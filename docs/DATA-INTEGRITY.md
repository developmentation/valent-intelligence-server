# Data integrity & anti-data-loss guarantees

Data loss is the one unacceptable failure. This documents the checks and balances that make it safe to
push from the phone and, eventually, delete the local copy — and the rule for never discovering a
grievous error after the fact.

## The core invariant (verified in app + server code)

**A chunk file exists on the phone ⟺ its `chunk_close` in the manifest has `bytes > 0`.**

- `JsonlCollector` (all sparse streams) opens the physical file **lazily — on the first record**. An
  empty window creates **no file**; the manifest records `chunk_close` with `records:0, "null":true`
  instead. (`capture/.../collectors/JsonlCollector.kt`.)
- Dense collectors (audio, device, motion, gnss, location…) always write, so their chunks always have
  `bytes > 0`.
- Therefore the manifest is the **authoritative list of files the phone wrote**, with no zero-byte
  ambiguity. Empirically confirmed: for every validated session, server file count per stream ==
  count of `chunk_close` with `bytes>0` (notifications 26=26, wifi 29=29, speech 4=4, motion 32×12
  writers, …).

## The chain of custody (phone → server)

1. **On the wire:** each batch member carries its SHA-256; the phone computes the body SHA. Nothing is
   assumed delivered until the server replies `2xx`.
2. **At ingest:** the server **re-verifies** the body SHA and every member SHA before writing
   (`ingest.js`). A mismatch is rejected — corrupt/truncated data never lands.
3. **Dedup by content:** `files.sha256` is unique; a re-sent chunk is idempotent, never doubled.
4. **Only then** does the phone mark that chunk uploaded. A dropped network loses nothing — unmarked
   chunks retry.
5. **Delete-after-confirm / Push & clear** deletes a local file **only after its batch got a `2xx`**
   (i.e., after the server SHA-verified and stored it). The manifest itself is never deleted.

## The validation gate (the belt-and-suspenders)

`GET /admin/validate?session=<id>` cross-checks the server against the phone's own manifest:

- **Alignment:** for every stream, the set of chunk indices the manifest says had content (`bytes>0`)
  must equal the set present on the server. Handles multi-file streams (audio `.anchors`, motion
  per-writer `.vstream`), directory renames (`sms_meta`→`sms`), and interrupted-capture trailing
  chunks.
- **On disk:** every DB file row resolves to a real file.
- **Counts agree**, capture cleanly closed (`session_close`), not mid-upload.
- Verdict: `COMPLETE` / `UPLOADED_NOT_CLOSED` (interrupted but fully delivered) / `MISALIGNED`
  (real missing chunks) / `UPLOADING` / `INCOMPLETE`.

**THE RULE: never bulk-delete a session from the phone until `/admin/validate` returns `COMPLETE`
(or `UPLOADED_NOT_CLOSED`) for it.** Per-chunk delete-after-confirm is already SHA-safe; the validate
gate is the whole-session confirmation before trusting that a session is fully preserved.

Recommended hardening (not yet built): before Push & clear removes a session locally, have the phone
call `/admin/validate` for it and refuse to clear unless the verdict is COMPLETE/UPLOADED_NOT_CLOSED.
Today the local delete is per-chunk-after-2xx (safe); this adds a final whole-session check.

## What "misaligned" caught in testing

Two large older sessions (`20260816-113537`, `20260812-084845`) were only **partially uploaded** — a
push was superseded mid-stream. The validator flagged them `MISALIGNED` with the exact missing
streams. **Had those been auto-deleted on a naive "we pushed it" assumption, data would have been
lost.** The gate is what prevents that. They need a Wi-Fi re-push (scope=All, or Push & clear each).

## Ownership

- App side: the manifest contract (`chunk_open`/`chunk_close`/`session_close`, lazy file open) is the
  source of truth — see `capture/.../collectors/JsonlCollector.kt` and `CaptureEngine.kt`.
- Server side: SHA verification (`ingest.js`), the validate gate (`server.js /admin/validate`).
