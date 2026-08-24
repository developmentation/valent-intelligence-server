// Video pipeline — transcode captured videos to a small, fast, web-optimized MP4 (H.264, faststart),
// cached on disk, served by default to curate/publish/live; the original stays downloadable (?dl=1).
//
// Transcoding is CPU-heavy and this runs on a small single instance (0.5 CPU / 512 MB), so it happens in
// a background queue with CONCURRENCY 1 — it never blocks request handling, and a video is served from
// its original bytes until its web version is ready. If ffmpeg is unavailable, everything degrades to
// serving originals (no crash). Web versions are content-stable → cached `immutable`.
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
let FFMPEG = null;
try { FFMPEG = require('ffmpeg-static'); } catch (_) { FFMPEG = null; }

const VIDEO_RE = /\.(mp4|mov|m4v|webm|mkv|avi)$/i;
const isVideo = (rel) => VIDEO_RE.test(rel);

function webAbs(root, key) {
  const safe = String(key).split('/').join(path.sep);
  const p = path.resolve(root, '_derived', 'video', safe + '.mp4');
  const base = path.resolve(root, '_derived', 'video');
  if (p !== base && !p.startsWith(base + path.sep)) throw new Error('web key escapes cache root');
  return p;
}

const queue = [];
const queued = new Set();
let running = false;
const stat = { done: 0, failed: 0, current: null };

function transcode(job) {
  return new Promise((resolve) => {
    if (!fs.existsSync(job.src)) { stat.failed++; return resolve(); }
    try { fs.mkdirSync(path.dirname(job.out), { recursive: true }); } catch (_) { stat.failed++; return resolve(); }
    const tmp = job.out + '.tmp.mp4';
    // veryfast + crf 28 + cap width 1280, 1 thread → small output, gentle on a 0.5-CPU instance. Audio is
    // encoded to AAC only if a track exists (our in-app videos are audio-less; -c:a aac is a no-op then).
    const args = ['-hide_banner', '-loglevel', 'error', '-y', '-i', job.src,
      '-vf', "scale='min(1280,iw)':-2", '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '28',
      '-pix_fmt', 'yuv420p', '-movflags', '+faststart', '-threads', '1', '-c:a', 'aac', '-b:a', '96k', tmp];
    let err = '';
    const p = spawn(FFMPEG, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    p.stderr.on('data', (d) => { err += d; });
    p.on('error', () => { stat.failed++; try { fs.unlinkSync(tmp); } catch (_) {} resolve(); });
    p.on('close', (code) => {
      if (code === 0 && fs.existsSync(tmp)) {
        try { fs.renameSync(tmp, job.out); stat.done++; }
        catch (_) { stat.failed++; }
      } else {
        stat.failed++;
        try { fs.unlinkSync(tmp); } catch (_) {}
        if (err) console.error('ffmpeg failed', job.rel, err.slice(0, 300));
      }
      resolve();
    });
  });
}

function pump() {
  if (running) return;
  const job = queue.shift();
  if (!job) return;
  running = true; stat.current = job.rel;
  transcode(job).finally(() => {
    running = false; stat.current = null; queued.delete(job.rel);
    setImmediate(pump);
  });
}

/** Queue a video for web transcoding (no-op if ffmpeg unavailable, not a video, already done, or queued). */
function enqueue(storage, rel) {
  if (!FFMPEG || !isVideo(rel) || queued.has(rel)) return false;
  let out; try { out = webAbs(storage.root, rel); } catch (_) { return false; }
  if (fs.existsSync(out)) return false;
  queued.add(rel);
  queue.push({ rel, out, src: storage.localPath(rel) });
  pump();
  return true;
}

/** Absolute path to the ready web version, or null (enqueues a transcode so it's ready next time). */
function webIfReady(storage, rel) {
  if (!FFMPEG || !isVideo(rel)) return null;
  let out; try { out = webAbs(storage.root, rel); } catch (_) { return null; }
  if (fs.existsSync(out)) return out;
  enqueue(storage, rel);
  return null;
}

/** Enqueue every not-yet-transcoded video from a set of `files` rows ([{path}]). */
function backfill(storage, rows) {
  let enqueued = 0, alreadyWeb = 0, alreadyQueued = 0;
  for (const r of rows) {
    if (!isVideo(r.path)) continue;
    let out; try { out = webAbs(storage.root, r.path); } catch (_) { continue; }
    if (fs.existsSync(out)) { alreadyWeb++; continue; }
    if (queued.has(r.path)) { alreadyQueued++; continue; }
    if (enqueue(storage, r.path)) enqueued++;
  }
  return { enqueued, alreadyWeb, alreadyQueued };
}

module.exports = {
  isVideo, enqueue, webIfReady, backfill, webAbs,
  available: () => !!FFMPEG,
  status: () => ({ available: !!FFMPEG, pending: queue.length, ...stat }),
};
