-- ─────────────────────────────────────────────────────────────────────────────
-- Rocco Fridge (account id "roccoridge") — Gorgias "Live overview" page
-- Run once in: Supabase Dashboard → SQL Editor → New Query
--
-- Same Gorgias CRM/page structure as scrapers/guardianbikes/index.js — see
-- sql/guardianbikes.sql and scrapers/roccoridge/index.js's file header for
-- the full reasoning behind each table.
--
-- All three data sources for this account:
--   roccoridge_overview_kpis  — the 4 "key metric" stat cards
--   roccoridge_ticket_volume  — the "Support Volume" chart's hourly data
--   roccoridge_agents        — one row per agent (Live Agents table)
--   roccoridge_voice_kpis    — the 11 Live Voice stat-card values
--   roccoridge_live_calls    — one row per currently-active call
--   roccoridge_voice_agents  — one row per agent (Live Voice's Agents sidebar)
--
-- NOT wired into wfm_accounts/wfm_settings yet — same as every other new
-- account, that's a separate Dashboard-side step once this data is confirmed
-- flowing in.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS roccoridge_overview_kpis (
  id                      text PRIMARY KEY,  -- = account_id (one row total)
  account_id              text NOT NULL,
  agents_online           text,
  agents_offline          text,
  assigned_open_tickets   text,
  unassigned_open_tickets text,
  updated_at              timestamptz DEFAULT now()
);

CREATE TABLE IF NOT EXISTS roccoridge_ticket_volume (
  id           text PRIMARY KEY,  -- "{account_id}:{hour_ts}:{metric}"
  account_id   text NOT NULL,
  hour_ts      bigint,            -- raw UNIX-seconds timestamp, as Chart.js was given it
  hour_label   text,              -- human-readable, e.g. "2 AM"
  metric       text,              -- sanitized key, e.g. "ticket_created"
  metric_label text,              -- original label, e.g. "Ticket created"
  value        text,
  updated_at   timestamptz DEFAULT now()
);

CREATE TABLE IF NOT EXISTS roccoridge_agents (
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

CREATE TABLE IF NOT EXISTS roccoridge_voice_kpis (
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

CREATE TABLE IF NOT EXISTS roccoridge_live_calls (
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

CREATE TABLE IF NOT EXISTS roccoridge_voice_agents (
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
  IF NOT EXISTS (SELECT 1 FROM pg_publication_tables WHERE pubname = 'supabase_realtime' AND tablename = 'roccoridge_overview_kpis') THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE roccoridge_overview_kpis;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_publication_tables WHERE pubname = 'supabase_realtime' AND tablename = 'roccoridge_ticket_volume') THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE roccoridge_ticket_volume;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_publication_tables WHERE pubname = 'supabase_realtime' AND tablename = 'roccoridge_agents') THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE roccoridge_agents;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_publication_tables WHERE pubname = 'supabase_realtime' AND tablename = 'roccoridge_voice_kpis') THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE roccoridge_voice_kpis;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_publication_tables WHERE pubname = 'supabase_realtime' AND tablename = 'roccoridge_live_calls') THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE roccoridge_live_calls;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_publication_tables WHERE pubname = 'supabase_realtime' AND tablename = 'roccoridge_voice_agents') THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE roccoridge_voice_agents;
  END IF;
END $$;
