// lib/terminal-dash.js
// Fixed-header terminal dashboard — each account gets its own row with
// live KPI data (SLA, Queue, Agents) that updates in place.

const W = 92  // total box width — fits in standard 100-col terminal

// ── ANSI helpers ──────────────────────────────────────────────────────────────
const ESC     = '\x1b'
const RESET   = `${ESC}[0m`
const BOLD    = `${ESC}[1m`
const DIM     = `${ESC}[2m`
const GREEN   = `${ESC}[32m`
const RED     = `${ESC}[31m`
const YELLOW  = `${ESC}[33m`
const CYAN    = `${ESC}[36m`
const WHITE   = `${ESC}[97m`
const ORANGE  = `${ESC}[38;5;208m`

const move    = (r, c) => `${ESC}[${r};${c}H`
const saveCur = `${ESC}[s`
const restCur = `${ESC}[u`
const hideCur = `${ESC}[?25l`
const showCur = `${ESC}[?25h`
const clrLine = `${ESC}[2K`

// ── Box drawing ───────────────────────────────────────────────────────────────
const INNER = W - 4   // usable content width inside ║  ...  ║
const TOP   = `╔${'═'.repeat(W - 2)}╗`
const SEP   = `╠${'═'.repeat(W - 2)}╣`
const BOT   = `╚${'═'.repeat(W - 2)}╝`

// Strip ANSI codes for visible-length calculation
const visLen = s => s.replace(/\x1b\[[0-9;]*m/g, '').length

function boxLine(content) {
  const pad = INNER - visLen(content)
  return `║  ${content}${' '.repeat(Math.max(0, pad))}  ║`
}

// ── Column layout (visible widths, no ANSI) ───────────────────────────────────
// ACCOUNT(18)  TIME(12)  STATUS(7)  SLA(13)  QUEUE(9)  AGENTS(8)  INFO(rest)
// Total fixed = 18+12+7+13+9+8 = 67  →  INFO gets INNER-67 = 88-67 = 21 chars
const C = {
  ACCOUNT: 18,
  TIME:    12,
  STATUS:  7,
  SLA:     13,
  QUEUE:   9,
  AGENTS:  8,
}
const INFO_W = INNER - Object.values(C).reduce((a, b) => a + b, 0)

// ── Format one account row ────────────────────────────────────────────────────
function formatRow(id, s) {
  // Status icon + text
  const icon   = s.error ? `${RED}✗${RESET}` : s.ok ? `${GREEN}✔${RESET}` : `${YELLOW}…${RESET}`
  const stTxt  = s.error ? `${RED}ERR${RESET}` : s.ok ? `${GREEN}OK${RESET}` : `${YELLOW}---${RESET}`
  const status = icon + ' ' + stTxt  // visible = 4 chars

  // SLA — color based on value
  const slaRaw = String(s.sla || '--').replace(/\s+/g, '')
  const slaNum = parseFloat(slaRaw)
  const slaColor = !isNaN(slaNum)
    ? (slaNum >= 80 ? GREEN : slaNum >= 70 ? YELLOW : RED)
    : DIM
  const slaStr = `SLA:${slaColor}${slaRaw}${RESET}`

  // Queue — color if > 0
  const qRaw    = String(s.waiting || '0')
  const qNum    = parseInt(qRaw) || 0
  const qColor  = qNum > 10 ? RED : qNum > 0 ? YELLOW : DIM
  const qStr    = `Q:${qColor}${qRaw}${RESET}`

  // Agents
  const agtStr  = `Agt:${s.agents || '--'}`

  // Info (extra context: calls, LOBs, error snippet)
  const infoRaw = s.error
    ? `${RED}${String(s.error).substring(0, INFO_W)}${RESET}`
    : (s.info || '').substring(0, INFO_W)

  // Build row — pad each column to its fixed visible width
  function pad(str, w) {
    const v = visLen(str)
    return str + ' '.repeat(Math.max(0, w - v))
  }

  return (
    pad(id,      C.ACCOUNT) +
    pad(s.time || '--:--', C.TIME) +
    pad(status,  C.STATUS) +
    pad(slaStr,  C.SLA) +
    pad(qStr,    C.QUEUE) +
    pad(agtStr,  C.AGENTS) +
    infoRaw
  )
}

// ── TerminalDash class ────────────────────────────────────────────────────────
class TerminalDash {
  constructor(accounts, intervalMs) {
    this.accounts   = accounts
    this.intervalMs = intervalMs
    this.states     = {}
    this._logRow    = 0
    this._acctRows  = {}

    accounts.forEach(a => {
      this.states[a.id] = {
        time: '--:--', ok: false,
        sla: '--', waiting: '0', agents: '--',
        info: 'initializing...', error: null
      }
    })
  }

  init() {
    this._logRow = 9 + this.accounts.length
    this.accounts.forEach((a, i) => { this._acctRows[a.id] = 6 + i })

    const termH = process.stdout.rows || 40
    process.stdout.write(`${ESC}[${this._logRow};${termH}r`)
    process.stdout.write(`${ESC}[2J`)
    process.stdout.write(move(1, 1))
    this._drawBox()
    process.stdout.write(move(this._logRow, 1))
  }

  _drawBox() {
    const meta      = `${this.accounts.length} account${this.accounts.length !== 1 ? 's' : ''}  |  ${this.intervalMs / 1000}s interval`
    const titleStr  = 'WFM Live Scraper'
    const titlePad  = INNER - titleStr.length - meta.length
    const titleLine = `${BOLD}${WHITE}${titleStr}${RESET}` + ' '.repeat(Math.max(1, titlePad)) + `${DIM}${meta}${RESET}`

    // Column header (visible only, no color)
    const hdr = (
      'ACCOUNT'.padEnd(C.ACCOUNT) +
      'LAST SCRAPE'.padEnd(C.TIME) +
      'ST'.padEnd(C.STATUS) +
      'SLA'.padEnd(C.SLA) +
      'QUEUE'.padEnd(C.QUEUE) +
      'AGENTS'.padEnd(C.AGENTS) +
      'INFO'
    )

    process.stdout.write(TOP + '\n')
    process.stdout.write(boxLine(titleLine) + '\n')
    process.stdout.write(SEP + '\n')
    process.stdout.write(boxLine(`${DIM}${hdr}${RESET}`) + '\n')
    process.stdout.write(SEP + '\n')
    this.accounts.forEach(a => {
      process.stdout.write(boxLine(formatRow(a.id, this.states[a.id])) + '\n')
    })
    process.stdout.write(BOT + '\n')
    process.stdout.write('\n')
    process.stdout.write(`${DIM}${'─'.repeat(W)} Recent Activity ${'─'.repeat(3)}${RESET}\n`)
  }

  // Update a single account row in place
  update(id, { time, ok, sla, waiting, agents, info, error } = {}) {
    const s = this.states[id]
    if (!s) return
    if (time    !== undefined) s.time    = time
    if (ok      !== undefined) s.ok      = ok
    if (sla     !== undefined) s.sla     = sla
    if (waiting !== undefined) s.waiting = waiting
    if (agents  !== undefined) s.agents  = agents
    if (info    !== undefined) s.info    = info
    if (error   !== undefined) s.error   = error

    const row = this._acctRows[id]
    if (!row) return

    process.stdout.write(hideCur + saveCur)
    process.stdout.write(move(row, 1) + clrLine)
    process.stdout.write(boxLine(formatRow(id, s)))
    process.stdout.write(restCur + showCur)
  }

  log(id, msg, level = 'info') {
    const color = level === 'error' ? RED : level === 'warn' ? YELLOW : DIM
    const ts    = new Date().toLocaleTimeString()
    const tag   = id ? `${CYAN}[${id}]${RESET} ` : ''
    process.stdout.write(saveCur + move(this._logRow, 1) + restCur)
    process.stdout.write(`${DIM}${ts}${RESET} ${tag}${color}${msg}${RESET}\n`)
  }

  error(id, msg) { this.log(id, msg, 'error') }
  warn(id, msg)  { this.log(id, msg, 'warn')  }
}

module.exports = TerminalDash
