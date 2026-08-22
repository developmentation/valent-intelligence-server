# `/live` — the full-screen live media player

`public/live.html`, served at `GET /live` (same JWT auth as the dashboard; unauth → `/login?next=/live`).
A single full-screen "media player" for whatever session is live — think social feed for sensor fusion.

## What it shows
- **Media stage** — newest photo/video, `object-fit: contain` over a blurred copy of itself (so any
  aspect fits), **cross-fading** between items (two stacked layers swapped by opacity). Videos autoplay
  muted (tap to unmute) and play inline.
- **Fusion HUD** over the media (presence over instrumentation — kept deliberately sparse):
  - place name (reverse-geocoded via OSM Nominatim, coords fallback);
  - **activity + pace + heading** on one line — pace is DE-JITTERED (displacement over a ~50 s window /
    elapsed, `computePace`), never a single noisy GPS fix;
  - **journey so far** — distance (haversine over the track) + duration;
  - **altitude** — only when notably off the ground (|alt| ≥ 80 m);
  - rolling **audio-scene** chips; **now-playing** music.
- **Battery** pill (top bar) — capture-device `%` + charging bolt, coloured by level, so a viewer knows
  if the stream may die. From `/api/status.battery` (the `power` stream, now indexed).
- **Staleness** — a live session quiet >2 min shows "no signal for Xm" (amber); >4 min → REPLAY.
- **Details modal (ⓘ)** — satellites, Wi-Fi, GPS accuracy, altitude, battery, last-signal: the
  diagnostics kept OFF the main HUD.
- **Map** — mini card (Leaflet, Carto dark/light tiles); tap to go fullscreen (drag + scroll + pinch
  zoom, zoom buttons, close/theme controls). Theme remembered in `localStorage`.
- **Filmstrip** — the whole gallery, selectable; auto-reverts to newest when fresh media arrives.
- **Transcript / Audio** — stubbed toggles (a "soon" dot) for later. (Hidden on phones to save the top row.)

## Data + freshness (all existing APIs)
`/api/sessions` (newest = active), `/api/status`, `/api/gallery`, `/api/track`, `/api/scene`, media via
`/media/*`. Kept fresh by **SSE `/api/stream`** (`photo`/`live`/`ingest`/`error`) plus a 15 s poll backstop.

## Lifecycle (auto-follows the live session)
- **Live** while the session's last signal is <4 min old; the map head tracks the latest GPS fix.
- **Replay** when it goes quiet: a GPS-mapped carousel of that last session (map follows each photo's
  nearest track point by time).
- **New session takes over automatically:** ANY SSE event whose session id is newer than the current one
  (`d.session > state.sid`, timestamp-prefixed ids → string compare) switches immediately, on any lane.

## Map behaviour — the lesson that bit us twice
`map.fitBounds()` on every update **resets the user's zoom/pan**. So:
- **Mini map**: auto-fits the full GPS bounds on every update (it's a glance view; interactions off, a
  tap expands). This is intended.
- **Expanded map**: fits once on open, then NEVER auto-refits — the user pans/zooms freely.
- **Dashboard map** (`dashboard.html`): only fits when the session selection changes, never on a live
  fix (same fix — see `fittedSession`).
Whenever a map "snaps back" on new data, this is why: gate `fitBounds` to the right moments.
