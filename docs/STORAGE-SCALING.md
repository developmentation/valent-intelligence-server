# Storage scaling plan — Valent Intelligence server

The phone pushes raw session files (audio `.aac`, media, `.jsonl`, `.vstream`) plus a derived
record index. Today those files land on a **10 GB Render persistent disk** at `/data/media`, and
the parsed records go into **Render Postgres**. One trip already wants ~12.6 GB; sustained capture
(and multiple devices) means we must plan for **hundreds of GB → multiple TB**. A single mounted
disk does not get us there economically. This is the staged plan.

## Where the bytes are

| Data | Size driver | Today | Long-term home |
|------|-------------|-------|----------------|
| Audio `.aac` chunks | ~1.9 MB/min while recording — the bulk | Render disk `/data/media` | **Object storage** (S3/R2/B2) |
| Photos / video | occasional, large | Render disk | **Object storage** |
| `.jsonl` / `.vstream` sensor files | steady, small-ish | Render disk | Object storage (raw) |
| Parsed `records` (jsonb) | 1.7M+ rows/trip | Postgres | Postgres (index only) — **not** the raw bytes |

Key point: `records` is a *derived index* (dashboard queries), not the source of truth. The raw
files on disk/object-store are canonical, so we can prune/rebuild the DB, and we must never let the
DB grow unbounded with blob-like data.

## Stage 0 — right now (unblock the current trip)

- **Client-side scope selector** (shipped): `Live / Recent 3 / All` on the Sync screen. On cellular
  the phone pushes only the live (or recent) session; the full backlog drains later on Wi-Fi. This
  keeps us under the disk ceiling without any server change.
- If a single Wi-Fi drain of everything is wanted before Stage 1, **temporarily bump the Render
  disk** (see below) — a stopgap, not the destination.

## Stage 1 — bump the Render disk (buys months, hours of work: ~0)

Render disks resize **up** in place (data preserved; a redeploy/restart applies it). Good up to the
plan's max (tens–low-hundreds of GB). Do this to cover the near term while Stage 2 is built.

```bash
# via the Render API (disk id from GET /v1/services/{id})
curl -X PATCH https://api.render.com/v1/disks/dsk-... \
  -H "Authorization: Bearer $RENDER_API_KEY" -H "Content-Type: application/json" \
  -d '{"sizeGB": 50}'
```

Note: disks are **single-instance** (can't be shared across web + worker) and are the *most
expensive* per-GB option. Treat Stage 1 as runway, not the answer for TB scale.

## Stage 2 — object storage for raw files (the real fix, TB-scale)

Move `storeMember`'s file writes from the local disk to an S3-compatible bucket. Recommended:
**Cloudflare R2** (zero egress fees — matters for a public gallery) or **Backblaze B2**; AWS S3
works too. Postgres keeps only metadata + the record index; the disk shrinks back to ~2 GB (APKs +
scratch) or goes away.

**The single code seam.** `ingest.js → storeMember()` is the only place that touches file bytes:

```js
// today:
fs.writeFileSync(path.join(MEDIA_ROOT, sessionId, stream, filename), m.bytes);
// stage 2:
await putObject(`${sessionId}/${stream}/${filename}`, m.bytes, contentTypeFor(filename));
```

and `server.js`'s `/media/*` route serves via a **presigned URL redirect** (or a CDN domain in front
of the bucket) instead of `res.sendFile`. Everything else — dedup by `files.sha256`, the `records`
index, the dashboard — is unchanged. Storage becomes effectively unbounded (R2/B2/S3 scale to PB)
and cost is ~$15/TB/month with no egress on R2.

Migration of existing on-disk files: a one-off script walks `/data/media`, uploads each to the
bucket, verifies, and deletes locally — same verify-then-delete discipline as the phone→server push.

## Stage 3 — lifecycle + the public gallery

- **Tiering:** keep audio in standard storage for N days, then transition cold objects to
  infrequent-access / archive classes (bucket lifecycle rules) — audio is the bulk and is rarely
  re-read once processed.
- **Public gallery** reads only GPS tracks + photos (never audio) — those are tiny; serve via the
  CDN in front of the bucket. The audio never needs a public path.
- **Postgres hygiene:** `records` can be partitioned by session/month and old partitions dropped or
  rolled to cold storage once the dashboards no longer need them; the raw `.jsonl` in the bucket can
  always rebuild them.

## Decision shortlist

1. **Now:** scope selector (done) ± a one-time disk bump for a full Wi-Fi drain.
2. **This month:** Stage 1 resize to ~50 GB for headroom.
3. **Before multi-device / months of capture:** Stage 2 — R2/B2 behind `storeMember`, disk drops to
   scratch-only. This is the only path that reaches 500 GB–1 TB+ affordably.
