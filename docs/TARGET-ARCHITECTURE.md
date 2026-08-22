# Target data-platform architecture — Valent Intelligence

Goal: a beautiful web/mobile/desktop visualizer that **replays and stitches every stream on one clock**
in real time, with heavy post-processing (incl. GPU) layered on top — over live *and* completed
sessions. This is the architecture to build toward. The guiding rule: **route each data class to the
store that matches its access pattern.** One store cannot be fast at bytes, time-windows, geo, and
analytics at once.

## The four stores (by access pattern, not by data type)

```
                         ┌─────────────────────────────────────────────┐
   phone push ──►ingest──►│ 1. CATALOG (Postgres)  small, relational     │◄── visualizer "what exists"
                         │    sessions, streams, files, jobs, artifacts │
                         └─────────────────────────────────────────────┘
        │                ┌─────────────────────────────────────────────┐
        ├───────────────►│ 2. TIME-SERIES (Postgres + TimescaleDB +     │◄── replay: windowed reads
        │  dense streams │    PostGIS + pgvector)                       │    + LOD + map + similarity
        │  (loc, motion, │    hypertables, continuous-aggregate LOD,    │
        │   sensors,     │    geography, feature vectors                │
        │   derived      └─────────────────────────────────────────────┘
        │   features)    ┌─────────────────────────────────────────────┐
        ├───────────────►│ 3. OBJECT STORAGE (R2/S3)  the bytes         │◄── CDN + range requests
        │  media + raw   │    raw/ audio·video·image·jsonl·vstream       │    (audio/video seek)
        │                │    derived/ HLS, waveforms, tiles, thumbs,    │
        │                │    embeddings.parquet, GPU outputs           │
        │                └─────────────────────────────────────────────┘
        │                ┌─────────────────────────────────────────────┐
        └───────────────►│ 4. ANALYTICS (Parquet in R2 + DuckDB/CH)     │◄── GPU/batch full-fidelity
           full-fidelity │    columnar per session/stream               │    scans, model training
           samples       └─────────────────────────────────────────────┘
```

### 1. Catalog — Postgres (relational, stays small)
The visualizer's first call and the system's spine. Tables: `sessions`, `streams` (per session×stream:
sample rate, time range, LOD tiers available, artifact keys), `files`, `batches`, `jobs`,
`artifacts` (derived-output registry), `users`/`shares`. Never holds bulk samples or blobs — it holds
*where everything is* and *what state it's in*. Small, indexed, sub-ms lookups.

### 2. Time-series — Postgres + TimescaleDB + PostGIS + pgvector (the hot replay store)
This single extension-loaded Postgres collapses four needs and is the highest-leverage choice:
- **Timescale hypertables** for location, motion/IMU, and every dense sensor stream, partitioned by
  time. Compresses ~10–20× and makes `where session=? and wall between ? and ?` a partition-pruned
  index scan — exactly the replay query.
- **Continuous aggregates = built-in Level-of-Detail.** Pre-roll each stream into 1 s / 10 s / 1 min
  buckets (avg/min/max/count, activity label, GPS-simplified). The zoomed-out timeline and map read
  the *aggregate* (O(pixels)) instead of 1.3 M raw points (O(samples)). Aggregates refresh
  incrementally, so **live sessions get LOD as chunks land.**
- **PostGIS** for the map: `geography` points, spatial index, `ST_Simplify`/bbox for viewport-scoped
  tracks; graduate to vector tiles (Martin/pg_tileserv → MVT) when the naive path isn't enough.
- **pgvector** for embeddings the GPU produces (similarity search: "find moments like this").

### 3. Object storage — R2/S3 (the bytes; canonical + derived)
- `raw/{session}/{stream}/{file}` — audio `.aac`, video, images, and the raw `.jsonl`/`.vstream`
  (ultimate source of truth; either other store can be rebuilt from these).
- `derived/{session}/...` — GPU/post-processing outputs: HLS/DASH renditions + thumbnails (video),
  waveform peaks + spectrograms + transcripts (audio), map vector tiles, `embeddings.parquet`.
- Served via CDN with **HTTP range** (audio/video scrubbing) and presigned URLs. **Cloudflare R2**
  recommended — zero egress fees, which matters for a public gallery. Effectively unbounded, cheap.

### 4. Analytics — Parquet + DuckDB/ClickHouse (GPU & batch)
Full-fidelity samples also land as **columnar Parquet** in object storage (`analytics/{session}/{stream}.parquet`).
The GPU/analysis layer reads Parquet directly (DuckDB embedded in the worker, or ClickHouse at scale) —
cheap storage, blazing analytical scans, no load on the hot Postgres. This is where model training,
re-processing, and cross-session queries live.

## Data-class routing (the user's question, concretely)

| Class | Canonical bytes | Hot/queryable | Derived for the UI |
|-------|-----------------|---------------|--------------------|
| **Video** | R2 `raw/` | catalog row + time range | HLS/DASH + poster/thumbs (GPU/ffmpeg) in `derived/` |
| **Audio** | R2 `raw/` | catalog + range | waveform peaks, spectrogram, transcript, tags (GPU) |
| **Image** | R2 `raw/` | catalog + capture time | thumbnails / responsive sizes |
| **Location** | R2 raw `.jsonl` | PostGIS + Timescale hypertable | LOD tracks + vector tiles |
| **Motion/IMU** | R2 raw `.vstream` | Timescale hypertable | per-second magnitude/activity LOD |
| **Other sensors** (wifi/cell/gnss/events) | R2 raw `.jsonl` | Timescale/PG summary rows | latest-value + event markers |

Principle: **bytes on object storage; dense numeric time-series in Timescale (+ Parquet mirror); geo in
PostGIS; the map of "where is everything" in the relational catalog.** Postgres never stores blobs or
millions of jsonb rows again.

## The replay contract — a per-session streams manifest

The visualizer's data contract, like an HLS manifest but multi-modal. On ingest (and updated live), write
`derived/{session}/manifest.json`:

```jsonc
{
  "session": "20260810-062150",
  "clock": { "firstWall": 1723272110498, "lastWall": 1723315710498 },
  "streams": [
    { "key": "audio",    "kind": "audio", "segments": "hls/audio.m3u8", "range": [t0, t1] },
    { "key": "location", "kind": "geo",   "lod": ["1s","10s","1m"], "tiles": "tiles/{z}/{x}/{y}.mvt" },
    { "key": "motion",   "kind": "series","lod": ["1s","10s"], "channels": ["ax","ay","az","mag"] },
    { "key": "video",    "kind": "video", "clips": [{ "start": ts, "src": "hls/clip1.m3u8" }] }
  ]
}
```

The client loads the manifest once, then **streams windows**: for playhead `t` + viewport, it pulls the
current media segment (range-seek from CDN), each stream's visible window at the right LOD (Timescale
aggregate endpoint), and the viewport-simplified track (PostGIS/tiles). Scrubbing = re-window, not
refetch-all. Works identically for a live session (manifest + aggregates grow) and a finished one.

## Processing / GPU layer (live + batch, same model)

- **Jobs are first-class.** Ingesting a chunk/session enqueues jobs in a `jobs` table (or SQS/Redis at
  scale). A job is `(session, stream, chunk?, model, model_version)` — **idempotent and versioned**, so
  reprocessing with a better model is safe and produces a new artifact version rather than clobbering.
- **GPU worker (Lambda GPU / dedicated GPU box)** pulls raw chunks from R2, runs the model
  (transcription, audio tagging, video analysis, embeddings), and writes: derived artifacts → R2,
  feature rows → Timescale, vectors → pgvector, and an `artifacts` row → catalog. It never touches the
  hot serving path.
- **Live streaming:** each chunk that lands fires a per-chunk job, so a live session is analyzed
  incrementally and the visualizer sees results within seconds. **Completed sessions** enqueue whole-
  session (or backfill) jobs. Same queue, same idempotency keys — live and batch are one pipeline.
- **Feature outputs for playback** (per-second loudness, activity labels, detected events, scene tags)
  go to Timescale so the timeline overlays query them as fast as raw streams.

## Cross-cutting invariants

- **Real capture time is the only ordering.** Everything keyed by `wall` + monotonic `ern`; LOD buckets
  and the manifest are wall-time. Upload order is irrelevant (already true; dedup by sha256).
- **Content-addressed + versioned.** Raw by input sha; derived by `(input_sha, model, version)` — makes
  reprocessing, caching, and cache-busting trivial.
- **Live-first everywhere.** Partial sessions must render; aggregates + manifest update incrementally.
- **Postgres stays lean.** Catalog + Timescale hypertables (compressed) + pgvector. Bulk bytes and
  cold analytics never sit in the relational tables.

## Migration path from today

1. **Object storage (R2)** behind `storeMember` — move media + raw files off the local disk. *(planned;
   see STORAGE-SCALING.md)*
2. **Selective jsonb → Timescale.** Load TimescaleDB + PostGIS; route location/motion/sensor into
   hypertables with continuous aggregates instead of the current selective `records` jsonb index. The
   `records` table becomes a Timescale hypertable (or is replaced by per-stream hypertables).
3. **Parquet mirror** of dense streams to R2 for the analytics/GPU path (DuckDB).
4. **`jobs` + `artifacts` tables + a GPU worker**; wire per-chunk jobs on ingest.
5. **Per-session `manifest.json`** generation (live-updating) — the visualizer's entry point.
6. Build the visualizer against the manifest + windowed-LOD + media-range endpoints.

## One real fork to decide

- **Timescale-in-Postgres (recommended default)** vs a separate **ClickHouse** cluster for the hot
  time-series. Start with Timescale: it keeps geo (PostGIS), time-series (hypertables + LOD), vectors
  (pgvector), and the catalog in one managed database with plain SQL — far simpler to operate and more
  than fast enough for one-to-tens of devices. Move the *analytical* tier to ClickHouse only if
  cross-session scans over billions of rows become the bottleneck; the hot replay path can stay on
  Timescale regardless. Object storage + Parquet + the manifest contract are unchanged either way, so
  this decision is reversible and can be deferred.
```
