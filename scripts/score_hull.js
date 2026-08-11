#!/usr/bin/env node
/**
 * score_hull.js: grade a box cloud against the game's real windows.
 *
 * A box cloud is right when the game's own windows land on its faces. This
 * measures that for one district, identically for any cloud, so a rebuilt hull
 * and CDPR's shipped cloud can be compared on the same windows with the same
 * test:
 *
 *   node scripts/score_hull.js city_center --cloud cdpr
 *   node scripts/score_hull.js city_center --cloud hull
 *
 * The metric is the distance from each window to the nearest box SURFACE, and
 * the depth of those that fall inside a box. A correct cloud puts windows on
 * its skin: distance near zero, depth near zero. A cloud that is too fat
 * swallows them, which shows up as depth rather than as distance.
 *
 * Windows come from data/window-debug-fixed.bin, the 1.5M real window
 * positions already baked by window_faces.js. That file is THREE space:
 * CET (x, y, z) was written as (x, z, -y), so it is read back the same way.
 *
 * This deliberately does NOT reuse window_faces.js. That script bakes the
 * shipping asset and answers a different question (how to ENCODE the windows);
 * this one only has to produce one comparable number per cloud.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const args = process.argv.slice(2);
const name = args[0];
const CLOUD = (i => i > 0 ? args[i + 1] : 'hull')(args.indexOf('--cloud'));
if (!name) { console.error('usage: node scripts/score_hull.js <district> [--cloud hull|cdpr]'); process.exit(1); }

const dataDir = path.join(__dirname, '..', 'data');
const hullMeta = JSON.parse(fs.readFileSync(path.join(dataDir, `district-boxes-${name}.json`), 'utf8'));
const bounds = hullMeta.bounds;

// When the cloud was extracted on the district's real boundary, the windows
// have to be judged on that boundary too. Scoring the bbox instead counts the
// corners the district does not cover as misses, which is the neighbouring
// district's geometry being marked absent.
const { districtPolygon, inPolygon } = require('./district_meta');
const polygon = hullMeta.boundary === 'district trigger polygon' ? districtPolygon(name) : null;

// ── the boxes ─────────────────────────────────────────────────────────────
// { c: centre CET, h: half-extent CET, q: orientation CET }
const B = [];
if (CLOUD === 'hull') {
  const raw = fs.readFileSync(path.join(dataDir, `district-hull-${name}.bin`));
  const f = new Float32Array(raw.buffer, raw.byteOffset, raw.length / 4);
  for (let i = 0; i < f.length / 10; i++) {
    const o = i * 10;
    B.push({ c: [f[o], f[o + 1], f[o + 2]], h: [f[o + 3], f[o + 4], f[o + 5]], q: [f[o + 6], f[o + 7], f[o + 8], f[o + 9]] });
  }
} else {
  // CDPR's shipped texture, decoded exactly as loadBuildings does but kept in
  // CET rather than remapped to THREE.
  const META = require('./district_meta').DISTRICTS[name];
  if (!META) { console.error(`unknown district ${name}`); process.exit(1); }
  const set = (args.includes('--vanilla') || META.noFixed) ? 'assets/dds' : 'assets/dds/fixed';
  const buf = fs.readFileSync(path.join(__dirname, '..', set, META.dds));
  const hdr = new Uint32Array(buf.buffer, buf.byteOffset, 32);
  const texH = hdr[3], texW = hdr[4], blockW = texW / 3;
  const px = new Uint16Array(buf.buffer, buf.byteOffset + 148, (buf.length - 148) / 2);
  const U16 = 65535, ALPHA = 655;
  for (let y = 0; y < texH; y++) {
    for (let x = 0; x < blockW; x++) {
      const pi = (y * texW + x) * 4, ri = (y * texW + x + blockW) * 4, si = (y * texW + x + 2 * blockW) * 4;
      if (px[pi + 3] < ALPHA) continue;
      if (px[si] < ALPHA && px[si + 1] < ALPHA && px[si + 2] < ALPHA) continue;
      const c = [
        META.transMin[0] + (META.transMax[0] - META.transMin[0]) * (px[pi] / U16) + META.offset[0],
        META.transMin[1] + (META.transMax[1] - META.transMin[1]) * (px[pi + 1] / U16) + META.offset[1],
        META.transMin[2] + (META.transMax[2] - META.transMin[2]) * (px[pi + 2] / U16),
      ];
      let q = [px[ri] / U16 * 2 - 1, px[ri + 1] / U16 * 2 - 1, px[ri + 2] / U16 * 2 - 1, px[ri + 3] / U16 * 2 - 1];
      const ql = Math.hypot(q[0], q[1], q[2], q[3]) || 1;
      q = [q[0] / ql, q[1] / ql, q[2] / ql, q[3] / ql];
      B.push({ c, h: [px[si] / U16 * META.cubeSize, px[si + 1] / U16 * META.cubeSize, px[si + 2] / U16 * META.cubeSize], q });
    }
  }
}

// Cull to the district footprint so both clouds are judged on the same ground.
const inD = b => b.c[0] >= bounds.min[0] && b.c[0] <= bounds.max[0] && b.c[1] >= bounds.min[1] && b.c[1] <= bounds.max[1]
  && (!polygon || inPolygon(polygon, b.c[0], b.c[1]));
const boxes = B.filter(inD);
console.log(`cloud ${CLOUD}: ${boxes.length.toLocaleString()} boxes inside ${name}`);

// ── spatial hash ──────────────────────────────────────────────────────────
const CELL = 32;
const grid = new Map();
const key = (i, j) => i * 100000 + j;
boxes.forEach((b, n) => {
  const r = Math.hypot(b.h[0], b.h[1], b.h[2]) + 8;
  for (let i = Math.floor((b.c[0] - r) / CELL); i <= Math.floor((b.c[0] + r) / CELL); i++) {
    for (let j = Math.floor((b.c[1] - r) / CELL); j <= Math.floor((b.c[1] + r) / CELL); j++) {
      const k = key(i, j); let a = grid.get(k); if (!a) grid.set(k, a = []); a.push(n);
    }
  }
});

// ── the windows ───────────────────────────────────────────────────────────
const wraw = fs.readFileSync(path.join(dataDir, 'window-debug-fixed.bin'));
const n = JSON.parse(fs.readFileSync(path.join(dataDir, 'window-debug-fixed.json'), 'utf8')).count;
const xyz = new Float32Array(wraw.buffer, wraw.byteOffset, n * 3);

/** Rotate v by the conjugate of q: world offset into the box's own frame. */
function toBox(v, q) {
  const [x, y, z, w] = [-q[0], -q[1], -q[2], q[3]];
  const tx = 2 * (y * v[2] - z * v[1]), ty = 2 * (z * v[0] - x * v[2]), tz = 2 * (x * v[1] - y * v[0]);
  return [v[0] + w * tx + (y * tz - z * ty), v[1] + w * ty + (z * tx - x * tz), v[2] + w * tz + (x * ty - y * tx)];
}

// ── the occupancy grid, when the hull run published one ──────────────────
// Depth alone does not mean the cloud is wrong. Some of the game's glass is
// genuinely interior: partitions, atrium walls, glass deep inside a mass that
// no exterior face could ever carry. Some of it is recessed facade, light well
// or courtyard glass that IS visible from outside and should land on a face.
//
// The grid separates them by asking a question about the real geometry rather
// than about either cloud: march out from the window along each axis and find
// the distance to open air.
//
//   air within REACH_AIR  -> the window sits on a real exterior surface, so a
//                            cloud that buries it has a box too fat there.
//                            THE CLOUD IS AT FAULT.
//   no air within REACH   -> genuinely interior glass. No exterior face can
//                            carry it, so no cloud can be blamed for it.
//
// CAVEAT when judging the rebuilt cloud with this: the grid and the boxes come
// from the same voxelisation, so a window buried in the grid is buried in the
// boxes almost by construction, and the "excusable" bucket flatters the
// rebuild. Against CDPR's texture the test is independent and the number
// stands on its own.
let vox = null;
try {
  const hm = JSON.parse(fs.readFileSync(path.join(dataDir, `district-hull-${name}.json`), 'utf8'));
  const bits = fs.readFileSync(path.join(dataDir, `district-grid-${name}.bin`));
  vox = {
    bits: new Uint8Array(bits.buffer, bits.byteOffset, bits.length),
    nx: hm.grid.nx, ny: hm.grid.ny, nz: hm.grid.nz,
    o: hm.gridOrigin, v: hm.voxel,
  };
  vox.get = (x, y, z) => {
    if (x < 0 || y < 0 || z < 0 || x >= vox.nx || y >= vox.ny || z >= vox.nz) return 0;
    const k = (z * vox.ny + y) * vox.nx + x;
    return (vox.bits[k >> 3] >> (k & 7)) & 1;
  };
} catch (e) { /* no vox published: depth is reported without a visibility split */ }

const REACH = 24;     // metres of marching before the search gives up
const REACH_AIR = 4;  // air this close means the window is on a real exterior surface

/** Metres from a world point to open air along the nearest axis, or Infinity. */
function escapeDistance(cx, cy, cz) {
  const gx = Math.floor((cx - vox.o[0]) / vox.v);
  const gy = Math.floor((cy - vox.o[1]) / vox.v);
  const gz = Math.floor((cz - vox.o[2]) / vox.v);
  if (!vox.get(gx, gy, gz)) return 0;
  const steps = Math.ceil(REACH / vox.v);
  const dirs = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]];
  let best = Infinity;
  for (const [dx, dy, dz] of dirs) {
    for (let s = 1; s <= steps; s++) {
      if (s * vox.v >= best) break;
      if (!vox.get(gx + dx * s, gy + dy * s, gz + dz * s)) { best = s * vox.v; break; }
    }
  }
  return best;
}

const MARGINS = [0.5, 1, 2, 4, 8];
const landed = new Array(MARGINS.length).fill(0);
const depths = [];
let scored = 0, noBox = 0;
let cloudFault = 0, trulyInterior = 0;
const escapes = [];

for (let i = 0; i < n; i++) {
  // THREE (x, y, z) was written from CET (x, z, -y), so invert it.
  const cx = xyz[i * 3], cy = -xyz[i * 3 + 2], cz = xyz[i * 3 + 1];
  if (cx < bounds.min[0] || cx > bounds.max[0] || cy < bounds.min[1] || cy > bounds.max[1]) continue;
  if (polygon && !inPolygon(polygon, cx, cy)) continue;
  scored++;

  let best = Infinity, bestDepth = null;
  const gi = Math.floor(cx / CELL), gj = Math.floor(cy / CELL);
  for (let di = -1; di <= 1; di++) {
    for (let dj = -1; dj <= 1; dj++) {
      const a = grid.get(key(gi + di, gj + dj));
      if (!a) continue;
      for (const bi of a) {
        const b = boxes[bi];
        const l = toBox([cx - b.c[0], cy - b.c[1], cz - b.c[2]], b.q);
        const ox = Math.abs(l[0]) - b.h[0], oy = Math.abs(l[1]) - b.h[1], oz = Math.abs(l[2]) - b.h[2];
        let d;
        if (ox <= 0 && oy <= 0 && oz <= 0) {
          // Inside: distance to the nearest face, and that is also the depth.
          d = Math.min(-ox, -oy, -oz);
          if (d < best) { best = d; bestDepth = d; }
          continue;
        }
        d = Math.hypot(Math.max(ox, 0), Math.max(oy, 0), Math.max(oz, 0));
        if (d < best) { best = d; bestDepth = null; }
      }
    }
  }
  if (!isFinite(best)) { noBox++; continue; }
  for (let m = 0; m < MARGINS.length; m++) if (best <= MARGINS[m]) landed[m]++;
  if (bestDepth !== null) {
    depths.push(bestDepth);
    // Only windows the surface test already failed are worth asking about.
    if (vox && bestDepth > 2) {
      const esc = escapeDistance(cx, cy, cz);
      escapes.push(isFinite(esc) ? esc : REACH);
      if (esc <= REACH_AIR) cloudFault++; else trulyInterior++;
    }
  }
}

depths.sort((a, b) => a - b);
const pct = p => depths.length ? depths[Math.floor(depths.length * p)].toFixed(2) : 'n/a';

console.log(`windows in footprint: ${scored.toLocaleString()}   no box near: ${noBox.toLocaleString()} (${(100 * noBox / scored).toFixed(1)}%)`);
console.log('\ndistance from the window to the nearest box surface:');
MARGINS.forEach((m, i) => console.log(`  within ${String(m).padStart(4)} m   ${(100 * landed[i] / scored).toFixed(1).padStart(5)}%   ${landed[i].toLocaleString()}`));
console.log(`\ninside a box: ${depths.length.toLocaleString()} (${(100 * depths.length / scored).toFixed(1)}%)`);
console.log(`  depth p50 ${pct(0.5)} m   p90 ${pct(0.9)} m   p99 ${pct(0.99)} m`);

if (vox) {
  const deep = cloudFault + trulyInterior;
  escapes.sort((a, b) => a - b);
  const ep = p => escapes.length ? escapes[Math.floor(escapes.length * p)].toFixed(1) : 'n/a';
  console.log(`\nof the ${deep.toLocaleString()} windows more than 2 m inside a box:`);
  console.log(`  ${cloudFault.toLocaleString()} (${(100 * cloudFault / deep).toFixed(1)}%) have open air within ${REACH_AIR} m in the real geometry:`);
  console.log(`      real exterior glass, swallowed by a box that is too fat. THE CLOUD IS AT FAULT.`);
  console.log(`      = ${(100 * cloudFault / scored).toFixed(1)}% of every window in the district`);
  console.log(`  ${trulyInterior.toLocaleString()} (${(100 * trulyInterior / deep).toFixed(1)}%) do not: genuinely interior glass, which no exterior face can carry.`);
  console.log(`  distance to air: p50 ${ep(0.5)} m   p90 ${ep(0.9)} m   (capped at ${REACH} m)`);
  if (CLOUD === 'hull') console.log(`  NOTE: grid and boxes share a voxelisation, so the interior bucket flatters this cloud.`);
}
