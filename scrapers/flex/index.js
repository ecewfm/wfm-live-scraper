// File: scrapers/flex/index.js
// Zendesk Agent Workspace ticket-list scraper for the Flex account (getflex.zendesk.com).
//
// THREE data sources for this account — first two are implemented so far:
//   1. General Ticket Status — the "General" view's ticket table
//      (https://getflex.zendesk.com/agent/filters/22437671830423) — DONE.
//   2. Geckoboard "Tickets Nearing SLA Breach" board
//      (https://share.geckoboard.com/dashboards/<id>) — DONE. A completely
//      different product from Zendesk — a PUBLIC share link needing no login
//      at all, fetched as its own secondary Playwright Page in the same
//      browser context (same pattern as scrapers/wyze/index.js's
//      ensureSecondaryPage), independent of the Zendesk session below.
//   3. Ticket Status Explore dashboard (getflex.zendesk.com/explore/studio#/
//      dashboards/precanned/...) — PARTIALLY implemented, see below.
//
// GENERAL VIEW TABLE — confirmed via a live DOM probe: a plain semantic
// Garden <table data-test-id="generic-table">, NOT a virtual-list/ARIA grid.
// 16 <thead th> columns in this exact order: Select-all, Conversation, Agent
// collision, Group privacy, Ticket status, ID, Priority, SLA, Subject,
// Requester, Requested, Group, Assignee, Category (U), Channel, Actions.
// <tbody> holds one <tr class="...StyledRow..."> per ticket (16 <td>s, same
// column order), PLUS an occasional single-cell <tr class="...StyledGroupRow...">
// divider row between priority buckets (e.g. "Priority: Normal") that must be
// skipped, not scraped as a ticket. Paginated with real Prev/Next buttons and
// a "(Page X of Y)" counter (data-test-id="views_views-header-page-amount")
// — NOT virtualized scroll — so every tick clicks "Next" until the last page
// to collect every ticket in the view.
//
// GECKOBOARD SLA-BREACH WIDGET — confirmed via a live DOM probe: the share
// link's page is a single cross-origin iframe (id="gb-dashboard-iframe", src
// .../inception) which renders the real widget content DIRECTLY inside it —
// no further nesting — as long as it's genuinely loaded as a child frame (it
// shows a recursive self-embedding placeholder instead if that URL is ever
// opened standalone, which is a dead end, not a real page shape). Inside that
// frame: a plain <table><tbody><tr><td> with 6 columns in this order: ID,
// Subject, Assignee, Assignee tags, Next SLA breach at, Ticket group. Each
// cell's innerText renders its content TWICE internally (a truncate/tooltip
// pattern) — cellText() below dedupes that back down to one copy. No
// pagination — it's a small, fixed "tickets nearing breach" list.
//
// TICKET STATUS EXPLORE DASHBOARD — confirmed via live DOM probing (took many
// rounds — noted here in detail so the dead ends aren't re-explored): this
// dashboard is NOT native Zendesk Explore rendering (unlike Eden Health/
// Wyze's kpi-queryid-* tiles) — it's a Looker embed
// (zendeskproductionuseast1.cloud.looker.com), reached via a chain of
// iframes: the Zendesk page's own iframe (URL contains short-lived signed
// embed_navigation_token/embed_authentication_token JWTs, 1hr session —
// NEVER hardcode this URL, it must come from a live page load) → a Looker
// "dashboard" frame → one SEPARATE iframe PER TILE ("SLA status", "Email",
// "Messaging", "Voice", etc. — ~12 tiles total), each individually
// SANDBOXED (iframe sandbox attribute, no allow-same-origin) so a same-host
// contentDocument reach-in from a sibling/parent frame returns null even
// though they share a hostname — Playwright's page.frames()/contentFrame()
// aren't subject to that restriction, they operate through the browser's own
// automation protocol same as DevTools, not through page-JS.
//
// Tiles LAZY-LOAD their iframe as they scroll into view — scrollLooker
// DashboardIntoView() below scrolls the dashboard frame's own document
// through its full height first so every tile actually has an iframe to find.
//
// TWO tile shapes are handled:
//
// (a) "Multiple Value" numeric tiles ("SLA status", "Email", "Messaging",
// "Voice", "Satisfaction score by channel", etc.) — each per-tile iframe
// carries an aria-label matching its own title (CONFIRMED via live
// probing), which is how each is found — NOT by iframe order or src, since
// every tile using this same Looker viz component shares the exact same
// src (e.g. ".../render/marketplace_viz_multiple_value::multiple_value-
// marketplace"). Inside: class names containing "DataPointGroup"/
// "DataPointValue" — each data point renders as two lines of text, label
// then value (e.g. "Messaging\n74%").
//
// (b) Donut/pie tiles ("SLA status by channel"; "Satisfaction distribution
// by channel" is NOT yet working, see below) — these render DIRECTLY inline
// in the Looker dashboard frame's own DOM (a D3 chart, no per-tile iframe
// at all), so instead of reading static markup, the scraper does a REAL
// Playwright mouse hover over each arc segment and reads the tooltip that
// appears — CONFIRMED via live testing that browser-console synthetic hover
// events (dispatchEvent) never trigger it (always isTrusted:false), but
// genuine Playwright mouse movement does. Donut charts commonly draw a full
// background ring UNDER a smaller foreground arc, so a naive path-midpoint
// hover can land on a point visually covered by a DIFFERENT segment —
// handled by trying several points along each path and verifying via
// elementFromPoint that the point actually resolves to the intended
// segment before trusting its tooltip. The tooltip only exists in the DOM
// while genuinely hovered, and a stale one can bleed into the NEXT
// segment/tile's read if not explicitly waited out — see
// waitForDonutTooltipCleared(). Full investigation history (including every
// dead end) is in scrapers/flex/PROGRESS.md.
//
// "Satisfaction distribution by channel" specifically: its tile is found
// (title renders), but no chart SVG with enough <path> elements is ever
// detected there — likely a different chart type (e.g. bars, not arcs)
// rather than a simple missing-selector issue. Left unhandled rather than
// guessed at; see PROGRESS.md for what to check next.
//
// Unrecognized tile shapes are silently skipped (not an error) so this can
// be extended incrementally as more tile types get mapped.
//
// WIDGET-ERROR RECOVERY: the embedded Looker dashboard frequently renders
// its tile shells (titles visible) but shows every widget in an error state
// (an icon in place of its chart/numbers) instead of real data — a known,
// apparently common Looker/Explore failure mode, observed to often be
// transient (a reload clears it). scrapeExploreDashboard() detects "tiles
// clearly rendered, but literally everything we know how to read came back
// with zero data" (deliberately excluding the one known-permanently-broken
// tile, "Satisfaction distribution by channel", from that check — otherwise
// its unrelated, permanent gap would trigger a reload on every single tick
// forever) and does ONE full page reload + retry before giving up for that
// tick. This is a coarse, whole-dashboard signal, not per-tile — a PARTIAL
// failure (some tiles fine, others erroring) does not currently trigger it.
//
// LOGIN: sign-in is "Sign in with Google" → a Google account-picker → the
// real dashboard. account.email holds the Google account's own address
// (e.g. abdul.mandangan.e@getflex.com) — attemptGoogleSignIn() clicks
// "Sign in with Google" then picks that account from Google's chooser.
// Because the persisted profile (sessions/flex-profile/, manualLogin's
// on-disk Chrome profile) already has this Google account's session
// remembered from the one-time manual setup, this normally needs no
// password or 2FA at all — CONFIRMED by the client's own description of
// their manual flow (Sign in with Google → click the one remembered
// account → straight to the dashboard). meta.manualLogin stays true as a
// fallback: if the remembered session ever needs fresh consent (a real
// password/2FA prompt appears), attemptGoogleSignIn() gives up cleanly and
// this falls back to waiting for a human (`resume flex`), same posture as
// scrapers/homebase/index.js's Okta SSO. (The Geckoboard board needs none
// of this — a public share link has no login step of its own.)
//
// config.json entry needed:
//   {
//     "id": "flex",
//     "type": "zendesk",
//     "email": "abdul.mandangan.e@getflex.com",
//     "password": "",
//     "dashboardUrl": "https://getflex.zendesk.com/agent/filters/22437671830423?brand_id=360002102693",
//     "exploreUrl": "https://getflex.zendesk.com/explore/studio?brand_id=360002102693#/dashboards/precanned/13EAEF5951D595E3281C80635C5BE556547FE5A572EE6A091B1237E8C49E4EBA",
//     "geckoboardUrl": "https://share.geckoboard.com/dashboards/BUMCTLXCJC5APKJ6"
//   }
//
// Supabase tables needed — see sql/flex.sql (run once):
//   flex_tickets      — one row per ticket in the General view
//   flex_sla_watch    — one row per ticket in the Geckoboard SLA-breach widget
//   flex_explore_tiles — one row per (tile, label) data point in the Explore dashboard
// ─────────────────────────────────────────────────────────────────────────────

'use strict'

// ── Supabase write helper (same pattern as edenhealth/hippo/wyze) ──────────
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

// Bounded-time backstop for a step that could theoretically still hang despite
// the dialog-dismiss fix (see ensureExplorePage's comment) — e.g. some other
// not-yet-seen way for a Playwright call to never resolve. This does NOT
// cancel the underlying operation (Playwright has no such mechanism), it just
// lets scrape() give up and return within bounded time so account-runner.js's
// tick() can reach its `finally` and reset `_ticking` — the difference between
// one bad tick and the account being permanently frozen (which is exactly
// what happened live on 2026-09-18 before the dialog-dismiss fix existed).
function withTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms)),
  ])
}

// Postgres rejects the whole upsert batch if the same id appears twice.
function dedupeById(rows) {
  const map = new Map()
  rows.forEach(r => map.set(r.id, r))
  return [...map.values()]
}

// ── Departure detection — delete rows for tickets no longer in the General
// view (closed/solved, reassigned out of it, etc.). Same pattern as every
// other scraper's pruneDeparted — see scrapers/wyze/index.js for the full
// reasoning behind the seed-then-diff approach.
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
      console.log(`[prune] ${table}: removed ${departed.length} departed ticket(s)`)
    }
  }
  _lastSeenIds.set(table, currentIds)
}

// ── URL helpers ──────────────────────────────────────────────────────────────
// Google SSO + an authenticator 2FA step bounces through accounts.google.com
// and possibly other domains along the way that aren't ours to predict — same
// reasoning as scrapers/homebase/index.js's Okta SSO check: deliberately
// broad (anywhere other than the real agent app counts as "not logged in")
// rather than matching one specific login domain/path, which could easily
// miss an intermediate redirect step and misreport "logged in" too early.
function isLoginUrl(url) {
  return !/getflex\.zendesk\.com\/agent\//.test(url || '')
}

// ── Automated "Sign in with Google" — the persisted profile (sessions/
// flex-profile/, see lib/browser.js's persistent-profile mode for manualLogin
// accounts) already has this account's Google session remembered from the
// one-time manual setup, so picking it from Google's account-chooser needs no
// password or 2FA re-entry — CONFIRMED by the client's own description of
// their manual flow: "Sign in with Google" → click the one remembered account
// → straight to the dashboard, no further prompts. This is an OPTIMISTIC
// attempt only: if the remembered session ever needs re-consent (a real
// password/2FA prompt appears, or the expected elements just aren't there),
// this gives up and returns without throwing — login()'s caller
// (account-runner.js, for every manualLogin account) already re-checks
// isSessionExpired() afterward and falls back to waiting for a human exactly
// as before if this didn't actually get all the way in.
// account.email holds the Google account's own address (e.g.
// abdul.mandangan.e@getflex.com) — repurposing the config field that this
// file's header previously called "unused... in case Flex ever exposes a
// scriptable login path later."
async function attemptGoogleSignIn(page, account) {
  const email = account.email || ''
  if (!email) {
    console.warn('[flex] No account.email configured — cannot pick a Google account automatically')
    return false
  }

  try {
    console.log('[flex] Attempting automated "Sign in with Google"...')
    const googleBtn = page.locator('text=Sign in with Google').first()
    const hasGoogleBtn = await googleBtn.waitFor({ timeout: 10000 }).then(() => true).catch(() => false)
    if (hasGoogleBtn) {
      await googleBtn.click()
    } else if (!/accounts\.google\.com/.test(page.url())) {
      console.log('[flex] "Sign in with Google" button not found — giving up on automated sign-in')
      return false
    }

    // Google may go straight to the account chooser, straight back to Flex
    // (if it silently resumes an existing session with no picker at all), or
    // — if the remembered session needs fresh consent — a real
    // password/2FA prompt. Only the first two are handled here.
    await page.waitForURL(/accounts\.google\.com|getflex\.zendesk\.com\/agent\//, { timeout: 20000 }).catch(() => {})

    if (/accounts\.google\.com/.test(page.url())) {
      console.log(`[flex] Google account chooser — selecting ${email}...`)
      const byIdentifier = page.locator(`[data-identifier="${email}"]`).first()
      const found = await byIdentifier.waitFor({ timeout: 8000 }).then(() => true).catch(() => false)
      if (found) {
        await byIdentifier.click()
      } else {
        // Fallback: the exact data-identifier attribute isn't guaranteed —
        // find whichever element's own visible text contains the email and
        // click it (clicks bubble to the tile's real click handler even if
        // this isn't the outermost clickable container).
        const byText = page.locator(`text=${email}`).first()
        const foundByText = await byText.waitFor({ timeout: 5000 }).then(() => true).catch(() => false)
        if (!foundByText) {
          console.warn(`[flex] Could not find a Google account tile for ${email}`)
          return false
        }
        await byText.click()
      }
      await page.waitForURL(/getflex\.zendesk\.com\/agent\//, { timeout: 20000 }).catch(() => {})
    }

    await page.waitForTimeout(1500)
    const success = !isLoginUrl(page.url())
    console.log(success
      ? '[flex] ✅ Automated Google sign-in succeeded'
      : '[flex] Automated Google sign-in did not complete (still on a login/consent page)')
    return success
  } catch (err) {
    console.warn(`[flex] Automated Google sign-in error: ${err.message}`)
    return false
  }
}

// ── Wait for the General view's ticket table to actually have rows ─────────
async function waitForTicketTable(page, maxMs = 30000) {
  await page.waitForFunction(() => {
    const table = document.querySelector('[data-test-id="generic-table"]')
    return !!(table && table.querySelectorAll('tbody tr').length > 0)
  }, { timeout: maxMs })
}

// ── Scrape the CURRENTLY VISIBLE page of the General ticket table ──────────
// Runs inside page.evaluate(). Column order confirmed via a live DOM probe —
// see file header. StyledGroupRow rows are single-cell priority dividers
// (e.g. "Priority: Normal") — captured as priorityGroup for every ticket row
// that follows, not scraped as a ticket themselves. The SLA cell holds TWO
// lines of text (e.g. "Breached by 16 days" then "-16d") — kept as separate
// fields rather than joined, so either can be used/formatted independently.
function scrapeTicketTablePage() {
  const table = document.querySelector('[data-test-id="generic-table"]')
  if (!table) return []

  const rows = Array.from(table.querySelectorAll('tbody tr'))
  const tickets = []
  let priorityGroup = ''

  rows.forEach(row => {
    if (row.className.includes('StyledGroupRow')) {
      priorityGroup = row.innerText.trim().replace(/^Priority:\s*/i, '')
      return
    }
    const cells = Array.from(row.querySelectorAll('td'))
    if (cells.length < 16) return // unexpected row shape — skip rather than misread columns

    const text = i => cells[i].innerText.trim()
    const slaLines = text(7).split('\n').map(s => s.trim()).filter(Boolean)

    const id = text(5).replace(/^#/, '')
    if (!id) return

    tickets.push({
      id, priorityGroup,
      ticketStatus: text(4),
      priority:     text(6),
      slaText:      slaLines[0] || '',
      slaShort:     slaLines.length > 1 ? slaLines[slaLines.length - 1] : '',
      subject:      text(8),
      requester:    text(9),
      requested:    text(10),
      group:        text(11),
      assignee:     text(12),
      category:     text(13),
      channel:      text(14),
    })
  })

  return tickets
}

// ── "(Page X of Y)" counter ──────────────────────────────────────────────────
async function readPageInfo(page) {
  return page.evaluate(() => {
    const el = document.querySelector('[data-test-id="views_views-header-page-amount"]')
    const m = (el?.innerText || '').match(/Page\s+(\d+)\s+of\s+(\d+)/i)
    return m ? { current: parseInt(m[1]), total: parseInt(m[2]) } : { current: 1, total: 1 }
  })
}

async function clickNextPage(page) {
  const buttons = await page.$$('button')
  for (const btn of buttons) {
    const t = (await btn.innerText().catch(() => '')).trim()
    if (/^next$/i.test(t)) { await btn.click(); return true }
  }
  return false
}

// ── Scrape EVERY page of the General ticket table, clicking "Next" until the
// last page — real pagination, not virtualized scroll (see file header). ───
async function scrapeAllTickets(page) {
  const all = []
  let guard = 0
  while (guard++ < 20) { // hard safety cap — a real view should never need this many pages
    await waitForTicketTable(page).catch(() => {})
    const pageTickets = await page.evaluate(scrapeTicketTablePage)
    all.push(...pageTickets)

    const { current, total } = await readPageInfo(page)
    if (current >= total) break

    const firstIdBefore = pageTickets[0]?.id
    const clicked = await clickNextPage(page)
    if (!clicked) break

    // Wait for the table to actually refresh (first data row's ticket id
    // changes) rather than a fixed sleep — Zendesk's own render timing varies.
    await page.waitForFunction(prevId => {
      const table = document.querySelector('[data-test-id="generic-table"]')
      const dataRow = Array.from(table?.querySelectorAll('tbody tr') || [])
        .find(r => !r.className.includes('StyledGroupRow'))
      const idCell = dataRow?.querySelectorAll('td')?.[5]
      return idCell && idCell.innerText.trim().replace(/^#/, '') !== prevId
    }, firstIdBefore, { timeout: 15000 }).catch(() => {})
  }
  return dedupeById(all)
}

// ── Geckoboard "Tickets Nearing SLA Breach" widget — public share link, no
// login. One secondary Page per account, opened once and reused across
// ticks (same pattern as scrapers/wyze/index.js's ensureSecondaryPage). ────
const GECKOBOARD_PAGES = new Map() // accountId -> Page

async function ensureGeckoboardPage(context, account) {
  let p = GECKOBOARD_PAGES.get(account.id)
  if (p && !p.isClosed()) return p

  p = await context.newPage()
  GECKOBOARD_PAGES.set(account.id, p)
  p.on('pageerror', () => {})
  p.on('dialog', d => d.dismiss().catch(() => {})) // see ensureExplorePage's comment — cheap defensive consistency
  await p.goto(account.geckoboardUrl, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(e => {
    console.warn(`[flex] geckoboard goto failed: ${e.message}`)
  })
  return p
}

// The real widget content lives inside iframe#gb-dashboard-iframe — fetched
// fresh every tick (cheap) rather than cached, in case Geckoboard ever
// replaces the iframe element internally (e.g. its own periodic refresh).
async function getGeckoboardFrame(page) {
  const handle = await page.waitForSelector('iframe#gb-dashboard-iframe', { timeout: 20000 }).catch(() => null)
  if (!handle) return null
  return handle.contentFrame()
}

async function waitForSlaWidgetRows(frame, maxMs = 30000) {
  await frame.waitForFunction(
    () => document.querySelectorAll('table tbody tr').length > 0,
    { timeout: maxMs }
  ).catch(() => {})
}

// Runs inside frame.evaluate() — column order + the duplicated-text quirk
// confirmed via a live DOM probe, see file header.
function scrapeSlaBreachWidget() {
  function cellText(cell) {
    const lines = Array.from(new Set(cell.innerText.trim().split('\n').map(s => s.trim()).filter(Boolean)))
    return lines.join(' ')
  }
  const rows = Array.from(document.querySelectorAll('table tbody tr'))
  return rows.map(row => {
    const cells = Array.from(row.querySelectorAll('td'))
    if (cells.length < 6) return null
    return {
      ticketId:     cellText(cells[0]),
      subject:      cellText(cells[1]),
      assignee:     cellText(cells[2]),
      assigneeTags: cellText(cells[3]),
      nextBreachAt: cellText(cells[4]),
      ticketGroup:  cellText(cells[5]),
    }
  }).filter(t => t && t.ticketId)
}

// ── Ticket Status Explore dashboard (Looker embed) — one secondary Page per
// account, reused across ticks (same pattern as the Geckoboard page above).
// Needs the same Zendesk login session as the General view, so it's only
// opened AFTER that login succeeds. See file header for the full iframe
// chain / sandboxing / lazy-load reasoning. ─────────────────────────────────
const EXPLORE_PAGES = new Map() // accountId -> Page

async function ensureExplorePage(context, account) {
  let p = EXPLORE_PAGES.get(account.id)
  if (!p || p.isClosed()) {
    p = await context.newPage()
    EXPLORE_PAGES.set(account.id, p)
    p.on('pageerror', () => {})
    // CONFIRMED root cause of a real production hang (2026-09-18): the Looker/
    // Explore embed's SPA apparently registers a beforeunload handler, so
    // page.reload() (see scrapeExploreDashboard's widget-error recovery) can
    // trigger a native "Leave site?" confirm dialog. Playwright leaves any
    // dialog open indefinitely unless something explicitly responds to it —
    // with no handler, that reload() call (and every awaited Playwright call
    // after it) hung forever, which froze this account's tick() permanently
    // (account-runner.js's _ticking guard never gets to reset in its `finally`
    // because the awaited scrape() call itself never resolves). Auto-dismiss
    // every dialog on this page so a reload can never get stuck waiting on one.
    p.on('dialog', d => d.dismiss().catch(() => {}))
    await p.goto(account.exploreUrl, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(e => {
      console.warn(`[flex] explore goto failed: ${e.message}`)
    })
  }

  // This tab shares Zendesk's login session with the main ticket view but
  // has been confirmed live to expire INDEPENDENTLY of it (the main page
  // stayed logged in while this separate cached tab silently redirected to
  // the Google sign-in screen on its own) — and since this page is reused
  // across ticks rather than recreated, nothing else ever re-checks it.
  // Re-validate and re-authenticate on every call, not just at creation.
  if (isLoginUrl(p.url())) {
    console.log('[flex] Explore page session expired — attempting automated Google sign-in...')
    const signedIn = await attemptGoogleSignIn(p, account)
    if (signedIn) {
      await p.goto(account.exploreUrl, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {})
    } else {
      console.warn('[flex] Explore page automated sign-in did not complete — will retry next tick')
    }
  }

  return p
}

function findLookerDashboardFrame(page) {
  return page.frames().find(f => /cloud\.looker\.com\/embed\/dashboards\//.test(f.url()))
}

// Tiles lazy-load their per-tile iframe only once scrolled into view.
// CONFIRMED BUG (found via live testing, not just theory) in an earlier
// version of this function: it scrolled `document.scrollingElement`, which
// has NOTHING to scroll in this dashboard (scrollHeight === clientHeight) —
// a complete no-op. The REAL scrollable container is a specific inner div
// (class containing "DashboardMain") — found generically here (by computed
// overflow style) rather than hardcoding that exact styled-components hash,
// since those are the kind of auto-generated class names most likely to
// change on a redeploy.
async function scrollLookerDashboardIntoView(frame) {
  await frame.evaluate(async () => {
    const sleep = ms => new Promise(r => setTimeout(r, ms))
    const isScrollable = el => {
      try {
        const s = getComputedStyle(el)
        return (s.overflowY === 'auto' || s.overflowY === 'scroll') && el.scrollHeight > el.clientHeight + 20 && el.clientHeight > 100
      } catch { return false }
    }
    const container = Array.from(document.querySelectorAll('*')).find(isScrollable)
    if (!container) return
    const step = Math.max(container.clientHeight - 60, 200)
    let lastTop = -1
    for (let i = 0; i < 30; i++) {
      container.scrollTop += step
      await sleep(500)
      if (container.scrollTop === lastTop) break
      lastTop = container.scrollTop
    }
    container.scrollTop = 0
  }).catch(() => {})
}

// ── "Multiple Value" tiles (Email/Messaging/Voice/SLA status numeric tiles)
// — each per-tile iframe carries an aria-label matching its own title
// (confirmed via live probing), a much more direct correlation than walking
// DOM ancestry. Only tiles whose iframe has actually mounted (scrolled into
// view + loaded) are found; everything else is silently skipped, not an
// error — retried next tick.
async function scrapeMultipleValueTiles(page, lookerFrame, titles) {
  const results = []
  for (const title of titles) {
    const iframeHandle = await lookerFrame.$(`iframe[aria-label="${title}"]`).catch(() => null)
    if (!iframeHandle) continue
    const tileFrame = await iframeHandle.contentFrame().catch(() => null)
    if (!tileFrame) continue

    const dataPoints = await tileFrame.evaluate(() => {
      const groups = Array.from(document.querySelectorAll('[class*="DataPointGroup"]'))
      if (groups.length === 0) return null
      return groups.map(g => {
        const lines = g.innerText.trim().split('\n').map(s => s.trim()).filter(Boolean)
        return { label: lines[0] || '', value: lines[1] || '' }
      })
    }).catch(() => null)

    if (dataPoints) dataPoints.forEach(dp => results.push({ tile: title, label: dp.label, value: dp.value }))
  }
  return results
}

// ── Donut/pie tiles ("SLA status by channel", "Satisfaction distribution by
// channel") — CONFIRMED via live testing (browser-console synthetic hover
// events never worked — dispatched events are always isTrusted:false, and
// this chart's hover detection appears to require genuinely trusted input;
// real Playwright mouse movement DOES work). These render DIRECTLY inline in
// the Looker dashboard frame's own DOM (a D3-based chart, NOT a per-tile
// iframe like the numeric tiles above), so no contentFrame() hop is needed
// — just real page.mouse hovering over each arc segment and reading the
// tooltip that appears. The tooltip only exists in the DOM while hovered
// (confirmed zero tooltip-shaped elements at rest) and reliably needs:
// (1) moving the mouse AWAY first, (2) approaching with multi-step smooth
// movement (a single instant jump often failed to trigger it in testing),
// (3) polling with a small jiggle between attempts rather than one fixed
// wait. See scrapers/flex/PROGRESS.md for the full investigation history.
const DONUT_TILE_TITLES = ['SLA status by channel', 'Satisfaction distribution by channel']

// NOTE on findChartSvgInTile()'s duplication below: this same tiny lookup —
// pick whichever <svg> in the tile has the MOST <path> children, rather
// than assuming a fixed index — needs to run inside TWO separate
// page.evaluate() calls (waitForDonutTileReady + the segment-finder in
// scrapeDonutTile). Since evaluate() callbacks can't reference outer JS
// scope, it's inlined in both rather than shared, same as every other
// scraper in this codebase nests its DOM helpers directly inside
// evaluate()/page.evaluate() calls. CONFIRMED via live testing that "the
// 2nd svg is always the chart" (the original assumption) does NOT hold
// across different tiles — works for "SLA status by channel", silently
// finds nothing for "Satisfaction distribution by channel", which
// apparently has a different icon-button layout shifting which svg is
// which. Icon svgs (menu/kebab buttons etc.) have only 1-2 paths; a real
// arc-based chart has many more.
async function waitForDonutTileReady(lookerFrame, title, maxMs = 15000) {
  const deadline = Date.now() + maxMs
  while (Date.now() < deadline) {
    const ready = await lookerFrame.evaluate(t => {
      function findChartSvgInTile(tile) {
        const svgs = Array.from(tile.querySelectorAll('svg'))
        let best = null, bestCount = 2 // require MORE than an icon's typical 1-2 paths
        svgs.forEach(svg => {
          const c = svg.querySelectorAll('path').length
          if (c > bestCount) { bestCount = c; best = svg }
        })
        return best
      }
      const h2 = Array.from(document.querySelectorAll('h2')).find(el => el.innerText.trim() === t)
      const tile = h2?.closest('.react-grid-item')
      return !!(tile && findChartSvgInTile(tile))
    }, title).catch(() => false)
    if (ready) return true
    await new Promise(r => setTimeout(r, 500))
  }
  return false
}

// Frame-relative viewport coordinates (from getScreenCTM, same coordinate
// space as clientX/clientY within that frame) need the Looker iframe's own
// on-page position added to become real page.mouse coordinates, since the
// donut chart lives one iframe deep from the top-level page.
async function frameToPageCoords(lookerFrame, frameX, frameY) {
  const frameElement = await lookerFrame.frameElement()
  const box = await frameElement.boundingBox()
  return { x: box.x + frameX, y: box.y + frameY }
}

const DONUT_TOOLTIP_NEEDLES = ['Within SLA', 'Breached', 'Nearing breach', 'CSAT', 'Satisfied', 'Dissatisfied', 'Neutral']

// CONFIRMED via live testing: a stale tooltip from the PREVIOUS hover can
// still be sitting in the DOM when the next segment (or next tile) starts
// checking, producing a result attributed to the wrong segment entirely.
// Actively wait for it to clear rather than assuming a mouse-move-away is
// enough on its own.
async function waitForDonutTooltipCleared(frame, maxMs = 2000) {
  const deadline = Date.now() + maxMs
  while (Date.now() < deadline) {
    const stillThere = await frame.evaluate(needles =>
      !!Array.from(document.querySelectorAll('body *')).find(el =>
        el.children.length === 0 && needles.some(n => (el.innerText || '').includes(n))
      ), DONUT_TOOLTIP_NEEDLES
    ).catch(() => false)
    if (!stillThere) return
    await new Promise(r => setTimeout(r, 150))
  }
}

async function hoverAndReadDonutTooltip(page, lookerFrame, pageX, pageY) {
  await page.mouse.move(pageX - 50, pageY - 50)
  await page.waitForTimeout(200)
  await page.mouse.move(pageX, pageY, { steps: 15 })

  const readTooltip = needles => {
    const leaf = Array.from(document.querySelectorAll('body *')).find(el =>
      el.children.length === 0 && needles.some(n => (el.innerText || '').includes(n))
    )
    return leaf?.parentElement?.innerText.trim() || null
  }

  for (let i = 0; i < 8; i++) {
    const text = await lookerFrame.evaluate(readTooltip, DONUT_TOOLTIP_NEEDLES).catch(() => null)
    if (text) return text
    await page.mouse.move(pageX + (i % 2 === 0 ? 1 : -1), pageY, { steps: 3 })
    await page.waitForTimeout(250)
  }
  return null
}

async function scrapeDonutTile(page, lookerFrame, title) {
  const ready = await waitForDonutTileReady(lookerFrame, title)
  if (!ready) return []

  // Make sure nothing is left over from whatever was hovered just before
  // this tile started (see waitForDonutTooltipCleared's reasoning above).
  await waitForDonutTooltipCleared(lookerFrame)

  // Tag each arc segment with a stable index, and compute a FEW candidate
  // points along its length (not just the midpoint) — donut charts commonly
  // draw a full background ring UNDER a smaller foreground arc, so a point
  // exactly at 50% length can land on a seam that's visually covered by a
  // DIFFERENT segment (CONFIRMED live: this caused duplicate/missing
  // categories when only the midpoint was tried).
  const segments = await lookerFrame.evaluate(t => {
    function findChartSvgInTile(tile) {
      const svgs = Array.from(tile.querySelectorAll('svg'))
      let best = null, bestCount = 2
      svgs.forEach(svg => {
        const c = svg.querySelectorAll('path').length
        if (c > bestCount) { bestCount = c; best = svg }
      })
      return best
    }
    const h2 = Array.from(document.querySelectorAll('h2')).find(el => el.innerText.trim() === t)
    const tile = h2?.closest('.react-grid-item')
    const chartSvg = tile && findChartSvgInTile(tile)
    const paths = Array.from(chartSvg?.querySelectorAll('path') || [])
    return paths.map((p, i) => {
      p.setAttribute('data-flex-idx', String(i))
      const len = p.getTotalLength()
      const candidates = [0.5, 0.25, 0.75, 0.35, 0.65].map(f => {
        const pt = p.getPointAtLength(len * f)
        const sp = pt.matrixTransform(p.getScreenCTM())
        return { x: sp.x, y: sp.y }
      })
      return { idx: i, candidates }
    })
  }, title).catch(() => [])

  const results = []
  for (const seg of segments) {
    let tooltipText = null
    for (const cand of seg.candidates) {
      // Verify this exact point resolves to THIS path before trusting
      // whatever tooltip shows up — cheap check, avoids acting on a point
      // that's actually covered by an overlapping segment.
      const isOnThisPath = await lookerFrame.evaluate(({ x, y, idx }) => {
        const el = document.elementFromPoint(x, y)
        return !!el?.closest(`path[data-flex-idx="${idx}"]`)
      }, { x: cand.x, y: cand.y, idx: seg.idx }).catch(() => false)
      if (!isOnThisPath) continue

      const { x: pageX, y: pageY } = await frameToPageCoords(lookerFrame, cand.x, cand.y)
      tooltipText = await hoverAndReadDonutTooltip(page, lookerFrame, pageX, pageY)
      if (tooltipText) break
    }

    if (tooltipText) {
      const lines = tooltipText.split('\n').map(s => s.trim()).filter(Boolean)
      if (lines.length >= 3) {
        const [channel, category, value] = lines
        results.push({ tile: title, label: `${channel} - ${category}`, value })
      }
    }

    // Confirm the tooltip actually cleared before the NEXT segment starts —
    // not just fire-and-forget a mouse move (see reasoning above).
    await page.mouse.move(10, 10).catch(() => {})
    await waitForDonutTooltipCleared(lookerFrame)
  }

  // Defensive dedupe by (tile,label) — even with the elementFromPoint
  // verification above, keep only the first result per key rather than
  // risk a duplicate slipping through some edge case.
  const seen = new Set()
  return results.filter(r => {
    const key = `${r.tile}|${r.label}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

async function scrapeAllDonutTiles(page, lookerFrame) {
  const results = []
  for (const title of DONUT_TILE_TITLES) {
    try {
      const tileResults = await scrapeDonutTile(page, lookerFrame, title)
      results.push(...tileResults)
    } catch (err) {
      console.warn(`[flex] donut tile "${title}" scrape failed: ${err.message}`)
    }
  }
  return results
}

// The Looker iframe (and the dashboard frame nested inside it) can take
// several seconds to appear after the explore page itself loads — CONFIRMED
// via live testing to need polling, not a fixed short wait (observed taking
// ~5-6s on a fresh navigation). Cheap no-op on later ticks once it already
// exists.
async function waitForLookerFrame(page, maxMs = 20000) {
  const deadline = Date.now() + maxMs
  while (Date.now() < deadline) {
    const f = findLookerDashboardFrame(page)
    if (f) return f
    await page.waitForTimeout(1000)
  }
  return null
}

// One attempt at reading the whole dashboard. Returns both the scraped
// results AND whether tiles clearly rendered at all (titleCount > 0) — the
// caller uses that to tell "the dashboard is just slow to load" apart from
// "the dashboard rendered its tile shells but every widget errored", which
// is a known, apparently common Looker/Explore failure mode (each tile
// shows an error icon instead of data) that a full page reload usually
// clears.
async function scrapeExploreDashboardAttempt(page) {
  const lookerFrame = await waitForLookerFrame(page)
  if (!lookerFrame) return { results: [], titleCount: 0 }

  // The frame existing doesn't mean its React content has mounted yet —
  // CONFIRMED via live testing (the frame can sit there for several more
  // seconds with zero tile titles rendered). Poll rather than proceed
  // immediately — this is also what gives a widget error the time it needs
  // to actually surface, rather than mistaking "still loading" for "broken".
  let titleCount = 0
  for (let i = 0; i < 20; i++) {
    titleCount = await lookerFrame.locator('[class*="ElementTitle"]').count().catch(() => 0)
    if (titleCount > 0) break
    await page.waitForTimeout(1000)
  }
  if (titleCount === 0) return { results: [], titleCount: 0 }

  await scrollLookerDashboardIntoView(lookerFrame)

  const titleLocators = lookerFrame.locator('[class*="ElementTitle"]')
  const count = await titleLocators.count().catch(() => 0)
  const seenTitles = new Set()
  for (let i = 0; i < count; i++) {
    const t = (await titleLocators.nth(i).innerText().catch(() => '')).trim()
    if (t) seenTitles.add(t)
  }
  const multiValueTitles = [...seenTitles].filter(t => !DONUT_TILE_TITLES.includes(t))

  const multiValueResults = await scrapeMultipleValueTiles(page, lookerFrame, multiValueTitles)
  const donutResults = await scrapeAllDonutTiles(page, lookerFrame)

  return { results: [...multiValueResults, ...donutResults], titleCount, multiValueTileCount: multiValueTitles.length }
}

// Tile shells rendering (titles visible) but EVERY multi-value tile coming
// back with zero data points is the known widget-error signature (each
// tile shows an error icon in place of its chart/numbers instead of the
// dashboard just still loading — the poll above already gives it generous
// time to load normally). "Satisfaction distribution by channel" is
// deliberately excluded from this check — it never produces data regardless
// of dashboard health (see file header), so its absence alone must never
// trigger a reload, or this would reload forever on every single tick.
function looksLikeWidgetError(attempt) {
  return attempt.titleCount > 0 && attempt.multiValueTileCount > 0 &&
    !attempt.results.some(r => r.tile !== 'Satisfaction distribution by channel')
}

async function scrapeExploreDashboard(page) {
  let attempt = await scrapeExploreDashboardAttempt(page)

  if (looksLikeWidgetError(attempt)) {
    console.warn('[flex] Explore dashboard tiles rendered but every widget came back empty (looks like the known Looker widget-error state) — reloading and retrying once...')
    await page.reload({ waitUntil: 'domcontentloaded', timeout: 30000 }).catch(e => {
      console.warn(`[flex] Explore reload failed: ${e.message}`)
    })
    attempt = await scrapeExploreDashboardAttempt(page)
  }

  return attempt.results
}

// ── Write to Supabase ──────────────────────────────────────────────────────
async function writeFlexData(tickets, accountId) {
  if (!tickets || tickets.length === 0) return
  const now = new Date().toISOString()
  const rows = tickets.map(t => ({
    id:             `${accountId}:${t.id}`,
    account_id:     accountId,
    ticket_id:      t.id,
    priority_group: t.priorityGroup,
    ticket_status:  t.ticketStatus,
    priority:       t.priority,
    sla_text:       t.slaText,
    sla_short:      t.slaShort,
    subject:        t.subject,
    requester:      t.requester,
    requested:      t.requested,
    ticket_group:   t.group,
    assignee:       t.assignee,
    category:       t.category,
    channel:        t.channel,
    updated_at:     now,
  }))
  const deduped = dedupeById(rows)
  await pruneDeparted('flex_tickets', accountId, new Set(deduped.map(r => r.id)))
  await supabaseUpsert('flex_tickets', deduped)
  console.log(`[flex] ✅ Tickets written (${deduped.length})`)
}

async function writeFlexSlaWatch(tickets, accountId) {
  if (!tickets || tickets.length === 0) return
  const now = new Date().toISOString()
  const rows = tickets.map(t => ({
    id:             `${accountId}:${t.ticketId}`,
    account_id:     accountId,
    ticket_id:      t.ticketId,
    subject:        t.subject,
    assignee:       t.assignee,
    assignee_tags:  t.assigneeTags,
    next_breach_at: t.nextBreachAt,
    ticket_group:   t.ticketGroup,
    updated_at:     now,
  }))
  const deduped = dedupeById(rows)
  await pruneDeparted('flex_sla_watch', accountId, new Set(deduped.map(r => r.id)))
  await supabaseUpsert('flex_sla_watch', deduped)
  console.log(`[flex] ✅ SLA-watch tickets written (${deduped.length})`)
}

async function writeFlexExploreTiles(tiles, accountId) {
  if (!tiles || tiles.length === 0) return
  const now = new Date().toISOString()
  const sanitize = s => String(s || '').replace(/\s+/g, '_').toLowerCase().replace(/[^a-z0-9_]/g, '')
  const rows = tiles.map(t => ({
    id:         `${accountId}:${sanitize(t.tile)}:${sanitize(t.label)}`,
    account_id: accountId,
    tile:       t.tile,
    label:      t.label,
    value:      t.value,
    updated_at: now,
  }))
  const deduped = dedupeById(rows)
  // No pruneDeparted here — unlike ticket lists, a tile/label combo that
  // doesn't appear this tick usually just means it hasn't scrolled into
  // view yet (lazy-load), not that it stopped existing. Rows are simply
  // overwritten in place whenever their tile IS visible.
  await supabaseUpsert('flex_explore_tiles', deduped)
  console.log(`[flex] ✅ Explore tiles written (${deduped.length})`)
}

// ── Module exports ────────────────────────────────────────────────────────────
module.exports = {
  meta: {
    type:        'zendesk',
    interval:    30000,
    manualLogin: true,   // kept as a fallback — see attemptGoogleSignIn()'s comment
  },

  // ── Login: try automated "Sign in with Google" first (see
  // attemptGoogleSignIn() — works because the persisted profile already
  // remembers this account's Google session), falling back to waiting for a
  // human if that doesn't fully resolve (e.g. the remembered session ever
  // needs fresh password/2FA consent) — same optimistic-then-fallback pattern
  // as scrapers/edenhealth/index.js. account-runner.js already re-checks
  // isSessionExpired() after this returns for every manualLogin account, so
  // no extra plumbing is needed here beyond just trying.
  async login(page, context, account, sessionPath) {
    page.on('pageerror', err => console.warn(`[flex page error] ${err.message}`))
    page.on('dialog', d => d.dismiss().catch(() => {})) // see ensureExplorePage's comment — a beforeunload dialog on ANY page can hang every future Playwright call on it

    await page.goto(account.dashboardUrl, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(e => {
      console.warn(`[flex] goto failed: ${e.message}`)
    })
    await page.waitForTimeout(1500)

    if (isLoginUrl(page.url())) {
      const signedIn = await attemptGoogleSignIn(page, account)
      if (!signedIn) {
        console.log('[flex] Automated sign-in did not complete — waiting for human (resume flex once done)...')
        return
      }
    }

    if (!page.url().includes('/agent/filters/')) {
      await page.goto(account.dashboardUrl, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {})
    }

    await waitForTicketTable(page).catch(e => {
      console.warn(`[flex] ticket table never appeared: ${e.message}`)
    })

    if (account.geckoboardUrl) {
      await ensureGeckoboardPage(context, account)
    } else {
      console.log('[flex] No geckoboardUrl configured — skipping the SLA-breach widget until it is set in config.json')
    }

    if (account.exploreUrl) {
      await ensureExplorePage(context, account)
    } else {
      console.log('[flex] No exploreUrl configured — skipping the Explore dashboard until it is set in config.json')
    }
  },

  // ── Session-expiry check ─────────────────────────────────────────────────────
  isSessionExpired(page) {
    return isLoginUrl(page.url())
  },

  // ── Scrape: every ticket across every page of the General view ─────────────
  async scrape(page, account) {
    if (isLoginUrl(page.url())) return { hasData: false }

    // Always re-navigate to the view URL first — the simplest reliable way
    // to guarantee clean page-1 pagination state every tick, rather than
    // trying to click "Previous" back from wherever last tick's "Next"
    // clicking left off.
    await page.goto(account.dashboardUrl, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {})

    // account-runner.js's own isSessionExpired()+auto-login retry only runs
    // BEFORE this scrape() call — if the session was fine at tick-start but
    // THIS goto() itself lands on the login page (expired sometime between
    // ticks), that gap was never caught. Attempt sign-in right here too
    // instead of silently returning empty.
    if (isLoginUrl(page.url())) {
      console.log('[flex] Main page session expired mid-tick — attempting automated Google sign-in...')
      const signedIn = await attemptGoogleSignIn(page, account)
      if (signedIn) {
        await page.goto(account.dashboardUrl, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {})
      } else {
        console.warn('[flex] Main page automated sign-in did not complete — will retry next tick')
        return { hasData: false }
      }
    }

    await waitForTicketTable(page).catch(() => {})

    let tickets = []
    try {
      tickets = await scrapeAllTickets(page)
    } catch (err) {
      console.warn(`[flex] ticket scrape failed: ${err.message}`)
    }

    let slaWatch = []
    if (account.geckoboardUrl) {
      try {
        const gbPage = await ensureGeckoboardPage(page.context(), account)
        const frame = await getGeckoboardFrame(gbPage)
        if (frame) {
          await waitForSlaWidgetRows(frame)
          slaWatch = await frame.evaluate(scrapeSlaBreachWidget)
        } else {
          console.warn('[flex] Geckoboard iframe never appeared (will retry next tick)')
        }
      } catch (err) {
        console.warn(`[flex] Geckoboard SLA-watch scrape failed: ${err.message}`)
      }
    }

    let exploreTiles = []
    if (account.exploreUrl) {
      try {
        const explorePage = await ensureExplorePage(page.context(), account)
        exploreTiles = await withTimeout(scrapeExploreDashboard(explorePage), 120000, '[flex] Explore dashboard scrape')
      } catch (err) {
        console.warn(`[flex] Explore dashboard scrape failed: ${err.message}`)
      }
    }

    if (tickets.length === 0 && slaWatch.length === 0 && exploreTiles.length === 0) return { hasData: false }
    return { hasData: true, tickets, slaWatch, exploreTiles, snapshotTime: new Date().toISOString() }
  },

  // ── Write to Supabase ──────────────────────────────────────────────────────
  async write(data, accountId) {
    if (!data || !data.hasData) return
    // Each of the three sources writes to its OWN table — isolated so a
    // problem with one (e.g. a table that hasn't been created yet, or a
    // scrape shape that's temporarily off) can't silently block the other
    // two from persisting this tick, which `await`ing them in a bare
    // sequence would otherwise do (the first thrown error stops the rest).
    await writeFlexData(data.tickets, accountId).catch(err => console.warn(`[flex] flex_tickets write failed: ${err.message}`))
    await writeFlexSlaWatch(data.slaWatch, accountId).catch(err => console.warn(`[flex] flex_sla_watch write failed: ${err.message}`))
    await writeFlexExploreTiles(data.exploreTiles, accountId).catch(err => console.warn(`[flex] flex_explore_tiles write failed: ${err.message}`))
  },

  // ── Terminal dashboard display ─────────────────────────────────────────────
  getDisplayInfo(data) {
    if (!data) return { sla: '--', waiting: '0', agents: '--', info: '' }
    const tickets  = data.tickets || []
    const breached = tickets.filter(t => /breached/i.test(t.slaText)).length
    return {
      sla:     '--',
      waiting: String(tickets.length),
      agents:  '--',
      info:    `${tickets.length} ticket(s), ${breached} breached, ${data.slaWatch?.length || 0} nearing SLA, ${data.exploreTiles?.length || 0} explore value(s)`,
    }
  },
}
