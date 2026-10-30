// What does Kanidm's login page look like to a browser? (for the live login test)
import dns from 'node:dns/promises'
import { chromium } from 'playwright'

const [{ address }] = await dns.lookup('idm.localhost', { all: true })
const browser = await chromium.launch({
  args: [`--host-resolver-rules=MAP idm.localhost ${address}`],
})
const page = await (await browser.newContext({ ignoreHTTPSErrors: true })).newPage()
await page.goto('https://idm.localhost:8443/ui/login')
await page.waitForLoadState('networkidle')
console.log('URL', page.url())
console.log('TITLE', await page.title())
const controls = await page.evaluate(() =>
  Array.from(document.querySelectorAll('input, button, a, label, h1, h2, h3')).map(
    (el) =>
      `${el.tagName} type=${el.getAttribute('type')} name=${el.getAttribute('name')} id=${el.id} text=${(el.textContent ?? '').trim().slice(0, 40)}`,
  ),
)
console.log(controls.join('\n'))
await page.fill('#username', 'alice')
await page.click('button[type=submit]')
await page.waitForTimeout(1500)
console.log('--- after Begin ---')
console.log('URL', page.url())
console.log(
  (
    await page.evaluate(() =>
      Array.from(document.querySelectorAll('input, button, a, label, h1, h2, h3, p')).map(
        (el) =>
          `${el.tagName} type=${el.getAttribute('type')} name=${el.getAttribute('name')} id=${el.id} text=${(el.textContent ?? '').trim().slice(0, 50)}`,
      ),
    )
  ).join('\n'),
)
await browser.close()
