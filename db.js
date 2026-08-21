'use strict';
const { Pool } = require('pg');

// Render Postgres requires SSL from outside its network; inside it's plain. Accept self-signed.
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL && process.env.DATABASE_URL.includes('render.com')
    ? { rejectUnauthorized: false }
    : (process.env.PGSSL === 'require' ? { rejectUnauthorized: false } : false),
  max: 8,
});

const SCHEMA = `
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
`;

async function init() {
  await pool.query(SCHEMA);
}

module.exports = { pool, init };
