// Video pipeline — transcode captured videos into a small web-optimized MP4 LADDER (multiple renditions),
// cached on disk and served by default to every server surface (dashboard, live, curate, published). The
// ORIGINAL is never touched — it stays downloadable via ?dl=1 / ?orig=1.
//
// Renditions are keyed by their long-edge cap: 854 (~480p), 1280 (~720p, the default), 1920 (~1080p). A
// rendition is only produced when it's an actual downscale of the source; a small source yields one native
// re-encode. Each rendition is one ffmpeg child process (its own OS thread of work), so transcoding runs
// OFF the request-serving thread. Concurrency scales with CPUs but always reserves one core for the web
// server: CONCURRENCY = max(1, cpus-1), each ffmpeg pinned to 1 thread. Graceful no-op if ffmpeg is absent.
const { spawn } = require('child_process');
const os = require('os');
const fs = require('fs');
const path = require('path');
let FFMPEG = null;
try { FFMPEG = require('ffmpeg-static'); } catch (_) { FFMPEG = null; }

const VIDEO_RE = /\.(mp4|mov|m4v|webm|mkv|avi)$/i;
const isVideo = (rel) => VIDEO_RE.test(rel);

const LADDER = [854, 1280, 1920];          // long-edge caps: ~480p / ~720p / ~1080p
const DEFAULT_EDGE = 1280;                 // served when no ?q — a good web default (~720p)
const Q_TO_EDGE = { '480': 854, '720': 1280, '1080': 1920 };
const CONCURRENCY = Math.max(1, (os.cpus() ? os.cpus().length : 1) - 1);

function dirAbs(root, key) {
  const safe = String(key).split('/').join(path.sep);
  const p = path.resolve(root, '_derived', 'video', safe);
  const base = path.resolve(root, '_derived', 'video');
  if (p !== base && !p.startsWith(base + path.sep)) throw new Error('web key escapes cache root');
  return p;
}
const rendAbs = (root, key, edge) => path.join(dirAbs(root, key), edge + '.mp4');

const queue = [];               // pending rendition jobs {key, edge, out, src, rel}
const inQueue = new Set();       // `${rel}@${edge}` dedupe
const planned = new Set();       // rels whose ladder has been planned
let running = 0;
const stat = { done: 0, failed: 0, planned: 0 };

function probeLongEdge(src) {
  // Parse ffmpeg -i stderr for the video stream WxH; return max(w,h) or null.
  return new Promise((resolve) => {
    const p = spawn(FFMPEG, ['-hide_banner', '-i', src], { stdio: ['ignore', 'ignore', 'pipe'] });
    let err = '';
    p.stderr.on('data', (d) => { err += d; });
    p.on('error', () => resolve(null));
    p.on('close', () => {
      const m = err.match(/Video:.*?(\d{2,5})x(\d{2,5})/);
      if (!m) return resolve(null);
      resolve(Math.max(parseInt(m[1], 10), parseInt(m[2], 10)));
    });
  });
}

function runJob(job) {
  return new Promise((resolve) => {
    if (!fs.existsSync(job.src)) { stat.failed++; return resolve(); }
    try { fs.mkdirSync(path.dirname(job.out), { recursive: true }); } catch (_) { stat.failed++; return resolve(); }
    const tmp = job.out + '.tmp.mp4';
    // Fit within a box of `edge` on the long side, preserving aspect + even dims, for BOTH orientations.
    const L = job.edge;
    const vf = `scale='if(gt(iw,ih),min(${L},iw),-2)':'if(gt(iw,ih),-2,min(${L},ih))'`;
    const args = ['-hide_banner', '-loglevel', 'error', '-y', '-i', job.src,
      '-vf', vf, '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '28',
      '-pix_fmt', 'yuv420p', '-movflags', '+faststart', '-threads', '1', '-c:a', 'aac', '-b:a', '96k', tmp];
    let err = '';
    const p = spawn(FFMPEG, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    p.stderr.on('data', (d) => { err += d; });
    p.on('error', () => { stat.failed++; try { fs.unlinkSync(tmp); } catch (_) {} resolve(); });
    p.on('close', (code) => {
      if (code === 0 && fs.existsSync(tmp)) {
        try { fs.renameSync(tmp, job.out); stat.done++; } catch (_) { stat.failed++; }
      } else {
        stat.failed++;
        try { fs.unlinkSync(tmp); } catch (_) {}
        if (err) console.error('ffmpeg failed', job.rel, job.edge, err.slice(0, 200));
      }
      resolve();
    });
  });
}

function pump() {
  while (running < CONCURRENCY && queue.length) {
    const job = queue.shift();
    inQueue.delete(`${job.rel}@${job.edge}`);
    running++;
    runJob(job).finally(() => { running--; setImmediate(pump); });
  }
}

function pushJob(storage, rel, edge) {
  let out; try { out = rendAbs(storage.root, rel, edge); } catch (_) { return; }
  if (fs.existsSync(out)) return;
  const tag = `${rel}@${edge}`;
  if (inQueue.has(tag)) return;
  inQueue.add(tag);
  queue.push({ rel, edge, out, src: storage.localPath(rel) });
}

async function planLadder(storage, rel) {
  if (planned.has(rel)) return;
  planned.add(rel); stat.planned++;
  const srcLong = await probeLongEdge(storage.localPath(rel));
  // renditions at or below the source's long edge (so a 1080p source also gets a compressed 1080p web
  // version), capped by the ladder's top (4K sources top out at ~1080p web; original kept for download).
  let edges = LADDER.filter((L) => srcLong ? L <= srcLong : true);
  if (!edges.length) edges = [Math.min(srcLong || DEFAULT_EDGE, DEFAULT_EDGE)];  // small source → one native re-encode
  for (const e of edges) pushJob(storage, rel, e);
  pump();
}

/** Kick off the ladder for a video (async, non-blocking). No-op if ffmpeg unavailable / not a video. */
function enqueue(storage, rel) {
  if (!FFMPEG || !isVideo(rel)) return false;
  if (!planned.has(rel)) { planLadder(storage, rel).catch(() => {}); return true; }
  return false;
}

/** Absolute path to a ready web rendition (honoring ?q), or null (kicks off the ladder for next time). */
function webIfReady(storage, rel, q) {
  if (!FFMPEG || !isVideo(rel)) return null;
  let root; try { dirAbs(storage.root, rel); root = storage.root; } catch (_) { return null; }
  const have = LADDER.filter((L) => { try { return fs.existsSync(rendAbs(root, rel, L)); } catch (_) { return false; } });
  // also allow a native-edge rendition (small source) — probe the dir for any Nmp4
  if (!have.length) { enqueue(storage, rel); return null; }
  const want = (q && Q_TO_EDGE[String(q)]) || DEFAULT_EDGE;
  // nearest available: prefer exact/just-below want, else the largest we have
  const atOrBelow = have.filter((L) => L <= want);
  const pick = atOrBelow.length ? Math.max(...atOrBelow) : Math.min(...have);
  enqueue(storage, rel);   // ensure the full ladder eventually exists (cheap if already planned)
  return rendAbs(root, rel, pick);
}

/** Enqueue ladders for every not-yet-done video in a set of `files` rows ([{path}]). */
function backfill(storage, rows) {
  let enqueued = 0, alreadyWeb = 0, alreadyPlanned = 0;
  for (const r of rows) {
    if (!isVideo(r.path)) continue;
    let done = false;
    try { done = LADDER.some((L) => fs.existsSync(rendAbs(storage.root, r.path, L))); } catch (_) {}
    if (done) { alreadyWeb++; continue; }
    if (planned.has(r.path)) { alreadyPlanned++; continue; }
    if (enqueue(storage, r.path)) enqueued++;
  }
  return { enqueued, alreadyWeb, alreadyPlanned };
}

module.exports = {
  isVideo, enqueue, webIfReady, backfill,
  available: () => !!FFMPEG,
  status: () => ({ available: !!FFMPEG, concurrency: CONCURRENCY, running, pending: queue.length, ...stat }),
};
