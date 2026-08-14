#!/usr/bin/env node
/**
 * raw_hull.js: the zero-loss cloud. Every building placement's own oriented
 * box, straight from stage 1. No voxels, no merge, no grouping: nothing is
 * approximated, so nothing can step and nothing can be dropped.
 *
 * This exists as the DIAGNOSTIC endpoint of the generator family. Every other
 * generator approximates, and three of them have now been accused of holes by
 * the render. If holes survive a cloud that contains every placement at its
 * exact transform, the holes are not in any generator: they are in the data
 * (an asset with no bounds), the encoder, or the renderer, and the hunt moves
 * there with the geometry ruled out.
 *
 * Proxies keep the usual rule: emitted only where the placements left the
 * space uncovered, because a proxy's box double-counts the towers it stands
 * in for.
 *
 * Usage: node scripts/raw_hull.js <district> [--minsize 0.3]
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { categorize } = require('./asset_category');
const { loadTerrain, indexTris, heightAtCet } = require('./terrain_lib');

const args = process.argv.slice(2);
const name = args[0];
const flag = (k, d) => { const i = args.indexOf(`--${k}`); return i > 0 ? Number(args[i + 1]) : d; };

const MIN_SIZE = flag('minsize', 0.3);
const MAX_SIZE = flag('maxsize', 1000);
const PROXY_MAX = flag('proxymax', 450);
const PROXY_COVER = flag('proxycover', 0.25);
const BELOW = flag('below', 16);

if (!name) { console.error('usage: node scripts/raw_hull.js <district>'); process.exit(1); }

const dataDir = path.join(__dirname, '..', 'data');
const meta = JSON.parse(fs.readFileSync(path.join(dataDir, `district-boxes-${name}.json`), 'utf8'));
const raw = fs.readFileSync(path.join(dataDir, `district-boxes-${name}.bin`));
const box = new Float32Array(raw.buffer, raw.byteOffset, raw.length / 4);
const S = meta.stride, TYPE = meta.types || {}, PATHS = meta.assetPaths || {};

const terrain = indexTris(loadTerrain());
const quatToMat = (qx, qy, qz, qw) => [
  1 - 2 * (qy * qy + qz * qz), 2 * (qx * qy - qz * qw), 2 * (qx * qz + qy * qw),
  2 * (qx * qy + qz * qw), 1 - 2 * (qx * qx + qz * qz), 2 * (qy * qz - qx * qw),
  2 * (qx * qz - qy * qw), 2 * (qy * qz + qx * qw), 1 - 2 * (qx * qx + qy * qy),
];

console.log(`district ${name}`);

const out = [];
const proxies = [];
let skippedSmall = 0, skippedHuge = 0, skippedNever = 0, skippedProxy = 0, cutUnder = 0;

function emit(i) {
  const o = i * S;
  const g = heightAtCet(terrain, box[o], box[o + 1]);
  if (g !== null && box[o + 2] + box[o + 5] <= g - BELOW) { cutUnder++; return; }
  out.push({
    c: [box[o], box[o + 1], box[o + 2]],
    h: [box[o + 3], box[o + 4], box[o + 5]],
    q: [box[o + 6], box[o + 7], box[o + 8], box[o + 9]],
  });
}

for (let i = 0; i < meta.boxes; i++) {
  const o = i * S;
  const largest = Math.max(box[o + 3], box[o + 4], box[o + 5]) * 2;
  if (largest < MIN_SIZE) { skippedSmall++; continue; }
  const cat = categorize(PATHS[box[o + 10]] || '', TYPE[box[o + 11]] || '');
  if (cat !== 'building' && cat !== 'proxy') { skippedNever++; continue; }
  if (largest > MAX_SIZE) { skippedHuge++; continue; }
  if (cat === 'proxy') {
    if (largest > PROXY_MAX) { skippedProxy++; continue; }
    proxies.push(i);
    continue;
  }
  emit(i);
}
console.log(`  emitted   ${out.length.toLocaleString()} placement boxes verbatim (${cutUnder.toLocaleString()} buried cut)`);
console.log(`  skipped   ${skippedSmall.toLocaleString()} under ${MIN_SIZE} m, ${skippedHuge.toLocaleString()} over ${MAX_SIZE} m, ` +
            `${skippedNever.toLocaleString()} never-geometry, ${skippedProxy.toLocaleString()} area proxies`);

// Proxy redundancy probe against the emitted boxes.
const CELL = 32;
const hash = new Map();
function indexBox(b, i) {
  const r = Math.hypot(b.h[0], b.h[1]);
  for (let cx = Math.floor((b.c[0] - r) / CELL); cx <= Math.floor((b.c[0] + r) / CELL); cx++)
    for (let cy = Math.floor((b.c[1] - r) / CELL); cy <= Math.floor((b.c[1] + r) / CELL); cy++) {
      const k = `${cx},${cy}`;
      let l = hash.get(k); if (!l) hash.set(k, l = []);
      l.push(i);
    }
}
out.forEach((b, i) => indexBox(b, i));
const mats = out.map(b => quatToMat(b.q[0], b.q[1], b.q[2], b.q[3]));
function insideAny(x, y, z) {
  for (const i of hash.get(`${Math.floor(x / CELL)},${Math.floor(y / CELL)}`) || []) {
    const b = out[i], m = mats[i];
    const dx = x - b.c[0], dy = y - b.c[1], dz = z - b.c[2];
    const bx = m[0] * dx + m[3] * dy + m[6] * dz;
    const by = m[1] * dx + m[4] * dy + m[7] * dz;
    const bz = m[2] * dx + m[5] * dy + m[8] * dz;
    if (Math.abs(bx) <= b.h[0] && Math.abs(by) <= b.h[1] && Math.abs(bz) <= b.h[2]) return true;
  }
  return false;
}

let proxyUsed = 0, proxyCovered = 0;
proxies.sort((a, b) =>
  box[a * S + 3] * box[a * S + 4] * box[a * S + 5] - box[b * S + 3] * box[b * S + 4] * box[b * S + 5]);
for (const i of proxies) {
  const o = i * S;
  const m = quatToMat(box[o + 6], box[o + 7], box[o + 8], box[o + 9]);
  let occ = 0;
  for (let fz = -1; fz <= 1; fz++) for (let fy = -1; fy <= 1; fy++) for (let fx = -1; fx <= 1; fx++) {
    const lx = fx * box[o + 3] * 0.66, ly = fy * box[o + 4] * 0.66, lz = fz * box[o + 5] * 0.66;
    if (insideAny(box[o] + m[0] * lx + m[1] * ly + m[2] * lz,
                  box[o + 1] + m[3] * lx + m[4] * ly + m[5] * lz,
                  box[o + 2] + m[6] * lx + m[7] * ly + m[8] * lz)) occ++;
  }
  if (occ / 27 >= PROXY_COVER) { proxyCovered++; continue; }
  const before = out.length;
  emit(i);
  if (out.length > before) { indexBox(out[before], before); mats.push(quatToMat(out[before].q[0], out[before].q[1], out[before].q[2], out[before].q[3])); }
  proxyUsed++;
}
console.log(`  proxies   ${proxyUsed.toLocaleString()} emitted where uncovered, ${proxyCovered.toLocaleString()} rejected as covered`);

{
  const dims = out.map(b => Math.max(b.h[0], b.h[1], b.h[2]) * 2).sort((a, b) => a - b);
  const med = dims.length ? dims[dims.length >> 1] : 0;
  console.log(`  shape     median largest dim ${med.toFixed(1)} m, ${out.length.toLocaleString()} boxes`);
}
console.log(`  BOXES     ${out.length.toLocaleString()} after raw passthrough (0 axis + ${out.length.toLocaleString()} oriented)`);

const buf = new Float32Array(out.length * 10);
out.forEach((b, i) => {
  const o = i * 10;
  buf[o] = b.c[0]; buf[o + 1] = b.c[1]; buf[o + 2] = b.c[2];
  buf[o + 3] = b.h[0]; buf[o + 4] = b.h[1]; buf[o + 5] = b.h[2];
  buf[o + 6] = b.q[0]; buf[o + 7] = b.q[1]; buf[o + 8] = b.q[2]; buf[o + 9] = b.q[3];
});
fs.writeFileSync(path.join(dataDir, `district-hull-${name}.bin`), Buffer.from(buf.buffer));
fs.rmSync(path.join(dataDir, `district-hull-${name}.presnap.bin`), { force: true });
fs.writeFileSync(path.join(dataDir, `district-hull-${name}.json`), JSON.stringify({
  district: name, bounds: meta.bounds, generator: 'raw',
  minSize: MIN_SIZE, maxSize: MAX_SIZE, below: BELOW, proxyMax: PROXY_MAX,
  boxes: out.length, proxyUsed, proxyCovered,
  stride: 10, layout: 'centre xyz, halfExtent xyz, quat xyzw (float32)',
  generated: new Date().toISOString(),
}, null, 2));
console.log(`\n  wrote data/district-hull-${name}.bin`);
