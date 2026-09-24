-- ─────────────────────────────────────────────────────────────────────────────
-- Ashley Digital (account id "ashleydigital") — Assembled WFM REST API
-- Run once in: Supabase Dashboard → SQL Editor → New Query
--
-- See scrapers/ashleydigital/index.js's file header for the full reasoning
-- and confirmed API response shapes behind each table.
-- ─────────────────────────────────────────────────────────────────────────────

-- Roster — one row per person. `id` is Assembled's PERSON id (NOT agent_id —
-- both are stored, agent_id is what agent_state/agent_state_raw key on).
CREATE TABLE IF NOT EXISTS ashleydigital_people (
  id          text PRIMARY KEY,  -- "{account_id}:{person_id}"
  account_id  text NOT NULL,
  person_id   text,
  agent_id    text,
  first_name  text,
  last_name   text,
  email       text,
  timezone    text,
  role        text,
  agent_role  text,
  channels    jsonb,
  site_id     text,
  teams       jsonb,             -- array of team ids
  queues      jsonb,             -- array of queue ids
  skills      jsonb,             -- array of skill ids
  platforms   jsonb,             -- {"five9": "...", "intercom": "...", ...}
  start_date  bigint,            -- unix seconds
  end_date    bigint,
  staffable   boolean,
  deleted     boolean,
  updated_at  timestamptz DEFAULT now()
);

-- Shared shape for the three org-hierarchy trees bundled in /people's
-- response (teams/sites/skills) — each is id/name/parent_id, same as queues.
CREATE TABLE IF NOT EXISTS ashleydigital_teams (
  id         text PRIMARY KEY,  -- "{account_id}:{team_id}"
  account_id text NOT NULL,
  item_id    text,
  name       text,
  parent_id  text,
  updated_at timestamptz DEFAULT now()
);

CREATE TABLE IF NOT EXISTS ashleydigital_sites (
  id         text PRIMARY KEY,
  account_id text NOT NULL,
  item_id    text,
  name       text,
  parent_id  text,
  updated_at timestamptz DEFAULT now()
);

CREATE TABLE IF NOT EXISTS ashleydigital_skills (
  id         text PRIMARY KEY,
  account_id text NOT NULL,
  item_id    text,
  name       text,
  parent_id  text,
  updated_at timestamptz DEFAULT now()
);

CREATE TABLE IF NOT EXISTS ashleydigital_queues (
  id         text PRIMARY KEY,
  account_id text NOT NULL,
  item_id    text,
  name       text,
  parent_id  text,
  updated_at timestamptz DEFAULT now()
);

-- Activity type catalog (from /activity_types).
CREATE TABLE IF NOT EXISTS ashleydigital_activity_types (
  id                text PRIMARY KEY,  -- "{account_id}:{type_id}"
  account_id        text NOT NULL,
  type_id           text,
  name              text,
  short_name        text,
  value             text,
  channels          jsonb,
  productive        boolean,
  timeoff           boolean,
  background_color  text,
  font_color        text,
  timeoff_unit      text,
  updated_at        timestamptz DEFAULT now()
);

-- CURRENT merged agent status — one row per agent (from
-- /agents/state/condensed_timeline, deduped across platforms per
-- account.priorityOrder). This is the primary "who's doing what right now"
-- table for a live dashboard.
CREATE TABLE IF NOT EXISTS ashleydigital_agent_state (
  id                text PRIMARY KEY,  -- "{account_id}:{agent_id}"
  account_id        text NOT NULL,
  agent_id          text,
  agent_name        text,
  agent_email       text,
  platform          text,             -- which platform's state won (e.g. "five9")
  agent_platform_id text,
  state             text,             -- e.g. "Offline", "Away and Reassign"
  start_time        bigint,
  end_time          bigint,
  modified_at       bigint,
  external_id       text,
  ticket_id         text,
  ticket_status     text,
  updated_at        timestamptz DEFAULT now()
);

-- RAW un-merged per-(agent,platform) status (from /agents/states/:agent_id)
-- — a rotating subset of the roster refreshes each tick (see index.js's
-- RAW_STATE_BATCH_SIZE), so rows are simply overwritten in place on their
-- turn rather than pruned every tick.
CREATE TABLE IF NOT EXISTS ashleydigital_agent_state_raw (
  id                text PRIMARY KEY,  -- "{account_id}:{agent_id}:{platform}"
  account_id        text NOT NULL,
  agent_id          text,
  platform          text,
  agent_platform_id text,
  state             text,
  start_time        bigint,
  end_time          bigint,
  modified_at       bigint,
  external_id       text,
  updated_at        timestamptz DEFAULT now()
);

-- Schedule occurrences (from /activities) — id_with_timestamps is the real
-- unique key since a plain activity `id` can recur across occurrences.
CREATE TABLE IF NOT EXISTS ashleydigital_activities (
  id           text PRIMARY KEY,  -- "{account_id}:{id_with_timestamps}"
  account_id   text NOT NULL,
  activity_id  text,              -- Assembled's own (recurring) activity id
  agent_id     text,
  type_id      text,              -- joins to ashleydigital_activity_types
  start_time   bigint,
  end_time     bigint,
  description  text,
  updated_at   timestamptz DEFAULT now()
);

-- Realtime — safe to re-run; skips if already in the publication.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_publication_tables WHERE pubname = 'supabase_realtime' AND tablename = 'ashleydigital_people') THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE ashleydigital_people;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_publication_tables WHERE pubname = 'supabase_realtime' AND tablename = 'ashleydigital_agent_state') THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE ashleydigital_agent_state;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_publication_tables WHERE pubname = 'supabase_realtime' AND tablename = 'ashleydigital_agent_state_raw') THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE ashleydigital_agent_state_raw;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_publication_tables WHERE pubname = 'supabase_realtime' AND tablename = 'ashleydigital_activities') THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE ashleydigital_activities;
  END IF;
END $$;
