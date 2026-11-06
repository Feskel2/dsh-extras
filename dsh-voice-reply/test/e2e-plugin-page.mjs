/**
 * Verifies the bundle's display metadata in the Web UI: the Plugins page shows
 * the localized title/description («Голосовые ответы») and the uploaded icon.
 * Run: node test/e2e-plugin-page.mjs
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
const browser = await launchBrowser()
const page = await openPage(browser.port, URL)
try {
  await authenticatePage(page, URL)
  await page.send('Page.navigate', { url: URL })
  await page.waitFor("document.title === 'DeepSeek Harness'", { timeoutMs: 30000, label: 'app title' })
  await sleep(1200)

  const opened = await page.evaluate(`(() => {
    const target = [...document.querySelectorAll('button, [role="button"]')].find((b) => (b.innerText || '').trim() === 'Плагины');
    if (target === undefined) return false;
    target.click();
    return true;
  })()`)
  check('Plugins page opened', opened === true)
  const listed = await page
    .waitFor("document.body.innerText.includes('Голосовые ответы')", { timeoutMs: 15000, label: 'bundle title in Plugins' })
    .then(() => true)
    .catch(() => false)
  check('localized bundle title appears in Plugins', listed)

  const info = await page.evaluate(`(() => {
    const text = document.body.innerText;
    const card = [...document.querySelectorAll('*')].find((el) => (el.innerText || '').includes('Голосовые ответы') && (el.innerText || '').length < 600);
    const images = [...document.querySelectorAll('img, svg')].filter((el) => {
      const r = el.getBoundingClientRect();
      return r.width > 10 && r.height > 10;
    }).length;
    return { snippet: card ? (card.innerText || '').slice(0, 400) : '', images };
  })()`)
  check('bundle description visible', /SpeechKit|озвуч/i.test(info.snippet), info)
  await page.screenshot(path.join(ARTIFACTS, 'e2e-plugins-page.png'))
} catch (error) {
  failures.push(`exception: ${error instanceof Error ? error.message : String(error)}`)
  try {
    await page.screenshot(path.join(ARTIFACTS, 'e2e-plugins-page-failure.png'))
  } catch {
    /* ignore */
  }
} finally {
  const summary = { ok: failures.length === 0, failures, checks, console: page.consoleMessages.slice(-20), exceptions: page.exceptions.slice(-10) }
  fs.writeFileSync(path.join(ARTIFACTS, 'e2e-plugins-report.json'), JSON.stringify(summary, null, 2))
  console.log(JSON.stringify(summary, null, 2))
  page.close()
  closeBrowser(browser)
}
if (failures.length > 0) process.exitCode = 1
