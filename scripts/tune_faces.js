/**
 * scripts/tune_faces.js
 * ─────────────────────────────────────────────────────────────────────────
 * Headless validation of computeFaceOccluders() — the exterior-face occlusion
 * precompute (see three-scene.js). Lifts the function VERBATIM from the live
 * source (anti-drift, same pattern as tune_lib's segmentBuildings), runs it
 * over every district's decoded box set, and emulates the shader's
 * per-fragment gate at sample points to verify the geometry cases that
 * matter:
 *   - isolated box        → every wall point lit
 *   - stacked pair        → wall lit above the shorter neighbour, dark beside it
 *   - floating ledge      → wall lit above AND below a mid-wall greeble
 *   - interpenetrating slabs → wall lit exactly where it pokes past a sibling
 *
 * tune_lib's decode only keeps AABBs, so this script re-decodes with the full
 * per-box T·R·S matrices (the harness convention).
 *
 * Run: node scripts/tune_faces.js
 */
'use strict';

const path = require('path');
const { ROOT, NCZ, DISTRICTS, SCENE, sliceBalanced, loadDataDds } = require('./tune_lib');

// ── lift computeFaceOccluders verbatim ───────────────────────────────────────
const faceSrc = sliceBalanced(SCENE, 'function computeFaceOccluders', '{', '}');
// eslint-disable-next-line no-eval
const computeFaceOccluders = eval(`(${faceSrc})`);

// ── shader-gate emulator ─────────────────────────────────────────────────────
// Mirrors the TSL gate: probe = worldPos + FACE_EPS·normal; dark if the probe
// is inside any of the box's 4 occluders (unit-cube test via inverse matrix).
function gateAt(occ, i, wx, wy, wz, nx, ny, nz) {
  const px = wx + NCZ.FACE_EPS * nx, py = wy + NCZ.FACE_EPS * ny, pz = wz + NCZ.FACE_EPS * nz;
  for (let s = 0; s < 4; s++) {
    const j = occ.idx[i * 4 + s];
    const b = j * 16, m = occ.inv;
    const lx = m[b] * px + m[b + 4] * py + m[b + 8] * pz + m[b + 12];
    const ly = m[b + 1] * px + m[b + 5] * py + m[b + 9] * pz + m[b + 13];
    const lz = m[b + 2] * px + m[b + 6] * py + m[b + 10] * pz + m[b + 14];
    if (Math.max(Math.abs(lx), Math.abs(ly), Math.abs(lz)) < 0.5) return 0;
  }
  return 1;
}

// Axis-aligned test rigs: boxes given as [cx, cy, cz, hx, hy, hz].
function rig(boxes) {
  const n = boxes.length;
  const M = new Float32Array(n * 16);
  const cx = new Float32Array(n), cy = new Float32Array(n), cz = new Float32Array(n);
  const hx = new Float32Array(n), hy = new Float32Array(n), hz = new Float32Array(n);
  boxes.forEach(([x, y, z, a, b2, c], i) => {
    const b = i * 16;
    M[b] = a * 2; M[b + 5] = b2 * 2; M[b + 10] = c * 2;
    M[b + 12] = x; M[b + 13] = y; M[b + 14] = z; M[b + 15] = 1;
    cx[i] = x; cy[i] = y; cz[i] = z; hx[i] = a; hy[i] = b2; hz[i] = c;
  });
  return { occ: computeFaceOccluders(M, cx, cy, cz, hx, hy, hz, n) };
}

console.log('computeFaceOccluders — headless validation\n');

{ // isolated box 20×60×30 at origin: every wall point lit
  const { occ } = rig([[0, 30, 0, 10, 30, 15]]);
  const pts = [[10, 5, 0], [10, 55, 0], [-10, 30, 10], [0, 30, 15], [0, 5, -15]];
  const lit = pts.map(([x, y, z]) => gateAt(occ, 0, x, y, z, Math.sign(x) * (Math.abs(x) === 10 ? 1 : 0), 0, Math.sign(z) * (Math.abs(z) === 15 ? 1 : 0)));
  console.log(`isolated box: ${lit.every((v) => v === 1) ? 'PASS' : 'FAIL'} (all wall points lit) → [${lit.join(',')}]`);
}

{ // stacked pair: 30-tall box pressed on the +X face of a 60-tall box
  const { occ } = rig([[0, 30, 0, 10, 30, 15], [20, 15, 0, 10, 15, 15]]);
  const below = gateAt(occ, 0, 10, 15, 0, 1, 0, 0);  // beside the neighbour → dark
  const above = gateAt(occ, 0, 10, 45, 0, 1, 0, 0);  // above its roof → lit
  console.log(`stacked pair: ${below === 0 && above === 1 ? 'PASS' : 'FAIL'} (dark beside, lit above) → below=${below} above=${above}`);
}

{ // floating ledge: small box at 60–80% height on the +X face
  const { occ } = rig([[0, 30, 0, 10, 30, 15], [13, 42, 0, 3, 6, 15]]);
  const under = gateAt(occ, 0, 10, 20, 0, 1, 0, 0);   // open wall under the ledge → lit
  const behind = gateAt(occ, 0, 10, 42, 0, 1, 0, 0);  // behind the ledge → dark
  const over = gateAt(occ, 0, 10, 55, 0, 1, 0, 0);    // above it → lit
  console.log(`floating ledge: ${under === 1 && behind === 0 && over === 1 ? 'PASS' : 'FAIL'} (lit/dark/lit) → ${under}/${behind}/${over}`);
}

{ // interpenetrating slabs: A 100 wide, sibling B 80 wide overlapping same level
  const { occ } = rig([[0, 10, 0, 50, 10, 30], [0, 12, 0, 40, 12, 28]]);
  const poke = gateAt(occ, 0, 45, 10, 30, 0, 0, 1);   // A's +Z face where it pokes past B → lit
  const covered = gateAt(occ, 0, 0, 10, 30, 0, 0, 1); // A's +Z face centre, B is 2 CET proud → dark? B half z 28 < A 30, so B is BEHIND A's face → lit
  const insideB = gateAt(occ, 1, 0, 12, 28, 0, 0, 1); // B's +Z face centre sits INSIDE A → dark
  console.log(`interpenetrating slabs: ${poke === 1 && covered === 1 && insideB === 0 ? 'PASS' : 'FAIL'} (poke lit, outer face lit, inner face dark) → ${poke}/${covered}/${insideB}`);
}

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

// ── district stats ───────────────────────────────────────────────────────────
// litSample: emulate the gate at each box's 4 face centres and report the lit
// share among boxes poking above grade — the "visible wall points" proxy.
console.log('');
const rows = [];
let totalMs = 0, totalBoxes = 0;
for (const meta of DISTRICTS) {
  let d;
  try { d = decodeDistrictMatrices(meta); } catch { continue; }
  if (!d.count) continue;
  const t0 = process.hrtime.bigint();
  const occ = computeFaceOccluders(d.matrixData, d.bcx, d.bcy, d.bcz, d.bhx, d.bhy, d.bhz, d.count);
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  totalMs += ms; totalBoxes += d.count;
  let lit = 0, samples = 0, nan = 0;
  for (let i = 0; i < d.count; i += 7) {          // sample every 7th box
    if (d.bcy[i] + d.bhy[i] < 10) continue;        // above-grade boxes only
    const b = i * 16, e = d.matrixData;
    for (let f = 0; f < 4; f++) {
      const axC = f < 2 ? 0 : 8, sgn = (f % 2 === 0) ? 1 : -1;
      const ax = [e[b + axC], e[b + axC + 1], e[b + axC + 2]];
      const al = Math.hypot(ax[0], ax[1], ax[2]) || 1;
      const wx = e[b + 12] + sgn * 0.5 * ax[0], wy = e[b + 13] + sgn * 0.5 * ax[1], wz = e[b + 14] + sgn * 0.5 * ax[2];
      const g = gateAt(occ, i, wx, wy, wz, sgn * ax[0] / al, sgn * ax[1] / al, sgn * ax[2] / al);
      if (Number.isNaN(g)) nan++;
      lit += g; samples++;
    }
  }
  rows.push({
    district: d.name, boxes: d.count, ms: Math.round(ms),
    'occluded%': occ.occludedPct,
    'faceCentresLit%': samples ? Math.round(100 * lit / samples) : 0,
    nan,
  });
}
console.table(rows);
console.log(`total: ${totalBoxes} boxes, ${Math.round(totalMs)}ms`);
