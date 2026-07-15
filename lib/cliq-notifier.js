// lib/cliq-notifier.js
// Zoho Cliq breach-notification loop — runs entirely inside this already-
// running scraper process (no Vercel Cron, no extra hosting). On its own
// interval, reads each account's live KPI/agent Supabase data + configured
// thresholds (the SAME wfm_settings rows the Next.js dashboard reads), runs
// the breach algorithm ported in lib/breach-detector.js, and posts an alert
// to that account's configured Zoho Cliq channel — mirroring the WFM Live
// dashboard's own Breach/Anomalies detection, just running server-side on a
// schedule instead of only while a browser tab is open.
//
// Migrated from the old Google Apps Script tool's CliqNotifier.gs — same
// overall shape (global enable/test-mode/frequency settings, per-account
// channel + cooldown, staleness suppression, [TEST]-prefixed messages) but
// re-authenticates via a locally-cached Zoho refresh token instead of Apps
// Script's OAuth2 library, and reads thresholds from Supabase instead of
// Google Sheets/Drive.
//
// Required .env vars: SUPABASE_URL, SUPABASE_KEY, ZOHO_CLIQ_CLIENT_ID,
// ZOHO_CLIQ_CLIENT_SECRET, ZOHO_CLIQ_REFRESH_TOKEN. If any Zoho var is
// missing, the notifier logs once and simply never ticks — every other
// account/scraper feature keeps working unaffected.

'use strict'

const { buildBreaches, isDataStale, mostRecentUpdatedAt } = require('./breach-detector')

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL
const SUPABASE_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || process.env.SUPABASE_KEY

const ZOHO_CLIENT_ID     = process.env.ZOHO_CLIQ_CLIENT_ID
const ZOHO_CLIENT_SECRET = process.env.ZOHO_CLIQ_CLIENT_SECRET
const ZOHO_REFRESH_TOKEN = process.env.ZOHO_CLIQ_REFRESH_TOKEN

const ZOHO_TOKEN_URL = 'https://accounts.zoho.com/oauth/v2/token'
const CLIQ_MESSAGE_URL = channel => `https://cliq.zoho.com/api/v2/channelsbyname/${encodeURIComponent(channel)}/message`

const TICK_MS = 60000   // how often to scan — the per-account cooldown (frequency_minutes) governs actual send rate

// ── Supabase REST helpers (same raw-fetch pattern as lib/db.js's supabaseUpsert) ─
async function supabaseSelect(table, query) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${table}?${query}`, {
    headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` },
  })
  if (!res.ok) throw new Error(`Supabase select [${table}] failed ${res.status}: ${await res.text()}`)
  return res.json()
}

async function supabaseUpsertRow(table, row) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${table}`, {
    method: 'POST',
    headers: {
      apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}`,
      'Content-Type': 'application/json', Prefer: 'resolution=merge-duplicates',
    },
    body: JSON.stringify([row]),
  })
  if (!res.ok) throw new Error(`Supabase upsert [${table}] failed ${res.status}: ${await res.text()}`)
}

// ── Agent row fetch + normalization — mirrors Dashboard.tsx's fetchAgentSource
// exactly: legacy agentTable (if set) PLUS every agentSources[] entry are
// UNIONED (additive, not either/or), each normalized to the same
// _name/_status/_duration/_durationSecs/_agentGroup shape. ───────────────────
async function fetchAgentSource(src, accountId) {
  if (!src.table) return []
  const accountCol = src.accountCol || 'account_id'
  let rows
  try {
    rows = await supabaseSelect(src.table, `${encodeURIComponent(accountCol)}=eq.${encodeURIComponent(accountId)}&select=*`)
  } catch (e) {
    return []
  }
  return rows.map(r => ({
    ...r,
    _agentGroup:   src.groupByCol ? String(r[src.groupByCol] ?? '') : src.label,
    _name:         String(r[src.nameCol] ?? ''),
    _status:       String(r[src.statusCol] ?? ''),
    _duration:     String(r[src.durationCol] ?? ''),
    _durationSecs: src.durationSecsCol ? String(r[src.durationSecsCol] ?? '') : '',
  }))
}

async function fetchAccountData(ds, accountId) {
  const kpiRows = ds.kpiTable
    ? await supabaseSelect(ds.kpiTable, `${encodeURIComponent(ds.kpiAccountCol || 'account_id')}=eq.${encodeURIComponent(accountId)}&select=*`).catch(() => [])
    : []

  const agentSourcesToFetch = []
  if (ds.agentTable) {
    agentSourcesToFetch.push({
      label: ds.agentTable, groupByCol: '',
      table: ds.agentTable, accountCol: ds.agentAccountCol,
      nameCol: ds.agentNameCol, statusCol: ds.agentStatusCol,
      durationCol: ds.agentDurationCol, durationSecsCol: ds.agentDurationSecs,
    })
  }
  if (ds.agentSources) agentSourcesToFetch.push(...ds.agentSources)
  const agentLists = await Promise.all(agentSourcesToFetch.map(src => fetchAgentSource(src, accountId)))

  return { kpiRows, agents: agentLists.flat() }
}

// ── Zoho OAuth — refresh-token grant, in-memory access-token cache ──────────
let _accessToken = null
let _accessTokenExpiresAt = 0

async function getZohoAccessToken() {
  if (_accessToken && Date.now() < _accessTokenExpiresAt - 60000) return _accessToken

  const res = await fetch(ZOHO_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type:    'refresh_token',
      refresh_token: ZOHO_REFRESH_TOKEN,
      client_id:     ZOHO_CLIENT_ID,
      client_secret: ZOHO_CLIENT_SECRET,
    }),
  })
  const data = await res.json()
  if (!res.ok || !data.access_token) throw new Error(`Zoho token refresh failed: ${JSON.stringify(data)}`)

  _accessToken = data.access_token
  _accessTokenExpiresAt = Date.now() + (data.expires_in || 3600) * 1000
  return _accessToken
}

async function sendCliqChannelMessage(channel, message) {
  const token = await getZohoAccessToken()
  const res = await fetch(CLIQ_MESSAGE_URL(channel), {
    method: 'POST',
    headers: { Authorization: `Zoho-oauthtoken ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: message }),
  })
  // Zoho returns 204 No Content on success — guard against an empty body.
  const text = await res.text()
  const body = text.trim() ? JSON.parse(text) : { success: true, status: res.status }
  const isApiError = !res.ok || body.error || body.status === 'failure' ||
    (body.code && String(body.code).toLowerCase() !== 'null' && String(body.code) !== '')
  if (isApiError) throw new Error(`Cliq send failed: ${JSON.stringify(body)}`)
  return body
}

// ── Message formatting — mirrors the old GAS tool's format ──────────────────
function formatMessage(accountId, breaches, testMode) {
  const prefix = testMode ? '[TEST] ' : ''
  const ts = new Date().toLocaleString('en-US', { timeZoneName: 'short' })
  const lines = [
    `${prefix}🚨 WFM BREACH ALERT — ${accountId.toUpperCase()}`,
    `Account: ${accountId}`,
    `Time: ${ts}`,
    '',
    `Active Breaches (${breaches.length}):`,
  ]
  breaches.forEach((b, i) => {
    const icon = b.severity === 'critical' ? '🔴' : '🟡'
    lines.push(`${icon} ${i + 1}. ${b.entity} — ${b.metric}: ${b.value} (threshold ${b.threshold})`)
  })
  if (testMode) {
    lines.push('')
    lines.push('⚠️ This is a TEST message. Disable Test Mode in Settings > Cliq Alerts when ready.')
  }
  return lines.join('\n')
}

// ── Main notifier ─────────────────────────────────────────────────────────────
class CliqNotifier {
  constructor(dash) {
    this.dash = dash
    this.timer = null
    this._running = false   // re-entrancy guard — a slow tick shouldn't overlap the next interval fire
    this._zohoConfigured = !!(ZOHO_CLIENT_ID && ZOHO_CLIENT_SECRET && ZOHO_REFRESH_TOKEN)
  }

  start() {
    if (!this._zohoConfigured) {
      this.dash.warn(null, '[cliq] ZOHO_CLIQ_CLIENT_ID/CLIENT_SECRET/REFRESH_TOKEN not set in .env — Cliq notifications disabled.')
      return
    }
    this.dash.log(null, '[cliq] Breach notifier started — scanning every 60s (per-account cooldown still applies).')
    this.timer = setInterval(() => this.tick().catch(e => this.dash.warn(null, `[cliq] tick failed: ${e.message}`)), TICK_MS)
  }

  stop() {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  /** Force one immediate scan — used by the `cliqscan` terminal command.
   *  Bypasses cooldown, but NOT the staleness suppression (mirrors the old
   *  GAS tool's force-scan behavior exactly). */
  async forceScan() {
    if (!this._zohoConfigured) {
      this.dash.warn(null, '[cliq] Cannot force-scan — Zoho credentials not configured in .env.')
      return
    }
    await this.tick({ forceSend: true, verbose: true })
  }

  async tick(opts) {
    const forceSend = !!(opts && opts.forceSend)
    const verbose   = !!(opts && opts.verbose)
    if (this._running) return
    this._running = true
    const log = (msg) => { if (verbose) this.dash.log(null, `[cliq] ${msg}`) }

    try {
      const globalSettings = await this._loadGlobalSettings()
      if (!globalSettings.enabled) { log('Disabled globally — nothing to do.'); return }

      const accounts = await supabaseSelect(
        'wfm_settings',
        'select=id,data_source,kpi_thresholds,status_thresholds,cliq_channel,cliq_last_sent_at'
      ).catch(e => { this.dash.warn(null, `[cliq] Failed to load accounts: ${e.message}`); return [] })

      const qualifying = accounts.filter(a => a.cliq_channel && a.data_source)
      log(`${accounts.length} account(s) total, ${qualifying.length} with a Cliq channel configured.`)

      for (const acc of qualifying) {
        try {
          await this._processAccount(acc, globalSettings, forceSend, log)
        } catch (e) {
          // Per-account try/catch — one account's failure must not skip everyone else.
          this.dash.warn(acc.id, `[cliq] scan failed: ${e.message}`)
        }
      }
    } finally {
      this._running = false
    }
  }

  async _loadGlobalSettings() {
    try {
      const rows = await supabaseSelect('wfm_cliq_settings', "id=eq.global&select=enabled,test_mode,frequency_minutes")
      const row = rows[0]
      if (!row) return { enabled: false, testMode: true, frequencyMinutes: 5 }
      return {
        enabled: !!row.enabled,
        testMode: row.test_mode !== false,
        frequencyMinutes: row.frequency_minutes || 5,
      }
    } catch (e) {
      this.dash.warn(null, `[cliq] Failed to load global settings (defaulting to disabled): ${e.message}`)
      return { enabled: false, testMode: true, frequencyMinutes: 5 }
    }
  }

  async _processAccount(acc, globalSettings, forceSend, log) {
    const accountId = acc.id
    const ds = acc.data_source
    const kpiTh = acc.kpi_thresholds || {}
    const statusTh = acc.status_thresholds || {}

    if (!forceSend) {
      const lastSent = acc.cliq_last_sent_at ? new Date(acc.cliq_last_sent_at).getTime() : 0
      const cooldownMs = globalSettings.frequencyMinutes * 60 * 1000
      if (Date.now() - lastSent < cooldownMs) {
        log(`${accountId}: within cooldown (${globalSettings.frequencyMinutes}m) — skipping.`)
        return
      }
    }

    const accountData = await fetchAccountData(ds, accountId)

    // Staleness suppression — mirrors the dashboard's own "DATA NOT IN SYNC"
    // overlay (5 min). Applies even on a forced scan: stale data can't
    // reliably trigger an alert regardless of how the scan was triggered.
    const freshest = mostRecentUpdatedAt(accountData.kpiRows, ds.kpiUpdatedAt)
    if (isDataStale(freshest)) {
      log(`${accountId}: DATA NOT IN SYNC (freshest=${freshest || 'none'}) — suppressing.`)
      return
    }

    const breaches = buildBreaches(accountData, kpiTh, statusTh, ds)
    log(`${accountId}: ${breaches.length} breach(es).`)
    if (breaches.length === 0) return

    const message = formatMessage(accountId, breaches, globalSettings.testMode)
    await sendCliqChannelMessage(acc.cliq_channel, message)
    log(`${accountId}: sent to #${acc.cliq_channel}.`)

    // Cooldown only advances on a CONFIRMED send — a failed Cliq API call
    // (thrown above, caught by the per-account try/catch in tick()) must not
    // silently eat the cooldown window.
    await supabaseUpsertRow('wfm_settings', { id: accountId, account_id: accountId, cliq_last_sent_at: new Date().toISOString() })
  }
}

module.exports = CliqNotifier
