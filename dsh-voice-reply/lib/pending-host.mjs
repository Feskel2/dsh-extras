/**
 * dsh-voice-reply — host side of "speak each finished answer at most once".
 *
 * Watches top-level Session turns on the Host and remembers the last completed
 * assistant answer per Session until a browser claims it exactly once:
 *
 *   POST /dsh-voice-pending/take     { sessionId } → { ok, item: { messageId, text, seq } | null }
 *   POST /dsh-voice-pending/discard  { sessionId } → { ok }
 *   GET  /dsh-voice-pending/peek?sessionId=…       → { ok, item } (no claim; diagnostics)
 *
 * The Host is the only component that sees turns of Sessions the browser is not
 * showing, so it records them regardless of tab focus; the client claims one
 * item when it can actually play it (page visible, focused, that chat open) and
 * the claim deletes it, so switching chats, reloading the page or a second tab
 * can never auto-speak the same answer twice. Manual replay does not claim
 * anything: it is a user action and always allowed.
 *
 * This module is a separate plugin row (`dsh-voice-reply/pending`) so that
 * adding it never needs a `dsh web` restart: a brand-new file is imported by
 * the Loader on the next bundle activation.
 */
export const name = 'voice-reply-pending'

/** The HTTP carrier is the only required service. */
export const inject = ['webServer']

/** Route prefix owned by this row (the main row owns `/dsh-voice-reply`). */
const PREFIX = '/dsh-voice-pending'

/** Finished answers kept at most (oldest dropped first). */
const MAX_PENDING = 200

/** Finished answers older than this are ignored (a day-old answer is stale). */
const MAX_AGE_MS = 6 * 60 * 60 * 1000

/** Accepted JSON body size for the two POST routes. */
const MAX_BODY_BYTES = 16 * 1024

/**
 * One finished answer waiting for its browser claim.
 * @typedef {{ messageId: string, text: string, seq: number, ts: number }} PendingAnswer
 */

/** @type {Map<string, PendingAnswer>} sessionId → unclaimed finished answer */
const pending = new Map()

/** @type {Map<string, { messageId: string, text: string, seq: number }>} last assistant message of a running turn */
const lastAssistant = new Map()

/**
 * Whether a Session is a delegated child whose answers stay silent.
 * @param {unknown} session - Session handed to the event listener.
 * @returns {boolean} true for subagent Sessions.
 */
function isDelegated(session) {
  const header = session !== null && typeof session === 'object' ? session.header : undefined
  if (header === null || typeof header !== 'object') return false
  return header.origin === 'subagent' || (header.delegationDepth ?? 0) > 0
}

/**
 * Join the visible text blocks of one logged assistant message.
 * @param {unknown} message - `assistant/message` payload message.
 * @returns {string} plain answer text (may be empty).
 */
function assistantText(message) {
  if (message === null || typeof message !== 'object') return ''
  const content = /** @type {{ content?: unknown, blocks?: unknown }} */ (message).content
    ?? /** @type {{ blocks?: unknown }} */ (message).blocks
  if (typeof content === 'string') return content.trim()
  if (!Array.isArray(content)) return ''
  const parts = []
  for (const block of content) {
    if (block === null || typeof block !== 'object') continue
    const kind = block.type ?? block.kind
    if (kind !== 'text' && kind !== undefined) continue
    if (typeof block.text === 'string' && block.text.trim() !== '') parts.push(block.text)
  }
  return parts.join('\n\n').trim()
}

/**
 * Drop expired entries and enforce the cap; cheap enough to run per event.
 * @returns {void}
 */
function prune() {
  const now = Date.now()
  for (const [sessionId, item] of pending) {
    if (now - item.ts > MAX_AGE_MS) pending.delete(sessionId)
  }
  while (pending.size > MAX_PENDING) {
    const oldest = pending.keys().next()
    if (oldest.done) break
    pending.delete(oldest.value)
  }
}

/**
 * Read one request body with a hard cap.
 * @param {import('node:http').IncomingMessage} req - request.
 * @returns {Promise<Record<string, unknown>>} parsed JSON object (empty on bad input).
 */
function readJsonBody(req) {
  return new Promise((resolve) => {
    const chunks = []
    let size = 0
    let done = false
    const finish = (value) => {
      if (done) return
      done = true
      resolve(value)
    }
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > MAX_BODY_BYTES) {
        finish({})
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      try {
        const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'))
        finish(parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {})
      } catch {
        finish({})
      }
    })
    req.on('error', () => finish({}))
  })
}

/**
 * Send a JSON response.
 * @param {import('node:http').ServerResponse} res - response.
 * @param {number} status - status code.
 * @param {unknown} body - JSON body.
 * @returns {void}
 */
function sendJson(res, status, body) {
  const payload = Buffer.from(JSON.stringify(body), 'utf8')
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': payload.length,
    'cache-control': 'no-store',
  })
  res.end(payload)
}

/**
 * Route one pending request.
 * @param {import('node:http').IncomingMessage} req - request.
 * @param {import('node:http').ServerResponse} res - response.
 * @returns {Promise<void>} completion after the response is sent.
 */
async function handle(req, res) {
  const url = new URL(req.url ?? '/', 'http://voice-reply-pending.local')
  const pathname = url.pathname
  prune()

  if (pathname === `${PREFIX}/peek`) {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, { allow: 'GET, HEAD' }).end()
      return
    }
    const sessionId = String(url.searchParams.get('sessionId') ?? '')
    sendJson(res, 200, { ok: true, item: sessionId === '' ? null : pending.get(sessionId) ?? null })
    return
  }
  if (pathname === `${PREFIX}/take` || pathname === `${PREFIX}/discard`) {
    if (req.method !== 'POST') {
      res.writeHead(405, { allow: 'POST' }).end()
      return
    }
    const body = await readJsonBody(req)
    const sessionId = typeof body.sessionId === 'string' ? body.sessionId : ''
    if (sessionId === '') {
      sendJson(res, 400, { ok: false, error: { code: 'bad-request', message: 'sessionId is required' } })
      return
    }
    const item = pending.get(sessionId) ?? null
    pending.delete(sessionId)
    if (pathname.endsWith('/take')) sendJson(res, 200, { ok: true, item })
    else sendJson(res, 200, { ok: true })
    return
  }
  sendJson(res, 404, { ok: false, error: { code: 'bad-request', message: 'unknown voice-reply-pending route' } })
}

/**
 * Register the routes and the Session listener.
 * @param {import('@deepseek-ai/cordis').Context} ctx - Host context with `webServer`.
 * @returns {void}
 */
export function apply(ctx) {
  ctx.on('session/event', (session, event) => {
    try {
      if (isDelegated(session)) return
      const sessionId = session !== null && typeof session === 'object' && session.id !== undefined ? String(session.id) : ''
      if (sessionId === '') return
      if (event === null || typeof event !== 'object') return

      if (event.type === 'turn/start') {
        lastAssistant.delete(sessionId)
        return
      }
      if (event.type === 'assistant/message') {
        const message = event.data?.message
        const text = assistantText(message)
        if (text === '') return
        lastAssistant.set(sessionId, {
          messageId: typeof message?.id === 'string' ? message.id : `seq-${String(event.seq)}`,
          text,
          seq: typeof event.seq === 'number' ? event.seq : 0,
        })
        return
      }
      if (event.type !== 'turn/end') return
      const reason = event.data?.reason?.kind
      const completed = reason === 'completed'
      const last = lastAssistant.get(sessionId)
      lastAssistant.delete(sessionId)
      if (!completed || last === undefined) return
      pending.set(sessionId, { ...last, ts: Date.now() })
      prune()
    } catch {
      /* never disturb a Session */
    }
  })

  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'prefix',
        path: PREFIX,
        handler: (req, res) => {
          handle(req, res).catch(() => {
            try {
              sendJson(res, 500, { ok: false, error: { code: 'internal', message: 'pending store failed' } })
            } catch {
              /* response already sent */
            }
          })
        },
      }),
    'voice-reply-pending: HTTP routes',
  )

  ctx.effect(
    () => () => {
      pending.clear()
      lastAssistant.clear()
    },
    'voice-reply-pending: store cleanup',
  )
}
