// File: scraper.js
// Path: C:\Users\rodolfo.luga\Documents\Node Projects\wfm-live-scraper\scraper.js
// scraper.js — WFM Live Scraper v3
// Per-account scraper modules in scrapers/<account-id>/index.js
//
// Commands (type + Enter while running):
//   add <name>       — create scrapers/<name>/ from template, add to config
//   start <name>     — start a configured account (after editing its scraper file)
//   force <name>     — start/take over a locked account immediately, bypassing
//                       the other instance's stale-lock wait (use with care)
//   autologin <name> [on|off] — per-account toggle for auto-login attempts,
//                       for manualLogin accounts that support it (currently
//                       edenhealth, wyze); off always falls back to manual
//                       login. No on/off arg prints that account's current
//                       state.
//   reload <name>    — hot-reload that account's scraper file (no full restart)
//   pause <name>     — pause scraping (browser stays alive, session kept)
//   resume <name>    — resume a paused account
//   remove <name>    — stop and remove from active list (files stay on disk)
//   list             — show all accounts, scraper file, and current state
//   hide [name]      — minimize + hide from taskbar (all if no name)
//   show [name]      — restore browser window
//   retry <name>     — immediately re-scrape
//   status           — print KPI summary for all accounts
//   help             — list all commands

require('dotenv').config()

const fs   = require('fs')
const path = require('path')

const TerminalDash   = require('./lib/terminal-dash')
const AccountRunner  = require('./lib/account-runner')
const settings       = require('./lib/settings')
const { BUILD, NOTE } = require('./lib/version')

// ── Paths ─────────────────────────────────────────────────────────────────────
const CONFIG_PATH   = path.join(__dirname, 'config.json')
const SCRAPERS_DIR  = path.join(__dirname, 'scrapers')
const TEMPLATE_DIR  = path.join(SCRAPERS_DIR, '_template')
const SESSIONS_DIR  = path.join(__dirname, 'sessions')

// ── Validation ────────────────────────────────────────────────────────────────
if (!fs.existsSync(CONFIG_PATH)) {
  console.error('❌  config.json not found.')
  process.exit(1)
}
if (!process.env.SUPABASE_URL || !process.env.SUPABASE_KEY) {
  console.error('❌  SUPABASE_URL and SUPABASE_KEY must be set in .env')
  process.exit(1)
}
if (!fs.existsSync(SESSIONS_DIR)) fs.mkdirSync(SESSIONS_DIR, { recursive: true })

const ACCOUNTS    = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'))
const INTERVAL_MS = parseInt(process.env.SCRAPE_INTERVAL_MS) || 30000

// ── Terminal dashboard ────────────────────────────────────────────────────────
const dash = new TerminalDash(ACCOUNTS, INTERVAL_MS)
dash.init()

// ── Active runners ────────────────────────────────────────────────────────────
const runners = {}  // accountId → AccountRunner

// ── Load scraper module (busts require cache on reload) ───────────────────────
function loadScraperModule(accountId) {
  const scraperPath = path.join(SCRAPERS_DIR, accountId, 'index.js')
  if (!fs.existsSync(scraperPath)) {
    throw new Error(
      `No scraper found at scrapers/${accountId}/index.js\n` +
      `  → Run: add ${accountId}   to create from template\n` +
      `  → Or create the file manually`
    )
  }
  // Clear require cache so reload gets fresh code
  const resolved = require.resolve(scraperPath)
  delete require.cache[resolved]
  return require(scraperPath)
}

// ── Start a single account ────────────────────────────────────────────────────
async function startAccount(account, force = false) {
  const mod    = loadScraperModule(account.id)
  const runner = new AccountRunner(account, mod, dash)
  runners[account.id] = runner
  await runner.init(force)
  runner.start()
}

// ── Command: add <name> ───────────────────────────────────────────────────────
function cmdAdd(name) {
  if (!name) { dash.log(null, 'Usage: add <account-name>'); return }
  if (runners[name]) { dash.log(null, `"${name}" is already running`); return }

  const targetDir = path.join(SCRAPERS_DIR, name)
  if (!fs.existsSync(targetDir)) {
    fs.mkdirSync(targetDir, { recursive: true })
    // Copy template
    const tmplFile = path.join(TEMPLATE_DIR, 'index.js')
    const destFile = path.join(targetDir, 'index.js')
    if (fs.existsSync(tmplFile)) {
      fs.copyFileSync(tmplFile, destFile)
      dash.log(null, `✅ Created scrapers/${name}/index.js from template`)
    } else {
      fs.writeFileSync(destFile, `// scrapers/${name}/index.js\nmodule.exports = { meta: { type: 'custom' }, async login() {}, async scrape() { return null }, async write() {} }\n`)
      dash.log(null, `✅ Created scrapers/${name}/index.js (empty)`)
    }
  } else {
    dash.log(null, `scrapers/${name}/ already exists`)
  }

  // Add to config.json if not there
  const config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'))
  if (!config.find(a => a.id === name)) {
    config.push({ id: name, email: '', password: '' })
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2))
    dash.log(null, `✅ Added "${name}" to config.json (add credentials there)`)
  }

  // Add to dashboard
  dash.addAccount(name)
  dash.log(null, `Next steps:`)
  dash.log(null, `  1. Edit scrapers/${name}/index.js with your login + scrape logic`)
  dash.log(null, `  2. Edit config.json to add email/password for "${name}"`)
  dash.log(null, `  3. Run: start ${name}`)
}

// ── Command: start <name> ─────────────────────────────────────────────────────
async function cmdStart(name) {
  if (!name) { dash.log(null, 'Usage: start <account-name>'); return }

  // A runner sitting in awaitingLogin/awaitingLock has no .timer (it's
  // cleared while paused/on standby) — checking .timer alone let a second
  // `start` silently open a SECOND browser window on the same profile,
  // orphaning the first one. Any tracked runner at all means don't start
  // another; guide the operator to the right follow-up command instead.
  const existing = runners[name]
  if (existing) {
    if (existing.awaitingLogin) { dash.log(null, `"${name}" already has a browser open awaiting manual login — log in THERE, then run: resume ${name}`); return }
    if (existing.awaitingLock)  { dash.log(null, `"${name}" is on standby (locked by another instance) — use: force ${name}`); return }
    dash.log(null, `"${name}" is already running — use reload to refresh`)
    return
  }

  const config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'))
  const account = config.find(a => a.id === name)
  if (!account) {
    dash.log(null, `"${name}" not in config.json — run: add ${name}`)
    return
  }

  // Add to dashboard if not there
  if (!dash.accounts.find(a => a.id === name)) dash.addAccount(name)

  dash.log(null, `▶ Starting ${name}...`)
  try {
    await startAccount(account)
  } catch (err) {
    dash.error(name, `Failed to start: ${err.message}`)
  }
}

// ── Command: force <name> ─────────────────────────────────────────────────────
// Bypasses the distributed lock's STALE_MS wait — for when the operator
// already knows the other holder is stale/gone (e.g. being decommissioned
// account-by-account) and doesn't want to wait out the 90s heartbeat timeout.
async function cmdForce(name) {
  if (!name) { dash.log(null, 'Usage: force <account-name>'); return }

  const existing = runners[name]
  if (existing && existing.awaitingLock) {
    dash.log(null, `▶ Force-taking "${name}" from the other instance...`)
    await existing.forceTakeover()
    return
  }
  // Same reasoning as cmdStart: any other tracked state (running, or stuck
  // awaiting manual login) already has a browser open — force-starting on
  // top of it would just open a second, orphaned one.
  if (existing) {
    if (existing.awaitingLogin) { dash.log(null, `"${name}" already has a browser open awaiting manual login — log in THERE, then run: resume ${name}`); return }
    dash.log(null, `"${name}" is already running here`)
    return
  }

  const config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'))
  const account = config.find(a => a.id === name)
  if (!account) {
    dash.log(null, `"${name}" not in config.json — run: add ${name}`)
    return
  }
  if (!dash.accounts.find(a => a.id === name)) dash.addAccount(name)

  dash.log(null, `▶ Force-starting ${name}...`)
  try {
    await startAccount(account, true)
  } catch (err) {
    dash.error(name, `Failed to force-start: ${err.message}`)
  }
}

// ── Command: reload <name> ────────────────────────────────────────────────────
async function cmdReload(name) {
  if (!name) { dash.log(null, 'Usage: reload <account-name>'); return }
  const runner = runners[name]
  if (!runner) { dash.log(null, `"${name}" is not running — use: start ${name}`); return }
  try {
    const newMod = loadScraperModule(name)
    await runner.reload(newMod)
  } catch (err) {
    dash.error(name, `Reload failed: ${err.message}`)
  }
}

// ── Command: list ─────────────────────────────────────────────────────────────
function cmdList() {
  const config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'))
  dash.log(null, `─── Accounts (${config.length}) ────────────────────────`)
  config.forEach(a => {
    const runner = runners[a.id]
    const scraperPath = path.join(SCRAPERS_DIR, a.id, 'index.js')
    const fileExists  = fs.existsSync(scraperPath) ? '✅' : '❌ no scraper file'
    const state = runner
      ? (runner.paused ? '⏸ paused' : runner.stopped ? '⏹ stopped' : '▶ running')
      : '○ not started'
    const type = runner?.module?.meta?.type || '?'
    dash.log(null, `  ${a.id.padEnd(20)} [${type}]  ${state}  ${fileExists}`)
  })
  dash.log(null, `────────────────────────────────────────`)
}

// ── Command handler ───────────────────────────────────────────────────────────
function handleCommand(raw) {
  const line  = raw.trim().replace(/['"]/g, '')
  if (!line) return
  const parts = line.split(/\s+/)
  const cmd   = parts[0].toLowerCase()
  const arg   = parts[1]
  const arg2  = parts[2]

  switch (cmd) {
    case 'add':    cmdAdd(arg);    break
    case 'start':  cmdStart(arg);  break
    case 'force':  cmdForce(arg);  break
    case 'reload': cmdReload(arg); break

    case 'autologin': {
      const accountId = arg
      const val = arg2?.toLowerCase()
      if (!accountId) { dash.log(null, 'Usage: autologin <account> [on|off]'); break }
      if (!ACCOUNTS.find(a => a.id === accountId)) { dash.log(null, `Unknown account: "${accountId}"`); break }
      if (!val) {
        dash.log(null, `Auto-login for "${accountId}" is currently ${settings.isAutoLoginEnabled(accountId) ? 'ON' : 'OFF'}`)
        break
      }
      if (val === 'on')  { settings.setAutoLogin(accountId, true);  dash.log(null, `✅ Auto-login ON for "${accountId}"`) }
      else if (val === 'off') { settings.setAutoLogin(accountId, false); dash.log(null, `⏸ Auto-login OFF for "${accountId}" — will always wait for manual login`) }
      else dash.log(null, 'Usage: autologin <account> on|off')
      break
    }

    case 'pause': {
      const ids = arg ? [arg] : Object.keys(runners)
      ids.forEach(id => {
        if (!runners[id]) { dash.log(null, `Unknown: ${id}`); return }
        runners[id].pause()
      })
      break
    }

    case 'resume': {
      // With an explicit id: an account that's never been started at all
      // (the new default — see the startup message) has no runner yet, so
      // fall back to starting it fresh instead of just saying "Unknown" —
      // `start` and `resume` should both work to open an account's browser.
      // Bare `resume` (no id) only resumes already-tracked runners; it
      // deliberately does NOT start every configured account.
      if (arg) {
        if (!runners[arg]) { cmdStart(arg); break }
        runners[arg].resume()
        break
      }
      Object.keys(runners).forEach(id => runners[id].resume())
      break
    }

    case 'remove': {
      if (!arg) { dash.log(null, 'Usage: remove <name>'); break }
      const runner = runners[arg]
      if (!runner) { dash.log(null, `"${arg}" is not running`); break }
      runner.stop().then(() => {
        delete runners[arg]
        dash.removeAccount(arg)
        dash.log(null, `✅ "${arg}" removed (files kept on disk)`)
      })
      break
    }

    case 'list': cmdList(); break

    case 'hide': {
      const ids = arg ? [arg] : Object.keys(runners)
      ids.forEach(id => {
        if (!runners[id]) { dash.log(null, `Unknown: ${id}`); return }
        runners[id].hide()
      })
      break
    }

    case 'show': {
      const ids = arg ? [arg] : Object.keys(runners)
      ids.forEach(id => {
        if (!runners[id]) { dash.log(null, `Unknown: ${id}`); return }
        runners[id].show()
      })
      break
    }

    case 'retry': {
      if (!arg) { dash.log(null, `Usage: retry <name>  Available: ${Object.keys(runners).join(', ')}`); break }
      if (!runners[arg]) { dash.log(null, `Unknown: "${arg}"`); break }
      dash.log(null, `▶ Retrying ${arg}...`)
      runners[arg].tick()
      break
    }

    case 'status': {
      Object.keys(runners).forEach(id => {
        const s  = dash.states[id] || {}
        const st = s.error ? `❌ ${s.error}` : s.ok ? `✅ SLA:${s.sla} Q:${s.waiting} Agt:${s.agents}` : `⏳ ${s.info}`
        dash.log(null, `${id.padEnd(20)} ${s.time || '--:--'}  ${st}`)
      })
      break
    }

    case 'help': case '?':
      dash.log(null, 'add | start | force | autologin | reload | pause | resume | remove | list | hide | show | retry | status | help')
      dash.log(null, `Active: ${Object.keys(runners).join(', ') || '(none)'}`)
      break

    default:
      dash.log(null, `Unknown: "${cmd}" — type help`)
  }
}

// ── Main ──────────────────────────────────────────────────────────────────────
;(async () => {
  // Nothing auto-starts anymore — every account (headless or visible-browser)
  // now waits for an explicit `start <id>` / `resume <id>` before it opens
  // anything or hits its CRM. Each row still shows up in the dashboard above
  // (via TerminalDash's constructor) as "not started" so it's clear what's
  // available without needing to run `list` first.
  dash.log(null, `Build ${BUILD} — ${NOTE}`)
  dash.log(null, `${ACCOUNTS.length} account(s) configured, none started automatically.`)
  dash.log(null, `Available: ${ACCOUNTS.map(a => a.id).join(', ')}`)
  dash.log(null, `Run: start <id>  or  resume <id>  to open one.`)

  // stdin commands
  process.stdin.resume()
  process.stdin.setEncoding('utf8')
  let _buf = ''
  process.stdin.on('data', chunk => {
    _buf += chunk
    const lines = _buf.split(/\r?\n/)
    _buf = lines.pop()
    lines.forEach(l => handleCommand(l))
  })

  setTimeout(() => {
    dash.log(null, 'Commands: add | start | force | autologin | reload | pause | resume | remove | list | hide | show | retry | status | help')
  }, 2000)

  // Graceful shutdown
  process.on('SIGINT', async () => {
    dash.log(null, 'Shutting down...')
    for (const runner of Object.values(runners)) {
      try { await runner.stop() } catch (_) {}
    }
    process.stdout.write('\x1b[r\x1b[?25h\n')
    process.exit(0)
  })
})()
