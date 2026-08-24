// Resumable, checksum-validated chunked upload — the reliable path for longform / multi-GB video that a
// single request can't carry past the CDN edge. The client splits a file into chunks and uploads each with
// its SHA-256; the server verifies EACH chunk on arrival, then on `complete` concatenates them in order and
// verifies the WHOLE-FILE SHA-256 against what the client declared. Only a byte-exact match is committed —
// otherwise the upload is discarded and the client restarts. Every step streams to disk (constant memory).
//
// State lives on disk under MEDIA_ROOT/_uploads/<id>/ (meta.json + <index>.part), so an interrupted upload
// RESUMES: re-`init` returns which chunks already landed and the client sends only the rest. `id` is derived
// from (session, filename, final sha) so a resume finds the same staging dir without the client storing it.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const sanFile = (s) => String(s || '').replace(/[^a-zA-Z0-9._-]/g, '_');
const sanStream = (s) => (String(s || 'camera').replace(/[^a-z0-9_]/gi, '') || 'camera');

function stagingRoot(storage) { return path.resolve(storage.root, '_uploads'); }
function idFor(session, filename, sha) {
  return crypto.createHash('sha256').update(session + '\0' + filename + '\0' + sha).digest('hex').slice(0, 32);
}
function dirFor(storage, id) {
  if (!/^[0-9a-f]{32}$/.test(String(id || ''))) throw new Error('bad upload id');
  const base = stagingRoot(storage);
  const p = path.resolve(base, id);
  if (!p.startsWith(base + path.sep)) throw new Error('upload id escapes staging root');
  return p;
}
function totalChunks(meta) { return Math.max(1, Math.ceil(meta.size / meta.chunkSize)); }
function receivedList(dir, total) {
  const r = [];
  for (let i = 0; i < total; i++) if (fs.existsSync(path.join(dir, i + '.part'))) r.push(i);
  return r;
}
function readMeta(storage, id) {
  const dir = dirFor(storage, id);
  const mp = path.join(dir, 'meta.json');
  if (!fs.existsSync(mp)) return null;
  return { dir, ...JSON.parse(fs.readFileSync(mp, 'utf8')) };
}

function init(storage, body) {
  const session = String(body.session || '');
  const filename = sanFile(body.filename);
  const stream = sanStream(body.stream);
  const size = Number(body.size);
  const sha256 = String(body.sha256 || '').toLowerCase();
  const chunkSize = Number(body.chunkSize);
  if (!session || session.includes('/') || session.includes('..')) throw new Error('bad session');
  if (!filename || !size || size < 0 || !chunkSize || chunkSize < 1) throw new Error('missing size/chunkSize/filename');
  if (!/^[0-9a-f]{64}$/.test(sha256)) throw new Error('sha256 must be 64 hex chars');
  const id = idFor(session, filename, sha256);
  const dir = dirFor(storage, id);
  fs.mkdirSync(dir, { recursive: true });
  const mp = path.join(dir, 'meta.json');
  const meta = { session, filename, stream, size, sha256, chunkSize };
  if (!fs.existsSync(mp)) fs.writeFileSync(mp, JSON.stringify(meta));
  const total = totalChunks(meta);
  return { uploadId: id, chunkSize, totalChunks: total, received: receivedList(dir, total) };
}

// Stream one chunk to disk and verify its SHA-256. Returns {status, ...}.
function saveChunk(storage, id, indexRaw, shaRaw, readable) {
  return new Promise((resolve) => {
    let m; try { m = readMeta(storage, id); } catch (e) { return resolve({ status: 400, error: String(e.message) }); }
    if (!m) return resolve({ status: 404, error: 'no such upload' });
    const total = totalChunks(m);
    const index = parseInt(indexRaw, 10);
    const sha = String(shaRaw || '').toLowerCase();
    if (!(index >= 0 && index < total)) return resolve({ status: 400, error: 'bad chunk index' });
    if (!/^[0-9a-f]{64}$/.test(sha)) return resolve({ status: 400, error: 'x-chunk-sha256 must be 64 hex chars' });
    const tmp = path.join(m.dir, index + '.part.tmp');
    const fin = path.join(m.dir, index + '.part');
    const h = crypto.createHash('sha256');
    const ws = fs.createWriteStream(tmp);
    let done = false;
    const fail = (e) => { if (done) return; done = true; try { ws.destroy(); } catch (_) {} fs.unlink(tmp, () => {}); resolve({ status: 500, error: String(e && e.message || e) }); };
    readable.on('error', fail); ws.on('error', fail);
    readable.on('data', (d) => h.update(d));
    readable.pipe(ws);
    ws.on('finish', () => {
      if (done) return; done = true;
      const got = h.digest('hex');
      if (got !== sha) { fs.unlink(tmp, () => {}); return resolve({ status: 422, error: 'chunk sha mismatch', expected: sha, got }); }
      try { fs.renameSync(tmp, fin); } catch (e) { return resolve({ status: 500, error: String(e.message) }); }
      resolve({ status: 200, ok: true, index, received: receivedList(m.dir, total).length, totalChunks: total });
    });
  });
}

function status(storage, id) {
  let m; try { m = readMeta(storage, id); } catch (_) { return null; }
  if (!m) return null;
  const total = totalChunks(m);
  const r = receivedList(m.dir, total);
  const missing = [];
  for (let i = 0; i < total; i++) if (!r.includes(i)) missing.push(i);
  return { uploadId: id, totalChunks: total, received: r, missing, size: m.size };
}

// Concatenate parts[0..n] into dest with backpressure, hashing as we go. Resolves the hex digest.
function concatAndHash(parts, dest) {
  return new Promise((resolve, reject) => {
    const ws = fs.createWriteStream(dest);
    const h = crypto.createHash('sha256');
    ws.on('error', reject);
    ws.on('finish', () => resolve(h.digest('hex')));
    let i = 0;
    const nextPart = () => {
      if (i >= parts.length) { ws.end(); return; }
      const rs = fs.createReadStream(parts[i]); i++;
      rs.on('error', reject);
      rs.on('data', (d) => { h.update(d); if (!ws.write(d)) { rs.pause(); ws.once('drain', () => rs.resume()); } });
      rs.on('end', nextPart);
    };
    nextPart();
  });
}

// Verify all chunks present, reassemble, verify whole-file SHA, and hand back the finished temp path + key.
async function complete(storage, id) {
  let m; try { m = readMeta(storage, id); } catch (e) { return { status: 400, error: String(e.message) }; }
  if (!m) return { status: 404, error: 'no such upload' };
  const total = totalChunks(m);
  const missing = [];
  for (let i = 0; i < total; i++) if (!fs.existsSync(path.join(m.dir, i + '.part'))) missing.push(i);
  if (missing.length) return { status: 409, error: 'incomplete', missing };
  const parts = []; for (let i = 0; i < total; i++) parts.push(path.join(m.dir, i + '.part'));
  const finalTmp = path.join(m.dir, 'final.tmp');
  let got;
  try { got = await concatAndHash(parts, finalTmp); }
  catch (e) { try { fs.unlinkSync(finalTmp); } catch (_) {} return { status: 500, error: String(e && e.message || e) }; }
  if (got !== m.sha256) {
    try { fs.rmSync(m.dir, { recursive: true, force: true }); } catch (_) {}   // corrupt → discard, client restarts
    return { status: 422, error: 'final sha mismatch — upload discarded, please restart', expected: m.sha256, got };
  }
  const key = `${m.session}/${m.stream}/${m.filename}`;
  let dest; try { dest = storage.localPath(key); } catch (e) { return { status: 400, error: String(e.message) }; }
  try { fs.mkdirSync(path.dirname(dest), { recursive: true }); fs.renameSync(finalTmp, dest); }
  catch (e) { return { status: 500, error: String(e && e.message || e) }; }
  return { status: 200, ok: true, key, bytes: m.size, sha256: m.sha256, session: m.session, stream: m.stream, filename: m.filename, dir: m.dir };
}

module.exports = { init, saveChunk, status, complete, idFor };
