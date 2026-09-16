// lib/scraper-lock.js
// Active-passive distributed lock, backed by Supabase (wfm_scraper_locks —
// see sql/scraper_locks.sql). Lets a second scraper instance run alongside
// the primary as a manual backup/failover for the SAME accounts, without
// both actually driving the same CRM session at once — that would race on
// the shared session file/profile and risk the CRM itself kicking out
// whichever login it considers "second device".
//
// One row per account_id. Whichever instance currently holds an account
// renews its heartbeat every tick (see account-runner.js); if that stops
// (crash, network loss, intentional stop) for longer than STALE_MS, any
// other instance trying to claim the account takes over automatically.

const crypto = require('crypto');
const os     = require('os');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;
const TABLE        = 'wfm_scraper_locks';

// 3x the default 30s tick interval — comfortably longer than one missed
// heartbeat (a slow tick, a transient network blip) without making a real
// failover wait unreasonably long.
const STALE_MS = 90_000;

// Unique per process — survives reload/module-cache-busting within the same
// run since this module (unlike scraper modules) is never require()-cache-
// cleared, but is fresh on every actual process restart.
const INSTANCE_ID = `${os.hostname()}-${process.pid}-${crypto.randomUUID().slice(0, 8)}`;

// Throttles the "claim write failed" warning to once per account per this
// many ms — the underlying cause (missing table, RLS, network) doesn't
// change tick-to-tick, so logging it every single tick just buries real
// activity under repeated identical lines.
const WARN_THROTTLE_MS = 5 * 60_000;
const _lastWarnAt = new Map(); // accountId -> timestamp

function headers(extra = {}) {
  return {
    apikey: SUPABASE_KEY,
    Authorization: `Bearer ${SUPABASE_KEY}`,
    'Content-Type': 'application/json',
    ...extra,
  };
}

// ── Claim (or renew) the lock for accountId. Returns true if this instance
// holds it after the call, false if another instance actively holds it. ────
async function tryClaim(accountId) {
  try {
    const getRes = await fetch(
      `${SUPABASE_URL}/rest/v1/${TABLE}?account_id=eq.${encodeURIComponent(accountId)}`,
      { headers: headers() }
    );
    const rows = getRes.ok ? await getRes.json() : [];
    const existing = rows[0];

    if (existing && existing.holder_id !== INSTANCE_ID) {
      const age = Date.now() - new Date(existing.heartbeat_at).getTime();
      if (age < STALE_MS) return false; // someone else actively holds it
    }

    const upsertRes = await fetch(`${SUPABASE_URL}/rest/v1/${TABLE}`, {
      method: 'POST',
      headers: headers({ Prefer: 'resolution=merge-duplicates' }),
      body: JSON.stringify([{
        account_id: accountId, holder_id: INSTANCE_ID, heartbeat_at: new Date().toISOString(),
      }]),
    });
    if (!upsertRes.ok) {
      // Table missing/misconfigured (e.g. sql/scraper_locks.sql never run —
      // 404) or some other Supabase-side error: fail open (return true —
      // this account keeps scraping normally, nothing here blocks it) rather
      // than get an account permanently stuck in standby over infra that
      // isn't the other instance actually holding it.
      const now = Date.now();
      const last = _lastWarnAt.get(accountId) || 0;
      if (now - last > WARN_THROTTLE_MS) {
        _lastWarnAt.set(accountId, now);
        console.warn(`[scraper-lock] claim write failed for "${accountId}" (HTTP ${upsertRes.status}) — failing open (scraping continues normally; run sql/scraper_locks.sql to silence this)`);
      }
      return true;
    }
    return true;
  } catch (_) {
    // Supabase unreachable — fail open (keep whatever this instance already
    // held) rather than fail closed and stop scraping over a network blip.
    return true;
  }
}

// ── Force-take the lock regardless of who currently holds it or how fresh
// their heartbeat is. For the manual `force <id>` command — used when the
// operator knows the other holder is actually stale/gone (e.g. removed from
// that instance, or that instance's process is being decommissioned) even
// though STALE_MS hasn't elapsed yet, and doesn't want to wait it out. ─────
async function forceClaim(accountId) {
  try {
    const upsertRes = await fetch(`${SUPABASE_URL}/rest/v1/${TABLE}`, {
      method: 'POST',
      headers: headers({ Prefer: 'resolution=merge-duplicates' }),
      body: JSON.stringify([{
        account_id: accountId, holder_id: INSTANCE_ID, heartbeat_at: new Date().toISOString(),
      }]),
    });
    // force means force — a write failure here (missing table, RLS, etc.)
    // should never block the operator's explicit override. The lock row is
    // best-effort bookkeeping; the actual takeover (launching the browser)
    // happens regardless.
    if (!upsertRes.ok) {
      console.warn(`[scraper-lock] force-claim write failed for "${accountId}" (HTTP ${upsertRes.status}) — proceeding anyway`);
    }
    return true;
  } catch (_) {
    return true;
  }
}

// ── Release explicitly on graceful stop, so a backup can take over instantly
// instead of waiting out STALE_MS. ──────────────────────────────────────────
async function release(accountId) {
  try {
    await fetch(
      `${SUPABASE_URL}/rest/v1/${TABLE}?account_id=eq.${encodeURIComponent(accountId)}&holder_id=eq.${encodeURIComponent(INSTANCE_ID)}`,
      { method: 'DELETE', headers: headers() }
    );
  } catch (_) {}
}

module.exports = { tryClaim, forceClaim, release, INSTANCE_ID, STALE_MS };
