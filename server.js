'use strict';
const express = require('express');
const session = require('express-session');
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
    res.status(out.status).json(out.body);
  } catch (e) {
    console.error('ingest error', e);
    res.status(500).json({ ok: false, error: String(e.message || e) });
  }
});

// ---- diagnostics (token-gated, no login) ----
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
    const idxRe = /_(\d+)\.[^.]+$/;
    const byStream = {};
    let onDisk = 0; const missingDisk = [];
    for (const f of files) {
      const s = (byStream[f.stream] || (byStream[f.stream] = { count: 0, indices: [], bytes: 0, kind: f.kind }));
      s.count++; s.bytes += Number(f.bytes || 0);
      const m = idxRe.exec(f.filename); if (m) s.indices.push(parseInt(m[1], 10));
      if (await storage.exists(f.path)) onDisk++; else missingDisk.push(f.path);
    }
    const streams = Object.entries(byStream).map(([stream, s]) => {
      const idx = s.indices.slice().sort((a, b) => a - b);
      const min = idx.length ? idx[0] : null;
      const max = idx.length ? idx[idx.length - 1] : null;
      const present = new Set(idx);
      const gaps = [];
      if (min != null) for (let i = min; i <= max; i++) if (!present.has(i)) gaps.push(i);
      return {
        stream, kind: s.kind, files: s.count, bytes: s.bytes,
        minIdx: min, maxIdx: max, expectedChunks: min != null ? max - min + 1 : s.count,
        gapCount: gaps.length, gapsSample: gaps.slice(0, 50), contiguous: gaps.length === 0,
      };
    }).sort((a, b) => b.bytes - a.bytes);

    // Indexing: records actually landed for the queryable streams.
    const recRows = (await pool.query(
      'select stream, count(*)::int n from records where session_id=$1 group by stream', [sid])).rows;
    const indexed = {}; recRows.forEach((r) => { indexed[r.stream] = r.n; });

    // Manifest present + best-effort capture-close detection from the raw manifest.
    const manifestKey = `${sid}/manifest.jsonl`;
    const manifestPresent = await storage.exists(manifestKey);
    let closedDetected = null;
    if (manifestPresent) {
      try {
        const txt = (await storage.get(manifestKey)).toString('utf8');
        closedDetected = /session_?close|"closed"\s*:\s*true|"ended?"\s*:\s*true/i.test(txt);
      } catch (_) { /* leave null */ }
    }

    const totalGaps = streams.reduce((a, s) => a + s.gapCount, 0);
    const dbVsScan = files.length === session.file_count;
    const complete = totalGaps === 0 && missingDisk.length === 0 && manifestPresent && dbVsScan;
    res.json({
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
      upload: { filesOnDisk: onDisk, filesMissingOnDisk: missingDisk.length, missingSample: missingDisk.slice(0, 20), totalChunkGaps: totalGaps },
      manifestPresent, closedDetected,
      streams: streams.map((s) => ({ ...s, indexedRecords: indexed[s.stream] || 0 })),
      verdict: complete ? 'COMPLETE' : 'INCOMPLETE',
      reasons: [
        totalGaps ? `${totalGaps} missing chunk(s)` : null,
        missingDisk.length ? `${missingDisk.length} file(s) not on disk` : null,
        !manifestPresent ? 'manifest missing' : null,
        !dbVsScan ? `file_count mismatch (db ${session.file_count} vs scan ${files.length})` : null,
      ].filter(Boolean),
    });
  } catch (e) { res.status(500).json({ error: String(e.message || e) }); }
});

// ---- admin auth ----
app.use(session({
  secret: process.env.SESSION_SECRET || crypto.randomBytes(24).toString('hex'),
  resave: false,
  saveUninitialized: false,
  cookie: { httpOnly: true, sameSite: 'lax', secure: 'auto', maxAge: 1000 * 60 * 60 * 24 * 14 },
}));
app.use(express.urlencoded({ extended: false }));
app.use(express.json());

function requireAdmin(req, res, next) {
  if (req.session && req.session.admin) return next();
  if (req.path.startsWith('/api/') || req.path.startsWith('/media/')) {
    return res.status(401).json({ ok: false, error: 'login required' });
  }
  return res.redirect('/login');
}

app.get('/login', (req, res) => {
  res.type('html').send(loginPage(req.query.e ? 'Wrong password.' : ''));
});
app.post('/login', (req, res) => {
  if (ADMIN_PASSWORD && req.body.password === ADMIN_PASSWORD) {
    req.session.admin = true;
    return res.redirect('/');
  }
  return res.redirect('/login?e=1');
});
app.post('/logout', (req, res) => { req.session.destroy(() => res.redirect('/login')); });

// ---- viewer APIs (admin only) ----
app.get('/api/sessions', requireAdmin, async (_req, res) => {
  const q = await pool.query(
    `select id, device, first_wall, last_wall, bytes, file_count, record_count, updated_at
     from sessions order by coalesce(last_wall, extract(epoch from updated_at)*1000) desc limit 200`);
  res.json(q.rows);
});

app.get('/api/track', requireAdmin, async (req, res) => {
  const s = req.query.session;
  const args = [];
  let where = `stream='location'`;
  if (s) { args.push(s); where += ` and session_id=$1`; }
  const q = await pool.query(
    `select session_id, wall,
            (data->>'lat')::float8 as lat, (data->>'lon')::float8 as lon,
            (data->>'acc')::float8 as acc, (data->>'speed')::float8 as speed,
            (data->>'suspect') as suspect
     from records where ${where} and data ? 'lat'
     order by wall asc limit 50000`, args);
  res.json(q.rows.filter(r => r.lat != null && r.lon != null));
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

app.get('/api/status', requireAdmin, async (_req, res) => {
  const latest = async (stream) => (await pool.query(
    `select data, wall from records where stream=$1 order by wall desc nulls last limit 1`, [stream])).rows[0] || null;
  const [activity, loc, wifi, gnss] = await Promise.all([
    latest('motion_activity'), latest('location'), latest('wifi'), latest('gnss'),
  ]);
  const totals = (await pool.query(
    `select (select count(*) from sessions) sessions,
            (select count(*) from files where kind='media') media,
            (select coalesce(sum(record_count),0) from sessions) records,
            (select coalesce(sum(bytes),0) from files) bytes`)).rows[0];
  res.json({
    activity: activity && { label: activity.data.label, engine: activity.data.engine, wall: Number(activity.wall) },
    location: loc && { lat: loc.data.lat, lon: loc.data.lon, acc: loc.data.acc, wall: Number(loc.wall) },
    wifi: wifi && { count: wifi.data.count, wall: Number(wifi.wall) },
    gnss: gnss && gnss.data.kind === 'sky' ? { used: gnss.data.usedInFix, inView: gnss.data.inView, wall: Number(gnss.wall) } : null,
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

// ---- pages ----
function loginPage(err) {
  return `<!doctype html><meta charset=utf-8><meta name=viewport content="width=device-width,initial-scale=1">
<title>Valent — sign in</title><style>body{background:#0d0d0d;color:#eee;font-family:system-ui;display:grid;place-items:center;height:100vh;margin:0}
form{background:#1a1a19;padding:28px;border-radius:14px;border:1px solid #2c2c2a;width:280px}
h1{font-size:16px;margin:0 0 14px}input{width:100%;box-sizing:border-box;padding:10px;border-radius:8px;border:1px solid #333;background:#111;color:#fff;margin-bottom:10px}
button{width:100%;padding:10px;border:0;border-radius:8px;background:#3987e5;color:#fff;font-weight:600;cursor:pointer}.e{color:#e66767;font-size:12px;margin-bottom:8px}</style>
<form method=post action=/login><h1>Valent Intelligence</h1>${err ? `<div class=e>${err}</div>` : ''}
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
