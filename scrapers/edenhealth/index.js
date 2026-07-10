// File: scrapers/edenhealth/index.js
// Zendesk WFM scraper for the Eden Health account (tryeden.zendesk.com).
//
// Ported from the reference "Tryeden ZD Scraper" Chrome extension
// (content.js + autologin.js). Unlike Hippo/ZenBusiness this account needs
// TWO pages scraped every tick, from two different URLs on the same login
// session:
//   1. WFM Agent Status page  → the ECE team's agent roster (virtual-list DOM)
//   2. Explore KPI dashboard  → ~22 fixed KPI tiles (by CSS class "kpi-queryid-*")
//
// The Chrome extension opened these as two separate browser tabs (via
// chrome.windows.create). Here we do the Playwright equivalent: the runner
// gives us one `page` (the WFM Agent Status tab); we open a second `Page` in
// the SAME BrowserContext (context.newPage()) for the Explore tab, so it
// automatically shares the login session — no separate auth needed. The
// second page is cached per-account in EXPLORE_PAGES so we don't reopen it
// every tick.
//
// LOGIN: plain email + password, no MFA/SSO (confirmed against the reference
// extension's autologin.js, which only fills email/password and submits —
// no OTP handling). So this account is fully automated (manualLogin: false),
// unlike Hippo/ZenBusiness.
//
// config.json entry:
//   {
//     "id": "edenhealth",
//     "type": "zendesk",
//     "email": "...",
//     "password": "...",
//     "dashboardUrl": "https://tryeden.zendesk.com/wfm/v2/agent-status",
//     "exploreUrl": "https://tryeden.zendesk.com/explore/studio#/dashboards/precanned/EF77AE5F7483DDB94511D1331779BE9536587AFEB338C08AAA73203D20637876"
//   }
//
// Supabase tables needed — see sql/edenhealth.sql (run once):
//   edenhealth_kpis    — one row per KPI tile (label/value/delta)
//   edenhealth_agents  — one row per ECE agent (roster + status/duration)
// ─────────────────────────────────────────────────────────────────────────────

'use strict'

// ── Supabase write helper (same pattern as hippo/zenbusiness) ──────────────
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
// Tracks the ID set written last tick in memory; anything missing this tick
// gets deleted. First tick after a process restart has no baseline, so it
// never deletes anyone — only real future departures do.
const _lastSeenIds = new Map() // table -> Set<id>

async function pruneDeparted(table, currentIds) {
  const prevIds = _lastSeenIds.get(table) || new Set()
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

// ── Second-page (Explore KPI tab) cache — one Page per account, reused across
// ticks instead of reopened every time. Keyed by account.id in case this
// module is ever reused by more than one account.
const EXPLORE_PAGES = new Map()

async function ensureExplorePage(context, account) {
  let ep = EXPLORE_PAGES.get(account.id)
  if (ep && !ep.isClosed()) return ep

  ep = await context.newPage()
  EXPLORE_PAGES.set(account.id, ep)
  ep.on('pageerror', err => console.warn(`[edenhealth explore page error] ${err.message}`))
  await ep.goto(account.exploreUrl, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(e => {
    console.warn(`[edenhealth] explore goto failed: ${e.message}`)
  })
  await ep.waitForFunction(
    () => document.querySelectorAll('.kpi-first-measure-value').length >= 3,
    { timeout: 60000 }
  ).catch(() => {
    console.warn('[edenhealth] explore KPI tiles never loaded (will retry next tick)')
  })
  return ep
}

// ── URL helpers ──────────────────────────────────────────────────────────────
function isLoginUrl(url) {
  return /\/auth\/v3\/signin/.test(url || '')
}

// ── Login form fill — ported from autologin.js's doAutoLogin() ─────────────
async function fillLoginForm(page, email, password) {
  const emailInput = await page.waitForSelector('input[type="email"]', { timeout: 15000 })
  const passInput  = await page.waitForSelector('input[type="password"]', { timeout: 15000 })
  await emailInput.fill(email)
  await page.waitForTimeout(150)
  await passInput.fill(password)
  await page.waitForTimeout(300)
  const submitBtn = await page.$('button[type="submit"]')
  if (!submitBtn) throw new Error('Submit button not found on Zendesk login page')
  await submitBtn.click()
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

// ── ECE roster scrape — ported from content.js's waitForAgentList/
// findEceAgentLis/parseAgentLi/scrollAndCollectAgents. Runs inside
// page.evaluate() — no access to Node.js scope, so every helper is nested
// inline. The virtual-list only renders visible rows (a custom React virtual
// scroller, same idea as ag-Grid virtualization elsewhere in this codebase),
// so we scroll it through its full range and dedupe by agent name.
async function scrapeEceRoster() {
  const TARGET_GROUP = 'ECE'

  function findEceAgentLis(vList) {
    const allLis = Array.from(vList.querySelectorAll('li.sc-dkYRCH'))
    let eceIdx = -1
    allLis.forEach((li, i) => {
      const h6 = li.querySelector('h6')
      if (h6 && h6.innerText.trim() === TARGET_GROUP) eceIdx = i
    })
    if (eceIdx === -1) return []
    const parentUl = allLis[eceIdx].parentElement
    if (!parentUl) return []
    const siblings = Array.from(parentUl.children)
    const eceUlIdx = siblings.indexOf(allLis[eceIdx])
    const agentLis = []
    for (let i = eceUlIdx + 1; i < siblings.length; i++) {
      const li    = siblings[i]
      const h6    = li.querySelector('h6')
      const lines = li.innerText.trim().split('\n').map(s => s.trim()).filter(Boolean)
      if (h6 && lines.length <= 2) break // next team's header row — stop
      agentLis.push(li)
    }
    return agentLis
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
  const stepSize = Math.max(vList.clientHeight - 60, 60)
  const savedPos = vList.scrollTop
  const addAgents = () => {
    findEceAgentLis(vList).forEach(li => {
      const agent = parseAgentLi(li)
      if (agent.name) agentMap.set(agent.name, agent)
    })
  }
  vList.scrollTop = 0; await sleep(200); addAgents()
  let lastTop = -1
  while (true) {
    const atBottom = vList.scrollTop >= vList.scrollHeight - vList.clientHeight - 5
    if (atBottom || vList.scrollTop === lastTop) break
    lastTop = vList.scrollTop
    vList.scrollTop += stepSize
    await sleep(200); addAgents()
  }
  addAgents()
  vList.scrollTop = savedPos
  return { agents: Array.from(agentMap.values()) }
}

// ── Explore KPI tiles scrape — ported verbatim from content.js's
// scrapeDashboardKpis(). Runs inside page.evaluate().
function scrapeExploreKpis() {
  const KPI_MAP = [
    { label: 'Support - Open tickets (30min)',                  queryid: 'kpi-queryid-102211711' },
    { label: 'Support - New tickets (30min)',                   queryid: 'kpi-queryid-102212181' },
    { label: 'Support - Agents online',                         queryid: 'kpi-queryid-141667301' },
    { label: 'Support - Agents offline',                        queryid: 'kpi-queryid-141667311' },
    { label: 'Voice - Longest wait time in queue (min)',        queryid: 'kpi-queryid-168704211' },
    { label: 'Voice - Average wait time in queue (min)',        queryid: 'kpi-queryid-168704221' },
    { label: 'Messaging - Inactive assigned conversations',     queryid: 'kpi-queryid-172502971' },
    { label: 'Voice - Agents offline',                          queryid: 'kpi-queryid-172508571' },
    { label: 'Messaging - Active conversations in queue',       queryid: 'kpi-queryid-177949621' },
    { label: 'Messaging - Inactive conversations in queue',     queryid: 'kpi-queryid-178387521' },
    { label: 'Messaging - Agents online',                       queryid: 'kpi-queryid-178392891' },
    { label: 'Messaging - Agents away',                         queryid: 'kpi-queryid-178396851' },
    { label: 'Voice - Average wait time (min)',                 queryid: 'kpi-queryid-212650761' },
    { label: 'Messaging - Active assigned conversations',       queryid: 'kpi-queryid-229254411' },
    { label: 'Voice - Calls in queue',                          queryid: 'kpi-queryid-238863341' },
    { label: 'Voice - Ongoing calls',                           queryid: 'kpi-queryid-238863351' },
    { label: 'Voice - Longest wait time (min)',                 queryid: 'kpi-queryid-238863451' },
    { label: 'Support - Solved tickets (30min)',                queryid: 'kpi-queryid-238863491' },
    { label: 'Voice - Callbacks in queue',                      queryid: 'kpi-queryid-239098421' },
    { label: 'Support - Satisfaction (today)',                  queryid: 'kpi-queryid-50103971'  },
    { label: 'Messaging - Satisfaction (today)',                queryid: 'kpi-queryid-52693441'  },
    { label: 'Voice - Agents online',                           queryid: 'kpi-queryid-95262881'  },
  ]

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

  // Catch any new tiles not yet in KPI_MAP (Explore dashboard is user-editable)
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

// ── Write to Supabase ──────────────────────────────────────────────────────
async function writeEdenHealthData(data, accountId) {
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
    await supabaseUpsert('edenhealth_kpis', dedupeById(kpiRows))
    console.log(`[edenhealth] ✅ KPIs written (${kpiRows.length})`)
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
    await pruneDeparted('edenhealth_agents', new Set(dedupedAgentRows.map(r => r.id)))
    await supabaseUpsert('edenhealth_agents', dedupedAgentRows)
    console.log(`[edenhealth] ✅ Agents written (${agentRows.length})`)
  }
}

// ── Module exports ────────────────────────────────────────────────────────────
module.exports = {
  meta: {
    type:        'zendesk',
    interval:    30000,
    manualLogin: false, // plain email/password, no MFA — fully automated
  },

  // ── Login: navigate to the Agent Status page; fill credentials if bounced
  // to the sign-in page. Also opens the Explore KPI tab (same context/session,
  // so no separate auth needed) and selects the "By team" roster view once.
  async login(page, context, account, sessionPath) {
    page.on('pageerror', err => console.warn(`[edenhealth page error] ${err.message}`))

    await page.goto(account.dashboardUrl, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(e => {
      console.warn(`[edenhealth] goto failed: ${e.message}`)
    })

    if (isLoginUrl(page.url())) {
      console.log('[edenhealth] On login page — filling credentials...')
      await fillLoginForm(page, account.email, account.password)
      await page.waitForURL(u => !isLoginUrl(u.toString()), { timeout: 20000 }).catch(() => {})
      await context.storageState({ path: sessionPath }).catch(() => {})
    }

    // Zendesk may land somewhere else post-login (e.g. agent/home) — force
    // it back to the Agent Status page.
    if (!page.url().includes('agent-status')) {
      await page.goto(account.dashboardUrl, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {})
    }

    await waitForAgentListDom(page).catch(e => {
      console.warn(`[edenhealth] agent list never appeared: ${e.message}`)
    })
    await selectByTeamIfNeeded(page).catch(() => {})

    await ensureExplorePage(context, account)
  },

  // ── Session-expiry check ───────────────────────────────────────────────────
  isSessionExpired(page) {
    return isLoginUrl(page.url())
  },

  // ── Scrape: ECE roster (primary page) + KPI tiles (Explore tab) ────────────
  async scrape(page, account) {
    if (isLoginUrl(page.url())) return { hasData: false }

    const snapshotTime = new Date().toISOString()

    let agents = []
    try {
      const rosterResult = await page.evaluate(scrapeEceRoster)
      agents = rosterResult?.agents || []
    } catch (err) {
      console.warn(`[edenhealth] roster scrape failed: ${err.message}`)
    }

    let kpis = []
    try {
      const explorePage = await ensureExplorePage(page.context(), account)
      if (isLoginUrl(explorePage.url())) {
        await explorePage.goto(account.exploreUrl, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {})
      }
      kpis = await explorePage.evaluate(scrapeExploreKpis)
    } catch (err) {
      console.warn(`[edenhealth] KPI scrape failed: ${err.message}`)
    }

    if (agents.length === 0 && kpis.length === 0) return { hasData: false }
    return { hasData: true, agents, kpis, snapshotTime }
  },

  // ── Write to Supabase ──────────────────────────────────────────────────────
  async write(data, accountId) {
    if (!data || !data.hasData) return
    await writeEdenHealthData(data, accountId)
  },

  // ── Terminal dashboard display ─────────────────────────────────────────────
  getDisplayInfo(data) {
    if (!data) return { sla: '--', waiting: '0', agents: '--', info: '' }
    const findKpi = hint => {
      const row = data.kpis?.find(k => k.label.toLowerCase().includes(hint))
      return row ? row.value : '--'
    }
    return {
      sla:     findKpi('satisfaction'),
      waiting: findKpi('calls in queue') !== '--' ? findKpi('calls in queue') : '0',
      agents:  String(data.agents?.length ?? '--'),
      info:    `${data.agents?.length || 0} ECE agent(s), ${data.kpis?.length || 0} KPI(s)`,
    }
  },
}
