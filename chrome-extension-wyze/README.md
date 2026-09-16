# Wyze Dashboard Scraper — Chrome Extension

Why this exists: Zendesk added **MFA/2FA** to the Wyze account after
`wfm-live-scraper`'s Node/Playwright scraper (`scrapers/wyze/index.js`) was
first written. Auto-filling email/password now only gets as far as the 2FA
challenge, and repeatedly resubmitting credentials against that wall is what
risks getting the account logged out/flagged. This extension runs instead,
inside the **already-logged-in human's own browser** — it doesn't do any
login of its own, it just reads whatever page is already on screen and
writes the same data to the same Supabase tables the Node scraper uses.

Same pattern as `chrome-extension-hippo/` (built for Hippo's YubiKey-only
NICE CXone login, which hit the identical "can't script past this" wall).
The one structural difference: Hippo's NICE dashboard is one page made of
several iframes, scraped all at once; Wyze's data lives on **two separate
Zendesk pages/tabs** (WFM Agent Status, Chat Monitor), each scraped
independently by its own content script and its own overlay.

---

## What it writes

Same tables as `wfm-live-scraper/scrapers/wyze/index.js` — see
`sql/wyze.sql` in that repo:

| Table | Source page | Content script |
|---|---|---|
| `wyze_agents` | WFM Agent Status (`/wfm/v2/agent-status`) — ECE team roster | `content_roster.js` |
| `wyze_chat_monitor` | Chat Monitor (`/chat/agent#monitor`) — live queue/response/duration cards | `content_chat.js` |
| `wyze_kpis` | Explore KPI dashboard — **not wired up yet**, see below | `content_explore.js` (unregistered) |

If Wyze's Node scraper is ever restarted for some other reason, both it and
this extension write to the exact same tables/columns — keep the write
logic in `background.js` here in sync with `writeWyzeData()` in
`scrapers/wyze/index.js` if a column ever changes.

---

## Install (for the Wyze user's PC)

1. Download/copy this whole `chrome-extension-wyze` folder onto their machine.
2. Open `chrome://extensions` in Chrome.
3. Turn on **Developer mode** (top-right toggle).
4. Click **Load unpacked** → select this folder.
5. Log into Zendesk as normal (MFA and all).
6. Open **two tabs**, one for each page:
   - `https://wyzelabs.zendesk.com/wfm/v2/agent-status`
   - `https://wyzelabs.zendesk.com/chat/agent#monitor`
7. An overlay panel appears automatically, top-right, on each tab.
8. On each, click **▶ Start Auto Sync** (30s default, adjustable) — or use
   **📸 Manual Snapshot** for a one-off. Leave both tabs open; each overlay
   keeps running independently as long as its tab stays open.

No Google account, no OAuth — it's already pointed at the right Supabase
project.

---

## Adding Explore once the URL is known

`config.json`'s `exploreUrl` for Wyze is still `""` — the real Explore
dashboard URL was never filled in (same gap as the Node scraper). Once it's
known:

1. In `manifest.json`, add a third `content_scripts` entry:
   ```json
   {
     "matches": ["https://wyzelabs.zendesk.com/explore/studio*"],
     "js": ["overlay.js", "content_explore.js"],
     "run_at": "document_idle"
   }
   ```
   (adjust the match pattern to the real URL's path).
2. `content_explore.js` is already written and functional (ported from
   `scrapeExploreKpis()`) — nothing else to change to get it scraping with
   the generic "any `kpi-queryid-*` tile" fallback.
3. Optionally catalogue Wyze's actual KPI tile query-IDs and fill in
   `KPI_MAP` in both `content_explore.js` here AND `scrapers/wyze/index.js`,
   so tiles get real labels instead of `(unknown: kpi-queryid-NNNNN)`.
4. Also add `account.exploreUrl` to `config.json` so the Node scraper (kept
   as a documented fallback, see below) picks it up too.

---

## If something looks wrong

- Open DevTools (F12) **on the dashboard tab itself** and check the Console
  for `[Wyze Roster]` / `[Wyze Chat Monitor]` / `[Wyze BG]` log lines.
- Each overlay's own **Activity Log** panel shows the last 60 sync attempts
  and any errors.
- `chrome://extensions` → this extension → **service worker** link opens
  DevTools for `background.js` specifically (the actual Supabase writes
  happen there).
- If the roster overlay logs "No ECE agents found", the "By team" filter
  may not have applied yet — `content_roster.js` retries it on every
  snapshot, so a second Manual Snapshot after the dropdown settles usually
  clears it.

## Known limitations

- An MV3 background service worker isn't a persistent process — Chrome can
  put it to sleep between snapshots and wake it back up on the next one.
  This extension already accounts for the main risk of that (the "which
  agents disappeared since last time" cleanup logic is persisted to
  `chrome.storage.local`, not kept only in memory) — but if Chrome closes a
  tab entirely, that page's scraping stops until someone reopens it. Both
  tabs need to stay open for both data sources to keep flowing.
- Unlike Hippo's NICE dashboard, there's no known idle-timeout/auto-logout
  behavior documented for Zendesk's WFM app, so this extension doesn't
  include Hippo's keep-alive/idle-dialog-guard logic. If Wyze's session
  turns out to expire from inactivity the same way, port that piece over
  from `chrome-extension-hippo/content_main.js`.
