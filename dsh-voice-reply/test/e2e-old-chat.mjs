/**
 * Browser E2E: opening a chat whose answer predates the plugin must stay
 * completely silent — no automatic Yandex SpeechKit request — and only the
 * speaker button under an answer may synthesize it.
 *
 * Run: node test/e2e-old-chat.mjs
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
const currentSession = `document.querySelector('[data-conversation-session]')?.getAttribute('data-conversation-session') ?? null`

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

try {
  await authenticatePage(page, URL)
  await page.send('Page.navigate', { url: URL })
  await page.waitFor("document.title === 'DeepSeek Harness'", { timeoutMs: 30000, label: 'app title' })
  await page.waitFor("document.body.innerText.includes('Рабочие пространства')", { timeoutMs: 30000, label: 'sidebar' })
  await sleep(1500)
  const active = await page.evaluate(currentSession)

  /* ---- open an existing (old) chat that already has answers ---- */
  const target = await page.evaluate(`(() => {
    const rows = [...document.querySelectorAll('[data-row-key^="session:"]')];
    const candidates = rows.filter((row) => row.getAttribute('data-row-key') !== 'session:${active}');
    const preferred = candidates.find((row) => (row.innerText || '').includes('Проверка голосового')) ?? candidates[0];
    if (preferred === undefined) return null;
    preferred.scrollIntoView({ block: 'center' });
    preferred.click();
    return { id: preferred.getAttribute('data-row-key').replace('session:', ''), text: (preferred.innerText || '').slice(0, 80) };
  })()`)
  check('an existing chat with answers was opened', target !== null, target)
  await page.waitFor(`(${currentSession}) === ${JSON.stringify(target?.id)}`, { timeoutMs: 20000, label: 'old chat' })
  await page.waitFor("document.querySelectorAll('[data-voice-reply-action]').length > 0", { timeoutMs: 20000, label: 'old answer actions' })
  await sleep(5000)

  const afterOpen = await page.evaluate(`(() => ({
    chip: document.querySelector('[data-voice-reply-chip]')?.getAttribute('data-voice-reply-state') ?? null,
    states: [...document.querySelectorAll('[data-voice-reply-action]')].map((n) => n.getAttribute('data-voice-reply-state')),
    actions: document.querySelectorAll('[data-voice-reply-action]').length,
  }))()`)
  check('opening an old chat makes no /speak request', speakRequests().length === 0, speakRequests())
  check('old chat stays silent automatically', afterOpen.chip === null && afterOpen.states.every((state) => state === 'idle'), afterOpen)
  await page.screenshot(path.join(ARTIFACTS, 'e2e-old-chat-silent.png'))

  /* ---- the speaker button still synthesizes on demand ---- */
  const clicked = await page.evaluate(`(() => {
    const nodes = [...document.querySelectorAll('[data-voice-reply-action]')];
    if (nodes.length === 0) return false;
    const button = nodes[nodes.length - 1];
    button.scrollIntoView({ block: 'center' });
    button.click();
    return true;
  })()`)
  check('speaker button on an old answer is clickable', clicked === true)
  const spoke = await page
    .waitFor(`document.querySelector('[data-voice-reply-chip]') !== null`, { timeoutMs: 20000, label: 'manual old-answer speech' })
    .then(() => true)
    .catch(() => false)
  check('speaker button synthesizes the old answer on demand', spoke === true, speakRequests())
  let onDemandRecorded = speakRequests().length === 1
  for (let attempt = 0; attempt < 50 && !onDemandRecorded; attempt += 1) {
    await sleep(200)
    onDemandRecorded = speakRequests().length === 1
  }
  check('the on-demand request happened after the click', onDemandRecorded, speakRequests())
  await page.screenshot(path.join(ARTIFACTS, 'e2e-old-chat-on-demand.png'))
} catch (error) {
  failures.push(`exception: ${error instanceof Error ? error.message : String(error)}`)
  try {
    await page.screenshot(path.join(ARTIFACTS, 'e2e-old-chat-failure.png'))
  } catch {
    /* ignore */
  }
} finally {
  const summary = { ok: failures.length === 0, failures, checks, network, console: page.consoleMessages.slice(-30), exceptions: page.exceptions.slice(-10) }
  fs.writeFileSync(path.join(ARTIFACTS, 'e2e-old-chat-report.json'), JSON.stringify(summary, null, 2))
  console.log(JSON.stringify(summary, null, 2))
  page.close()
  closeBrowser(browser)
}

if (failures.length > 0) process.exitCode = 1
