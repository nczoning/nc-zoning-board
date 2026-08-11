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
  const META = {
    city_center: { transMin: [-770.609192, -530.549133, -40.6581497], transMax: [1316.82483, 649.75531, 642.893127], offset: [-2116.637, 106.508], cubeSize: 168.289993, dds: 'city_center_data.dds' },
  }[name];
  if (!META) { console.error(`no CDPR texture mapping for ${name}`); process.exit(1); }
  const set = args.includes('--vanilla') ? 'assets/dds' : 'assets/dds/fixed';
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
const inD = b => b.c[0] >= bounds.min[0] && b.c[0] <= bounds.max[0] && b.c[1] >= bounds.min[1] && b.c[1] <= bounds.max[1];
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

const MARGINS = [0.5, 1, 2, 4, 8];
const landed = new Array(MARGINS.length).fill(0);
const depths = [];
let scored = 0, noBox = 0;

for (let i = 0; i < n; i++) {
  // THREE (x, y, z) was written from CET (x, z, -y), so invert it.
  const cx = xyz[i * 3], cy = -xyz[i * 3 + 2], cz = xyz[i * 3 + 1];
  if (cx < bounds.min[0] || cx > bounds.max[0] || cy < bounds.min[1] || cy > bounds.max[1]) continue;
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
  if (bestDepth !== null) depths.push(bestDepth);
}

depths.sort((a, b) => a - b);
const pct = p => depths.length ? depths[Math.floor(depths.length * p)].toFixed(2) : 'n/a';

console.log(`windows in footprint: ${scored.toLocaleString()}   no box near: ${noBox.toLocaleString()} (${(100 * noBox / scored).toFixed(1)}%)`);
console.log('\ndistance from the window to the nearest box surface:');
MARGINS.forEach((m, i) => console.log(`  within ${String(m).padStart(4)} m   ${(100 * landed[i] / scored).toFixed(1).padStart(5)}%   ${landed[i].toLocaleString()}`));
console.log(`\ninside a box: ${depths.length.toLocaleString()} (${(100 * depths.length / scored).toFixed(1)}%)`);
console.log(`  depth p50 ${pct(0.5)} m   p90 ${pct(0.9)} m   p99 ${pct(0.99)} m`);
