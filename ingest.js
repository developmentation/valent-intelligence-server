'use strict';
const zlib = require('zlib');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { pool } = require('./db');

const MEDIA_ROOT = process.env.MEDIA_ROOT || '/data/media';

const MEDIA_EXT = new Set(['jpg', 'jpeg', 'png', 'webp', 'gif', 'mp4', 'mov', 'mkv', 'webm']);
const AUDIO_EXT = new Set(['aac', 'm4a', 'opus', 'ogg', 'wav', 'mp3', 'flac']);

function sha256hex(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}
function extOf(name) {
  const i = name.lastIndexOf('.');
  return i >= 0 ? name.slice(i + 1).toLowerCase() : '';
}
function kindOf(filename, stream) {
  const e = extOf(filename);
  if (MEDIA_EXT.has(e)) return 'media';
  if (AUDIO_EXT.has(e) || stream === 'audio') return 'audio';
  if (e === 'jsonl' || e === 'json') return 'json';
  return 'binary';
}

/**
 * Parse a gzip(VBATCH1) body into its members.
 * Container: a UTF-8 text header ending in a line "--", then the concatenated raw member bytes.
 *   VBATCH1
 *   device=<model>
 *   created_ern=<n>
 *   member <sha256hex> <len> <session/stream/file>
 *   ...
 *   --
 *   <member0 bytes><member1 bytes>...
 */
function parseVbatch(gzipped) {
  const buf = zlib.gunzipSync(gzipped);
  const sep = buf.indexOf(Buffer.from('\n--\n'));
  if (sep < 0) throw new Error('no VBATCH1 header terminator');
  const header = buf.slice(0, sep).toString('utf8');
  let offset = sep + 4; // past "\n--\n"
  const lines = header.split('\n');
  if (!lines[0].startsWith('VBATCH1')) throw new Error('not a VBATCH1 container');
  let device = null;
  const members = [];
  for (const line of lines) {
    if (line.startsWith('device=')) device = line.slice(7);
    else if (line.startsWith('member ')) {
      // member <sha> <len> <path with possible spaces>
      const rest = line.slice(7);
      const s1 = rest.indexOf(' ');
      const s2 = rest.indexOf(' ', s1 + 1);
      const sha = rest.slice(0, s1);
      const len = parseInt(rest.slice(s1 + 1, s2), 10);
      const rel = rest.slice(s2 + 1); // sessionId/stream/filename
      const bytes = buf.slice(offset, offset + len);
      offset += len;
      members.push({ sha, len, rel, bytes });
    }
  }
  return { device, members };
}

function splitRel(rel) {
  // sessionId/stream/filename  (filename may contain nothing exotic; stream is the middle dir)
  const parts = rel.split('/');
  const sessionId = parts[0];
  const filename = parts[parts.length - 1];
  const stream = parts.length >= 3 ? parts.slice(1, -1).join('/') : (parts.length === 2 ? '' : '');
  return { sessionId, stream, filename };
}

function walOf(o) {
  for (const k of ['wall', 'wallMs', 'startWallMs', 'startWall', 'timestampMillis']) {
    if (typeof o[k] === 'number') return o[k];
  }
  return null;
}

async function storeMember(m) {
  const { sessionId, stream, filename } = splitRel(m.rel);
  if (!sessionId) return { skipped: true };
  const kind = kindOf(filename, stream);

  // Write to disk (idempotent by content path).
  const dir = path.join(MEDIA_ROOT, sessionId, stream);
  fs.mkdirSync(dir, { recursive: true });
  const dest = path.join(dir, filename);
  fs.writeFileSync(dest, m.bytes);

  if (filename === 'manifest.jsonl') {
    // Session metadata + clock; overwrite, don't index as a file (changes every batch).
    await upsertSessionFromManifest(sessionId, m.bytes);
    return { manifest: true };
  }

  // Dedup by content hash: only NEW files get parsed into records.
  const ins = await pool.query(
    `insert into files (session_id, stream, filename, path, sha256, bytes, kind)
     values ($1,$2,$3,$4,$5,$6,$7) on conflict (sha256) do nothing returning id`,
    [sessionId, stream, filename, path.join(sessionId, stream, filename), m.sha, m.len, kind],
  );
  if (ins.rowCount === 0) return { duplicate: true };

  let recCount = 0;
  if (kind === 'json' && filename.endsWith('.jsonl')) {
    recCount = await ingestJsonl(sessionId, stream, m.bytes);
  }
  return { stored: true, kind, records: recCount };
}

async function ingestJsonl(sessionId, stream, bytes) {
  const text = bytes.toString('utf8');
  const rows = [];
  for (const line of text.split('\n')) {
    const s = line.trim();
    if (!s) continue;
    let o;
    try { o = JSON.parse(s); } catch { continue; }
    rows.push([sessionId, stream, (typeof o.ern === 'number' ? o.ern : null), walOf(o), o]);
  }
  // batch insert
  const CHUNK = 500;
  for (let i = 0; i < rows.length; i += CHUNK) {
    const slice = rows.slice(i, i + CHUNK);
    const vals = [];
    const ph = slice.map((r, j) => {
      const b = j * 5;
      vals.push(r[0], r[1], r[2], r[3], JSON.stringify(r[4]));
      return `($${b + 1},$${b + 2},$${b + 3},$${b + 4},$${b + 5})`;
    }).join(',');
    await pool.query(
      `insert into records (session_id, stream, ern, wall, data) values ${ph}`,
      vals,
    );
  }
  return rows.length;
}

async function upsertSessionFromManifest(sessionId, bytes) {
  let device = null, firstWall = null, lastWall = null;
  const text = bytes.toString('utf8');
  for (const line of text.split('\n')) {
    const s = line.trim();
    if (!s) continue;
    let o;
    try { o = JSON.parse(s); } catch { continue; }
    if (o.device && !device) device = o.device;
    if (o.model && !device) device = o.model;
    const w = walOf(o) || (o.t === 'clock_anchor' ? o.wall : null);
    if (typeof w === 'number') {
      if (firstWall === null || w < firstWall) firstWall = w;
      if (lastWall === null || w > lastWall) lastWall = w;
    }
  }
  await pool.query(
    `insert into sessions (id, device, first_wall, last_wall, updated_at)
       values ($1,$2,$3,$4, now())
     on conflict (id) do update set
       device = coalesce(excluded.device, sessions.device),
       first_wall = least(coalesce(sessions.first_wall, excluded.first_wall), excluded.first_wall),
       last_wall = greatest(coalesce(sessions.last_wall, excluded.last_wall), excluded.last_wall),
       updated_at = now()`,
    [sessionId, device, firstWall, lastWall],
  );
}

/** Handle one POST body. Returns {status, body}. */
async function handleIngest(headers, rawBody) {
  const encrypted = headers['x-valent-encrypted'];
  if (encrypted && encrypted !== '0') {
    // Encrypted (VSEAL1) payloads not yet supported server-side; the phone default is unencrypted.
    return { status: 415, body: { ok: false, error: 'encrypted payloads not yet supported' } };
  }
  // Optional integrity check of the whole POST body.
  const claimed = headers['x-valent-sha256'];
  if (claimed && sha256hex(rawBody) !== claimed) {
    return { status: 400, body: { ok: false, error: 'body sha256 mismatch' } };
  }
  const batchHdr = headers['x-valent-batch'] || '';
  const [sessionId0, idxStr] = batchHdr.split('#');
  const idx = parseInt(idxStr, 10);

  // Idempotency: if we've already ingested this exact body, ack.
  const bodySha = sha256hex(rawBody);
  const dup = await pool.query('select id from batches where sha256=$1', [bodySha]);
  if (dup.rowCount > 0) {
    return { status: 200, body: { ok: true, duplicate: true } };
  }

  const { device, members } = parseVbatch(rawBody);
  // verify each member sha
  for (const m of members) {
    if (sha256hex(m.bytes) !== m.sha) {
      return { status: 400, body: { ok: false, error: `member sha mismatch: ${m.rel}` } };
    }
  }
  let stored = 0, recs = 0;
  for (const m of members) {
    const r = await storeMember(m);
    if (r.stored) stored++;
    if (r.records) recs += r.records;
  }
  await pool.query(
    `insert into batches (session_id, idx, sha256, device, bytes, members)
     values ($1,$2,$3,$4,$5,$6) on conflict (sha256) do nothing`,
    [sessionId0 || null, Number.isFinite(idx) ? idx : null, bodySha,
      device || headers['x-valent-device'] || null, rawBody.length, members.length],
  );
  // refresh rollups
  if (sessionId0) {
    await pool.query(
      `update sessions s set
         bytes = coalesce((select sum(bytes) from files f where f.session_id=s.id),0),
         file_count = coalesce((select count(*) from files f where f.session_id=s.id),0),
         record_count = coalesce((select count(*) from records r where r.session_id=s.id),0)
       where s.id=$1`, [sessionId0]);
  }
  return { status: 200, body: { ok: true, session: sessionId0, members: members.length, storedNew: stored, records: recs } };
}

module.exports = { handleIngest, MEDIA_ROOT };
