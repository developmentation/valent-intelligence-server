-- 0002_streams: per session x stream catalog — the visualizer manifest source.
-- Kept current on ingest (kind, real capture time-span, file/record counts, bytes). Never holds
-- samples. Idempotent so it no-ops against the production DB that already had this table.

create table if not exists streams (
  session_id text,
  stream text,
  kind text,
  first_wall bigint,
  last_wall bigint,
  file_count int default 0,
  record_count bigint default 0,
  bytes bigint default 0,
  updated_at timestamptz default now(),
  primary key (session_id, stream)
);

create index if not exists streams_session on streams (session_id);
