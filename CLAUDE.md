# WFM Live Scraper — Claude Code Instructions

Read this first. It explains what this project is, how it runs in production
(24/7 on an always-on PC), and the rules that must NOT be broken.

## What this is

A Node.js + Playwright scraper that logs into contact-center live-monitoring
dashboards, scrapes KPIs/agents/calls every ~30s, and writes them to Supabase.
The WFM Live Dashboard (separate project) reads from that Supabase.

- Entry point:  `scraper.js` (auto-starts every account in `config.json` on boot)
- Per-account logic: `scrapers/<account-id>/index.js` (each exports `login/scrape/write/meta`)
- Shared libs: `lib/account-runner.js` (lifecycle, tick loop, recovery),
  `lib/browser.js` (Playwright launch + Aircall login + session persistence),
  `lib/db.js` / `lib/db-talkdesk.js` (Supabase writes), `lib/terminal-dash.js` (UI),
  `lib/breach-detector.js` + `lib/cliq-notifier.js` (Zoho Cliq breach alerts — see below)
- Accounts today: `7cs-live` (Aircall), `ashley-phones` (Talkdesk),
  `perfectserve` + `uniters` (Five9 CRM)

## Zoho Cliq breach notifications (lib/cliq-notifier.js)

Migrated from an older Google Apps Script tool's Cliq integration — runs
entirely in THIS process (no Vercel Cron, no separate hosting) so it stays
free. Started once in `scraper.js`'s startup IIFE, independent of any single
account's `AccountRunner`.

- Every 60s, reads each account's `wfm_settings` row (same Supabase table the
  Next.js dashboard writes/reads: `data_source`, `kpi_thresholds`,
  `status_thresholds`, `cliq_channel`) and, for accounts with a channel
  configured, fetches that account's live KPI/agent rows and runs
  `lib/breach-detector.js` — a faithful, line-for-line port of the
  dashboard's own `buildBreaches()`/`checkKpi` (see `../wfm-live-dashboard`'s
  `components/Dashboard.tsx` / `lib/utils.ts` if these two ever need
  reconciling after a dashboard change).
- Per-account cooldown (`cliq_last_sent_at` column, default 5 min, configurable
  via the dashboard's Settings → Cliq Alerts tab) and a 5-minute staleness
  suppression (mirrors the dashboard's own "DATA NOT IN SYNC" overlay) both
  apply — cooldown only advances on a **confirmed successful send**.
- Auth: a Zoho "Server-based Application" OAuth client (same one registered
  for this integration, `ZOHO_CLIQ_CLIENT_ID`/`ZOHO_CLIQ_CLIENT_SECRET` in
  `.env`) plus a `ZOHO_CLIQ_REFRESH_TOKEN` obtained ONCE via the dashboard
  app's `/api/zoho/authorize` → `/api/zoho/callback` routes (that one-time
  step needs a public HTTPS redirect, which only the Vercel app can provide —
  everything after that runs independently, right here). Missing/blank Zoho
  env vars just disable the notifier silently; nothing else is affected.
- Terminal command `cliqscan` forces an immediate scan (bypasses cooldown,
  NOT the staleness check — same as the old tool's "Force Scan").

## How it runs in production (IMPORTANT)

The scraper runs 24/7 on a **separate always-on Windows PC ("the server")**, NOT
on the developer's laptop. That PC **sits at a locked screen** (no user logged in).

- Process manager: **PM2**, installed **as a Windows Service** via
  [pm2-installer](https://github.com/jessety/pm2-installer) so it runs under
  `LOCAL SYSTEM` before/without any login and auto-resurrects after reboot.
- Config: `ecosystem.config.js` (`HEADLESS: 'true'`, `autorestart`, `max_restarts: 500`).
- Must run **headless** — there is no desktop under a Service.
- `.env` on the server sets `CHROME_PATH` to a real installed Chrome
  (e.g. `C:\Program Files\Google\Chrome\Application\chrome.exe`), because a
  `LOCAL SYSTEM` service usually can't find Playwright's per-user Chromium.

### Everyday commands (run on the server)
```
pm2 list                          # is it online?
pm2 logs wfm-live-scraper         # live logs
pm2 restart wfm-live-scraper      # after a code/config change
pm2 save                          # persist process list (survives reboot)
```
After `pm2 save`, rebooting the locked PC brings the scraper back automatically.

### Deploy / update workflow
Edit code on the laptop → `git commit` → `git push`. Then on the server run:
```
powershell -ExecutionPolicy Bypass -File .\deploy.ps1
```
`deploy.ps1` does: `git pull` → `npm install` → `pm2 restart` → `pm2 save` → tail logs.

## Hard rules — do not break

1. **Never run the SAME account on two machines at once.** Sessions are local
   per-PC files (`sessions/<id>.json`), not shared. Two live logins with the
   same credentials make Five9/Aircall/Talkdesk evict each other, and each
   PC's expiry check ([lib/account-runner.js](lib/account-runner.js)) re-logs-in
   → a ping-pong logout loop. It also races `wfm_active_calls`
   (DELETE+INSERT per account in [lib/db.js](lib/db.js)) → duplicate/lost rows.
   → While the server owns the live accounts, on the laptop **edit code only**;
     do not `node scraper.js` / `pm2 start` those same accounts.

2. **Headless only on the server.** Never set `HEADLESS=false` there.

3. **Credentials are plaintext in `config.json`** (Five9/Aircall/Talkdesk
   passwords). Keep the server trusted; do not paste config.json anywhere public.

## How resilience works (so you know what NOT to reinvent)

- Session persisted after login via `context.storageState()` → reused next launch.
- Every 30s tick checks `isSessionExpired()` and auto re-logs-in.
- 3 consecutive empty scrapes → forced re-login (revives stale Five9 widgets).
- Browser crash → relaunch + re-init.
- PM2 → restarts the whole process on crash and after reboot.
- There is NO dedicated keep-alive heartbeat and NO leader-election/locking
  between machines. If asked to add redundancy, propose a Supabase heartbeat
  lock — do not just run a second copy.

## Supabase write model (see lib/db.js)

- `wfm_kpi_snapshots`, `wfm_user_status_counts` — 1 row per `account_id`, upsert.
- `wfm_agent_states` — 1 row per `account_id:agent_name`, upsert.
- `wfm_active_calls` — **DELETE all for account_id, then INSERT** each cycle
  (this is the table that corrupts under concurrent writers — see rule 1).

## First-time server setup (bootstrapping a fresh always-on PC)

Do this ONCE on a new server PC. Assumes Windows, locked-screen, always powered on.

**1. Prerequisites**
```powershell
# Install Node.js LTS (>=20) and Git first (from nodejs.org / git-scm.com).
# Install Google Chrome (needed because a LOCAL SYSTEM service can't reach
# Playwright's per-user Chromium).
node -v ; git --version      # verify both work
```

**2. Get the code**
```powershell
cd C:\   # or wherever you keep projects
git clone <this-repo-url> wfm-live-scraper
cd wfm-live-scraper
npm install
```

**3. Create `.env`** (in the project root — it is gitignored, so it must be made
per-machine). Fill in the real Supabase values:
```
HEADLESS=true
CHROME_PATH=C:\Program Files\Google\Chrome\Application\chrome.exe
SUPABASE_URL=<your-supabase-url>
SUPABASE_KEY=<your-supabase-service-key>
SCRAPE_INTERVAL_MS=30000
ZOHO_CLIQ_CLIENT_ID=<optional — only needed for Cliq breach alerts, see below>
ZOHO_CLIQ_CLIENT_SECRET=<optional>
ZOHO_CLIQ_REFRESH_TOKEN=<optional>
```

**4. Set `config.json`** — list ONLY the accounts this server should own, with
their credentials. Make sure no other machine is running these same accounts
(see Hard rule 1).

**5. Install PM2 as a Windows Service** (so it runs at the lock screen, no login):
```powershell
git clone https://github.com/jessety/pm2-installer.git
cd pm2-installer
npm run configure
npm run setup
cd ..\wfm-live-scraper
```

**6. Start it and persist**
```powershell
pm2 start ecosystem.config.js
pm2 save                       # records the process list for auto-resurrect
```

**7. Verify reboot-survival (the whole point):**
Reboot the PC, leave it at the lock screen ~2 min, then log in and run:
```powershell
pm2 list                       # wfm-live-scraper should already be "online"
pm2 logs wfm-live-scraper      # confirm each account logs in + scrapes
```
If it's `online` without you having started it, setup is correct — you can walk away.

After this, day-to-day updates use `deploy.ps1` (see "Deploy / update workflow").

## Related project

The dashboard that consumes this data is `../wfm-live-dashboard` (Next.js).
Its own `CLAUDE.md` covers deploy + Hermes reporting for that side.
