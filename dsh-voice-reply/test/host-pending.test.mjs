/**
 * Unit tests for the host-side "claimed once" store (`lib/pending-host.mjs`).
 *
 * Boots the real plugin with a fake Cordis context + fake webServer, feeds
 * Session events and exercises the HTTP routes with a local server.
 *
 * Run: node --test test/host-pending.test.mjs
 */
import assert from 'node:assert/strict'
import http from 'node:http'
import { after, before, beforeEach, test } from 'node:test'

/** Fake webServer route handler captured from the plugin. */
let handler = null
/** Captured session/event listener. */
let listener = null

const ctx = {
  on(name, fn) {
    if (name === 'session/event') listener = fn
  },
  effect(fn) {
    fn()
  },
  webServer: {
    register(route) {
      handler = route.handler
      return () => {
        handler = null
      }
    },
  },
}

const { apply } = await import('../lib/pending-host.mjs')

const app = http.createServer((req, res) => {
  if (handler === null) {
    res.writeHead(503).end()
    return
  }
  Promise.resolve(handler(req, res)).catch(() => res.writeHead(500).end())
})

let base = ''

before(async () => {
  apply(ctx)
  await new Promise((resolve) => app.listen(0, '127.0.0.1', resolve))
  base = `http://127.0.0.1:${app.address().port}`
})

after(async () => {
  await new Promise((resolve) => app.close(resolve))
})

beforeEach(async () => {
  // Drain any leftover items from an earlier test.
  await Promise.all(
    ['s1', 's2', 's3', 's4', 's5', 's6'].map((sessionId) =>
      fetch(`${base}/dsh-voice-pending/discard`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ sessionId }),
      }),
    ),
  )
})

/**
 * Emit one Session event through the captured listener.
 * @param {string} sessionId - session identity.
 * @param {object} event - event payload.
 * @param {object} [header] - session header overrides.
 * @returns {void}
 */
function emit(sessionId, event, header = {}) {
  listener({ id: sessionId, header }, { type: event.type, seq: event.seq ?? 1, data: event.data })
}

/**
 * Call the pending API.
 * @param {string} route - path below the prefix.
 * @param {{ method?: string, body?: unknown }} [options] - request options.
 * @returns {Promise<any>} parsed JSON.
 */
async function call(route, options = {}) {
  const response = await fetch(`${base}/dsh-voice-pending${route}`, {
    method: options.method ?? 'GET',
    headers: options.body === undefined ? {} : { 'content-type': 'application/json' },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  })
  let body = null
  try {
    body = await response.json()
  } catch {
    body = null
  }
  return { status: response.status, body }
}

/**
 * Feed one completed turn with an answer.
 * @param {string} sessionId - session identity.
 * @param {string} text - answer text.
 * @param {string} messageId - durable answer id.
 * @returns {void}
 */
function finishTurn(sessionId, text, messageId = 'm1') {
  emit(sessionId, { type: 'turn/start', seq: 1 })
  emit(sessionId, { type: 'assistant/message', seq: 2, data: { message: { id: messageId, content: [{ type: 'text', text }] } } })
  emit(sessionId, { type: 'turn/end', seq: 3, data: { reason: { kind: 'completed' } } })
}

test('a completed turn becomes one pending answer', async () => {
  finishTurn('s1', 'Привет, это ответ.', 'msg-1')
  const peek = await call('/peek?sessionId=s1')
  assert.equal(peek.body.ok, true)
  assert.equal(peek.body.item.text, 'Привет, это ответ.')
  assert.equal(peek.body.item.messageId, 'msg-1')
})

test('peek does not consume; take consumes exactly once', async () => {
  finishTurn('s2', 'Второй ответ.', 'msg-2')
  const firstPeek = await call('/peek?sessionId=s2')
  assert.equal(firstPeek.body.item.messageId, 'msg-2')
  const take = await call('/take', { method: 'POST', body: { sessionId: 's2' } })
  assert.equal(take.status, 200)
  assert.equal(take.body.item.messageId, 'msg-2')
  const secondTake = await call('/take', { method: 'POST', body: { sessionId: 's2' } })
  assert.equal(secondTake.body.item, null)
  const afterPeek = await call('/peek?sessionId=s2')
  assert.equal(afterPeek.body.item, null)
})

test('discard drops the pending answer', async () => {
  finishTurn('s3', 'Третий ответ.', 'msg-3')
  const discard = await call('/discard', { method: 'POST', body: { sessionId: 's3' } })
  assert.equal(discard.body.ok, true)
  const take = await call('/take', { method: 'POST', body: { sessionId: 's3' } })
  assert.equal(take.body.item, null)
})

test('only completed turns are stored', async () => {
  emit('s4', { type: 'turn/start', seq: 1 })
  emit('s4', { type: 'assistant/message', seq: 2, data: { message: { id: 'm4', content: [{ type: 'text', text: 'Прерванный ответ' }] } } })
  emit('s4', { type: 'turn/end', seq: 3, data: { reason: { kind: 'cancelled' } } })
  const peek = await call('/peek?sessionId=s4')
  assert.equal(peek.body.item, null)
})

test('subagent sessions never queue answers', async () => {
  emit('s5', { type: 'turn/start', seq: 1 }, { origin: 'subagent', delegationDepth: 1 })
  emit('s5', { type: 'assistant/message', seq: 2, data: { message: { id: 'm5', content: [{ type: 'text', text: 'Ответ сабагента' }] } } }, { origin: 'subagent', delegationDepth: 1 })
  emit('s5', { type: 'turn/end', seq: 3, data: { reason: { kind: 'completed' } } }, { origin: 'subagent', delegationDepth: 1 })
  const peek = await call('/peek?sessionId=s5')
  assert.equal(peek.body.item, null)
})

test('the newest answer of a session wins', async () => {
  finishTurn('s6', 'Старый ответ.', 'm-old')
  finishTurn('s6', 'Новый ответ.', 'm-new')
  const peek = await call('/peek?sessionId=s6')
  assert.equal(peek.body.item.messageId, 'm-new')
  assert.equal(peek.body.item.text, 'Новый ответ.')
})

test('bad requests are rejected', async () => {
  const missing = await call('/take', { method: 'POST', body: {} })
  assert.equal(missing.status, 400)
  const wrongMethod = await call('/take')
  assert.equal(wrongMethod.status, 405)
  const unknown = await call('/nope')
  assert.equal(unknown.status, 404)
})
