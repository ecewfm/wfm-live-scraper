-- ─────────────────────────────────────────────────────────────────────────────
-- Cut off the OLD postgres_changes path for good — no client cooperation needed
-- Run once in: Supabase Dashboard → SQL Editor → New Query
--
-- PROBLEM: the dashboard code was updated to use conditional broadcast instead
-- of raw postgres_changes on these 8 tables (see realtime_status_broadcast.sql
-- and realtime_kpi_broadcast.sql) — but a browser tab that's been open since
-- before that deploy is still running the OLD JS bundle, which still holds an
-- old-style postgres_changes subscription. A server-side deploy can't reach
-- into an already-loaded tab and make it stop — the tab just keeps going
-- until someone manually refreshes it, which isn't reliable to depend on.
--
-- FIX: remove these tables from the supabase_realtime publication entirely.
-- postgres_changes has nothing to deliver events through once a table isn't
-- published, so ANY client still using that old subscription — regardless of
-- whether they ever refresh — silently stops receiving those events and
-- falls back to the dashboard's existing 60s poll for that data (the same
-- fallback Hippo/ZenBusiness/Eden Health/Wyze already rely on for these same
-- tables today, with no issue).
--
-- This does NOT touch the new broadcast mechanism at all — realtime.send()
-- writes to realtime.messages, a separate table with its own independent
-- replication slot, entirely unrelated to whether talkdesk_agent_states (etc.)
-- is itself in this publication. New, up-to-date clients are unaffected.
-- ─────────────────────────────────────────────────────────────────────────────

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_publication_tables WHERE pubname = 'supabase_realtime' AND tablename = 'wfm_kpi_snapshots') THEN
    ALTER PUBLICATION supabase_realtime DROP TABLE wfm_kpi_snapshots;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_publication_tables WHERE pubname = 'supabase_realtime' AND tablename = 'talkdesk_lob_kpis') THEN
    ALTER PUBLICATION supabase_realtime DROP TABLE talkdesk_lob_kpis;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_publication_tables WHERE pubname = 'supabase_realtime' AND tablename = 'five9_kpis') THEN
    ALTER PUBLICATION supabase_realtime DROP TABLE five9_kpis;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_publication_tables WHERE pubname = 'supabase_realtime' AND tablename = 'uniters_kpis') THEN
    ALTER PUBLICATION supabase_realtime DROP TABLE uniters_kpis;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_publication_tables WHERE pubname = 'supabase_realtime' AND tablename = 'wfm_agent_states') THEN
    ALTER PUBLICATION supabase_realtime DROP TABLE wfm_agent_states;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_publication_tables WHERE pubname = 'supabase_realtime' AND tablename = 'talkdesk_agent_states') THEN
    ALTER PUBLICATION supabase_realtime DROP TABLE talkdesk_agent_states;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_publication_tables WHERE pubname = 'supabase_realtime' AND tablename = 'five9_agent_states') THEN
    ALTER PUBLICATION supabase_realtime DROP TABLE five9_agent_states;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_publication_tables WHERE pubname = 'supabase_realtime' AND tablename = 'uniters_agent_states') THEN
    ALTER PUBLICATION supabase_realtime DROP TABLE uniters_agent_states;
  END IF;
END $$;
