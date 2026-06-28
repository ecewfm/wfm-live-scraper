// lib/scrape-talkdesk.js
// Ashley Phones (Talkdesk) scraper for Node.js + Playwright.
// Handles the 3-hop login flow and scrapes data from the cross-origin live iframe.

const path = require('path')
const fs   = require('fs')
const { hideWindow, showWindow } = require('./win-window')

const LIVE_URL      = 'https://ashleyretail.mytalkdesk.com/atlas/apps/live'
const SESSIONS_DIR  = path.join(__dirname, '..', 'sessions')

// Reusable IdleDetector mock — injected into every page/context
const IDLE_DETECTOR_MOCK = () => {
  class MockIdleDetector extends EventTarget {
    constructor() { super() }
    static async requestPermission() { return 'granted' }
    async start() {}
    get userState()   { return 'active'   }
    get screenState() { return 'unlocked' }
  }
  Object.defineProperty(window, 'IdleDetector', {
    value: MockIdleDetector, writable: true, configurable: true
  })
}

// ── Login flow ────────────────────────────────────────────────────────────────
// Talkdesk has 3 hops:
//   1. ashleyretail.mytalkdesk.com → redirects to talkdeskid.com credentials page
//   2. Credentials page → fill email + password → submit
//   3. account.talkdeskid.com (account picker) → navigate directly to live URL
// ── Login flow ────────────────────────────────────────────────────────────────
// Talkdesk has 3 hops:
//   1. ashleyretail.mytalkdesk.com → redirects to talkdeskid.com credentials page
//   2. Credentials page → fill email + password → submit
//   3. account.talkdeskid.com (account picker) → navigate directly to live URL
//
// Uses waitForURL (not waitForNavigation) because Talkdesk uses React fetch +
// client-side routing — a real page navigation event may not fire.
async function loginTalkdesk(page, context, account, sessionPath) {
  const tag = `[${account.id}]`

  console.log(`${tag} Navigating to Talkdesk live monitoring...`)
  await page.goto(LIVE_URL, { waitUntil: 'domcontentloaded', timeout: 30000 })
  await page.waitForTimeout(2000)

  // ── Step 2: Credentials page ──────────────────────────────────────────────
  if (page.url().includes('talkdeskid.com') && !page.url().includes('account.talkdeskid.com')) {
    console.log(`${tag} On credentials page — filling form...`)

    await page.waitForSelector('input[type="email"]', { timeout: 20000 })
    await page.fill('input[type="email"]',    account.email)
    await page.waitForTimeout(600)
    await page.fill('input[type="password"]', account.password)
    await page.waitForTimeout(600)

    console.log(`${tag} Clicking submit...`)
    await page.click('button[type="submit"]')

    // waitForURL is more reliable than waitForNavigation for React SPA logins
    await page.waitForURL(
      url => !url.href.includes('15746684.talkdeskid.com') && !url.href.includes('ashleyretail.talkdeskid.com'),
      { timeout: 45000 }
    )
    console.log(`${tag} Redirected to: ${page.url()}`)
  }

  // ── Handle "Device usage" wall ────────────────────────────────────────────
  await _handleDeviceUsagePage(page, tag)

  // ── Step 3: Account picker page ───────────────────────────────────────────
  if (page.url().includes('account.talkdeskid.com')) {
    console.log(`${tag} Account picker — navigating to live monitoring...`)
    await page.goto(LIVE_URL, { waitUntil: 'domcontentloaded', timeout: 30000 })
    await page.waitForTimeout(1500)
    await _handleDeviceUsagePage(page, tag)
  }

  // ── Final fallback — if not on dashboard yet, go directly ─────────────────
  if (!page.url().includes('ashleyretail.mytalkdesk.com')) {
    console.log(`${tag} Not on dashboard — navigating directly...`)
    await page.goto(LIVE_URL, { waitUntil: 'domcontentloaded', timeout: 30000 })
    await page.waitForTimeout(1500)
    await _handleDeviceUsagePage(page, tag)
  }

  await page.waitForURL('**/ashleyretail.mytalkdesk.com/**', { timeout: 30000 })
  console.log(`${tag} ✅ Login successful`)

  await context.storageState({ path: sessionPath })
  console.log(`${tag} Session saved → ${sessionPath}`)
}

// ── Click through "Device usage" permission page if it appears ────────────────
async function _handleDeviceUsagePage(page, tag) {
  if (!page.url().includes('request-idle-permission')) return
  console.log(`${tag} Device usage page — clicking Enable...`)
  try {
    const btn = await page.waitForSelector(
      'button:has-text("Enable device usage")',
      { timeout: 8000 }
    )
    await btn.click()
    await page.waitForURL(
      url => !url.href.includes('request-idle-permission'),
      { timeout: 15000 }
    ).catch(() => {})
    await page.waitForTimeout(1500)
    console.log(`${tag} Device usage accepted — now on: ${page.url()}`)
  } catch (e) {
    console.warn(`${tag} Device usage handler: ${e.message}`)
  }
}


// ── Find the live monitoring iframe ──────────────────────────────────────────
// Talkdesk embeds the live dashboard inside an iframe from prd-cdn-talkdesk.talkdesk.com
// Playwright can access it directly — no cross-origin restriction in controlled browser
async function getLiveFrame(page, accountId) {
  const tag = `[${accountId}]`

  console.log(`${tag} Waiting for live monitoring iframe...`)

  // Wait for the iframe element to appear in the DOM
  await page.waitForSelector('iframe.app-module__iframe', { timeout: 60000 })
    .catch(() => console.warn(`${tag} iframe.app-module__iframe not found — will search frames anyway`))

  // Poll page.frames() until the live dashboard frame appears and has content
  for (let attempt = 0; attempt < 30; attempt++) {
    for (const frame of page.frames()) {
      const frameUrl = frame.url()
      if (!frameUrl.includes('prd-cdn-talkdesk') && !frameUrl.includes('reporting-live-dashboards')) continue

      const hasContent = await frame.evaluate(() => {
        return !!(
          document.getElementById('live-dashboards-app') ||
          document.querySelector('[data-testid="widget-card"]') ||
          document.querySelector('[class*="live-dashboard"]') ||
          document.querySelector('[class*="reporting-live"]')
        )
      }).catch(() => false)

      if (hasContent) {
        console.log(`${tag} Live frame found: ${frameUrl.substring(0, 80)}`)
        return frame
      }
    }
    await page.waitForTimeout(1500)
  }

  console.warn(`${tag} Could not find live monitoring frame after 45s`)
  return null
}

// ── Core scrape — runs inside the live iframe ─────────────────────────────────
// Ported directly from iframe_scraper.js
async function scrapeFrame(frame, accountId) {
  const tag = `[${accountId}]`

  // First: scroll all overflow containers to expose virtual-scroll rows
  await frame.evaluate(async () => {
    const all = Array.from(document.querySelectorAll('*'))
    all.forEach(el => {
      try {
        const s = window.getComputedStyle(el)
        if ((s.overflowY === 'auto' || s.overflowY === 'scroll') &&
            el.scrollHeight > el.clientHeight + 10) {
          el.scrollTop = el.scrollHeight
        }
      } catch (_) {}
    })
    await new Promise(r => setTimeout(r, 400))
  })

  // Run the full scrape inside the frame — all DOM operations happen here
  const result = await frame.evaluate(async () => {
    const sleep = ms => new Promise(r => setTimeout(r, ms))
    const txt   = el => (el ? (el.innerText || el.textContent || '').trim() : '')

    // ──────────────────────────────────────────────────────────────────────────
    // PART 1: KPI TILES
    // ──────────────────────────────────────────────────────────────────────────
    function scrapeKPIs() {
      const groupMap = {}

      let tiles = Array.from(document.querySelectorAll('[data-testid="widget-card"]'))
      if (tiles.length === 0) {
        tiles = Array.from(document.querySelectorAll('*')).filter(el => {
          if (el.children.length > 20) return false
          const t = txt(el)
          return /service level|AHT|contacts in queue|agents logged/i.test(t) && t.length < 500
        })
      }

      const lobOrder = []

      // Pass 1: labeled tiles
      tiles.forEach(tile => {
        const fullText = txt(tile)
        const lines    = fullText.split('\n').map(l => l.trim()).filter(l => l.length > 0)
        if (lines.length === 0) return
        const title = lines[0]

        if (/service level/i.test(title)) {
          const group = title.replace(/service level/i, '').trim() || 'Unknown'
          if (!groupMap[group]) groupMap[group] = {}
          const pct = lines.find(l => /^\d+(\.\d+)?%$/.test(l.trim()))
          if (pct) groupMap[group].sla = pct.trim()
          if (group !== 'Unknown' && !lobOrder.includes(group)) lobOrder.push(group)
        }

        if (/\bAHT\b/i.test(title) && !/service level/i.test(title)) {
          const group = title.replace(/\bAHT\b/i, '').trim() || 'Unknown'
          if (!groupMap[group]) groupMap[group] = {}
          const dur = lines.find(l => /^\d+:\d+$/.test(l.trim()))
          if (dur) groupMap[group].aht = dur.trim()
        }

        if (/live contacts in queue/i.test(title)) {
          const group = title.replace(/live contacts in queue/i, '').trim() || 'Unknown'
          if (!groupMap[group]) groupMap[group] = {}
          const num = lines.find((l, i) => i > 0 && /^\d+$/.test(l.trim()))
          groupMap[group].contactsInQueue = num ? num.trim() : '0'
        }
      })

      // Pass 2: Count of Agents Logged-In tiles (unlabeled — assign by position)
      let agentTileIdx = 0
      tiles.forEach(tile => {
        const fullText = txt(tile)
        const lines    = fullText.split('\n').map(l => l.trim()).filter(l => l.length > 0)
        if (lines.length === 0) return
        const title = lines[0]

        if (/count of agents logged.?in/i.test(title)) {
          const group = lobOrder[agentTileIdx] || ('Unknown_' + agentTileIdx)
          agentTileIdx++
          if (!groupMap[group]) groupMap[group] = {}
          const availM = fullText.match(/(\d+)\s*Available/i)
          const acwM   = fullText.match(/(\d+)\s*ACW/i)
          const busyM  = fullText.match(/(\d+)\s*Busy/i)
          const awayM  = fullText.match(/(\d+)\s*Away/i)
          const nums   = lines.filter(l => /^\d+$/.test(l.trim())).map(l => parseInt(l.trim()))
          const total  = nums.length > 0 ? String(Math.max(...nums)) : 'N/A'
          groupMap[group].loggedIn = {
            total,
            available: availM ? availM[1] : '0',
            acw:       acwM   ? acwM[1]   : '0',
            busy:      busyM  ? busyM[1]  : '0',
            away:      awayM  ? awayM[1]  : '0'
          }
        }
      })

      // Fallback: full innerText parsing if tiles yielded nothing
      if (Object.keys(groupMap).length === 0) {
        const pageLines = document.body.innerText.split('\n').map(l => l.trim()).filter(l => l.length > 0)
        const isPercent = l => /^\d+%$/.test(l)
        const isDur     = l => /^\d+:\d+$/.test(l)
        const isNum     = l => /^\d+$/.test(l)
        let lastNamedGroup = null

        for (let i = 0; i < pageLines.length; i++) {
          const ln = pageLines[i]
          if (/service level$/i.test(ln)) {
            const group = ln.replace(/service level$/i, '').trim() || 'Unknown'
            if (!groupMap[group]) groupMap[group] = {}
            for (let j = i+1; j < Math.min(i+8, pageLines.length); j++) {
              if (isPercent(pageLines[j])) { groupMap[group].sla = pageLines[j]; break }
            }
            if (group !== 'Unknown') lastNamedGroup = group
          }
          if (/\bAHT$/i.test(ln)) {
            const group = ln.replace(/\bAHT$/i, '').trim() || 'Unknown'
            if (!groupMap[group]) groupMap[group] = {}
            for (let j = i+1; j < Math.min(i+8, pageLines.length); j++) {
              if (isDur(pageLines[j])) { groupMap[group].aht = pageLines[j]; break }
            }
            if (group !== 'Unknown') lastNamedGroup = group
          }
          if (/live contacts in queue$/i.test(ln)) {
            const group = ln.replace(/live contacts in queue$/i, '').trim() || 'Unknown'
            if (!groupMap[group]) groupMap[group] = {}
            for (let j = i+1; j < Math.min(i+12, pageLines.length); j++) {
              if (isNum(pageLines[j])) { groupMap[group].contactsInQueue = pageLines[j]; break }
            }
            if (group !== 'Unknown') lastNamedGroup = group
          }
          if (/count of agents logged.?in$/i.test(ln)) {
            let group = ln.replace(/count of agents logged.?in$/i, '').trim()
            if (!group) group = lastNamedGroup || 'Unknown'
            if (!groupMap[group]) groupMap[group] = {}
            const section = pageLines.slice(i+1, i+20).join('\n')
            const availM  = section.match(/(\d+)\s*Available/i)
            const acwM    = section.match(/(\d+)\s*ACW/i)
            const busyM   = section.match(/(\d+)\s*Busy/i)
            const awayM   = section.match(/(\d+)\s*Away/i)
            let total = 'N/A'
            for (let j = i+1; j < Math.min(i+8, pageLines.length); j++) {
              if (isNum(pageLines[j])) { total = pageLines[j]; break }
            }
            groupMap[group].loggedIn = {
              total,
              available: availM ? availM[1] : '0',
              acw:       acwM   ? acwM[1]   : '0',
              busy:      busyM  ? busyM[1]  : '0',
              away:      awayM  ? awayM[1]  : '0'
            }
          }
        }
      }

      return Object.keys(groupMap).map(group => ({
        group,
        sla:             groupMap[group].sla             || 'N/A',
        aht:             groupMap[group].aht             || 'N/A',
        contactsInQueue: groupMap[group].contactsInQueue || 'N/A',
        loggedIn:        groupMap[group].loggedIn        || { total: 'N/A', available: '0', acw: '0', busy: '0', away: '0' }
      }))
    }

    // ──────────────────────────────────────────────────────────────────────────
    // PART 2: AGENT TABLES  (logic ported from proven Chrome extension iframe_scraper.js)
    // ──────────────────────────────────────────────────────────────────────────
    async function scrapeAgentTables() {
      const agents = []

      let tableBodies = Array.from(document.querySelectorAll('.co-table__body'))
      if (tableBodies.length === 0) {
        tableBodies = Array.from(document.querySelectorAll(
          'tbody, [role="rowgroup"], [class*="TableBody"], [class*="table-body"]'
        ))
      }

      for (const tbody of tableBodies) {
        // ── Determine table label ────────────────────────────────────────────
        let tableLabel = 'Unknown'
        let el = tbody
        for (let i = 0; i < 12; i++) {
          el = el.parentElement
          if (!el) break
          const headings = el.querySelectorAll('h4, h3, h2, h1')
          for (const h of headings) {
            const ht = txt(h).split('\n')[0].trim()
            if (ht.length > 2 && ht.length < 100 && /agent|available|contacts in queue/i.test(ht)) {
              tableLabel = ht; break
            }
          }
          if (tableLabel !== 'Unknown') break
        }

        if (!/agent|available/i.test(tableLabel)) continue

        const scrollContainer = tbody
        scrollContainer.scrollTop = 0
        await sleep(200)

        const allRowData = []  // { name, queues, status, timeInStatus }

        function harvestVisibleRows() {
          // Real rows: class="co-table__row"; skip react-flex expanded detail strips
          const rows = Array.from(tbody.querySelectorAll('.co-table__row'))

          for (const row of rows) {
            // ── Agent name: first <A> tag ──────────────────────────────────
            const nameEl = row.querySelector('a')
            if (!nameEl) continue
            const agentName = txt(nameEl).trim()
            if (!agentName || agentName.length < 2) continue
            if (allRowData.some(r => r.name === agentName)) continue  // dedupe

            // ── Status: <P> with co-text class ────────────────────────────
            const statusEl = row.querySelector('p[class*="co-text"], p[class*="co-typ"]')
            const status   = statusEl
              ? txt(statusEl).replace(/[\u25bc\u25b2\u2193\u2191\u25be\u25b4▼▲↓↑]/g, '').trim()
              : ''

            // ── Time in status: SPAN whose full text matches MM:SS exactly ─
            // This is the key — search ALL spans for a time-formatted value
            const allSpans    = Array.from(row.querySelectorAll('span'))
            const timeSpan    = allSpans.find(s => /^\d{1,2}:\d{2}(:\d{2})?$/.test(txt(s).trim()))
            const timeInStatus = timeSpan ? txt(timeSpan).trim() : ''

            // ── Queues: co-chip.co--small + p.co--truncate overflow ────────
            const queues      = []
            const primaryChip = row.querySelector('.co-chip.co--small')
            if (primaryChip) {
              const qv = txt(primaryChip).trim()
              if (qv && !/^\+\d+$/.test(qv)) queues.push(qv)
            }
            const truncatePtags = Array.from(row.querySelectorAll('p.co--truncate'))
            const queueP = truncatePtags.length > 1
              ? truncatePtags[truncatePtags.length - 1]
              : null
            if (queueP) {
              const queueStr = txt(queueP).trim()
              if (queueStr && (queueStr.includes('_') || queueStr.includes('+'))) {
                queueStr.split('+').forEach(q => {
                  const qv = q.trim()
                  if (qv && !queues.includes(qv)) queues.push(qv)
                })
              }
            }

            allRowData.push({ name: agentName, queues, status, timeInStatus, table: tableLabel })
          }
        }

        // ── Fixed 300px step scroll — stop after 3 consecutive empty passes ─
        // Same strategy as the extension: more reliable than scrollHeight-based stop
        const STEP      = 300
        const MAX_STEPS = 60   // hard cap ~18 000px
        let scrollPos   = 0
        let emptyPasses = 0

        for (let step = 0; step < MAX_STEPS; step++) {
          scrollContainer.scrollTop = scrollPos
          await sleep(120)   // 120ms safe, 50ms is minimum per extension tests
          const before = allRowData.length
          harvestVisibleRows()
          const added = allRowData.length - before

          if (added === 0) {
            emptyPasses++
            if (emptyPasses >= 3) break   // 3 empty steps in a row = end of list
          } else {
            emptyPasses = 0
          }
          scrollPos += STEP
        }

        // Reset scroll to top
        scrollContainer.scrollTop = 0
        await sleep(100)

        // Merge into main agents array — skip exact duplicates
        for (const rowData of allRowData) {
          const exists = agents.some(a => a.name === rowData.name && a.table === tableLabel)
          if (!exists) agents.push(rowData)
        }
      }

      // ── Fallback: innerText line parsing if DOM scraping got nothing ────────
      if (agents.length === 0) {
        const pageText      = document.body.innerText
        const tablePatterns = [
          { label: 'Agents on a Call',   pattern: /Agents on a call[\s\S]*?(?=Agents on Non|Available Agents|$)/i },
          { label: 'Agents on Non Prod', pattern: /Agents on Non P[\s\S]*?(?=Available Agents|$)/i },
          { label: 'Available Agents',   pattern: /Available Agents[\s\S]*?$/i }
        ]
        const skipLines = ['Agents on a call','Agents on Non','Available Agents',
          'Agent name','Queues','Status','Time in status','User Attributes','Live','●']
        const isDur = s => /^\d+:\d+(:\d+)?$/.test(s)

        tablePatterns.forEach(({ label, pattern }) => {
          const m = pageText.match(pattern)
          if (!m) return
          const lines = m[0].split('\n').map(l => l.trim()).filter(l => l.length > 0)
          let i = 0
          while (i < lines.length) {
            const ln = lines[i]
            if (skipLines.some(s => ln.toLowerCase().includes(s.toLowerCase()))) { i++; continue }
            if (ln.length > 1 && ln.length < 80 && !/^\d+$/.test(ln) && !/^\+\d+$/.test(ln)) {
              let status = '', timeInStatus = ''
              if (lines[i+1] && !isDur(lines[i+1]) && lines[i+1].length < 50) {
                status = lines[i+1].replace(/[▼▲↓↑]/g, '').trim()
                if (lines[i+2] && isDur(lines[i+2])) { timeInStatus = lines[i+2]; i += 3 }
                else { i += 2 }
              } else if (lines[i+1] && isDur(lines[i+1])) {
                timeInStatus = lines[i+1]; i += 2
              } else { i++; continue }
              const exists = agents.some(a => a.name === ln && a.table === label)
              if (!exists) agents.push({ name: ln, queues: [], status, timeInStatus, table: label })
              continue
            }
            i++
          }
        })
      }

      return agents
    }


    // ──────────────────────────────────────────────────────────────────────────
    // Run both scrapes
    // ──────────────────────────────────────────────────────────────────────────
    const groupKpis = scrapeKPIs()
    const agents    = await scrapeAgentTables()

    // Build global KPI totals from group data (same as content.js)
    let totalAvail = 0, totalACW = 0, totalBusy = 0, totalLogged = 0
    groupKpis.forEach(g => {
      totalAvail  += parseInt(g.loggedIn.available) || 0
      totalACW    += parseInt(g.loggedIn.acw)       || 0
      totalBusy   += parseInt(g.loggedIn.busy)      || 0
      if (!isNaN(parseInt(g.loggedIn.total))) totalLogged += parseInt(g.loggedIn.total)
    })

    const kpis = {
      'Total Logged-In Agents':   String(totalLogged || (totalAvail + totalACW + totalBusy)),
      'Total Available':          String(totalAvail),
      'Total ACW':                String(totalACW),
      'Total Busy':               String(totalBusy),
      'Agents on a Call Count':   String(agents.filter(a => /agents on a call/i.test(a.table)).length),
      'Agents on Break/Aux Count':String(agents.filter(a => /non.prod/i.test(a.table)).length),
      'Available Agents Count':   String(agents.filter(a => /available/i.test(a.table)).length || totalAvail)
    }

    return {
      groupKpis,
      agents,
      kpis,
      hasData: groupKpis.length > 0 || agents.length > 0
    }
  })

  return result
}

// ── Full account runner ───────────────────────────────────────────────────────
async function runTalkdeskAccount(account, { chromium, INTERVAL_MS }) {
  const tag         = `[${account.id}]`
  const sessionPath = path.join(SESSIONS_DIR, `${account.id}.json`)
  let isHeadless = process.env.HEADLESS !== 'false'
  let _cdp      = null   // CDP session for window control
  let _windowId = null   // Chrome window ID

  // Use dash callbacks if available, otherwise fall back to console
  const log  = account._onLog  || (msg => console.log(`${tag} ${msg}`))
  const warn = account._onWarn || (msg => console.warn(`${tag} ${msg}`))
  const err  = account._onErr  || (msg => console.error(`${tag} ${msg}`))
  const upd  = account._onUpdate || (() => {})

  const browser = await chromium.launch({
    headless: isHeadless,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
    executablePath: process.env.CHROME_PATH || undefined
  })


  const contextOpts = fs.existsSync(sessionPath) ? { storageState: sessionPath } : {}
  const context     = await browser.newContext(contextOpts)
  const page        = await context.newPage()
  page.on('console', () => {})
  page.on('pageerror', () => {})

  // Mock IdleDetector so Talkdesk "Device usage" check always passes
  await page.addInitScript(IDLE_DETECTOR_MOCK)

  log('Logging in to Ashley Phones (Talkdesk)...')
  await loginTalkdesk(page, context, account, sessionPath)

  if (!page.url().includes('/atlas/apps/live')) {
    await page.goto(LIVE_URL, { waitUntil: 'domcontentloaded', timeout: 30000 })
  }

  let liveFrame = await getLiveFrame(page, account.id)

  // Set up CDP window control for minimize/restore
  await setupCDP(page, context)
  if (!liveFrame) {
    err('Could not find live iframe — aborting')
    await browser.close()
    return
  }

  log(`Ready — scraping every ${INTERVAL_MS / 1000}s`)

  const { writeTalkdeskSnapshot } = require('./db-talkdesk')

  async function tick() {
    try {
      if (!liveFrame || liveFrame.isDetached()) {
        warn('Frame detached — re-finding...')
        liveFrame = await getLiveFrame(page, account.id)
        if (!liveFrame) { err('Could not re-find live iframe'); return }
      }

      if (page.url().includes('talkdeskid.com')) {
        warn('Session expired — re-logging in...')
        await loginTalkdesk(page, context, account, sessionPath)
        liveFrame = await getLiveFrame(page, account.id)
        if (!liveFrame) return
      }

      const scraped = await scrapeFrame(liveFrame, account.id)
      if (!scraped) return

      if (scraped.hasData) {
        await writeTalkdeskSnapshot(scraped, account.id)
      }

      // Build SLA summary — "A:72% O:85% W:90%" using first letter of LOB name
      const lobSla = scraped.groupKpis
        .filter(g => g.sla && g.sla !== 'N/A')
        .map(g => `${g.group.substring(0,1)}:${g.sla}`)
        .join(' ')

      // Total contacts in queue across all LOBs
      const totalQueue = scraped.groupKpis.reduce(
        (sum, g) => sum + (parseInt(g.contactsInQueue) || 0), 0
      )

      // Push status to terminal dashboard
      upd({
        hasData: scraped.hasData,
        agents:  scraped.agents.length,
        lobs:    scraped.groupKpis.length,
        sla:     lobSla || '--',
        waiting: String(totalQueue),
        logMsg:  scraped.hasData
                   ? `LOBs:${scraped.groupKpis.length} agents:${scraped.agents.length} Q:${totalQueue}`
                   : 'empty scrape'
      })

    } catch (e) {
      err(e.message)
      upd({ hasData: false, error: e.message.substring(0, 40) })
      if (e.message.includes('Target closed') || e.message.includes('page has been closed')) {
        warn('Page crashed — restarting in 5s...')
        await new Promise(r => setTimeout(r, 5000))
        try { await browser.close() } catch (_) {}
        throw e
      }
    }
  }

  // Expose tick for external retry command
  account._tick = tick

  // ── CDP window control setup ─────────────────────────────────────────────
  // Called once after launch to grab CDP session + window ID for minimize/restore
  async function setupCDP(pg, ctx) {
    if (isHeadless) { log('Running headless — CDP window control disabled'); return }
    try {
      _cdp = await ctx.newCDPSession(pg)
      const r = await _cdp.send('Browser.getWindowForTarget')
      _windowId = r.windowId
      log(`CDP ready — window control available (id:${_windowId})`)
    } catch (e) {
      log(`CDP setup failed: ${e.message} — hide/show will use Win32 fallback`)
      _cdp = null
      _windowId = null
    }
  }

  // Expose hide — minimizes + hides from taskbar, no restart, scraping continues
  account._hide = async () => {
    if (isHeadless) { log('Already running headless'); return }
    if (_cdp && _windowId) {
      try {
        await _cdp.send('Browser.setWindowBounds', { windowId: _windowId, bounds: { windowState: 'minimized' } })
      } catch (_) {}
    }
    // Use page title to identify this specific Chrome window
    const title = await page.title().catch(() => '')
    if (title) log(`Window title: "${title}"`)
    const ok = hideWindow(browser, title)
    log(ok
      ? '✅ Hidden from screen and taskbar — scraping continues'
      : '⚠️ Minimized to taskbar (Win32 hide unavailable)')
  }

  // Expose show — restores window from hidden state
  account._show = async () => {
    if (isHeadless) { log('Running headless — relaunch with HEADLESS=false to see browser'); return }
    // Win32 restore first using page title, then CDP unminimize
    const title = await page.title().catch(() => '')
    showWindow(browser, title)
    await new Promise(r => setTimeout(r, 300))
    if (_cdp && _windowId) {
      try { await _cdp.send('Browser.setWindowBounds', { windowId: _windowId, bounds: { windowState: 'normal' } }) } catch (_) {}
    }
    log('✅ Window restored')
  }

  await tick()
  const timer = setInterval(tick, INTERVAL_MS)

  process.on('SIGINT', async () => {
    clearInterval(timer)
    try { await browser.close() } catch (_) {}
  })
}

module.exports = { runTalkdeskAccount }