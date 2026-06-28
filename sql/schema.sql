-- WFM Aircall Scraper — Supabase Schema
-- Run this in: Supabase Dashboard → SQL Editor → New Query

-- ── 1. KPI snapshot (one row per account, upserted each interval) ─────────────
CREATE TABLE IF NOT EXISTS wfm_kpi_snapshots (
  id                text PRIMARY KEY,   -- account_id
  account_id        text NOT NULL,
  sla               text,
  total_calls       text,
  outbound          text,
  inbound           text,
  answered          text,
  unanswered        text,
  time_to_answer    text,
  longest_waiting   text,
  available_users   text,
  calls_waiting     text,
  calls_in_table    text,
  total_users       text,
  updated_at        timestamptz DEFAULT now()
);

-- ── 2. Agent states (one row per agent, upserted each interval) ──────────────
CREATE TABLE IF NOT EXISTS wfm_agent_states (
  id          text PRIMARY KEY,   -- "{account_id}:{agent_name}"
  account_id  text NOT NULL,
  agent_name  text NOT NULL,
  status      text,               -- 'Available', 'In call', 'On a break', etc.
  duration    text,               -- e.g. "5min", "1h 20min"
  updated_at  timestamptz DEFAULT now()
);

-- ── 3. User status counts (one row per account) ───────────────────────────────
CREATE TABLE IF NOT EXISTS wfm_user_status_counts (
  id              text PRIMARY KEY,   -- account_id
  account_id      text NOT NULL,
  available       int DEFAULT 0,
  ringing         int DEFAULT 0,
  in_call         int DEFAULT 0,
  after_call_work int DEFAULT 0,
  not_available   int DEFAULT 0,
  do_not_disturb  int DEFAULT 0,
  on_a_break      int DEFAULT 0,
  out_for_lunch   int DEFAULT 0,
  back_office     int DEFAULT 0,
  in_training     int DEFAULT 0,
  offline         int DEFAULT 0,
  updated_at      timestamptz DEFAULT now()
);

-- ── 4. Active calls (replaced each interval — reflects current live calls) ────
CREATE TABLE IF NOT EXISTS wfm_active_calls (
  id          text PRIMARY KEY,   -- "{account_id}:{index}"
  account_id  text NOT NULL,
  direction   text,               -- 'Inbound', 'Outbound', 'Unknown'
  agent       text,
  phone_line  text,
  customer    text,
  status      text,
  started_at  text,               -- as shown on Aircall (e.g. "2:34")
  updated_at  timestamptz DEFAULT now()
);

-- ── Enable Realtime on the tables your webapp needs to subscribe to ───────────
-- Run in Supabase SQL Editor:
ALTER PUBLICATION supabase_realtime ADD TABLE wfm_kpi_snapshots;
ALTER PUBLICATION supabase_realtime ADD TABLE wfm_agent_states;
ALTER PUBLICATION supabase_realtime ADD TABLE wfm_user_status_counts;
ALTER PUBLICATION supabase_realtime ADD TABLE wfm_active_calls;

-- ── Optional: Row Level Security (recommended for production) ─────────────────
-- The anon key in your .env only needs INSERT/UPDATE/DELETE.
-- Uncomment if you want to lock it down:

-- ALTER TABLE wfm_kpi_snapshots         ENABLE ROW LEVEL SECURITY;
-- ALTER TABLE wfm_agent_states          ENABLE ROW LEVEL SECURITY;
-- ALTER TABLE wfm_user_status_counts    ENABLE ROW LEVEL SECURITY;
-- ALTER TABLE wfm_active_calls          ENABLE ROW LEVEL SECURITY;

-- CREATE POLICY "allow_all" ON wfm_kpi_snapshots      FOR ALL USING (true);
-- CREATE POLICY "allow_all" ON wfm_agent_states        FOR ALL USING (true);
-- CREATE POLICY "allow_all" ON wfm_user_status_counts  FOR ALL USING (true);
-- CREATE POLICY "allow_all" ON wfm_active_calls        FOR ALL USING (true);
