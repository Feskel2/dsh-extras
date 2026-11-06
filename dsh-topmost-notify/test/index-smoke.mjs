/**
 * Host-half smoke test without a running Host.
 *
 * The plugin imports `@deepseek-ai/schemastery`, which resolves inside the DSH
 * process through the Loader's ESM hooks but not from an arbitrary folder. This
 * test therefore copies the package into a temporary directory that carries a
 * `node_modules` junction to the installed DSH tree, then drives `apply()` with
 * a fake Cordis context and fake Session events.
 *
 * With DSH_TOPMOST_NOTIFY_DRY_RUN=1 the notifier writes its payload to
 * `host/notify-debug.log` instead of spawning a window; the test reads those lines.
 *
 * Run: node test/index-smoke.mjs
 */
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import assert from 'node:assert/strict'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))

/** Locate the installed DSH dependency tree that owns `@deepseek-ai/schemastery`. */
function dshNodeModules() {
  if (process.env.DSH_NODE_MODULES) return process.env.DSH_NODE_MODULES
  const candidates = [
    join(process.env.APPDATA ?? '', 'npm', 'node_modules', '@deepseek-ai', 'dsh', 'node_modules'),
    join(process.env.ProgramFiles ?? '', 'nodejs', 'node_modules', '@deepseek-ai', 'dsh', 'node_modules'),
    '/usr/local/lib/node_modules/@deepseek-ai/dsh/node_modules',
  ]
  const found = candidates.find((candidate) => existsSync(join(candidate, '@deepseek-ai', 'schemastery')))
  if (found === undefined) throw new Error('cannot locate the installed DSH node_modules; set DSH_NODE_MODULES')
  return found
}

/** Copy the package files the test needs into a throwaway directory. */
function stagePackage() {
  const dir = mkdtempSync(join(tmpdir(), 'topmost-notify-smoke-'))
  for (const file of ['package.json', 'index.mjs']) cpSync(join(ROOT, file), join(dir, file))
  cpSync(join(ROOT, 'host'), join(dir, 'host'), { recursive: true })
  symlinkSync(dshNodeModules(), join(dir, 'node_modules'), 'junction')
  return dir
}

const dir = stagePackage()
const logPath = join(dir, 'host', 'notify-debug.log')
const handlers = new Map()
const warns = []

const ctx = {
  logger: { info: () => {}, warn: (...args) => warns.push(args) },
  on: (event, handler) => {
    handlers.set(event, handler)
    return () => handlers.delete(event)
  },
  get: () => undefined,
}

/** Every payload the plugin decided to notify with, in order. */
function dryRuns() {
  if (!existsSync(logPath)) return []
  return readFileSync(logPath, 'utf8')
    .split('\n')
    .filter((line) => line.includes(' dry-run '))
    .map((line) => JSON.parse(line.slice(line.indexOf(' dry-run ') + ' dry-run '.length)))
}

/** Payloads produced by one scenario, with the log truncated first. */
function reset() {
  rmSync(logPath, { force: true })
}

try {
  process.env.DSH_TOPMOST_NOTIFY_DRY_RUN = '1'
  const plugin = await import(pathToFileURL(join(dir, 'index.mjs')).href)
  assert.equal(plugin.name, 'topmost-notify', 'plugin name')
  assert.equal(typeof plugin.apply, 'function', 'apply export')
  assert.equal(typeof plugin.Config, 'function', 'Config export is a schemastery schema')
  assert.ok(typeof plugin.Config.toJSON === 'function', 'Config exposes toJSON for the Settings form')

  const config = { enabled: true, durationMs: 1000, sound: true, showSessionTitle: true, showAnswerExcerpt: true }
  const title = '✅PL-1 «Демо-задача»'
  const session = { id: 'session-demo', header: { delegationDepth: 0 } }
  ctx.get = (service) => (service === 'sessionTitle' ? { get: () => ({ title }) } : undefined)
  const emit = (target, event) => handlers.get('session/event')?.(target, event)

  // --- 1. a normal root Session: assistant text then a completed turn -------
  reset()
  plugin.apply(ctx, config)
  emit(session, { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'Готово: **всё** собрано.\n\n```\ncode\n```' }] } } })
  emit(session, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })
  let runs = dryRuns()
  assert.equal(runs.length, 1, 'one notification for a completed turn')
  assert.equal(runs[0].title, '✅ Задача выполнена')
  assert.equal(runs[0].durationMs, 1000)
  assert.equal(runs[0].sound, true)
  assert.ok(runs[0].body.startsWith(title), 'session title leads the body')
  assert.ok(runs[0].body.includes('Готово: всё собрано.'), 'markdown flattened into the excerpt')
  assert.ok(!runs[0].body.includes('```'), 'code fences stripped')

  // --- 2. an aborted turn is silent ----------------------------------------
  reset()
  emit(session, { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'partial' }] } } })
  emit(session, { type: 'turn/end', data: { turn: 2, reason: { kind: 'aborted', reason: 'user' } } })
  assert.equal(dryRuns().length, 0, 'aborted turn stays silent')

  // --- 3. a blocked turn is silent -----------------------------------------
  emit(session, { type: 'turn/end', data: { turn: 3, reason: { kind: 'blocked' } } })
  assert.equal(dryRuns().length, 0, 'blocked turn stays silent')

  // --- 4. a disabled switch is silent --------------------------------------
  reset()
  plugin.apply(ctx, { ...config, enabled: false })
  emit(session, { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'done' }] } } })
  emit(session, { type: 'turn/end', data: { turn: 4, reason: { kind: 'completed' } } })
  assert.equal(dryRuns().length, 0, 'disabled switch suppresses the notification')

  // --- 5. subagent Sessions are silent -------------------------------------
  reset()
  plugin.apply(ctx, config)
  const child = { id: 'session-child', header: { origin: 'subagent', delegationDepth: 1 } }
  emit(child, { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'child done' }] } } })
  emit(child, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })
  assert.equal(dryRuns().length, 0, 'subagent Sessions never notify')

  // --- 6. no title service, no excerpt: still a valid message --------------
  reset()
  ctx.get = () => undefined
  plugin.apply(ctx, { ...config, showAnswerExcerpt: false })
  const bare = { id: 'session-bare', header: {} }
  emit(bare, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })
  runs = dryRuns()
  assert.equal(runs.length, 1, 'missing optional data still notifies')
  assert.ok(runs[0].body.length > 0, 'body falls back to a generic line')

  // --- 7. production shape: `.volatile()` members are live wrappers --------
  reset()
  const live = (value) => ({ get: () => value, update: () => {} })
  plugin.apply(ctx, {
    enabled: live(true),
    durationMs: live(1500),
    sound: live(false),
    showSessionTitle: live(false),
    showAnswerExcerpt: live(true),
    notifySubagentTest: live(false),
  })
  const liveSession = { id: 'session-live', header: {} }
  emit(liveSession, { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'Ответ из живой конфигурации' }] } } })
  emit(liveSession, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })
  runs = dryRuns()
  assert.equal(runs.length, 1, 'volatile Config wrappers still notify (regression guard)')
  assert.equal(runs[0].durationMs, 1500, 'volatile durationMs read through get()')
  assert.equal(runs[0].sound, false, 'volatile sound read through get()')
  assert.ok(!runs[0].body.includes('«'), 'volatile showSessionTitle=false honoured')

  // --- 8. a volatile switch that is OFF suppresses the notification --------
  reset()
  plugin.apply(ctx, { enabled: live(false), durationMs: live(1000), sound: live(true) })
  emit({ id: 'session-off', header: {} }, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })
  assert.equal(dryRuns().length, 0, 'volatile enabled=false suppresses the notification')

  // --- 9. an agent question notifies with the `question` kind -------------
  reset()
  plugin.apply(ctx, { ...config, notifyQuestions: true })
  const asking = { id: 'session-ask', header: {} }
  const askArgs = JSON.stringify({
    questions: [
      { id: 'q1', header: 'Вариант', question: 'Продолжать?', options: [{ label: 'Да' }, { label: 'Нет' }] },
      { id: 'q2', question: 'Второй вопрос' },
    ],
  })
  emit(asking, { type: 'tool/call', data: { turn: 1, step: 1, callId: 'call-1', name: 'ask_user_question', arguments: askArgs } })
  runs = dryRuns()
  assert.equal(runs.length, 1, 'a question notifies')
  assert.equal(runs[0].kind, 'question', 'question payload carries its kind')
  assert.ok(runs[0].body.includes('Продолжать?'), 'question text reaches the popup')
  assert.ok(runs[0].body.includes('+1'), 'extra questions are counted')

  // --- 10. the same tool call notifies once --------------------------------
  reset()
  emit(asking, { type: 'tool/call', data: { turn: 1, step: 1, callId: 'call-1', name: 'ask_user_question', arguments: askArgs } })
  assert.equal(dryRuns().length, 0, 'a repeated tool/call is deduplicated')

  // --- 11. unrelated tools never notify ------------------------------------
  reset()
  emit(asking, { type: 'tool/call', data: { turn: 1, step: 1, callId: 'call-2', name: 'read', arguments: '{}' } })
  assert.equal(dryRuns().length, 0, 'other tool calls stay silent')

  // --- 12. questions can be switched off ------------------------------------
  reset()
  plugin.apply(ctx, { ...config, notifyQuestions: false })
  emit(asking, { type: 'tool/call', data: { turn: 1, step: 1, callId: 'call-3', name: 'ask_user_question', arguments: askArgs } })
  assert.equal(dryRuns().length, 0, 'notifyQuestions=false suppresses question popups')

  // --- 13. a delegated question stays silent -------------------------------
  reset()
  plugin.apply(ctx, { ...config, notifyQuestions: true })
  emit({ id: 'session-child-ask', header: { origin: 'subagent', delegationDepth: 1 } },
    { type: 'tool/call', data: { turn: 1, step: 1, callId: 'call-4', name: 'ask_user_question', arguments: askArgs } })
  assert.equal(dryRuns().length, 0, 'delegated question stays silent')

  // --- 14. malformed question arguments still produce a usable popup -------
  reset()
  emit(asking, { type: 'tool/call', data: { turn: 1, step: 1, callId: 'call-5', name: 'ask_user_question', arguments: 'not json' } })
  runs = dryRuns()
  assert.equal(runs.length, 1, 'a malformed question still notifies')
  assert.ok(runs[0].body.length > 0, 'malformed question falls back to generic copy')

  // --- 15. a listener failure never escapes into the Host -------------------
  reset()
  const broken = {
    id: 'session-broken',
    get header() {
      throw new Error('header exploded')
    },
  }
  plugin.apply(ctx, config)
  emit(broken, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })
  assert.equal(dryRuns().length, 0, 'a broken Session notifies nothing')
  assert.equal(warns.length, 1, 'the failure is contained and reported to the logger')

  // --- 16. a muted chat (per-chat bell) stays silent -----------------------
  reset()
  const mutedSession = { id: 'session-muted', header: {} }
  plugin.apply(ctx, { ...config, mutedSessions: ['session-muted'] })
  emit(mutedSession, { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'done' }] } } })
  emit(mutedSession, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })
  assert.equal(dryRuns().length, 0, 'a muted chat does not notify on completion')

  emit(mutedSession, { type: 'tool/call', data: { turn: 2, step: 1, callId: 'muted-q', name: 'ask_user_question', arguments: JSON.stringify({ questions: [{ id: 'q', question: 'Вопрос?' }] }) } })
  assert.equal(dryRuns().length, 0, 'a muted chat does not notify on questions')

  // --- 17. the bell's production shape: volatile list of session ids --------
  reset()
  plugin.apply(ctx, {
    enabled: live(true),
    durationMs: live(1000),
    sound: live(true),
    showSessionTitle: live(true),
    showAnswerExcerpt: live(true),
    notifySubagentTest: live(false),
    mutedSessions: { get: () => ['session-live'], update: () => {} },
  })
  emit({ id: 'session-live', header: {} }, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })
  assert.equal(dryRuns().length, 0, 'volatile mutedSessions wrapper is read through get()')

  // --- 18. unmuting restores the notification ------------------------------
  reset()
  plugin.apply(ctx, { ...config, mutedSessions: [] })
  emit(mutedSession, { type: 'turn/end', data: { turn: 3, reason: { kind: 'completed' } } })
  assert.equal(dryRuns().length, 1, 'an unmuted chat notifies again')

  console.log('PASS index-smoke: 18 scenarios')
  console.log('  completed turn payload:', JSON.stringify(runs[0]))
} finally {
  rmSync(dir, { recursive: true, force: true })
}
