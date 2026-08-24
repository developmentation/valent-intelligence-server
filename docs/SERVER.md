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
| `public/live.html` | `/live` — a full-screen, always-fresh media player for the live session (fusion HUD, mini/fullscreen map, filmstrip). SSE-driven; auto-follows session→session. Same auth. |

## The two lanes (split by latency, not dataset)
- **Bulk lane — `POST /ingest`** — the durable, complete, ordered record. `gzip(VBATCH1)` of many chunk
  files; each member SHA-verified before storage; dedup by `files.sha256`; jsonl of the queryable
  streams exploded into `records`. Latency-insensitive (minutes fine). **Source of truth.**
- **Live lane** — low-latency overlay, independent of the bulk lane:
  - `POST /ingest/live` — tiny JSON `{session, points[], scene}`, ~every 10 s. Kept as an in-memory
    fresh tail per session (ring + TTL), merged into `/api/track`. Ephemeral by design.
  - `POST /ingest/live/photo` — a captured photo (raw bytes) stored immediately + `files` row +
    gallery broadcast. De-duped against the bulk copy by SHA.
  - `POST /ingest/errors` — the app's universal crash/error catcher's sink: persisted uncaught crashes
    + recent caught error/warn diagnostics, deduped on a client `fingerprint`. Read back via
    `GET /admin/errors` to evaluate a device fault without adb. See ERROR-CATCHER.md.

## Endpoint reference
| Method · Path | Auth | Purpose |
|---|---|---|
| `GET /health` | none | `{ok, db, time}` |
| `POST /ingest` | Bearer INGEST_TOKEN | bulk batch (see above) |
| `POST /ingest/live` | Bearer | live GPS fixes + scene |
| `POST /ingest/live/photo` | Bearer | instant photo (X-Session/X-Filename/X-Stream headers) |
| `POST /ingest/errors` | Bearer | device crash/error catcher upload (`{device, events[]}`, deduped on fingerprint) |
| `GET /admin/errors?session=&level=&device=&since=&limit=&format=text` | Bearer | captured errors, newest first; `format=text` = compact dump |
| `GET /admin/stats` | Bearer | corpus totals, per-kind/stream, sessions, recent batches |
| `GET /admin/validate?session=` | Bearer | per-session acceptance check vs the phone manifest (see DATA-INTEGRITY) |
| `POST /admin/apk` · `DELETE /admin/apk/:name` | Bearer | publish / prune APK builds |
| `GET /login` · `POST /login` · `POST /logout` | — | JWT cookie auth (15-min access + 14-day refresh, HttpOnly, sliding). `?next=<same-origin path>` returns there after sign-in (safePath-guarded) — how `/live` round-trips through login. |
| `GET /` | JWT | dashboard |
| `GET /live` | JWT | full-screen live media player (see LIVE-VIEW.md) |
| `GET /api/stream` | JWT | **SSE**: `ingest` / `live` / `photo` / `error` events |
| `GET /api/sessions` | JWT | session list (newest first) |
| `GET /api/status?session=` | JWT | latest activity/location/wifi/satellites/scene/now-playing/speech + totals (session-scoped) |
| `GET /api/track?session=&max=` | JWT | GPS track, LOD-decimated per session, with the live tail merged |
| `GET /api/streams?session=` | JWT | every stream + counts/bytes/last-seen |
| `GET /api/scene?session=&mins=` | JWT | rolling audio-scene history (default 3 min) |
| `GET /api/transcript?session=` | JWT | full cumulative transcript |
| `GET /api/audio?session=` | JWT | ordered `.aac` clips for the streaming player |
| `GET /api/manifest?session=` | JWT | per-session streams manifest (visualizer entry point) |
| `GET /api/gallery?session=` | JWT | media items with URLs |
| `GET /media/*` | JWT | image `?w=` → cached JPEG; video → cached web MP4 (`?q=480/720/1080`); `?dl=1` → original (see MEDIA-PIPELINE.md) |
| `POST /admin/transcode-backfill` | INGEST_TOKEN | enqueue web renditions for all existing videos (re-runnable) |
| `GET /admin/transcode-status` | INGEST_TOKEN | transcode queue status (available/running/pending/done/failed) |
| `POST /admin/purge-session` | INGEST_TOKEN | delete a session's files+derived+records+row (exact id; destructive) |
| `GET /curate` | JWT | publication builder UI (see PUBLICATIONS.md) |
| `GET · POST /admin/publications` | JWT | list / create publications |
| `GET · PATCH · DELETE /admin/publications/:id` | JWT | read / edit (incl. publish/unpublish) / delete a publication |
| `GET /publish/:id` | **none** | public journey viewer (only if published; else 404) |
| `GET /api/pub/:id` | **none** | public publication JSON: legs + de-noised track + gallery, **exclusions removed** |
| `GET /pub/:id/media/*` | **none** | public media — 404s unless published, a member session, AND not excluded; `?w=<allowed>` → cached downscaled JPEG (see MEDIA-PIPELINE.md) |
| `GET /download` · `/download/app.apk` · `/download/apk/:name` | — | APK install page + downloads |
| `GET /setup` | JWT | QR to provision the phone |

## Data model (Postgres)
- `sessions` — id, **device (the session's display NAME)**, first/last wall, bytes, file_count, record_count.
  The name comes from the manifest `session_open.device` field (app: `CaptureConfig.captureName`, default
  **"Valent"**, user-configurable later); the server defaults to "Valent" when absent. It is NEVER read
  from a manifest `model` field — those are per-stream ML model ids (e.g. the motion HAR
  `tinyhar-wisdm-v1`, audio `ced-small`) and leaked into titles before this rule.
- `streams` — per session×stream catalog: kind, time span, file/record counts, bytes.
- `files` — every stored file: session/stream/filename/path, **sha256 (unique → dedup)**, bytes, kind.
- `records` — **selective** index (only dashboard-queryable streams: location, gnss, wifi,
  motion_activity, audio_scene, media, speech, **power**, + any GPS-bearing) as `jsonb` with `ern`/`wall`.
  `power` feeds `/api/status.battery` (the `/live` battery pill); widen via `INDEX_STREAMS` env.
- `batches` — one row per received bulk batch (sha256 unique).
- `errors` — device-reported crashes/errors: level/kind/component/message/where/stack/fields, `wall_ms`,
  **fingerprint (unique → dedup)**. Fed by `/ingest/errors`, read by `/admin/errors`. See ERROR-CATCHER.md.
- `publications` — curated, shareable collections: id (UUID, the public URL), title/description,
  **`session_ids`** (ordered legs), **`excluded`** (media paths to hide), `published` flag. Pure metadata
  over sessions the server already holds — nothing is copied. Admin curates; the published view is open.
  See PUBLICATIONS.md.
- `schema_migrations` — applied migration ledger.

The raw files on disk are canonical; `records` is a rebuildable index (keeps Postgres small).

## Storage layout (disk, R2-ready)
`MEDIA_ROOT/{session}/{stream}/{file}` (raw, canonical) · `{session}/manifest.jsonl` (overwritten each
batch) · `_derived/{session}/…` reserved for processing outputs. APKs at `APK_DIR`.

## Secrets (Render env only — never in the repo)
`DATABASE_URL`, `INGEST_TOKEN`, `ADMIN_PASSWORD`, `JWT_SECRET`(||`SESSION_SECRET`), `MEDIA_ROOT`, `APK_DIR`.

## Run / deploy
- Local: set `DATABASE_URL`, `npm start` (runs `migrate()` on boot).
- Render: push to `main`, then trigger **one** deploy via the Render API. New migrations apply
  automatically on boot. Service `srv-da4bukk9v7es73aug02g`; API key + DB id in `../render/render.md`.

## Operational lessons (learned the hard way — keep these in mind)
- **Auto-deploy is slow/unreliable for this repo.** Don't rely on push-triggered deploys; trigger one
  explicitly (`POST /v1/services/<srv>/deploys`). But do NOT stack a manual deploy on top of one that
  already fired — two deploys restart the single instance back-to-back and give ~30–60 s of **502s**
  (a reload clears it). One deploy = one brief restart.
- **The DB is only reachable from inside Render** (the env `DATABASE_URL` is the internal host; the
  external host drops connections from here). So one-off **data fixes go in a migration**, not an ad-hoc
  external `psql`/`pg` — it runs on boot with internal access and is tracked (e.g. `0004` relabeled
  leaked session names to "Valent").
- **This machine's curl needs `-k`** to reach `onrender.com` / `api.render.com` (local CA issue), and
  `MSYS_NO_PATHCONV=1` in Git Bash for URLs with `/` query values — but UNSET it for `curl --data-binary
  @<file>` or the file path won't resolve and you upload **0 bytes** (bit us on an APK publish).
- **`/admin/validate` verdict turns on MISSING chunks only.** `extra` chunks (server holds more than
  the manifest declared — e.g. a sparse stream's first chunk recorded empty) are benign and reported in
  `alignment`/`note`, never a failure. A fully-uploaded session reads `COMPLETE`; an interrupted-but-
  complete one reads `UPLOADED_NOT_CLOSED` (no clean close, all declared data present).

## Known single-instance constraints (by design, until scale needs it)
SSE clients + the live-track tail are in-memory (per-process). Going multi-instance requires Redis
pub/sub for SSE + object storage (the disk is single-instance). CPU work (transcode) must move to
`worker_threads` / a worker, never the request path. See TARGET-ARCHITECTURE.md.
