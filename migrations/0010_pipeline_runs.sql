-- Pipeline run status — live, CONTENT-FREE telemetry from the box-hosted conductor so a run can be monitored
-- (API + dashboard) without the laptop that started it, and without exposing any transcript/audio content.
-- One row per (run_id, session_id): run_id = one conductor process (a box's lifetime); the row advances through
-- phases as the box processes the session, and closes with an end-to-end time. Purely operational metadata.
create table if not exists pipeline_runs (
  id            bigserial primary key,
  run_id        text not null,                       -- one conductor/box lifetime (e.g. box-<ip>-<ts>)
  session_id    text not null,
  box           text,                                -- box ip / instance id (operational, not a secret)
  phase         text,                                -- launch|download|ingest|candidates|whisper|distil|qwen|cohere|granite|fusion|post|done|failed|skipped
  model         text,                                -- current model/stage label (informational)
  status        text default 'running',              -- running|done|failed|skipped
  n_chunks      int,
  n_segments    int,
  progress      real,                                -- 0..1 within current phase (optional)
  note          text,                                -- short status line (no content)
  started_at    timestamptz default now(),
  updated_at    timestamptz default now(),
  ended_at      timestamptz,
  elapsed_secs  int,                                 -- end-to-end for this session
  phases        jsonb default '{}'::jsonb,           -- {phase: seconds} accumulated per-phase timing
  meta          jsonb default '{}'::jsonb,           -- open-ended (pipeline version, whisper_variant, ...)
  unique (run_id, session_id)
);
create index if not exists pipeline_runs_updated on pipeline_runs (updated_at desc);
create index if not exists pipeline_runs_run on pipeline_runs (run_id, updated_at desc);
