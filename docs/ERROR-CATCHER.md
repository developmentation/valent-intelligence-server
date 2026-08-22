# Universal error catcher → errors API

A device fault should be evaluable **without a cable**. The app already caught crashes and errors
locally; this pipeline carries them to the server so any fault can be read (and diagnosed) remotely.

## The chain

```
app (on device)                              server                         you
─────────────────────────────────────────   ────────────────────────────   ───────────────────────
CrashReporter  (uncaught → crashes.jsonl) ┐
FlightRecorder (caught error/warn ring)   ┘→ ErrorReporter.flush ──POST──▶ /ingest/errors → errors  ──▶ GET /admin/errors
                                             (best-effort, deduped)         (Postgres, unique fp)       (?format=text)
```

### On-device capture (already existed, unchanged)
- **`CrashReporter`** (core-diagnostics) — a `Thread.setDefaultUncaughtExceptionHandler` that writes
  every uncaught exception (any thread → fatal) to `diagnostics/crashes.jsonl` **synchronously**, so it
  survives the process death that produced it. Chains to the platform handler (tombstone + ApplicationExitInfo intact).
- **`FlightRecorder`** (core-diagnostics) — every `recorder.error(...)` / `recorder.warn(...)` for
  *caught* faults (the ones a try/catch swallows) lands in an in-memory ring + the disk jsonl.

So "universal" = **uncaught crashes** (CrashReporter) + **caught errors/warns** (FlightRecorder). A silent
failure that neither crashes nor logs is invisible by definition — the fix for those is to add a
`recorder.warn/error` breadcrumb at the point it happens (see the timeline example below).

### Upload (new — `app/sync/ErrorReporter.kt`)
Best-effort and idempotent, mirroring `LiveUploader`:
- Reads pending crashes (past a saved wall-clock cursor) + error/warn events (past a saved seq cursor).
- `POST {endpoint}/errors` — `{device, events:[{fp, level, kind, component, where, message, wall, build, stack, fields}]}`.
- Advances the cursors **only on a 2xx**, so a dropped post is retried. The server also dedups on `fp`.
- **When it runs:** on app launch (`ValentCaptureApp` — ships the crash that just killed the process),
  and every ~60 s while recording (`CaptureService` live loop — ships in-session caught errors).
  `ErrorReporter.flushAsync(context)` fires one off any thread (e.g. the timeline uses it on view).
- Gated on sync being configured + enabled (uses the same `SecureStore` endpoint/key as the sync lanes).

### Server (new — `/ingest/errors`, `/admin/errors`, migration `0003_errors`)
- `errors` table, `fingerprint` unique (client `fp` or a `wall|type|where|msg` derivation) → a re-sent
  crash lands once.
- `POST /ingest/errors` (Bearer INGEST_TOKEN) — inserts, `on conflict (fingerprint) do nothing`, SSE `{type:'error'}`.

## Reading errors (how to evaluate a fault)

`GET /admin/errors` (Bearer INGEST_TOKEN). Filters: `session`, `level` (FATAL|ERROR|WARN), `device`,
`since` (ms), `limit` (default 100, max 500). Add `format=text` for a compact, readable dump:

```bash
# newest 50, human/LLM-readable
curl -s -H "Authorization: Bearer $INGEST_TOKEN" \
  "$BASE/admin/errors?limit=50&format=text"

# just the fatal crashes for one session, as JSON
curl -s -H "Authorization: Bearer $INGEST_TOKEN" \
  "$BASE/admin/errors?session=<id>&level=FATAL"
```

## Worked example — the blank fusion timeline

The bug that motivated this: a past session's on-device **Fusion timeline was blank and the map missing**,
while the coverage bar was green and photo thumbnails rendered. Root cause: the sync's delete-after-confirm
reclaims a synced session's chunk data (`location/`, `events/`, `motion/`) to free space, keeping the
`manifest.jsonl` and captured media. The timeline reads the now-deleted chunk files → empty lanes + no
map; the coverage bar reads the manifest (kept) → still green; media thumbnails read `photos/` (kept).

Two fixes shipped together:
1. **Honest UI** — `TimelineData` now detects the reclaimed state (continuous coverage in the manifest but
   zero series data) and the timeline shows a "Detailed data uploaded — view on the server" notice instead
   of a blank chart.
2. **Self-reporting** — whenever the timeline finds no series data it logs a `WARN` with a per-stream
   breadcrumb (counts, `startErn`, streams present), which this pipeline uploads. So if it ever renders
   blank for a *different* reason, `/admin/errors?level=WARN` says exactly which read came back empty —
   no device on a cable required.
