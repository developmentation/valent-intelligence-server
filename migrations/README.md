# Database migrations

Every schema change is a **new, sequentially-numbered SQL file** here — never an inline edit to
`db.js` and never a hand-run `ALTER` against the database.

## Convention
- Filename: `NNNN_short_description.sql` (zero-padded, monotonically increasing, e.g. `0003_add_lod.sql`).
- Applied in filename order, each in its own transaction, exactly once.
- Prefer idempotent statements (`create table if not exists`, `create index if not exists`,
  `alter table ... add column if not exists`) so a migration is safe to re-run and applies cleanly to
  both a fresh DB and the existing production DB.
- Never edit a migration that has already been applied in production — write a new one that alters.

## How it runs
`db.js` → `init()` → `migrate()` on server boot:
1. ensures a `schema_migrations (version, applied_at)` ledger exists,
2. reads `migrations/*.sql` sorted by name,
3. runs each unapplied file inside a transaction and records its `version` (the filename without
   `.sql`). A failure rolls back that file and aborts boot (fail fast, no partial schema).

## Adding a change
1. Add `migrations/000N_thing.sql`.
2. Commit + push. The next deploy applies it automatically on boot.
3. To apply locally: set `DATABASE_URL` and start the server (or run `node -e "require('./db').init()"`).
