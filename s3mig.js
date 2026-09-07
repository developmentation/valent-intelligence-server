'use strict';
// Minimal S3 (SigV4) client for the disk->OVH migration. No SDK/deps: Node https + crypto only.
// Streams file bodies with UNSIGNED-PAYLOAD so we never buffer a whole video in RAM.
const https = require('https');
const crypto = require('crypto');
const fs = require('fs');
const { URL } = require('url');

const EP = process.env.S3_ENDPOINT || '';       // e.g. https://s3.bhs.io.cloud.ovh.net
const REGION = process.env.S3_REGION || 'bhs';
const BUCKET = process.env.S3_BUCKET || '';
const AK = process.env.S3_ACCESS_KEY || '';
const SK = process.env.S3_SECRET_KEY || '';
const HOST = EP ? new URL(EP).host : '';
const SERVICE = 's3';
const configured = !!(EP && BUCKET && AK && SK);

const hmac = (key, msg) => crypto.createHmac('sha256', key).update(msg).digest();
function signingKey(date) {
  let k = hmac('AWS4' + SK, date); k = hmac(k, REGION); k = hmac(k, SERVICE);
  return hmac(k, 'aws4_request');
}
const amzNow = () => new Date().toISOString().replace(/[:-]|\.\d{3}/g, ''); // YYYYMMDDTHHMMSSZ

// Path-style, per-segment URI-encoded key. Slashes preserved (they separate canonical path segments).
const encKey = (key) => '/' + BUCKET + '/' + String(key).split('/').map(encodeURIComponent).join('/');

function sign(method, key, extraHeaders) {
  const amz = amzNow(); const date = amz.slice(0, 8);
  const path = encKey(key);
  const base = { host: HOST, 'x-amz-content-sha256': 'UNSIGNED-PAYLOAD', 'x-amz-date': amz };
  const merged = Object.assign(base, extraHeaders || {});
  const lower = {}; Object.keys(merged).forEach(h => { lower[h.toLowerCase()] = String(merged[h]).trim(); });
  const signed = Object.keys(lower).sort().join(';');
  const canonHeaders = Object.keys(lower).sort().map(h => `${h}:${lower[h]}\n`).join('');
  const canonReq = `${method}\n${path}\n\n${canonHeaders}\n${signed}\nUNSIGNED-PAYLOAD`;
  const scope = `${date}/${REGION}/${SERVICE}/aws4_request`;
  const sts = `AWS4-HMAC-SHA256\n${amz}\n${scope}\n${crypto.createHash('sha256').update(canonReq).digest('hex')}`;
  const sig = crypto.createHmac('sha256', signingKey(date)).update(sts).digest('hex');
  lower.authorization = `AWS4-HMAC-SHA256 Credential=${AK}/${scope}, SignedHeaders=${signed}, Signature=${sig}`;
  return { path, headers: lower };
}

function headObject(key) {
  return new Promise((resolve) => {
    const { path, headers } = sign('HEAD', key, {});
    const req = https.request({ host: HOST, path, method: 'HEAD', headers, timeout: 30000 }, (res) => {
      resolve({ status: res.statusCode, size: Number(res.headers['content-length'] || -1) });
      res.resume();
    });
    req.on('error', () => resolve({ status: 0, size: -1 }));
    req.on('timeout', () => { req.destroy(); resolve({ status: 0, size: -1 }); });
    req.end();
  });
}

// Stream a local file to S3. Content-Length is signed (must match). Body is UNSIGNED-PAYLOAD.
function putFile(key, localPath, size) {
  return new Promise((resolve, reject) => {
    const { path, headers } = sign('PUT', key, { 'content-length': String(size) });
    const req = https.request({ host: HOST, path, method: 'PUT', headers, timeout: 600000 }, (res) => {
      let b = ''; res.on('data', d => b += d); res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) resolve(true);
        else reject(new Error('PUT ' + res.statusCode + ' ' + b.slice(0, 200)));
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(new Error('PUT timeout')); });
    fs.createReadStream(localPath).on('error', reject).pipe(req);
  });
}

module.exports = { configured, headObject, putFile, HOST, BUCKET, REGION };
