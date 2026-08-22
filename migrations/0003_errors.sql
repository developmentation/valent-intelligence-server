-- 0003_errors: device-reported errors — the sink for the app's universal crash/error catcher.
-- Fed by POST /ingest/errors (the app uploads persisted crashes + recent error/warn diagnostics on
-- launch and while recording). Read by GET /admin/errors so a fault on any device can be evaluated
-- without adb. Idempotent. Dedup is on `fingerprint` (client-computed: wall+type+where), so the same
-- crash re-sent after a flaky post lands once.

create table if not exists errors (
  id bigserial primary key,
  fingerprint text unique,       -- client dedup key; null-safe: null rows are never merged
  session_id text,               -- the capture session in view/progress when it fired, if any
  device text,
  build text,
  level text,                    -- FATAL (uncaught) | ERROR | WARN
  kind text,                     -- crash | event
  component text,                -- FlightRecorder component / "uncaught"
  message text,
  where_at text,                 -- thread name (crash) or component (event)
  wall_ms bigint,                -- device wall-clock of the error
  stack text,
  fields jsonb,                  -- structured DiagEvent fields, when present
  received_at timestamptz default now()
);

create index if not exists errors_received on errors (received_at desc);
create index if not exists errors_session on errors (session_id);
create index if not exists errors_level on errors (level);
