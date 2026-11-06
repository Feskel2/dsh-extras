/**
 * Real HTTP test for the topmost-notify host API (`/dsh-topmost-notify`).
 *
 * Unlike `index-smoke.mjs` (which drives Session events with a fake context),
 * this test starts a real `node:http` server, hands it the handler captured from
 * the plugin's `ctx.webServer.register({kind:'prefix', ...})` call, and speaks
 * HTTP to it exactly like the settings page does.
 *
 * The plugin is staged into a throwaway temp package (its bare import of
 * `@deepseek-ai/schemastery` resolves only beside the installed DSH tree), so the
 * uploads, the `sounds/` folder and `host/notify-debug.log` never touch the repo.
 * `DSH_TOPMOST_NOTIFY_DRY_RUN=1` makes preview routes log a `dry-run <json>` line
 * instead of spawning a PowerShell window.
 *
 * Run: node test/host-api.test.mjs
 */
import assert from 'node:assert/strict'
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from 'node:fs'
import http from 'node:http'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const PREFIX = '/dsh-topmost-notify'

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
  const dir = mkdtempSync(join(tmpdir(), 'topmost-notify-http-'))
  for (const file of ['package.json', 'index.mjs']) cpSync(join(ROOT, file), join(dir, file))
  cpSync(join(ROOT, 'host'), join(dir, 'host'), { recursive: true })
  symlinkSync(dshNodeModules(), join(dir, 'node_modules'), 'junction')
  return dir
}

/**
 * Build a tiny PCM WAV in memory (16-bit mono 44.1 kHz, a 440 Hz tone).
 * @param {number} durationMs - tone length.
 * @returns {Buffer} complete RIFF/WAVE file bytes.
 */
function makeWav(durationMs = 200) {
  const rate = 44100
  const samples = Math.round((rate * durationMs) / 1000)
  const pcm = Buffer.alloc(samples * 2)
  for (let i = 0; i < samples; i++) {
    pcm.writeInt16LE(Math.round(4000 * Math.sin((2 * Math.PI * 440 * i) / rate)), i * 2)
  }
  const header = Buffer.alloc(44)
  header.write('RIFF', 0, 'ascii')
  header.writeUInt32LE(36 + pcm.length, 4)
  header.write('WAVE', 8, 'ascii')
  header.write('fmt ', 12, 'ascii')
  header.writeUInt32LE(16, 16)
  header.writeUInt16LE(1, 20)
  header.writeUInt16LE(1, 22)
  header.writeUInt32LE(rate, 24)
  header.writeUInt32LE(rate * 2, 28)
  header.writeUInt16LE(2, 32)
  header.writeUInt16LE(16, 34)
  header.write('data', 36, 'ascii')
  header.writeUInt32LE(pcm.length, 40)
  return Buffer.concat([header, pcm])
}

/** Smallest plausible MP3 prefix: one MPEG-1 Layer III frame sync header. */
const MP3_HEADER = Buffer.from([0xff, 0xfb, 0x90, 0x64])

const stage = stagePackage()
const logPath = join(stage, 'host', 'notify-debug.log')
const soundsDir = join(stage, 'sounds')
let registered = null
let server = null

/**
 * Execute one HTTP request against the API.
 * @param {string} method - HTTP method.
 * @param {string} path - path below the plugin prefix.
 * @param {{ body?: Buffer | string, headers?: Record<string, string> }} [options] - request options.
 * @returns {Promise<{ status: number, json: any, text: string }>} response data.
 */
async function request(method, path, options = {}) {
  const url = `http://127.0.0.1:${server.address().port}${PREFIX}${path}`
  const response = await fetch(url, {
    method,
    body: options.body,
    headers: options.headers,
  })
  const text = await response.text()
  let json = null
  try {
    json = JSON.parse(text)
  } catch {
    json = null
  }
  return { status: response.status, json, text }
}

/**
 * Read the JSON lines the plugin wrote for dry-run previews.
 * @returns {Array<Record<string, unknown>>} parsed dry-run payloads.
 */
function dryRuns() {
  if (!existsSync(logPath)) return []
  return readFileSync(logPath, 'utf8')
    .split('\n')
    .filter((line) => line.includes(' dry-run '))
    .map((line) => JSON.parse(line.slice(line.indexOf(' dry-run ') + ' dry-run '.length)))
}

try {
  process.env.DSH_TOPMOST_NOTIFY_DRY_RUN = '1'
  const plugin = await import(pathToFileURL(join(stage, 'index.mjs')).href)

  const config = {
    enabled: true,
    durationMs: 1000,
    questionDurationMs: 1500,
    sound: true,
    completedSoundEnabled: true,
    questionSoundEnabled: true,
    completedSoundFile: '',
    questionSoundFile: '',
  }
  const ctx = {
    logger: { info: () => {}, warn: () => {} },
    on: () => () => {},
    get: () => undefined,
    effect: (fn) => {
      const dispose = fn()
      return typeof dispose === 'function' ? dispose : () => {}
    },
    webServer: {
      register: (route) => {
        registered = route
        return () => {}
      },
    },
  }
  plugin.apply(ctx, config)
  assert.ok(registered !== null, 'the plugin registered an HTTP route')
  assert.equal(registered.kind, 'prefix', 'route is registered as a prefix')
  assert.equal(registered.path, PREFIX, 'route prefix matches the settings page')
  assert.equal(typeof registered.handler, 'function', 'route handler is callable')

  server = http.createServer((req, res) => {
    if (!String(req.url).startsWith(PREFIX)) {
      res.writeHead(404).end()
      return
    }
    registered.handler(req, res)
  })
  await new Promise((resolvePromise, rejectPromise) => {
    server.once('error', rejectPromise)
    server.listen(0, '127.0.0.1', resolvePromise)
  })
  console.log(`host-api: listening on ${server.address().port}`)

  // --- 1. GET /status -----------------------------------------------------
  let response = await request('GET', '/status')
  assert.equal(response.status, 200, 'status is 200')
  assert.equal(response.json.ok, true, 'status ok flag')
  assert.equal(response.json.plugin, 'topmost-notify', 'status plugin id')
  assert.equal(typeof response.json.version, 'string', 'status carries the package version')
  assert.deepEqual(response.json.limits.duration, { min: 300, max: 10000, step: 100 }, 'duration limits')
  assert.deepEqual(response.json.bundled, { completed: 'chime.wav', question: 'chime-question.wav' }, 'bundled sounds')
  assert.equal(response.json.soundDir, soundsDir, 'soundDir points at the staged package sounds/')
  assert.equal(response.json.custom.completed, null, 'no custom completion sound yet')
  assert.equal(response.json.custom.question, null, 'no custom question sound yet')

  // --- 2. POST /sounds: a real WAV is accepted and stored ------------------
  const wav = makeWav(200)
  response = await request('POST', '/sounds?kind=completed', {
    body: wav,
    headers: {
      'content-type': 'application/octet-stream',
      'x-file-name': encodeURIComponent('Мой сигнал.wav'),
    },
  })
  assert.equal(response.status, 200, 'valid WAV upload is 200')
  assert.equal(response.json.ok, true, 'upload ok flag')
  assert.equal(response.json.kind, 'completed', 'upload kind echoed')
  assert.equal(response.json.format, 'wav', 'upload format detected from the signature')
  assert.equal(response.json.bytes, wav.length, 'upload byte count')
  assert.ok(response.json.path.startsWith(soundsDir), 'upload stored inside sounds/')
  assert.ok(response.json.path.endsWith('.wav'), 'stored with the .wav extension')
  assert.ok(existsSync(response.json.path), 'uploaded file exists on disk')
  const firstPath = response.json.path
  assert.equal(response.json.name, firstPath.split(/[\\/]/).pop(), 'response name is the stored file name')

  // --- 3. a second upload of the same kind replaces the previous file -----
  response = await request('POST', '/sounds?kind=completed', {
    body: wav,
    headers: { 'content-type': 'application/octet-stream', 'x-file-name': 'second.wav' },
  })
  assert.equal(response.status, 200, 'second upload is 200')
  const secondPath = response.json.path
  assert.notEqual(secondPath, firstPath, 'the new upload gets a new file name')
  assert.equal(existsSync(firstPath), false, 'the previous file of the same kind is removed')
  assert.equal(existsSync(secondPath), true, 'the new file is stored')

  // --- 4. MP3 upload (signature check only; the fixture is exercised by notify.ps1 tests)
  response = await request('POST', '/sounds?kind=question', {
    body: MP3_HEADER,
    headers: {
      'content-type': 'audio/mpeg',
      'x-file-name': encodeURIComponent('question.mp3'),
    },
  })
  assert.equal(response.status, 200, 'MP3-signature upload is 200')
  assert.equal(response.json.format, 'mp3', 'MP3 detected from the frame sync byte')
  const mp3Path = response.json.path
  assert.ok(existsSync(mp3Path), 'MP3 file exists on disk')

  // --- 5. invalid format is rejected with 400 -----------------------------
  response = await request('POST', '/sounds?kind=completed', {
    body: Buffer.from('this is definitely not audio'),
    headers: { 'content-type': 'application/octet-stream', 'x-file-name': 'fake.wav' },
  })
  assert.equal(response.status, 400, 'garbage WAV is 400')
  assert.equal(response.json.ok, false, 'error body has ok=false')
  assert.equal(response.json.error.code, 'bad-request', 'error code for a bad format')

  response = await request('POST', '/sounds?kind=completed', {
    body: wav,
    headers: { 'content-type': 'application/octet-stream', 'x-file-name': 'real.wav' },
  })
  assert.equal(response.status, 200, 'the valid file is still accepted')
  const validPath = response.json.path

  // extension/signature mismatch: RIFF bytes under a .mp3 name
  response = await request('POST', '/sounds?kind=completed', {
    body: wav,
    headers: { 'content-type': 'application/octet-stream', 'x-file-name': 'mismatch.mp3' },
  })
  assert.equal(response.status, 400, 'extension/signature mismatch is 400')

  // unsupported extension
  response = await request('POST', '/sounds?kind=completed', {
    body: wav,
    headers: { 'content-type': 'application/octet-stream', 'x-file-name': 'sound.flac' },
  })
  assert.equal(response.status, 400, 'unsupported extension is 400')

  // unknown kind
  response = await request('POST', '/sounds?kind=bogus', {
    body: wav,
    headers: { 'content-type': 'application/octet-stream', 'x-file-name': 'x.wav' },
  })
  assert.equal(response.status, 400, 'unknown kind is 400')

  // --- 6. more than 12 MiB is rejected with 413 ---------------------------
  const oversized = Buffer.alloc(12 * 1024 * 1024 + 1)
  wav.copy(oversized, 0, 0, wav.length)
  response = await request('POST', '/sounds?kind=completed', {
    body: oversized,
    headers: { 'content-type': 'application/octet-stream', 'x-file-name': 'too-big.wav' },
  })
  assert.equal(response.status, 413, 'oversized upload is 413')
  assert.equal(response.json.error.code, 'payload-too-large', 'oversized error code')
  assert.equal(existsSync(validPath), true, 'a rejected oversized upload keeps the previous file')

  // --- 7. POST /preview-sound: allow-listed custom path, DRY_RUN log ------
  response = await request('POST', '/preview-sound', {
    body: JSON.stringify({ kind: 'completed', sound: validPath }),
    headers: { 'content-type': 'application/json' },
  })
  assert.equal(response.status, 200, 'preview-sound with a sounds/ path is 200')
  assert.equal(response.json.ok, true, 'preview-sound ok flag')

  const hostWav = join(stage, 'host', 'chime.wav')
  response = await request('POST', '/preview-sound', {
    body: JSON.stringify({ kind: 'question', sound: hostWav }),
    headers: { 'content-type': 'application/json' },
  })
  assert.equal(response.status, 200, 'preview-sound with a host/ path is 200')

  let runs = dryRuns()
  assert.equal(runs.length, 2, 'two dry-run preview-sound lines are logged')
  assert.equal(runs[0].previewSound, true, 'preview-sound payload is marked')
  assert.equal(runs[0].sound, validPath, 'preview-sound payload carries the custom path')
  assert.equal(runs[1].sound, hostWav, 'host/ path reaches the payload')

  // --- 8. forbidden paths are rejected with 400 ---------------------------
  const forbidden = [
    'C:\\Windows\\System32\\notepad.exe',
    join(stage, 'index.mjs'),
    'relative-sound.mp3',
  ]
  for (const sound of forbidden) {
    response = await request('POST', '/preview-sound', {
      body: JSON.stringify({ kind: 'completed', sound }),
      headers: { 'content-type': 'application/json' },
    })
    assert.equal(response.status, 400, `preview-sound rejects ${sound}`)
  }
  response = await request('POST', '/preview', {
    body: JSON.stringify({ kind: 'completed', sound: 'C:\\Windows\\win.ini' }),
    headers: { 'content-type': 'application/json' },
  })
  assert.equal(response.status, 400, 'preview rejects a path outside sounds/ and host/')

  // --- 9. POST /preview: sample window payload ----------------------------
  response = await request('POST', '/preview', {
    body: JSON.stringify({ kind: 'question', durationMs: 700, sound: true }),
    headers: { 'content-type': 'application/json' },
  })
  assert.equal(response.status, 200, 'preview is 200')
  assert.equal(response.json.ok, true, 'preview ok flag')
  assert.equal(response.json.payload.kind, 'question', 'preview keeps the kind')
  assert.equal(response.json.payload.durationMs, 700, 'preview honours durationMs')
  assert.equal(response.json.payload.sound, true, 'preview keeps the bundled sound flag')
  assert.ok(response.json.payload.body.includes('агент'), 'preview uses the sample body')

  runs = dryRuns()
  assert.equal(runs.length, 3, 'the preview window is a dry-run too')
  assert.equal(runs[2].kind, 'question', 'preview dry-run payload kind')
  assert.equal(runs[2].title, '❓ Нужен ваш ответ', 'preview dry-run title')

  // duration clamping and defaults
  response = await request('POST', '/preview', {
    body: JSON.stringify({ kind: 'completed' }),
    headers: { 'content-type': 'application/json' },
  })
  assert.equal(response.status, 200, 'preview without options is 200')
  assert.equal(response.json.payload.durationMs, 1000, 'preview falls back to durationMs from Config')

  response = await request('POST', '/preview', {
    body: JSON.stringify({ kind: 'completed', durationMs: 999999 }),
    headers: { 'content-type': 'application/json' },
  })
  assert.equal(response.status, 200, 'preview clamps large durations')
  assert.equal(response.json.payload.durationMs, 10000, 'durationMs clamps to the max')

  // --- 10. GET /status reflects a stored custom sound via Config ----------
  // Re-apply with the uploaded path saved in Config (the settings page writes it).
  plugin.apply(ctx, { ...config, questionSoundFile: mp3Path })
  response = await request('GET', '/status')
  assert.equal(response.status, 200, 'status after Config update is 200')
  assert.ok(response.json.custom.question !== null, 'status reports the configured custom question sound')
  assert.equal(response.json.custom.question.file, mp3Path, 'status reports the configured file path')
  assert.equal(response.json.custom.question.exists, true, 'status reports the file as existing')
  assert.equal(response.json.custom.question.format, 'mp3', 'status reports the file format')

  // --- 11. POST /reset-sound removes the saved files ----------------------
  response = await request('POST', '/reset-sound', {
    body: JSON.stringify({ kind: 'completed' }),
    headers: { 'content-type': 'application/json' },
  })
  assert.equal(response.status, 200, 'reset-sound is 200')
  assert.equal(response.json.kind, 'completed', 'reset-sound echoes the kind')
  assert.equal(existsSync(validPath), false, 'the saved completion sound is deleted')

  response = await request('POST', '/reset-sound', {
    body: JSON.stringify({ kind: 'question' }),
    headers: { 'content-type': 'application/json' },
  })
  assert.equal(response.status, 200, 'reset-sound for question is 200')
  assert.equal(existsSync(mp3Path), false, 'the saved question sound is deleted')

  // --- 12. routing edge cases ---------------------------------------------
  response = await request('GET', '/nope')
  assert.equal(response.status, 404, 'unknown route is 404')
  response = await request('GET', '/sounds?kind=completed')
  assert.equal(response.status, 405, 'GET on /sounds is 405')
  response = await request('POST', '/preview', {
    body: 'not json',
    headers: { 'content-type': 'application/json' },
  })
  assert.equal(response.status, 400, 'malformed JSON body is 400')

  console.log('PASS host-api: status, upload/add-replace, format/size checks, reset, preview (dry-run), allow-list')
} finally {
  if (server !== null) await new Promise((resolvePromise) => server.close(() => resolvePromise()))
  if (existsSync(soundsDir)) rmSync(soundsDir, { recursive: true, force: true })
  rmSync(stage, { recursive: true, force: true })
}
