# Publications — curated, shareable journeys

A **publication** turns one or more existing capture sessions into a single, public, password-free web
page: `/publish/<uuid>`. It is the "share what I did today" surface — pick the legs, weed out photos/videos
you don't want seen, publish, send the link. Unpublish (or delete) any time.

## The core idea: metadata only, exclusions enforced at the API

A publication **copies nothing**. It is a row of metadata over sessions the server already holds:

- an **ordered list of session ids** (`session_ids`) — the legs of the journey, ordered by time;
- a list of **excluded media paths** (`excluded`) — the photos/videos to hide;
- `title`, `description`, and a `published` flag.

The public surface reads live from the same `files`/`records` the private dashboard uses, then **subtracts
the exclusions**. There is no second copy to drift, and "delete a publication" never touches a session.

The exclusion is enforced **at the API, not just in the UI**. `GET /pub/:id/media/*` 404s unless the file
is (a) in a publication that is currently `published`, (b) owned by one of that publication's member
sessions, and (c) **not** in `excluded`. Guessing an excluded file's URL returns 404 — hiding it in the
gallery is not the security boundary; the media route is.

## Who can do what

| Action | Route | Auth |
|---|---|---|
| Build / edit / publish / unpublish / delete | `/curate`, `/admin/publications*` | **admin (JWT login)** |
| View a published journey | `/publish/:id`, `/api/pub/:id`, `/pub/:id/media/*` | **none** (open, but only if `published`) |

Curation and the publish/unpublish switch are behind the existing password. The **published content is
open** — anyone with the UUID link sees it, no login. Unpublishing flips `published=false`: the page, its
JSON, and its media all immediately 404 again (the link is dormant, not deleted — republishing revives it).

## The build flow (`/curate`)

1. **Pick sessions** — checkbox list, newest first, showing name, time range, duration, record count.
   Selected legs are auto-ordered by start time. Each leg gets a stable color.
2. **Details** — title + optional description (shown at the top of the public page).
3. **Route** — a combined dark Leaflet map, one colored polyline per leg (the same **de-noised** track the
   phone draws — see below).
4. **Choose what to show** — the deselection gallery: every photo/clip across the selected sessions, in
   chronological order, each tagged with its leg color. **Tap to exclude** (tap again to restore).
   Excluded items get an "excluded" badge and are dropped from the publication.
5. **Publish** (or **Save draft**). Publishing returns the `/publish/<uuid>` link with copy/open buttons.

The **My publications** tab lists everything: publish/unpublish, edit (re-opens the builder with the same
sessions + exclusions), copy link, open, delete.

## The public page (`/publish/:id`)

Served by `publish.html`, which fetches `/api/pub/:id` and renders:

- a hero (title, description, and stats: date, leg count, distance, moving time, media count);
- a colored per-leg map (line breaks on large time/space gaps so no false connector is ever drawn);
- leg pills with **subject-local** times (each leg carries its `tz_offset_min`, so times read as the
  clock where the person actually was, not UTC or the viewer's zone);
- a gallery grid (leg-color dots, local timestamps, video badges) with a keyboard-navigable lightbox.
  Grid/lightbox/slideshow request **downscaled JPEG thumbnails** (`/pub/:id/media/*?w=…`, cached and
  `immutable`) instead of the multi-MB originals, so the page loads fast — see `MEDIA-PIPELINE.md`.

The leg pills double as a **filter**: tap a leg to scope the gallery (and the map focus) to that session;
an **All** pill clears it. The filter also scopes the slideshow — filter to a leg, then Play to replay just
that leg. A **light/dark toggle** (top-right, and in the slideshow) themes the whole page and both maps
(CARTO `light_all`/`dark_all` tiles); it defaults to dark and is remembered in `localStorage`.

### Slideshow (cinematic replay)

The published page has a **Play slideshow** button that opens a full-screen cinematic player — the same
visual language as `/live`, but spanning the **whole publication** across all its legs. It replays every
photo/clip in chronological order with a cross-fading stage (blurred backdrop + Ken Burns), and for each
item drives a fusion HUD + map exactly as the live view does:

- the **place name** (reverse-geocoded), coordinates, and **subject-local time** of that photo;
- chips: which **leg** (colored, "leg 2/3"), the **speed** at that moment (from the de-noised track),
  and the **journey** total (distance · duration);
- a mini map (tap to expand) that is **dynamic to the image**: it zooms to the current photo's leg and
  reframes as the leg changes, with a **head marker that moves** to where each photo was taken (nearest
  de-noised fix by time); expanding the map shows the whole journey. Its tiles follow the light/dark theme,
  though the cinematic chrome stays dark for legibility over photos.
- a filmstrip; play/pause; ←/→ and space; Esc closes.

It is driven entirely by the already-loaded `/api/pub` data — no extra endpoints, and (see below) **no
audio**. The underlying page is hidden while it's open so the hero map's Leaflet panes can't bleed through.

### Audio is not served or referenced (future feature)

The public surface exposes **no audio**. `/api/pub/:id` builds `media` from `kind='media'` only (photos +
videos), so audio clips never appear in the JSON, and `/pub/:id/media/*` is an **allowlist** — it serves a
path only if a `kind='media'` file with that exact path exists in a member session. A guessed `…/audio/….aac`
path (or any other stream: gnss, motion, sensor) returns **404**. The viewer UI likewise has no audio,
transcript, scene, or now-playing affordances. Audio playback is a deliberate future feature.

`/api/pub/:id` returns `{ id, title, description, publishedAt, legs[], track[], media[] }`:
- **`legs`** — per session: `session_id`, `first_wall`/`last_wall` (ms), `tz_offset_min`.
- **`track`** — the merged, **de-noised** GPS across all legs (accuracy-weighted constant-velocity Kalman
  + RTS smoother + glitch gate — the exact port of the phone's `GeoTrack.clean`, in `geotrack.js`), each
  point carrying its `session_id` so the viewer can color and gap-break per leg.
- **`media`** — photos/clips across the member sessions **with exclusions already removed**, oldest-first
  (chronological journey order), each with a `/pub/:id/media/<path>` URL.

## Robustness notes (learned during build)

- **Leaflet is `defer`red** in both `curate.html` and `publish.html`, and `drawMap()` waits for `L`. A
  render-blocking `<script src=unpkg…leaflet.js>` had delayed the inline script that fetches the data, so
  the public page sat on "Loading…" until the CDN answered. Text + gallery must never wait on the map lib.
- The curate gallery sorts **chronologically client-side** — `/api/gallery` returns newest-first (for the
  dashboard/live view), but the journey reads best oldest-first, matching the published page.

## Testing

`playtest_pub.js` (Playwright, real Chrome) is the end-to-end check. It logs in, builds a publication from
several sessions, excludes an item, publishes, then from a **no-auth** context verifies:

- the public page renders (h1, stats, gallery cells > 0);
- **exclusion is enforced**: the excluded media path → 404, a kept one → 200;
- **unpublish** makes `/api/pub` and `/publish` → 404;
- **delete** → 200.

Run it against the deployed server:
```bash
# from server/ ; PW = ADMIN_PASSWORD (fetch from Render env-vars)
BASE=https://valent-intelligence-server.onrender.com PW=<admin-pw> node playtest_pub.js
```
Screenshots (`pub_public.png`, `pub_curate.png`) land in the scratchpad for visual review. The test
cleans up after itself (unpublishes + deletes its test publication; sessions are untouched).

## Files
- `migrations/0006_publications.sql` — the `publications` table.
- `server.js` — `/admin/publications*` (admin CRUD), `loadPublished()`, `/api/pub/:id`,
  `/pub/:id/media/*` (exclusion enforcement), `/publish/:id`, `/curate`; `trackForSessions()` shared
  de-noise helper (also backs `/api/track?sessions=` and `/api/gallery?sessions=`).
- `public/curate.html` — the admin builder. `public/publish.html` — the public viewer.
- `geotrack.js` — the GPS de-noise port (Kalman + RTS + glitch gate).
- `playtest_pub.js` — the Playwright end-to-end + screenshot test.
