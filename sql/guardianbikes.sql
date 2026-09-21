-- ─────────────────────────────────────────────────────────────────────────────
-- Guardian Bikes — Gorgias "Live overview" page
-- Run once in: Supabase Dashboard → SQL Editor → New Query
--
-- All three data sources for this account (see scrapers/guardianbikes/
-- index.js's file header for the full reasoning behind each):
--   guardianbikes_overview_kpis  — the 4 "key metric" stat cards
--   guardianbikes_ticket_volume  — the "Support Volume" chart's hourly data
--   guardianbikes_agents        — one row per agent (Live Agents table)
--   guardianbikes_voice_kpis    — the 11 Live Voice stat-card values
--   guardianbikes_live_calls    — one row per currently-active call
--   guardianbikes_voice_agents  — one row per agent (Live Voice's Agents sidebar)
--
-- NOT wired into wfm_accounts/wfm_settings yet — same as every other new
-- account, that's a separate Dashboard-side step once this data is confirmed
-- flowing in.
-- ─────────────────────────────────────────────────────────────────────────────

-- One row per account — the 4 stat cards. index.js's writeOverviewKpis()
-- writes to a column named after each card's OWN label text (sanitized:
-- lowercased, spaces -> underscores) rather than a fixed list in code, so if
-- Gorgias ever renames/adds a card, this table is the one place to add the
-- matching column — no code change needed. Until then, an unrecognized label
-- would fail that column's write (caught + logged, not fatal — same
-- independent-per-table .catch() as flex_tickets/flex_sla_watch/
-- flex_explore_tiles) rather than being silently dropped.
CREATE TABLE IF NOT EXISTS guardianbikes_overview_kpis (
  id                      text PRIMARY KEY,  -- = account_id (one row total)
  account_id              text NOT NULL,
  agents_online           text,
  agents_offline          text,
  assigned_open_tickets   text,
  unassigned_open_tickets text,
  updated_at              timestamptz DEFAULT now()
);

-- One row per (hour, metric) data point from the "Support Volume" chart
-- (Ticket created / Ticket replied / Ticket closed, by hour of the current
-- day). Rows are simply overwritten in place every tick as the day's counts
-- change — no pruning needed, the same fixed ~24 hour_ts values recur all day
-- and naturally roll over once Gorgias's own chart moves to the next day.
CREATE TABLE IF NOT EXISTS guardianbikes_ticket_volume (
  id           text PRIMARY KEY,  -- "{account_id}:{hour_ts}:{metric}"
  account_id   text NOT NULL,
  hour_ts      bigint,            -- raw UNIX-seconds timestamp, as Chart.js was given it
  hour_label   text,              -- human-readable, e.g. "2 AM" (see index.js's write() for the timezone caveat)
  metric       text,              -- sanitized key, e.g. "ticket_created"
  metric_label text,              -- original label, e.g. "Ticket created"
  value        text,
  updated_at   timestamptz DEFAULT now()
);

-- One row per agent from the Live Agents table. `open_tickets_by_channel` is
-- jsonb (e.g. {"forum": "1", "email": "1"}) rather than fixed columns per
-- channel, since the set of channels (forum/live_help/phone/email/sms
-- confirmed live so far) isn't necessarily finite/fixed. Rows for agents no
-- longer in the table (removed from the team) are pruned — see
-- pruneDepartedAgents() in index.js — same reasoning as flex_tickets.
CREATE TABLE IF NOT EXISTS guardianbikes_agents (
  id                      text PRIMARY KEY,  -- "{account_id}:{sanitized_agent_name}"
  account_id              text NOT NULL,
  agent_name              text,
  online_status           text,              -- "Online" / "Offline"
  availability_status     text,              -- e.g. "Available", "Call wrap-up", "Lunch break", "Unavailable"
  tickets_closed          text,
  messages_sent           text,
  open_tickets_total      text,
  open_tickets_by_channel jsonb,
  updated_at              timestamptz DEFAULT now()
);

-- One row per account — the 11 Live Voice stat cards. Same dynamic-column-
-- by-sanitized-label pattern as guardianbikes_overview_kpis above (see that
-- table's comment) — add a column here if Gorgias ever renames/adds a card.
-- Four of these (missed/cancelled/abandoned calls, callback requests) can
-- show either a raw count or a percentage depending on a page-side "#"/"%"
-- toggle we don't control — whatever's currently displayed is what lands
-- here (percentages, as of this writing).
CREATE TABLE IF NOT EXISTS guardianbikes_voice_kpis (
  id                 text PRIMARY KEY,  -- = account_id (one row total)
  account_id         text NOT NULL,
  calls_in_queue     text,
  average_wait_time  text,
  average_talk_time  text,
  sla_achievement_rate text,
  inbound_calls      text,
  outbound_calls     text,
  unanswered_calls   text,
  missed_calls       text,
  cancelled_calls    text,
  abandoned_calls    text,
  callback_requests  text,
  updated_at         timestamptz DEFAULT now()
);

-- One row per CURRENTLY ACTIVE call (not call history) — rows are pruned
-- every tick to exactly whatever's live right now, including down to zero
-- rows when nobody's on the phone (see writeLiveCalls()'s comment on why
-- pruning always runs, unlike the other tables here).
CREATE TABLE IF NOT EXISTS guardianbikes_live_calls (
  id          text PRIMARY KEY,  -- "{account_id}:call:{ticket_id}" (or a composite fallback — see index.js)
  account_id  text NOT NULL,
  ticket_id   text,
  direction   text,              -- Material Icons ligature name, e.g. "call_received"
  customer    text,              -- phone number
  agent_name  text,
  status      text,              -- e.g. "In progress"
  duration    text,              -- e.g. "05:11"
  integration text,
  queue       text,
  updated_at  timestamptz DEFAULT now()
);

-- One row per agent from Live Voice's "Agents" sidebar — deliberately
-- separate from guardianbikes_agents (the Live Agents page's ticket-handling
-- stats) since this is a different, call-specific view: 3 category groups
-- (Busy/Available/Unavailable) plus a more specific per-agent status_detail
-- read dynamically from the status dot's aria-label (see index.js's file
-- header for why no fixed status list is hardcoded).
CREATE TABLE IF NOT EXISTS guardianbikes_voice_agents (
  id            text PRIMARY KEY,  -- "{account_id}:{sanitized_agent_name}"
  account_id    text NOT NULL,
  agent_name    text,
  category      text,              -- "Busy" / "Available" / "Unavailable"
  status_detail text,              -- e.g. "On a call", "Available", "Offline" — whatever Gorgias's aria-label says
  status_color  text,              -- e.g. "red" / "green" / "grey"
  description   text,              -- e.g. a duration string like "04:57" when present, blank otherwise
  updated_at    timestamptz DEFAULT now()
);

-- Realtime — safe to re-run; skips if already in the publication.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_publication_tables WHERE pubname = 'supabase_realtime' AND tablename = 'guardianbikes_overview_kpis') THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE guardianbikes_overview_kpis;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_publication_tables WHERE pubname = 'supabase_realtime' AND tablename = 'guardianbikes_ticket_volume') THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE guardianbikes_ticket_volume;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_publication_tables WHERE pubname = 'supabase_realtime' AND tablename = 'guardianbikes_agents') THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE guardianbikes_agents;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_publication_tables WHERE pubname = 'supabase_realtime' AND tablename = 'guardianbikes_voice_kpis') THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE guardianbikes_voice_kpis;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_publication_tables WHERE pubname = 'supabase_realtime' AND tablename = 'guardianbikes_live_calls') THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE guardianbikes_live_calls;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_publication_tables WHERE pubname = 'supabase_realtime' AND tablename = 'guardianbikes_voice_agents') THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE guardianbikes_voice_agents;
  END IF;
END $$;
