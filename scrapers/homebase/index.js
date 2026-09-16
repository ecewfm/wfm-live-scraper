// scrapers/homebase/index.js
// Talkdesk Live Dashboard scraper for Homebase.
// Self-contained — includes login flow, iframe detection, and full DOM scraping.
// Same underlying Talkdesk product as scrapers/ashley-phones (confirmed via a
// live DOM probe: same reporting-live-dashboards-ui iframe, same
// [data-testid="widget-card"]/.co-table__body conventions) — the widget set
// here is different (Contacts in Queue, Longest Wait Time, Live Contacts In
// Queue, Service Level, Abandon Rate, Live Agents List, Contacts List), so
// the scrape logic is new.
//
// LOGIN: manualLogin (see meta below) — same reasoning as edenhealth/wyze.
// Homebase's Talkdesk tenant is Okta SSO-gated, not Talkdesk's own native
// credential form, so it can't be scripted the way ashley-phones is. This
// opens a visible browser, leaves the whole login flow (Okta and anything
// after it) to a human, and only starts ticking once `resume homebase` is
// run. Uses a persistent Chrome profile (see lib/browser.js/account-runner.js)
// so Okta's session — once established — should survive restarts instead of
// needing to be redone every time.

'use strict'

const { writeHomebaseSnapshot } = require('../../lib/db-homebase')

const LIVE_URL = 'https://homebase.mytalkdesk.com/atlas/apps/live'

// ── IdleDetector mock — prevents "Device usage" permission wall ───────────────
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

// Anywhere other than the live dashboard itself counts as "not logged in" —
// deliberately broad rather than checking for a specific Okta/Talkdesk login
// domain, since the exact login domain(s)/step count are whatever Okta's SSO
// flow happens to redirect through and aren't ours to predict or script.
function isLoginUrl(url) {
  return !/homebase\.mytalkdesk\.com/.test(url || '')
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

// ── Find the live dashboard iframe ────────────────────────────────────────────
// Talkdesk embeds the live dashboard inside an iframe from prd-cdn-talkdesk.talkdesk.com
// (reporting-live-dashboards-ui) — confirmed identical to ashley-phones via probe.
async function getLiveFrame(page, accountId) {
  const tag = `[${accountId}]`

  console.log(`${tag} Waiting for live dashboard iframe...`)
  await page.waitForSelector('iframe.app-module__iframe', { timeout: 60000 })
    .catch(() => console.warn(`${tag} iframe.app-module__iframe not found — will search frames anyway`))

  for (let attempt = 0; attempt < 30; attempt++) {
    for (const frame of page.frames()) {
      const frameUrl = frame.url()
      if (!frameUrl.includes('prd-cdn-talkdesk') && !frameUrl.includes('reporting-live-dashboards')) continue

      const hasContent = await frame.evaluate(() => !!document.querySelector('[data-testid="widget-card"]')).catch(() => false)
      if (hasContent) {
        console.log(`${tag} Live frame found: ${frameUrl.substring(0, 80)}`)
        return frame
      }
    }
    await page.waitForTimeout(1500)
  }

  console.warn(`${tag} Could not find live dashboard frame after 45s`)
  return null
}

// ── Core scrape — runs inside the live iframe ─────────────────────────────────
async function scrapeFrame(frame, accountId) {
  const tag = `[${accountId}]`

  // Scroll all overflow containers to expose virtual-scroll rows (same trick
  // ashley-phones uses — Talkdesk tables lazily render rows on scroll)
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

  const result = await frame.evaluate(async () => {
    const sleep = ms => new Promise(r => setTimeout(r, ms))
    const txt   = el => (el ? (el.innerText || el.textContent || '').trim() : '')

    const widgets = Array.from(document.querySelectorAll('[data-testid="widget-card"]'))

    // ── Widget title → first non-empty text line ──────────────────────────
    function widgetTitle(el) {
      const lines = txt(el).split('\n').map(l => l.trim()).filter(Boolean)
      return lines[0] || ''
    }

    // ── Single-value widgets (no table inside) ─────────────────────────────
    // "Contacts in Queue": number + a threshold line ("≤ 9")
    // "Service Level" / "Abandon Rate": a percentage
    // "Longest Wait Time" (aggregate variant — the per-queue TABLE variant
    // sharing this same title is skipped here via the hasTable check below)
    function scrapeSingleValueWidgets() {
      const out = { contactsInQueue: null, contactsInQueueThreshold: null, serviceLevel: null, abandonRate: null, longestWaitTime: null }

      widgets.forEach(w => {
        const hasTable = !!w.querySelector('.co-table__body, table, [role="rowgroup"]')
        const title = widgetTitle(w)
        const lines = txt(w).split('\n').map(l => l.trim()).filter(Boolean)

        if (/^contacts in queue$/i.test(title) && !hasTable) {
          const num = lines.find((l, i) => i > 0 && /^\d+$/.test(l))
          const threshold = lines.find(l => /^[≤≥<>]\s*\d+$/.test(l))
          out.contactsInQueue = num || null
          out.contactsInQueueThreshold = threshold || null
        }
        if (/^service level$/i.test(title)) {
          const pct = lines.find(l => /^\d+(\.\d+)?%$/.test(l))
          out.serviceLevel = pct || null
        }
        if (/^abandon rate$/i.test(title)) {
          const pct = lines.find(l => /^\d+(\.\d+)?%$/.test(l))
          out.abandonRate = pct || null
        }
        if (/^longest wait time$/i.test(title) && !hasTable) {
          // "Ø" = no active wait (nothing in queue) — kept as-is rather than
          // coerced to 0, since it's a distinct "no data" state, not a real zero.
          const val = lines.find((l, i) => i > 0 && (l === 'Ø' || /^\d+:\d+(:\d+)?$/.test(l)))
          out.longestWaitTime = val || null
        }
      })

      return out
    }

    // ── Per-queue breakdown tables (Live Contacts In Queue, and the
    // per-queue variant of Longest Wait Time) — both are "Queue | Value"
    // two-column tables sharing the same queue list. ───────────────────────
    function scrapeQueueTable(widgetTitleMatch) {
      const widget = widgets.find(w => {
        const hasTable = !!w.querySelector('.co-table__body, table, [role="rowgroup"]')
        return hasTable && widgetTitleMatch.test(widgetTitle(w))
      })
      if (!widget) return []

      const rows = Array.from(widget.querySelectorAll('.co-table__row, tr, [role="row"]'))
      const out = []
      rows.forEach(row => {
        const cells = Array.from(row.querySelectorAll('p, span, td')).map(c => txt(c)).filter(Boolean)
        if (cells.length < 2) return
        const [queue, value] = cells
        if (!queue || /^(queue|value)$/i.test(queue)) return // skip header row
        out.push({ queue, value })
      })
      return out
    }

    // ── Live Agents List — confirmed via a live DOM probe. Each row is a
    // fixed, deterministic SEQUENCE of leaf elements in this order:
    //   <a> agent name
    //   N x <span class="co-chip..."> queue chips, the LAST of which is
    //     always the "co-chip--alternate" overflow badge (N varies per row —
    //     Talkdesk shows however many named queues fit before the "+N" badge)
    //   <div class="co-placeholder..."> (queues overflow placeholder)
    //   <input> (row select checkbox)
    //   <i> status bullet icon
    //   <p> status text
    //   3x { <i> channel icon, <span> sr-only, <p> count } for call/chat/email
    //   <span class="co-chip..."> channels overflow badge (constant "+N")
    //   <div class="co-placeholder..."> (channels overflow placeholder)
    //   <p> occupancy ("51/100")
    //   <progress> occupancy bar (no text)
    //   <span> time in status
    //   <i> + <span> "..." actions menu (ignored)
    // Walked positionally rather than via fixed array indices since the
    // queue-chip count varies row to row — everything after it stays fixed.
    function scrapeAgentsList() {
      const widget = widgets.find(w => w.querySelector('.co-table__body, table, [role="rowgroup"]') && /^live agents list$/i.test(widgetTitle(w)))
      if (!widget) return []

      const rows = Array.from(widget.querySelectorAll('.co-table__row, tr, [role="row"]'))
      const out = []

      rows.forEach(row => {
        const leaves = Array.from(row.querySelectorAll('*')).filter(el => el.children.length === 0)
        let i = 0
        const peek = () => leaves[i]
        const next = () => leaves[i++]
        const isChip = el => el && el.tagName === 'SPAN' && el.className.includes('co-chip')
        const isPlaceholder = el => el && el.className && el.className.includes('co-placeholder')

        if (!peek() || peek().tagName !== 'A') return // header row (no agent link) — skip
        const name = txt(next())

        const queues = []
        while (isChip(peek())) {
          const chip = next()
          queues.push(txt(chip))
          if (chip.className.includes('co-chip--alternate')) break
        }
        if (isPlaceholder(peek())) next() // queues overflow placeholder

        if (peek() && peek().tagName === 'INPUT') next()
        if (peek() && peek().tagName === 'I') next() // status bullet icon
        const status = peek() && peek().tagName === 'P' ? txt(next()) : ''

        const channelCounts = {}
        ;['call', 'textsms', 'email'].forEach(key => {
          if (peek() && peek().tagName === 'I') next()   // channel icon
          if (peek() && peek().tagName === 'SPAN') next() // sr-only span
          channelCounts[key] = peek() && peek().tagName === 'P' ? txt(next()) : '0'
        })

        if (isChip(peek())) next()        // channels overflow badge
        if (isPlaceholder(peek())) next()  // channels overflow placeholder

        const occupancy = peek() && peek().tagName === 'P' ? txt(next()) : ''
        if (peek() && peek().tagName === 'PROGRESS') next() // occupancy bar, no useful text

        const timeInStatus = peek() && peek().tagName === 'SPAN' ? txt(next()) : ''

        out.push({
          name,
          queues,
          status,
          channels: `call:${channelCounts.call} chat:${channelCounts.textsms} email:${channelCounts.email}`,
          occupancy,
          timeInStatus,
        })
      })

      return out
    }

    // ── Contacts List — same positional-walk approach, confirmed via probe.
    // Fixed sequence per row:
    //   <p> status, <p> agent, <p> contact info   (always exactly these 3)
    //   N x <span class="co-chip..."> Queues chips (last = overflow badge,
    //     N can be 0 — some rows show only the overflow badge, or none at all)
    //   <div class="co-placeholder..."> (Queues overflow placeholder)
    //   M x <span class="co-chip..."> Live queues chips (same pattern, M can be 0)
    //   <div class="co-placeholder..."> (Live queues overflow placeholder)
    //   <span> Duration (bare, no class)
    //   EITHER <span> Hold Time (bare, if actually on hold)
    //       OR <p class="co--truncate">"Ø"</p> (if not on hold)
    //   EITHER <i> checkmark icon (Callback enabled)
    //       OR <div> empty cell (Callback not enabled)
    //   <i> + <span> "..." actions menu (ignored)
    function scrapeContactsList() {
      const widget = widgets.find(w => w.querySelector('.co-table__body, table, [role="rowgroup"]') && /^contacts list$/i.test(widgetTitle(w)))
      if (!widget) return []

      const rows = Array.from(widget.querySelectorAll('.co-table__row, tr, [role="row"]'))
      const out = []

      rows.forEach(row => {
        const leaves = Array.from(row.querySelectorAll('*')).filter(el => el.children.length === 0)
        let i = 0
        const peek = () => leaves[i]
        const next = () => leaves[i++]
        const isChip = el => el && el.tagName === 'SPAN' && el.className.includes('co-chip')
        const isPlaceholder = el => el && el.className && el.className.includes('co-placeholder')

        if (!peek() || peek().tagName !== 'P') return // header row (no leading <p>) — skip
        const status = txt(next())
        if (!peek() || peek().tagName !== 'P') return
        const agent = txt(next())
        if (!peek() || peek().tagName !== 'P') return
        const contactInfo = txt(next())

        const queueChips = []
        while (isChip(peek())) {
          const chip = next()
          queueChips.push(txt(chip))
          if (chip.className.includes('co-chip--alternate')) break
        }
        if (isPlaceholder(peek())) next()

        const liveQueueChips = []
        while (isChip(peek())) {
          const chip = next()
          liveQueueChips.push(txt(chip))
          if (chip.className.includes('co-chip--alternate')) break
        }
        if (isPlaceholder(peek())) next()

        const duration = peek() && peek().tagName === 'SPAN' ? txt(next()) : ''
        // Hold Time: a bare span (real value) or a <p> reading "Ø" (none)
        const holdTime = peek() ? txt(next()) : ''
        // Callback: an <i> checkmark icon (enabled) or an empty <div> (not)
        const callbackEl = peek()
        // Explicit 'Yes'/'No' string, not a boolean — the writer stores this
        // in a text column, and `false || null` would otherwise silently
        // collapse "no callback" into null instead of a real value.
        const callback = callbackEl && callbackEl.tagName === 'I' ? 'Yes' : 'No'
        if (callbackEl) next()

        out.push({
          status, agent, contactInfo,
          queues:     queueChips.join(', '),
          liveQueues: liveQueueChips.join(', '),
          duration, holdTime, callback,
        })
      })

      return out
    }

    const singleValues = scrapeSingleValueWidgets()
    const liveContactsInQueue = scrapeQueueTable(/^live contacts in queue$/i)
    const longestWaitByQueue  = scrapeQueueTable(/^longest wait time$/i)
    const agents   = scrapeAgentsList()
    const contacts = scrapeContactsList()

    return {
      ...singleValues,
      liveContactsInQueue,
      longestWaitByQueue,
      agents,
      contacts,
      hasData: Object.values(singleValues).some(v => v != null) || liveContactsInQueue.length > 0,
    }
  })

  return result
}

// ── Module state (cleared on reload via require cache bust) ───────────────────
const _state = {}  // accountId → { liveFrame }

module.exports = {
  meta: {
    type:        'Talkdesk',
    interval:    30000,
    manualLogin: true,   // Okta SSO — see file header. Waits for `resume homebase`.
  },

  // ── Login: manual — navigate and wait for the human when not already on
  // the live dashboard (Okta SSO can't be scripted). When the persisted
  // (persistent-profile) session is still valid, this lands straight on the
  // live dashboard and proceeds straight to finding the iframe, same as any
  // other restart.
  async login(page, context, account, sessionPath) {
    await context.addInitScript(IDLE_DETECTOR_MOCK)
    page.on('console', () => {})
    page.on('pageerror', () => {})

    console.log(`[${account.id}] Navigating to Homebase live dashboard...`)
    await page.goto(LIVE_URL, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(e => {
      console.warn(`[${account.id}] goto failed: ${e.message}`)
    })
    await page.waitForTimeout(1500)

    if (isLoginUrl(page.url())) {
      console.log(`[${account.id}] Not authenticated — manual Okta login required. Waiting for human (resume homebase once done)...`)
      return
    }

    await _handleDeviceUsagePage(page, `[${account.id}]`)

    const liveFrame = await getLiveFrame(page, account.id)
    _state[account.id] = { liveFrame }
    if (!liveFrame) throw new Error('Could not find live dashboard iframe after login')
  },

  isSessionExpired(page) {
    return isLoginUrl(page.url())
  },

  async scrape(page, account) {
    let { liveFrame } = _state[account.id] || {}
    if (!liveFrame || liveFrame.isDetached()) {
      liveFrame = await getLiveFrame(page, account.id)
      if (!liveFrame) return null
      _state[account.id] = { liveFrame }
    }
    return await scrapeFrame(liveFrame, account.id)
  },

  async write(data, accountId) {
    if (data && data.hasData) await writeHomebaseSnapshot(data, accountId)
  },

  getDisplayInfo(data) {
    return {
      sla:     data.serviceLevel || '--',
      waiting: data.contactsInQueue || '0',
      agents:  String(Array.isArray(data.agents) ? data.agents.length : '--'),
      info:    data.abandonRate ? `ABN:${data.abandonRate}` : '',
    }
  }
}
