// File: scraper.js
// Path: C:\Users\rodolfo.luga\Documents\Node Projects\wfm-live-scraper\scraper.js
// scraper.js — WFM Live Scraper v3
// Per-account scraper modules in scrapers/<account-id>/index.js
//
// Commands (type + Enter while running):
//   add <name>       — create scrapers/<name>/ from template, add to config
//   start <name>     — start a configured account (after editing its scraper file)
//   reload <name>    — hot-reload that account's scraper file (no full restart)
//   pause <name>     — pause scraping (browser stays alive, session kept)
//   resume <name>    — resume a paused account
//   remove <name>    — stop and remove from active list (files stay on disk)
//   list             — show all accounts, scraper file, and current state
//   hide [name]      — minimize + hide from taskbar (all if no name)
//   show [name]      — restore browser window
//   retry <name>     — immediately re-scrape
//   status           — print KPI summary for all accounts
//   cliqscan         — force an immediate Zoho Cliq breach scan (bypasses cooldown, not staleness)
//   help             — list all commands

require('dotenv').config()

const fs   = require('fs')
const path = require('path')

const TerminalDash   = require('./lib/terminal-dash')
const AccountRunner  = require('./lib/account-runner')
const CliqNotifier   = require('./lib/cliq-notifier')

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

// ── Zoho Cliq breach notifier — independent of any single account, own interval ─
const cliqNotifier = new CliqNotifier(dash)

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
async function startAccount(account) {
  const mod    = loadScraperModule(account.id)
  const runner = new AccountRunner(account, mod, dash)
  runners[account.id] = runner
  await runner.init()
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
  if (runners[name]?.timer) { dash.log(null, `"${name}" is already running — use reload to refresh`); return }

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

  switch (cmd) {
    case 'add':    cmdAdd(arg);    break
    case 'start':  cmdStart(arg);  break
    case 'reload': cmdReload(arg); break

    case 'pause': {
      const ids = arg ? [arg] : Object.keys(runners)
      ids.forEach(id => {
        if (!runners[id]) { dash.log(null, `Unknown: ${id}`); return }
        runners[id].pause()
      })
      break
    }

    case 'resume': {
      const ids = arg ? [arg] : Object.keys(runners)
      ids.forEach(id => {
        if (!runners[id]) { dash.log(null, `Unknown: ${id}`); return }
        runners[id].resume()
      })
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

    case 'cliqscan':
      dash.log(null, '▶ Forcing an immediate Cliq breach scan...')
      cliqNotifier.forceScan().catch(e => dash.warn(null, `[cliq] force scan failed: ${e.message}`))
      break

    case 'help': case '?':
      dash.log(null, 'add | start | reload | pause | resume | remove | list | hide | show | retry | status | cliqscan | help')
      dash.log(null, `Active: ${Object.keys(runners).join(', ') || '(none)'}`)
      break

    default:
      dash.log(null, `Unknown: "${cmd}" — type help`)
  }
}

// ── Main ──────────────────────────────────────────────────────────────────────
;(async () => {
  // Start all accounts from config.json
  for (const account of ACCOUNTS) {
    const scraperPath = path.join(SCRAPERS_DIR, account.id, 'index.js')
    if (!fs.existsSync(scraperPath)) {
      dash.warn(account.id, `No scraper file — run: add ${account.id}  then: start ${account.id}`)
      continue
    }
    try {
      await startAccount(account)
    } catch (err) {
      dash.error(account.id, `Startup failed: ${err.message}`)
    }
  }

  // Independent of any single account — starts its own interval, never blocks
  // account startup above (and never blocks on it either, per-account errors
  // are caught inside).
  cliqNotifier.start()

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
    dash.log(null, 'Commands: add | start | reload | pause | resume | remove | list | hide | show | retry | status | cliqscan | help')
  }, 2000)

  // Graceful shutdown
  process.on('SIGINT', async () => {
    dash.log(null, 'Shutting down...')
    cliqNotifier.stop()
    for (const runner of Object.values(runners)) {
      try { await runner.stop() } catch (_) {}
    }
    process.stdout.write('\x1b[r\x1b[?25h\n')
    process.exit(0)
  })
})()
