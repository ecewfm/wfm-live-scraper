// lib/settings.js
// Tiny on-disk store for per-account runtime toggles (e.g. `autologin <id>
// on/off` from the scraper.js command loop) — separate from config.json
// (credentials) since these are behavior switches, not account data.
// Persists across restarts by writing settings.json next to it.

const fs   = require('fs')
const path = require('path')

const FILE = path.join(__dirname, '..', 'settings.json')

function load() {
  try {
    const parsed = JSON.parse(fs.readFileSync(FILE, 'utf8'))
    return { autoLogin: {}, ...parsed }
  } catch (_) {
    return { autoLogin: {} }
  }
}

function persist() {
  try {
    fs.writeFileSync(FILE, JSON.stringify(state, null, 2))
  } catch (e) {
    console.warn(`[settings] failed to persist settings.json: ${e.message}`)
  }
}

let state = load()

// Default is ON for every account unless explicitly turned off.
function isAutoLoginEnabled(accountId) {
  return state.autoLogin[accountId] !== false
}

function setAutoLogin(accountId, enabled) {
  state.autoLogin[accountId] = enabled
  persist()
}

module.exports = { isAutoLoginEnabled, setAutoLogin }
