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
- **Infra handles large media** — tested: a **140 MB** POST to `/ingest/live/photo` returned 200, and the
  store already holds media up to ~172 MB. So the ceiling is not the server/Cloudflare here.

The app side (which lane the phone uses, and the retry that was missing for off-grid captures) is in the
capture repo: `claude/docs/SERVER-SYNC.md`.

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
