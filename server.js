'use strict';
const express = require('express');
const session = require('express-session');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { pool, init } = require('./db');
const { handleIngest, MEDIA_ROOT } = require('./ingest');

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
            (select count(*) from records) records,
            (select coalesce(sum(bytes),0) from files) bytes`)).rows[0];
  res.json({
    activity: activity && { label: activity.data.label, engine: activity.data.engine, wall: Number(activity.wall) },
    location: loc && { lat: loc.data.lat, lon: loc.data.lon, acc: loc.data.acc, wall: Number(loc.wall) },
    wifi: wifi && { count: wifi.data.count, wall: Number(wifi.wall) },
    gnss: gnss && gnss.data.kind === 'sky' ? { used: gnss.data.usedInFix, inView: gnss.data.inView, wall: Number(gnss.wall) } : null,
    totals,
  });
});

// ---- media serving (admin only) ----
app.get('/media/*', requireAdmin, (req, res) => {
  const rel = decodeURIComponent(req.params[0] || '');
  if (rel.includes('..')) return res.status(400).end();
  const abs = path.join(MEDIA_ROOT, rel);
  if (!abs.startsWith(MEDIA_ROOT)) return res.status(400).end();
  res.sendFile(abs, (err) => { if (err) res.status(404).end(); });
});

// ---- APK distribution (remote updates without a cable) ----
app.get('/download', (_req, res) => {
  let list = [];
  try { list = fs.readdirSync(APK_DIR).filter(f => f.endsWith('.apk')); } catch (_) {}
  res.type('html').send(downloadPage(list));
});
app.get('/download/app.apk', (_req, res) => {
  const latest = latestApk();
  if (!latest) return res.status(404).send('No APK published yet.');
  res.download(path.join(APK_DIR, latest), 'valent-capture.apk');
});
// I publish new builds here with the ingest token (kept off the public surface).
app.post('/admin/apk', express.raw({ type: () => true, limit: '256mb' }), (req, res) => {
  const auth = req.header('authorization') || '';
  if (!INGEST_TOKEN || auth !== 'Bearer ' + INGEST_TOKEN) return res.status(401).end();
  const name = (req.header('x-apk-name') || `valent-${Date.now()}.apk`).replace(/[^a-zA-Z0-9._-]/g, '_');
  fs.writeFileSync(path.join(APK_DIR, name), req.body);
  res.json({ ok: true, name, bytes: req.body.length });
});

function latestApk() {
  try {
    const files = fs.readdirSync(APK_DIR).filter(f => f.endsWith('.apk'))
      .map(f => ({ f, t: fs.statSync(path.join(APK_DIR, f)).mtimeMs }))
      .sort((a, b) => b.t - a.t);
    return files[0] && files[0].f;
  } catch (_) { return null; }
}

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
  const rows = list.length ? list.map(f => `<li><a href="/download/app.apk">${f}</a></li>`).join('') : '<li>No APK published yet.</li>';
  return `<!doctype html><meta charset=utf-8><meta name=viewport content="width=device-width,initial-scale=1"><title>Install Valent Capture</title>
<style>body{background:#0d0d0d;color:#eee;font-family:system-ui;max-width:640px;margin:40px auto;padding:0 18px;line-height:1.5}
a{color:#3987e5}code{background:#1a1a19;padding:2px 5px;border-radius:4px}</style>
<h1>Install Valent Capture</h1><p>Tap to download the latest build, then open it to install. A reinstall over the same app <b>keeps your sessions and permissions</b> (it just stops any live recording).</p>
<p><a href="/download/app.apk" style="display:inline-block;background:#3987e5;color:#fff;padding:12px 18px;border-radius:10px;text-decoration:none;font-weight:600">Download latest APK</a></p>
<ul>${rows}</ul>`;
}

// ---- boot ----
(async () => {
  try { await init(); console.log('db ready'); } catch (e) { console.error('db init failed', e); }
  const port = process.env.PORT || 10000;
  app.listen(port, () => console.log('valent-intelligence-server on :' + port));
})();
