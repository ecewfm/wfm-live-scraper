-- ─────────────────────────────────────────────────────────────────────────────
-- Ashley Furniture CHAT account (id "ashleychat") — LivePerson Manager
-- Workspace, ported from chrome extension scrapers old/ashley-chat-extension/
-- Run once in: Supabase Dashboard → SQL Editor → New Query
--
-- Four data sources — see scrapers/ashleychat/index.js's file header for the
-- full reasoning (this is a direct port of that extension's scrapeLivePerson()):
--   ashleychat_activity_summary — one row (the Activity Summary metrics)
--   ashleychat_queue_summary    — one row per skill (the in-queue widget)
--   ashleychat_agents           — one row per agent
--   ashleychat_conversations    — one row per live conversation
--
-- NOT wired into wfm_accounts/wfm_settings yet — same as every other new
-- account, that's a separate Dashboard-side step once this data is confirmed
-- flowing in.
-- ─────────────────────────────────────────────────────────────────────────────

-- One row per account. Columns match the exact fixed set of labels the
-- original extension's metricMap/subMetrics produce (see index.js) —
-- sanitized the same way (lowercased, spaces -> underscores).
CREATE TABLE IF NOT EXISTS ashleychat_activity_summary (
  id                                text PRIMARY KEY,  -- = account_id (one row total)
  account_id                        text NOT NULL,
  assigned                         text,  -- "Assigned"
  load                             text,  -- "Load"
  closed                           text,  -- "Closed"
  csat                             text,  -- "CSAT"
  first_response_time              text,
  response_time                    text,
  resolution_time                  text,
  overdue_assigned                 text,
  online_load                      text,
  away_load                        text,
  closed_by_agent                  text,
  closed_by_consumer               text,
  auto_closed                      text,
  first_response_from_assignment   text,
  response_from_assignment         text,
  updated_at                        timestamptz DEFAULT now()
);

-- One row per skill in the "in queue" widget. Rows are pruned to whatever
-- skills are currently present (a skill can be added/removed on the
-- LivePerson side).
CREATE TABLE IF NOT EXISTS ashleychat_queue_summary (
  id         text PRIMARY KEY,  -- "{account_id}:{sanitized_skill}"
  account_id text NOT NULL,
  skill      text,
  in_queue   text,
  wait_time  text,
  updated_at timestamptz DEFAULT now()
);

-- One row per agent. `skills` is jsonb (an array of skill-tag strings) since
-- the set of skills per agent isn't fixed-width.
CREATE TABLE IF NOT EXISTS ashleychat_agents (
  id              text PRIMARY KEY,  -- "{account_id}:{sanitized_agent_name}"
  account_id      text NOT NULL,
  agent_name      text,
  status          text,
  status_duration text,
  agent_group     text,
  active_convs    text,
  assigned_convs  text,
  closed_convs    text,
  load            text,
  online_rate     text,
  csat            text,
  max_slots       text,
  transfers       text,
  transfer_rate   text,
  skills          jsonb,
  updated_at      timestamptz DEFAULT now()
);

-- One row per CURRENTLY LIVE conversation (not history) — rows are pruned
-- every tick to exactly whatever's live right now, including down to zero
-- rows, same reasoning as guardianbikes_live_calls.
CREATE TABLE IF NOT EXISTS ashleychat_conversations (
  id                text PRIMARY KEY,  -- "{account_id}:conv:{sanitized visitor:agent:startTimestamp}"
  account_id        text NOT NULL,
  visitor_name      text,
  status            text,             -- "Open" / "Closed"
  response_time     text,
  agent_name        text,
  agent_group_name  text,
  skill             text,
  start_timestamp   text,
  csat_score        text,
  updated_at        timestamptz DEFAULT now()
);

-- Realtime — safe to re-run; skips if already in the publication.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_publication_tables WHERE pubname = 'supabase_realtime' AND tablename = 'ashleychat_activity_summary') THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE ashleychat_activity_summary;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_publication_tables WHERE pubname = 'supabase_realtime' AND tablename = 'ashleychat_queue_summary') THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE ashleychat_queue_summary;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_publication_tables WHERE pubname = 'supabase_realtime' AND tablename = 'ashleychat_agents') THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE ashleychat_agents;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_publication_tables WHERE pubname = 'supabase_realtime' AND tablename = 'ashleychat_conversations') THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE ashleychat_conversations;
  END IF;
END $$;
