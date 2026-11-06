/**
 * dsh-voice-reply — host half.
 *
 * Serves the browser half a small local HTTP API that synthesizes speech with
 * Yandex SpeechKit TTS v1 and caches the resulting audio:
 *
 *   GET  /dsh-voice-reply/status          → configuration + voice catalogue
 *   POST /dsh-voice-reply/speak           → { text, messageId? } → chunk URLs
 *   GET  /dsh-voice-reply/audio/<file>    → audio bytes (mp3/ogg/wav)
 *
 * Credentials live in `plugin-config.json` beside this module (re-read on every
 * request, so replacing the key needs no `dsh web` restart) or in the
 * `YANDEX_TTS_API_KEY`, `YANDEX_TTS_IAM_TOKEN` and `YANDEX_TTS_FOLDER_ID`
 * environment variables, which are read first and win over the file. The plugin
 * never logs the answer text or the key: only counts, timings and status codes
 * reach `.state/events.log`.
 */
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  DEFAULT_ENDPOINT,
  FORMATS,
  VOICES,
  TtsError,
  extForFormat,
  mimeForFormat,
  splitIntoChunks,
  synthesizeChunk,
} from './lib/yandex-tts.js'
import {
  MAX_SUMMARY_MAX_CHARS,
  MIN_SUMMARY_MAX_CHARS,
  SUMMARY_STEP,
  clampSummaryMaxChars,
  summarizeSpeechText,
} from './lib/summarize.js'

/** Stable Loader identity; also the `configForms` namespace the browser half edits. */
export const name = 'voice-reply'

/** The HTTP carrier is the only required service. */
export const inject = ['webServer']

/** Maximum accepted JSON request body for /speak. */
const MAX_BODY_BYTES = 1024 * 1024

/** Route prefix owned by this plugin. */
const ROUTE_PREFIX = '/dsh-voice-reply'

/** Sample phrases spoken by the settings-page voice preview, by voice language. */
const PREVIEW_TEXTS = Object.freeze({
  ru: 'Привет! Так звучит выбранный голос. Проверьте, нравится ли вам скорость и интонация.',
  en: 'Hello! This is how the selected voice sounds. Check the speed and intonation.',
  de: 'Hallo! So klingt die ausgewählte Stimme. Prüfen Sie Sprechtempo und Intonation.',
  kk: 'Сәлеметсіз бе! Бұл таңдалған дауыс. Сөйлеу жылдамдығын тексеріңіз.',
  uz: 'Salom! Bu tanlangan ovoz. Nutq tezligini tekshiring.',
})

/**
 * Pick the preview phrase for one voice language (`ru-RU` → `ru`).
 * @param {string} lang - BCP-47-ish voice language.
 * @returns {string} sample phrase.
 */
function previewTextFor(lang) {
  const key = String(lang).toLowerCase().slice(0, 2)
  return PREVIEW_TEXTS[key] ?? PREVIEW_TEXTS.ru
}

/** Cache directory: audio is reproducible from the key, so the OS temp dir fits. */
const CACHE_DIR = path.join(os.tmpdir(), 'dsh-voice-reply-cache')

/** Cached audio older than this is deleted on activation (7 days). */
const CACHE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000

/** Hard cap for the on-disk audio cache (best effort; oldest files go first). */
const CACHE_MAX_BYTES = 512 * 1024 * 1024

/**
 * Volatile plugin settings. This bundle is installed from a linked workspace
 * directory, where bare imports of DSH's own packages do not resolve, so the
 * plugin deliberately exports no schemastery `Config`: preferences that the UI
 * writes (autoSpeak, enabled) live in `plugin-config.json` beside this module
 * and are changed through `POST /dsh-voice-reply/preferences`. The row in
 * `cordis.patch.yml` supplies the other defaults.
 */

/** Directory of this module; the credential file and the log live beside it. */
const HERE = path.dirname(fileURLToPath(import.meta.url))

/* ------------------------------------------------------------------ */
/* Small helpers                                                      */
/* ------------------------------------------------------------------ */

/**
 * Read one Config member. `.volatile()` fields arrive as live references that
 * expose `get()`; plain fields arrive as values.
 * @param {unknown} value - raw Config member.
 * @param {unknown} fallback - value used when absent/empty.
 * @returns {unknown} plain current value.
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
 * Coerce a value into a finite number inside a range.
 * @param {unknown} value - candidate.
 * @param {number} min - lower bound.
 * @param {number} max - upper bound.
 * @param {number} fallback - value used when candidate is not numeric.
 * @returns {number} clamped number.
 */
function clampNumber(value, min, max, fallback) {
  const number = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(number)) return fallback
  return Math.min(max, Math.max(min, number))
}

/**
 * Whether a string is a non-empty trimmed string.
 * @param {unknown} value - candidate.
 * @returns {boolean} true for a usable string.
 */
function nonEmpty(value) {
  return typeof value === 'string' && value.trim() !== ''
}

/**
 * First non-empty string of the arguments.
 * @param {...unknown} values - candidates.
 * @returns {string|undefined} first usable value.
 */
function pick(...values) {
  return values.find(nonEmpty)
}

/**
 * Append one diagnostic line to the plugin log; never throws.
 * @param {string} line - event name.
 * @param {Record<string, unknown>} [fields] - redacted fields (no text, no keys).
 * @returns {void}
 */
function appendEvent(line, fields) {
  try {
    const file = path.join(HERE, '.state', 'events.log')
    fs.mkdirSync(path.dirname(file), { recursive: true })
    try {
      if (fs.statSync(file).size > 512 * 1024) fs.renameSync(file, `${file}.1`)
    } catch {
      /* no previous log */
    }
    fs.appendFileSync(file, `${JSON.stringify({ ts: new Date().toISOString(), event: line, ...fields })}\n`, 'utf8')
  } catch {
    /* diagnostics must never break speech */
  }
}

/**
 * Read plugin-config.json; a missing file is an empty object, a broken file is
 * an explicit error (silently using stale/foreign credentials would be worse).
 * @returns {Record<string, unknown>} parsed configuration.
 * @throws {Error} when the file exists but is not a JSON object.
 */
function readFileConfig() {
  const file = path.join(HERE, 'plugin-config.json')
  let raw
  try {
    raw = fs.readFileSync(file, 'utf8')
  } catch (error) {
    if (error && error.code === 'ENOENT') return {}
    throw new Error(`voice-reply: не удалось прочитать ${file}: ${error?.message ?? error}`)
  }
  try {
    const parsed = JSON.parse(raw)
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('ожидался JSON-объект')
    }
    return parsed
  } catch (error) {
    throw new Error(`voice-reply: ${file} содержит некорректный JSON: ${error?.message ?? error}`)
  }
}

/**
 * Strip an authorization prefix a user may have pasted together with the key.
 * @param {string} value - raw secret.
 * @returns {string} bare secret.
 */
function bareSecret(value) {
  return String(value).trim().replace(/^(api-key|apikey|bearer)\s+/i, '')
}

/**
 * Resolve effective TTS settings: defaults ← plugin-config.json ← env ← Config.
 * Re-read on every request so key/config edits are live.
 * @param {unknown} config - plugin Config (volatile members are wrappers).
 * @returns {Record<string, unknown>} normalized settings.
 */
function resolveSettings(config) {
  const file = readFileConfig()
  const env = process.env

  const apiKeyRaw = pick(env.YANDEX_TTS_API_KEY, env.YANDEX_SPEECHKIT_API_KEY, env.YC_API_KEY, file.apiKey)
  const iamTokenRaw = pick(env.YANDEX_TTS_IAM_TOKEN, env.YANDEX_SPEECHKIT_IAM_TOKEN, env.YC_IAM_TOKEN, file.iamToken)
  const folderId = pick(env.YANDEX_TTS_FOLDER_ID, env.YANDEX_SPEECHKIT_FOLDER_ID, env.YC_FOLDER_ID, file.folderId)
  const authMode = nonEmpty(iamTokenRaw) ? 'iam' : nonEmpty(apiKeyRaw) ? 'api-key' : 'none'
  const secret = authMode === 'iam' ? bareSecret(iamTokenRaw) : bareSecret(apiKeyRaw ?? '')

  // The plugin settings page writes voice and speed to plugin-config.json; the
  // file value wins over the patch row so a choice applies without a profile
  // edit. Unknown/empty values fall back to the patch/default voice.
  const fileVoice = VOICES.find((entry) => entry.id === file.voice)
  const configVoice = VOICES.find((entry) => entry.id === configValue(config?.voice, ''))
  const known = fileVoice ?? configVoice ?? VOICES[0]
  const voice = known.id
  const format = String(pick(configValue(config?.format, ''), file.format) ?? 'mp3')
  const endpoint = String(pick(env.YANDEX_TTS_ENDPOINT, file.endpoint) ?? DEFAULT_ENDPOINT)

  // UI-written preferences live in plugin-config.json and win over the patch
  // row, so a Settings toggle survives remounts without editing the profile.
  const enabled = typeof file.enabled === 'boolean' ? file.enabled : configValue(config?.enabled, true) !== false
  const autoSpeak = typeof file.autoSpeak === 'boolean' ? file.autoSpeak : configValue(config?.autoSpeak, true) !== false
  // The spoken summary budget is the user-facing setting: the plugin settings
  // page writes it to plugin-config.json, so the file value wins over the patch.
  const summaryMaxChars = clampSummaryMaxChars(
    file.summaryMaxChars === undefined || file.summaryMaxChars === null
      ? configValue(config?.summaryMaxChars, undefined)
      : file.summaryMaxChars,
  )
  const speedSource = file.speed === undefined || file.speed === null ? configValue(config?.speed, undefined) : file.speed

  // Intonation (`emotion` in the Yandex API) is voice-specific. The settings
  // page writes the chosen emotion to plugin-config.json, so the file value
  // wins over the patch row; a value the selected voice does not support (for
  // example after switching to a voice without emotions) falls back to the
  // voice default instead of failing the synthesis request.
  const requestedEmotion = String(pick(file.emotion, configValue(config?.emotion, '')) ?? '').trim()
  const supportedEmotions = Array.isArray(known.emotions) ? known.emotions : []
  const emotion = supportedEmotions.includes(requestedEmotion) ? requestedEmotion : ''
  const emotionOptions = supportedEmotions.slice()

  return {
    authMode,
    secret,
    folderId: typeof folderId === 'string' ? folderId.trim() : '',
    endpoint,
    voice,
    lang: known.lang,
    emotion,
    emotionOptions,
    speed: clampNumber(speedSource, 0.1, 3, 1),
    format: FORMATS[format] === undefined ? 'mp3' : format,
    maxChars: Math.round(clampNumber(configValue(config?.maxChars, undefined), 100, 20000, 4000)),
    summaryMaxChars,
    enabled,
    autoSpeak,
    debug: configValue(config?.debug, true) !== false,
    configured: authMode !== 'none',
  }
}

/**
 * Persist UI-owned preferences into `plugin-config.json` (read-modify-write,
 * atomic rename). Credentials and the other fields are preserved verbatim.
 * @param {{ autoSpeak?: boolean, enabled?: boolean, summaryMaxChars?: number, voice?: string, emotion?: string, speed?: number }} patch - changed preferences.
 * @returns {{ autoSpeak: boolean, enabled: boolean, summaryMaxChars: number, voice: string, emotion: string, speed: number }} stored preferences.
 * @throws {Error} when the file cannot be written.
 */
function writePreferences(patch) {
  const file = readFileConfig()
  const next = { ...file }
  if (typeof patch.autoSpeak === 'boolean') next.autoSpeak = patch.autoSpeak
  if (typeof patch.enabled === 'boolean') next.enabled = patch.enabled
  if (patch.summaryMaxChars !== undefined) next.summaryMaxChars = clampSummaryMaxChars(patch.summaryMaxChars)
  if (nonEmpty(patch.voice)) next.voice = String(patch.voice)
  // An empty string is a real choice: it clears the intonation and lets the
  // voice default apply.
  if (typeof patch.emotion === 'string') next.emotion = patch.emotion
  if (patch.speed !== undefined) next.speed = clampNumber(patch.speed, 0.1, 3, 1)
  const target = path.join(HERE, 'plugin-config.json')
  const temporary = path.join(HERE, `.plugin-config.json.${process.pid}.tmp`)
  fs.writeFileSync(temporary, `${JSON.stringify(next, null, 2)}\n`, 'utf8')
  fs.renameSync(temporary, target)
  return {
    autoSpeak: typeof next.autoSpeak === 'boolean' ? next.autoSpeak : true,
    enabled: typeof next.enabled === 'boolean' ? next.enabled : true,
    summaryMaxChars: clampSummaryMaxChars(next.summaryMaxChars),
    voice: nonEmpty(next.voice) ? String(next.voice) : VOICES[0].id,
    emotion: typeof next.emotion === 'string' ? next.emotion : '',
    speed: clampNumber(next.speed, 0.1, 3, 1),
  }
}

/* ------------------------------------------------------------------ */
/* Response helpers                                                   */
/* ------------------------------------------------------------------ */

/**
 * Send a JSON response.
 * @param {import('node:http').ServerResponse} res - response.
 * @param {number} status - HTTP status.
 * @param {unknown} body - JSON-serializable body.
 * @param {Record<string, string>} [headers] - extra headers.
 * @returns {void}
 */
function sendJson(res, status, body, headers = {}) {
  const payload = Buffer.from(JSON.stringify(body), 'utf8')
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': payload.length,
    'cache-control': 'no-store',
    ...headers,
  })
  res.end(payload)
}

/**
 * Send one structured error.
 * @param {import('node:http').ServerResponse} res - response.
 * @param {number} status - HTTP status.
 * @param {{ code: string, message: string, hint?: string, detail?: string }} error - error fields.
 * @returns {void}
 */
function sendError(res, status, error) {
  sendJson(res, status, { ok: false, error })
}

/**
 * Map an engine error to an HTTP response.
 * @param {import('node:http').ServerResponse} res - response.
 * @param {unknown} error - thrown value.
 * @param {string} context - log context.
 * @returns {void}
 */
function sendEngineError(res, error, context) {
  if (error instanceof TtsError) {
    const status = error.status === 401 ? 401 : error.status === 403 ? 403 : error.status === 429 ? 429 : error.status === 400 ? 400 : 502
    appendEvent(`${context}.error`, { code: error.code, status: error.status ?? status })
    sendError(res, status, {
      code: error.code,
      message: error.message,
      ...(error.hint === undefined ? {} : { hint: error.hint }),
      ...(error.detail === undefined ? {} : { detail: error.detail }),
      ...(error.status === undefined ? {} : { status: error.status }),
    })
    return
  }
  const message = error instanceof Error ? error.message : String(error)
  appendEvent(`${context}.error`, { code: 'internal', message: message.slice(0, 300) })
  sendError(res, 500, { code: 'internal', message: 'Внутренняя ошибка плагина озвучки', detail: message.slice(0, 300) })
}

/**
 * Read a request body with a hard byte cap.
 * @param {import('node:http').IncomingMessage} req - request.
 * @param {number} limit - maximum bytes.
 * @returns {Promise<Buffer>} body.
 * @throws {TtsError} when the body exceeds the cap.
 */
function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > limit) {
        reject(new TtsError('Тело запроса слишком велико', { status: 413, code: 'bad-request', hint: 'Ответ длиннее 1 МБ' }))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks)))
    req.on('error', (error) => reject(error))
  })
}

/* ------------------------------------------------------------------ */
/* Audio cache                                                        */
/* ------------------------------------------------------------------ */

/** In-memory index of finished syntheses: cache key → chunk metadata. */
const memoryCache = new Map()

/**
 * Remove expired cache directories and enforce the size cap; best effort.
 * @returns {void}
 */
function pruneCache() {
  try {
    fs.mkdirSync(CACHE_DIR, { recursive: true })
    const entries = fs.readdirSync(CACHE_DIR, { withFileTypes: true }).filter((entry) => entry.isDirectory())
    const now = Date.now()
    const live = []
    for (const entry of entries) {
      const dir = path.join(CACHE_DIR, entry.name)
      let stat
      try {
        stat = fs.statSync(dir)
      } catch {
        continue
      }
      if (now - stat.mtimeMs > CACHE_MAX_AGE_MS) {
        fs.rmSync(dir, { recursive: true, force: true })
        continue
      }
      let bytes = 0
      try {
        for (const file of fs.readdirSync(dir)) {
          try {
            bytes += fs.statSync(path.join(dir, file)).size
          } catch {
            /* racing cleanup */
          }
        }
      } catch {
        /* racing cleanup */
      }
      live.push({ dir, mtimeMs: stat.mtimeMs, bytes })
    }
    let total = live.reduce((sum, item) => sum + item.bytes, 0)
    if (total > CACHE_MAX_BYTES) {
      live.sort((a, b) => a.mtimeMs - b.mtimeMs)
      for (const item of live) {
        if (total <= CACHE_MAX_BYTES) break
        fs.rmSync(item.dir, { recursive: true, force: true })
        total -= item.bytes
      }
    }
  } catch {
    /* the cache is an optimization */
  }
}

/**
 * Synthesize (or reuse) one answer and return its chunk descriptors.
 * @param {{ text: string, messageId?: string }} request - cleaned request.
 * @param {Record<string, unknown>} settings - resolved settings.
 * @returns {Promise<{ key: string, chunks: Array<{ index: number, url: string, mime: string, bytes: number }>, chars: number, sourceChars: number, summarized: boolean, truncated: boolean, cached: boolean }>} result.
 */
async function synthesizeAnswer(request, settings) {
  // Speak the short extractive summary instead of the whole answer. `maxChars`
  // stays as a legacy hard cap; the user-facing budget is `summaryMaxChars`.
  const limit = Math.min(settings.summaryMaxChars, settings.maxChars)
  const prepared = summarizeSpeechText(request.text, { maxChars: limit })
  if (!nonEmpty(prepared.text)) {
    throw new TtsError('Нечего озвучивать: после очистки текста не осталось', {
      status: 400,
      code: 'bad-request',
      hint: 'Ответ состоял только из кода или разметки',
    })
  }
  const chunks = splitIntoChunks(prepared.text, {
    voice: settings.voice,
    lang: settings.lang,
    format: settings.format,
    speed: settings.speed,
    emotion: settings.emotion,
    folderId: settings.authMode === 'iam' ? settings.folderId : undefined,
  })
  const key = crypto
    .createHash('sha256')
    .update([settings.voice, settings.emotion, settings.speed, settings.format, settings.lang, prepared.text].join('\u0000'))
    .digest('hex')
    .slice(0, 32)

  const existing = memoryCache.get(key)
  if (existing !== undefined) {
    return {
      key,
      chunks: existing.chunks,
      chars: prepared.text.length,
      sourceChars: prepared.sourceChars,
      summarized: prepared.summarized,
      truncated: prepared.truncated,
      cached: true,
    }
  }

  const dir = path.join(CACHE_DIR, key)
  const ext = extForFormat(settings.format)
  const mime = mimeForFormat(settings.format)
  const metaFile = path.join(dir, 'meta.json')

  // A previous process may have finished this answer already.
  try {
    const meta = JSON.parse(fs.readFileSync(metaFile, 'utf8'))
    if (meta?.chunks?.length === chunks.length && chunks.every((_, index) => fs.existsSync(path.join(dir, `${index}.${ext}`)))) {
      const record = { chunks: meta.chunks, voice: settings.voice, format: settings.format, mime, lang: settings.lang, chars: prepared.text.length }
      memoryCache.set(key, record)
      return {
        key,
        chunks: record.chunks,
        chars: prepared.text.length,
        sourceChars: prepared.sourceChars,
        summarized: prepared.summarized,
        truncated: prepared.truncated,
        cached: true,
      }
    }
  } catch {
    /* no reusable cache entry */
  }

  fs.mkdirSync(dir, { recursive: true })
  const descriptors = []
  try {
    for (let index = 0; index < chunks.length; index += 1) {
      const result = await synthesizeChunk({
        text: chunks[index],
        voice: settings.voice,
        emotion: settings.emotion,
        speed: settings.speed,
        lang: settings.lang,
        format: settings.format,
        apiKey: settings.authMode === 'api-key' ? settings.secret : undefined,
        iamToken: settings.authMode === 'iam' ? settings.secret : undefined,
        folderId: settings.authMode === 'iam' ? settings.folderId : undefined,
        endpoint: settings.endpoint,
      })
      const file = `${index}.${ext}`
      fs.writeFileSync(path.join(dir, file), result.audio)
      descriptors.push({ index, url: `${ROUTE_PREFIX}/audio/${key}-${file}`, mime: result.mime, bytes: result.bytes })
    }
  } catch (error) {
    fs.rmSync(dir, { recursive: true, force: true })
    throw error
  }

  const record = {
    chunks: descriptors,
    voice: settings.voice,
    format: settings.format,
    mime,
    lang: settings.lang,
    chars: prepared.text.length,
    sourceChars: prepared.sourceChars,
    summarized: prepared.summarized,
  }
  memoryCache.set(key, record)
  if (memoryCache.size > 60) {
    const oldest = memoryCache.keys().next().value
    memoryCache.delete(oldest)
  }
  try {
    fs.writeFileSync(
      metaFile,
      JSON.stringify({
        key,
        voice: settings.voice,
        format: settings.format,
        lang: settings.lang,
        chars: prepared.text.length,
        sourceChars: prepared.sourceChars,
        summarized: prepared.summarized,
        chunks: descriptors,
      }),
      'utf8',
    )
  } catch {
    /* metadata is an optimization */
  }
  return {
    key,
    chunks: descriptors,
    chars: prepared.text.length,
    sourceChars: prepared.sourceChars,
    summarized: prepared.summarized,
    truncated: prepared.truncated,
    cached: false,
  }
}

/* ------------------------------------------------------------------ */
/* HTTP routes                                                        */
/* ------------------------------------------------------------------ */

/** Serializes synthesis so a burst of answers cannot exhaust the TTS quota. */
let speechChain = Promise.resolve()

/**
 * Queue one synthesis behind all earlier ones.
 * @template T
 * @param {() => Promise<T>} task - work.
 * @returns {Promise<T>} task result.
 */
function enqueueSpeech(task) {
  const run = speechChain.then(task, task)
  speechChain = run.then(
    () => undefined,
    () => undefined,
  )
  return run
}

/**
 * Handle GET /dsh-voice-reply/status.
 * @param {import('node:http').ServerResponse} res - response.
 * @param {unknown} config - plugin Config.
 * @returns {void}
 */
function handleStatus(res, config) {
  let settings
  try {
    settings = resolveSettings(config)
  } catch (error) {
    sendError(res, 500, { code: 'not-configured', message: error instanceof Error ? error.message : String(error) })
    return
  }
  sendJson(res, 200, {
    ok: true,
    plugin: 'voice-reply',
    configured: settings.configured,
    authMode: settings.authMode,
    voice: settings.voice,
    lang: settings.lang,
    emotion: settings.emotion,
    emotionOptions: settings.emotionOptions,
    speed: settings.speed,
    format: settings.format,
    mime: mimeForFormat(settings.format),
    autoSpeak: settings.autoSpeak,
    enabled: settings.enabled,
    maxChars: settings.maxChars,
    summaryMaxChars: settings.summaryMaxChars,
    summaryLimits: { min: MIN_SUMMARY_MAX_CHARS, max: MAX_SUMMARY_MAX_CHARS, step: SUMMARY_STEP },
    voices: VOICES,
    error: settings.configured
      ? null
      : 'Yandex SpeechKit TTS не настроен: добавьте API-ключ со скоупом yc.ai.speechkitTts.execute в plugin-config.json плагина voice-reply',
  })
}

/**
 * Handle POST /dsh-voice-reply/preferences: persist the UI-owned preferences.
 * @param {import('node:http').IncomingMessage} req - request.
 * @param {import('node:http').ServerResponse} res - response.
 * @param {unknown} config - plugin Config.
 * @returns {Promise<void>} completion after the response is sent.
 */
async function handlePreferences(req, res, config) {
  let current
  try {
    current = resolveSettings(config)
  } catch (error) {
    sendError(res, 500, { code: 'not-configured', message: error instanceof Error ? error.message : String(error) })
    return
  }
  let body
  try {
    body = JSON.parse((await readBody(req, 64 * 1024)).toString('utf8'))
  } catch (error) {
    if (error instanceof TtsError) {
      sendError(res, 413, { code: error.code, message: error.message })
      return
    }
    sendError(res, 400, {
      code: 'bad-request',
      message: 'Ожидался JSON { autoSpeak?: boolean, enabled?: boolean, summaryMaxChars?: number, voice?: string, emotion?: string, speed?: number }',
    })
    return
  }
  const patch = {}
  if (body !== null && typeof body === 'object') {
    if (typeof body.autoSpeak === 'boolean') patch.autoSpeak = body.autoSpeak
    if (typeof body.enabled === 'boolean') patch.enabled = body.enabled
    if (body.summaryMaxChars !== undefined && body.summaryMaxChars !== null) {
      const value = typeof body.summaryMaxChars === 'number' ? body.summaryMaxChars : Number(body.summaryMaxChars)
      if (!Number.isFinite(value) || value < MIN_SUMMARY_MAX_CHARS || value > MAX_SUMMARY_MAX_CHARS) {
        sendError(res, 400, {
          code: 'bad-request',
          message: `Максимум символов озвучки должен быть числом от ${MIN_SUMMARY_MAX_CHARS} до ${MAX_SUMMARY_MAX_CHARS}`,
        })
        return
      }
      patch.summaryMaxChars = Math.round(value)
    }
    if (body.voice !== undefined && body.voice !== null && body.voice !== '') {
      const voice = String(body.voice)
      if (!VOICES.some((entry) => entry.id === voice)) {
        sendError(res, 400, { code: 'bad-request', message: `Неизвестный голос озвучки: ${voice.slice(0, 60)}` })
        return
      }
      patch.voice = voice
    }
    // The intonation is validated against the voice that will be in effect
    // *after* this write: the settings page sends the new voice and intonation
    // in one save, so the check must not use the previously accepted voice.
    if (body.emotion !== undefined && body.emotion !== null) {
      if (typeof body.emotion !== 'string') {
        sendError(res, 400, { code: 'bad-request', message: 'Интонация озвучки должна быть строкой' })
        return
      }
      const emotion = body.emotion.trim()
      const voiceEntry = VOICES.find((entry) => entry.id === (patch.voice ?? current.voice)) ?? VOICES[0]
      const allowed = Array.isArray(voiceEntry.emotions) ? voiceEntry.emotions : []
      if (emotion !== '' && !allowed.includes(emotion)) {
        sendError(res, 400, {
          code: 'bad-request',
          message: `Интонация «${emotion.slice(0, 40)}» недоступна для голоса ${voiceEntry.id}`,
          hint:
            allowed.length > 0
              ? `Доступные интонации: ${allowed.join(', ')}. Передайте пустую строку, чтобы вернуть интонацию по умолчанию.`
              : 'У этого голоса нет вариантов интонации. Передайте пустую строку, чтобы не задавать её.',
        })
        return
      }
      patch.emotion = emotion
    }
    if (body.speed !== undefined && body.speed !== null && body.speed !== '') {
      const speed = typeof body.speed === 'number' ? body.speed : Number(body.speed)
      if (!Number.isFinite(speed) || speed < 0.1 || speed > 3) {
        sendError(res, 400, { code: 'bad-request', message: 'Скорость речи должна быть числом от 0.1 до 3.0' })
        return
      }
      patch.speed = Math.round(speed * 100) / 100
    }
  }
  if (Object.keys(patch).length === 0) {
    sendError(res, 400, {
      code: 'bad-request',
      message: 'Нужно передать autoSpeak, enabled, summaryMaxChars, voice, emotion или speed',
    })
    return
  }
  try {
    const stored = writePreferences(patch)
    const resolved = resolveSettings(config)
    appendEvent('preferences.ok', stored)
    sendJson(res, 200, {
      ok: true,
      autoSpeak: resolved.autoSpeak,
      enabled: resolved.enabled,
      summaryMaxChars: resolved.summaryMaxChars,
      voice: resolved.voice,
      lang: resolved.lang,
      emotion: resolved.emotion,
      speed: resolved.speed,
      format: resolved.format,
    })
  } catch (error) {
    sendEngineError(res, error, 'preferences')
  }
}

/**
 * Handle POST /dsh-voice-reply/preview: synthesize a short sample of the
 * drafts currently chosen on the plugin settings page, without saving them.
 * #body `{ voice?: string, emotion?: string, speed?: number }`
 * @param {import('node:http').IncomingMessage} req - request.
 * @param {import('node:http').ServerResponse} res - response.
 * @param {unknown} config - plugin Config.
 * @returns {Promise<void>} completion after the response is sent.
 */
async function handlePreview(req, res, config) {
  const startedAt = Date.now()
  let settings
  try {
    settings = resolveSettings(config)
  } catch (error) {
    sendError(res, 500, { code: 'not-configured', message: error instanceof Error ? error.message : String(error) })
    return
  }
  if (!settings.configured) {
    sendError(res, 503, {
      code: 'not-configured',
      message: 'Yandex SpeechKit TTS не настроен',
      hint: 'Добавьте API-ключ со скоупом yc.ai.speechkitTts.execute в plugin-config.json плагина voice-reply',
    })
    return
  }

  let body
  try {
    body = JSON.parse((await readBody(req, 64 * 1024)).toString('utf8'))
  } catch (error) {
    if (error instanceof TtsError) {
      sendError(res, 413, { code: error.code, message: error.message })
      return
    }
    sendError(res, 400, { code: 'bad-request', message: 'Ожидался JSON { voice?: string, emotion?: string, speed?: number }' })
    return
  }

  const requestedVoice = body !== null && typeof body === 'object' && nonEmpty(body.voice) ? String(body.voice) : settings.voice
  const voiceEntry = VOICES.find((entry) => entry.id === requestedVoice)
  if (voiceEntry === undefined) {
    sendError(res, 400, { code: 'bad-request', message: 'Неизвестный голос озвучки' })
    return
  }
  // Same rule as the persisted preference: an unsupported intonation is a
  // client-side mismatch, not a reason to synthesize.
  let emotion = ''
  if (body !== null && typeof body === 'object' && body.emotion !== undefined && body.emotion !== null && body.emotion !== '') {
    if (typeof body.emotion !== 'string') {
      sendError(res, 400, { code: 'bad-request', message: 'Интонация озвучки должна быть строкой' })
      return
    }
    const candidate = body.emotion.trim()
    const allowed = Array.isArray(voiceEntry.emotions) ? voiceEntry.emotions : []
    if (candidate !== '' && !allowed.includes(candidate)) {
      sendError(res, 400, {
        code: 'bad-request',
        message: `Интонация «${candidate.slice(0, 40)}» недоступна для голоса ${voiceEntry.id}`,
        hint:
          allowed.length > 0
            ? `Доступные интонации: ${allowed.join(', ')}.`
            : 'У этого голоса нет вариантов интонации.',
      })
      return
    }
    emotion = candidate
  }
  let speed = settings.speed
  if (body !== null && typeof body === 'object' && body.speed !== undefined && body.speed !== null && body.speed !== '') {
    const value = typeof body.speed === 'number' ? body.speed : Number(body.speed)
    if (!Number.isFinite(value) || value < 0.1 || value > 3) {
      sendError(res, 400, { code: 'bad-request', message: 'Скорость речи должна быть числом от 0.1 до 3.0' })
      return
    }
    speed = Math.round(value * 100) / 100
  }

  const previewSettings = {
    ...settings,
    voice: voiceEntry.id,
    lang: voiceEntry.lang,
    emotion,
    speed,
  }
  try {
    const result = await enqueueSpeech(() => synthesizeAnswer({ text: previewTextFor(voiceEntry.lang) }, previewSettings))
    appendEvent('preview.ok', {
      chars: result.chars,
      chunks: result.chunks.length,
      cached: result.cached,
      voice: voiceEntry.id,
      emotion,
      speed,
      ms: Date.now() - startedAt,
    })
    sendJson(res, 200, {
      ok: true,
      key: result.key,
      voice: voiceEntry.id,
      lang: voiceEntry.lang,
      emotion,
      speed,
      format: settings.format,
      mime: mimeForFormat(settings.format),
      chars: result.chars,
      cached: result.cached,
      chunks: result.chunks,
    })
  } catch (error) {
    sendEngineError(res, error, 'preview')
  }
}

/**
 * Handle POST /dsh-voice-reply/speak.
 * @param {import('node:http').IncomingMessage} req - request.
 * @param {import('node:http').ServerResponse} res - response.
 * @param {unknown} config - plugin Config.
 * @returns {Promise<void>} completion after the response is sent.
 */
async function handleSpeak(req, res, config) {
  const startedAt = Date.now()
  let settings
  try {
    settings = resolveSettings(config)
  } catch (error) {
    sendError(res, 500, { code: 'not-configured', message: error instanceof Error ? error.message : String(error) })
    return
  }
  if (!settings.configured) {
    sendError(res, 503, {
      code: 'not-configured',
      message: 'Yandex SpeechKit TTS не настроен',
      hint: 'Добавьте API-ключ со скоупом yc.ai.speechkitTts.execute в plugin-config.json плагина voice-reply (файл перечитывается на каждый запрос)',
    })
    return
  }

  let body
  try {
    body = JSON.parse((await readBody(req, MAX_BODY_BYTES)).toString('utf8'))
  } catch (error) {
    if (error instanceof TtsError) {
      sendError(res, 413, { code: error.code, message: error.message, ...(error.hint ? { hint: error.hint } : {}) })
      return
    }
    sendError(res, 400, { code: 'bad-request', message: 'Ожидался JSON { text: string }' })
    return
  }
  const text = typeof body?.text === 'string' ? body.text : ''
  if (!nonEmpty(text)) {
    sendError(res, 400, { code: 'bad-request', message: 'Пустой текст: озвучивать нечего' })
    return
  }

  try {
    const result = await enqueueSpeech(() => synthesizeAnswer({ text, messageId: body?.messageId }, settings))
    appendEvent('speak.ok', {
      chars: result.chars,
      sourceChars: result.sourceChars,
      summarized: result.summarized,
      truncated: result.truncated,
      chunks: result.chunks.length,
      cached: result.cached,
      voice: settings.voice,
      format: settings.format,
      ms: Date.now() - startedAt,
    })
    sendJson(res, 200, {
      ok: true,
      key: result.key,
      voice: settings.voice,
      format: settings.format,
      mime: mimeForFormat(settings.format),
      lang: settings.lang,
      chars: result.chars,
      sourceChars: result.sourceChars,
      summarized: result.summarized,
      truncated: result.truncated,
      cached: result.cached,
      chunks: result.chunks,
    })
  } catch (error) {
    sendEngineError(res, error, 'speak')
  }
}

/**
 * Handle GET/HEAD /dsh-voice-reply/audio/<file>.
 * @param {import('node:http').IncomingMessage} req - request.
 * @param {import('node:http').ServerResponse} res - response.
 * @param {string} fileName - path segment after /audio/.
 * @returns {Promise<void>} completion after the response is sent.
 */
async function handleAudio(req, res, fileName) {
  if (!/^[a-f0-9]{16,64}-\d+\.(mp3|ogg|wav)$/.test(fileName)) {
    sendError(res, 404, { code: 'bad-request', message: 'Аудио не найдено' })
    return
  }
  const dash = fileName.lastIndexOf('-')
  const key = fileName.slice(0, dash)
  const rest = fileName.slice(dash + 1)
  const ext = rest.slice(rest.lastIndexOf('.') + 1)
  const file = path.join(CACHE_DIR, key, rest)
  let audio
  try {
    audio = await fs.promises.readFile(file)
  } catch {
    sendError(res, 404, { code: 'bad-request', message: 'Аудио не найдено или уже удалено из кэша' })
    return
  }
  const mime = ext === 'mp3' ? 'audio/mpeg' : ext === 'ogg' ? 'audio/ogg' : 'audio/wav'
  res.writeHead(200, {
    'content-type': mime,
    'content-length': audio.length,
    'cache-control': 'private, max-age=86400, immutable',
    'accept-ranges': 'none',
  })
  if (req.method === 'HEAD') {
    res.end()
    return
  }
  res.end(audio)
}

/**
 * Route one request under the plugin prefix.
 * @param {import('node:http').IncomingMessage} req - request.
 * @param {import('node:http').ServerResponse} res - response.
 * @param {unknown} config - plugin Config.
 * @returns {Promise<void>} completion after the response is sent.
 */
async function handleRequest(req, res, config) {
  const url = new URL(req.url ?? '/', 'http://voice-reply.local')
  const pathname = url.pathname

  if (pathname === `${ROUTE_PREFIX}/status`) {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, { allow: 'GET, HEAD' }).end()
      return
    }
    handleStatus(res, config)
    return
  }
  if (pathname === `${ROUTE_PREFIX}/speak`) {
    if (req.method !== 'POST') {
      res.writeHead(405, { allow: 'POST' }).end()
      return
    }
    await handleSpeak(req, res, config)
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
  if (pathname === `${ROUTE_PREFIX}/preferences`) {
    if (req.method !== 'POST') {
      res.writeHead(405, { allow: 'POST' }).end()
      return
    }
    await handlePreferences(req, res, config)
    return
  }
  if (pathname.startsWith(`${ROUTE_PREFIX}/audio/`)) {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, { allow: 'GET, HEAD' }).end()
      return
    }
    await handleAudio(req, res, decodeURIComponent(pathname.slice(`${ROUTE_PREFIX}/audio/`.length)))
    return
  }
  sendError(res, 404, { code: 'bad-request', message: 'Неизвестный маршрут voice-reply' })
}

/* ------------------------------------------------------------------ */
/* Plugin entry                                                       */
/* ------------------------------------------------------------------ */

/**
 * Register the HTTP routes and prepare the audio cache.
 * @param {import('@deepseek-ai/cordis').Context} ctx - Host context with `webServer`.
 * @param {Record<string, unknown>} [config] - raw row config from `cordis.patch.yml`.
 * @returns {void}
 */
export function apply(ctx, config) {
  appendEvent('activate', { cacheDir: CACHE_DIR })
  pruneCache()

  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'prefix',
        path: ROUTE_PREFIX,
        handler: (req, res) => {
          handleRequest(req, res, config).catch((error) => {
            try {
              sendEngineError(res, error, 'route')
            } catch {
              /* response may already be sent */
            }
          })
        },
      }),
    'voice-reply: HTTP routes',
  )

  ctx.effect(
    () => () => {
      memoryCache.clear()
      appendEvent('dispose')
    },
    'voice-reply: cache cleanup',
  )
}
