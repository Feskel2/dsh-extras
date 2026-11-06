/**
 * topmost-notify — host half.
 *
 * Watches every top-level Session turn and, when a turn ends successfully and the
 * user has left the feature enabled in Settings, pops a native always-on-top
 * window with a short "task finished" summary and a pleasant chime. When the
 * agent is waiting for an answer (`ask_user_question`) it pops the amber
 * "answer needed" card with the question sound.
 *
 * Why native instead of an in-page overlay: the Web client cannot render above
 * another application. A separate PowerShell/WPF window with WS_EX_TOPMOST does,
 * so the notification is visible over a fullscreen video in another browser or a
 * borderless-fullscreen game (exclusive-fullscreen DirectX games are the one
 * documented exception — see README.md).
 *
 * v1.1 adds the plugin settings page (served by the client half):
 *   - per-kind duration (`durationMs` / `questionDurationMs`);
 *   - per-kind sound on/off (`completedSoundEnabled` / `questionSoundEnabled`,
 *     with the legacy `sound` master used only when the kind field is absent);
 *   - per-kind custom sound files (`completedSoundFile` / `questionSoundFile`);
 *   - HTTP API under `/dsh-topmost-notify`: status, sound upload/reset, preview.
 *
 * Diagnostics: this plugin appends one line per decision to
 * `host/notify-debug.log` (bounded). It never throws into the Session: every
 * helper failure is logged and ignored.
 */
import { execFile } from 'node:child_process'
import {
  appendFileSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { basename, dirname, extname, isAbsolute, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import z from '@deepseek-ai/schemastery'

/** Stable Loader identity; also the settings namespace the browser row edits. */
export const name = 'topmost-notify'

/**
 * The HTTP carrier is the only declared service dependency. Session events are
 * self-contained and the Session title is read opportunistically through
 * `ctx.get('sessionTitle')`, so the notification half keeps working even when
 * the composed Host has no web server: route registration is guarded below.
 */
export const inject = ['webServer']

/**
 * Settings form fields. Every field is volatile so the Settings page may rewrite
 * it in the running Host; DSH restarts this entry with the accepted values.
 */
export const Config = z.object({
  /** Master switch mirrored by the Settings row. */
  enabled: z.boolean().default(true).volatile(),
  /** Time the "task finished" notification window stays on screen, in milliseconds. */
  durationMs: z.number().step(100).min(300).max(10000).default(1000).volatile(),
  /** Time the "answer needed" notification window stays on screen, in milliseconds. */
  questionDurationMs: z.number().step(100).min(300).max(10000).default(1500).volatile(),
  /** Legacy sound master: applied only when the per-kind field is absent. */
  sound: z.boolean().default(true).volatile(),
  /** Play the completion sound. */
  completedSoundEnabled: z.boolean().default(true).volatile(),
  /** Play the question sound. */
  questionSoundEnabled: z.boolean().default(true).volatile(),
  /** Absolute path to a custom .mp3/.wav for completions; '' = bundled chime.wav. */
  completedSoundFile: z.string().default('').volatile(),
  /** Absolute path to a custom .mp3/.wav for questions; '' = bundled chime-question.wav. */
  questionSoundFile: z.string().default('').volatile(),
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
/** Custom sounds uploaded by the settings page. */
const SOUNDS_DIR = join(HERE, 'sounds')
const PACKAGE_JSON = join(HERE, 'package.json')
const WINDOW_SCRIPT = 'powershell.exe'
const SPAWN_TIMEOUT_MS = 20000
/** Keep the diagnostic file small: it is appended to on every candidate turn. */
const LOG_LIMIT_BYTES = 256 * 1024

/** Longest excerpt kept for the notification body. */
const EXCERPT_LIMIT = 150

/** Route prefix owned by this plugin (prefix registration in `ctx.webServer`). */
const ROUTE_PREFIX = '/dsh-topmost-notify'

/** Accepted upload size for a custom sound (12 MiB). */
const MAX_SOUND_BYTES = 12 * 1024 * 1024

/** Accepted JSON body size for the small control routes. */
const MAX_JSON_BYTES = 64 * 1024

/** Duration limits mirrored by the settings page sliders. */
const DURATION_LIMITS = Object.freeze({ min: 300, max: 10000, step: 100 })

/** Built-in sounds, by notification kind. */
const BUNDLED_SOUNDS = Object.freeze({
  completed: join(HOST_DIR, 'chime.wav'),
  question: join(HOST_DIR, 'chime-question.wav'),
})

/** Sample copy shown by the settings-page preview buttons. */
const PREVIEW_SAMPLES = Object.freeze({
  completed: {
    title: '✅ Задача выполнена',
    body: 'Пример: так карточка появится после завершения задачи',
  },
  question: {
    title: '❓ Нужен ваш ответ',
    body: 'Пример: агент ждёт вашего ответа в чате',
  },
})

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
 * Read one optional Config member, keeping "absent" distinct from "explicitly
 * false/empty": the legacy `sound` master must apply only when the per-kind
 * field is missing from the row config.
 * @param {unknown} config - plugin Config (volatile members are wrappers).
 * @param {string} key - field name.
 * @returns {unknown} the current plain value, or `undefined` when absent.
 */
function configField(config, key) {
  if (config === undefined || config === null) return undefined
  const raw = config[key]
  if (raw === undefined || raw === null) return undefined
  return configValue(raw, undefined)
}

/**
 * Clamp a duration to the range advertised by the settings page.
 * @param {unknown} value - requested duration in milliseconds.
 * @param {number} fallback - duration used for a non-numeric value.
 * @returns {number} integer duration within limits.
 */
function clampDuration(value, fallback = 1000) {
  const numeric = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(numeric)) return fallback
  return Math.min(DURATION_LIMITS.max, Math.max(DURATION_LIMITS.min, Math.round(numeric)))
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
 * Resolve the sound for one notification kind: a custom file when it exists,
 * otherwise the bundled signal; `true`/`false` keep the payload contract simple
 * (`true` = bundled signal, string = custom file, false = silent).
 * @param {'completed' | 'question'} kind - notification kind.
 * @param {unknown} rawFile - configured `completedSoundFile`/`questionSoundFile`.
 * @returns {true | string} bundled marker or absolute path.
 */
function resolveSoundFile(kind, rawFile) {
  const raw = typeof rawFile === 'string' ? rawFile.trim() : ''
  if (raw === '') return true
  const absolute = isAbsolute(raw) ? raw : resolve(HERE, raw)
  try {
    if (statSync(absolute).isFile() && statSync(absolute).size > 0) return absolute
  } catch {}
  log('custom-sound-missing', kind, absolute, '-> bundled', basename(BUNDLED_SOUNDS[kind]))
  return true
}

/**
 * Resolve duration and sound for one notification kind from the live Config.
 * Completed uses `durationMs`/`completedSoundEnabled`/`completedSoundFile`;
 * question uses `questionDurationMs`/`questionSoundEnabled`/`questionSoundFile`
 * with the legacy `sound` master as fallback for the per-kind enable switch.
 * @param {unknown} config - plugin Config (volatile members are wrappers).
 * @param {'completed' | 'question'} kind - notification kind.
 * @returns {{ durationMs: number, sound: true | false | string }} payload fields.
 */
function resolveKindSettings(config, kind) {
  const durationRaw = kind === 'question'
    ? configField(config, 'questionDurationMs') ?? configField(config, 'durationMs') ?? 1000
    : configField(config, 'durationMs') ?? 1000
  const enabledField = kind === 'question' ? 'questionSoundEnabled' : 'completedSoundEnabled'
  const explicitEnabled = configField(config, enabledField)
  const soundEnabled = explicitEnabled === undefined
    ? configValue(config?.sound, true) !== false
    : explicitEnabled !== false
  const fileField = kind === 'question' ? 'questionSoundFile' : 'completedSoundFile'
  return {
    durationMs: clampDuration(durationRaw, kind === 'question' ? 1500 : 1000),
    sound: soundEnabled ? resolveSoundFile(kind, configField(config, fileField)) : false,
  }
}

/**
 * Spawn the native notifier script for one payload; never throws.
 * @param {{ kind?: 'completed' | 'question', title?: string, body?: string, durationMs?: number, sound?: boolean | string }} payload
 * @param {string[]} extraArgs - extra notify.ps1 switches (e.g. `-PreviewSound`).
 * @param {string} label - diagnostic label for the spawn line.
 * @returns {void}
 */
function runNotifier(payload, extraArgs, label) {
  if (process.env.DSH_TOPMOST_NOTIFY_DRY_RUN === '1') {
    log('dry-run', JSON.stringify(payload))
    return
  }
  const encoded = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64')
  log('spawn', label, SCRIPT_PATH, JSON.stringify(payload))
  try {
    execFile(
      WINDOW_SCRIPT,
      ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-ExecutionPolicy', 'Bypass',
        '-File', SCRIPT_PATH, ...extraArgs, '-PayloadBase64', encoded],
      { windowsHide: true, timeout: SPAWN_TIMEOUT_MS, maxBuffer: 1024 * 1024 },
      (error, stdout, stderr) => {
        log('child', label, error ? `error=${error.message}` : 'ok', `stderr=${String(stderr).slice(0, 600)}`)
      },
    )
  } catch (error) {
    log('spawn-failed', error?.message ?? String(error))
  }
}

/**
 * Show the native notification window for one payload.
 * @param {{ kind?: 'completed' | 'question', title?: string, body?: string, durationMs?: number, sound?: boolean | string }} payload
 * @returns {void}
 */
function showNotification(payload) {
  runNotifier(payload, [], 'window')
}

/**
 * Play only the sound of a payload (`notify.ps1 -PreviewSound`), no window.
 * @param {{ kind?: 'completed' | 'question', sound?: boolean | string }} payload
 * @returns {void}
 */
function previewSoundOnly(payload) {
  runNotifier(payload, ['-PreviewSound'], 'preview-sound')
}

/* ------------------------------------------------------------------ */
/* HTTP helpers                                                       */
/* ------------------------------------------------------------------ */

/** One HTTP error carrying the status and a stable error code. */
class HttpError extends Error {
  /**
   * @param {number} status - HTTP status.
   * @param {string} code - stable machine-readable code.
   * @param {string} message - human-readable message (Russian, shown by the page).
   */
  constructor(status, code, message) {
    super(message)
    this.status = status
    this.code = code
  }
}

/** Response headers used by every JSON answer. */
const JSON_HEADERS = Object.freeze({
  'content-type': 'application/json; charset=utf-8',
  'cache-control': 'no-store',
})

/**
 * Send a JSON response.
 * @param {import('node:http').ServerResponse} res - response.
 * @param {number} status - HTTP status.
 * @param {unknown} body - JSON-serializable body.
 * @returns {void}
 */
function sendJson(res, status, body) {
  const payload = Buffer.from(JSON.stringify(body), 'utf8')
  res.writeHead(status, { ...JSON_HEADERS, 'content-length': payload.length })
  res.end(payload)
}

/**
 * Send one structured error.
 * @param {import('node:http').ServerResponse} res - response.
 * @param {number} status - HTTP status.
 * @param {string} code - stable machine-readable code.
 * @param {string} message - human-readable message.
 * @returns {void}
 */
function sendError(res, status, code, message) {
  sendJson(res, status, { ok: false, error: { code, message } })
}

/**
 * Read a request body with a hard byte cap. A declared oversize
 * `content-length` is rejected before the body is buffered (413); the request is
 * drained instead of destroyed so the client still receives the answer.
 * @param {import('node:http').IncomingMessage} req - request.
 * @param {number} limit - maximum bytes.
 * @returns {Promise<Buffer>} body.
 * @throws {HttpError} 413 when the body exceeds the cap.
 */
function readBody(req, limit) {
  return new Promise((resolvePromise, rejectPromise) => {
    const declared = Number(req.headers['content-length'])
    if (Number.isFinite(declared) && declared > limit) {
      req.resume()
      rejectPromise(new HttpError(413, 'payload-too-large', `Размер больше лимита ${Math.round(limit / 1024 / 1024)} МиБ`))
      return
    }
    const chunks = []
    let size = 0
    let settled = false
    req.on('data', (chunk) => {
      if (settled) return
      size += chunk.length
      if (size > limit) {
        settled = true
        chunks.length = 0
        req.resume()
        rejectPromise(new HttpError(413, 'payload-too-large', `Размер больше лимита ${Math.round(limit / 1024 / 1024)} МиБ`))
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      if (settled) return
      settled = true
      resolvePromise(Buffer.concat(chunks))
    })
    req.on('error', (error) => {
      if (settled) return
      settled = true
      rejectPromise(error)
    })
  })
}

/**
 * Read and parse a small JSON body.
 * @param {import('node:http').IncomingMessage} req - request.
 * @returns {Promise<Record<string, unknown>>} parsed object (empty for no body).
 * @throws {HttpError} 400 on malformed JSON.
 */
async function readJson(req) {
  const buffer = await readBody(req, MAX_JSON_BYTES)
  const text = buffer.toString('utf8').trim()
  if (text === '') return {}
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new HttpError(400, 'bad-request', 'Ожидался JSON')
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new HttpError(400, 'bad-request', 'Ожидался JSON-объект')
  }
  return parsed
}

/**
 * Validate a notification kind from a query/body.
 * @param {unknown} raw - raw value.
 * @returns {'completed' | 'question'} normalized kind.
 * @throws {HttpError} 400 for an unknown kind.
 */
function normalizeKind(raw) {
  const value = typeof raw === 'string' ? raw.trim().toLowerCase() : ''
  if (value === 'completed' || value === 'question') return value
  throw new HttpError(400, 'bad-request', 'kind должен быть completed или question')
}

/**
 * Detect the real audio format from a file signature.
 * WAV — `RIFF` … `WAVE`; MP3 — `ID3` tag or an MPEG frame sync byte `0xFF 0xEx`.
 * @param {Buffer} buffer - uploaded bytes.
 * @returns {'wav' | 'mp3' | null} detected format.
 */
function detectAudioFormat(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 4) return null
  if (buffer.length >= 12
    && buffer.toString('ascii', 0, 4) === 'RIFF'
    && buffer.toString('ascii', 8, 12) === 'WAVE') {
    return 'wav'
  }
  if (buffer.length >= 3 && buffer.toString('latin1', 0, 3) === 'ID3') return 'mp3'
  if (buffer.length >= 2 && buffer[0] === 0xff && (buffer[1] & 0xe0) === 0xe0) return 'mp3'
  return null
}

/**
 * List the saved custom sounds of one kind.
 * @param {'completed' | 'question'} kind - notification kind.
 * @returns {string[]} absolute paths.
 */
function savedSoundFiles(kind) {
  try {
    return readdirSync(SOUNDS_DIR)
      .filter((entry) => new RegExp(`^${kind}-\\d+\\.(?:mp3|wav)$`, 'i').test(entry))
      .map((entry) => join(SOUNDS_DIR, entry))
  } catch {
    return []
  }
}

/**
 * Delete every saved custom sound of one kind, optionally sparing one file.
 * @param {'completed' | 'question'} kind - notification kind.
 * @param {string} [keepPath] - file to keep (the fresh upload).
 * @returns {number} number of removed files.
 */
function removeSavedSounds(kind, keepPath) {
  let removed = 0
  const keep = keepPath === undefined ? undefined : resolve(keepPath)
  for (const file of savedSoundFiles(kind)) {
    if (keep !== undefined && resolve(file) === keep) continue
    try {
      unlinkSync(file)
      removed += 1
    } catch {}
  }
  return removed
}

/**
 * Whether `candidate` resolves inside `root` (case-insensitive, Windows paths).
 * @param {string} candidate - absolute path.
 * @param {string} root - absolute directory.
 * @returns {boolean} true when the candidate lives inside the root.
 */
function isInside(candidate, root) {
  const target = resolve(candidate).toLowerCase()
  const base = resolve(root).toLowerCase()
  return target === base || target.startsWith(base.endsWith(sep) ? base : `${base}${sep}`)
}

/**
 * Validate the `sound` value accepted by preview routes: only `false`, `true`,
 * or an absolute path inside `sounds/` or `host/` (no arbitrary file playback
 * from a web page).
 * @param {unknown} value - requested sound.
 * @returns {boolean | string} normalized value.
 * @throws {HttpError} 400 for anything outside the allow-list.
 */
function validatePreviewSound(value) {
  if (value === true || value === false) return value
  if (typeof value !== 'string' || value.trim() === '') {
    throw new HttpError(400, 'bad-request', 'sound должен быть false, true или абсолютным путём к файлу в sounds/ или host/')
  }
  const raw = value.trim()
  if (!isAbsolute(raw)) {
    throw new HttpError(400, 'bad-request', 'sound: нужен абсолютный путь внутри sounds/ или host/')
  }
  const absolute = resolve(raw)
  if (!isInside(absolute, SOUNDS_DIR) && !isInside(absolute, HOST_DIR)) {
    throw new HttpError(400, 'bad-request', 'sound: путь вне sounds/ и host/ запрещён')
  }
  return absolute
}

/**
 * Read the plugin version from its own package.json (the bundle ships it).
 * @returns {string | null} version string, or null when unreadable.
 */
function pluginVersion() {
  try {
    const parsed = JSON.parse(readFileSync(PACKAGE_JSON, 'utf8'))
    return typeof parsed?.version === 'string' ? parsed.version : null
  } catch {
    return null
  }
}

/**
 * Describe the currently configured custom sound of one kind.
 * @param {unknown} config - plugin Config.
 * @param {'completed' | 'question'} kind - notification kind.
 * @returns {{ file: string, name: string, exists: boolean, format: string } | null} info or null.
 */
function customSoundInfo(config, kind) {
  const field = kind === 'question' ? 'questionSoundFile' : 'completedSoundFile'
  const raw = configField(config, field)
  const text = typeof raw === 'string' ? raw.trim() : ''
  if (text === '') return null
  const absolute = isAbsolute(text) ? text : resolve(HERE, text)
  const extension = extname(absolute).toLowerCase()
  const format = extension === '.mp3' || extension === '.wav' ? extension.slice(1) : ''
  let exists = false
  try {
    exists = statSync(absolute).isFile()
  } catch {
    exists = false
  }
  return { file: absolute, name: basename(absolute), exists, format }
}

/* ------------------------------------------------------------------ */
/* HTTP route handlers                                                */
/* ------------------------------------------------------------------ */

/**
 * Handle GET /dsh-topmost-notify/status.
 * @param {import('node:http').ServerResponse} res - response.
 * @param {unknown} config - plugin Config.
 * @returns {void}
 */
function handleStatus(res, config) {
  sendJson(res, 200, {
    ok: true,
    plugin: 'topmost-notify',
    version: pluginVersion(),
    limits: { duration: { ...DURATION_LIMITS } },
    bundled: { completed: 'chime.wav', question: 'chime-question.wav' },
    custom: {
      completed: customSoundInfo(config, 'completed'),
      question: customSoundInfo(config, 'question'),
    },
    soundDir: SOUNDS_DIR,
  })
}

/**
 * Handle POST /dsh-topmost-notify/sounds?kind=…: raw file bytes in the body,
 * original name in the `x-file-name` header (encodeURIComponent).
 * @param {import('node:http').IncomingMessage} req - request.
 * @param {import('node:http').ServerResponse} res - response.
 * @param {string | null} rawKind - `kind` query parameter.
 * @returns {Promise<void>} completion after the response is sent.
 */
async function handleSoundUpload(req, res, rawKind) {
  const kind = normalizeKind(rawKind)
  const header = req.headers['x-file-name']
  if (typeof header !== 'string' || header.trim() === '') {
    throw new HttpError(400, 'bad-request', 'Не указано имя файла: заголовок x-file-name обязателен')
  }
  let fileName = header
  try {
    fileName = decodeURIComponent(header)
  } catch {
    fileName = header
  }
  const extension = extname(fileName).toLowerCase()
  if (extension !== '.mp3' && extension !== '.wav') {
    throw new HttpError(400, 'bad-request', 'Принимаются только файлы .mp3 и .wav')
  }
  const body = await readBody(req, MAX_SOUND_BYTES)
  if (body.length === 0) throw new HttpError(400, 'bad-request', 'Пустой файл')
  const format = detectAudioFormat(body)
  if (format === null) {
    throw new HttpError(400, 'bad-request', 'Не удалось распознать формат: ожидался WAV (RIFF/WAVE) или MP3 (ID3 / кадровый синхробайт)')
  }
  if (`${format}` !== extension.slice(1)) {
    throw new HttpError(400, 'bad-request', `Расширение ${extension} не совпадает с содержимым (${format.toUpperCase()})`)
  }
  mkdirSync(SOUNDS_DIR, { recursive: true })
  const target = join(SOUNDS_DIR, `${kind}-${Date.now()}.${format}`)
  writeFileSync(target, body)
  const removed = removeSavedSounds(kind, target)
  log('sound-upload', kind, target, `${body.length}b`, `removed=${removed}`)
  sendJson(res, 200, { ok: true, kind, path: target, name: basename(target), bytes: body.length, format })
}

/**
 * Handle POST /dsh-topmost-notify/reset-sound: delete the saved custom sound.
 * @param {import('node:http').IncomingMessage} req - request.
 * @param {import('node:http').ServerResponse} res - response.
 * @returns {Promise<void>} completion after the response is sent.
 */
async function handleResetSound(req, res) {
  const body = await readJson(req)
  const kind = normalizeKind(body.kind)
  const removed = removeSavedSounds(kind)
  log('sound-reset', kind, `removed=${removed}`)
  sendJson(res, 200, { ok: true, kind })
}

/**
 * Handle POST /dsh-topmost-notify/preview: show a sample notification window.
 * #body `{ kind, durationMs?, sound? }`
 * @param {import('node:http').IncomingMessage} req - request.
 * @param {import('node:http').ServerResponse} res - response.
 * @param {unknown} config - plugin Config.
 * @returns {Promise<void>} completion after the response is sent.
 */
async function handlePreview(req, res, config) {
  const body = await readJson(req)
  const kind = normalizeKind(body.kind)
  const settings = resolveKindSettings(config, kind)
  let durationMs = settings.durationMs
  if (body.durationMs !== undefined && body.durationMs !== null) {
    const numeric = typeof body.durationMs === 'number' ? body.durationMs : Number(body.durationMs)
    if (!Number.isFinite(numeric)) throw new HttpError(400, 'bad-request', 'durationMs должен быть числом')
    durationMs = clampDuration(numeric)
  }
  const sound = body.sound === undefined ? settings.sound : validatePreviewSound(body.sound)
  const payload = {
    kind,
    title: PREVIEW_SAMPLES[kind].title,
    body: PREVIEW_SAMPLES[kind].body,
    durationMs,
    sound,
  }
  showNotification(payload)
  sendJson(res, 200, { ok: true, payload })
}

/**
 * Handle POST /dsh-topmost-notify/preview-sound: play only the sound.
 * #body `{ kind, sound? }`
 * @param {import('node:http').IncomingMessage} req - request.
 * @param {import('node:http').ServerResponse} res - response.
 * @param {unknown} config - plugin Config.
 * @returns {Promise<void>} completion after the response is sent.
 */
async function handlePreviewSound(req, res, config) {
  const body = await readJson(req)
  const kind = normalizeKind(body.kind)
  const settings = resolveKindSettings(config, kind)
  const sound = body.sound === undefined ? settings.sound : validatePreviewSound(body.sound)
  const payload = { kind, sound, previewSound: true }
  previewSoundOnly(payload)
  sendJson(res, 200, { ok: true })
}

/**
 * Route one request under the plugin prefix.
 * @param {import('node:http').IncomingMessage} req - request.
 * @param {import('node:http').ServerResponse} res - response.
 * @param {unknown} config - plugin Config.
 * @returns {Promise<void>} completion after the response is sent.
 */
async function handleRequest(req, res, config) {
  const url = new URL(req.url ?? '/', 'http://topmost-notify.local')
  const pathname = url.pathname

  if (pathname === `${ROUTE_PREFIX}/status`) {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, { allow: 'GET, HEAD' }).end()
      return
    }
    handleStatus(res, config)
    return
  }
  if (pathname === `${ROUTE_PREFIX}/sounds`) {
    if (req.method !== 'POST') {
      res.writeHead(405, { allow: 'POST' }).end()
      return
    }
    await handleSoundUpload(req, res, url.searchParams.get('kind'))
    return
  }
  if (pathname === `${ROUTE_PREFIX}/reset-sound`) {
    if (req.method !== 'POST') {
      res.writeHead(405, { allow: 'POST' }).end()
      return
    }
    await handleResetSound(req, res)
    return
  }
  if (pathname === `${ROUTE_PREFIX}/preview`) {
    if (req.method !== 'POST') {
      res.writeHead(405, { allow: 'POST' }).end()
      return
    }
    await handlePreview(req, res, config)
    return
  }
  if (pathname === `${ROUTE_PREFIX}/preview-sound`) {
    if (req.method !== 'POST') {
      res.writeHead(405, { allow: 'POST' }).end()
      return
    }
    await handlePreviewSound(req, res, config)
    return
  }
  sendError(res, 404, 'not-found', 'Неизвестный маршрут topmost-notify')
}

/**
 * Build the prefix handler registered in the Host web server.
 * @param {unknown} config - plugin Config.
 * @returns {(req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => void} handler.
 */
function createHandler(config) {
  return (req, res) => {
    handleRequest(req, res, config).catch((error) => {
      try {
        if (error instanceof HttpError) {
          sendError(res, error.status, error.code, error.message)
          return
        }
        log('http-error', error?.message ?? String(error))
        sendError(res, 500, 'internal', 'Внутренняя ошибка topmost-notify')
      } catch {}
    })
  }
}

/**
 * Register the HTTP API, degrading safely when the Host composes no web server.
 * @param {import('@deepseek-ai/cordis').Context} ctx - Host context.
 * @param {unknown} config - plugin Config.
 * @returns {void}
 */
function registerHttpApi(ctx, config) {
  if (typeof ctx.effect !== 'function') {
    log('http-skip', 'ctx.effect отсутствует')
    return
  }
  try {
    ctx.effect(() => {
      const server = ctx.webServer
      if (server === undefined || server === null || typeof server.register !== 'function') {
        log('http-skip', 'webServer отсутствует')
        return () => {}
      }
      try {
        const dispose = server.register({
          kind: 'prefix',
          path: ROUTE_PREFIX,
          handler: createHandler(config),
        })
        log('http-registered', ROUTE_PREFIX)
        return dispose
      } catch (error) {
        log('http-register-failed', error?.message ?? String(error))
        return () => {}
      }
    }, 'topmost-notify: HTTP API')
  } catch (error) {
    log('http-effect-failed', error?.message ?? String(error))
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
  registerHttpApi(ctx, config)

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
        const settings = resolveKindSettings(config, 'question')
        showNotification({
          kind: 'question',
          title: '❓ Нужен ваш ответ',
          body: body.length > 0 ? body : 'Агент ждёт ответа в чате',
          durationMs: settings.durationMs,
          sound: settings.sound,
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
      const settings = resolveKindSettings(config, 'completed')
      log('turn/end', sessionId, 'reason=' + reason, 'delegated=' + delegated,
        'enabled=' + String(configValue(config?.enabled, '?')),
        'test=' + String(configValue(config?.notifySubagentTest, '?')),
        'duration=' + String(settings.durationMs),
        'sound=' + String(settings.sound))
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
        durationMs: settings.durationMs,
        sound: settings.sound,
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
