# Hippo Dashboard Scraper — Chrome Extension

Why this exists: Hippo switched their NICE CXone login to **YubiKey-only**
hardware-key authentication. A physical key can't be scripted, so
`wfm-live-scraper`'s Node/Playwright scraper (`scrapers/hippo/index.js`) can
no longer log in on its own. This extension runs instead, inside the
**already-logged-in human's own browser** — it doesn't do any login of its
own, it just reads the dashboard that's already on screen and writes the
same data to the same Supabase tables the Node scraper used to.

Converted from an earlier "NICE inContact Dashboard Scraper" extension that
uploaded CSV snapshots to Google Drive — the DOM-scraping logic is untouched
(it was already tuned specifically for Hippo's dashboard), only the upload
destination changed from Google Drive to Supabase.

---

## What it writes

Same tables as `wfm-live-scraper/scrapers/hippo/index.js` — see
`sql/hippo.sql` in that repo:

| Table | What |
|---|---|
| `hippo_kpis` | KPI tiles (queue counters, SLA %, etc.) — one row per widget+metric |
| `hippo_licensed_agents` | "Licensed Agents" roster widget |
| `hippo_level_1` | "Level 1" roster widget |
| `hippo_datasets` | Any other table widget NICE shows, stored generically (JSONB) so a newly-added widget never breaks anything |

If Hippo's Node scraper is ever restarted for some other reason, both it and
this extension write to the exact same tables/columns — keep
`KNOWN_WIDGETS` in `background.js` here in sync with the one in
`scrapers/hippo/index.js` if a widget's columns ever change.

---

## Install (for the Hippo user's PC)

1. Download/copy this whole `chrome-extension-hippo` folder onto their machine.
2. Open `chrome://extensions` in Chrome.
3. Turn on **Developer mode** (top-right toggle).
4. Click **Load unpacked** → select this folder.
5. Log into the Hippo NICE CXone dashboard as normal (YubiKey and all).
6. Navigate to the Dashboard: `https://na1.nice-incontact.com/apps/#/dashboard/wrapper/dashboards`
   (or whatever Hippo's actual URL is — if it's on a different NICE CXone
   region/cluster than `na1.nice-incontact.com`, tell me and I'll adjust the
   `manifest.json` host permissions).
7. A small overlay panel appears top-right of the page automatically.
8. Click **▶ Start Auto Sync** — it'll scrape and sync every 60 seconds
   (adjustable in the overlay). Or use **📸 Manual Snapshot** for a one-off.

No Google account, no OAuth, no folder picker — it's already pointed at the
right Supabase project.

---

## Icons (optional)

`manifest.json` doesn't reference any icon files, so Chrome will show a
default icon in the toolbar. Drop `icon16.png` / `icon48.png` / `icon128.png`
into this folder and add an `"icons"` block back to `manifest.json` if you
want a custom one — not required for it to work.

---

## If something looks wrong

- Open DevTools (F12) **on the dashboard tab itself** and check the Console
  for `[Hippo BG]`, `[Hippo iframe]`, `[Hippo Interceptor]`, or
  `[Hippo KeepAlive]` log lines.
- The overlay's own **Activity Log** panel shows the last 60 sync attempts
  and any errors.
- If a Supabase write ever fails, the extension automatically downloads a
  local CSV backup of that snapshot instead of losing the data silently.
- `chrome://extensions` → this extension → **service worker** link opens
  DevTools for `background.js` specifically (the actual Supabase writes
  happen there).

## Known limitation

An MV3 background service worker isn't a persistent process — Chrome can
put it to sleep between snapshots and wake it back up on the next one. This
extension already accounts for the main risk of that (the "which rows
disappeared since last time" cleanup logic is persisted to
`chrome.storage.local` instead of kept only in memory), but if Chrome kills
the tab/window entirely (not just the service worker), scraping stops until
someone reopens the dashboard tab — there's no way around that for a
browser-extension-based approach, unlike the always-on Node process.
