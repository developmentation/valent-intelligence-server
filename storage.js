'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

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
  /**
   * Stream a readable straight to storage with CONSTANT memory — for large media (video) that must not
   * be buffered whole in RAM on the single instance. Hashes as it writes; cleans up a partial file if
   * the source errors (a dropped upload). Returns { key, bytes, sha256 }. (S3/R2 later: multipart put.)
   */
  putStream(key, readable) {
    const p = abs(key);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    return new Promise((resolve, reject) => {
      const hash = crypto.createHash('sha256');
      let bytes = 0;
      const ws = fs.createWriteStream(p);
      const fail = (e) => { ws.destroy(); fs.unlink(p, () => {}); reject(e); };
      readable.on('data', (d) => { bytes += d.length; hash.update(d); });
      readable.on('error', fail);
      ws.on('error', fail);
      ws.on('finish', () => resolve({ key, bytes, sha256: hash.digest('hex') }));
      readable.pipe(ws);
    });
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

// ── S3 driver (OVH object storage) ────────────────────────────────────────────────────────────────
// Raw + original media live in the bucket (durable, uncapped, free egress). The instance's local disk
// (ROOT) is used only as a CACHE for derived artifacts (image resizes, video renditions, posters) and
// upload staging — regenerable from the bucket, so it can be small and ephemeral. Reads that need a
// real file (transcode/resize source) call the async `ensureLocal(key)` which pulls the original into the
// cache on demand. Serving redirects to a short-lived presigned URL so bytes go client↔OVH directly.
function makeS3() {
  const { S3Client, GetObjectCommand, PutObjectCommand, HeadObjectCommand, DeleteObjectCommand } =
    require('@aws-sdk/client-s3');
  const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
  const Bucket = process.env.S3_BUCKET;
  const client = new S3Client({
    region: process.env.S3_REGION || 'bhs',
    endpoint: process.env.S3_ENDPOINT,
    forcePathStyle: true,
    credentials: { accessKeyId: process.env.S3_ACCESS_KEY, secretAccessKey: process.env.S3_SECRET_KEY },
  });
  const CACHE = ROOT;                       // local NVMe cache/staging root (MEDIA_ROOT)
  const cabs = (key) => abs(key);           // reuse the traversal-safe local path resolver
  const streamToBuffer = (s) => new Promise((res, rej) => {
    const c = []; s.on('data', (d) => c.push(d)); s.on('error', rej); s.on('end', () => res(Buffer.concat(c)));
  });

  return {
    driver: 's3',
    root: CACHE,                            // uploadpipe staging + derived caches live here (local)
    async put(key, buf) {
      await client.send(new PutObjectCommand({ Bucket, Key: key, Body: buf, ContentLength: buf.length }));
      return { key, bytes: buf.length };
    },
    // Stream to a local temp first (to get length + sha), then PUT. Constant memory relative to a buffer.
    putStream(key, readable) {
      const tmp = path.join(CACHE, '_tmp', crypto.randomBytes(16).toString('hex'));
      fs.mkdirSync(path.dirname(tmp), { recursive: true });
      return new Promise((resolve, reject) => {
        const hash = crypto.createHash('sha256'); let bytes = 0;
        const ws = fs.createWriteStream(tmp);
        const fail = (e) => { ws.destroy(); fs.unlink(tmp, () => {}); reject(e); };
        readable.on('data', (d) => { bytes += d.length; hash.update(d); });
        readable.on('error', fail); ws.on('error', fail);
        ws.on('finish', async () => {
          try {
            await client.send(new PutObjectCommand({ Bucket, Key: key, Body: fs.createReadStream(tmp), ContentLength: bytes }));
            fs.unlink(tmp, () => {});
            resolve({ key, bytes, sha256: hash.digest('hex') });
          } catch (e) { fs.unlink(tmp, () => {}); reject(e); }
        });
        readable.pipe(ws);
      });
    },
    async get(key) {
      const r = await client.send(new GetObjectCommand({ Bucket, Key: key }));
      return streamToBuffer(r.Body);
    },
    async exists(key) {
      try { await client.send(new HeadObjectCommand({ Bucket, Key: key })); return true; }
      catch { return false; }
    },
    async del(key) {
      try { await client.send(new DeleteObjectCommand({ Bucket, Key: key })); return true; } catch { return false; }
    },
    // No synchronous local path on S3 — callers that need a real file use ensureLocal (async) instead.
    localPath: undefined,
    // Pull the object into the local cache (idempotent) and return its path — for transcode/resize sources.
    async ensureLocal(key) {
      const p = cabs(key);
      if (fs.existsSync(p) && fs.statSync(p).size > 0) return p;
      fs.mkdirSync(path.dirname(p), { recursive: true });
      const r = await client.send(new GetObjectCommand({ Bucket, Key: key }));
      await new Promise((resolve, reject) => {
        const ws = fs.createWriteStream(p); r.Body.on('error', reject); ws.on('error', reject);
        ws.on('finish', resolve); r.Body.pipe(ws);
      });
      return p;
    },
    publicUrl(key) { return '/media/' + String(key).split(path.sep).join('/'); },
    // Redirect to a short-lived presigned URL: client fetches straight from OVH (free egress), VM doesn't proxy.
    async serve(res, key, downloadName) {
      try {
        const cmd = new GetObjectCommand({
          Bucket, Key: key,
          ...(downloadName ? { ResponseContentDisposition: `attachment; filename="${downloadName}"` } : {}),
        });
        const url = await getSignedUrl(client, cmd, { expiresIn: 3600 });
        res.redirect(302, url);
      } catch (e) { res.status(404).end(); }
    },
  };
}

let impl = disk;
if (DRIVER === 's3') {
  try { impl = makeS3(); }
  catch (e) { console.error('storage: S3 driver init failed, falling back to disk:', e.message); impl = disk; }
} else if (DRIVER !== 'disk') {
  console.warn(`storage: driver "${DRIVER}" not implemented — using disk`);
}

module.exports = impl;
