'use strict';
const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const QRCode = require('qrcode');
const { pool, init } = require('./db');
const { handleIngest, MEDIA_ROOT } = require('./ingest');
const storage = require('./storage');

const app = express();
app.set('trust proxy', 1);

const INGEST_TOKEN = process.env.INGEST_TOKEN || '';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '';
const APK_DIR = process.env.APK_DIR || '/data/apk';
fs.mkdirSync(APK_DIR, { recursive: true });

// ---- Server-Sent Events: push a live nudge to the visualizer the instant chunks land ----
const sseClients = new Set();
function sseBroadcast(event) {
  const line = `data: ${JSON.stringify(event)}\n\n`;
  for (const res of sseClients) { try { res.write(line); } catch (_) { /* dropped on next close */ } }
}

// ---- Live lane: an in-memory fresh tail per session, fed by the tiny /ingest/live posts. This is a
// low-latency OVERLAY on top of the durable, complete bulk track — not a second source of truth. The
// bulk lane still persists every fix; this just lets the map head be ~10s fresh instead of a chunk
// behind. Ephemeral by design (lost on restart, which is fine — the bulk lane has it all).
const liveTracks = new Map();   // session -> { pts:[{lat,lon,wall,acc,speed}], latest, scene, updated }
const LIVE_CAP = 800;
const LIVE_TTL_MS = 15 * 60 * 1000;
function pruneLive() {
  const cutoff = Date.now() - LIVE_TTL_MS;
  for (const [k, t] of liveTracks) if (t.updated < cutoff) liveTracks.delete(k);
}

// ---- health (no auth) ----
app.get('/health', async (_req, res) => {
  let db = false;
  try { await pool.query('select 1'); db = true; } catch (_) {}
  res.json({ ok: true, db, time: Date.now() });
});

// ---- ingest (bearer-token auth; raw octet-stream body) ----
app.post('/ingest', express.raw({ type: () => true, limit: '64mb' }), async (req, res) => {
  const auth = req.header('authorization') || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  if (!INGEST_TOKEN || token !== INGEST_TOKEN) {
    return res.status(401).json({ ok: false, error: 'bad key' });
  }
  try {
    const h = {};
    for (const k of Object.keys(req.headers)) h[k.toLowerCase()] = req.headers[k];
    const out = await handleIngest(h, req.body);
    // Live nudge to any connected visualizer: which session grew, by how much.
    if (out.status >= 200 && out.status < 300 && out.body && out.body.session) {
      sseBroadcast({ type: 'ingest', session: out.body.session, storedNew: out.body.storedNew, records: out.body.records, members: out.body.members, at: Date.now() });
    }
    res.status(out.status).json(out.body);
  } catch (e) {
    console.error('ingest error', e);
    res.status(500).json({ ok: false, error: String(e.message || e) });
  }
});

// ---- live lane: current GPS fixes + scene (tiny JSON, ~every 10s, best-effort, low-latency) ----
app.post('/ingest/live', express.json({ limit: '512kb' }), (req, res) => {
  if ((req.header('authorization') || '') !== 'Bearer ' + INGEST_TOKEN) return res.status(401).end();
  const b = req.body || {};
  const sid = String(b.session || '');
  if (!sid) return res.status(400).json({ ok: false, error: 'session required' });
  let t = liveTracks.get(sid);
  if (!t) { t = { pts: [], latest: null, scene: null, updated: 0 }; liveTracks.set(sid, t); }
  let added = 0;
  for (const p of (Array.isArray(b.points) ? b.points : [])) {
    if (typeof p.lat !== 'number' || typeof p.lon !== 'number') continue;
    const wall = Number(p.wall) || 0;
    if (t.pts.length && wall && wall <= t.pts[t.pts.length - 1].wall) continue;   // keep in order, dedup
    t.pts.push({ lat: p.lat, lon: p.lon, wall, acc: p.acc ?? null, speed: p.speed ?? null });
    added++;
  }
  if (t.pts.length > LIVE_CAP) t.pts.splice(0, t.pts.length - LIVE_CAP);
  if (t.pts.length) t.latest = t.pts[t.pts.length - 1];
  if (b.scene && b.scene.label) t.scene = { label: b.scene.label, score: b.scene.score, wall: Number(b.scene.wall) || Date.now() };
  t.updated = Date.now();
  if (Math.random() < 0.05) pruneLive();
  // Register the session immediately (before its first bulk batch) so /api/sessions — and thus /live +
  // the dashboard — can discover a freshly-started session within one live post (~10s) instead of
  // waiting a whole chunk. Best-effort; the manifest upsert later fills in the real name/clock.
  // `updated_at = now()` is the SERVER clock — the skew-proof recency signal (device wall can be wrong).
  const liveWall = (t.latest && Number(t.latest.wall)) || Date.now();
  pool.query(
    `insert into sessions (id, device, last_wall, updated_at) values ($1, 'Valent', $2, now())
     on conflict (id) do update set
       last_wall = greatest(coalesce(sessions.last_wall, excluded.last_wall), excluded.last_wall),
       updated_at = now()`,
    [sid, liveWall]).catch(() => {});
  sseBroadcast({ type: 'live', session: sid, lat: t.latest && t.latest.lat, lon: t.latest && t.latest.lon, wall: t.latest && t.latest.wall, scene: t.scene, added });
  res.json({ ok: true, added, held: t.pts.length });
});

// ---- live lane: a just-captured photo (raw bytes), stored immediately + gallery-broadcast ----
// Disk-backed today via the storage seam; swap to a presigned R2 PUT later without touching callers.
app.post('/ingest/live/photo', express.raw({ type: () => true, limit: '64mb' }), async (req, res) => {
  if ((req.header('authorization') || '') !== 'Bearer ' + INGEST_TOKEN) return res.status(401).end();
  const sid = String(req.header('x-session') || '');
  const fname = String(req.header('x-filename') || '').replace(/[^a-zA-Z0-9._-]/g, '_');
  const stream = String(req.header('x-stream') || 'camera').replace(/[^a-z0-9_]/gi, '') || 'camera';
  if (!sid || !fname || !req.body || !req.body.length) return res.status(400).json({ ok: false, error: 'x-session + x-filename + body required' });
  try {
    const key = `${sid}/${stream}/${fname}`;
    await storage.put(key, req.body);
    const sha = crypto.createHash('sha256').update(req.body).digest('hex');
    await pool.query(
      `insert into files (session_id, stream, filename, path, sha256, bytes, kind)
       values ($1,$2,$3,$4,$5,$6,'media') on conflict (sha256) do nothing`,
      [sid, stream, fname, key, sha, req.body.length]);
    const url = storage.publicUrl(key);
    sseBroadcast({ type: 'photo', session: sid, url, filename: fname, at: Date.now() });
    res.json({ ok: true, url });
  } catch (e) { res.status(500).json({ ok: false, error: String(e.message || e) }); }
});

// ---- error lane: the app's universal crash/error catcher uploads here (persisted crashes on launch
// + recent error/warn diagnostics). Best-effort, deduped on fingerprint so a re-sent crash lands once.
// Read back via GET /admin/errors to evaluate a fault on any device without adb. ----
app.post('/ingest/errors', express.json({ limit: '4mb' }), async (req, res) => {
  if ((req.header('authorization') || '') !== 'Bearer ' + INGEST_TOKEN) return res.status(401).end();
  const b = req.body || {};
  const device = String(b.device || '');
  const build = String(b.build || '');
  const events = Array.isArray(b.events) ? b.events : [];
  if (!events.length) return res.json({ ok: true, stored: 0 });
  let stored = 0;
  try {
    for (const e of events.slice(0, 500)) {
      const wall = Number(e.wall) || 0;
      const type = String(e.component || e.type || '');
      const where = String(e.where || e.thread || e.component || '');
      // Client fingerprint if given; else derive one so a re-send dedups. wall+type+where+msg-prefix.
      const fp = String(e.fp || `${wall}|${type}|${where}|${String(e.message || e.msg || '').slice(0, 80)}`);
      const r = await pool.query(
        `insert into errors (fingerprint, session_id, device, build, level, kind, component, message, where_at, wall_ms, stack, fields)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
         on conflict (fingerprint) do nothing returning id`,
        [fp, e.session || b.session || null, e.device || device || null, e.build || build || null,
         String(e.level || 'ERROR'), String(e.kind || 'event'), type || null,
         String(e.message || e.msg || ''), where || null, wall,
         e.stack || null, e.fields ? JSON.stringify(e.fields) : null]);
      if (r.rowCount) stored++;
    }
    if (stored) sseBroadcast({ type: 'error', device, stored, at: Date.now() });
    res.json({ ok: true, stored, seen: events.length });
  } catch (e) { console.error('errors ingest', e); res.status(500).json({ ok: false, error: String(e.message || e) }); }
});

// ---- diagnostics (token-gated, no login) ----
// The captured errors, newest first. Filters: ?session= ?level=FATAL|ERROR|WARN ?device= ?since=<ms>
// ?limit= (default 100). ?format=text returns a compact, LLM/human-readable dump instead of JSON.
app.get('/admin/errors', async (req, res) => {
  if ((req.header('authorization') || '') !== 'Bearer ' + INGEST_TOKEN) return res.status(401).end();
  try {
    const where = []; const args = [];
    const add = (sql, v) => { args.push(v); where.push(sql.replace('?', '$' + args.length)); };
    if (req.query.session) add('session_id = ?', String(req.query.session));
    if (req.query.level) add('upper(level) = upper(?)', String(req.query.level));
    if (req.query.device) add('device ilike ?', '%' + String(req.query.device) + '%');
    if (req.query.since) add('wall_ms >= ?', Number(req.query.since) || 0);
    const limit = Math.min(500, Math.max(1, Number(req.query.limit) || 100));
    const sql = `select id, fingerprint, session_id, device, build, level, kind, component, message, where_at, wall_ms, stack, fields, received_at
                 from errors ${where.length ? 'where ' + where.join(' and ') : ''}
                 order by received_at desc limit ${limit}`;
    const rows = (await pool.query(sql, args)).rows;
    if (String(req.query.format) === 'text') {
      const lines = rows.map((r) => {
        const t = new Date(Number(r.wall_ms) || Date.parse(r.received_at)).toISOString();
        const head = `[${t}] ${r.level}/${r.kind} ${r.component || ''} — ${r.message || ''}`;
        const meta = `    device=${r.device || '?'} build=${r.build || '?'} session=${r.session_id || '-'} where=${r.where_at || '-'}`;
        const flds = r.fields ? `    fields=${JSON.stringify(r.fields)}` : '';
        const stk = r.stack ? '    ' + String(r.stack).trim().split('\n').slice(0, 24).join('\n    ') : '';
        return [head, meta, flds, stk].filter(Boolean).join('\n');
      });
      res.type('text/plain').send(`# ${rows.length} error(s), newest first\n\n` + lines.join('\n\n') + '\n');
    } else {
      res.json({ count: rows.length, errors: rows });
    }
  } catch (e) { res.status(500).json({ error: String(e.message || e) }); }
});

app.get('/admin/stats', async (req, res) => {
  if ((req.header('authorization') || '') !== 'Bearer ' + INGEST_TOKEN) return res.status(401).end();
  try {
    const q = (s) => pool.query(s).then(r => r.rows);
    const [byKind, byStream, biggest, sessions, lastBatch] = await Promise.all([
      q(`select kind, count(*)::int n, coalesce(sum(bytes),0)::bigint bytes, coalesce(max(bytes),0)::bigint maxb from files group by kind order by n desc`),
      q(`select stream, count(*)::int n, coalesce(sum(bytes),0)::bigint bytes, coalesce(max(bytes),0)::bigint maxb from files group by stream order by bytes desc limit 40`),
      q(`select session_id, stream, filename, bytes from files order by bytes desc limit 12`),
      q(`select id, device, file_count, record_count, bytes, updated_at from sessions order by updated_at desc`),
      q(`select session_id, idx, bytes, members, received_at from batches order by received_at desc limit 8`),
    ]);
    res.json({ byKind, byStream, biggest, sessions, lastBatch });
  } catch (e) { res.status(500).json({ error: String(e.message || e) }); }
});

// Deep end-to-end validation of one session: full upload (chunk-index contiguity, no gaps),
// DB<->storage consistency (every file actually on disk), indexing (queryable streams have records),
// and capture close. Reusable acceptance check for the phone->server->index pipeline.
app.get('/admin/validate', async (req, res) => {
  if ((req.header('authorization') || '') !== 'Bearer ' + INGEST_TOKEN) return res.status(401).end();
  const sid = String(req.query.session || '');
  if (!sid) return res.status(400).json({ error: 'session required' });
  try {
    const session = (await pool.query('select * from sessions where id=$1', [sid])).rows[0];
    if (!session) return res.status(404).json({ error: 'no such session' });
    const files = (await pool.query(
      'select stream, filename, path, bytes, kind from files where session_id=$1 order by stream, filename', [sid])).rows;

    // Per-stream chunk analysis + disk existence. Chunk index is the trailing _NNNNNN in the filename.
    // A chunk can have >1 file (e.g. audio: a .aac + a .anchors sidecar share the same index), so gaps
    // are computed over the SET of indices, and files vs chunks are reported separately.
    const idxRe = /_(\d+)/;   // first _NNNNNN = chunk index (stem has no other underscore); tolerant of
    //                          both `_000000.jsonl` and motion's `_000000_accel.vstream` writer suffix.
    const extRe = /\.([^.]+)$/;
    const byStream = {};
    let onDisk = 0; const missingDisk = [];
    for (const f of files) {
      const s = (byStream[f.stream] || (byStream[f.stream] = { count: 0, indices: new Set(), bytes: 0, kind: f.kind, exts: {}, sample: [] }));
      s.count++; s.bytes += Number(f.bytes || 0);
      if (s.sample.length < 3) s.sample.push(f.filename);
      const m = idxRe.exec(f.filename); if (m) s.indices.add(parseInt(m[1], 10));
      const e = extRe.exec(f.filename); if (e) s.exts[e[1]] = (s.exts[e[1]] || 0) + 1;
      if (await storage.exists(f.path)) onDisk++; else missingDisk.push(f.path);
    }
    const streams = Object.entries(byStream).map(([stream, s]) => {
      const idx = [...s.indices].sort((a, b) => a - b);
      const min = idx.length ? idx[0] : null;
      const max = idx.length ? idx[idx.length - 1] : null;
      const gaps = [];
      if (min != null) for (let i = min; i <= max; i++) if (!s.indices.has(i)) gaps.push(i);
      return {
        stream, kind: s.kind, files: s.count, chunks: s.indices.size, bytes: s.bytes, exts: s.exts,
        minIdx: min, maxIdx: max, expectedChunks: min != null ? max - min + 1 : s.indices.size,
        gapCount: gaps.length, gapsSample: gaps.slice(0, 50), contiguous: gaps.length === 0,
      };
    }).sort((a, b) => b.bytes - a.bytes);

    // Indexing: records actually landed for the queryable streams.
    const recRows = (await pool.query(
      'select stream, count(*)::int n from records where session_id=$1 group by stream', [sid])).rows;
    const indexed = {}; recRows.forEach((r) => { indexed[r.stream] = r.n; });

    // Parse the phone's manifest — the AUTHORITATIVE record of what was captured. A chunk_close with
    // bytes>0 means that chunk produced a file; bytes==0 is an empty chunk (no file written). So the
    // set of content chunk indices per stream is exactly what the server must hold. (Multi-file
    // streams — audio's .anchors sidecar, motion's per-writer .vstream — share the chunk index, so an
    // index-set comparison is exact regardless of files-per-chunk.)
    const manifestKey = `${sid}/manifest.jsonl`;
    const manifestPresent = await storage.exists(manifestKey);
    let closedDetected = null; let sessionClose = null;
    const manifestContent = {}; // stream -> Set(index) that closed with bytes>0
    if (manifestPresent) {
      try {
        const txt = (await storage.get(manifestKey)).toString('utf8');
        for (const line of txt.split('\n')) {
          if (!line) continue;
          let o; try { o = JSON.parse(line); } catch (_) { continue; }
          if (o.t === 'chunk_close') {
            const m = /_(\d+)/.exec(o.stem || o.file || '');
            if (m && Number(o.bytes) > 0) {
              (manifestContent[o.stream] || (manifestContent[o.stream] = new Set())).add(parseInt(m[1], 10));
            }
          } else if (o.t === 'session_close') {
            sessionClose = { chunks: o.chunks, bytes: Number(o.bytes), durationSec: o.durationSec };
          }
        }
        closedDetected = sessionClose != null;
      } catch (_) { /* leave null */ }
    }

    // In-flight detection: if batches for this session are still arriving, gaps are transient (the
    // push is mid-stream), so we report UPLOADING rather than falsely failing it as INCOMPLETE.
    const bstat = (await pool.query(
      `select max(received_at) mx, count(*) filter (where received_at > now() - interval '3 minutes') recent
       from batches where session_id=$1`, [sid])).rows[0];
    const uploading = Number(bstat.recent || 0) > 0;

    const dbVsScan = files.length === session.file_count;
    // Chunk indices are a SESSION-WIDE tick (a chunk boundary every ~minute). Dense streams write at
    // every tick; event-driven streams (speech, wifi, health, bluetooth…) only write when they have
    // data, so a gap in their tick sequence is EXPECTED sparsity, not lost data. So gaps are
    // informational, not a failure. Authoritative completeness = clean capture-close + every file on
    // disk + counts agree + not mid-upload; ingest already sha-verified every member.
    const globalTicks = streams.reduce((m, s) => Math.max(m, (s.maxIdx == null ? -1 : s.maxIdx) + 1), 0);
    const sparseStreams = streams
      .filter((s) => s.chunks > 0 && s.chunks < globalTicks)
      .map((s) => ({ stream: s.stream, chunks: s.chunks, ofTicks: globalTicks, skipped: s.gapCount }));
    const totalGaps = streams.reduce((a, s) => a + s.gapCount, 0);

    // Manifest alignment (the authoritative file check): for every stream the manifest says produced
    // content, does the server hold exactly those chunk indices? Missing = a real upload gap; extra =
    // a file the manifest didn't declare. Stream names present on the server but absent from the
    // manifest content are reported separately (naming differences / no-content streams).
    const perStream = Object.entries(manifestContent).map(([stream, want]) => {
      const have = byStream[stream] ? byStream[stream].indices : new Set();
      const maxWant = want.size ? Math.max(...want) : -1;
      const missing = [...want].filter((i) => !have.has(i)).sort((a, b) => a - b);
      const extraAll = [...have].filter((i) => !want.has(i)).sort((a, b) => a - b);
      // A server chunk PAST the last closed one is the final open chunk of an interrupted capture
      // (file written + uploaded, but the session died before chunk_close). Expected, not a defect.
      const trailingExtra = extraAll.filter((i) => i > maxWant);
      const extra = extraAll.filter((i) => i <= maxWant);   // a real unexpected file inside the range
      return { stream, manifestChunks: want.size, serverChunks: have.size, missing, extra, trailingExtra, aligned: !missing.length && !extra.length };
    }).sort((a, b) => Number(a.aligned) - Number(b.aligned));
    const serverOnlyStreams = Object.keys(byStream)
      .filter((s) => manifestContent[s] === undefined && byStream[s].indices.size > 0);
    // Reconcile stream-name differences (e.g. manifest 'sms_meta' stored under dir 'sms'): a fully
    // absent manifest stream whose content indices are all present under a server-only stream is the
    // same data under a different name — mark it aligned (renamed), not missing.
    for (const a of perStream) {
      if (a.aligned || a.serverChunks > 0) continue;
      const want = manifestContent[a.stream];
      const hit = serverOnlyStreams.find((so) => [...want].every((i) => byStream[so].indices.has(i)));
      if (hit) {
        a.aligned = true; a.renamedTo = hit; a.missing = []; a.serverChunks = byStream[hit].indices.size;
        serverOnlyStreams.splice(serverOnlyStreams.indexOf(hit), 1);
      }
    }
    const misaligned = perStream.filter((a) => !a.aligned);
    const manifestAligned = manifestPresent && perStream.length > 0 && misaligned.length === 0;
    // Completeness (the verdict driver) turns ONLY on MISSING chunks — data the manifest declared that
    // the server does not hold. `extra` chunks (the server holding MORE than the manifest declared, e.g.
    // a sparse stream's first chunk that the manifest recorded as empty) are never data loss, so they
    // must not fail the verdict — they're still reported in `alignment` for transparency.
    const missingData = perStream.some((a) => a.missing.length > 0);
    const extraStreams = perStream.filter((a) => a.missing.length === 0 && (a.extra.length > 0 || a.trailingExtra.length > 0));

    const uploadOk = missingDisk.length === 0 && dbVsScan && manifestPresent;
    const captureClosed = closedDetected === true;
    const verdict = uploading ? 'UPLOADING'
      : !uploadOk ? 'INCOMPLETE'
        : missingData ? 'MISALIGNED'
          : captureClosed ? 'COMPLETE'
            : 'UPLOADED_NOT_CLOSED';   // all declared data delivered, but capture had no clean close

    res.json({
      uploading, lastBatchAt: bstat.mx,
      session: sid, device: session.device,
      clock: {
        firstWall: Number(session.first_wall), lastWall: Number(session.last_wall),
        durationMin: (session.first_wall && session.last_wall)
          ? Math.round((Number(session.last_wall) - Number(session.first_wall)) / 60000) : null,
      },
      totals: {
        filesScanned: files.length, dbFileCount: session.file_count, dbVsScanMatch: dbVsScan,
        bytes: Number(session.bytes), records: Number(session.record_count),
      },
      upload: { filesOnDisk: onDisk, filesMissingOnDisk: missingDisk.length, missingSample: missingDisk.slice(0, 20) },
      capture: { closedDetected, sessionClose, globalTicks, sparseStreams },  // sparse = expected, informational
      manifestPresent,
      alignment: { aligned: manifestAligned, misaligned, serverOnlyStreams, perStream },
      streams: streams.map((s) => ({ ...s, indexedRecords: indexed[s.stream] || 0 })),
      verdict,
      reasons: [
        missingData ? `${perStream.filter((a) => a.missing.length).length} stream(s) missing chunks the manifest declared` : null,
        uploading ? 'still uploading' : null,
        missingDisk.length ? `${missingDisk.length} file(s) not on disk` : null,
        !manifestPresent ? 'manifest missing' : null,
        !dbVsScan ? `file_count mismatch (db ${session.file_count} vs scan ${files.length})` : null,
        (!uploading && uploadOk && !captureClosed) ? 'capture not cleanly closed (interrupted) — delivered data is intact' : null,
      ].filter(Boolean),
      note: [
        totalGaps ? `${totalGaps} tick(s) skipped by sparse/event-driven streams (expected, not missing data)` : null,
        extraStreams.length ? `${extraStreams.length} stream(s) hold extra chunk(s) not declared in the manifest (benign — server has more than declared, e.g. a sparse stream's first chunk)` : null,
      ].filter(Boolean).join(' · ') || undefined,
    });
  } catch (e) { res.status(500).json({ error: String(e.message || e) }); }
});

// ---- admin auth: short-lived JWT access cookie + refresh cookie, both HttpOnly ----
// Dependency-free HS256 JWT. The access token lives 15 min; a valid refresh token silently rotates a
// new access cookie (sliding session). Only the password unlocks it; secrets stay in Render env.
const AUTH_SECRET = process.env.JWT_SECRET || process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex');
const ACCESS_TTL = 15 * 60;               // 15 minutes
const REFRESH_TTL = 14 * 24 * 60 * 60;    // 14 days
const b64uJson = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
function signJwt(payload, ttl) {
  const now = Math.floor(Date.now() / 1000);
  const data = `${b64uJson({ alg: 'HS256', typ: 'JWT' })}.${b64uJson({ ...payload, iat: now, exp: now + ttl })}`;
  return `${data}.${crypto.createHmac('sha256', AUTH_SECRET).update(data).digest('base64url')}`;
}
function verifyJwt(token) {
  if (!token || token.split('.').length !== 3) return null;
  const [h, p, s] = token.split('.');
  const expect = crypto.createHmac('sha256', AUTH_SECRET).update(`${h}.${p}`).digest('base64url');
  const a = Buffer.from(s); const b = Buffer.from(expect);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  let payload; try { payload = JSON.parse(Buffer.from(p, 'base64url').toString('utf8')); } catch (_) { return null; }
  if (!payload.exp || payload.exp < Math.floor(Date.now() / 1000)) return null;
  return payload;
}
function parseCookies(req) {
  const out = {};
  (req.headers.cookie || '').split(';').forEach((c) => {
    const i = c.indexOf('='); if (i > 0) out[c.slice(0, i).trim()] = decodeURIComponent(c.slice(i + 1).trim());
  });
  return out;
}
function setAuthCookies(res, { refresh = true } = {}) {
  res.append('Set-Cookie', `va=${signJwt({ sub: 'admin', typ: 'a' }, ACCESS_TTL)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${ACCESS_TTL}; Secure`);
  if (refresh) res.append('Set-Cookie', `vr=${signJwt({ sub: 'admin', typ: 'r' }, REFRESH_TTL)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${REFRESH_TTL}; Secure`);
}

app.use(express.urlencoded({ extended: false }));
app.use(express.json());

function requireAdmin(req, res, next) {
  const c = parseCookies(req);
  const access = verifyJwt(c.va);
  if (access && access.typ === 'a') return next();
  const refresh = verifyJwt(c.vr);
  if (refresh && refresh.typ === 'r') { setAuthCookies(res, { refresh: false }); return next(); }   // rotate access
  if (req.path.startsWith('/api/') || req.path.startsWith('/media/')) {
    return res.status(401).json({ ok: false, error: 'login required' });
  }
  // Preserve where they were headed (e.g. /live) so login returns them there, not always to /.
  const nextQ = req.originalUrl && req.originalUrl !== '/' ? '?next=' + encodeURIComponent(req.originalUrl) : '';
  return res.redirect('/login' + nextQ);
}

// Only ever redirect to a same-origin absolute path (starts with a single '/'), never an external URL.
const safePath = (p) => (typeof p === 'string' && /^\/(?!\/)[^\s]*$/.test(p) ? p : '');

app.get('/login', (req, res) => {
  res.type('html').send(loginPage(req.query.e ? 'Wrong password.' : '', safePath(req.query.next)));
});
app.post('/login', (req, res) => {
  // `next` rides the form action's query string (always parsed), with the hidden body field as backup.
  const nx = safePath(req.query.next) || safePath(req.body && req.body.next);
  if (ADMIN_PASSWORD && req.body && req.body.password === ADMIN_PASSWORD) {
    setAuthCookies(res);
    return res.redirect(nx || '/');
  }
  return res.redirect('/login?e=1' + (nx ? '&next=' + encodeURIComponent(nx) : ''));
});
app.post('/logout', (_req, res) => {
  res.append('Set-Cookie', 'va=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0; Secure');
  res.append('Set-Cookie', 'vr=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0; Secure');
  res.redirect('/login');
});

// ---- viewer APIs (admin only) ----
// Live event stream: the visualizer opens this once and gets an {type:'ingest', session, ...} event
// each time a batch lands, so it can refresh the affected session in near-real-time.
app.get('/api/stream', requireAdmin, (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',   // don't let any proxy buffer the stream
  });
  res.write('retry: 3000\n');
  res.write(': connected\n\n');
  sseClients.add(res);
  const hb = setInterval(() => { try { res.write(': hb\n\n'); } catch (_) { /* closing */ } }, 25000);
  req.on('close', () => { clearInterval(hb); sseClients.delete(res); });
});

app.get('/api/sessions', requireAdmin, async (_req, res) => {
  const q = await pool.query(
    `select id, device, first_wall, last_wall, bytes, file_count, record_count, tz_offset_min, updated_at
     from sessions order by coalesce(last_wall, extract(epoch from updated_at)*1000) desc limit 200`);
  res.json(q.rows);
});

// Rolling audio-scene history (default last 3 min) — the top tag per frame, newest last, so the
// dashboard can show "what we've heard" like the phone rather than a single instantaneous label.
app.get('/api/scene', requireAdmin, async (req, res) => {
  const s = req.query.session; const args = [];
  let where = `stream='audio_scene' and data ? 'tags'`;
  if (s) { args.push(s); where += ` and session_id=$1`; }
  const mins = Math.min(30, Math.max(1, parseInt(req.query.mins, 10) || 3));
  const q = await pool.query(`select data, wall from records where ${where} order by wall desc limit 600`, args);
  const cutoff = Date.now() - mins * 60000;
  const out = [];
  for (const r of q.rows) {
    const w = Number(r.wall);
    if (w < cutoff) break;
    const tags = Array.isArray(r.data.tags) ? r.data.tags : [];
    const t = tags.find((x) => !x.secondary) || tags[0];
    if (t) out.push({ label: t.label, score: t.score, wall: w });
  }
  res.json(out.reverse());   // oldest → newest
});

// Full cumulative transcript for a session (the running narrative), oldest→newest, plus the joined text.
app.get('/api/transcript', requireAdmin, async (req, res) => {
  const s = req.query.session; const args = [];
  let where = `stream='speech' and data ? 'text'`;
  if (s) { args.push(s); where += ` and session_id=$1`; }
  const q = await pool.query(
    `select data, wall from records where ${where} order by wall asc limit 8000`, args);
  const segs = q.rows
    .map((r) => ({ text: (r.data.text || '').trim(), wall: Number(r.wall) }))
    .filter((x) => x.text);
  res.json({ count: segs.length, text: segs.map((x) => x.text).join(' '), segments: segs.slice(-600) });
});

app.get('/api/track', requireAdmin, async (req, res) => {
  const s = req.query.session;
  const args = [];
  let where = `stream='location'`;
  if (s) { args.push(s); where += ` and session_id=$1`; }
  // Level-of-detail: decimate to ~perSession points PER session (keeping first + last so no journey
  // vanishes and endpoints stay put). A single ordered scan; the map gets a smooth line without
  // shipping tens of thousands of points. (Persisted multi-tier rollups can replace this at huge scale.)
  const perSession = Math.min(6000, Math.max(300, parseInt(req.query.max, 10) || (s ? 4000 : 1200)));
  const q = await pool.query(
    `with pts as (
       select session_id, wall,
              (data->>'lat')::float8 lat, (data->>'lon')::float8 lon,
              (data->>'acc')::float8 acc, (data->>'speed')::float8 speed, (data->>'suspect') suspect,
              row_number() over (partition by session_id order by wall) rn,
              count(*)     over (partition by session_id) cnt
       from records where ${where} and data ? 'lat'
     )
     select session_id, wall, lat, lon, acc, speed, suspect from pts
     where rn = 1 or rn = cnt or rn % greatest(1, (cnt / ${perSession})::int) = 0
     order by session_id, wall`, args);
  const rows = q.rows.filter(r => r.lat != null && r.lon != null);
  // Merge the fresh in-memory live tail (≤~10s old) on top of the durable DB track, so the map head
  // is current rather than a chunk behind. Only points newer than the session's last DB fix are added.
  const mergeLive = (sid) => {
    const t = liveTracks.get(sid);
    if (!t || !t.pts.length) return;
    let lastWall = 0;
    for (const r of rows) if (r.session_id === sid) { const w = Number(r.wall) || 0; if (w > lastWall) lastWall = w; }
    for (const p of t.pts) {
      if ((p.wall || 0) > lastWall) rows.push({ session_id: sid, wall: p.wall, lat: p.lat, lon: p.lon, acc: p.acc, speed: p.speed, suspect: null, live: true });
    }
  };
  if (s) mergeLive(s); else for (const sid of liveTracks.keys()) mergeLive(sid);
  rows.sort((a, b) => (a.session_id < b.session_id ? -1 : a.session_id > b.session_id ? 1 : (Number(a.wall) || 0) - (Number(b.wall) || 0)));
  res.json(rows);
});

// Every stream captured (all sessions or one), for a comprehensive live view — not just the 4 the
// status chips read. Files/bytes come from the file index (all streams); records from the catalog.
app.get('/api/streams', requireAdmin, async (req, res) => {
  const s = req.query.session; const args = [];
  const where = s ? 'f.session_id=$1' : '1=1';
  if (s) args.push(s);
  const q = await pool.query(
    `select f.stream,
            count(*)::int files,
            coalesce(sum(f.bytes),0)::bigint bytes,
            max(f.received_at) last_recv,
            max(f.kind) kind,
            coalesce((select sum(record_count) from streams st
                      where st.stream=f.stream ${s ? 'and st.session_id=$1' : ''}),0)::bigint records
     from files f where ${where} group by f.stream order by files desc`, args);
  res.json(q.rows.map(r => ({
    stream: r.stream, kind: r.kind, files: r.files,
    bytes: Number(r.bytes || 0), records: Number(r.records || 0),
    lastRecv: r.last_recv ? new Date(r.last_recv).getTime() : null,
  })));
});

const CHUNK_SECONDS = 60;   // audio chunk length; HLS segment duration + clip-count → seconds
// Ordered audio clips (metadata) for the player UI.
app.get('/api/audio', requireAdmin, async (req, res) => {
  const s = req.query.session; const args = [];
  let where = `stream='audio' and kind='audio'`;
  if (s) { args.push(s); where += ` and session_id=$1`; }
  const q = await pool.query(
    `select session_id, filename, path, bytes from files where ${where} order by filename asc limit 5000`, args);
  const clips = q.rows.map((r) => ({ session: r.session_id, filename: r.filename, url: storage.publicUrl(r.path), bytes: Number(r.bytes || 0) }));
  res.json({ clips, seconds: clips.length * CHUNK_SECONDS });
});

// HLS playlist: the session's .aac chunks presented as ONE continuous, scrubbable timeline. A live
// session is an EVENT playlist (seekable from 0:00 AND follows the live edge; grows as chunks land);
// a finished one is VOD (#EXT-X-ENDLIST). hls.js plays raw-AAC (ADTS) segments directly and joins them
// gaplessly with look-ahead buffering. Same-origin, so the auth cookie rides along to /media segments.
app.get('/api/audio/hls', requireAdmin, async (req, res) => {
  const s = req.query.session;
  if (!s) return res.status(400).send('session required');
  const rows = (await pool.query(
    `select filename, path from files where session_id=$1 and stream='audio' and kind='audio' order by filename asc`, [s])).rows;
  if (!rows.length) return res.status(404).send('no audio');
  const live = Number((await pool.query(
    `select count(*) filter (where received_at > now() - interval '3 minutes') recent from batches where session_id=$1`, [s])).rows[0].recent || 0) > 0;
  let m = '#EXTM3U\n#EXT-X-VERSION:3\n';
  m += `#EXT-X-TARGETDURATION:${CHUNK_SECONDS}\n#EXT-X-MEDIA-SEQUENCE:0\n`;
  m += `#EXT-X-PLAYLIST-TYPE:${live ? 'EVENT' : 'VOD'}\n`;
  for (const r of rows) m += `#EXTINF:${CHUNK_SECONDS.toFixed(1)},\n${storage.publicUrl(r.path)}\n`;
  if (!live) m += '#EXT-X-ENDLIST\n';
  res.set('Content-Type', 'application/vnd.apple.mpegurl');
  res.set('Cache-Control', 'no-cache');
  res.send(m);
});

app.get('/api/gallery', requireAdmin, async (req, res) => {
  const s = req.query.session;
  const args = [];
  let where = `kind='media'`;
  if (s) { args.push(s); where += ` and session_id=$1`; }
  const q = await pool.query(
    `select session_id, stream, filename, path, bytes, received_at
     from files where ${where} order by received_at desc limit 500`, args);
  res.json(q.rows.map(r => ({
    ...r,
    url: '/media/' + r.path.split(path.sep).join('/'),
    type: /\.(mp4|mov|webm|mkv)$/i.test(r.filename) ? 'video' : 'image',
  })));
});

app.get('/api/status', requireAdmin, async (req, res) => {
  // Scope to a selected session so the cards show THAT session's live state, not a stale global
  // latest (which could be an old session's record, e.g. an 11-day-old transcript).
  const s = req.query.session || null;
  const sf = s ? ' and session_id=$2' : '';   // $2 in latest(); adjusted per helper below
  const latest = async (stream) => (await pool.query(
    `select data, wall from records where stream=$1${s ? ' and session_id=$2' : ''} order by wall desc nulls last limit 1`,
    s ? [stream, s] : [stream])).rows[0] || null;
  // gnss writes frequent kind:"epoch" measurements + occasional kind:"sky" status; the satellite
  // counts live only on the sky record, so fetch the latest of THOSE, not just the latest gnss row.
  const latestSky = async () => (await pool.query(
    `select data, wall from records where stream='gnss' and data->>'kind'='sky'${s ? ' and session_id=$1' : ''} order by wall desc nulls last limit 1`,
    s ? [s] : [])).rows[0] || null;
  const latestWith = async (stream, field) => (await pool.query(
    `select data, wall from records where stream=$1 and data ? $2${s ? ' and session_id=$3' : ''} order by wall desc limit 1`,
    s ? [stream, field, s] : [stream, field])).rows[0] || null;
  void sf;
  const [activity, loc, wifi, gnss, scene, media, speech, power] = await Promise.all([
    latest('motion_activity'), latest('location'), latest('wifi'), latestSky(),
    latestWith('audio_scene', 'tags'), latestWith('media', 'package'), latestWith('speech', 'text'),
    latestWith('power', 'percent'),
  ]);
  const totals = s
    ? (await pool.query(
      `select 1 sessions,
              (select count(*) from files where kind='media' and session_id=$1) media,
              (select coalesce(record_count,0) from sessions where id=$1) records,
              (select coalesce(sum(bytes),0) from files where session_id=$1) bytes`, [s])).rows[0]
    : (await pool.query(
      `select (select count(*) from sessions) sessions,
              (select count(*) from files where kind='media') media,
              (select coalesce(sum(record_count),0) from sessions) records,
              (select coalesce(sum(bytes),0) from files) bytes`)).rows[0];
  res.json({
    activity: activity && { label: activity.data.label, engine: activity.data.engine, wall: Number(activity.wall) },
    location: loc && { lat: loc.data.lat, lon: loc.data.lon, acc: loc.data.acc,
      alt: (loc.data.alt != null ? Number(loc.data.alt) : null),
      speed: (loc.data.speed != null ? Number(loc.data.speed) : null), wall: Number(loc.wall) },
    battery: power ? { percent: Number(power.data.percent),
      charging: Number(power.data.plugged) > 0 || /charg/i.test(String(power.data.status || '')),
      wall: Number(power.wall) } : null,
    wifi: wifi && { count: wifi.data.count, wall: Number(wifi.wall) },
    gnss: gnss ? { used: gnss.data.usedInFix, inView: gnss.data.inView, wall: Number(gnss.wall) } : null,
    scene: (scene && Array.isArray(scene.data.tags) && scene.data.tags[0])
      ? { label: scene.data.tags[0].label, score: scene.data.tags[0].score, wall: Number(scene.wall) } : null,
    nowPlaying: (media && (media.data.title || media.data.artist))
      ? { title: media.data.title || null, artist: media.data.artist || null, album: media.data.album || null,
          app: media.data.package || null, state: media.data.state || null, wall: Number(media.wall) } : null,
    speech: (speech && speech.data.text)
      ? { text: speech.data.text, wall: Number(speech.wall) } : null,
    totals,
  });
});

// ---- per-session streams manifest (the visualizer's entry point) ----
// One call returns the session clock, every stream with its real time-span + size, and the media
// items with playable URLs. The client loads this once, then streams windows per stream/LOD.
app.get('/api/manifest', requireAdmin, async (req, res) => {
  const sid = String(req.query.session || '');
  if (!sid) return res.status(400).json({ error: 'session required' });
  const session = (await pool.query('select id, device, first_wall, last_wall from sessions where id=$1', [sid])).rows[0];
  if (!session) return res.status(404).json({ error: 'no such session' });
  let streams = (await pool.query(
    `select stream, kind, first_wall, last_wall, file_count, record_count, bytes
     from streams where session_id=$1 order by stream`, [sid])).rows.map((s) => ({
    key: s.stream,
    kind: s.kind,
    range: [s.first_wall == null ? null : Number(s.first_wall), s.last_wall == null ? null : Number(s.last_wall)],
    files: s.file_count,
    records: Number(s.record_count || 0),
    bytes: Number(s.bytes || 0),
  }));
  // Fallback for sessions ingested before the streams catalog existed: derive from the files table.
  if (streams.length === 0) {
    streams = (await pool.query(
      `select stream, min(kind) kind, count(*)::int files, coalesce(sum(bytes),0)::bigint bytes
       from files where session_id=$1 group by stream order by stream`, [sid])).rows.map((x) => ({
      key: x.stream, kind: x.kind, range: [null, null], files: x.files, records: 0, bytes: Number(x.bytes || 0),
    }));
  }
  const media = (await pool.query(
    `select stream, filename, path, kind, bytes from files
     where session_id=$1 and kind in ('media','audio') order by filename`, [sid])).rows.map((f) => ({
    stream: f.stream, filename: f.filename, kind: f.kind, bytes: Number(f.bytes || 0),
    url: storage.publicUrl(f.path),
    type: /\.(mp4|mov|webm|mkv)$/i.test(f.filename) ? 'video' : (f.kind === 'audio' ? 'audio' : 'image'),
  }));
  res.json({
    session: session.id,
    device: session.device,
    clock: { firstWall: session.first_wall == null ? null : Number(session.first_wall), lastWall: session.last_wall == null ? null : Number(session.last_wall) },
    streams,
    media,
  });
});

// ---- media serving (admin only) ----
// Goes through the storage seam: disk today (sendFile), a presigned/CDN redirect once S3/R2 is wired.
app.get('/media/*', requireAdmin, (req, res) => {
  const rel = decodeURIComponent(req.params[0] || '');
  if (rel.includes('..')) return res.status(400).end();
  try { storage.serve(res, rel); } catch (_) { res.status(400).end(); }
});

// ---- APK distribution (remote updates without a cable) ----
app.get('/download', (_req, res) => {
  res.type('html').send(downloadPage(apksByNewest()));
});
app.get('/download/app.apk', (_req, res) => {
  const latest = latestApk();
  if (!latest) return res.status(404).send('No APK published yet.');
  res.download(path.join(APK_DIR, latest), 'valent-capture.apk');
});
// Deliberate download of a specific build (rollback). Basename-guarded to stay inside APK_DIR.
app.get('/download/apk/:name', (req, res) => {
  const name = path.basename(req.params.name || '');
  if (!name.endsWith('.apk')) return res.status(400).send('bad name');
  const p = path.join(APK_DIR, name);
  if (!fs.existsSync(p)) return res.status(404).send('no such build');
  res.download(p, name);
});
// I publish new builds here with the ingest token (kept off the public surface).
app.post('/admin/apk', express.raw({ type: () => true, limit: '256mb' }), (req, res) => {
  const auth = req.header('authorization') || '';
  if (!INGEST_TOKEN || auth !== 'Bearer ' + INGEST_TOKEN) return res.status(401).end();
  const name = (req.header('x-apk-name') || `valent-${Date.now()}.apk`).replace(/[^a-zA-Z0-9._-]/g, '_');
  fs.writeFileSync(path.join(APK_DIR, name), req.body);
  const pruned = pruneApks(3); // keep newest 3 (latest + two rollback points)
  res.json({ ok: true, name, bytes: req.body.length, pruned });
});
// Manual delete of a specific build (same admin token as publish).
app.delete('/admin/apk/:name', (req, res) => {
  const auth = req.header('authorization') || '';
  if (!INGEST_TOKEN || auth !== 'Bearer ' + INGEST_TOKEN) return res.status(401).end();
  const name = path.basename(req.params.name || '');
  if (!name.endsWith('.apk')) return res.status(400).json({ ok: false, error: 'bad name' });
  const p = path.join(APK_DIR, name);
  if (!fs.existsSync(p)) return res.status(404).json({ ok: false, error: 'not found' });
  fs.unlinkSync(p);
  res.json({ ok: true, deleted: name });
});

function apksByNewest() {
  try {
    return fs.readdirSync(APK_DIR).filter(f => f.endsWith('.apk'))
      .map(f => ({ f, t: fs.statSync(path.join(APK_DIR, f)).mtimeMs, size: fs.statSync(path.join(APK_DIR, f)).size }))
      .sort((a, b) => b.t - a.t);
  } catch (_) { return []; }
}
function latestApk() { const l = apksByNewest(); return l[0] && l[0].f; }
// Keep only the newest `keep` builds; delete the rest. Returns names removed.
function pruneApks(keep) {
  const removed = [];
  apksByNewest().slice(keep).forEach(({ f }) => {
    try { fs.unlinkSync(path.join(APK_DIR, f)); removed.push(f); } catch (_) {}
  });
  return removed;
}

// ---- phone setup (QR to configure the app's Sync) ----
app.get('/setup', requireAdmin, async (req, res) => {
  const endpoint = `${req.protocol}://${req.get('host')}/ingest`;
  const key = process.env.INGEST_TOKEN || '';
  const data = `valent://sync?endpoint=${endpoint}&key=${key}`;
  let qr = '';
  try {
    qr = await QRCode.toDataURL(data, { margin: 2, scale: 9, color: { dark: '#0b0b0b', light: '#ffffff' } });
  } catch (e) { console.error('qr error', e); }
  res.type('html').send(setupPage(qr, endpoint, key));
});

// ---- dashboard ----
app.use('/public', requireAdmin, express.static(path.join(__dirname, 'public')));
app.get('/', requireAdmin, (_req, res) => res.sendFile(path.join(__dirname, 'public', 'dashboard.html')));
// ---- /live: the full-screen live media-player view (same password gate) ----
app.get('/live', requireAdmin, (_req, res) => res.sendFile(path.join(__dirname, 'public', 'live.html')));

// ---- pages ----
function loginPage(err, next) {
  const clean = safePath(next);
  const action = '/login' + (clean ? '?next=' + encodeURIComponent(clean) : '');
  const nx = clean.replace(/"/g, '%22').replace(/</g, '%3C');
  return `<!doctype html><meta charset=utf-8><meta name=viewport content="width=device-width,initial-scale=1">
<title>Valent — sign in</title><style>body{background:#0d0d0d;color:#eee;font-family:system-ui;display:grid;place-items:center;height:100vh;margin:0}
form{background:#1a1a19;padding:28px;border-radius:14px;border:1px solid #2c2c2a;width:280px}
h1{font-size:16px;margin:0 0 14px}input{width:100%;box-sizing:border-box;padding:10px;border-radius:8px;border:1px solid #333;background:#111;color:#fff;margin-bottom:10px}
button{width:100%;padding:10px;border:0;border-radius:8px;background:#3987e5;color:#fff;font-weight:600;cursor:pointer}.e{color:#e66767;font-size:12px;margin-bottom:8px}</style>
<form method=post action="${action}"><h1>Valent Intelligence</h1>${err ? `<div class=e>${err}</div>` : ''}
${nx ? `<input type=hidden name=next value="${nx}">` : ''}
<input type=password name=password placeholder=Password autofocus><button>Sign in</button></form>`;
}
function downloadPage(list) {
  const mb = b => (b / 1048576).toFixed(1) + ' MB';
  const rows = list.length
    ? list.map((x, i) => `<li><a href="/download/apk/${encodeURIComponent(x.f)}">${x.f}</a> <span class=mut>· ${mb(x.size)}${i === 0 ? ' · <b style="color:#0ca30c">latest</b>' : ''}</span></li>`).join('')
    : '<li>No APK published yet.</li>';
  return `<!doctype html><meta charset=utf-8><meta name=viewport content="width=device-width,initial-scale=1"><title>Install Valent Capture</title>
<style>body{background:#0d0d0d;color:#eee;font-family:system-ui;max-width:640px;margin:40px auto;padding:0 18px;line-height:1.5}
a{color:#3987e5}code{background:#1a1a19;padding:2px 5px;border-radius:4px}.mut{color:#8a8a86;font-size:13px}
h2{font-size:13px;color:#8a8a86;text-transform:uppercase;letter-spacing:.05em;margin-top:26px}</style>
<h1>Install Valent Capture</h1><p>Tap the button for the newest build, then open it to install. A reinstall over the same app <b>keeps your sessions and permissions</b> (it just stops any live recording; re-grant Health data after an update).</p>
<p><a href="/download/app.apk" style="display:inline-block;background:#3987e5;color:#fff;padding:12px 18px;border-radius:10px;text-decoration:none;font-weight:600">Download latest APK</a></p>
<h2>All builds (newest first)</h2><ul>${rows}</ul>`;
}

function setupPage(qr, endpoint, key) {
  return `<!doctype html><meta charset=utf-8><meta name=viewport content="width=device-width,initial-scale=1">
<title>Connect a phone</title><style>
body{background:#0d0d0d;color:#eee;font-family:system-ui,-apple-system,"Segoe UI",sans-serif;max-width:720px;margin:0 auto;padding:26px 18px 60px;line-height:1.55}
a{color:#3987e5}h1{font-size:20px}.card{background:#1a1a19;border:1px solid #2c2c2a;border-radius:14px;padding:18px;margin:16px 0}
.qr{display:block;width:260px;max-width:80vw;margin:6px auto;border-radius:10px;background:#fff;padding:8px}
code{background:#111;border:1px solid #2c2c2a;padding:3px 6px;border-radius:6px;word-break:break-all;font-size:12.5px}
.row{margin:8px 0}.k{color:#8a8a86;font-size:11px;text-transform:uppercase;letter-spacing:.06em}
ol{padding-left:20px}li{margin:6px 0}.warn{color:#fab219}button{background:#3987e5;color:#fff;border:0;border-radius:7px;padding:5px 9px;cursor:pointer;font-size:12px}
.top{display:flex;gap:14px;align-items:center}.top a{font-size:13px}</style>
<div class="top"><a href="/">&larr; Dashboard</a></div>
<h1>📱 Connect a phone</h1>
<div class="card" style="text-align:center">
${qr ? `<img class="qr" src="${qr}" alt="Sync QR">` : '<p>(QR unavailable)</p>'}
<p style="color:#8a8a86;font-size:13px;margin:6px 0 0">Valent Capture &rarr; <b>Settings &rarr; Sync &rarr; Scan QR</b></p>
</div>
<div class="card">
<div class="row"><span class="k">Endpoint</span><br><code id="ep">${endpoint}</code> <button onclick="navigator.clipboard.writeText('${endpoint}')">copy</button></div>
<div class="row"><span class="k">Key</span><br><code id="ky">${key}</code> <button onclick="navigator.clipboard.writeText('${key}')">copy</button></div>
</div>
<div class="card">
<h3 style="margin-top:0">Steps</h3>
<ol>
<li>Open the app &rarr; <b>Settings &rarr; Sync</b>.</li>
<li><b>Scan QR</b> and point it at the code above (or paste the endpoint + key).</li>
<li>Turn on <b>Enable sync</b>; set interval to <b>1 min</b> for near-real-time.</li>
<li class="warn">Turn <b>OFF "Wi-Fi only"</b> if you want it to push on cellular / roaming while travelling.</li>
<li>Tap <b>Sync now</b> to send immediately.</li>
</ol>
</div>`;
}

// ---- boot ----
(async () => {
  try { await init(); console.log('db ready'); } catch (e) { console.error('db init failed', e); }
  const port = process.env.PORT || 10000;
  app.listen(port, () => console.log('valent-intelligence-server on :' + port));
})();
