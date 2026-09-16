// File: scrapers/wyze/index.js
// Zendesk WFM scraper for the Wyze account (wyzelabs.zendesk.com).
//
// Ported from the reference "Wyzelabs ZD Scraper" Chrome extension
// (content.js + autologin.js) — same underlying pattern as scrapers/edenhealth,
// but with a THIRD live page: Chat Monitor. Three pages, scraped every tick,
// all sharing one login session:
//   1. WFM Agent Status page  → the ECE team's agent roster (identical DOM
//      structure to Eden Health — same Zendesk WFM app, virtual-list markup)
//   2. Explore KPI dashboard  → fixed KPI tiles (by CSS class "kpi-queryid-*")
//   3. Chat Monitor page      → card-based live chat metrics (queue/response/
//      duration/agent stats) — a page Eden Health doesn't have
//
// Each page becomes its own Playwright `Page` in the same BrowserContext
// (context.newPage()), so all three share the one login session — no
// separate auth needed for tabs 2/3.
//
// LOGIN: manualLogin (see meta below) — a VISIBLE, persistent-profile browser,
// same as Hippo/ZenBusiness/Eden Health, since Zendesk MFA/2FA can never be
// scripted. Unlike a plain credential auto-retry (which was actively harmful
// here — repeatedly resubmitting credentials against an MFA wall is what got
// this account logged out/flagged in the first place), every login()
// attempt (including the one account-runner.js fires automatically on every
// detected session-cookie expiry, not just a manual restart) first tries
// attemptAutoLogin() below: submitting ONLY email+password, never touching
// MFA. If the persistent Chrome profile's "remember this device" trust is
// still valid, Zendesk skips MFA entirely and this silently recovers the
// session with no human involved — ported from scrapers/edenhealth/index.js,
// which uses this same mechanism to avoid needing `resume edenhealth` on its
// own daily cookie expiry. Only when that attempt still lands back on the
// signin page (trust also expired, a real MFA prompt would appear) does this
// fall back to waiting for a human: log in + complete MFA by hand, then in
// the scraper.js terminal run:
//     resume wyze
// Toggle with `autologin wyze off` if this ever needs to be disabled (falls
// straight back to always-manual, same as before this existed).
// The session is then persisted (sessions/wyze-profile/) so future restarts
// skip the manual step as long as that session (or its device trust) is
// still valid.
//
// EXPLORE KPI DASHBOARD: the reference extension's own EXPLORE_URL was never
// filled in (left as `null` with a TODO to paste the real dashboard URL once
// known) — its KPI_MAP is also empty for the same reason. This scraper mirrors
// that: if `account.exploreUrl` isn't set in config.json, Explore scraping is
// skipped entirely (no page opened, no error) until the URL is added. The KPI
// tile scraper still works with an empty KPI_MAP — the generic "any tile with
// a kpi-queryid-* class" fallback discovers and labels tiles automatically.
//
// config.json entry:
//   {
//     "id": "wyze",
//     "type": "zendesk",
//     "email": "...",
//     "password": "...",
//     "dashboardUrl": "https://wyzelabs.zendesk.com/wfm/v2/agent-status",
//     "chatMonitorUrl": "https://wyzelabs.zendesk.com/chat/agent#monitor",
//     "exploreUrl": ""   // TODO: fill in once the real Explore dashboard URL is known
//   }
//
// Supabase tables needed — see sql/wyze.sql (run once):
//   wyze_agents        — one row per ECE agent (roster + status/duration)
//   wyze_kpis          — one row per Explore KPI tile (label/value/delta)
//   wyze_chat_monitor  — one row per (card, metric) — Chat Monitor's live stats
// ─────────────────────────────────────────────────────────────────────────────

'use strict'

const settings = require('../../lib/settings')

// ── Supabase write helper (same pattern as edenhealth/hippo/zenbusiness) ────
const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL
const SUPABASE_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || process.env.SUPABASE_KEY

async function supabaseUpsert(table, rows) {
  if (!rows || rows.length === 0) return
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${table}`, {
    method:  'POST',
    headers: {
      'apikey':        SUPABASE_KEY,
      'Authorization': `Bearer ${SUPABASE_KEY}`,
      'Content-Type':  'application/json',
      'Prefer':        'resolution=merge-duplicates',
    },
    body: JSON.stringify(rows),
  })
  if (!res.ok) {
    const txt = await res.text().catch(() => '')
    throw new Error(`Supabase ${table} error: ${res.status} ${txt.substring(0, 120)}`)
  }
}

function sanitizeKey(s) {
  return String(s || '').replace(/\s+/g, '_').toLowerCase().replace(/[^a-z0-9_]/g, '')
}

// Postgres rejects the whole upsert batch if the same id appears twice.
function dedupeById(rows) {
  const map = new Map()
  rows.forEach(r => map.set(r.id, r))
  return [...map.values()]
}

// ── Departure detection — delete rows for agents no longer in the roster ─────
// Upsert alone never removes a row, so an agent who logs out with no visible
// "Offline" status to fall into would be left frozen in Supabase forever.
// Tracks the ID set written last tick in memory. The FIRST time a table is
// touched in this process's lifetime, the baseline is seeded from Supabase's
// EXISTING rows for that account instead of an empty set — otherwise a row
// already stale BEFORE this process started would never enter tracking and
// never be recognized as departed. No deletion happens on that seeding call
// itself, since an incomplete first live scrape could otherwise look like a
// mass departure — only ticks after the seed actually delete.
const _lastSeenIds = new Map() // table -> Set<id>

async function fetchExistingIds(table, accountId) {
  try {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/${table}?account_id=eq.${encodeURIComponent(accountId)}&select=id`, {
      headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` }
    })
    if (!res.ok) return new Set()
    const rows = await res.json()
    return new Set(rows.map(r => r.id))
  } catch (e) {
    return new Set()
  }
}

async function pruneDeparted(table, accountId, currentIds) {
  if (!_lastSeenIds.has(table)) {
    const existing = await fetchExistingIds(table, accountId)
    _lastSeenIds.set(table, existing)
    return
  }
  const prevIds = _lastSeenIds.get(table)
  const departed = [...prevIds].filter(id => !currentIds.has(id))
  if (departed.length > 0) {
    const filterValue = `(${departed.map(id => `"${String(id).replace(/"/g, '\\"')}"`).join(',')})`
    const res = await fetch(`${SUPABASE_URL}/rest/v1/${table}?id=in.${encodeURIComponent(filterValue)}`, {
      method: 'DELETE',
      headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` }
    })
    if (!res.ok) {
      const text = await res.text().catch(() => '')
      console.warn(`[prune] delete failed for ${table}: ${res.status} ${text.substring(0, 120)}`)
    } else {
      console.log(`[prune] ${table}: removed ${departed.length} departed agent(s)`)
    }
  }
  _lastSeenIds.set(table, currentIds)
}

// ── Secondary-page cache — one Page per (account, purpose), reused across
// ticks instead of reopened every time. 'explore' and 'chatMonitor' are two
// independent tabs sharing the same login session as the primary WFM page.
const SECONDARY_PAGES = new Map() // `${account.id}:${kind}` -> Page

async function ensureSecondaryPage(context, account, kind, url, readyCheckFn) {
  const key = `${account.id}:${kind}`
  let p = SECONDARY_PAGES.get(key)
  if (p && !p.isClosed()) return p

  p = await context.newPage()
  SECONDARY_PAGES.set(key, p)
  p.on('pageerror', err => console.warn(`[wyze ${kind} page error] ${err.message}`))
  await p.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(e => {
    console.warn(`[wyze] ${kind} goto failed: ${e.message}`)
  })
  if (readyCheckFn) {
    await readyCheckFn(p).catch(() => {
      console.warn(`[wyze] ${kind} content never became ready (will retry next tick)`)
    })
  }
  return p
}

// ── URL helpers ──────────────────────────────────────────────────────────────
function isLoginUrl(url) {
  return /\/auth\/v3\/signin/.test(url || '')
}

// ── Auto-login attempt — email+password only, MFA is never scripted ─────────
// Ported from scrapers/edenhealth/index.js — same underlying Zendesk WFM app,
// same plain signin form (input[type="email"], input[type="password"],
// button[type="submit"]). This is what lets Eden Health recover from a daily
// session-cookie expiry WITHOUT ever falling back to a manual/`resume`
// prompt, as long as the persistent Chrome profile's "remember this device"
// MFA trust is still valid — Wyze never had this, so every cookie expiry
// (roughly once a day) parked it in awaitingLogin limbo until someone ran
// `resume wyze` by hand, even though the same silent-recovery path was
// almost certainly available to it too.
//
// Whether this actually gets us in depends on something we can't see from
// the DOM: whether the persistent Chrome profile's "remember this device"
// MFA trust is still valid even though the plain session cookie expired.
//   - Trust still valid  → submitting these two fields is enough, Zendesk
//     skips straight past MFA, we land on the real dashboard. Returns true.
//   - Trust also expired → an MFA/2FA prompt appears instead (we don't need
//     to know what that looks like) and we never reach the dashboard within
//     the wait below. Returns false — caller falls back to the existing
//     manual/`resume wyze` gate, same as before this existed.
async function attemptAutoLogin(page, account) {
  const tag = `[${account.id}]`
  try {
    const emailField = await page.waitForSelector('input[type="email"]', { timeout: 8000 }).catch(() => null)
    const passwordField = await page.$('input[type="password"]')
    if (!emailField || !passwordField) {
      console.log(`${tag} Auto-login: email/password fields not found (SSO-only login page?) — skipping to manual.`)
      return false
    }

    await emailField.fill(account.email)
    await passwordField.fill(account.password)
    await page.waitForTimeout(300)

    const submitBtn = await page.$('button[type="submit"]')
    if (!submitBtn) return false
    await submitBtn.click()

    // Either we navigate away from the signin URL (trust valid, logged in),
    // or an MFA prompt renders in place / we're bounced back to signin
    // (trust expired) and this just times out — both are handled the same
    // way below by re-checking the URL directly rather than trusting the
    // wait's own success/failure.
    await page.waitForURL(url => !isLoginUrl(url.href), { timeout: 15000 }).catch(() => {})
    await page.waitForTimeout(1000)

    return !isLoginUrl(page.url())
  } catch (e) {
    console.warn(`${tag} Auto-login attempt failed: ${e.message}`)
    return false
  }
}

// ── "By team" dropdown — ported from content.js's selectByTeam() ───────────
// Ant Design's dropdown only opens on mousedown; Playwright's .click() already
// fires a full mousedown/mouseup/click sequence, so a plain click is enough.
async function selectByTeamIfNeeded(page) {
  const current = await page.$('.ant-select-selection-item')
  if (current) {
    const title = await current.getAttribute('title').catch(() => null)
    if (title === 'By team') return // already correct
  }
  const trigger = await page.waitForSelector('.ant-select-selector', { timeout: 10000 }).catch(() => null)
  if (!trigger) return
  await trigger.click()
  const byTeamOption = await page.waitForSelector(
    '.ant-select-dropdown:not(.ant-select-dropdown-hidden) .ant-select-item-option[title="By team"]',
    { timeout: 5000 }
  ).catch(() => null)
  if (byTeamOption) await byTeamOption.click()
}

async function waitForAgentListDom(page, maxMs = 30000) {
  await page.waitForFunction(() => {
    const vList = document.querySelector('.virtual-list')
    return !!(vList && vList.querySelectorAll('li.sc-dkYRCH').length > 0)
  }, { timeout: maxMs })
}

async function waitForExploreDom(page, maxMs = 60000) {
  await page.waitForFunction(
    () => document.querySelectorAll('.kpi-first-measure-value').length >= 3,
    { timeout: maxMs }
  )
}

// Mirrors content.js's waitForChatMonitor() — card shells first, then the
// Response time / Chat duration stacks must each have BOTH values (Longest +
// Average), since React adds Average asynchronously after the card shell.
async function waitForChatMonitorDom(page, maxMs = 60000) {
  await page.waitForFunction(() => {
    const findCard = title => [...document.querySelectorAll('[class*="card___"]')]
      .find(c => c.querySelector('[class*="title___"]')?.innerText.trim() === title)
    const stackValCount = card => card
      ? card.querySelectorAll('[class*="metricStack___"] [class*="value___"]').length
      : 2 // missing card — treat as ready
    if (document.querySelectorAll('[class*="card___"]').length < 3) return false
    return stackValCount(findCard('Response time')) >= 2 && stackValCount(findCard('Chat duration')) >= 2
  }, { timeout: maxMs })
}

// ── ECE roster scrape — identical DOM to Eden Health (same Zendesk WFM app).
// Runs inside page.evaluate() — no access to Node.js scope, so every helper
// is nested inline. The virtual-list only renders visible rows (a custom
// React virtual scroller), so we scroll it through its full range and dedupe
// by agent name.
//
// STATE TRACKING ACROSS SCROLL STEPS — not re-deriving the boundary fresh
// each time. The old approach re-found the "ECE" header row from scratch on
// every scroll step, then walked forward from it. That silently broke the
// moment the ECE header itself scrolled out of the viewport: virtualization
// removes rows outside the render window from the DOM entirely, so once
// scrolled far enough, no h6 with text "ECE" exists anywhere in the DOM any
// more — the search came back empty and every row after the first screenful
// was dropped (confirmed live: capped the roster at ~28 of 104 real ECE
// agents, cutting off around "Helson", never reaching e.g. "Ryan Gajunera").
// Fixed by tracking "am I currently inside the ECE block" as state that
// persists across scroll steps instead — it only needs to have been true
// ONCE (when the header was still rendered), and flips off only when a
// DIFFERENT team's header (e.g. "Foundever") is seen while that state is on.
async function scrapeEceRoster() {
  const TARGET_GROUP = 'ECE'

  // A row is a TEAM HEADER (not an agent) when it has an <h6> but no other
  // detail columns rendered alongside it — just the team name, <=2 lines of
  // text total. Every agent row always has more than that (activity, ticket
  // number, adherence, etc. columns).
  function classifyRow(li) {
    const h6    = li.querySelector('h6')
    const lines = li.innerText.trim().split('\n').map(s => s.trim()).filter(Boolean)
    return { h6Text: h6 ? h6.innerText.trim() : null, isHeader: !!h6 && lines.length <= 2 }
  }

  function parseAgentLi(li) {
    const nameEl = li.querySelector('h6')
    const name   = nameEl ? nameEl.innerText.trim() : ''
    const perf   = li.querySelector('[data-testid="AgentPerformanceContent"]')
    const getCol = id => {
      if (!perf) return ''
      const el = perf.querySelector(`[data-testid="${id}"]`)
      return el ? el.innerText.trim().replace(/\n/g, ' ').trim() : ''
    }
    const badgeEl  = li.querySelector('[data-testid="AgentDetailsColoredTask"]')
    const activity = badgeEl ? badgeEl.innerText.trim() : getCol('ColumnWorkstream')
    return {
      name, activity,
      ticketNumber:      getCol('ColumnTicketId'),
      activityDuration:  getCol('ColumnActivityDuration'),
      adherenceCurrent:  getCol('ColumnAdherenceCurrent'),
      adherenceDuration: getCol('ColumnAdherenceDuration'),
      status:            getCol('ColumnTalkActivity'),
      statusDuration:    getCol('ColumnTalkActivityDuration'),
    }
  }

  function sleep(ms) { return new Promise(r => setTimeout(r, ms)) }

  const vList = document.querySelector('.virtual-list')
  if (!vList) return { agents: [] }

  const agentMap = new Map()
  let insideTarget   = false // currently inside the ECE block (persists across scroll steps)
  let doneWithTarget = false // scrolled past ECE into the next team — stop for good

  const processWindow = () => {
    if (doneWithTarget) return
    const lis = Array.from(vList.querySelectorAll('li.sc-dkYRCH'))
    for (const li of lis) {
      const { h6Text, isHeader } = classifyRow(li)
      if (isHeader) {
        if (h6Text === TARGET_GROUP) {
          insideTarget = true
        } else if (insideTarget) {
          doneWithTarget = true
          insideTarget = false
        }
        continue
      }
      if (insideTarget) {
        const agent = parseAgentLi(li)
        if (agent.name) agentMap.set(agent.name, agent)
      }
    }
  }

  const stepSize = Math.max(vList.clientHeight - 60, 60)
  const savedPos = vList.scrollTop

  vList.scrollTop = 0; await sleep(200); processWindow()
  let lastTop = -1
  while (!doneWithTarget) {
    const atBottom = vList.scrollTop >= vList.scrollHeight - vList.clientHeight - 5
    if (atBottom || vList.scrollTop === lastTop) break
    lastTop = vList.scrollTop
    vList.scrollTop += stepSize
    await sleep(200); processWindow()
  }
  vList.scrollTop = savedPos
  return { agents: Array.from(agentMap.values()) }
}

// ── Explore KPI tiles scrape — ported from content.js's scrapeDashboardKpis().
// KPI_MAP is intentionally empty (same as the reference extension) — Wyze's
// specific tile query-IDs were never catalogued. The generic fallback below
// (any element with a "kpi-queryid-*" class) discovers and labels every tile
// automatically as "(unknown: kpi-queryid-NNNNN)" until real labels are added.
function scrapeExploreKpis() {
  const KPI_MAP = []

  const now = new Date().toISOString()
  const result = [], seen = new Set()

  KPI_MAP.forEach(({ label, queryid }) => {
    seen.add(queryid)
    const el    = document.querySelector('.' + queryid)
    const value = el ? el.innerText.trim() : ''
    let delta = ''
    if (el) {
      const container = el.closest('.kpi-first-measure')?.parentElement
                     || el.parentElement?.parentElement
      if (container) {
        const secondEl  = container.querySelector('.kpi-second-measure')
        const inlineDiv = secondEl?.querySelector('div[style*="inline"]')
        delta = inlineDiv ? inlineDiv.innerText.trim() : (secondEl?.innerText.trim() || '')
      }
    }
    result.push({ label, value, delta, snapshotTime: now })
  })

  document.querySelectorAll('[class*="kpi-queryid-"]').forEach(el => {
    const qid = Array.from(el.classList).find(c => c.startsWith('kpi-queryid-'))
    if (!qid || seen.has(qid)) return
    seen.add(qid)
    let p = el.parentElement, labelEl = null
    for (let i = 0; i < 8; i++) {
      if (!p) break
      labelEl = p.querySelector('span.sc-bdlOLf')
      if (labelEl) break
      p = p.parentElement
    }
    const label = labelEl ? labelEl.innerText.trim() : '(unknown: ' + qid + ')'
    result.push({ label, value: el.innerText.trim(), delta: '', snapshotTime: now })
  })

  return result
}

// ── Chat Monitor scrape — ported from content.js's scrapeChatMonitorKpis().
// Three widget shapes on this page, each parsed differently:
//   singleMetric___  — one big value + a sublabel (Queue total, Missed, ...)
//   metricGrid___    — LABEL then VALUE siblings (Chats per agent, ...)
//   metricStack___   — VALUE then LABEL siblings (Response time, ...)
// Runs inside page.evaluate(). Includes the same up-to-5s wait the extension
// used before every snap, since React briefly removes/re-adds the Average
// value during each of its own refresh cycles.
async function scrapeChatMonitor() {
  function sleep(ms) { return new Promise(r => setTimeout(r, ms)) }

  const findCard = title => [...document.querySelectorAll('[class*="card___"]')]
    .find(c => c.querySelector('[class*="title___"]')?.innerText.trim() === title)
  const valCount = card => card
    ? card.querySelectorAll('[class*="metricStack___"] [class*="value___"]').length
    : 2

  const deadline = Date.now() + 5000
  while (Date.now() < deadline) {
    if (valCount(findCard('Response time')) >= 2 && valCount(findCard('Chat duration')) >= 2) break
    await sleep(200)
  }

  const now = new Date().toISOString()
  const result = []

  document.querySelectorAll('[class*="card___"]').forEach(card => {
    const titleEl = card.querySelector('[class*="title___"]')
    if (!titleEl) return
    const title = titleEl.innerText.trim()
    if (!title) return

    const addRow = (metric, value) =>
      result.push({ snapshotTime: now, card: title, metric, value: value || '-' })

    const singleMetric = card.querySelector('[class*="singleMetric___"]')
    if (singleMetric) {
      const val   = singleMetric.querySelector('[class*="value___"]')?.innerText.trim() || '-'
      const label = singleMetric.querySelector('[class*="label___"]')?.innerText.trim() || 'Value'
      addRow(label, val)
    }

    card.querySelectorAll('[class*="metricGrid___"] > [class*="label___"]').forEach(labelEl => {
      const label  = labelEl.innerText.trim()
      const nextEl = labelEl.nextElementSibling
      const isVal  = nextEl && [...nextEl.classList].some(c => c.includes('value___'))
      const value  = isVal ? nextEl.innerText.trim() : '-'
      if (label) addRow(label, value || '-')
    })

    card.querySelectorAll('[class*="metricStack___"] > [class*="value___"]').forEach(valueEl => {
      const value  = valueEl.innerText.trim()
      const nextEl = valueEl.nextElementSibling
      const isLbl  = nextEl && [...nextEl.classList].some(c => c.includes('label___'))
      if (isLbl) addRow(nextEl.innerText.trim(), value || '-')
    })
  })

  return result
}

// ── Write to Supabase ──────────────────────────────────────────────────────
async function writeWyzeData(data, accountId) {
  const now = new Date().toISOString()

  if (data.kpis && data.kpis.length > 0) {
    const kpiRows = data.kpis.map(k => ({
      id:         `${accountId}:${sanitizeKey(k.label)}`,
      account_id: accountId,
      kpi_key:    sanitizeKey(k.label),
      label:      k.label,
      value:      k.value,
      delta:      k.delta || '',
      updated_at: now,
    }))
    await supabaseUpsert('wyze_kpis', dedupeById(kpiRows))
    console.log(`[wyze] ✅ KPIs written (${kpiRows.length})`)
  }

  if (data.agents && data.agents.length > 0) {
    const agentRows = data.agents.map(a => ({
      id:                 `${accountId}:${a.name}`,
      account_id:         accountId,
      agent_name:         a.name,
      activity:           a.activity,
      ticket_number:      a.ticketNumber,
      activity_duration:  a.activityDuration,
      adherence_current:  a.adherenceCurrent,
      adherence_duration: a.adherenceDuration,
      status:             a.status,
      status_duration:    a.statusDuration,
      updated_at:         now,
    }))
    const dedupedAgentRows = dedupeById(agentRows)
    await pruneDeparted('wyze_agents', accountId, new Set(dedupedAgentRows.map(r => r.id)))
    await supabaseUpsert('wyze_agents', dedupedAgentRows)
    console.log(`[wyze] ✅ Agents written (${agentRows.length})`)
  }

  if (data.chatMonitor && data.chatMonitor.length > 0) {
    const chatRows = data.chatMonitor.map(c => ({
      id:         `${accountId}:${sanitizeKey(c.card)}:${sanitizeKey(c.metric)}`,
      account_id: accountId,
      card:       c.card,
      metric:     c.metric,
      value:      c.value,
      updated_at: now,
    }))
    await supabaseUpsert('wyze_chat_monitor', dedupeById(chatRows))
    console.log(`[wyze] ✅ Chat Monitor written (${chatRows.length})`)
  }
}

// ── Module exports ────────────────────────────────────────────────────────────
module.exports = {
  meta: {
    type:        'zendesk',
    interval:    30000,
    manualLogin: true,   // MFA/2FA now required — see lib/account-runner.js, waits for `resume wyze`
  },

  // ── Login: try auto-login (email+password) first, fall back to manual +
  // wait only if that doesn't get us past MFA. When the persisted session
  // (or the auto-login attempt) lands us on the app, do the normal one-time
  // setup (force to Agent Status, select "By team", open the Chat Monitor/
  // Explore tabs).
  async login(page, context, account, sessionPath) {
    page.on('pageerror', err => console.warn(`[wyze page error] ${err.message}`))

    await page.goto(account.dashboardUrl, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(e => {
      console.warn(`[wyze] goto failed: ${e.message}`)
    })

    // Zendesk's React app sometimes redirects to the signin page via
    // client-side JS AFTER domcontentloaded already resolved above —
    // checking page.url() immediately can still read the pre-redirect
    // agent-status URL and skip auto-login entirely, leaving the page to
    // land on signin on its own a moment later with nothing ever attempted.
    // Give that redirect a beat to happen before deciding where we actually
    // are (ported from scrapers/edenhealth/index.js).
    await page.waitForURL(url => isLoginUrl(url.href), { timeout: 3000 }).catch(() => {})

    if (isLoginUrl(page.url())) {
      if (!settings.isAutoLoginEnabled(account.id)) {
        console.log(`[wyze] Auto-login is OFF for "${account.id}" (autologin ${account.id} off) — waiting for human (resume ${account.id} once done)...`)
        return
      }
      const autoLoggedIn = await attemptAutoLogin(page, account)
      if (!autoLoggedIn) {
        console.log('[wyze] Auto-login did not reach the dashboard (likely an MFA prompt) — waiting for human (resume wyze once done)...')
        return
      }
      console.log('[wyze] ✅ Auto-login succeeded — device still trusted, no MFA prompt this time')
    }

    // Zendesk may land somewhere else post-login (e.g. agent/home) — force
    // it back to the Agent Status page.
    if (!page.url().includes('agent-status')) {
      await page.goto(account.dashboardUrl, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {})
    }

    await waitForAgentListDom(page).catch(e => {
      console.warn(`[wyze] agent list never appeared: ${e.message}`)
    })
    await selectByTeamIfNeeded(page).catch(() => {})

    if (account.chatMonitorUrl) {
      await ensureSecondaryPage(context, account, 'chatMonitor', account.chatMonitorUrl, waitForChatMonitorDom)
    }
    if (account.exploreUrl) {
      await ensureSecondaryPage(context, account, 'explore', account.exploreUrl, waitForExploreDom)
    } else {
      console.log('[wyze] No exploreUrl configured — skipping Explore KPI scraping until it is set in config.json')
    }
  },

  // ── Session-expiry check ───────────────────────────────────────────────────
  isSessionExpired(page) {
    return isLoginUrl(page.url())
  },

  // ── Scrape: ECE roster (primary page) + Chat Monitor + KPI tiles ──────────
  async scrape(page, account) {
    if (isLoginUrl(page.url())) return { hasData: false }

    const snapshotTime = new Date().toISOString()

    // Safety net: `resume wyze` (after a manual MFA login) goes straight to
    // tick()/scrape() without re-running login()'s setup — re-check the
    // "By team" selection here too. Idempotent/cheap (no-op once selected).
    await selectByTeamIfNeeded(page).catch(() => {})

    let agents = []
    try {
      const rosterResult = await page.evaluate(scrapeEceRoster)
      agents = rosterResult?.agents || []
    } catch (err) {
      console.warn(`[wyze] roster scrape failed: ${err.message}`)
    }

    let chatMonitor = []
    if (account.chatMonitorUrl) {
      try {
        const chatPage = await ensureSecondaryPage(page.context(), account, 'chatMonitor', account.chatMonitorUrl, waitForChatMonitorDom)
        if (isLoginUrl(chatPage.url())) {
          await chatPage.goto(account.chatMonitorUrl, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {})
        }
        chatMonitor = await chatPage.evaluate(scrapeChatMonitor)
      } catch (err) {
        console.warn(`[wyze] Chat Monitor scrape failed: ${err.message}`)
      }
    }

    let kpis = []
    if (account.exploreUrl) {
      try {
        const explorePage = await ensureSecondaryPage(page.context(), account, 'explore', account.exploreUrl, waitForExploreDom)
        if (isLoginUrl(explorePage.url())) {
          await explorePage.goto(account.exploreUrl, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {})
        }
        kpis = await explorePage.evaluate(scrapeExploreKpis)
      } catch (err) {
        console.warn(`[wyze] KPI scrape failed: ${err.message}`)
      }
    }

    if (agents.length === 0 && kpis.length === 0 && chatMonitor.length === 0) return { hasData: false }
    return { hasData: true, agents, kpis, chatMonitor, snapshotTime }
  },

  // ── Write to Supabase ──────────────────────────────────────────────────────
  async write(data, accountId) {
    if (!data || !data.hasData) return
    await writeWyzeData(data, accountId)
  },

  // ── Terminal dashboard display ─────────────────────────────────────────────
  getDisplayInfo(data) {
    if (!data) return { sla: '--', waiting: '0', agents: '--', info: '' }
    const findKpi = hint => {
      const row = data.kpis?.find(k => k.label.toLowerCase().includes(hint))
      return row ? row.value : '--'
    }
    const findChat = (card, metric) => {
      const row = data.chatMonitor?.find(c =>
        c.card.toLowerCase().includes(card) && c.metric.toLowerCase().includes(metric))
      return row ? row.value : '--'
    }
    return {
      sla:     findKpi('satisfaction'),
      waiting: findChat('queue', 'chats') !== '--' ? findChat('queue', 'chats') : '0',
      agents:  String(data.agents?.length ?? '--'),
      info:    `${data.agents?.length || 0} ECE agent(s), ${data.kpis?.length || 0} KPI(s), ${data.chatMonitor?.length || 0} chat metric(s)`,
    }
  },
}
