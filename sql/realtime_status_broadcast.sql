-- ─────────────────────────────────────────────────────────────────────────────
-- Agent status Realtime — broadcast only on actual status changes
-- Run once in: Supabase Dashboard → SQL Editor → New Query
--
-- PROBLEM: every scraper upserts agent rows every ~30s tick regardless of
-- whether the agent's status actually changed (duration/updated_at always
-- move). postgres_changes fires a Realtime message for every one of those
-- row touches, so the dashboard was paying for ~(agents × ticks) messages
-- even when nothing meaningful happened — the dominant driver of Realtime
-- message volume across the whole project.
--
-- FIX: instead of the dashboard subscribing to raw postgres_changes on these
-- tables, a trigger compares OLD vs NEW status on every write and only calls
-- realtime.send() (Supabase's "Broadcast from Database" feature) when the
-- status column actually differs. Duration/updated_at still get written to
-- the table every tick as before (so polling/reload freshness is untouched)
-- — only the Realtime notification becomes conditional.
--
-- This covers the 4 tables the dashboard actually subscribes to (see
-- components/Dashboard.tsx): wfm_agent_states, talkdesk_agent_states,
-- five9_agent_states, uniters_agent_states. Hippo/ZenBusiness/Eden Health
-- aren't wired into dashboard Realtime at all today (they rely on the 60s
-- poll), so they don't need this trigger yet — add it the same way if that
-- ever changes.
-- ─────────────────────────────────────────────────────────────────────────────

-- ── Generic trigger function ──────────────────────────────────────────────────
-- Reused across all 4 tables via trigger arguments (TG_ARGV), since the
-- "status" column is named differently per table (status vs state):
--   TG_ARGV[0] = status column name
--   TG_ARGV[1] = agent name column name
-- Every one of these tables has account_id, so that's referenced directly.
CREATE OR REPLACE FUNCTION public.notify_agent_status_change()
RETURNS trigger
SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  status_col  text := TG_ARGV[0];
  name_col    text := TG_ARGV[1];
  old_status  text;
  new_status  text;
  agent_name  text;
BEGIN
  new_status := (to_jsonb(NEW) ->> status_col);
  agent_name := (to_jsonb(NEW) ->> name_col);

  IF TG_OP = 'UPDATE' THEN
    old_status := (to_jsonb(OLD) ->> status_col);
    IF old_status IS NOT DISTINCT FROM new_status THEN
      RETURN NEW; -- status unchanged this tick — nothing worth broadcasting
    END IF;
  END IF;
  -- TG_OP = 'INSERT' (new agent row) always broadcasts — old_status stays NULL.

  PERFORM realtime.send(
    jsonb_build_object(
      'table',      TG_TABLE_NAME,
      'account_id', NEW.account_id,
      'agent_name', agent_name,
      'old_status', old_status,
      'new_status', new_status
    ),
    'status_change',              -- event name — matches Dashboard.tsx's .on('broadcast', { event: 'status_change' }, ...)
    'wfm-realtime',                -- topic — matches the dashboard's single 'wfm-realtime' channel
    false                          -- public channel, no Realtime Authorization needed (same posture as postgres_changes today)
  );

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- ── Triggers — one per table, passing that table's actual column names ───────
DROP TRIGGER IF EXISTS trg_notify_status_change ON wfm_agent_states;
CREATE TRIGGER trg_notify_status_change
AFTER INSERT OR UPDATE ON wfm_agent_states
FOR EACH ROW EXECUTE FUNCTION notify_agent_status_change('status', 'agent_name');

DROP TRIGGER IF EXISTS trg_notify_status_change ON talkdesk_agent_states;
CREATE TRIGGER trg_notify_status_change
AFTER INSERT OR UPDATE ON talkdesk_agent_states
FOR EACH ROW EXECUTE FUNCTION notify_agent_status_change('status', 'agent_name');

DROP TRIGGER IF EXISTS trg_notify_status_change ON five9_agent_states;
CREATE TRIGGER trg_notify_status_change
AFTER INSERT OR UPDATE ON five9_agent_states
FOR EACH ROW EXECUTE FUNCTION notify_agent_status_change('state', 'name');

DROP TRIGGER IF EXISTS trg_notify_status_change ON uniters_agent_states;
CREATE TRIGGER trg_notify_status_change
AFTER INSERT OR UPDATE ON uniters_agent_states
FOR EACH ROW EXECUTE FUNCTION notify_agent_status_change('state', 'name');
