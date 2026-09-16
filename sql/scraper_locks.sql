-- wfm_scraper_locks — one-time table create
-- Run once in: Supabase Dashboard → SQL Editor → New Query
--
-- Backs lib/scraper-lock.js's active-passive lock: lets a second scraper
-- instance run alongside the primary as a backup/failover for the SAME
-- accounts, without both actually scraping the same CRM session at once.
-- One row per account_id — holder_id is whichever process instance
-- currently owns it, heartbeat_at is renewed on every tick so a crashed or
-- stopped instance's lock goes stale and can be taken over automatically.

CREATE TABLE IF NOT EXISTS wfm_scraper_locks (
  account_id   text PRIMARY KEY,
  holder_id    text NOT NULL,
  heartbeat_at timestamptz NOT NULL DEFAULT now()
);
