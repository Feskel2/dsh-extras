/**
 * Browser E2E for "each finished answer is auto-spoken at most once per chat".
 *
 * Scenario:
 *   1. Create chat A and send a prompt; while its Turn runs, switch to a new
 *      chat B. A finishes in the background — the Host stores it, no audio.
 *   2. Open chat A → the answer is spoken exactly once (real Yandex TTS).
 *   3. Switch B → A again → nothing is spoken again.
 *   4. Manual replay works (🔊) and, after stopping it, switching chats still
 *      does not auto-repeat the answer.
 *
 * Run: node test/e2e-once-per-chat.mjs
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { authenticatePage, closeBrowser, launchBrowser, openPage, sleep } from './cdp.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ARTIFACTS = path.join(HERE, '..', 'artifacts')
const URL = process.env.DSH_WEB_URL ?? 'http://127.0.0.1:3080'

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

const speakRequests = () => network.filter((entry) => entry.kind === 'request' && entry.url.includes('/speak'))

fs.mkdirSync(ARTIFACTS, { recursive: true })
const browser = await launchBrowser()
const page = await openPage(browser.port, URL)
page.onEvent((message) => {
  if (message.method === 'Network.requestWillBeSent' && String(message.params.request.url).includes('/dsh-voice-reply/')) {
    const url = String(message.params.request.url)
    if (!url.endsWith('/status')) network.push({ at: Date.now(), kind: 'request', method: message.params.request.method, url })
  }
  if (message.method === 'Network.responseReceived' && String(message.params.response.url).includes('/dsh-voice-reply/')) {
    const url = String(message.params.response.url)
    if (!url.endsWith('/status')) network.push({ at: Date.now(), kind: 'response', status: message.params.response.status, url })
  }
})

/** Read the session id currently shown by the conversation. */
const currentSession = `document.querySelector('[data-conversation-session]')?.getAttribute('data-conversation-session') ?? null`

/**
 * Click one sidebar Session row by durable id.
 * @param {string} id - Session id.
 * @returns {Promise<boolean>} whether the row was found.
 */
async function openSession(id) {
  return page.evaluate(`(() => {
    const row = document.querySelector('[data-row-key="session:${id}"]');
    if (row === null) return false;
    row.scrollIntoView({ block: 'center' });
    row.click();
    return true;
  })()`)
}

try {
  await authenticatePage(page, URL)
  await page.send('Page.navigate', { url: URL })
  await page.waitFor("document.title === 'DeepSeek Harness'", { timeoutMs: 30000, label: 'app title' })
  await page.waitFor("document.body.innerText.includes('Рабочие пространства')", { timeoutMs: 30000, label: 'sidebar' })
  await sleep(1500)
  const initialSession = await page.evaluate(currentSession)

  /* ---- chat A: create + prompt ---- */
  await page.evaluate(`(() => { const b = [...document.querySelectorAll('button')].find((x) => x.getAttribute('aria-label') === 'Новая сессия'); if (b) b.click(); return true; })()`)
  await page.waitFor(`document.querySelector('[contenteditable="true"]') !== null`, { timeoutMs: 15000, label: 'composer' })
  await sleep(500)
  const chatA = await page.evaluate(currentSession)
  check('chat A created', typeof chatA === 'string' && chatA.startsWith('session-'), { initialSession, chatA })
  await page.evaluate(`(() => { document.querySelector('[contenteditable="true"]').focus(); return true; })()`)
  await page.send('Input.insertText', { text: 'Ответь одним коротким предложением: проверка «по одному разу на чат».' })
  await sleep(300)
  await page.evaluate(`(() => { const b = [...document.querySelectorAll('button')].find((x) => (x.getAttribute('aria-label') || '').includes('Отправить сообщение')); if (b) b.click(); return true; })()`)

  /* ---- immediately move to chat B while A keeps working ---- */
  await sleep(300)
  await page.evaluate(`(() => { const b = [...document.querySelectorAll('button')].find((x) => x.getAttribute('aria-label') === 'Новая сессия'); if (b) b.click(); return true; })()`)
  let switched = await page
    .waitFor(`(${currentSession}) !== ${JSON.stringify(chatA)}`, { timeoutMs: 15000, label: 'chat B' })
    .then(() => true)
    .catch(() => false)
  if (!switched) {
    // The app may keep the running chat selected; open any other listed chat.
    switched = await page.evaluate(`(() => {
      const rows = [...document.querySelectorAll('[data-row-key^="session:"]')];
      const others = rows.filter((row) => row.getAttribute('data-row-key') !== 'session:${chatA}');
      const preferred = others.find((row) => (row.innerText || '').includes('Проверка голосового'));
      const other = preferred ?? others[0];
      if (other === undefined) return false;
      other.scrollIntoView({ block: 'center' });
      other.click();
      return true;
    })()`)
    switched = switched && (await page.waitFor(`(${currentSession}) !== ${JSON.stringify(chatA)}`, { timeoutMs: 15000, label: 'other chat' }).then(() => true).catch(() => false))
  }
  const chatB = await page.evaluate(currentSession)
  check('switched to chat B while A runs', switched === true && typeof chatB === 'string' && chatB !== chatA, { chatA, chatB, switched })

  /* ---- wait until A finishes in the background ---- */
  let pendingReady = false
  const deadline = Date.now() + 180000
  while (Date.now() < deadline) {
    pendingReady = await page.evaluate(`(async () => {
      try {
        const response = await fetch('/dsh-voice-pending/peek?sessionId=' + encodeURIComponent(${JSON.stringify(chatA)}));
        if (!response.ok) return false;
        const body = await response.json();
        return body.ok === true && body.item !== null && typeof body.item.text === 'string' && body.item.text.length > 0;
      } catch (error) { return false; }
    })()`)
    if (pendingReady) break
    await sleep(1000)
  }
  check('background answer recorded by the Host', pendingReady === true, { chatA, network: speakRequests() })
  check('nothing is spoken while another chat is open', speakRequests().length === 0, speakRequests())
  await page.screenshot(path.join(ARTIFACTS, 'e2e-once-other-chat.png'))

  /* ---- open A: spoken exactly once ---- */
  check('chat A row is in the sidebar', (await openSession(chatA)) === true)
  await page.waitFor(`(${currentSession}) === ${JSON.stringify(chatA)}`, { timeoutMs: 20000, label: 'back to A' })
  const spokenOnce = await page
    .waitFor(`document.querySelector('[data-voice-reply-chip]')?.getAttribute('data-voice-reply-state') === 'playing'`, { timeoutMs: 60000, label: 'A spoken on open' })
    .then(() => true)
    .catch(() => false)
  check('answer of A is spoken after opening A', spokenOnce, speakRequests())
  check('exactly one /speak request for the opening', speakRequests().length === 1, speakRequests())
  await page.screenshot(path.join(ARTIFACTS, 'e2e-once-spoken.png'))
  await page.waitFor(`document.querySelector('[data-voice-reply-chip]') === null`, { timeoutMs: 60000, label: 'A playback finished' }).catch(() => undefined)

  /* ---- switch to another listed chat and back: no automatic repeat ---- */
  const otherChat = await page.evaluate(`(() => {
    const rows = [...document.querySelectorAll('[data-row-key^="session:"]')];
    const others = rows.filter((row) => row.getAttribute('data-row-key') !== 'session:${chatA}');
    const preferred = others.find((row) => (row.innerText || '').includes('Проверка голосового'));
    const other = preferred ?? others[0];
    if (other === undefined) return null;
    other.scrollIntoView({ block: 'center' });
    other.click();
    return other.getAttribute('data-row-key').replace('session:', '');
  })()`)
  check('another listed chat opened', typeof otherChat === 'string' && otherChat !== chatA, { otherChat })
  await page.waitFor(`(${currentSession}) === ${JSON.stringify(otherChat)}`, { timeoutMs: 20000, label: 'other chat' })
  await sleep(2000)
  check('chat A row is still in the sidebar', (await openSession(chatA)) === true)
  await page.waitFor(`(${currentSession}) === ${JSON.stringify(chatA)}`, { timeoutMs: 20000, label: 'back to A again' })
  await sleep(4000)
  check('switching chats does not auto-repeat the answer', speakRequests().length === 1, speakRequests())
  const stateAfterSwitching = await page.evaluate(`(() => ({
    chip: document.querySelector('[data-voice-reply-chip]')?.getAttribute('data-voice-reply-state') ?? null,
    states: [...document.querySelectorAll('[data-voice-reply-action]')].map((n) => n.getAttribute('data-voice-reply-state')),
  }))()`)
  check('UI is idle after switching back', stateAfterSwitching.chip === null && stateAfterSwitching.states.every((state) => state === 'idle'), stateAfterSwitching)
  await page.screenshot(path.join(ARTIFACTS, 'e2e-once-after-switch.png'))

  /* ---- manual replay still works and is not auto-repeated after stop ---- */
  const replayClicked = await page.evaluate(`(() => { const nodes = [...document.querySelectorAll('[data-voice-reply-action]')]; if (nodes.length === 0) return false; nodes[nodes.length - 1].click(); return true; })()`)
  check('manual replay is clickable', replayClicked === true)
  const replayPlaying = await page
    .waitFor(`document.querySelector('[data-voice-reply-chip]')?.getAttribute('data-voice-reply-state') === 'playing'`, { timeoutMs: 15000, label: 'manual replay' })
    .then(() => true)
    .catch(() => false)
  check('manual replay plays the answer', replayPlaying)
  check('manual replay does not auto-repeat anything', speakRequests().length === 1, speakRequests())
  // Stop it through the ambient chip.
  await page.evaluate(`(() => {
    const chip = document.querySelector('[data-voice-reply-chip]');
    const button = chip === null ? null : chip.querySelector('button');
    if (button !== null) button.click();
    return true;
  })()`)
  await sleep(800)
  await openSession(otherChat)
  await page.waitFor(`(${currentSession}) === ${JSON.stringify(otherChat)}`, { timeoutMs: 20000, label: 'other chat after replay stop' })
  await sleep(1500)
  await openSession(chatA)
  await page.waitFor(`(${currentSession}) === ${JSON.stringify(chatA)}`, { timeoutMs: 20000, label: 'A after replay stop' })
  await sleep(3000)
  check('a stopped manual replay is not auto-repeated', speakRequests().length === 1, speakRequests())
} catch (error) {
  failures.push(`exception: ${error instanceof Error ? error.message : String(error)}`)
  try {
    await page.screenshot(path.join(ARTIFACTS, 'e2e-once-failure.png'))
  } catch {
    /* ignore */
  }
} finally {
  const summary = { ok: failures.length === 0, failures, checks, network, console: page.consoleMessages.slice(-40), exceptions: page.exceptions.slice(-20) }
  fs.writeFileSync(path.join(ARTIFACTS, 'e2e-once-report.json'), JSON.stringify(summary, null, 2))
  console.log(JSON.stringify(summary, null, 2))
  page.close()
  closeBrowser(browser)
}

if (failures.length > 0) process.exitCode = 1
