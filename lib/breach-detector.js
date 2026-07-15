// lib/breach-detector.js
// Faithful, dependency-free port of the WFM Live Dashboard's own breach-
// detection algorithm (components/Dashboard.tsx's buildBreaches()/checkKpi,
// lib/utils.ts's resolveCell/extractPercent/parseDurationToSeconds/
// isDataStale) — reimplemented here in plain Node so the same rules can run
// server-side, in this always-on scraper process, instead of only in a
// browser tab. Ported line-for-line from the TS source, not reinvented —
// see components/Dashboard.tsx / lib/utils.ts in the wfm-live-dashboard repo
// if these two ever need to be reconciled after a future dashboard change.
//
// No live in-memory ticking timer here (that's a browser-UI-only feature in
// the dashboard, used to count up an agent's duration between polls) — this
// always resolves duration straight from the scraped `_duration` string,
// which is the exact fallback the dashboard itself uses when no timer entry
// exists yet.

'use strict'

/** Read a single value from fetched KPI rows using a cell binding. Narrows by
 *  the group value (groupCol=groupVal) AND the cell's row match, so a 2-D
 *  table (skill × metric) resolves to exactly one row. */
function resolveCell(rows, binding, groupCol, groupVal) {
  if (!binding || !binding.valueCol) return ''
  const hasMatch = !!(binding.matchCol && binding.matchVal !== undefined && binding.matchVal !== '')
  const byMatch = arr =>
    hasMatch ? arr.filter(r => String(r[binding.matchCol] ?? '') === String(binding.matchVal)) : arr

  let cands = rows
  if (groupCol && groupVal !== undefined && groupVal !== '') {
    cands = cands.filter(r => String(r[groupCol] ?? '') === String(groupVal))
  }
  cands = byMatch(cands)

  // Fallback: if the group filter eliminated everything but the row key is
  // set (kpi_key/id is unique on its own), resolve by the row key alone.
  // Guards against a stale/mismatched group value.
  if (cands.length === 0 && hasMatch) cands = byMatch(rows)

  const row = cands[0]
  return row ? String(row[binding.valueCol] ?? '') : ''
}

function extractPercent(str) {
  if (!str || str === 'N/A' || str === '-') return NaN
  const cleaned = String(str).replace(/\s+/g, '')
  const m = cleaned.match(/([\d.]+)%/)
  if (m) return parseFloat(m[1])
  const n = parseFloat(cleaned)
  return isNaN(n) ? NaN : n
}

function parseDurationToSeconds(str) {
  if (!str) return 0
  const s = String(str).trim()
  if (/^\d+(\.\d+)?$/.test(s)) return Math.round(parseFloat(s))
  const parts = s.split(':').map(Number)
  if (parts.every(p => !isNaN(p))) {
    if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2]
    if (parts.length === 2) return parts[0] * 60 + parts[1]
  }
  let total = 0
  const d  = s.match(/(\d+)\s*d/i);      if (d)  total += parseInt(d[1]) * 86400
  const h  = s.match(/(\d+)\s*h/i);      if (h)  total += parseInt(h[1]) * 3600
  const m  = s.match(/(\d+)\s*m(?!s)/i); if (m)  total += parseInt(m[1]) * 60
  const sc = s.match(/(\d+)\s*s/i);      if (sc) total += parseInt(sc[1])
  return total
}

// Same 5-minute threshold as the live dashboard's "DATA NOT IN SYNC" overlay
// (lib/utils.ts's isDataStale) — kept in sync with what's visually shown on
// screen, not the old GAS tool's separate 3-minute constant.
function isDataStale(updatedAt) {
  if (!updatedAt) return false
  return Date.now() - new Date(updatedAt).getTime() > 5 * 60 * 1000
}

/** Freshest updated_at across all of an account's KPI rows — an orphaned row
 *  from a LOB the scraper no longer reports would otherwise make the whole
 *  account look stale even though the LOBs actually shown are live. */
function mostRecentUpdatedAt(rows, colName) {
  let best
  for (const row of rows) {
    const v = row && row[colName]
    if (!v) continue
    if (!best || new Date(v).getTime() > new Date(best).getTime()) best = v
  }
  return best
}

/** Build the list of active breaches for one account.
 *  accountData: { kpiRows: object[], agents: object[] } — agents already
 *  normalized to _name/_status/_duration (see fetchAgentRows in
 *  lib/cliq-notifier.js, which mirrors Dashboard.tsx's fetchAgentSource).
 *  Returns [{ entity, metric, value, threshold, severity }]. */
function buildBreaches(accountData, kpiTh, statusTh, ds) {
  const rows = []
  const kpiRows = (accountData && accountData.kpiRows) || []

  const checkKpi = (num, th, entity, metric, value, thLabel) => {
    if (isNaN(num)) return
    if (th.excludeZero && num === 0) return
    const isCrit = th.direction === 'desc' ? num <= th.crit : num >= th.crit
    const isWarn = th.direction === 'desc' ? num <= th.warn : num >= th.warn
    if (isCrit)      rows.push({ entity, metric, value, threshold: thLabel, severity: 'critical' })
    else if (isWarn) rows.push({ entity, metric, value, threshold: thLabel, severity: 'warning' })
  }

  // KPI breaches — one pass per manually-defined group
  ;(ds.groups || []).forEach(group => {
    const g       = group.name || 'KPI'
    const rc      = b => resolveCell(kpiRows, b, ds.kpiGroupCol, group.groupVal)
    const slaRaw  = rc(group.cells.sla)
    const waitRaw = rc(group.cells.wait)
    const ahtRaw  = rc(group.cells.aht)
    const abnRaw  = rc(group.cells.abn)

    if (group.cells.sla)  checkKpi(extractPercent(slaRaw), kpiTh.sla, g, ds.kpiLabels.sla, slaRaw.replace(/\s+/g, ''), `≥${kpiTh.sla.targ}%`)
    if (group.cells.wait) { const n = parseInt(waitRaw || '0', 10); checkKpi(n, kpiTh.wait, g, ds.kpiLabels.wait, String(n), String(kpiTh.wait.targ)) }
    if (group.cells.aht)  { const m = Math.round(parseDurationToSeconds(ahtRaw) / 60); if (m > 0) checkKpi(m, kpiTh.aht, g, ds.kpiLabels.aht, ahtRaw, `<${kpiTh.aht.targ}m`) }
    if (group.cells.abn)  checkKpi(extractPercent(abnRaw), kpiTh.abn, g, ds.kpiLabels.abn, abnRaw.replace(/\s+/g, ''), `<${kpiTh.abn.targ}%`)

    // Extra custom tiles carry their own thresholds
    ;(ds.extraTiles || []).forEach(t => {
      if (!group.cells[t.key]) return
      const raw = rc(group.cells[t.key])
      const num = extractPercent(raw)
      if (isNaN(num)) return
      const dir = t.higherIsBetter ? 'desc' : 'asc'
      checkKpi(num, { warn: t.warn, crit: t.crit, direction: dir }, g, t.label, raw, String(t.targ))
    })
  })

  // Agent status breaches — agents are pre-normalized to _name/_status/_duration
  // (see fetchAgentRows in lib/cliq-notifier.js).
  ;(accountData.agents || []).forEach(a => {
    const status = String(a._status || '')
    const thSt = statusTh[status]
    if (!thSt || thSt.crit >= 999 || thSt.excluded) return
    const name = String(a._name || '')
    const secs = parseDurationToSeconds(String(a._duration || ''))
    const mins = secs / 60
    const dur  = formatSeconds(secs)
    if (mins >= thSt.crit)      rows.push({ entity: name, metric: `${status} Duration`, value: dur, threshold: `${thSt.crit}m`, severity: 'critical' })
    else if (mins >= thSt.warn) rows.push({ entity: name, metric: `${status} Duration`, value: dur, threshold: `${thSt.warn}m`, severity: 'warning' })
  })

  return rows
}

// Ported verbatim from lib/utils.ts's formatSeconds (dashboard repo) — same
// "1d 2h 3m 4s" composite format used in the Breach/Anomalies table's Value column.
function formatSeconds(totalSec) {
  totalSec = Math.round(Math.max(0, totalSec))
  const d = Math.floor(totalSec / 86400)
  const h = Math.floor((totalSec % 86400) / 3600)
  const m = Math.floor((totalSec % 3600) / 60)
  const s = totalSec % 60
  const parts = []
  if (d > 0) parts.push(`${d}d`)
  if (h > 0) parts.push(`${h}h`)
  if (m > 0) parts.push(`${m}m`)
  if (s > 0 || parts.length === 0) parts.push(`${s}s`)
  return parts.join(' ')
}

module.exports = {
  resolveCell, extractPercent, parseDurationToSeconds,
  isDataStale, mostRecentUpdatedAt, buildBreaches,
}
