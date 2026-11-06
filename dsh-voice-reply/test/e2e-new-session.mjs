/**
 * End-to-end browser check for dsh-voice-reply.
 *
 * Creates a real new Session, sends one short prompt, waits for the reply Turn
 * to finish, and verifies:
 *   - the speaker action appears on the finalized answer;
 *   - auto-speak fires by itself (host error while the Yandex key has no TTS
 *     scope, or real playback with a working key / local mock);
 *   - clicking the action issues POST /dsh-voice-reply/speak and plays again;
 *   - audio bytes are served by GET /dsh-voice-reply/audio/<file>.
 *
 * Usage:
 *   node test/e2e-new-session.mjs
 *   node test/e2e-new-session.mjs --expect-audio --mock-audio <file.mp3>
 *
 * `--mock-audio` temporarily rewrites plugin-config.json's endpoint to a local
 * server returning the given MP3, so the full playback path can be verified
 * without Yandex credentials; the original file is restored afterwards.
 */
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { authenticatePage, closeBrowser, launchBrowser, openPage, sleep } from './cdp.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ARTIFACTS = path.join(HERE, '..', 'artifacts')
const URL = process.env.DSH_WEB_URL ?? 'http://127.0.0.1:3080'
const expectAudio = process.argv.includes('--expect-audio')
const mockAudioIndex = process.argv.indexOf('--mock-audio')
const mockAudioFile = mockAudioIndex === -1 ? null : process.argv[mockAudioIndex + 1]
const configFile = path.join(HERE, '..', 'plugin-config.json')

const failures = []
const checks = []
const network = []

/**
 * Record one check.
 * @param {string} name - check name.
 * @param {boolean} ok - result.
 * @param {unknown} [detail] - context.
 */
function check(name, ok, detail) {
  checks.push({ name, ok, detail })
  if (!ok) failures.push(`${name}: ${JSON.stringify(detail)}`)
}

fs.mkdirSync(ARTIFACTS, { recursive: true })

/* ---- optional local mock of the Yandex TTS endpoint ---- */
let mockServer = null
let savedConfigRaw = null
if (mockAudioFile !== null) {
  const audio = fs.readFileSync(mockAudioFile)
  mockServer = http.createServer((req, res) => {
    req.resume()
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'audio/mpeg', 'content-length': audio.length })
      res.end(audio)
    })
  })
  await new Promise((resolve) => mockServer.listen(0, '127.0.0.1', resolve))
  const port = mockServer.address().port
  savedConfigRaw = fs.readFileSync(configFile, 'utf8')
  const config = JSON.parse(savedConfigRaw)
  config.endpoint = `http://127.0.0.1:${port}/speech/v1/tts:synthesize`
  config.format = 'mp3'
  fs.writeFileSync(configFile, `${JSON.stringify(config, null, 2)}\n`, 'utf8')
  console.log('mock TTS endpoint:', config.endpoint)
}

const browser = await launchBrowser()
const page = await openPage(browser.port, URL)
page.onEvent((message) => {
  if (message.method === 'Network.requestWillBeSent' && String(message.params.request.url).includes('/dsh-voice-reply/')) {
    const url = String(message.params.request.url)
    if (!url.endsWith('/status')) network.push({ kind: 'request', method: message.params.request.method, url })
  }
  if (message.method === 'Network.responseReceived' && String(message.params.response.url).includes('/dsh-voice-reply/')) {
    const url = String(message.params.response.url)
    if (!url.endsWith('/status')) network.push({ kind: 'response', status: message.params.response.status, url, mime: message.params.response.mimeType })
  }
})

try {
  await authenticatePage(page, URL)
  await page.send('Page.navigate', { url: URL })
  await page.waitFor("document.title === 'DeepSeek Harness'", { timeoutMs: 30000, label: 'app title' })
  await page.waitFor("document.body.innerText.includes('Рабочие пространства')", { timeoutMs: 30000, label: 'sidebar' })
  await sleep(1500)

  /* ---- new session and one prompt ---- */
  const newSession = await page.evaluate(`(() => {
    const target = [...document.querySelectorAll('button')].find((b) => b.getAttribute('aria-label') === 'Новая сессия');
    if (target === undefined) return false;
    target.click();
    return true;
  })()`)
  check('new-session button clicked', newSession === true)
  await page.waitFor(`document.querySelector('[contenteditable="true"]') !== null`, { timeoutMs: 15000, label: 'composer editor' })
  await page.evaluate(`(() => { document.querySelector('[contenteditable="true"]').focus(); return true; })()`)
  await page.send('Input.insertText', { text: 'Ответь одним коротким предложением: проверка голосового плагина.' })
  await sleep(400)
  const sent = await page.evaluate(`(() => {
    const target = [...document.querySelectorAll('button')].find((b) => (b.getAttribute('aria-label') || '').includes('Отправить сообщение'));
    if (target === undefined) return false;
    target.click();
    return true;
  })()`)
  check('prompt submitted', sent === true)

  /* ---- finalized answer ---- */
  await page.waitFor("document.querySelectorAll('[data-voice-reply-action]').length > 0", { timeoutMs: 240000, label: 'finalized answer action' })
  const actions = await page.evaluate(`(() => {
    const nodes = [...document.querySelectorAll('[data-voice-reply-action]')];
    return { count: nodes.length, labels: nodes.map((n) => n.getAttribute('aria-label')), states: nodes.map((n) => n.getAttribute('data-voice-reply-state')) };
  })()`)
  check('finalized answer shows the speaker action', actions.count > 0, actions)
  await page.screenshot(path.join(ARTIFACTS, 'e2e-new-actions.png'))

  /* ---- auto-speak fired by itself ---- */
  const autoChip = await page
    .waitFor("document.querySelector('[data-voice-reply-chip]') !== null", { timeoutMs: 20000, label: 'auto-speak chip' })
    .then(() => true)
    .catch(() => false)
  const chipAfterAuto = await page.evaluate(`(() => {
    const chip = document.querySelector('[data-voice-reply-chip]');
    return chip === null ? null : { state: chip.getAttribute('data-voice-reply-state'), text: (chip.innerText || '').slice(0, 300) };
  })()`)

  if (expectAudio) {
    const playing = await page
      .waitFor(`document.querySelector('[data-voice-reply-chip]')?.getAttribute('data-voice-reply-state') === 'playing'`, { timeoutMs: 60000, label: 'auto-speak playback' })
      .then(() => true)
      .catch(() => false)
    const chip = await page.evaluate(`(() => {
      const el = document.querySelector('[data-voice-reply-chip]');
      return el === null ? null : { state: el.getAttribute('data-voice-reply-state'), text: (el.innerText || '').slice(0, 200) };
    })()`)
    check('auto-speak starts playback by itself', playing, chip)
    const audioServed = network.some((entry) => entry.kind === 'response' && entry.url.includes('/audio/') && entry.status === 200)
    check('audio bytes served by GET /audio', audioServed, network.filter((entry) => entry.url.includes('/audio/')))
    await page.screenshot(path.join(ARTIFACTS, 'e2e-new-playing.png'))
    const finished = await page
      .waitFor(`document.querySelector('[data-voice-reply-chip]') === null`, { timeoutMs: 60000, label: 'playback completion' })
      .then(() => true)
      .catch(() => false)
    check('playback finishes and the chip hides', finished)
  } else {
    check(
      'auto-speak fires and reports the host error (TTS key scope missing)',
      autoChip && (chipAfterAuto?.state === 'error' || chipAfterAuto?.state === 'playing'),
      chipAfterAuto,
    )
    check('error explains the missing TTS scope', /speechkitTts|скоуп|TTS|ключ/i.test(chipAfterAuto?.text ?? ''), chipAfterAuto)
    await page.screenshot(path.join(ARTIFACTS, 'e2e-new-auto.png'))
  }

  /* ---- manual replay through the speaker action ---- */
  await page.evaluate(`(() => {
    const nodes = [...document.querySelectorAll('[data-voice-reply-action]')];
    const button = nodes[nodes.length - 1];
    button.scrollIntoView({ block: 'center' });
    button.click();
    return true;
  })()`)
  await sleep(1500)
  const speakResponses = network.filter((entry) => entry.kind === 'response' && entry.url.includes('/speak'))
  check('speaker action issues POST /speak', speakResponses.length > 0, network)
  const speakResponse = speakResponses[speakResponses.length - 1]
  if (speakResponse !== undefined) {
    check(
      expectAudio ? 'speak response is 200' : 'speak response is 200 (working key) or 401 with explanation',
      expectAudio ? speakResponse.status === 200 : [200, 401, 403, 503].includes(speakResponse.status),
      speakResponse,
    )
  }
  const stateAfterClick = await page.evaluate(`(() => {
    const chip = document.querySelector('[data-voice-reply-chip]');
    const nodes = [...document.querySelectorAll('[data-voice-reply-action]')];
    return { chip: chip === null ? null : { state: chip.getAttribute('data-voice-reply-state'), text: (chip.innerText || '').slice(0, 200) }, actionStates: nodes.map((n) => n.getAttribute('data-voice-reply-state')) };
  })()`)
  check('UI reacts to the replay click', stateAfterClick.chip !== null || stateAfterClick.actionStates.some((state) => state !== 'idle'), stateAfterClick)
  if (expectAudio) {
    const replayPlaying = await page
      .waitFor(`document.querySelector('[data-voice-reply-chip]')?.getAttribute('data-voice-reply-state') === 'playing'`, { timeoutMs: 30000, label: 'replay playback' })
      .then(() => true)
      .catch(() => false)
    check('replay starts playback again', replayPlaying, stateAfterClick)
  }
  await page.screenshot(path.join(ARTIFACTS, 'e2e-new-replay.png'))
} catch (error) {
  failures.push(`exception: ${error instanceof Error ? error.message : String(error)}`)
  try {
    await page.screenshot(path.join(ARTIFACTS, 'e2e-new-failure.png'))
  } catch {
    /* ignore */
  }
} finally {
  if (savedConfigRaw !== null) {
    fs.writeFileSync(configFile, savedConfigRaw, 'utf8')
  }
  if (mockServer !== null) {
    await new Promise((resolve) => mockServer.close(resolve))
  }
  const summary = {
    ok: failures.length === 0,
    expectAudio,
    mockAudio: mockAudioFile !== null,
    failures,
    checks,
    network,
    console: page.consoleMessages.slice(-40),
    exceptions: page.exceptions.slice(-20),
  }
  fs.writeFileSync(path.join(ARTIFACTS, 'e2e-new-report.json'), JSON.stringify(summary, null, 2))
  console.log(JSON.stringify(summary, null, 2))
  page.close()
  closeBrowser(browser)
}

if (failures.length > 0) process.exitCode = 1
