/**
 * topmost-notify — host half.
 *
 * Watches every top-level Session turn and, when a turn ends successfully and the
 * user has left the feature enabled in Settings → General, pops a native
 * always-on-top window with a short "task finished" summary and a pleasant chime.
 *
 * Why native instead of an in-page overlay: the Web client cannot render above
 * another application. A separate PowerShell/WPF window with WS_EX_TOPMOST does,
 * so the notification is visible over a fullscreen video in another browser or a
 * borderless-fullscreen game (exclusive-fullscreen DirectX games are the one
 * documented exception — see README.md).
 *
 * Diagnostics: this plugin appends one line per decision to
 * `host/notify-debug.log` (bounded). It never throws into the Session: every
 * helper failure is logged and ignored.
 */
import { execFile } from 'node:child_process'
import { appendFileSync, mkdirSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import z from '@deepseek-ai/schemastery'

/** Stable Loader identity; also the settings namespace the browser row edits. */
export const name = 'topmost-notify'

/**
 * No declared service dependency. The Session title is read opportunistically
 * through `ctx.get('sessionTitle')`, so this plugin still loads on a Host that
 * composes no title service.
 */
export const inject = []

/**
 * Settings form fields. Every field is volatile so the Settings page may rewrite
 * it in the running Host; DSH restarts this entry with the accepted values.
 */
export const Config = z.object({
  /** Master switch mirrored by the Settings → General row. */
  enabled: z.boolean().default(true).volatile(),
  /** Time the notification window stays on screen, in milliseconds. */
  durationMs: z.number().step(100).min(300).max(10000).default(1000).volatile(),
  /** Play the bundled chime. */
  sound: z.boolean().default(true).volatile(),
  /** Include the Session title in the notification body. */
  showSessionTitle: z.boolean().default(true).volatile(),
  /** Include a one-line excerpt of the final answer. */
  showAnswerExcerpt: z.boolean().default(true).volatile(),
  /** Show the amber "answer needed" card when the agent asks a question. */
  notifyQuestions: z.boolean().default(true).volatile(),
  /** Sessions whose notifications are muted by the per-chat header switch. */
  mutedSessions: z.array(z.string()).default([]).volatile(),
  /** Diagnostics only: also notify for delegated subagent turns (default off). */
  notifySubagentTest: z.boolean().default(false).volatile(),
})

/** Directory of this module: the helper script lives in `host/` beside it. */
const HERE = dirname(fileURLToPath(import.meta.url))
const HOST_DIR = join(HERE, 'host')
const SCRIPT_PATH = join(HOST_DIR, 'notify.ps1')
const LOG_PATH = join(HOST_DIR, 'notify-debug.log')
const WINDOW_SCRIPT = 'powershell.exe'
const SPAWN_TIMEOUT_MS = 20000
/** Keep the diagnostic file small: it is appended to on every candidate turn. */
const LOG_LIMIT_BYTES = 256 * 1024

/** Longest excerpt kept for the notification body. */
const EXCERPT_LIMIT = 150

/**
 * Append one diagnostic line; never throws and never grows the file unbounded.
 * @param {unknown[]} parts - values joined by spaces.
 * @returns {void}
 */
function log(...parts) {
  try {
    mkdirSync(HOST_DIR, { recursive: true })
    try {
      if (statSync(LOG_PATH).size > LOG_LIMIT_BYTES) writeFileSync(LOG_PATH, '')
    } catch {}
    appendFileSync(LOG_PATH, `${new Date().toISOString()} ${parts.map(String).join(' ')}\n`)
  } catch {}
}

/**
 * Read one Config field. `.volatile()` fields arrive as live references exposing
 * `get()` (cordis keeps them mutable so a Settings write applies without a plugin
 * restart); plain fields arrive as their value. Reading through this helper is
 * what makes "no notification" impossible when only the wrapper shape differs.
 * @param {unknown} value - raw Config member.
 * @param {unknown} fallback - value used when the field is absent or empty.
 * @returns {unknown} the current plain value.
 */
function configValue(value, fallback) {
  if (value === undefined || value === null) return fallback
  if (typeof value === 'object' && typeof value.get === 'function') {
    const current = value.get()
    return current === undefined || current === null ? fallback : current
  }
  return value
}
/**
 * Whether the per-chat switch muted this Session.
 * @param {unknown} config - plugin Config (volatile members are wrappers).
 * @param {unknown} sessionId - Session identity.
 * @returns {boolean} true when the chat switched notifications off.
 */
function isMuted(config, sessionId) {
  const list = configValue(config?.mutedSessions, [])
  if (!Array.isArray(list) || list.length === 0) return false
  return sessionId !== undefined && list.includes(String(sessionId))
}

/**
 * Collapse markdown-ish whitespace into one readable line.
 * @param {string} text - raw markdown/plain text.
 * @returns {string} single-line excerpt, possibly empty.
 */
function toExcerpt(text) {
  if (typeof text !== 'string' || text.length === 0) return ''
  const flat = text
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/[*_`>#]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
  return flat.length > EXCERPT_LIMIT ? `${flat.slice(0, EXCERPT_LIMIT - 1)}…` : flat
}

/**
 * Extract readable assistant text from a logged `assistant/message` payload.
 * @param {unknown} message - `event.data.message`.
 * @returns {string} joined text blocks.
 */
function assistantText(message) {
  if (message === null || typeof message !== 'object') return ''
  const content = /** @type {{ content?: unknown, blocks?: unknown }} */ (message).content
    ?? /** @type {{ blocks?: unknown }} */ (message).blocks
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .filter((block) => block !== null && typeof block === 'object' && typeof block.text === 'string')
    .map((block) => /** @type {{ text: string }} */ (block).text)
    .join('\n')
}

/**
 * Whether a Session is a delegated child whose turns stay silent by default.
 * @param {unknown} session - Session handed to the event listener.
 * @returns {boolean} true for subagent Sessions.
 */
function isDelegated(session) {
  const header = session !== null && typeof session === 'object' ? session.header : undefined
  if (header === null || typeof header !== 'object') return false
  return header.origin === 'subagent' || (header.delegationDepth ?? 0) > 0
}

/**
 * Read the first question of an `ask_user_question` tool call so the popup can
 * show what the agent is waiting for. Tolerant by design: a malformed or
 * renamed argument shape degrades to an empty string.
 * @param {unknown} rawArguments - `tool/call` arguments (JSON text).
 * @returns {string} question text, prefixed by its header when present.
 */
function firstQuestionText(rawArguments) {
  try {
    const args = typeof rawArguments === 'string' ? JSON.parse(rawArguments) : rawArguments
    const questions = args?.questions
    if (!Array.isArray(questions) || questions.length === 0) return ''
    const first = questions[0]
    if (first === null || typeof first !== 'object') return ''
    const text = first.question ?? first.detail ?? ''
    if (typeof text !== 'string') return ''
    const header = typeof first.header === 'string' && first.header.length > 0 ? first.header : ''
    const extra = Array.isArray(questions) && questions.length > 1 ? ` (+${questions.length - 1})` : ''
    const options = Array.isArray(first.options) ? first.options.length : 0
    const suffix = options > 0 ? ` · вариантов: ${options}` : ''
    return `${header.length > 0 ? `${header}: ` : ''}${text}${extra}${suffix}`
  } catch {
    return ''
  }
}
/**
 * Spawn the native notifier for one payload; never throws.
 * @param {{ kind: 'completed' | 'question', title: string, body: string, durationMs: number, sound: boolean }} payload
 * @returns {void}
 */
function showNotification(payload) {
  if (process.env.DSH_TOPMOST_NOTIFY_DRY_RUN === '1') {
    log('dry-run', JSON.stringify(payload))
    return
  }
  const encoded = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64')
  log('spawn', SCRIPT_PATH, JSON.stringify(payload))
  try {
    execFile(
      WINDOW_SCRIPT,
      ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-ExecutionPolicy', 'Bypass',
        '-File', SCRIPT_PATH, '-PayloadBase64', encoded],
      { windowsHide: true, timeout: SPAWN_TIMEOUT_MS, maxBuffer: 1024 * 1024 },
      (error, stdout, stderr) => {
        log('child', error ? `error=${error.message}` : 'ok', `stderr=${String(stderr).slice(0, 600)}`)
      },
    )
  } catch (error) {
    log('spawn-failed', error?.message ?? String(error))
  }
}

/**
 * Install the Session listeners for the current configuration.
 * @param {import('@deepseek-ai/cordis').Context} ctx - Host context.
 * @param {z.infer<typeof Config>} config - validated volatile configuration.
 * @returns {void}
 */
export function apply(ctx, config) {
  const logger = ctx.logger
  const lastAnswer = new Map()
  const notifiedQuestions = new Set()
  log('apply', JSON.stringify(config))

  ctx.on('session/event', (session, event) => {
    try {
      const delegated = isDelegated(session)
      const sessionId = session?.id

      // The agent is waiting for a human answer: the turn stays open (no turn/end
      // until it is answered), so this event is the only notification point.
      if (event.type === 'tool/call') {
        if (event.data?.name !== 'ask_user_question' || delegated) return
        const callId = event.data?.callId
        if (callId !== undefined) {
          if (notifiedQuestions.has(callId)) return
          notifiedQuestions.add(callId)
        }
        if (configValue(config?.enabled, true) !== true) return
        if (isMuted(config, sessionId)) { log('muted', sessionId); return }
        if (configValue(config?.notifyQuestions, true) !== true) return
        const question = firstQuestionText(event.data?.arguments)
        log('question', sessionId, 'callId=' + callId, JSON.stringify(question))
        let sessionTitle = ''
        if (configValue(config?.showSessionTitle, true) !== false) {
          try {
            sessionTitle = ctx.get('sessionTitle')?.get(session)?.title ?? ''
          } catch {
            sessionTitle = ''
          }
        }
        const body = [sessionTitle, question].filter((part) => part.length > 0).join('\n')
        showNotification({
          kind: 'question',
          title: '❓ Нужен ваш ответ',
          body: body.length > 0 ? body : 'Агент ждёт ответа в чате',
          durationMs: configValue(config?.durationMs, 1000),
          sound: configValue(config?.sound, true) !== false,
        })
        return
      }

      if (event.type === 'assistant/message') {
        const text = assistantText(event.data?.message)
        if (text.length > 0 && sessionId !== undefined) lastAnswer.set(sessionId, text)
        return
      }
      if (event.type !== 'turn/end') return

      const reason = event.data?.reason?.kind
      log('turn/end', sessionId, 'reason=' + reason, 'delegated=' + delegated,
        'enabled=' + String(configValue(config?.enabled, '?')),
        'test=' + String(configValue(config?.notifySubagentTest, '?')),
        'duration=' + String(configValue(config?.durationMs, '?')))
      if (sessionId === undefined) return
      const answer = lastAnswer.get(sessionId) ?? ''
      lastAnswer.delete(sessionId)

      if (reason !== 'completed') return
      if (delegated && configValue(config?.notifySubagentTest, false) !== true) return
      if (configValue(config?.enabled, true) !== true) return
      if (isMuted(config, sessionId)) { log('muted', sessionId); return }

      let sessionTitle = ''
      if (configValue(config?.showSessionTitle, true) !== false) {
        try {
          sessionTitle = ctx.get('sessionTitle')?.get(session)?.title ?? ''
        } catch {
          sessionTitle = ''
        }
      }

      const excerpt = configValue(config?.showAnswerExcerpt, true) === false ? '' : toExcerpt(answer)
      const body = [sessionTitle, excerpt].filter((part) => part.length > 0).join('\n')
      showNotification({
        kind: 'completed',
        title: delegated ? '🧪 TEST: задача выполнена' : '✅ Задача выполнена',
        body: body.length > 0 ? body : 'Агент завершил работу в этом чате',
        durationMs: configValue(config?.durationMs, 1000),
        sound: configValue(config?.sound, true) !== false,
      })
    } catch (error) {
      log('listener-error', error?.message ?? String(error))
      logger?.warn?.('topmost-notify: ', error)
    }
  })

  ctx.on('session/disposed', (session) => {
    lastAnswer.delete(session?.id)
  })
}
