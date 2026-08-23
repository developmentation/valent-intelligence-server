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
