# valent-intelligence-server

Ingest + viewer for **Valent Capture** session pushes. The phone POSTs a gzipped `VBATCH1`
container to `/ingest` with a bearer token; the server verifies it, stores every stream file, indexes
the JSON streams into Postgres, and renders a login-gated dashboard (map + gallery + live status).

Matches the app's push contract in the app repo's `docs/SERVER-SYNC.md`. Encrypted (`VSEAL1`) payloads
are **not yet** handled — the phone's default is unencrypted, which is what we ingest today.

## Endpoints

| Method | Path | Auth | Purpose |
|---|---|---|---|
| POST | `/ingest` | `Bearer INGEST_TOKEN` | receive a `VBATCH1` batch (`application/octet-stream`, gzip) |
| GET | `/health` | — | liveness + db check |
| GET | `/login`, POST `/login`, POST `/logout` | password | admin session |
| GET | `/` | session | dashboard (map + gallery + status) |
| GET | `/api/sessions` `/api/track` `/api/gallery` `/api/status` | session | viewer data |
| GET | `/media/*` | session | serve a stored file |
| GET | `/download` · `/download/app.apk` | — | install the latest Android build |
| POST | `/admin/apk` | `Bearer INGEST_TOKEN` | publish a new APK (used by CI/Claude) |

## Env

- `DATABASE_URL` — Render Postgres connection string.
- `INGEST_TOKEN` — the bearer key the phone sends (also gates APK publish).
- `ADMIN_PASSWORD` — dashboard login.
- `SESSION_SECRET` — cookie signing.
- `MEDIA_ROOT` (`/data/media`), `APK_DIR` (`/data/apk`) — on the persistent disk.

## What's safe

TLS in transit (Render), token-gated ingest, password-gated viewing + media, private Postgres. No
end-to-end encryption yet (planned) — treat the server as trusted-but-private for now.

## Local dev

```
npm install
DATABASE_URL=postgres://... INGEST_TOKEN=dev ADMIN_PASSWORD=dev MEDIA_ROOT=./data/media APK_DIR=./data/apk npm start
```

Deployed on Render (Frankfurt); auto-deploys on push to `main`.
