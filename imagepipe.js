// Image pipeline — on-the-fly downscale + recompress with an on-disk cache, so the gallery/curate/publish
// surfaces fetch small JPEGs instead of the full-resolution capture (a phone photo here can be ~20 MB).
//
// A request for `<media-url>?w=400` returns a JPEG resized to 400 px wide, quality-compressed, and cached
// under MEDIA_ROOT/_derived/w400/<key>.jpg. Captures are content-addressed + uniquely named, so a derived
// image never goes stale → it's served `immutable` with a 1-year cache. Non-images, unknown widths, or a
// missing `w` fall through to the original bytes. A decode failure also falls back to the original, so this
// can never make a previously-working image 404.
const fs = require('fs');
const path = require('path');
let sharp = null;
try { sharp = require('sharp'); } catch (_) { /* sharp unavailable → always serve originals */ }

// Allowlisted widths keep the derived cache bounded (no arbitrary ?w=317 explosion). These match the
// front-end request sizes: filmstrip 140, grid ~400/500, hero/lightbox/slideshow 1600, retina 2400.
const WIDTHS = new Set([140, 200, 320, 400, 500, 800, 1200, 1600, 2400]);
const IMG_RE = /\.(jpe?g|png|webp|gif|heic|heif|bmp|tiff?)$/i;

function derivedAbs(root, key, w) {
  // Mirror the key under _derived/w<width>/, always as .jpg. Guard traversal via path.resolve check.
  const safe = String(key).split('/').join(path.sep);
  const p = path.resolve(root, '_derived', 'w' + w, safe + '.jpg');
  const base = path.resolve(root, '_derived');
  if (p !== base && !p.startsWith(base + path.sep)) throw new Error('derived key escapes cache root');
  return p;
}

/**
 * Serve `rel` as an HTTP response, resized when `?w=<allowed>` is present and the file is an image;
 * otherwise the original bytes. `storage` is the disk driver (needs localPath/serve/root).
 */
async function sendImage(req, res, storage, rel, downloadName) {
  const w = parseInt(req.query && req.query.w, 10);
  const wantResize = sharp && w && WIDTHS.has(w) && IMG_RE.test(rel) && typeof storage.localPath === 'function';
  if (!wantResize) return storage.serve(res, rel, downloadName);

  const src = storage.localPath(rel);
  let out;
  try { out = derivedAbs(storage.root, rel, w); } catch (_) { return storage.serve(res, rel, downloadName); }

  // A derived JPEG is immutable (its source never changes) — cache hard, both at the browser and edge.
  res.set('Cache-Control', 'public, max-age=31536000, immutable');
  if (fs.existsSync(out)) return res.sendFile(out, (e) => { if (e) storage.serve(res, rel, downloadName); });

  try {
    fs.mkdirSync(path.dirname(out), { recursive: true });
    await sharp(src, { failOn: 'none' })
      .rotate()                                        // honor EXIF orientation, then drop metadata
      .resize({ width: w, withoutEnlargement: true })
      .jpeg({ quality: 78, mozjpeg: true, progressive: true })
      .toFile(out);
    return res.sendFile(out, (e) => { if (e) storage.serve(res, rel, downloadName); });
  } catch (_) {
    // decode/encode failed (e.g. a HEIC the build can't read) → never worse than the original
    return storage.serve(res, rel, downloadName);
  }
}

module.exports = { sendImage, WIDTHS };
