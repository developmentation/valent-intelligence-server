'use strict';
const fs = require('fs');
const path = require('path');

/**
 * Pluggable blob store — the ONE seam that keeps the data portable.
 *
 * Today: `disk` driver → the Render persistent disk at MEDIA_ROOT (no new subscription, no cost
 * change). Later: set STORAGE=s3 and implement the S3/R2 branch here; migrating off Render then means
 * (a) drop in the driver and (b) copy the files (`aws s3 sync` / rclone) — the keys and the DB are
 * unchanged. Callers never touch fs directly, so nothing else in the server changes on migration.
 *
 * Keys are POSIX-style relative paths. Convention:
 *   raw (canonical):   `{session}/{stream}/{file}`     ← what the phone pushes; unchanged from before
 *   derived (outputs): `_derived/{session}/{...}`       ← HLS, waveforms, tiles, manifests, GPU output
 */
const DRIVER = process.env.STORAGE || 'disk';
const ROOT = process.env.MEDIA_ROOT || '/data/media';

function abs(key) {
  // Normalize the key to a safe path under ROOT (defence against traversal).
  const rel = String(key).split('/').join(path.sep);
  const p = path.resolve(ROOT, rel);
  if (p !== ROOT && !p.startsWith(ROOT + path.sep)) throw new Error('key escapes storage root');
  return p;
}

const disk = {
  driver: 'disk',
  root: ROOT,
  async put(key, buf) {
    const p = abs(key);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, buf);
    return { key, bytes: buf.length };
  },
  async get(key) { return fs.readFileSync(abs(key)); },
  async exists(key) { return fs.existsSync(abs(key)); },
  async del(key) { try { fs.unlinkSync(abs(key)); return true; } catch { return false; } },
  /** Local filesystem path — disk-only helper (undefined on object-store drivers). */
  localPath(key) { return abs(key); },
  /** Public path the browser fetches. Disk → our /media route; S3/R2 later → a presigned/CDN URL. */
  publicUrl(key) { return '/media/' + String(key).split(path.sep).join('/'); },
  /** Stream a key to an HTTP response (disk: sendFile; S3/R2 later: 302 to a presigned URL). */
  serve(res, key, downloadName) {
    const p = abs(key);
    if (downloadName) res.download(p, downloadName, (e) => { if (e) res.status(404).end(); });
    else res.sendFile(p, (e) => { if (e) res.status(404).end(); });
  },
};

// Only the disk driver exists today. When S3/R2 is wired, branch on DRIVER here and return an object
// with the same shape (publicUrl → presigned/CDN, serve → 302 redirect, localPath → undefined).
if (DRIVER !== 'disk') {
  console.warn(`storage: driver "${DRIVER}" not implemented yet — falling back to disk`);
}

module.exports = disk;
