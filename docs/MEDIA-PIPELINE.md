# Media pipeline — fast images + large-video ingest

How captured photos/videos get **in** (upload) and **out** (served fast to galleries), plus the on-disk
thumbnail cache. Read before touching `imagepipe.js`, the `/media` / `/pub/:id/media` routes, or the
capture app's media sync.

## Serving images fast: on-the-fly thumbnails (`imagepipe.js`)

A phone photo here is often **3–20 MB**. The curate builder, the published page, and every gallery grid
used to fetch those full-resolution originals for *every thumbnail*, so a 20-photo grid pulled ~80 MB and
loaded slowly.

Now any media URL accepts a **`?w=<width>`** query param:

- `GET /media/<key>?w=400` (admin) and `GET /pub/:id/media/<key>?w=400` (public) return a JPEG resized to
  that width, re-encoded with **mozjpeg q78, progressive**, EXIF-rotated then stripped.
- **Allowlisted widths only** — `140, 200, 320, 400, 500, 800, 1200, 1600, 2400` — so the derived cache
  can't explode on arbitrary `?w=317`. An unknown width, a non-image, a missing `w`, or a decode failure
  **falls through to the original bytes** (it can never make a working image 404).
- Derived JPEGs are cached on disk at `MEDIA_ROOT/_derived/w<width>/<key>.jpg`. Captures are uniquely
  named and never change, so a derivative is valid forever → served
  `Cache-Control: public, max-age=31536000, immutable` (browsers cache hard; repeat views are instant).
  First request per (key,width) builds+caches; later requests are a plain file send.

**Measured (live, real 4.1 MB photo):** `?w=400` → **17.6 KB** (0.43%), `?w=1600` → 248 KB (6%). A
20-photo grid drops from ~82 MB to ~0.35 MB (~230×). Cache hit confirmed; unknown width falls back to the
4.1 MB original.

**Front-end request sizes** (already wired):

| surface | width |
|---|---|
| curate grid, publish gallery grid | `?w=400` / `?w=500` |
| publish lightbox + slideshow hero | `?w=1600` (blurred backdrop `?w=900`) |
| slideshow filmstrip | `?w=140` |
| video, and any "download original" | no `?w=` → original bytes |

`sharp` is the only image dep (`package.json`; prebuilt linux-x64 binary installed by Render's
`npm install`). If `sharp` ever fails to load, `imagepipe` degrades to serving originals.

**Edge caching:** the `immutable` header lets browsers cache, but `cf-cache-status` is `DYNAMIC` — Render's
shared Cloudflare does not edge-cache origin responses. True edge caching would need the account's own
Cloudflare zone + a "Cache Everything" rule on `/pub/*/media/*`. Not required for the speed win (payload
size + browser cache carry it); noted for later.

## Uploading media (photos/videos): the live lane

Media uploads through **`POST /ingest/live/photo`** (same route for photo and video):

- **No body parser** — the request stream is piped straight to disk (`storage.putStream`) with constant
  memory and hashed as it goes, so a large video never buffers whole in RAM on the single instance.
- Stores the file + a `files` row with **`kind='media'`** (that's what the gallery/publish surfaces query;
  the bulk `/ingest` lane stores sensor/audio chunks, not media).
- **The bulk `/ingest` lane caps bodies at 64 MB** (`express.raw limit:'64mb'`) — a ~150 MB video can
  *never* go through it. Media must use the streaming live lane.
- **No body-size cap on the media lane**, and the HTTP server timeouts are opened up for big uploads
  (`requestTimeout=0`, `server.timeout=0`, generous headers/keep-alive) so a multi-GB video can stream to
  disk over a slow phone link without being cut off. Tested: **250 MB** POST → 200 in ~13 s.
- **The practical ceiling is the CDN/edge, not the app.** Requests transit Render's shared Cloudflare
  (`server: cloudflare`, `cf-ray`), which empirically passed 250 MB. For **very** large uploads (multi-GB,
  toward the 8 GB target) the reliable path is a **resumable/chunked upload** (tus-style) or a direct-to-
  object-store presigned PUT that bypasses the edge — a future item; the app-side server accepts whatever
  arrives today.
- **Instance:** Render **`pro` (2 CPU / 4 GB)** — upgraded from `starter` so transcoding has headroom
  (see the ladder below).

The app side (which lane the phone uses, and the retry that was missing for off-grid captures) is in the
capture repo: `claude/docs/SERVER-SYNC.md`.

## Reliable large uploads: resumable, checksum-validated chunks (`uploadpipe.js`)

For **longform / multi-GB** media that a single request can't push past the CDN edge, the app uploads in
**chunks** (8 MB), and the server verifies integrity at two levels — so a completed upload is guaranteed
byte-exact. Endpoints (all Bearer **INGEST_TOKEN**, mounted above the global JSON parser):

- `POST /ingest/upload/init` — `{session, filename, stream, size, sha256, chunkSize}` → `{uploadId,
  totalChunks, received:[…]}`. `uploadId` is derived from `(session, filename, sha256)` so a re-init of an
  interrupted upload returns which chunks already landed → the client sends only the rest (**resume**).
- `PUT /ingest/upload/chunk` — headers `x-upload-id`, `x-chunk-index`, `x-chunk-sha256`; raw chunk body
  streamed to disk. The server **verifies each chunk's SHA-256 on arrival** (mismatch → 422, re-send).
- `POST /ingest/upload/complete` — `{uploadId}`. Reassembles the parts in order and **verifies the
  WHOLE-FILE SHA-256** against what `init` declared. Only a byte-exact match is committed (file row +
  transcode enqueue); a mismatch discards the staging and the client restarts. Missing chunks → 409 with
  the `missing:[…]` list.
- `GET /ingest/upload/status?id=` — `{received, missing, totalChunks}` for resume.

Staging lives on disk under `MEDIA_ROOT/_uploads/<id>/` (meta.json + `<index>.part`); everything streams
(constant memory). Chunks are small, so this sidesteps the edge single-request ceiling entirely — the path
to the 8 GB target. Verified end-to-end: per-chunk 422 on corruption, 409 + resume of the missing chunk,
whole-file SHA match, exact byte count. Client: `claude/.../sync/ChunkedUploader.kt` (used by `SyncWorker`
for media over 24 MB; smaller media take the single-shot live lane).

## Serving videos fast: the web rendition ladder (`videopipe.js`)

Captured videos are large. Every server surface — dashboard, `/live`, curate, published — now serves a
small **web-optimized MP4** by default; the ORIGINAL is untouched and downloadable (`?dl=1`).

- On ingest (and on first view), a video is transcoded into a **ladder of renditions** keyed by long-edge
  cap: **854 (~480p), 1280 (~720p, the default), 1920 (~1080p)** — only those `≤` the source's long edge
  (a 4K source tops out at ~1080p web; a small source gets one native re-encode). H.264, `crf 28`,
  `veryfast`, `+faststart` (moov atom up front for instant web playback), AAC audio if present. Cached at
  `MEDIA_ROOT/_derived/video/<key>/<edge>.mp4`, served `immutable`. Orientation-correct (portrait +
  landscape both fit the box).
- **Serve:** a video URL returns the **default ~720p** rendition; `?q=480|720|1080` picks one (nearest
  available); `?dl=1` / `?orig=1` returns the original. The original is never modified.
- **Poster frames:** ffmpeg also extracts one representative frame (`~1s` in, first-frame fallback) as
  `poster.jpg` per video. Served via `<video-url>?poster=1` (resizable with `?w=`, cached). Every surface's
  video tiles use it as an `<img>` (with a play-badge overlay) and the players set it as their `poster=`,
  so video thumbnails render reliably instead of a blank box (a browser `<video>` poster was unreliable).
  404 until ready → the `<img>` falls back to the play-badge box. Backfill generates posters for videos
  that already have renditions too.
- **Transcoding is a background queue OFF the request thread** — each rendition is its own ffmpeg child
  process. Concurrency scales with CPUs but always reserves a core for the web server:
  `CONCURRENCY = max(1, cpus-1)` (hard-capped at 4, `TRANSCODE_CONCURRENCY` env override), each ffmpeg
  pinned to `-threads 1`. Graceful no-op if `ffmpeg-static` is unavailable (serves originals; never
  crashes). Local test: 1080p → 854/1280 renditions at a fraction of the source size.
  - **CPU count via cgroup, not `os.cpus()`.** In Render's container `os.cpus().length` is the *host's*
    32 cores, not the 2 allocated — using it spawned ~20 ffmpeg and thrashed the box. `effectiveCpus()`
    reads the cgroup v2/v1 CPU quota (`cpu.max` / `cpu.cfs_quota_us`) → 2 on `pro` → concurrency 1.
- **Backfill existing videos:** `POST /admin/transcode-backfill` (Bearer INGEST_TOKEN) enqueues every
  video lacking a web version (re-runnable, skips done); `GET /admin/transcode-status` reports
  `{available, concurrency, running, pending, done, failed, planned}`.

## Purge a session (cleanup / reclaim disk)

`POST /admin/purge-session` (Bearer **INGEST_TOKEN**, body `{"session":"<id>"}`) deletes a session's files
(disk + its `_derived` thumbnails), its `records`, its `files` rows, and the `sessions` row. Destructive,
irreversible, requires an **exact** id (never a wildcard). For removing test/junk sessions and reclaiming
disk. Example:

```
curl -sk -X POST "$BASE/admin/purge-session" -H "Authorization: Bearer $INGEST_TOKEN" \
  -H "Content-Type: application/json" -d '{"session":"ZZTEST"}'
```

See also `STORAGE-SCALING.md` (disk growth / object-store seam) and `PUBLICATIONS.md` (public surface).
