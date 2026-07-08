/**
 * scripts/tune_faces.js
 * ─────────────────────────────────────────────────────────────────────────
 * Headless validation of computeFaceExposure() — the exterior-face occlusion
 * mask precompute (see three-scene.js). Lifts the function VERBATIM from the
 * live source (anti-drift, same pattern as tune_lib's segmentBuildings) and
 * runs it over every district's decoded box set, reporting timing and
 * exposure statistics.
 *
 * tune_lib's decode only keeps AABBs, so this script re-decodes with the full
 * per-box T·R·S matrices (the harness convention: scripts that need matrices
 * copy the decode loop — see tune_lib.js decodeDistrict for the canon).
 *
 * Run: node scripts/tune_faces.js
 * Sanity expectations: dense districts (city_center, watson) show HIGH
 * fully-interior %; ep1_spaceport LOW; zero NaN; a synthetic isolated box has
 * all four side faces fully exposed (0).
 */
'use strict';

const path = require('path');
const { ROOT, NCZ, DISTRICTS, SCENE, sliceBalanced, loadDataDds } = require('./tune_lib');

// ── lift computeFaceExposure verbatim ────────────────────────────────────────
const faceSrc = sliceBalanced(SCENE, 'function computeFaceExposure', '{', '}');
// eslint-disable-next-line no-eval
const computeFaceExposure = eval(`(${faceSrc})`);

// ── decode WITH matrices (mirror of loadBuildings; tune_lib keeps AABBs only) ─
function decodeDistrictMatrices(meta) {
  const ddsPath = meta.dataDdsFixed || meta.dataDds;
  const { pixels, width: texW, height: texH } = loadDataDds(path.join(ROOT, ddsPath));
  const blockW = Math.floor(texW / 3);
  const blockH = Math.min(texH, blockW);
  const T = NCZ.DDS_ALPHA_THRESH, U = NCZ.UINT16_MAX, CS = meta.cubeSize;
  const tMin = meta.transMin, tMax = meta.transMax, ofs = meta.offset;

  const cap = blockW * blockH;
  const matrixData = new Float32Array(cap * 16);
  const bcx = new Float32Array(cap), bcy = new Float32Array(cap), bcz = new Float32Array(cap);
  const bhx = new Float32Array(cap), bhy = new Float32Array(cap), bhz = new Float32Array(cap);
  let n = 0;
  for (let y = 0; y < blockH; y++) {
    for (let x = 0; x < blockW; x++) {
      const pi = (y * texW + x) * 4;
      const ri = (y * texW + x + blockW) * 4;
      const si = (y * texW + x + 2 * blockW) * 4;
      const scaleEmpty = pixels[si] < T && pixels[si + 1] < T && pixels[si + 2] < T;
      if (pixels[pi + 3] < T || scaleEmpty) continue;

      const pr = pixels[pi] / U, pg = pixels[pi + 1] / U, pb = pixels[pi + 2] / U;
      const cetX = tMin[0] + (tMax[0] - tMin[0]) * pr + ofs[0];
      const cetY = tMin[1] + (tMax[1] - tMin[1]) * pg + ofs[1];
      const cetZ = tMin[2] + (tMax[2] - tMin[2]) * pb;

      const qr = pixels[ri] / U * 2 - 1, qg = pixels[ri + 1] / U * 2 - 1;
      const qb = pixels[ri + 2] / U * 2 - 1, qa = pixels[ri + 3] / U * 2 - 1;
      const ql = Math.hypot(qr, qg, qb, qa) || 1;
      const X = qr / ql, Y = qb / ql, Z = -qg / ql, W = qa / ql;

      const hx = pixels[si] / U * CS, hy = pixels[si + 1] / U * CS, hz = pixels[si + 2] / U * CS;
      const sx = hx * 2, sy = hz * 2, sz = hy * 2;

      const x2 = X + X, y2 = Y + Y, z2 = Z + Z;
      const xx = X * x2, xy = X * y2, xz = X * z2;
      const yy = Y * y2, yz = Y * z2, zz = Z * z2;
      const wx = W * x2, wy = W * y2, wz = W * z2;
      const b = n * 16;
      matrixData[b + 0] = (1 - (yy + zz)) * sx; matrixData[b + 1] = (xy + wz) * sx; matrixData[b + 2] = (xz - wy) * sx;
      matrixData[b + 4] = (xy - wz) * sy; matrixData[b + 5] = (1 - (xx + zz)) * sy; matrixData[b + 6] = (yz + wx) * sy;
      matrixData[b + 8] = (xz + wy) * sz; matrixData[b + 9] = (yz - wx) * sz; matrixData[b + 10] = (1 - (xx + yy)) * sz;
      matrixData[b + 12] = cetX; matrixData[b + 13] = cetZ; matrixData[b + 14] = -cetY;
      matrixData[b + 15] = 1;

      bcx[n] = cetX; bcy[n] = cetZ; bcz[n] = -cetY;
      bhx[n] = 0.5 * (Math.abs(matrixData[b]) + Math.abs(matrixData[b + 4]) + Math.abs(matrixData[b + 8]));
      bhy[n] = 0.5 * (Math.abs(matrixData[b + 1]) + Math.abs(matrixData[b + 5]) + Math.abs(matrixData[b + 9]));
      bhz[n] = 0.5 * (Math.abs(matrixData[b + 2]) + Math.abs(matrixData[b + 6]) + Math.abs(matrixData[b + 10]));
      n++;
    }
  }
  return { name: meta.name, count: n, matrixData, bcx, bcy, bcz, bhx, bhy, bhz };
}

// ── synthetic sanity check: one isolated axis-aligned box ────────────────────
function isolatedBoxCheck() {
  const m = new Float32Array(16);
  m[0] = 20; m[5] = 60; m[10] = 30; m[12] = 0; m[13] = 30; m[14] = 0; m[15] = 1;
  const r = computeFaceExposure(m, new Float32Array([0]), new Float32Array([30]), new Float32Array([0]),
    new Float32Array([10]), new Float32Array([30]), new Float32Array([15]), 1);
  const allExposed = [...r.exposure].every((v) => v === 0);
  return { pass: allExposed, exposure: [...r.exposure] };
}

// ── two stacked boxes: tall slab behind a half-height neighbour ──────────────
// The tall box's +X face is buried below the neighbour's roof → yExp ≈ 0.5.
function stackedBoxCheck() {
  const m = new Float32Array(32);
  // box 0: 20 wide (X) × 60 tall × 30 deep at origin
  m[0] = 20; m[5] = 60; m[10] = 30; m[13] = 30; m[15] = 1;
  // box 1: same footprint, 30 tall, pressed against box 0's +X face
  m[16] = 20; m[21] = 30; m[26] = 30; m[28] = 20; m[29] = 15; m[31] = 1;
  const r = computeFaceExposure(m,
    new Float32Array([0, 20]), new Float32Array([30, 15]), new Float32Array([0, 0]),
    new Float32Array([10, 10]), new Float32Array([30, 15]), new Float32Array([15, 15]), 2);
  const posX0 = r.exposure[0];            // box 0, +X face — expect ≈ 0.5
  return { pass: posX0 > 0.4 && posX0 < 0.6, posX0, exposure: [...r.exposure] };
}

// ── run ──────────────────────────────────────────────────────────────────────
console.log('computeFaceExposure — headless validation\n');

const iso = isolatedBoxCheck();
console.log(`isolated box: ${iso.pass ? 'PASS' : 'FAIL'} (all faces exposed) → [${iso.exposure.join(', ')}]`);
const stk = stackedBoxCheck();
console.log(`stacked pair: ${stk.pass ? 'PASS' : 'FAIL'} (+X exposed-above ≈ 0.5) → ${stk.posX0.toFixed(3)}\n`);

const rows = [];
let totalMs = 0, totalBoxes = 0;
for (const meta of DISTRICTS) {
  let d;
  try { d = decodeDistrictMatrices(meta); } catch { continue; }
  if (!d.count) continue;
  const t0 = process.hrtime.bigint();
  const r = computeFaceExposure(d.matrixData, d.bcx, d.bcy, d.bcz, d.bhx, d.bhy, d.bhz, d.count);
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  totalMs += ms; totalBoxes += d.count;
  let nan = 0, sum = 0, exposed = 0;
  const hist = [0, 0, 0, 0, 0]; // [0], (0,.33), [.33,.66), [.66,1), [1+]
  for (const v of r.exposure) {
    if (Number.isNaN(v)) nan++;
    sum += v;
    if (v === 0) { exposed++; hist[0]++; }
    else if (v >= 1) hist[4]++;
    else hist[1 + Math.min(2, Math.floor(v * 3))]++;
  }
  rows.push({
    district: d.name, boxes: d.count, ms: Math.round(ms),
    'interior%': r.interiorPct, 'partial%': r.partialPct,
    'exposed%': Math.round(100 * exposed / (d.count * 4)),
    mean: (sum / (d.count * 4)).toFixed(3), nan,
    hist: hist.map((h) => Math.round(100 * h / (d.count * 4))).join('/'),
  });
}
console.table(rows);
console.log(`total: ${totalBoxes} boxes, ${Math.round(totalMs)}ms (hist = %0 / low / mid / high / interior)`);
