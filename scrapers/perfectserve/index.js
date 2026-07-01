// File: scrapers/perfectserve/index.js
// Path: C:\Users\rodolfo.luga\Documents\Node Projects\wfm-live-scraper\scrapers\perfectserve\index.js
// scrapers/perfectserve/index.js
// Five9 Supervisor Desktop scraper for PerfectServe.
//
// Ports the proven DOM scraping logic from the Chrome extension (content.js).
// Login flow mirrors autologin.js: role selection → station setup → login form.
//
// config.json entry:
//   { "id": "perfectserve", "username": "youruser", "password": "yourpass" }
//
// Supabase tables needed (run SQL below once):
// ─────────────────────────────────────────────────────────────────────────────
// CREATE TABLE IF NOT EXISTS five9_kpis (
//   id text PRIMARY KEY,
//   account_id text NOT NULL,
//   kpi_key text,
//   label text,
//   skill text,
//   value text,
//   raw_value text,
//   updated_at timestamptz DEFAULT now()
// );
// CREATE TABLE IF NOT EXISTS five9_agent_states (
//   id text PRIMARY KEY,
//   account_id text NOT NULL,
//   name text,
//   username text,
//   state text,
//   duration text,
//   current_state text,
//   updated_at timestamptz DEFAULT now()
// );
// CREATE TABLE IF NOT EXISTS five9_acd_status (
//   id text PRIMARY KEY,
//   account_id text NOT NULL,
//   skill_name text,
//   calls_in_queue text,
//   active_agents text,
//   on_calls text,
//   ready_for_calls text,
//   not_ready_for_calls text,
//   service_level text,
//   avg_speed_of_answer text,
//   calls_handled text,
//   updated_at timestamptz DEFAULT now()
// );
// ALTER PUBLICATION supabase_realtime ADD TABLE five9_kpis;
// ALTER PUBLICATION supabase_realtime ADD TABLE five9_agent_states;
// ALTER PUBLICATION supabase_realtime ADD TABLE five9_acd_status;
// ─────────────────────────────────────────────────────────────────────────────

'use strict'

const SUPERVISOR_URL = 'https://app-atl.five9.com/'
const LOGIN_TIMEOUT  = 90000   // 90s for full login flow
const DASH_TIMEOUT   = 60000   // 60s to wait for dashboard widgets

// ── Supabase write helper (same pattern as db-talkdesk.js) ───────────────────
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

// ── React-aware input fill (Five9 SPA uses React controlled inputs) ──────────
async function reactFill(page, selector, value) {
  await page.$eval(selector, (el, val) => {
    const setter = Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype, 'value'
    ).set
    setter.call(el, val)
    el.dispatchEvent(new Event('input',  { bubbles: true }))
    el.dispatchEvent(new Event('change', { bubbles: true }))
    el.dispatchEvent(new KeyboardEvent('keydown',  { bubbles: true }))
    el.dispatchEvent(new KeyboardEvent('keypress', { bubbles: true }))
    el.dispatchEvent(new KeyboardEvent('keyup',    { bubbles: true }))
  }, value)
}

// ── Wait for an element by selector with timeout ─────────────────────────────
async function waitForSel(page, selector, timeout = 10000) {
  try {
    await page.waitForSelector(selector, { timeout })
    return await page.$(selector)
  } catch { return null }
}

// ── Full Five9 login flow — handles all states autologin.js handles ──────────
// States encountered in order (not always all of them):
//   1. Role selection cards → click Supervisor
//   2. Station setup         → click None → click Next
//   3. Login form (React)    → fill username + password → click Log In
//   4. Existing session modal → click Continue
//   5. Back to role cards    → click Supervisor again
//   6. Dashboard loads
async function handleFive9Login(page, account) {
  const username = account.username || account.email || ''
  const password = account.password || ''
  const sleep    = ms => new Promise(r => setTimeout(r, ms))

  const deadline = Date.now() + LOGIN_TIMEOUT
  let   pass     = 0

  while (Date.now() < deadline) {
    pass++
    const url = page.url()
    console.log(`[F9 login] pass=${pass} url=${url.substring(0, 80)}`)

    // ── Dashboard loaded? Check widgets OR supervisor URL ───────────────────
    if (url.includes('DomainSupervisor') || url.includes('/supervisor/index')) {
      console.log('[F9 login] ✅ Supervisor URL reached — login complete')
      return
    }
    const widgets = await page.$$('.stat-view, .stat-threshold-container, .f9-widget-grid-row')
    if (widgets.length > 0) {
      console.log('[F9 login] ✅ Dashboard widgets found')
      return
    }

    // ── Error page (session expired / force-logout) ──────────────────────────
    const returnLink = await page.$('#ErrorPage-return-link')
    if (returnLink) {
      console.log('[F9 login] Error page — clicking Return to login...')
      await returnLink.click()
      await sleep(2000)
      continue
    }

    // ── Role selection cards — click Supervisor ──────────────────────────────
    // ATL branded page shows AT&T-style role cards
    const supCard = await page.$(
      'a.home-link.supervisor, ' +
      '[class*="role-card"] a[href*="supervisor"], ' +
      'a[href*="DomainSupervisor"], ' +
      '.at-t-applications__card'
    )
    if (supCard) {
      console.log('[F9 login] Role cards — clicking Supervisor...')
      await supCard.click()
      await sleep(3000)
      continue
    }

    // ── AT&T branded card with "Supervisor" text (specific to app-atl) ───────
    // Use narrow selectors only — [class*="card"] is too broad and fires on every page
    const atCards = await page.$$('.at-t-applications__card, [class*="five9-role"], [class*="roleCard"]')
    let clickedCard = false
    for (const card of atCards) {
      const txt = (await card.textContent() || '').toLowerCase()
      if (txt.includes('supervisor') && !txt.includes('agent')) {
        console.log('[F9 login] Clicking Supervisor card (AT&T branded)...')
        await card.click()
        await sleep(3500)
        clickedCard = true
        break
      }
    }
    if (clickedCard) continue

    // ── Station setup — click None → Next ────────────────────────────────────
    const noneStation = await page.$('#station-setup-4')
    if (noneStation) {
      console.log('[F9 login] Station setup — clicking None...')
      const isActive = await noneStation.evaluate(el => el.classList.contains('active'))
      if (!isActive) {
        await noneStation.click()
        await sleep(500)
      }
      const nextBtn = await page.$('.btn.pull-right.f9-positive-cta-btn, .f9-positive-cta-btn')
      if (nextBtn) {
        await nextBtn.click()
        await sleep(2000)
      }
      continue
    }

    // ── Existing session modal ────────────────────────────────────────────────
    const continueBtn = await page.$(
      '#existing-session-continue, ' +
      '[class*="existing-session"] button, ' +
      'button[data-id="continue"]'
    )
    if (continueBtn) {
      console.log('[F9 login] Existing session modal — clicking Continue...')
      await continueBtn.click()
      await sleep(2000)
      continue
    }

    // ── React login form (#Login-username-input) ─────────────────────────────
    const reactUsername = await page.$('#Login-username-input')
    if (reactUsername) {
      console.log('[F9 login] React login form — filling credentials...')
      if (!username || !password) throw new Error('Five9 username/password not set in config.json')
      await reactUsername.focus()
      await reactFill(page, '#Login-username-input', username)
      await sleep(300)
      await reactFill(page, '#Login-password-input', password)
      await sleep(400)
      // Re-verify fill (React sometimes resets the value)
      const filled = await page.$eval('#Login-username-input', el => el.value)
      if (!filled) {
        await reactFill(page, '#Login-username-input', username)
        await sleep(300)
        await reactFill(page, '#Login-password-input', password)
        await sleep(400)
      }
      console.log('[F9 login] Clicking Log In...')
      await page.click('#Login-login-button')
      await sleep(3500)
      continue
    }

    // ── Plain HTML login form (login.five9.com) ───────────────────────────────
    const plainUsername = await page.$('#username')
    if (plainUsername) {
      console.log('[F9 login] Plain login form — filling credentials...')
      if (!username || !password) throw new Error('Five9 username/password not set in config.json')
      await page.fill('#username', username)
      await sleep(300)
      await page.fill('#password', password)
      await sleep(400)
      await page.click('#loginBtn')
      await sleep(3500)
      continue
    }

    // Nothing recognised — wait and retry
    await sleep(2000)
  }

  throw new Error(`Five9 login timed out after ${LOGIN_TIMEOUT / 1000}s`)
}

// ── Wait for the supervisor dashboard to be ready ────────────────────────────
// Accepts the page once EITHER: widgets are visible OR the URL shows DomainSupervisor
async function waitForDashboard(page) {
  const deadline = Date.now() + DASH_TIMEOUT
  while (Date.now() < deadline) {
    const url = page.url()
    // Success: we're on the supervisor page
    if (url.includes('DomainSupervisor') || url.includes('/supervisor/index')) {
      console.log('[F9] Supervisor URL detected — waiting for widgets...')
      // Give widgets up to 20s to render, but don't fail if they don't
      try {
        await page.waitForSelector(
          '.stat-view, .stat-threshold-container, .f9-widget-grid-row, .f9-panel-header-label',
          { timeout: 20000 }
        )
        console.log('[F9] Widgets found ✅')
      } catch {
        console.log('[F9] Widgets not found yet — accepting dashboard by URL')
      }
      return
    }
    await new Promise(r => setTimeout(r, 1000))
  }
  // Last resort — accept if URL looks right
  const url = page.url()
  if (url.includes('five9.com') && !url.includes('login') && !url.includes('error')) {
    console.log(`[F9] Accepting dashboard by URL: ${url}`)
    return
  }
  throw new Error(`Dashboard not ready after ${DASH_TIMEOUT/1000}s — URL: ${url}`)
}

// ── DOM scraping — ported directly from content.js scrapeDOM() ───────────────
// Runs inside page.evaluate(), has no access to Node.js scope.
// All helpers must be defined inline.
const scrapeDOM = async function () {
  function sleep(ms) { return new Promise(r => setTimeout(r, ms)) }

  const kpis         = {}
  const agentsReady      = []
  const agentsNotReady   = []
  const agentsOnCall     = []
  const agentsAllState   = []
  const acdStatusRows    = []
  const campaignRows     = []

  // ── Collect visible rows from a widget (virtualized scroll) ─────────────
  async function scrollAndCollectRows(widget) {
    const scrollContainer = widget.querySelector('.f9-widget-grid-content')
    if (!scrollContainer) return collectVisibleRows(widget)

    const rowMap    = new Map()
    const rowHeight = 50
    const stepSize  = Math.max(scrollContainer.clientHeight - rowHeight, rowHeight)
    const savedPos  = scrollContainer.scrollTop

    scrollContainer.scrollTop = 0
    await sleep(120)

    const addRows = rows => rows.forEach(row => {
      const key = row.email || row.name
      if (key && !rowMap.has(key)) rowMap.set(key, row)
    })

    let lastScrollTop = -1
    while (true) {
      addRows(collectVisibleRows(widget))
      const currentTop = scrollContainer.scrollTop
      if (currentTop === lastScrollTop) break
      lastScrollTop = currentTop
      const atBottom = scrollContainer.scrollTop >= scrollContainer.scrollHeight - scrollContainer.clientHeight
      if (atBottom) break
      scrollContainer.scrollTop += stepSize
      await sleep(120)
    }
    addRows(collectVisibleRows(widget))
    scrollContainer.scrollTop = savedPos
    return Array.from(rowMap.values())
  }

  // ── Collect currently visible rows ───────────────────────────────────────
  function collectVisibleRows(widget) {
    const colHeaders = Array.from(widget.querySelectorAll('.f9-widget-grid-header-label'))
      .map(el => el.innerText.trim())
    const rows = []

    // ── New grid row method (PerfectServe account) ───────────────────────
    const gridRows = widget.querySelectorAll('.f9-widget-grid-row')
    if (gridRows.length > 0) {
      gridRows.forEach(rowEl => {
        const nameCell  = rowEl.querySelector('.f9-widget-grid-cell.renderer.docked, [data-column-id="nameUsernameCombined"]')
        const rawText   = nameCell?.innerText.trim() || ''
        const nameParts = rawText.split('\n').map(s => s.trim()).filter(Boolean)
        const name      = nameCell?.querySelector('.agent-name-grid-cell-name')?.innerText.trim()
                       || nameParts[0] || ''
        const username  = nameCell?.querySelector('.agent-name-grid-cell-username')?.innerText.trim()
                       || nameParts[1] || ''
        if (!name) return

        const cells      = Array.from(rowEl.querySelectorAll('.f9-widget-grid-cell-inner'))
          .map(c => c.innerText.trim())
        const dockedExtra = (colHeaders.length - 1) - cells.length
        const colMap     = {}

        if (dockedExtra > 0) {
          const nonDockedRenderers = Array.from(
            rowEl.querySelectorAll('.f9-widget-grid-cell.renderer:not(.docked)')
          )
          const extraRenderers = nonDockedRenderers.filter(
            el => !el.querySelector('.f9-widget-grid-cell-inner')
          )
          colHeaders.slice(1, 1 + dockedExtra).forEach((col, idx) => {
            const el = extraRenderers[idx]
            if (!el) { colMap[col] = ''; return }
            const btnLabel = el.querySelector('.button-label')
            colMap[col] = btnLabel ? btnLabel.innerText.trim() : el.innerText.trim()
          })
        }

        colHeaders.slice(1 + dockedExtra).forEach((col, idx) => {
          colMap[col] = cells[idx] !== undefined ? cells[idx] : ''
        })

        rows.push({ name, username, email: username, colMap })
      })
      return rows
    }

    // ── Fallback: agent-name-label method ────────────────────────────────
    const nameEls = widget.querySelectorAll('.agent-name-label')
    nameEls.forEach(nameEl => {
      const name       = nameEl.querySelector('.agent-name-grid-cell-name')?.innerText.trim()
                      || nameEl.innerText.split('\n')[0].trim()
      const usernameEl = nameEl.closest('[class]')?.querySelector('.agent-name-grid-cell-username')
                      || nameEl.parentElement?.querySelector('.agent-name-grid-cell-username')
      const username   = usernameEl?.innerText.trim() || ''
      const emailEl    = nameEl.closest('[class]')?.querySelector('.tt.tt-allow-content')
      const email      = emailEl?.innerText.trim() || username

      let rowEl = nameEl.parentElement
      for (let i = 0; i < 8; i++) {
        if (!rowEl) break
        if (rowEl.querySelectorAll('*').length >= Math.max(colHeaders.length - 1, 3)) break
        rowEl = rowEl.parentElement
      }
      if (!rowEl) return

      const leafEls = Array.from(rowEl.querySelectorAll('*')).filter(el =>
        el.children.length === 0 &&
        el.innerText?.trim() &&
        !el.classList.contains('f9-widget-grid-header-label') &&
        !el.classList.contains('agent-name-grid-cell-name') &&
        !el.classList.contains('agent-name-grid-cell-username') &&
        !el.innerText.trim().startsWith('Alert ')
      )
      const vals = leafEls.map(el => el.innerText.trim()).filter(v => v.length > 0)
      const colMap = {}
      colHeaders.slice(1).forEach((col, idx) => { colMap[col] = vals[idx] !== undefined ? vals[idx] : '' })
      if (name) rows.push({ name, username, email, colMap })
    })
    return rows
  }

  // ── Collect ACD Status rows ──────────────────────────────────────────────
  function collectACDRows(widget) {
    const colHeaders = Array.from(widget.querySelectorAll('.f9-widget-grid-header-label'))
      .map(el => el.innerText.trim())
    const skillEls = widget.querySelectorAll('[class*="acd-status-name-label"]')
    console.log('[F9] ACD collectACDRows: colHeaders=' + colHeaders.length + ' skillEls=' + skillEls.length)
    const rows = []
    skillEls.forEach(skillEl => {
      const skillName = skillEl.innerText.trim()
      if (!skillName) return
      let rowEl = skillEl.parentElement
      for (let i = 0; i < 8; i++) {
        if (!rowEl) break
        const cells = rowEl.querySelectorAll(
          '.f9-widget-grid-cell-inner, [class*="acd-status-cell"], td, [role="gridcell"]'
        )
        if (cells.length >= 2) break
        rowEl = rowEl.parentElement
      }
      if (!rowEl) return

      // Method 1: header-mapped colMap
      const leafEls = Array.from(rowEl.querySelectorAll('*')).filter(el =>
        el.children.length === 0 && el.innerText?.trim() &&
        !el.classList.contains('f9-widget-grid-header-label') &&
        !el.innerText.trim().startsWith('Alert ')
      )
      const vals = leafEls.map(el => el.innerText.trim()).filter(v => v.length > 0)
      console.log('[F9] ACD skill="' + skillName + '" vals=' + JSON.stringify(vals.slice(0, 8)))

      const colMap = {}
      if (colHeaders.length > 1) {
        // Header-based mapping
        colHeaders.slice(1).forEach((col, idx) => { colMap[col] = vals[idx] !== undefined ? vals[idx] : '' })
      } else {
        // Positional fallback (typical Five9 ACD Status column order):
        // 0=skill, 1=calls_in_queue, 2=active_agents, 3=on_calls, 4=ready, 5=not_ready, 6=sla, 7=asa
        const P = ['Calls in Queue','Active Agents','On Calls','Ready For Calls',
                   'Not Ready For Calls','Service Level (%)','Avg Speed of Answer','Calls Handled']
        P.forEach((col, idx) => { colMap[col] = vals[idx] !== undefined ? vals[idx] : '' })
      }
      rows.push({ skillName, colMap })
    })
    return rows
  }

  // ── Loop through all widgets ─────────────────────────────────────────────
  const widgets = Array.from(document.querySelectorAll('.stat-view'))
  console.log('[F9] scrapeDOM: found ' + widgets.length + ' .stat-view widgets')
  widgets.forEach((w, i) => {
    const h = w.querySelector('.f9-panel-header-label')?.innerText?.trim() || '(no header)'
    const rows = w.querySelectorAll('.f9-widget-grid-row, tr').length
    const cards = w.querySelectorAll('.stat-threshold-container, .stat-view-item').length
    console.log('[F9]   widget[' + i + '] header="' + h + '" rows=' + rows + ' cards=' + cards)
  })
  if (widgets.length === 0) {
    // Fallback: try broader selectors
    const anyWidgets = Array.from(document.querySelectorAll(
      '[class*="stat-view"], [class*="StatView"], [class*="widget-container"]'
    ))
    console.log('[F9] Fallback: found ' + anyWidgets.length + ' broader stat widgets')
    if (anyWidgets.length === 0) {
      // Last resort: check if there are any stat tiles at all
      const anyTiles = document.querySelectorAll('.stat-threshold-container, [class*="stat-threshold"]')
      if (anyTiles.length > 0) {
        // Tiles exist but not wrapped in .stat-view — push a synthetic widget
        widgets.push(document.body)
      } else {
        return null
      }
    } else {
      anyWidgets.forEach(w => widgets.push(w))
    }
  }

  for (const widget of widgets) {
    const headerEl = widget.querySelector('.f9-panel-header-label')
    const header   = headerEl ? headerEl.innerText.trim() : ''

    // ── Stat tiles (KPI cards) — multi-strategy extraction ──────────────
    const statCards = Array.from(widget.querySelectorAll(
      '.stat-threshold-container, .stat-view-item, ' +
      '[class*="stat-threshold"], [class*="StatTile"], [class*="kpi-tile"]'
    ))
    statCards.forEach(card => {
      // Strategy 1: specific label + value selectors
      const labelEl = card.querySelector(
        '.stat-label, .stat-view-label, .stat-threshold-label, ' +
        '[class*="stat-label"], [class*="StatLabel"]'
      )
      const valueEl = card.querySelector(
        '.stat-value, .stat-view-value, .stat-threshold-value, ' +
        '[class*="stat-value"], [class*="StatValue"], [class*="stat-display"]'
      )
      let label = labelEl?.innerText.trim() || ''
      let value = valueEl?.innerText.trim() || ''

      // Strategy 2: fallback — tile text is usually "VALUE\nSkill Name"
      if (!label || !value) {
        const lines = card.innerText.trim().split('\n')
          .map(l => l.trim()).filter(Boolean)
        if (lines.length >= 2) {
          // First line is usually the big number/value, last is the skill/label
          value = value || lines[0]
          label = label || lines[lines.length - 1]
        } else if (lines.length === 1) {
          value = lines[0]
          label = header || 'KPI'
        }
      }

      if (label && value && value !== label) {
        const key = label.replace(/\s+/g, '_').toLowerCase()
        kpis[key] = { label, skill: header || 'Global', value, raw: value }
      }
    })

    // ── Not Ready / All State agents ────────────────────────────────────
    if (/not ready/i.test(header) || /all state/i.test(header)) {
      const rows = await scrollAndCollectRows(widget)
      const target = /all state/i.test(header) ? agentsAllState : agentsNotReady
      rows.forEach(({ name, username, email, colMap }) => {
        target.push({
          name, username,
          email:        email || colMap['Email'] || username,
          state:        colMap['Current State'] || 'Not Ready',
          duration:     colMap['State Timer']   || colMap['State Duration'] || '',
          currentState: colMap['Current State'] || '',
          stateSince:   colMap['State Since']   || '',
        })
      })
    }

    // ── On Call agents ──────────────────────────────────────────────────
    else if (/^on call/i.test(header) || /agents on a call/i.test(header)) {
      const rows = await scrollAndCollectRows(widget)
      rows.forEach(({ name, username, email, colMap }) => {
        agentsOnCall.push({
          name, username,
          email:        email || colMap['Email'] || username,
          state:        'On Call',
          duration:     colMap['State Timer']       || colMap['State Duration']   || '',
          callDuration: colMap['On Call Duration']  || '',
          currentState: colMap['Current State']     || '',
          stateSince:   colMap['State Since']       || '',
          voiceWL:      colMap['Voice WL']          || '',
        })
      })
    }

    // ── Ready for Calls agents ──────────────────────────────────────────
    else if (/ready for calls/i.test(header) || /agents on ready/i.test(header)) {
      const rows = await scrollAndCollectRows(widget)
      rows.forEach(({ name, username, email, colMap }) => {
        agentsReady.push({
          name, username,
          email:        email || colMap['Email'] || username,
          state:        'Ready',
          duration:     colMap['State Timer'] || colMap['State Duration'] || '',
          currentState: colMap['Current State'] || '',
          stateSince:   colMap['State Since']   || '',
          voiceWL:      colMap['Voice WL']      || '',
        })
      })
    }

    // ── ACD Status (per-skill queue stats) ──────────────────────────────
    else if (/^acd status/i.test(header)) {
      const rows = collectACDRows(widget)
      rows.forEach(({ skillName, colMap }) => {
        acdStatusRows.push({
          skillName,
          callsInQueue:        colMap['Calls in Queue']       || colMap['Calls In Queue']     || '',
          activeAgents:        colMap['Active Agents']        || '',
          onCalls:             colMap['On Calls']             || '',
          readyForCalls:       colMap['Ready For Calls']      || '',
          notReadyForCalls:    colMap['Not Ready For Calls']  || '',
          serviceLevel:        colMap['Service Level (%)']    || '',
          avgSpeedOfAnswer:    colMap['Avg Speed of Answer']  || '',
          callsHandled:        colMap['Calls Handled']        || '',
          longestQueueTime:    colMap['Longest Queue Time (Voice)'] || colMap['Longest Queue Time'] || '',
        })
      })
    }
  }

  // ── Derive KPIs from ACD rows if no stat tiles found ────────────────────
  if (Object.keys(kpis).length === 0 && acdStatusRows.length > 0) {
    acdStatusRows.forEach(row => {
      const sk = row.skillName.replace(/\s+/g, '_').toLowerCase()
      if (row.callsInQueue)     kpis['calls_in_queue_' + sk]  = { label: 'Calls In Queue',     skill: row.skillName, value: row.callsInQueue,     raw: row.callsInQueue }
      if (row.onCalls)          kpis['on_calls_'       + sk]  = { label: 'On Calls',            skill: row.skillName, value: row.onCalls,           raw: row.onCalls }
      if (row.readyForCalls)    kpis['ready_'          + sk]  = { label: 'Ready For Calls',     skill: row.skillName, value: row.readyForCalls,     raw: row.readyForCalls }
      if (row.notReadyForCalls) kpis['not_ready_'      + sk]  = { label: 'Not Ready',           skill: row.skillName, value: row.notReadyForCalls,  raw: row.notReadyForCalls }
      if (row.serviceLevel)     kpis['sla_'            + sk]  = { label: 'SLA',                 skill: row.skillName, value: row.serviceLevel,      raw: row.serviceLevel }
      if (row.avgSpeedOfAnswer) kpis['asa_'            + sk]  = { label: 'Avg Speed of Answer', skill: row.skillName, value: row.avgSpeedOfAnswer,  raw: row.avgSpeedOfAnswer }
    })
  }

  const hasData = Object.keys(kpis).length > 0 ||
    agentsReady.length > 0 || agentsNotReady.length > 0 ||
    agentsOnCall.length > 0 || agentsAllState.length > 0 ||
    acdStatusRows.length > 0

  if (!hasData) return null

  return {
    hasData: true,
    kpis, agentsReady, agentsNotReady, agentsOnCall,
    agentsAllState, acdStatusRows, campaignRows: [],
    snapshotTime: new Date().toISOString()
  }
}

// ── Write to Supabase ─────────────────────────────────────────────────────────
async function writeFive9Data(data, accountId) {
  const now = new Date().toISOString()

  // KPIs — full label-value table
  const kpiRows = Object.entries(data.kpis || {}).map(([key, kpi]) => ({
    id:          `${accountId}:${key}`,
    account_id:  accountId,
    kpi_key:     key,
    label:       kpi.label   || '',
    skill:       kpi.skill   || '',
    value:       kpi.value   || '',
    raw_value:   String(kpi.raw ?? kpi.value ?? ''),
    updated_at:  now,
  }))
  if (kpiRows.length > 0) {
    await supabaseUpsert('five9_kpis', kpiRows)
    console.log(`[${accountId}] ✅ KPIs written (${kpiRows.length})`)
  }

  // Flat global summary row — one row per account in wide format
  // This is what the dashboard Data Sources picks up for SLA, Queue, etc.
  const kpiVals = Object.values(data.kpis || {})
  const findKpiVal = (labelHint) => {
    const lower = labelHint.toLowerCase()
    const globalEntry = kpiVals.find(k =>
      (k.label || '').toLowerCase().includes(lower) && k.skill === 'Global' && k.value && k.value !== '-'
    )
    if (globalEntry) return globalEntry.value
    const anyEntry = kpiVals.find(k =>
      (k.label || '').toLowerCase().includes(lower) && k.value && k.value !== '-'
    )
    return anyEntry ? anyEntry.value : ''
  }
  const globalRow = {
    id:               accountId,
    account_id:       accountId,
    sla:              findKpiVal('sla') || findKpiVal('service level'),
    avg_handle_time:  findKpiVal('handle time') || findKpiVal('aht'),
    calls_in_queue:   findKpiVal('calls in queue') || findKpiVal('queue'),
    calls_abandoned:  findKpiVal('abandon'),
    total_calls:      findKpiVal('total call'),
    agents_ready:     data.agentsReady?.length    || 0,
    agents_not_ready: data.agentsNotReady?.length || 0,
    agents_on_call:   data.agentsOnCall?.length   || 0,
    updated_at:       now,
  }
  await supabaseUpsert('five9_global_kpis', [globalRow])
  console.log(`[${accountId}] ✅ Global KPIs written (SLA: ${globalRow.sla || '--'})`)

  // Agent states — merge all lists, deduplicate by username
  const allAgents = [
    ...data.agentsReady    || [],
    ...data.agentsNotReady || [],
    ...data.agentsOnCall   || [],
    ...data.agentsAllState || [],
  ]
  const agentMap = new Map()
  allAgents.forEach(a => {
    const key = `${accountId}:${a.username || a.name}`
    if (!agentMap.has(key)) agentMap.set(key, a)
  })
  const agentRows = [...agentMap.values()].map(a => ({
    id:            `${accountId}:${a.username || a.name}`,
    account_id:    accountId,
    name:          a.name         || '',
    username:      a.username     || '',
    state:         a.state        || '',
    duration:      a.duration     || '',
    current_state: a.currentState || a.state || '',
    updated_at:    now,
  }))
  if (agentRows.length > 0) {
    await supabaseUpsert('five9_agent_states', agentRows)
    console.log(`[${accountId}] ✅ Agent states written (${agentRows.length})`)
  }

  // ACD Status — deduplicate by skill name before upsert
  const acdMap = new Map()
  ;(data.acdStatusRows || []).forEach(row => {
    const id = `${accountId}:${row.skillName}`
    if (!acdMap.has(id)) acdMap.set(id, {
      id,
      account_id:          accountId,
      skill_name:          row.skillName            || '',
      calls_in_queue:      row.callsInQueue          || '',
      active_agents:       row.activeAgents          || '',
      on_calls:            row.onCalls               || '',
      ready_for_calls:     row.readyForCalls          || '',
      not_ready_for_calls: row.notReadyForCalls       || '',
      service_level:       row.serviceLevel           || '',
      avg_speed_of_answer: row.avgSpeedOfAnswer       || '',
      calls_handled:       row.callsHandled           || '',
      updated_at:          now,
    })
  })
  const acdRows = [...acdMap.values()]
  if (acdRows.length > 0) {
    await supabaseUpsert('five9_acd_status', acdRows)
    console.log(`[${accountId}] ✅ ACD status written (${acdRows.length} skills)`)
  }
}

// ── Module exports ────────────────────────────────────────────────────────────
module.exports = {
  meta: {
    type:     'Five9',
    interval: 30000,
  },

  // ── Login ──────────────────────────────────────────────────────────────────
  async login(page, context, account, sessionPath) {
    // Forward browser console.log to terminal for debugging
    page.on('console', msg => {
      const txt = msg.text()
      if (txt.startsWith('[F9]')) console.log(`[perfectserve browser] ${txt}`)
    })
    page.on('pageerror', err => console.warn(`[perfectserve page error] ${err.message}`))

    console.log(`[perfectserve] Navigating to Five9 supervisor...`)
    await page.goto(SUPERVISOR_URL, { waitUntil: 'domcontentloaded', timeout: 30000 })

    await handleFive9Login(page, account)
    await waitForDashboard(page)

    // Extra wait for Five9 to fully render all widgets after navigation
    console.log('[perfectserve] Waiting 6s for widgets to fully render...')
    await new Promise(r => setTimeout(r, 6000))
    // Save session cookies
    await context.storageState({ path: sessionPath })
    console.log('[perfectserve] ✅ Login complete, dashboard ready')
  },

  // ── Session expiry detection ───────────────────────────────────────────────
  isSessionExpired(page) {
    const url = page.url()
    return url.includes('loginError=true') ||
           url.includes('login.five9.com') ||
           url === 'about:blank' ||
           url.includes('/error.html')
  },

  // ── Scrape the Five9 supervisor DOM ───────────────────────────────────────
  async scrape(page, account) {
    try {
      const data = await page.evaluate(scrapeDOM)
      return data
    } catch (err) {
      console.error(`[perfectserve] scrape error:`, err.message)
      return null
    }
  },

  // ── Write to Supabase ──────────────────────────────────────────────────────
  async write(data, accountId) {
    if (!data || !data.hasData) return
    await writeFive9Data(data, accountId)
  },

  // ── Terminal dashboard display ─────────────────────────────────────────────
  getDisplayInfo(data) {
    if (!data) return { sla: '--', waiting: '0', agents: '--', info: '' }

    // Find first SLA KPI across any skill
    const kpiVals   = Object.values(data.kpis || {})
    const slaKpi    = kpiVals.find(k => k.label === 'SLA' || k.label?.toLowerCase().includes('service level'))
    const totalQ    = (data.acdStatusRows || []).reduce(
      (s, r) => s + (parseInt(r.callsInQueue) || 0), 0
    )
    const totalAgt  = (data.agentsReady?.length   || 0) +
                      (data.agentsNotReady?.length || 0) +
                      (data.agentsOnCall?.length   || 0) +
                      (data.agentsAllState?.length || 0)

    const nr = data.agentsNotReady?.length || 0
    const oc = data.agentsOnCall?.length   || 0
    const rd = data.agentsReady?.length    || 0

    return {
      sla:     slaKpi?.value || '--',
      waiting: String(totalQ),
      agents:  String(totalAgt),
      info:    `Rd:${rd} NR:${nr} OC:${oc}`,
    }
  }
}
