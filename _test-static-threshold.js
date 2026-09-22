// Verifies the new numeric threshold on a Static Duration value, live
// against guardianbikes' real "Ticket Solved" (tickets_closed) data.
'use strict'
require('dotenv').config()
const { chromium } = require('playwright')

async function main() {
  const browser = await chromium.launch({ headless: false, executablePath: process.env.CHROME_PATH })
  const page = await browser.newPage({ viewport: { width: 1300, height: 950 } })
  const consoleErrors = []
  page.on('console', msg => { if (msg.type() === 'error') consoleErrors.push(msg.text()) })
  page.on('pageerror', err => consoleErrors.push('pageerror: ' + err.message))

  console.log('[test] loading dashboard, switching to guardianbikes...')
  await page.goto('http://localhost:3000/', { waitUntil: 'domcontentloaded', timeout: 30000 })
  await page.waitForTimeout(1500)
  await page.evaluate(() => localStorage.setItem('wfm_current_account', 'guardianbikes'))
  await page.reload({ waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(2000)

  console.log('[test] opening Settings > Data Sources...')
  await page.click('button[title="Settings"]')
  await page.waitForTimeout(500)
  await page.locator('.sm-tab', { hasText: 'Data Sources' }).click()
  await page.waitForTimeout(800)

  // Confirm the Duration slot (renamed "Ticket Solved") is already in Static mode.
  const staticBtn = page.locator('button', { hasText: 'Static (shown as-is)' })
  console.log('[test] Static mode button count (should already be static per earlier config):', await staticBtn.count())
  if (await staticBtn.count() === 0) {
    console.log('[test] not static yet — clicking Running button to switch...')
    await page.locator('button', { hasText: 'Running (live timer)' }).first().click()
    await page.waitForTimeout(300)
  }

  console.log('[test] setting Warning=10, Critical=5, direction=Low=Bad...')
  const wInput = page.locator('label', { hasText: 'W' }).locator('input').first()
  const cInput = page.locator('label', { hasText: 'C' }).locator('input').first()
  await wInput.fill('10')
  await cInput.fill('5')
  await page.waitForTimeout(200)
  const dirBtn = page.locator('button', { hasText: /High = Bad|Low = Bad/ })
  const dirText = await dirBtn.first().innerText()
  console.log('[test] direction button currently:', dirText)
  if (dirText.includes('High')) {
    await dirBtn.first().click()
    await page.waitForTimeout(200)
  }
  const dirTextAfter = await dirBtn.first().innerText()
  console.log('[test] direction button after ensuring Low=Bad:', dirTextAfter)

  console.log('[test] saving changes...')
  await page.locator('button', { hasText: 'Save Changes' }).click()
  await page.waitForTimeout(1500)

  console.log('[test] checking the Breach table now...')
  await page.click('text=Dashboard')
  await page.waitForTimeout(1500)
  const breachRows = await page.locator('table.dash-table tbody tr').all()
  console.log(`[test] ${breachRows.length} breach row(s) found`)
  for (let i = 0; i < Math.min(breachRows.length, 8); i++) {
    const cells = await breachRows[i].locator('td').allInnerTexts()
    console.log(`[test] row ${i}:`, cells)
  }

  console.log('\n[test] console errors:', consoleErrors.length)

  console.log('\n[test] Reverting: clearing threshold values...')
  await page.click('button[title="Settings"]')
  await page.waitForTimeout(500)
  await page.locator('.sm-tab', { hasText: 'Data Sources' }).click()
  await page.waitForTimeout(800)
  const wInput2 = page.locator('label', { hasText: 'W' }).locator('input').first()
  const cInput2 = page.locator('label', { hasText: 'C' }).locator('input').first()
  await wInput2.fill('0')
  await cInput2.fill('0')
  await page.waitForTimeout(200)
  await page.locator('button', { hasText: 'Save Changes' }).click()
  await page.waitForTimeout(1000)

  console.log('\n[test] DONE.')
  await page.waitForTimeout(3000)
  await browser.close()
  process.exit(0)
}

main().catch(err => { console.error('[test] FATAL:', err); process.exit(1) })
