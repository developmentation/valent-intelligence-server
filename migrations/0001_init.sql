-- 0001_init: initial ingest schema.
-- All statements are idempotent (if not exists) so this applies cleanly on a fresh DB AND on the
-- existing production DB whose tables were created by the pre-migration inline schema.

create table if not exists sessions (
  id text primary key,
  device text,
  first_wall bigint,
  last_wall bigint,
  bytes bigint default 0,
  file_count int default 0,
  record_count bigint default 0,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

create table if not exists batches (
  id bigserial primary key,
  session_id text,
  idx int,
  sha256 text unique,
  device text,
  bytes bigint,
  members int,
  received_at timestamptz default now()
);

create table if not exists files (
  id bigserial primary key,
  session_id text,
  stream text,
  filename text,
  path text,
  sha256 text unique,
  bytes bigint,
  kind text,           -- 'media' | 'audio' | 'json' | 'binary'
  received_at timestamptz default now()
);

create table if not exists records (
  id bigserial primary key,
  session_id text,
  stream text,
  ern bigint,
  wall bigint,
  data jsonb,
  received_at timestamptz default now()
);

create index if not exists records_stream_wall on records (stream, wall);
create index if not exists records_session on records (session_id, stream);
create index if not exists files_session on files (session_id, kind);
create index if not exists files_stream on files (session_id, stream, filename);
