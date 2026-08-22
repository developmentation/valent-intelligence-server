'use strict';
/**
 * EXACT port of the phone's `GeoTrack.clean` (capture/.../engine/geo/GeoTrack.kt): an accuracy-weighted
 * 2-D constant-velocity Kalman filter + RTS smoother, per axis, with a glitch gate. Feeding /api/track
 * through this makes the server's "de-noised" track identical to the phone's map — same constants, same
 * math — instead of drawing raw fixes with spikes. Keep the constants in sync with the Kotlin file.
 */
const SPEED_CAP_MPS = 50.0;   // ~180 km/h — glitch gate (with ACC_BAD_M)
const ACC_BAD_M = 50.0;
const ACC_FLOOR_M = 3.0;      // never trust a fix better than ±3 m
const SIGMA_A = 1.2;          // process noise: std of unmodelled accel (m/s²)
const P0_POS = 100.0 * 100.0;
const P0_VEL = 10.0 * 10.0;
const M_PER_DEG = 111320.0;

function median(v) { const s = [...v].sort((a, b) => a - b); return s[Math.floor(s.length / 2)]; }

/** 2-state [pos, vel] CV Kalman + RTS for one axis; returns smoothed [pos, vel] per step. */
function axisSmooth(ts, z, acc) {
  const n = z.length, q = SIGMA_A * SIGMA_A;
  const xf = Array.from({ length: n }, () => [0, 0]);
  const xp = Array.from({ length: n }, () => [0, 0]);
  const pf = Array.from({ length: n }, () => [0, 0, 0, 0]);
  const pp = Array.from({ length: n }, () => [0, 0, 0, 0]);
  const dts = new Array(n).fill(0);
  let pos = z[0], vel = 0;
  let c00 = P0_POS, c01 = 0, c10 = 0, c11 = P0_VEL;
  for (let i = 0; i < n; i++) {
    const dt = i === 0 ? 0 : ts[i] - ts[i - 1];
    dts[i] = dt;
    let ppPos, ppVel, d00, d01, d10, d11;
    if (i === 0) { ppPos = pos; ppVel = vel; d00 = c00; d01 = c01; d10 = c10; d11 = c11; }
    else {
      ppPos = pos + dt * vel; ppVel = vel;
      const a00 = c00 + dt * c10, a01 = c01 + dt * c11, a10 = c10, a11 = c11;
      d00 = a00 + dt * a01; d01 = a01; d10 = a10 + dt * a11; d11 = a11;
      d00 += q * dt * dt * dt / 3.0; d01 += q * dt * dt / 2.0; d10 += q * dt * dt / 2.0; d11 += q * dt;
    }
    xp[i][0] = ppPos; xp[i][1] = ppVel;
    pp[i][0] = d00; pp[i][1] = d01; pp[i][2] = d10; pp[i][3] = d11;
    const r = acc[i] * acc[i];
    const s = d00 + r;
    const k0 = d00 / s, k1 = d10 / s;
    const resid = z[i] - ppPos;
    pos = ppPos + k0 * resid; vel = ppVel + k1 * resid;
    const e00 = (1 - k0) * d00, e01 = (1 - k0) * d01, e10 = d10 - k1 * d00, e11 = d11 - k1 * d01;
    c00 = e00; c01 = e01; c10 = e10; c11 = e11;
    xf[i][0] = pos; xf[i][1] = vel;
    pf[i][0] = c00; pf[i][1] = c01; pf[i][2] = c10; pf[i][3] = c11;
  }
  const out = xf.map((a) => a.slice());
  for (let i = n - 2; i >= 0; i--) {
    const dt = dts[i + 1];
    const f00 = pf[i][0] + pf[i][1] * dt, f01 = pf[i][1], f10 = pf[i][2] + pf[i][3] * dt, f11 = pf[i][3];
    const a = pp[i + 1][0], b = pp[i + 1][1], c = pp[i + 1][2], d = pp[i + 1][3];
    const det = a * d - b * c;
    if (Math.abs(det) < 1e-12) continue;
    const i00 = d / det, i01 = -b / det, i10 = -c / det, i11 = a / det;
    const g00 = f00 * i00 + f01 * i10, g01 = f00 * i01 + f01 * i11, g10 = f10 * i00 + f11 * i10, g11 = f10 * i01 + f11 * i11;
    const dxp = out[i + 1][0] - xp[i + 1][0], dxv = out[i + 1][1] - xp[i + 1][1];
    out[i][0] = xf[i][0] + g00 * dxp + g01 * dxv;
    out[i][1] = xf[i][1] + g10 * dxp + g11 * dxv;
  }
  return out;
}

/** Clean fixes [{lat,lon,frac,accuracy}] into a smoothed track [{lat,lon,frac,speedMps}]. frac is the
 *  time axis (seconds when durationSec=1). Mirrors GeoTrack.clean exactly. */
function clean(fixes, durationSec) {
  const sorted = [...fixes].sort((a, b) => a.frac - b.frac);
  const pts = [];
  for (const p of sorted) if (!pts.length || p.frac > pts[pts.length - 1].frac) pts.push(p);
  if (pts.length < 2) return pts.map((p) => ({ lat: p.lat, lon: p.lon, frac: p.frac, speedMps: 0 }));
  const lat0 = median(pts.map((p) => p.lat)), lon0 = median(pts.map((p) => p.lon));
  const coslat = Math.cos(lat0 * Math.PI / 180.0);
  const toX = (lon) => (lon - lon0) * coslat * M_PER_DEG, toY = (lat) => (lat - lat0) * M_PER_DEG;
  const toLat = (y) => lat0 + y / M_PER_DEG, toLon = (x) => lon0 + x / (coslat * M_PER_DEG);
  const t = [], zx = [], zy = [], acc = [], frac = [];
  let lastT = 0, lastX = 0, lastY = 0, have = false;
  for (const p of pts) {
    const tt = p.frac * durationSec, x = toX(p.lon), y = toY(p.lat);
    if (have) {
      const dt = tt - lastT;
      if (dt > 0 && Math.hypot(x - lastX, y - lastY) / dt > SPEED_CAP_MPS && p.accuracy > ACC_BAD_M) continue;
    }
    t.push(tt); zx.push(x); zy.push(y); acc.push(Math.max(p.accuracy, ACC_FLOOR_M)); frac.push(p.frac);
    lastT = tt; lastX = x; lastY = y; have = true;
  }
  const n = t.length;
  if (n < 2) return Array.from({ length: n }, (_, i) => ({ lat: toLat(zy[i]), lon: toLon(zx[i]), frac: frac[i], speedMps: 0 }));
  const xs = axisSmooth(t, zx, acc), ys = axisSmooth(t, zy, acc);
  return Array.from({ length: n }, (_, i) => ({ lat: toLat(ys[i][0]), lon: toLon(xs[i][0]), frac: frac[i], speedMps: Math.hypot(xs[i][1], ys[i][1]) }));
}

module.exports = { clean };
