// File: scrapers/ashleychat/index.js
// LivePerson Manager Workspace scraper for Ashley Furniture's CHAT account
// (account id deliberately "ashleychat", no dash, per explicit instruction —
// distinct from the existing "ashley-phones" Talkdesk account in this same
// config.json, a completely different CRM/data source).
//
// DIRECT PORT of chrome extension scrapers old/ashley-chat-extension/ — the
// user's explicit requirement was "100% same in function", so every DOM
// selector and every login step below is copied verbatim from that
// extension's background.js (scrapeLivePerson()) and autologin.js, with NO
// selector changes. The only differences from the original: this writes to
// Supabase instead of Google Drive CSVs, and runs as a Playwright-driven
// node scraper instead of a content-script+background-worker extension.
//
// LOGIN (ported from autologin.js) — two screens, in order:
//   1. "Account Number" screen — detected via a `?accountId=` query param on
//      the URL, OR hostname === 'authentication.liveperson.net', OR presence
//      of #siteNumber/input[name="siteNumber"]. The extension's own comment
//      says "DO NOT TOUCH" — it does NOT type anything here; LivePerson's
//      own page JS reads the URL's accountId param and autofills this field
//      on its own. We only WAIT for that value to appear (or the CSS
//      :autofill pseudo-class to match), then press Enter — exactly what
//      the original does. This means account.dashboardUrl MUST already
//      contain the correct `?accountId=...` query param for this to work.
//   2. "Credentials" screen — #proxy-username (preferred over the hidden
//      shadow #username field) + #password. Original types char-by-char
//      with realistic keydown/keypress/input/keyup events and an 18ms
//      per-character delay — Playwright's own page.type()/type() option
//      already does exactly this at the CDP level (more genuinely "trusted"
//      than synthetic dispatchEvent(), if anything), so that's used here
//      instead of hand-reimplementing typeIntoField(). Submit via
//      button[data-action-button-primary="true"] → button[type="submit"]
//      → .submitButton → Enter on the password field, same fallback order
//      as the original.
//
// NOT YET LIVE-TESTED — this account's actual dashboardUrl/credentials were
// never available while writing this port (see chat history); every
// selector below is exactly what the working chrome extension used, but
// this has not been run against a real login yet. Revisit once
// config.json's ashleychat entry has real values and a first `start
// ashleychat` has been observed.
//
// config.json entry needed (dashboardUrl MUST include the real ?accountId=
// query param — see above):
//   {
//     "id": "ashleychat",
//     "type": "liveperson",
//     "username": "",
//     "password": "",
//     "dashboardUrl": "https://z1.le.liveperson.net/hc/<REST_OF_REAL_PATH>?accountId=<REAL_ACCOUNT_ID>"
//   }
//
// Supabase tables needed — see sql/ashleychat.sql (run once):
//   ashleychat_activity_summary — one row (the Activity Summary metrics)
//   ashleychat_queue_summary    — one row per skill (the in-queue widget)
//   ashleychat_agents           — one row per agent
//   ashleychat_conversations    — one row per live conversation
// ─────────────────────────────────────────────────────────────────────────────

'use strict'

// ── Supabase write helper (same pattern as every other scraper here) ───────
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

function dedupeById(rows) {
  const map = new Map()
  rows.forEach(r => map.set(r.id, r))
  return [...map.values()]
}

// ── Departure detection — same seed-then-diff pattern as every other
// scraper's pruneDeparted (see scrapers/flex/index.js for the full
// reasoning). Generalized across tables via a Map keyed by table name.
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
      console.log(`[prune] ${table}: removed ${departed.length} departed row(s)`)
    }
  }
  _lastSeenIds.set(table, currentIds)
}

function sanitizeKey(label) {
  return String(label || '').trim().toLowerCase().replace(/\s+/g, '_').replace(/[^a-z0-9_]/g, '')
}

// ── URL helpers ──────────────────────────────────────────────────────────────
// Login lives on a DIFFERENT hostname (authentication.liveperson.net /
// auth-z1.liveperson.net) than the real dashboard (*.le.liveperson.net) — see
// manifest.json's host_permissions in the original extension. Broad match on
// the dashboard's own hostname pattern, not a fixed "z1" shard, since a
// different account could sit on a different LivePerson data-center shard.
function isLoginUrl(url) {
  return !/\.le\.liveperson\.net\//.test(url || '')
}

// ── Login: Screen 1 — "Account Number" — DO NOT TYPE, only wait + Enter.
// Ported verbatim from autologin.js's handleAccountScreen(): LivePerson's own
// page JS autofills this field from the URL's ?accountId= query param; we
// just poll for that to happen (or the :autofill/:-webkit-autofill CSS
// pseudo-class to match) then press Enter — never type a value ourselves.
async function handleAccountScreen(page) {
  const field = await page.waitForSelector(
    '#siteNumber, input[name="siteNumber"], input[type="text"], input[type="number"]',
    { timeout: 15000 }
  ).catch(() => null)
  if (!field) { console.warn('[ashleychat] Account field never appeared'); return false }

  const deadline = Date.now() + 18000 // 60 attempts * 300ms in the original
  while (Date.now() < deadline) {
    const ready = await field.evaluate(el => {
      const d = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')
      const val = d && d.get ? d.get.call(el) : el.value
      let autofilled = false
      try { autofilled = el.matches(':-webkit-autofill') || el.matches(':autofill') } catch (e) {}
      return !!(val && val.trim()) || autofilled
    }).catch(() => false)
    if (ready) break
    await page.waitForTimeout(300)
  }
  await page.waitForTimeout(800) // same 800ms pause as the original before Enter
  await field.press('Enter').catch(() => {})
  return true
}

// ── Login: Screen 2 — "Credentials" — type username, Tab, type password,
// click submit. Ported from autologin.js's handleCredentialScreen() +
// doCredentialLogin(). Playwright's own type() already sends realistic
// per-character keydown/keypress/input/keyup events, same effect as the
// original's hand-built typeIntoField() with an 18ms per-char delay.
async function handleCredentialScreen(page, account) {
  const passwordField = await page.waitForSelector(
    '#password, input[type="password"]', { timeout: 15000 }
  ).catch(() => null)
  if (!passwordField) { console.warn('[ashleychat] Password field never appeared'); return false }

  // Prefer #proxy-username (the visible field) over #username (hidden shadow
  // field) — same preference order as the original.
  const usernameField =
    await page.$('#proxy-username') ||
    await page.$('input[autocomplete="username"]:not([style*="display"])') ||
    await page.$('input[type="email"]') ||
    await page.$('input[name="username"]:not([style*="display"])') ||
    (await page.$$('input[type="text"]').then(async els => {
      for (const el of els) { if (await el.isVisible()) return el }
      return null
    })) ||
    await page.$('#username')
  if (!usernameField) { console.warn('[ashleychat] Username field never appeared'); return false }

  const username = account.username || account.email || ''
  const password = account.password || ''
  if (!username || !password) throw new Error('LivePerson username/password not set in config.json')

  await usernameField.type(username, { delay: 18 })
  await page.waitForTimeout(200)
  await usernameField.press('Tab')
  await page.waitForTimeout(300)
  await passwordField.type(password, { delay: 18 })
  await page.waitForTimeout(400)

  const submitBtn =
    await page.$('button[data-action-button-primary="true"]') ||
    await page.$('button[type="submit"]') ||
    await page.$('.submitButton')
  if (submitBtn) {
    await submitBtn.click()
  } else {
    await passwordField.press('Enter')
  }
  return true
}

// ── Full login flow — repeats the screen-detection loop since the original
// content script also just re-evaluates on every navigation via its own
// route observer, rather than assuming a fixed number of steps.
const LOGIN_TIMEOUT = 60000

async function handleLivePersonLogin(page, account) {
  const deadline = Date.now() + LOGIN_TIMEOUT
  let pass = 0
  while (Date.now() < deadline) {
    pass++
    const url = page.url()
    console.log(`[ashleychat login] pass=${pass} url=${url.substring(0, 100)}`)

    if (!isLoginUrl(url)) {
      console.log('[ashleychat login] ✅ Reached dashboard — login complete')
      return
    }

    const isAccountScreen = await page.evaluate(() => {
      return new URLSearchParams(location.search).has('accountId') ||
             location.hostname === 'authentication.liveperson.net' ||
             !!document.querySelector('#siteNumber') ||
             !!document.querySelector('input[name="siteNumber"]')
    }).catch(() => false)

    if (isAccountScreen) {
      await handleAccountScreen(page)
    } else {
      await handleCredentialScreen(page, account)
    }
    await page.waitForTimeout(1500)
  }
  throw new Error(`LivePerson login timed out after ${LOGIN_TIMEOUT / 1000}s`)
}

// ── Scrape — ported VERBATIM from background.js's scrapeLivePerson(), which
// ran via chrome.scripting.executeScript in the page context. Runs inside
// page.evaluate() here instead; every selector/field below is unchanged.
function scrapeLivePerson() {
  const txt = el => (el ? (el.innerText || el.textContent || '').trim() : '')

  const result = {
    activitySummary: {},
    queueSummary:    [],
    agents:          [],
    conversations:   [],
    snapshotTime:    new Date().toISOString()
  }

  // ── Activity Summary ─────────────────────────────────────────────────────
  const metricMap = {
    openAssignedConversations:  'Assigned',
    weightedAvgLoad:            'Load',
    totalResolvedConversations: 'Closed',
    csat:                       'CSAT',
    avgWaitTimeFirstResponse:   'First Response Time',
    avgWaitTime:                'Response Time',
    avgConversationsDuration:   'Resolution Time'
  }

  Object.entries(metricMap).forEach(([key, label]) => {
    const el = document.querySelector(`[data-test="shift_status.metric_${key}"]`)
    if (!el) return

    const valueEl =
      el.querySelector('.metric-value-number') ||
      el.querySelector('[class*="metric-value"]') ||
      el.querySelector('[class*="value-number"]') ||
      el.querySelector('.value')

    if (valueEl) {
      result.activitySummary[label] = txt(valueEl).replace(/\s+/g, ' ')
    } else {
      const fullText = txt(el)
      const lines = fullText.split('\n').map(l => l.trim()).filter(l => l.length > 0)
      const labelIdx = lines.findIndex(l => l.toUpperCase() === label.toUpperCase())
      if (labelIdx >= 0 && lines[labelIdx + 1]) {
        result.activitySummary[label] = lines.slice(labelIdx + 1).join(' ').trim()
      } else if (lines.length > 1) {
        result.activitySummary[label] = lines.slice(1).join(' ').trim()
      }
    }
  })

  // Sub-metrics
  const subMetrics = {
    extension_overdueConversationsAssigned:              'Overdue Assigned',
    extension_humanOnlineLoad:                           'Online Load',
    extension_humanAwayLoad:                             'Away Load',
    extension_closedByAgent:                             'Closed By Agent',
    extension_closedByConsumer:                          'Closed By Consumer',
    extension_autoClosed:                                'Auto Closed',
    extension_avgTimeToFirstResponseFirstAssignment:     'First Response From Assignment',
    extension_avgTimeToResponse:                         'Response From Assignment'
  }

  Object.entries(subMetrics).forEach(([key, label]) => {
    const el = document.querySelector(`[data-test="shift_status.metric_${key}"]`)
    if (!el) return
    const fullText = txt(el).replace(/\s+/g, ' ').trim()
    if (fullText) result.activitySummary[label] = fullText
  })

  // ── Queue Summary ────────────────────────────────────────────────────────
  const queueWidget = document.querySelector('article.in-queue')
  if (queueWidget) {
    const tableBody = queueWidget.querySelector(
      '[class*="table-body"], [class*="tableBody"], tbody, [class*="skills-list"], [class*="skillsList"]'
    )

    if (tableBody) {
      const rows = tableBody.querySelectorAll(
        '[class*="table-row"],[class*="tableRow"],[class*="skill-row"],[class*="skillRow"],tr'
      )
      rows.forEach(row => {
        const cells = row.querySelectorAll(
          '[class*="table-cell"],[class*="tableCell"],[class*="cell"],td'
        )
        if (cells.length >= 2) {
          const skillName = txt(cells[0])
          const inQueue   = txt(cells[1])
          const waitTime  = cells[2] ? txt(cells[2]) : ''
          if (skillName && skillName.length > 1 && !/^SKILL$/i.test(skillName)) {
            result.queueSummary.push({ skill: skillName, inQueue, waitTime })
          }
        }
      })
    }

    if (result.queueSummary.length === 0) {
      const lines = txt(queueWidget)
        .split('\n')
        .map(l => l.replace(/\t/g, '|').trim())
        .filter(l => l.length > 0)

      let inTable = false
      for (let i = 0; i < lines.length; i++) {
        const l = lines[i]
        if (/^SKILL/i.test(l)) { inTable = true; continue }
        if (!inTable) continue
        const parts = l.split('|').map(p => p.trim()).filter(p => p.length > 0)
        if (parts.length >= 2 && !/^\d+-\d+/.test(parts[0]) && !/^(IN QUEUE|WAIT TIME)/i.test(parts[0])) {
          result.queueSummary.push({
            skill:    parts[0],
            inQueue:  parts[1] || '0',
            waitTime: parts[2] || ''
          })
        }
      }
    }
  }

  // ── Agents Table ─────────────────────────────────────────────────────────
  const agentNameCells = Array.from(
    document.querySelectorAll('[data-test*="agentName_content"]')
  )

  agentNameCells.forEach(nameEl => {
    const dtVal = nameEl.getAttribute('data-test') || ''
    const match = dtVal.match(/agents\.data_(\d+)_agentName_content/)
    if (!match) return
    const agentId = match[1]

    const get = field => {
      const statusVal = document.querySelector(
        `[data-test="agents.data_${agentId}_${field}_status_value"]`
      )
      if (statusVal) return txt(statusVal)
      const plainVal = document.querySelector(
        `[data-test="agents.data_${agentId}_${field}_value"]`
      )
      if (plainVal) return txt(plainVal)
      const content = document.querySelector(
        `[data-test="agents.data_${agentId}_${field}_content"]`
      )
      if (content) {
        const directText = Array.from(content.childNodes)
          .filter(n => n.nodeType === 3)
          .map(n => n.textContent.trim())
          .join('')
        return directText || txt(content).split('\n')[0]
      }
      return ''
    }

    const skillsEl = document.querySelector(
      `[data-test="agents.data_${agentId}_agentSkills_values"]`
    )
    const skills = skillsEl
      ? Array.from(skillsEl.querySelectorAll('span, [class*="tag"], [class*="chip"], [class*="skill"]'))
          .map(s => txt(s).trim())
          .filter(s => s.length > 0 && !/^\+\d+$/.test(s))
      : []
    if (skills.length === 0 && skillsEl) {
      const raw = txt(skillsEl)
      if (raw) skills.push(...raw.split('\n').map(l => l.trim()).filter(l => l && !/^\+\d+$/.test(l)))
    }

    const agentName = txt(nameEl).split('\n')[0].trim()
    if (!agentName || agentName.length < 2) return

    result.agents.push({
      name:           agentName,
      status:         get('agentCurrentStatus'),
      statusDuration: get('agentCurrentStatusReasonStartTime'),
      group:          get('agentGroupName'),
      activeConvs:    get('activeConversations'),
      assignedConvs:  get('assignedConversations'),
      closedConvs:    get('closedConversations'),
      load:           get('agentLoad'),
      onlineRate:     get('onlineRate'),
      csat:           get('csat'),
      maxSlots:       get('maxSlots'),
      transfers:      get('transfers'),
      transferRate:   get('transferRate'),
      skills:         skills
    })
  })

  // ── Conversations Table ───────────────────────────────────────────────────
  try {
    const convWidget = document.querySelector('[data-test="conversations.widget"]')
    if (convWidget) {
      const allConvEls = Array.from(
        convWidget.querySelectorAll('[data-test^="conversations.column_visitorName_"]')
      )

      const rowEls = allConvEls.filter(el =>
        el.getAttribute('data-test').endsWith('_content')
      )

      rowEls.forEach(visitorEl => {
        const dt      = visitorEl.getAttribute('data-test') || ''
        const idMatch = dt.match(/conversations\.column_visitorName_(\d+)_content/)
        if (!idMatch) return
        const agentId = idMatch[1]

        const rowContainer = visitorEl.closest(
          '[class*="table-row"], [class*="tableRow"], [class*="row"], tr, li'
        ) || visitorEl.parentElement

        const getField = (field) => {
          const contentSel = `[data-test="conversations.column_${field}_${agentId}_content"]`
          let el = rowContainer ? rowContainer.querySelector(contentSel) : null
          if (el) return txt(el)
          const allMatching = Array.from(
            document.querySelectorAll(contentSel)
          )
          if (allMatching.length === 1) return txt(allMatching[0])
          for (const m of allMatching) {
            if (visitorEl.closest('[class*="widget"]') === m.closest('[class*="widget"]')) {
              return txt(m)
            }
          }
          return ''
        }

        const getStatusOrType = (field) => {
          const sel = `[data-test="conversations.column_${field}_${agentId}"]`
          const allMatching = Array.from(rowContainer
            ? rowContainer.querySelectorAll(sel)
            : document.querySelectorAll(sel)
          )
          if (allMatching.length > 0) return txt(allMatching[0])
          return ''
        }

        let status = ''
        const openEl  = rowContainer
          ? rowContainer.querySelector(`[data-test="conversations.column_status_OPEN_${agentId}"]`)
          : null
        const closeEl = rowContainer
          ? rowContainer.querySelector(`[data-test="conversations.column_status_CLOSE_${agentId}"]`)
          : null
        if (openEl)  status = 'Open'
        else if (closeEl) status = 'Closed'
        else status = getStatusOrType('status')

        const visitorName  = txt(visitorEl)
        if (!visitorName) return

        let responseTime = getField('responseTime')
        if (!responseTime) {
          const negEl = rowContainer
            ? rowContainer.querySelector(`[data-test*="conversations.column_responseTime_${agentId}_time_duration"]`)
            : null
          if (negEl) responseTime = txt(negEl)
        }

        result.conversations.push({
          visitorName:    visitorName,
          status:         status,
          responseTime:   responseTime,
          agentName:      getField('agentName'),
          agentGroupName: getField('agentGroupName'),
          skill:          getField('skill'),
          startTimestamp: getField('startTimestamp'),
          csatScore:      getField('csatScore')
        })
      })
    }
  } catch (e) {
    console.warn('[LP] Conversations scrape error:', e.message)
  }

  return result
}

// ── Write to Supabase ──────────────────────────────────────────────────────
async function writeActivitySummary(activitySummary, accountId) {
  if (!activitySummary || Object.keys(activitySummary).length === 0) return
  const row = { id: accountId, account_id: accountId, updated_at: new Date().toISOString() }
  Object.entries(activitySummary).forEach(([label, value]) => { row[sanitizeKey(label)] = value })
  await supabaseUpsert('ashleychat_activity_summary', [row])
  console.log(`[ashleychat] ✅ Activity summary written (${Object.keys(activitySummary).length} metric(s))`)
}

async function writeQueueSummary(queueSummary, accountId) {
  const now = new Date().toISOString()
  const rows = (queueSummary || []).map(q => ({
    id:         `${accountId}:${sanitizeKey(q.skill)}`,
    account_id: accountId,
    skill:      q.skill,
    in_queue:   q.inQueue,
    wait_time:  q.waitTime,
    updated_at: now,
  }))
  const deduped = dedupeById(rows)
  await pruneDeparted('ashleychat_queue_summary', accountId, new Set(deduped.map(r => r.id)))
  if (deduped.length === 0) return
  await supabaseUpsert('ashleychat_queue_summary', deduped)
  console.log(`[ashleychat] ✅ Queue summary written (${deduped.length})`)
}

async function writeAgents(agents, accountId) {
  if (!agents || agents.length === 0) return
  const now = new Date().toISOString()
  const rows = agents.map(a => ({
    id:                  `${accountId}:${sanitizeKey(a.name)}`,
    account_id:          accountId,
    agent_name:          a.name,
    status:              a.status,
    status_duration:     a.statusDuration,
    agent_group:         a.group,
    active_convs:        a.activeConvs,
    assigned_convs:      a.assignedConvs,
    closed_convs:        a.closedConvs,
    load:                a.load,
    online_rate:         a.onlineRate,
    csat:                a.csat,
    max_slots:           a.maxSlots,
    transfers:           a.transfers,
    transfer_rate:       a.transferRate,
    skills:              a.skills || [],
    updated_at:          now,
  }))
  const deduped = dedupeById(rows)
  await pruneDeparted('ashleychat_agents', accountId, new Set(deduped.map(r => r.id)))
  await supabaseUpsert('ashleychat_agents', deduped)
  console.log(`[ashleychat] ✅ Agents written (${deduped.length})`)
}

async function writeConversations(conversations, accountId) {
  const now = new Date().toISOString()
  const rows = (conversations || []).map(c => ({
    id:               `${accountId}:conv:${sanitizeKey(`${c.visitorName}:${c.agentName}:${c.startTimestamp}`)}`,
    account_id:       accountId,
    visitor_name:     c.visitorName,
    status:           c.status,
    response_time:    c.responseTime,
    agent_name:       c.agentName,
    agent_group_name: c.agentGroupName,
    skill:            c.skill,
    start_timestamp:  c.startTimestamp,
    csat_score:       c.csatScore,
    updated_at:       now,
  }))
  const deduped = dedupeById(rows)
  // Always prune, even with zero current conversations — same reasoning as
  // guardianbikes_live_calls: a live conversation list can legitimately drop
  // to zero, and previously-active rows must clear then too.
  await pruneDeparted('ashleychat_conversations', accountId, new Set(deduped.map(r => r.id)))
  if (deduped.length === 0) return
  await supabaseUpsert('ashleychat_conversations', deduped)
  console.log(`[ashleychat] ✅ Conversations written (${deduped.length})`)
}

// ── Module exports ────────────────────────────────────────────────────────────
module.exports = {
  meta: {
    type:     'liveperson',
    interval: 30000,
  },

  // ── Login: fully automated (see file header) — no MFA/2FA step observed in
  // the original extension's flow, so unlike the Five9/Gorgias/Flex accounts
  // in this codebase, this is NOT manualLogin.
  async login(page, context, account, sessionPath) {
    page.on('pageerror', err => console.warn(`[ashleychat page error] ${err.message}`))

    await page.goto(account.dashboardUrl, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(e => {
      console.warn(`[ashleychat] goto failed: ${e.message}`)
    })
    await page.waitForTimeout(1000)

    if (isLoginUrl(page.url())) {
      await handleLivePersonLogin(page, account)
    }
  },

  // ── Session-expiry check ─────────────────────────────────────────────────────
  isSessionExpired(page) {
    return isLoginUrl(page.url())
  },

  // ── Scrape ───────────────────────────────────────────────────────────────
  async scrape(page, account) {
    if (isLoginUrl(page.url())) return { hasData: false }

    let data
    try {
      data = await page.evaluate(scrapeLivePerson)
    } catch (err) {
      console.warn(`[ashleychat] scrape error: ${err.message}`)
      return null
    }

    const isEmpty = !data || (
      data.agents.length === 0 &&
      data.queueSummary.length === 0 &&
      Object.keys(data.activitySummary).length === 0
    )
    if (isEmpty) return { hasData: false }

    return { hasData: true, ...data }
  },

  // ── Write to Supabase ──────────────────────────────────────────────────────
  async write(data, accountId) {
    if (!data || !data.hasData) return
    await writeActivitySummary(data.activitySummary, accountId).catch(err => console.warn(`[ashleychat] activity_summary write failed: ${err.message}`))
    await writeQueueSummary(data.queueSummary, accountId).catch(err => console.warn(`[ashleychat] queue_summary write failed: ${err.message}`))
    await writeAgents(data.agents, accountId).catch(err => console.warn(`[ashleychat] agents write failed: ${err.message}`))
    await writeConversations(data.conversations, accountId).catch(err => console.warn(`[ashleychat] conversations write failed: ${err.message}`))
  },

  // ── Terminal dashboard display ─────────────────────────────────────────────
  getDisplayInfo(data) {
    if (!data) return { sla: '--', waiting: '0', agents: '--', info: '' }
    const act = data.activitySummary || {}
    return {
      sla:     act['CSAT'] || '--',
      waiting: String((data.queueSummary || []).reduce((s, q) => s + (parseInt(q.inQueue) || 0), 0)),
      agents:  String((data.agents || []).length),
      info:    `Assigned:${act['Assigned'] || '--'} Load:${act['Load'] || '--'} Closed:${act['Closed'] || '--'}`,
    }
  },
}
