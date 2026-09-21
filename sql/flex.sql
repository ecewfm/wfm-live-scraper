-- ─────────────────────────────────────────────────────────────────────────────
-- Flex — General Ticket Status + Geckoboard SLA-breach watch + Explore tiles
-- Run once in: Supabase Dashboard → SQL Editor → New Query
--
-- Three data sources for this account (see scrapers/flex/index.js's file
-- header for the full reasoning behind each):
--   flex_tickets       — getflex.zendesk.com's "General" view ticket table
--   flex_sla_watch     — the Geckoboard "Tickets Nearing SLA Breach" board
--   flex_explore_tiles — the Ticket Status Explore (Looker-embedded)
--                        dashboard — PARTIAL: only tiles using Looker's
--                        "Multiple Value" viz are scraped so far; donut/pie-
--                        chart tiles aren't handled yet (see scrapers/flex/
--                        index.js). Rows simply won't appear for tiles that
--                        haven't been scraped, rather than needing a
--                        migration later.
--
-- NOT wired into wfm_accounts/wfm_settings yet — this data is ticket lists/
-- ad-hoc tiles, not a KPI tile or an agent roster in the existing sense, so
-- it doesn't fit the Dashboard app's KPI/Agent Status config model.
-- Dashboard-side wiring is deliberately left for once the desired UI for
-- this data is decided.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS flex_tickets (
  id             text PRIMARY KEY,  -- "flex:{ticket_id}"
  account_id     text NOT NULL,
  ticket_id      text,
  priority_group text,              -- from the view's "Priority: X" divider row
  ticket_status  text,              -- e.g. "Pending Callback", "On-hold", "Open"
  priority       text,              -- e.g. "Normal"
  sla_text       text,              -- e.g. "Breached by 16 days", "25 hours till breach"
  sla_short      text,              -- e.g. "-16d", "25h"
  subject        text,
  requester      text,
  requested      text,              -- raw relative text as shown, e.g. "Sep 01", "Yesterday 13:39"
  ticket_group   text,              -- the view's "Group" column, e.g. "Phone Team", "Control Center"
  assignee       text,
  category       text,
  channel        text,              -- e.g. "API", "Messaging", "Web form"
  updated_at     timestamptz DEFAULT now()
);

-- Geckoboard "Tickets Nearing SLA Breach" widget — a small, fixed list (no
-- pagination), independent of the General view above (different product,
-- no login of its own — see scrapers/flex/index.js).
CREATE TABLE IF NOT EXISTS flex_sla_watch (
  id              text PRIMARY KEY,  -- "flex:{ticket_id}"
  account_id      text NOT NULL,
  ticket_id       text,
  subject         text,
  assignee        text,
  assignee_tags   text,
  next_breach_at  text,              -- raw relative text as shown, e.g. "in 2 hours"
  ticket_group    text,
  updated_at      timestamptz DEFAULT now()
);

-- Ticket Status Explore dashboard — one row per (tile, label) data point.
-- "tile" is the Looker dashboard element's title (e.g. "SLA status",
-- "Email", "Messaging", "Voice"); "label"/"value" are one data point within
-- it (e.g. label="Messaging" value="74%" — yes, some tiles nest a
-- channel-name label inside a tile already named for a channel/metric
-- group; that's just how this particular dashboard's tiles are laid out).
CREATE TABLE IF NOT EXISTS flex_explore_tiles (
  id         text PRIMARY KEY,  -- "flex:{sanitized tile}:{sanitized label}"
  account_id text NOT NULL,
  tile       text,
  label      text,
  value      text,
  updated_at timestamptz DEFAULT now()
);

-- Realtime — safe to re-run; skips if already in the publication.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_publication_tables WHERE pubname = 'supabase_realtime' AND tablename = 'flex_tickets') THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE flex_tickets;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_publication_tables WHERE pubname = 'supabase_realtime' AND tablename = 'flex_sla_watch') THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE flex_sla_watch;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_publication_tables WHERE pubname = 'supabase_realtime' AND tablename = 'flex_explore_tiles') THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE flex_explore_tiles;
  END IF;
END $$;
