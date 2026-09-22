// lib/scrape-errors.js
// Shared classification for Playwright errors that mean the page/context/
// browser is actually gone (crashed, closed, disconnected) — as opposed to a
// transient scrape failure (a selector timeout, a stale/frozen widget, a CRM
// error page) where the page is still alive and worth retrying in place.
//
// The distinction matters because the two failure modes need different
// recovery: AccountRunner._attemptRecovery() retries module.login() on the
// SAME page object, which is a no-op (and fails silently, forever) once that
// page is truly gone — only a full browser relaunch (browser.close() +
// init(), AccountRunner's _isBrowserCrash branch) actually recovers from that.
//
// Single source of truth so a scraper module's own scrape() can decide
// whether to re-throw (let the fatal-error branch handle it) or swallow to
// null (a normal empty-scrape retry) using the exact same rules
// AccountRunner itself uses to route the thrown error.
function isFatalPageError(msg) {
  if (!msg) return false
  return msg.includes('Target closed') ||
         msg.includes('has been closed') || // covers Playwright's actual
                                             // "Target page, context or
                                             // browser has been closed"
         msg.includes('Session closed') ||
         msg.includes('Browser has disconnected')
}

module.exports = { isFatalPageError }
