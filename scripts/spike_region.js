#!/usr/bin/env node
/**
 * spike_region.js: extract a neighbourhood as all three tiers at once, so the
 * transitions between them can be judged rather than argued about.
 *
 * The one-building spike answered what each representation costs. It cannot
 * answer the question that follows, which is whether a building CHANGING tier
 * is visible, because a single building is always at one distance.
 *
 * Per building, three representations:
 *
 *   near   the real kit, instanced from a library shared across the region
 *   mid    the same placements merged into one buffer at a coarser LOD
 *   far    the hull boxes the current pipeline ships for that volume
 *
 * The kit library is shared and the merged buffers are not, which is the
 * asymmetry the whole design rests on: 37,343 meshes cover the city, while
 * merged geometry is per building by construction.
 *
 * Source is the stage-1 bin rather than the dump, because it already carries
 * position, rotation, scale, asset and assembly per placement, and it is
 * already filtered to the district polygon.
 *
 * Usage:
 *   node scripts/spike_region.js city_center
 *   node scripts/spike_region.js city_center --at -1970,80 --buildings 16
 *   node scripts/spike_region.js watson --nearlod 2 --midlod 4
 *
 * Output: data/region-<district>.bin / .json
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { glbPathFor, meshTriangles } = require('./glb_lib');
const { categorize } = require('./asset_category');

const LOD_ROOT = 'd:/Modding/CP2077 Mods/MyMods/map_data_export/source/raw_alllod';
const RAW_ROOT = 'd:/Modding/CP2077 Mods/MyMods/map_data_export/source/raw';

const args = process.argv.slice(2);
const flag = (k, d) => { const i = args.indexOf(`--${k}`); return i > 0 ? args[i + 1] : d; };
const district = args.find(a => !a.startsWith('--') && !/^[-\d.,]+$/.test(a)) || 'city_center';
const AT = flag('at', null);
const MAX_BUILDINGS = Number(flag('buildings', 14));
const NEAR_LOD = Number(flag('nearlod', 2));   // mask 2 = LOD1
const MID_LOD = Number(flag('midlod', 4));     // mask 4 = LOD2
const MIN_PLACEMENTS = Number(flag('minplacements', 40));
const SPREAD = Number(flag('spread', 0));   // metres of minimum separation between chosen buildings

const dataDir = path.join(__dirname, '..', 'data');
const meta = JSON.parse(fs.readFileSync(path.join(dataDir, `district-boxes-${district}.json`), 'utf8'));
const raw = fs.readFileSync(path.join(dataDir, `district-boxes-${district}.bin`));
const box = new Float32Array(raw.buffer, raw.byteOffset, raw.length / 4);
const S = meta.stride, nBox = meta.boxes;
const PATHS = meta.assetPaths || {}, TYPE = meta.types || {};

if (S < 20) {
  console.error('stage 1 has no assembly id (stride < 20): rerun scripts/district_boxes.js');
  process.exit(1);
}

// ── Group placements into assemblies ──────────────────────────────────────
const asm = new Map();
for (let i = 0; i < nBox; i++) {
  const o = i * S;
  const id = box[o + 19];
  if (!(id >= 0)) continue;                       // no prefab ref: not a building group
  const depot = PATHS[box[o + 10]];
  if (!depot) continue;
  const kind = categorize(depot, TYPE[box[o + 11]] || '');
  if (kind === 'never' || kind === 'boundary' || kind === 'terrain' || kind === 'proxy') continue;
  let g = asm.get(id);
  if (!g) asm.set(id, g = { id, list: [], x0: Infinity, y0: Infinity, z0: Infinity, x1: -Infinity, y1: -Infinity, z1: -Infinity });
  g.list.push(i);
  const cx = box[o], cy = box[o + 1], cz = box[o + 2];
  if (cx < g.x0) g.x0 = cx; if (cx > g.x1) g.x1 = cx;
  if (cy < g.y0) g.y0 = cy; if (cy > g.y1) g.y1 = cy;
  if (cz < g.z0) g.z0 = cz; if (cz > g.z1) g.z1 = cz;
}

let groups = [...asm.values()].filter(g => g.list.length >= MIN_PLACEMENTS);
console.log(`${district}: ${asm.size.toLocaleString()} assemblies, ${groups.length.toLocaleString()} with ${MIN_PLACEMENTS}+ placements`);

let cx0, cy0;
if (AT) { const p = AT.split(',').map(Number); cx0 = p[0]; cy0 = p[1]; }
else {
  const biggest = groups.reduce((a, b) => (a.list.length > b.list.length ? a : b));
  cx0 = (biggest.x0 + biggest.x1) / 2; cy0 = (biggest.y0 + biggest.y1) / 2;
}
groups.forEach(g => {
  g.mx = (g.x0 + g.x1) / 2; g.my = (g.y0 + g.y1) / 2;
  g.dist = Math.hypot(g.mx - cx0, g.my - cy0);
});

if (SPREAD > 0) {
  // SPREAD over the district instead of clustering. A tier boundary can only
  // be watched crossing a building if the buildings sit at different distances
  // from the camera, and the nearest fourteen assemblies to a point span 88 m,
  // which is nothing against a camera that starts 800 units out.
  const byMass = [...groups].sort((a, b) => b.list.length - a.list.length);
  const picked = [];
  for (const g of byMass) {
    if (picked.length >= MAX_BUILDINGS) break;
    if (picked.every(p => Math.hypot(p.mx - g.mx, p.my - g.my) >= SPREAD)) picked.push(g);
  }
  groups = picked;
  const span = Math.max(...groups.map(g => Math.hypot(g.mx - cx0, g.my - cy0)));
  console.log(`region SPREAD at ${SPREAD} m minimum separation: ${groups.length} buildings over ${span.toFixed(0)} m`);
} else {
  groups.sort((a, b) => a.dist - b.dist);
  groups = groups.slice(0, MAX_BUILDINGS);
  console.log(`region centred on ${cx0.toFixed(0)}, ${cy0.toFixed(0)}: ${groups.length} buildings, ` +
              `out to ${groups[groups.length - 1].dist.toFixed(0)} m`);
}

// ── Mesh library, at both levels ──────────────────────────────────────────
const cacheNear = new Map(), cacheMid = new Map();
function trisFor(depot, lod, cache) {
  if (cache.has(depot)) return cache.get(depot);
  let t = null;
  let file = glbPathFor(LOD_ROOT, depot);
  if (!fs.existsSync(file)) file = glbPathFor(RAW_ROOT, depot);
  if (fs.existsSync(file)) {
    try { t = meshTriangles(file, lod); if (!t.length) t = null; } catch { t = null; }
  }
  cache.set(depot, t);
  return t;
}

const meshIndex = new Map();     // depot -> index into the shared near library
const meshList = [];
for (const g of groups) {
  for (const i of g.list) {
    const depot = PATHS[box[i * S + 10]];
    if (meshIndex.has(depot)) continue;
    const t = trisFor(depot, NEAR_LOD, cacheNear);
    if (!t) { meshIndex.set(depot, -1); continue; }
    meshIndex.set(depot, meshList.length);
    meshList.push({ depot, tris: t });
  }
}
const kitFloats = meshList.reduce((n, m) => n + m.tris.length, 0);
console.log(`kit        ${meshList.length} unique meshes at lod mask ${NEAR_LOD}, ` +
            `${(kitFloats / 9).toLocaleString()} triangles, ${(kitFloats * 4 / 1e6).toFixed(1)} MB`);

// ── Per building: instances, merged, boxes ────────────────────────────────
const hullFile = path.join(dataDir, `district-hull-${district}.bin`);
let hf = null;
if (fs.existsSync(hullFile)) {
  const hraw = fs.readFileSync(hullFile);
  hf = new Float32Array(hraw.buffer, hraw.byteOffset, hraw.length / 4);
}

const instParts = [], mergedParts = [], boxParts = [];
const buildings = [];
let instOff = 0, mergedOff = 0, boxOff = 0;

for (const g of groups) {
  const live = g.list.filter(i => meshIndex.get(PATHS[box[i * S + 10]]) >= 0);
  if (!live.length) continue;

  const inst = new Float32Array(live.length * 11);
  live.forEach((i, k) => {
    const o = i * S, q = k * 11;
    inst[q] = box[o + 13]; inst[q + 1] = box[o + 14]; inst[q + 2] = box[o + 15];
    inst[q + 3] = box[o + 6]; inst[q + 4] = box[o + 7]; inst[q + 5] = box[o + 8]; inst[q + 6] = box[o + 9];
    inst[q + 7] = box[o + 16]; inst[q + 8] = box[o + 17]; inst[q + 9] = box[o + 18];
    inst[q + 10] = meshIndex.get(PATHS[box[o + 10]]);
  });

  // Merged, at the mid level: the same placements, transformed once.
  let mergedTris = 0;
  for (const i of live) {
    const t = trisFor(PATHS[box[i * S + 10]], MID_LOD, cacheMid);
    if (t) mergedTris += t.length / 9;
  }
  const merged = new Float32Array(mergedTris * 9);
  let mo = 0;
  for (const i of live) {
    const t = trisFor(PATHS[box[i * S + 10]], MID_LOD, cacheMid);
    if (!t) continue;
    const o = i * S;
    const qx = box[o + 6], qy = box[o + 7], qz = box[o + 8], qw = box[o + 9];
    const m00 = 1 - 2 * (qy * qy + qz * qz), m01 = 2 * (qx * qy - qz * qw), m02 = 2 * (qx * qz + qy * qw);
    const m10 = 2 * (qx * qy + qz * qw), m11 = 1 - 2 * (qx * qx + qz * qz), m12 = 2 * (qy * qz - qx * qw);
    const m20 = 2 * (qx * qz - qy * qw), m21 = 2 * (qy * qz + qx * qw), m22 = 1 - 2 * (qx * qx + qy * qy);
    const px = box[o + 13], py = box[o + 14], pz = box[o + 15];
    const sx = box[o + 16], sy = box[o + 17], sz = box[o + 18];
    for (let k = 0; k < t.length; k += 3) {
      const lx = t[k] * sx, ly = t[k + 1] * sy, lz = t[k + 2] * sz;
      merged[mo++] = px + m00 * lx + m01 * ly + m02 * lz;
      merged[mo++] = py + m10 * lx + m11 * ly + m12 * lz;
      merged[mo++] = pz + m20 * lx + m21 * ly + m22 * lz;
    }
  }

  // Boxes, by the assembly's own volume. The hull has no assembly id, so this
  // is a spatial query and it catches whatever else shares the airspace.
  const boxes = [];
  if (hf) {
    const pad = 4;
    for (let i = 0; i < hf.length / 10; i++) {
      const o = i * 10;
      if (hf[o] < g.x0 - pad || hf[o] > g.x1 + pad) continue;
      if (hf[o + 1] < g.y0 - pad || hf[o + 1] > g.y1 + pad) continue;
      if (hf[o + 2] < g.z0 - pad || hf[o + 2] > g.z1 + pad) continue;
      for (let k = 0; k < 10; k++) boxes.push(hf[o + k]);
    }
  }
  const boxArr = Float32Array.from(boxes);

  buildings.push({
    assembly: g.id,
    placements: live.length,
    bounds: { min: [g.x0, g.y0, g.z0], max: [g.x1, g.y1, g.z1] },
    instances: { byteOffset: instOff, count: live.length },
    merged: { byteOffset: mergedOff, triangles: mergedTris },
    boxes: { byteOffset: boxOff, count: boxArr.length / 10 },
  });
  instParts.push(inst); instOff += inst.byteLength;
  mergedParts.push(merged); mergedOff += merged.byteLength;
  boxParts.push(boxArr); boxOff += boxArr.byteLength;
}

// ── Pack ──────────────────────────────────────────────────────────────────
const kit = new Float32Array(kitFloats);
const meshMeta = [];
let ko = 0;
for (const m of meshList) {
  kit.set(m.tris, ko);
  meshMeta.push({ depot: m.depot, floatOffset: ko, triangles: m.tris.length / 9 });
  ko += m.tris.length;
}

const cat = (arrs) => Buffer.concat(arrs.map(a => Buffer.from(a.buffer, a.byteOffset, a.byteLength)));
const kitBuf = Buffer.from(kit.buffer, 0, kit.byteLength);
const instBuf = cat(instParts), mergedBuf = cat(mergedParts), boxBuf = cat(boxParts);
const bin = Buffer.concat([kitBuf, instBuf, mergedBuf, boxBuf]);

const base = `region-${district}`;
fs.writeFileSync(path.join(dataDir, `${base}.bin`), bin);

let cursor = 0;
const range = (bytes) => { const r = { byteOffset: cursor, byteLength: bytes }; cursor += bytes; return r; };
const layout = {
  kit: { ...range(kitBuf.length), format: 'float32 xyz per vertex, 3 per triangle, CET' },
  instances: { ...range(instBuf.length), stride: 11, format: 'pos xyz, quat xyzw, scale xyz, meshIndex' },
  merged: { ...range(mergedBuf.length), format: 'float32 xyz per vertex, world CET' },
  boxes: { ...range(boxBuf.length), stride: 10, format: 'centre xyz, halfExtent xyz, quat xyzw' },
};

const totals = buildings.reduce((a, b) => ({
  placements: a.placements + b.placements,
  merged: a.merged + b.merged.triangles,
  boxes: a.boxes + b.boxes.count,
}), { placements: 0, merged: 0, boxes: 0 });

fs.writeFileSync(path.join(dataDir, `${base}.json`), JSON.stringify({
  district, centre: [cx0, cy0], nearLod: NEAR_LOD, midLod: MID_LOD,
  buildings, meshes: meshMeta, layout,
  totals: { ...totals, kitTriangles: kitFloats / 9, uniqueMeshes: meshList.length },
  generated: new Date().toISOString(),
}, null, 2));

console.log(`buildings  ${buildings.length}, ${totals.placements.toLocaleString()} placements`);
console.log(`merged     ${totals.merged.toLocaleString()} triangles at lod mask ${MID_LOD}`);
console.log(`boxes      ${totals.boxes.toLocaleString()}`);
console.log(`-> data/${base}.bin  ${(bin.length / 1e6).toFixed(1)} MB`);
