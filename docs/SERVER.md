# Valent Intelligence server — architecture & reference

The single source of truth for what the server *is today*. (Forward-looking design lives in
`TARGET-ARCHITECTURE.md`; storage scaling in `STORAGE-SCALING.md`; the anti-data-loss guarantees in
`DATA-INTEGRITY.md`.) Node/Express on Render, one instance, Postgres + a persistent disk.

## Modules (each does one thing)
| File | Responsibility |
|------|----------------|
| `server.js` | HTTP surface: routes, auth (JWT), SSE, the two ingest lanes, viewer APIs, admin, static dashboard. No storage/DB details beyond calling the modules below. |
| `ingest.js` | Bulk pipeline: parse the `VBATCH1` container, SHA-verify every member, store files, index the queryable record streams, keep `sessions`/`streams` catalogs current. |
| `storage.js` | The blob seam. `put/get/exists/del/localPath/publicUrl/serve`. Disk driver today; drop-in S3/R2 later (callers never touch `fs`). |
| `db.js` | `pg` pool + `migrate()` — applies `migrations/*.sql` in order via a `schema_migrations` ledger. |
| `migrations/` | Sequenced schema. Every change is a new numbered file (see `migrations/README.md`). |
| `public/dashboard.html` | The viewer: live map, gallery + lightbox, streams panel, audio banner + scene strip, transcript, streaming player, SSE-driven. |

## The two lanes (split by latency, not dataset)
- **Bulk lane — `POST /ingest`** — the durable, complete, ordered record. `gzip(VBATCH1)` of many chunk
  files; each member SHA-verified before storage; dedup by `files.sha256`; jsonl of the queryable
  streams exploded into `records`. Latency-insensitive (minutes fine). **Source of truth.**
- **Live lane** — low-latency overlay, independent of the bulk lane:
  - `POST /ingest/live` — tiny JSON `{session, points[], scene}`, ~every 10 s. Kept as an in-memory
    fresh tail per session (ring + TTL), merged into `/api/track`. Ephemeral by design.
  - `POST /ingest/live/photo` — a captured photo (raw bytes) stored immediately + `files` row +
    gallery broadcast. De-duped against the bulk copy by SHA.

## Endpoint reference
| Method · Path | Auth | Purpose |
|---|---|---|
| `GET /health` | none | `{ok, db, time}` |
| `POST /ingest` | Bearer INGEST_TOKEN | bulk batch (see above) |
| `POST /ingest/live` | Bearer | live GPS fixes + scene |
| `POST /ingest/live/photo` | Bearer | instant photo (X-Session/X-Filename/X-Stream headers) |
| `GET /admin/stats` | Bearer | corpus totals, per-kind/stream, sessions, recent batches |
| `GET /admin/validate?session=` | Bearer | per-session acceptance check vs the phone manifest (see DATA-INTEGRITY) |
| `POST /admin/apk` · `DELETE /admin/apk/:name` | Bearer | publish / prune APK builds |
| `GET /login` · `POST /login` · `POST /logout` | — | JWT cookie auth (15-min access + 14-day refresh, HttpOnly, sliding) |
| `GET /` | JWT | dashboard |
| `GET /api/stream` | JWT | **SSE**: `ingest` / `live` / `photo` events |
| `GET /api/sessions` | JWT | session list (newest first) |
| `GET /api/status?session=` | JWT | latest activity/location/wifi/satellites/scene/now-playing/speech + totals (session-scoped) |
| `GET /api/track?session=&max=` | JWT | GPS track, LOD-decimated per session, with the live tail merged |
| `GET /api/streams?session=` | JWT | every stream + counts/bytes/last-seen |
| `GET /api/scene?session=&mins=` | JWT | rolling audio-scene history (default 3 min) |
| `GET /api/transcript?session=` | JWT | full cumulative transcript |
| `GET /api/audio?session=` | JWT | ordered `.aac` clips for the streaming player |
| `GET /api/manifest?session=` | JWT | per-session streams manifest (visualizer entry point) |
| `GET /api/gallery?session=` | JWT | media items with URLs |
| `GET /media/*` | JWT | serve a stored file (via the storage seam) |
| `GET /download` · `/download/app.apk` · `/download/apk/:name` | — | APK install page + downloads |
| `GET /setup` | JWT | QR to provision the phone |

## Data model (Postgres)
- `sessions` — id, device, first/last wall, bytes, file_count, record_count.
- `streams` — per session×stream catalog: kind, time span, file/record counts, bytes.
- `files` — every stored file: session/stream/filename/path, **sha256 (unique → dedup)**, bytes, kind.
- `records` — **selective** index (only dashboard-queryable streams: location, gnss, wifi,
  motion_activity, audio_scene, media, speech, + any GPS-bearing) as `jsonb` with `ern`/`wall`.
- `batches` — one row per received bulk batch (sha256 unique).
- `schema_migrations` — applied migration ledger.

The raw files on disk are canonical; `records` is a rebuildable index (keeps Postgres small).

## Storage layout (disk, R2-ready)
`MEDIA_ROOT/{session}/{stream}/{file}` (raw, canonical) · `{session}/manifest.jsonl` (overwritten each
batch) · `_derived/{session}/…` reserved for processing outputs. APKs at `APK_DIR`.

## Secrets (Render env only — never in the repo)
`DATABASE_URL`, `INGEST_TOKEN`, `ADMIN_PASSWORD`, `JWT_SECRET`(||`SESSION_SECRET`), `MEDIA_ROOT`, `APK_DIR`.

## Run / deploy
- Local: set `DATABASE_URL`, `npm start` (runs `migrate()` on boot).
- Render: push to `main`; deploy via the Render API (public repo doesn't auto-deploy). New migrations
  apply automatically on boot.

## Known single-instance constraints (by design, until scale needs it)
SSE clients + the live-track tail are in-memory (per-process). Going multi-instance requires Redis
pub/sub for SSE + object storage (the disk is single-instance). CPU work (transcode) must move to
`worker_threads` / a worker, never the request path. See TARGET-ARCHITECTURE.md.
