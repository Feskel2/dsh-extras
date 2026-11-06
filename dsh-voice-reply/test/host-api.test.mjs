/**
 * Host-half integration tests for dsh-voice-reply.
 *
 * Boots the real Cordis plugin (`index.js`) against a fake `webServer` service
 * and a local mock of the Yandex SpeechKit TTS endpoint, then exercises the
 * public HTTP API end to end: status, speak, chunking limits, auth/error
 * mapping, retries, caching and audio serving.
 *
 * Run: node --test test/host-api.test.mjs
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { after, before, beforeEach, test } from 'node:test'
import { register } from 'node:module'

register('./resolver.mjs', import.meta.url)
const { apply } = await import('../index.js')

/** Mutable mock behavior for the next Yandex request(s). */
const mock = {
  /** @type {'ok'|'401'|'400'|'429-then-ok'|'500'} */
  mode: 'ok',
  requests: [],
  calls: 0,
}

/** Fake SpeechKit endpoint. */
const yandex = http.createServer((req, res) => {
  const chunks = []
  req.on('data', (chunk) => chunks.push(chunk))
  req.on('end', () => {
    mock.calls += 1
    const body = Buffer.concat(chunks)
    mock.requests.push({ headers: req.headers, body: body.toString('utf8'), bytes: body.length })
    if (mock.mode === '401') {
      res.writeHead(401, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error_code: 'UNAUTHORIZED', error_message: 'Permission denied' }))
      return
    }
    if (mock.mode === '400') {
      res.writeHead(400, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error_code: 'INVALID_ARGUMENT', error_message: 'bad voice' }))
      return
    }
    if (mock.mode === '429-then-ok' && mock.calls === 1) {
      res.writeHead(429, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error_code: 'RESOURCE_EXHAUSTED', error_message: 'quota' }))
      return
    }
    if (mock.mode === '500') {
      res.writeHead(500, { 'content-type': 'text/plain' })
      res.end('boom')
      return
    }
    res.writeHead(200, { 'content-type': 'audio/mpeg' })
    res.end(Buffer.from(`FAKE-MP3:${body.toString('utf8').length}`))
  })
})

/** Fake web server service captured from `apply`. */
const routes = new Map()

/** Cordis-ish context used by the host plugin. */
const ctx = {
  effect(fn) {
    const disposer = fn()
    return disposer
  },
  webServer: {
    register(route) {
      routes.set(route.path, route)
      return () => routes.delete(route.path)
    },
  },
  logger: { warn() {} },
}

/** Local HTTP carrier that dispatches to the plugin's prefix route. */
const app = http.createServer((req, res) => {
  const route = routes.get('/dsh-voice-reply')
  if (route === undefined) {
    res.writeHead(503).end('no route')
    return
  }
  Promise.resolve(route.handler(req, res)).catch((error) => {
    res.writeHead(500).end(String(error))
  })
})

/** Base URL of the local carrier. */
let base = ''
/** Temp dir for audio cache assertions. */
const cacheDir = path.join(os.tmpdir(), 'dsh-voice-reply-cache')
/** Saved environment so the test can restore it. */
const savedEnv = {}
/** Original credential file content, restored after the suite. */
const configFile = path.join(import.meta.dirname, '..', 'plugin-config.json')
let savedConfigRaw = ''

before(async () => {
  savedConfigRaw = fs.readFileSync(configFile, 'utf8')
  // The credential file is user-owned and may keep any voice/speed/budget from
  // a previous run of the live plugin; normalize the UI-owned preferences so
  // these assertions have a defined starting point.
  const baseline = JSON.parse(savedConfigRaw)
  baseline.voice = 'marina'
  baseline.speed = 1.32
  baseline.summaryMaxChars = 500
  baseline.emotion = ''
  fs.writeFileSync(configFile, `${JSON.stringify(baseline, null, 2)}\n`, 'utf8')
  fs.rmSync(cacheDir, { recursive: true, force: true })
  await new Promise((resolve) => yandex.listen(0, '127.0.0.1', resolve))
  const yandexPort = yandex.address().port
  await new Promise((resolve) => app.listen(0, '127.0.0.1', resolve))
  base = `http://127.0.0.1:${app.address().port}`
  savedEnv.YANDEX_TTS_API_KEY = process.env.YANDEX_TTS_API_KEY
  savedEnv.YANDEX_TTS_ENDPOINT = process.env.YANDEX_TTS_ENDPOINT
  savedEnv.YANDEX_TTS_IAM_TOKEN = process.env.YANDEX_TTS_IAM_TOKEN
  process.env.YANDEX_TTS_API_KEY = 'test-api-key'
  process.env.YANDEX_TTS_ENDPOINT = `http://127.0.0.1:${yandexPort}/speech/v1/tts:synthesize`
  delete process.env.YANDEX_TTS_IAM_TOKEN
  apply(ctx, {
    enabled: true,
    autoSpeak: true,
    voice: 'alena',
    emotion: '',
    speed: 1,
    format: 'mp3',
    maxChars: 4000,
    summaryMaxChars: 500,
    debug: false,
  })
})

after(async () => {
  fs.writeFileSync(configFile, savedConfigRaw, 'utf8')
  process.env.YANDEX_TTS_API_KEY = savedEnv.YANDEX_TTS_API_KEY ?? ''
  if (savedEnv.YANDEX_TTS_ENDPOINT === undefined) delete process.env.YANDEX_TTS_ENDPOINT
  else process.env.YANDEX_TTS_ENDPOINT = savedEnv.YANDEX_TTS_ENDPOINT
  await new Promise((resolve) => app.close(resolve))
  await new Promise((resolve) => yandex.close(resolve))
})

beforeEach(() => {
  mock.mode = 'ok'
  mock.requests = []
  mock.calls = 0
})

/**
 * Call the plugin API over HTTP.
 * @param {string} route - path below the prefix.
 * @param {{ method?: string, body?: unknown }} [options] - request options.
 * @returns {Promise<{ status: number, headers: http.IncomingHttpHeaders, json: any, bytes: Buffer }>} response.
 */
async function call(route, options = {}) {
  const method = options.method ?? 'GET'
  const response = await fetch(`${base}/dsh-voice-reply${route}`, {
    method,
    headers: options.body === undefined ? {} : { 'content-type': 'application/json' },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  })
  const bytes = Buffer.from(await response.arrayBuffer())
  let json
  try {
    json = JSON.parse(bytes.toString('utf8'))
  } catch {
    json = undefined
  }
  return { status: response.status, headers: response.headers, json, bytes }
}

test('status reports configuration, voices, format and summary limits', async () => {
  const { status, json } = await call('/status')
  assert.equal(status, 200)
  assert.equal(json.ok, true)
  assert.equal(json.configured, true)
  assert.equal(json.voice, 'marina')
  assert.equal(json.emotion, '', 'no intonation is stored by default')
  assert.equal(json.speed, 1.32)
  assert.equal(json.format, 'mp3')
  assert.equal(json.mime, 'audio/mpeg')
  assert.equal(json.summaryMaxChars, 500)
  assert.deepEqual(json.summaryLimits, { min: 100, max: 2000, step: 50 })
  assert.ok(Array.isArray(json.voices) && json.voices.length >= 8)
  assert.ok(json.voices.some((voice) => voice.id === 'alena' && voice.lang === 'ru-RU'))
  const jane = json.voices.find((voice) => voice.id === 'jane')
  assert.ok(jane && Array.isArray(jane.emotions) && jane.emotions.includes('good'), 'voices advertise their intonations')
  const filipp = json.voices.find((voice) => voice.id === 'filipp')
  assert.equal(filipp.emotions, undefined, 'a voice without intonations has no emotions list')
  assert.deepEqual(json.emotionOptions, ['neutral', 'whisper', 'friendly'], 'the selected voice exposes its intonations')
})

test('speak synthesizes once, serves audio, and replays from cache', async () => {
  const text = 'Привет! Это тестовый ответ голосом. Уникальный текст для кэша номер один.'
  const first = await call('/speak', { method: 'POST', body: { text, messageId: 'm1' } })
  assert.equal(first.status, 200)
  assert.equal(first.json.ok, true)
  assert.equal(first.json.chunks.length, 1)
  assert.equal(first.json.cached, false)
  assert.equal(first.json.summarized, false, 'a short answer is spoken in full')
  assert.equal(first.json.chars, text.length)
  assert.equal(mock.calls, 1)
  assert.match(mock.requests[0].body, /(?:^|&)text=/u)
  assert.match(String(mock.requests[0].headers.authorization), /^Api-Key test-api-key$/u)
  assert.match(String(mock.requests[0].headers['content-type']), /application\/x-www-form-urlencoded/u)
  assert.ok(!mock.requests[0].body.includes('folderId'))
  assert.ok(mock.requests[0].bytes <= 15000)

  const audioUrl = first.json.chunks[0].url
  assert.match(audioUrl, /^\/dsh-voice-reply\/audio\/[a-f0-9]+-0\.mp3$/u)
  const audio = await fetch(`${base}${audioUrl}`)
  assert.equal(audio.status, 200)
  assert.equal(audio.headers.get('content-type'), 'audio/mpeg')
  const audioBytes = Buffer.from(await audio.arrayBuffer())
  assert.ok(audioBytes.length > 0)
  assert.ok(fs.existsSync(cacheDir))

  const second = await call('/speak', { method: 'POST', body: { text, messageId: 'm1' } })
  assert.equal(second.status, 200)
  assert.equal(second.json.cached, true)
  assert.equal(mock.calls, 1, 'replay must not call Yandex again')
  assert.deepEqual(second.json.chunks.map((chunk) => chunk.url), first.json.chunks.map((chunk) => chunk.url))
})

test('a long Cyrillic answer is summarized before synthesis and stays under the 15 KB body limit', async () => {
  const sentence = 'Это длинный ответ ассистента, который мы не должны читать целиком: слушателю нужна только суть. '
  const text = `${sentence.repeat(70)}Итог: краткая озвучка заметно короче полного текста.`
  const response = await call('/speak', { method: 'POST', body: { text } })
  assert.equal(response.status, 200)
  assert.equal(response.json.summarized, true, 'a long answer must become a summary')
  assert.equal(response.json.truncated, true)
  assert.ok(response.json.chars <= 500, `summary chars ${response.json.chars} exceed 500`)
  assert.ok(response.json.sourceChars > 1500, 'source length must be reported')
  assert.ok(response.json.chunks.length >= 1)
  assert.equal(mock.calls, response.json.chunks.length)
  for (const request of mock.requests) {
    assert.ok(request.bytes <= 15000, `encoded body ${request.bytes} exceeds 15000`)
    const params = new URLSearchParams(request.body)
    assert.ok((params.get('text') ?? '').length > 0)
  }
})

test('markdown and code are cleaned before synthesis', async () => {
  const text = '# Заголовок\n\nТекст **жирный** и `код`.\n\n```js\nconsole.log("секрет")\n```\n\n[ссылка](https://example.com)'
  const response = await call('/speak', { method: 'POST', body: { text } })
  assert.equal(response.status, 200)
  const params = new URLSearchParams(mock.requests[0].body)
  const spoken = params.get('text') ?? ''
  assert.ok(!spoken.includes('```'), 'code fence must be removed')
  assert.ok(!spoken.includes('console.log'), 'code body must not be spoken')
  assert.ok(!spoken.includes('**'), 'markdown emphasis must be removed')
  assert.ok(spoken.includes('Заголовок'))
})

test('preview synthesizes a short sample with the draft voice, intonation and speed', async () => {
  const response = await call('/preview', { method: 'POST', body: { voice: 'john', speed: 1.5 } })
  assert.equal(response.status, 200)
  assert.equal(response.json.ok, true)
  assert.equal(response.json.voice, 'john')
  assert.equal(response.json.lang, 'en-US')
  assert.equal(response.json.emotion, '')
  assert.equal(response.json.speed, 1.5)
  assert.ok(response.json.chunks.length >= 1)
  assert.equal(mock.calls, 1)
  const params = new URLSearchParams(mock.requests[0].body)
  assert.equal(params.get('voice'), 'john')
  assert.equal(params.get('speed'), '1.5')
  assert.equal(params.get('lang'), 'en-US')
  assert.equal(params.get('emotion'), null, 'an empty intonation is not sent')
  const spoken = params.get('text') ?? ''
  assert.match(spoken, /Hello/iu, 'the sample is in the voice language')
  assert.ok(spoken.length < 200, `preview sample is ${spoken.length} chars`)
  assert.ok(!mock.requests[0].body.includes('folderId'))
  assert.ok(mock.requests[0].bytes <= 15000)

  const badVoice = await call('/preview', { method: 'POST', body: { voice: 'dasha' } })
  assert.equal(badVoice.status, 400)
  assert.equal(badVoice.json.error.code, 'bad-request')
  const badSpeed = await call('/preview', { method: 'POST', body: { voice: 'alena', speed: 0 } })
  assert.equal(badSpeed.status, 400)
  const wrongMethod = await call('/preview')
  assert.equal(wrongMethod.status, 405)
})

test('preview applies a supported intonation and rejects an unsupported one', async () => {
  const good = await call('/preview', { method: 'POST', body: { voice: 'jane', emotion: 'good', speed: 1.42 } })
  assert.equal(good.status, 200)
  assert.equal(good.json.voice, 'jane')
  assert.equal(good.json.emotion, 'good')
  const params = new URLSearchParams(mock.requests[0].body)
  assert.equal(params.get('emotion'), 'good')
  assert.equal(params.get('voice'), 'jane')

  const whisper = await call('/preview', { method: 'POST', body: { voice: 'marina', emotion: 'whisper' } })
  assert.equal(whisper.status, 200)
  assert.equal(whisper.json.emotion, 'whisper')
  const whisperParams = new URLSearchParams(mock.requests.at(-1).body)
  assert.equal(whisperParams.get('emotion'), 'whisper')

  const wrongEmotion = await call('/preview', { method: 'POST', body: { voice: 'jane', emotion: 'whisper' } })
  assert.equal(wrongEmotion.status, 400, 'jane does not support whisper')
  assert.match(wrongEmotion.json.error.hint ?? '', /neutral, good, evil/u)
  const noEmotionVoice = await call('/preview', { method: 'POST', body: { voice: 'filipp', emotion: 'good' } })
  assert.equal(noEmotionVoice.status, 400, 'filipp has no intonations at all')
  assert.match(noEmotionVoice.json.error.hint ?? '', /нет вариантов интонации/iu)
  const wrongType = await call('/preview', { method: 'POST', body: { voice: 'jane', emotion: 7 } })
  assert.equal(wrongType.status, 400)
})

test('401 from Yandex is mapped to an actionable unauthorized error', async () => {
  mock.mode = '401'
  const { status, json } = await call('/speak', { method: 'POST', body: { text: 'Уникальный текст для ошибки 401.' } })
  assert.equal(status, 401)
  assert.equal(json.ok, false)
  assert.equal(json.error.code, 'unauthorized')
  assert.match(json.error.hint ?? '', /yc\.ai\.speechkitTts\.execute/u)
  assert.equal(mock.calls, 1, '401 must not be retried')
})

test('400 from Yandex is mapped to bad-request without retry', async () => {
  mock.mode = '400'
  const { status, json } = await call('/speak', { method: 'POST', body: { text: 'Уникальный текст для ошибки 400.' } })
  assert.equal(status, 400)
  assert.equal(json.error.code, 'bad-request')
  assert.equal(mock.calls, 1)
})

test('429 is retried and a later success wins', async () => {
  mock.mode = '429-then-ok'
  const { status, json } = await call('/speak', { method: 'POST', body: { text: 'Уникальный текст для повтора после 429.' } })
  assert.equal(status, 200)
  assert.equal(json.ok, true)
  assert.equal(mock.calls, 2)
})

test('5xx retries are exhausted and reported as upstream', async () => {
  mock.mode = '500'
  const { status, json } = await call('/speak', { method: 'POST', body: { text: 'Уникальный текст для пятисоток.' } })
  assert.ok(status >= 500)
  assert.equal(json.error.code, 'upstream')
  assert.equal(mock.calls, 3)
})

test('preferences persist autoSpeak and summaryMaxChars and are reflected by status', async () => {
  const off = await call('/preferences', { method: 'POST', body: { autoSpeak: false } })
  assert.equal(off.status, 200)
  assert.equal(off.json.ok, true)
  assert.equal(off.json.autoSpeak, false)
  const statusOff = await call('/status')
  assert.equal(statusOff.json.autoSpeak, false)

  const on = await call('/preferences', { method: 'POST', body: { autoSpeak: true } })
  assert.equal(on.status, 200)
  assert.equal(on.json.autoSpeak, true)

  const limited = await call('/preferences', { method: 'POST', body: { summaryMaxChars: 300 } })
  assert.equal(limited.status, 200)
  assert.equal(limited.json.summaryMaxChars, 300)
  const statusLimited = await call('/status')
  assert.equal(statusLimited.json.summaryMaxChars, 300)

  const persisted = JSON.parse(fs.readFileSync(configFile, 'utf8'))
  assert.equal(persisted.autoSpeak, true)
  assert.equal(persisted.summaryMaxChars, 300)
  assert.equal(typeof persisted.apiKey, 'string', 'credentials must survive a preferences write')

  const voice = await call('/preferences', { method: 'POST', body: { voice: 'alena', speed: 1.5 } })
  assert.equal(voice.status, 200)
  assert.equal(voice.json.voice, 'alena')
  assert.equal(voice.json.lang, 'ru-RU')
  assert.equal(voice.json.speed, 1.5)
  const statusVoice = await call('/status')
  assert.equal(statusVoice.json.voice, 'alena')
  assert.equal(statusVoice.json.speed, 1.5)
  const persistedVoice = JSON.parse(fs.readFileSync(configFile, 'utf8'))
  assert.equal(persistedVoice.voice, 'alena')
  assert.equal(persistedVoice.speed, 1.5)

  const emotion = await call('/preferences', { method: 'POST', body: { voice: 'jane', emotion: 'good' } })
  assert.equal(emotion.status, 200)
  assert.equal(emotion.json.voice, 'jane')
  assert.equal(emotion.json.emotion, 'good')
  const statusEmotion = await call('/status')
  assert.equal(statusEmotion.json.emotion, 'good')
  assert.deepEqual(statusEmotion.json.emotionOptions, ['neutral', 'good', 'evil'])
  const persistedEmotion = JSON.parse(fs.readFileSync(configFile, 'utf8'))
  assert.equal(persistedEmotion.voice, 'jane')
  assert.equal(persistedEmotion.emotion, 'good')
  assert.equal(typeof persistedEmotion.apiKey, 'string', 'credentials must survive an intonation write')

  const invalid = await call('/preferences', { method: 'POST', body: { autoSpeak: 'yes' } })
  assert.equal(invalid.status, 400)
  const tooSmall = await call('/preferences', { method: 'POST', body: { summaryMaxChars: 99 } })
  assert.equal(tooSmall.status, 400)
  const tooBig = await call('/preferences', { method: 'POST', body: { summaryMaxChars: 2001 } })
  assert.equal(tooBig.status, 400)
  const notNumber = await call('/preferences', { method: 'POST', body: { summaryMaxChars: 'abc' } })
  assert.equal(notNumber.status, 400)
  const badVoice = await call('/preferences', { method: 'POST', body: { voice: 'dasha' } })
  assert.equal(badVoice.status, 400, 'v3-only voices are rejected')
  const badSpeed = await call('/preferences', { method: 'POST', body: { speed: 5 } })
  assert.equal(badSpeed.status, 400)
  const badEmotion = await call('/preferences', { method: 'POST', body: { emotion: 'whisper' } })
  assert.equal(badEmotion.status, 400, 'jane does not support whisper')
  assert.match(badEmotion.json.error.hint ?? '', /neutral, good, evil/u)
  const unknownEmotion = await call('/preferences', { method: 'POST', body: { emotion: 'angry' } })
  assert.equal(unknownEmotion.status, 400)
  const wrongEmotionType = await call('/preferences', { method: 'POST', body: { emotion: 3 } })
  assert.equal(wrongEmotionType.status, 400)
  const wrongMethod = await call('/preferences')
  assert.equal(wrongMethod.status, 405)

  const restored = await call('/preferences', { method: 'POST', body: { summaryMaxChars: 500, voice: 'marina', emotion: '', speed: 1.32 } })
  assert.equal(restored.status, 200)
  assert.equal(restored.json.summaryMaxChars, 500)
  assert.equal(restored.json.voice, 'marina')
  assert.equal(restored.json.emotion, '')
  assert.equal(restored.json.speed, 1.32)
})

test('switching to a voice without intonations clears the effective emotion', async () => {
  const withEmotion = await call('/preferences', { method: 'POST', body: { voice: 'marina', emotion: 'friendly' } })
  assert.equal(withEmotion.status, 200)
  assert.equal(withEmotion.json.emotion, 'friendly')

  const switched = await call('/preferences', { method: 'POST', body: { voice: 'filipp' } })
  assert.equal(switched.status, 200)
  assert.equal(switched.json.voice, 'filipp')
  assert.equal(switched.json.emotion, '', 'the stale intonation is not sent for a voice without emotions')
  const statusSwitched = await call('/status')
  assert.equal(statusSwitched.json.emotion, '')
  assert.deepEqual(statusSwitched.json.emotionOptions, [])

  // Switching back restores the stored intonation: it was never destroyed.
  const back = await call('/preferences', { method: 'POST', body: { voice: 'marina' } })
  assert.equal(back.status, 200)
  assert.equal(back.json.emotion, 'friendly')

  await call('/preferences', { method: 'POST', body: { emotion: '' } })
  const cleared = await call('/status')
  assert.equal(cleared.json.emotion, '')
  const persisted = JSON.parse(fs.readFileSync(configFile, 'utf8'))
  assert.equal(persisted.emotion, '')
})

test('a custom summary budget shortens the spoken text further', async () => {
  const sentence = 'Подробный абзац ответа, который при озвучке сокращается до самого главного. '
  const text = `${sentence.repeat(60)}Итог: проверка завершена.`
  const limited = await call('/preferences', { method: 'POST', body: { summaryMaxChars: 150 } })
  assert.equal(limited.status, 200)
  const response = await call('/speak', { method: 'POST', body: { text } })
  assert.equal(response.status, 200)
  assert.equal(response.json.summarized, true)
  assert.ok(response.json.chars <= 150, `summary chars ${response.json.chars} exceed 150`)
  assert.ok(response.json.chars >= 50, `summary chars ${response.json.chars} are too short`)
  await call('/preferences', { method: 'POST', body: { summaryMaxChars: 500 } })
})

test('empty text and unknown routes are rejected', async () => {
  const empty = await call('/speak', { method: 'POST', body: { text: '   ' } })
  assert.equal(empty.status, 400)
  assert.equal(empty.json.error.code, 'bad-request')

  const missing = await call('/nope')
  assert.equal(missing.status, 404)

  const wrongMethod = await call('/speak', { method: 'GET' })
  assert.equal(wrongMethod.status, 405)

  const missingAudio = await call('/audio/00000000000000000000000000000000-0.mp3')
  assert.equal(missingAudio.status, 404)
})
