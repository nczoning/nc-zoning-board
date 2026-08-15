#!/usr/bin/env node
/**
 * cull_hidden.js: the removal half of the surface method. Keeps only slabs
 * that can be SEEN: reachable by at least one unobstructed ray from a face
 * sample point to open sky. Everything else (module seam caps, furnished
 * interiors, under-floor cavities) is real geometry the game hides, and the
 * map must hide too.
 *
 * Principle: faithful first, remove-unseeable second, and the test is
 * WORLD-SPACE and cross-placement: a cap is hidden by its neighbour module,
 * an armchair by the four walls around it. Nothing per-asset can know that.
 * Bias errs toward KEEPING: a wrongly culled exterior slab is a hole, a
 * wrongly kept hidden slab is only noise; any escaping ray keeps the slab.
 *
 * Method per slab: sample points on both major faces (count scales with
 * area), nudged 5 cm off the surface. A sample INSIDE another slab is dead
 * (flush cover, the seam-cap case). Live samples cast rays over an
 * upper-hemisphere direction set (map cameras never go below grade); rays
 * walk a uniform world grid (3D-DDA) and test oriented slabs per cell. A
 * ray that leaves the world bounds without a hit is an escape.
 *
 * Usage: node scripts/cull_hidden.js <district> [--cell 8] [--maxsamples 5]
 * Reads/writes data/district-hull-<district>.bin (+ .json bookkeeping).
 */
'use strict';

const fs = require('fs');
const path = require('path');

const args = process.argv.slice(2);
const name = args[0];
const flag = (k, d) => { const i = args.indexOf(`--${k}`); return i > 0 ? Number(args[i + 1]) : d; };
const CELL = flag('cell', 8);          // metres: uniform grid cell
const MAX_S = flag('maxsamples', 5);   // per face, scaled by area
const EPS = 0.05;                      // metres: sample nudge off the face

if (!name) { console.error('usage: node scripts/cull_hidden.js <district>'); process.exit(1); }

const dataDir = path.join(__dirname, '..', 'data');
const raw = fs.readFileSync(path.join(dataDir, `district-hull-${name}.bin`));
const A = new Float32Array(raw.buffer, raw.byteOffset, raw.length / 4);
const n = A.length / 10;
console.log(`${name}: ${n.toLocaleString()} slabs in`);

const quatToMat = (qx, qy, qz, qw) => [
  1 - 2 * (qy * qy + qz * qz), 2 * (qx * qy - qz * qw), 2 * (qx * qz + qy * qw),
  2 * (qx * qy + qz * qw), 1 - 2 * (qx * qx + qz * qz), 2 * (qy * qz - qx * qw),
  2 * (qx * qz - qy * qw), 2 * (qy * qz + qx * qw), 1 - 2 * (qx * qx + qy * qy),
];

// Per-slab world data: rotation matrix + AABB.
const mats = new Float64Array(n * 9);
let wx0 = Infinity, wy0 = Infinity, wz0 = Infinity, wx1 = -Infinity, wy1 = -Infinity, wz1 = -Infinity;
const aabb = new Float64Array(n * 6);
for (let i = 0; i < n; i++) {
  const o = i * 10;
  const m = quatToMat(A[o + 6], A[o + 7], A[o + 8], A[o + 9]);
  for (let k = 0; k < 9; k++) mats[i * 9 + k] = m[k];
  const rx = Math.abs(m[0]) * A[o + 3] + Math.abs(m[1]) * A[o + 4] + Math.abs(m[2]) * A[o + 5];
  const ry = Math.abs(m[3]) * A[o + 3] + Math.abs(m[4]) * A[o + 4] + Math.abs(m[5]) * A[o + 5];
  const rz = Math.abs(m[6]) * A[o + 3] + Math.abs(m[7]) * A[o + 4] + Math.abs(m[8]) * A[o + 5];
  aabb[i * 6] = A[o] - rx; aabb[i * 6 + 1] = A[o] + rx;
  aabb[i * 6 + 2] = A[o + 1] - ry; aabb[i * 6 + 3] = A[o + 1] + ry;
  aabb[i * 6 + 4] = A[o + 2] - rz; aabb[i * 6 + 5] = A[o + 2] + rz;
  if (aabb[i * 6] < wx0) wx0 = aabb[i * 6]; if (aabb[i * 6 + 1] > wx1) wx1 = aabb[i * 6 + 1];
  if (aabb[i * 6 + 2] < wy0) wy0 = aabb[i * 6 + 2]; if (aabb[i * 6 + 3] > wy1) wy1 = aabb[i * 6 + 3];
  if (aabb[i * 6 + 4] < wz0) wz0 = aabb[i * 6 + 4]; if (aabb[i * 6 + 5] > wz1) wz1 = aabb[i * 6 + 5];
}
const nx = Math.max(1, Math.ceil((wx1 - wx0) / CELL));
const ny = Math.max(1, Math.ceil((wy1 - wy0) / CELL));
const nz = Math.max(1, Math.ceil((wz1 - wz0) / CELL));
console.log(`  grid ${nx}x${ny}x${nz} @ ${CELL} m`);

// Cell lists via counting sort (typed arrays, no per-cell array objects).
const cellOfIdx = (cx, cy, cz) => (cz * ny + cy) * nx + cx;
const nCells = nx * ny * nz;
const counts = new Int32Array(nCells + 1);
const spanOf = i => {
  const cx0 = Math.max(0, Math.floor((aabb[i * 6] - wx0) / CELL));
  const cx1 = Math.min(nx - 1, Math.floor((aabb[i * 6 + 1] - wx0) / CELL));
  const cy0 = Math.max(0, Math.floor((aabb[i * 6 + 2] - wy0) / CELL));
  const cy1 = Math.min(ny - 1, Math.floor((aabb[i * 6 + 3] - wy0) / CELL));
  const cz0 = Math.max(0, Math.floor((aabb[i * 6 + 4] - wz0) / CELL));
  const cz1 = Math.min(nz - 1, Math.floor((aabb[i * 6 + 5] - wz0) / CELL));
  return [cx0, cx1, cy0, cy1, cz0, cz1];
};
for (let i = 0; i < n; i++) {
  const [cx0, cx1, cy0, cy1, cz0, cz1] = spanOf(i);
  for (let cz = cz0; cz <= cz1; cz++) for (let cy = cy0; cy <= cy1; cy++) for (let cx = cx0; cx <= cx1; cx++)
    counts[cellOfIdx(cx, cy, cz) + 1]++;
}
for (let c = 0; c < nCells; c++) counts[c + 1] += counts[c];
const entries = new Int32Array(counts[nCells]);
const cursor = counts.slice(0, nCells);
for (let i = 0; i < n; i++) {
  const [cx0, cx1, cy0, cy1, cz0, cz1] = spanOf(i);
  for (let cz = cz0; cz <= cz1; cz++) for (let cy = cy0; cy <= cy1; cy++) for (let cx = cx0; cx <= cx1; cx++)
    entries[cursor[cellOfIdx(cx, cy, cz)]++] = i;
}
console.log(`  ${entries.length.toLocaleString()} cell entries`);

// Point-in-slab and ray-vs-slab in the box frame.
const stamp = new Int32Array(n);
let stampGen = 0;
function pointInAny(px, py, pz, self) {
  const cx = Math.floor((px - wx0) / CELL), cy = Math.floor((py - wy0) / CELL), cz = Math.floor((pz - wz0) / CELL);
  if (cx < 0 || cy < 0 || cz < 0 || cx >= nx || cy >= ny || cz >= nz) return false;
  const c = cellOfIdx(cx, cy, cz);
  for (let e = counts[c]; e < counts[c + 1]; e++) {
    const i = entries[e];
    if (i === self) continue;
    if (px < aabb[i * 6] || px > aabb[i * 6 + 1] || py < aabb[i * 6 + 2] || py > aabb[i * 6 + 3] ||
        pz < aabb[i * 6 + 4] || pz > aabb[i * 6 + 5]) continue;
    const o = i * 10, m9 = i * 9;
    const dx = px - A[o], dy = py - A[o + 1], dz = pz - A[o + 2];
    const bx = mats[m9] * dx + mats[m9 + 3] * dy + mats[m9 + 6] * dz;
    if (Math.abs(bx) > A[o + 3]) continue;
    const by = mats[m9 + 1] * dx + mats[m9 + 4] * dy + mats[m9 + 7] * dz;
    if (Math.abs(by) > A[o + 4]) continue;
    const bz = mats[m9 + 2] * dx + mats[m9 + 5] * dy + mats[m9 + 8] * dz;
    if (Math.abs(bz) > A[o + 5]) continue;
    return true;
  }
  return false;
}
function raySlab(i, ox, oy, oz, dx, dy, dz) {
  // Slab-method intersection in the box frame; returns entry t or Infinity.
  const o = i * 10, m9 = i * 9;
  const px = ox - A[o], py = oy - A[o + 1], pz = oz - A[o + 2];
  let t0 = 0, t1 = Infinity;
  for (let ax = 0; ax < 3; ax++) {
    const bo = mats[m9 + ax] * px + mats[m9 + 3 + ax] * py + mats[m9 + 6 + ax] * pz;
    const bd = mats[m9 + ax] * dx + mats[m9 + 3 + ax] * dy + mats[m9 + 6 + ax] * dz;
    const h = A[o + 3 + ax];
    if (Math.abs(bd) < 1e-12) { if (Math.abs(bo) > h) return Infinity; continue; }
    let ta = (-h - bo) / bd, tb = (h - bo) / bd;
    if (ta > tb) { const tmp = ta; ta = tb; tb = tmp; }
    if (ta > t0) t0 = ta;
    if (tb < t1) t1 = tb;
    if (t0 > t1) return Infinity;
  }
  return t0 > 1e-4 ? t0 : (t1 > 1e-4 ? 0 : Infinity);   // 0 = starts inside
}
function rayEscapes(ox, oy, oz, dx, dy, dz, self) {
  stampGen++;
  // 3D-DDA over the cell grid.
  let cx = Math.floor((ox - wx0) / CELL), cy = Math.floor((oy - wy0) / CELL), cz = Math.floor((oz - wz0) / CELL);
  if (cx < 0 || cy < 0 || cz < 0 || cx >= nx || cy >= ny || cz >= nz) return true;
  const sx = dx > 0 ? 1 : -1, sy = dy > 0 ? 1 : -1, sz = dz > 0 ? 1 : -1;
  const inf = Infinity;
  let tMaxX = Math.abs(dx) < 1e-12 ? inf : (((cx + (dx > 0 ? 1 : 0)) * CELL + wx0) - ox) / dx;
  let tMaxY = Math.abs(dy) < 1e-12 ? inf : (((cy + (dy > 0 ? 1 : 0)) * CELL + wy0) - oy) / dy;
  let tMaxZ = Math.abs(dz) < 1e-12 ? inf : (((cz + (dz > 0 ? 1 : 0)) * CELL + wz0) - oz) / dz;
  const tDx = Math.abs(dx) < 1e-12 ? inf : Math.abs(CELL / dx);
  const tDy = Math.abs(dy) < 1e-12 ? inf : Math.abs(CELL / dy);
  const tDz = Math.abs(dz) < 1e-12 ? inf : Math.abs(CELL / dz);
  let tCell = 0;
  for (;;) {
    const tExit = Math.min(tMaxX, tMaxY, tMaxZ);
    const c = cellOfIdx(cx, cy, cz);
    for (let e = counts[c]; e < counts[c + 1]; e++) {
      const i = entries[e];
      if (i === self || stamp[i] === stampGen) continue;
      stamp[i] = stampGen;
      const t = raySlab(i, ox, oy, oz, dx, dy, dz);
      if (t < tExit + 1e-6) return false;   // hit inside or before leaving this cell span
    }
    if (tMaxX <= tMaxY && tMaxX <= tMaxZ) { cx += sx; tCell = tMaxX; tMaxX += tDx; }
    else if (tMaxY <= tMaxZ) { cy += sy; tCell = tMaxY; tMaxY += tDy; }
    else { cz += sz; tCell = tMaxZ; tMaxZ += tDz; }
    if (cx < 0 || cy < 0 || cz < 0 || cx >= nx || cy >= ny || cz >= nz) return true;
  }
}

// Upper-hemisphere direction set: straight up + four 30-degree-elevation
// diagonals; each face also casts its outward normal tilted up unless the
// normal points downward.
const E = Math.sin(Math.PI / 6), C = Math.cos(Math.PI / 6);
const DIRS = [
  [0, 0, 1],
  [C * 0.7071, C * 0.7071, E], [-C * 0.7071, C * 0.7071, E],
  [C * 0.7071, -C * 0.7071, E], [-C * 0.7071, -C * 0.7071, E],
];

const keep = new Uint8Array(n);
let done = 0;
const t0 = Date.now();
for (let i = 0; i < n; i++) {
  const o = i * 10, m9 = i * 9;
  const hu = A[o + 3], hv = A[o + 4], hn = A[o + 5];
  // Face sample offsets in the box frame (u,v on the +/-n faces).
  const su = Math.min(MAX_S, Math.max(1, Math.round(hu)));
  const sv = Math.min(MAX_S, Math.max(1, Math.round(hv)));
  let visible = false;
  for (let side = -1; side <= 1 && !visible; side += 2) {
    // Outward normal of this face in world space.
    const nwx = mats[m9 + 2] * side, nwy = mats[m9 + 5] * side, nwz = mats[m9 + 8] * side;
    for (let a = 0; a < su && !visible; a++) for (let b = 0; b < sv && !visible; b++) {
      const fu = su === 1 ? 0 : (a / (su - 1) - 0.5) * 2 * hu * 0.8;
      const fv = sv === 1 ? 0 : (b / (sv - 1) - 0.5) * 2 * hv * 0.8;
      const off = hn + EPS;
      const px = A[o] + mats[m9] * fu + mats[m9 + 1] * fv + mats[m9 + 2] * side * off;
      const py = A[o + 1] + mats[m9 + 3] * fu + mats[m9 + 4] * fv + mats[m9 + 5] * side * off;
      const pz = A[o + 2] + mats[m9 + 6] * fu + mats[m9 + 7] * fv + mats[m9 + 8] * side * off;
      if (pointInAny(px, py, pz, i)) continue;   // flush-covered (seam cap)
      for (const [dx, dy, dz] of DIRS) {
        if (rayEscapes(px, py, pz, dx, dy, dz, i)) { visible = true; break; }
      }
      if (!visible && nwz > -0.2) {
        // Outward normal tilted 20 degrees up.
        const l = Math.hypot(nwx, nwy, nwz + 0.36) || 1;
        if (rayEscapes(px, py, pz, nwx / l, nwy / l, (nwz + 0.36) / l, i)) visible = true;
      }
    }
  }
  keep[i] = visible ? 1 : 0;
  if (++done % 100000 === 0) {
    const rate = done / ((Date.now() - t0) / 1000);
    console.log(`  ${done.toLocaleString()} / ${n.toLocaleString()} (${Math.round(rate).toLocaleString()}/s)`);
  }
}

let kept = 0;
for (let i = 0; i < n; i++) if (keep[i]) kept++;
const out = new Float32Array(kept * 10);
let w = 0;
for (let i = 0; i < n; i++) {
  if (!keep[i]) continue;
  out.set(A.subarray(i * 10, i * 10 + 10), w);
  w += 10;
}
fs.writeFileSync(path.join(dataDir, `district-hull-${name}.bin`), Buffer.from(out.buffer));
const jf = path.join(dataDir, `district-hull-${name}.json`);
const hj = JSON.parse(fs.readFileSync(jf, 'utf8'));
hj.boxes = kept;
hj.cullHidden = { in: n, kept, cell: CELL, maxSamples: MAX_S, dirs: DIRS.length + 1 };
fs.writeFileSync(jf, JSON.stringify(hj, null, 2));
console.log(`  CULLED ${n.toLocaleString()} -> ${kept.toLocaleString()} visible slabs (${(100 * kept / n).toFixed(1)}%), ${((Date.now() - t0) / 60000).toFixed(1)} min`);
