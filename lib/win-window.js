// File: lib/win-window.js
// Path: C:\Users\rodolfo.luga\Documents\Node Projects\wfm-live-scraper\lib\win-window.js
// lib/win-window.js
// Hides/shows a specific Chrome window from Windows taskbar.
// Uses the page title to identify the correct Chrome window
// when multiple Chrome instances are running.

const { execSync } = require('child_process')
const fs   = require('fs')
const os   = require('os')
const path = require('path')

// ── Write + run a PowerShell .ps1 file (avoids quote-escaping issues) ─────────
function runPS(lines) {
  const tmp = path.join(os.tmpdir(), `wfm_win_${Date.now()}.ps1`)
  try {
    fs.writeFileSync(tmp, lines.join('\r\n'), 'utf8')
    execSync(
      `powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "${tmp}"`,
      { timeout: 8000, stdio: 'ignore' }
    )
    return true
  } catch { return false }
  finally { try { fs.unlinkSync(tmp) } catch {} }
}

// ── Find Chrome PID by window title fragment ──────────────────────────────────
// e.g. "Aircall" or "Talkdesk" — each account's page has a different title
function findPidByTitle(titleFragment) {
  if (!titleFragment) return null
  // Escape any quotes in the title fragment
  const safe = titleFragment.replace(/'/g, '').replace(/"/g, '').substring(0, 40)
  try {
    const out = execSync(
      `powershell -NoProfile -NonInteractive -Command "` +
      `$p = Get-Process -Name chrome -ErrorAction SilentlyContinue | ` +
      `Where-Object { $_.MainWindowTitle -like '*${safe}*' -and $_.MainWindowHandle -ne 0 }; ` +
      `if ($p) { ($p | Select-Object -First 1).Id } else { 0 }"`,
      { timeout: 6000, stdio: ['pipe', 'pipe', 'ignore'] }
    ).toString().trim()
    const pid = parseInt(out)
    return (!isNaN(pid) && pid > 0) ? pid : null
  } catch { return null }
}

// ── Find Chrome PID as child of current Node process (fallback) ───────────────
function findChromeChildPid() {
  const nodePid = process.pid
  try {
    const out = execSync(
      `powershell -NoProfile -NonInteractive -Command "` +
      `$c = Get-WmiObject Win32_Process -ErrorAction SilentlyContinue | ` +
      `Where-Object { $_.Name -like 'chrome*' -and $_.ParentProcessId -eq ${nodePid} -and $_.CommandLine -notlike '*--type=*' }; ` +
      `if ($c) { ($c | Sort-Object ProcessId | Select-Object -First 1).ProcessId } else { 0 }"`,
      { timeout: 6000, stdio: ['pipe', 'pipe', 'ignore'] }
    ).toString().trim()
    const pid = parseInt(out)
    return (!isNaN(pid) && pid > 0) ? pid : null
  } catch { return null }
}

// ── Get PID from Playwright browser object (tries internal APIs) ──────────────
function getPidFromBrowser(browser) {
  try { const p = browser.process?.(); if (p?.pid) return p.pid } catch (_) {}
  try { const p = browser._browserProcess?.processLauncher?.process; if (p?.pid) return p.pid } catch (_) {}
  try { const p = browser._process; if (p?.pid) return p.pid } catch (_) {}
  return null
}

// ── ShowWindow wrapper ────────────────────────────────────────────────────────
function showWindowByPid(pid, nCmdShow) {
  return runPS([
    `$sig = '[DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int n);'`,
    `Add-Type -MemberDefinition $sig -Name 'WUtil' -Namespace 'WinAPI' -ErrorAction SilentlyContinue`,
    `$proc = Get-Process -Id ${pid} -ErrorAction SilentlyContinue`,
    `if ($proc -and $proc.MainWindowHandle -ne 0) {`,
    `  [WinAPI.WUtil]::ShowWindow($proc.MainWindowHandle, ${nCmdShow})`,
    `}`
  ])
}

/**
 * Hide a Chrome window completely (screen + taskbar).
 * @param {object} browser   — Playwright Browser object
 * @param {string} pageTitle — page.title() of the account's page (used to find right window)
 */
function hideWindow(browser, pageTitle) {
  // 1. Try page title search (most reliable when multiple Chrome instances exist)
  if (pageTitle) {
    const pid = findPidByTitle(pageTitle)
    if (pid) return showWindowByPid(pid, 0)
  }
  // 2. Try Playwright internal browser process APIs
  const pid2 = getPidFromBrowser(browser)
  if (pid2) return showWindowByPid(pid2, 0)
  // 3. Last resort — find any Chrome child of Node (may hit wrong window if multiple exist)
  const pid3 = findChromeChildPid()
  if (pid3) return showWindowByPid(pid3, 0)
  return false
}

/**
 * Restore a hidden Chrome window.
 * @param {object} browser   — Playwright Browser object
 * @param {string} pageTitle — page.title() of the account's page
 */
function showWindow(browser, pageTitle) {
  if (pageTitle) {
    const pid = findPidByTitle(pageTitle)
    if (pid) return showWindowByPid(pid, 9)
  }
  const pid2 = getPidFromBrowser(browser)
  if (pid2) return showWindowByPid(pid2, 9)
  const pid3 = findChromeChildPid()
  if (pid3) return showWindowByPid(pid3, 9)
  return false
}

module.exports = { hideWindow, showWindow }
