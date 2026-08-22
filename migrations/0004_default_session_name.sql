-- 0004_default_session_name: relabel sessions whose title leaked a per-stream ML model id (the motion
-- HAR "tinyhar-wisdm-v1") or was null, to the default name "Valent". Going forward the name comes from
-- session_open's `device` field (default "Valent", user-configurable later) — see ingest.js. This is a
-- one-time data fix for rows ingested before that change; applied once via the schema_migrations ledger.

update sessions set device = 'Valent'
 where device is null or device = 'tinyhar-wisdm-v1';
