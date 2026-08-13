#!/usr/bin/env node
/**
 * missing_geometry.js: which placements have no exported mesh, and does it
 * matter.
 *
 * 506,149 of 2.75M placements in the built districts price at zero triangles
 * because there is no GLB for their asset. Most of that is deliberate:
 * mesh_export_list.js only lists meshes between MIN_SIZE (2 m) and MAX_SIZE
 * (1000 m), on the argument that below 2 m a box is a fine approximation of a
 * bollard. That argument was made for the BOX cloud, where every placement
 * became a box anyway. Real geometry has no such fallback: an asset with no
 * GLB is simply absent.
 *
 * So the number to find is not the total, it is the part that is big enough to
 * see. Anything at or above the size gate with no geometry on disk is a hole in
 * every representation, and it will not announce itself.
 *
 * Usage:
 *   node scripts/missing_geometry.js
 *   node scripts/missing_geometry.js city_center --min 4
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { glbPathFor } = require('./glb_lib');
const { categorize } = require('./asset_category');

const LOD_ROOT = 'd:/Modding/CP2077 Mods/MyMods/map_data_export/source/raw_alllod';
const RAW_ROOT = 'd:/Modding/CP2077 Mods/MyMods/map_data_export/source/raw';

const args = process.argv.slice(2);
const flag = (k, d) => { const i = args.indexOf(`--${k}`); return i > 0 ? Number(args[i + 1]) : d; };
const MIN_INTERESTING = flag('min', 2);
const dataDir = path.join(__dirname, '..', 'data');

let districts = args.filter(a => !a.startsWith('--') && !/^[\d.]+$/.test(a));
if (!districts.length) {
  districts = fs.readdirSync(dataDir)
    .map(f => f.match(/^district-boxes-(.+)\.bin$/)).filter(Boolean).map(m => m[1]);
}

const have = new Map();
function exists(depot) {
  if (have.has(depot)) return have.get(depot);
  const v = fs.existsSync(glbPathFor(LOD_ROOT, depot)) || fs.existsSync(glbPathFor(RAW_ROOT, depot));
  have.set(depot, v);
  return v;
}

const buckets = { '<2m': 0, '2-4m': 0, '4-8m': 0, '8-20m': 0, '20-100m': 0, '100m+': 0 };
const bigByAsset = new Map();
const byKind = new Map();
let total = 0, missing = 0, noPath = 0;

for (const name of districts) {
  const meta = JSON.parse(fs.readFileSync(path.join(dataDir, `district-boxes-${name}.json`), 'utf8'));
  const raw = fs.readFileSync(path.join(dataDir, `district-boxes-${name}.bin`));
  const box = new Float32Array(raw.buffer, raw.byteOffset, raw.length / 4);
  const S = meta.stride, PATHS = meta.assetPaths || {}, TYPE = meta.types || {};
  for (let i = 0; i < meta.boxes; i++) {
    const o = i * S;
    total++;
    const depot = PATHS[box[o + 10]];
    if (!depot) { noPath++; continue; }
    if (exists(depot)) continue;
    missing++;
    const dim = Math.max(box[o + 3], box[o + 4], box[o + 5]) * 2;
    const b = dim < 2 ? '<2m' : dim < 4 ? '2-4m' : dim < 8 ? '4-8m'
      : dim < 20 ? '8-20m' : dim < 100 ? '20-100m' : '100m+';
    buckets[b]++;
    const kind = categorize(depot, TYPE[box[o + 11]] || '');
    byKind.set(kind, (byKind.get(kind) || 0) + 1);
    if (dim >= MIN_INTERESTING) {
      const e = bigByAsset.get(depot) || { n: 0, dim: 0, kind };
      e.n++; if (dim > e.dim) e.dim = dim;
      bigByAsset.set(depot, e);
    }
  }
}

console.log(`districts ${districts.join(', ')}`);
console.log(`placements ${total.toLocaleString()}, no GLB ${missing.toLocaleString()} (${(100 * missing / total).toFixed(1)}%), no asset path ${noPath.toLocaleString()}\n`);
console.log('missing, by placed size:');
for (const k in buckets) {
  console.log(`  ${k.padEnd(8)} ${String(buckets[k]).padStart(8)}  ${(100 * buckets[k] / Math.max(1, missing)).toFixed(1)}%`);
}
console.log('\nmissing, by category:');
for (const [k, n] of [...byKind].sort((a, b) => b[1] - a[1])) console.log(`  ${k.padEnd(15)} ${String(n).padStart(8)}`);

const big = [...bigByAsset].sort((a, b) => b[1].n - a[1].n);
const bigTotal = big.reduce((s, [, e]) => s + e.n, 0);
console.log(`\n${big.length.toLocaleString()} distinct assets at ${MIN_INTERESTING} m or larger with no GLB, ${bigTotal.toLocaleString()} placements`);
for (const [p, e] of big.slice(0, 15)) {
  console.log(`  ${String(e.n).padStart(6)}  up to ${e.dim.toFixed(1).padStart(7)} m  ${e.kind.padEnd(14)} ${p.split('\\').slice(-2).join('\\')}`);
}

// The list to feed back into the exporter, so the gap closes rather than being
// merely counted.
if (big.length) {
  const out = path.join(dataDir, 'missing-geometry.json');
  fs.writeFileSync(out, JSON.stringify({
    districts, minInteresting: MIN_INTERESTING,
    placements: total, missing, missingAtOrAboveMin: bigTotal,
    meshList: big.map(([p, e]) => ({ path: p, placements: e.n, maxDim: +e.dim.toFixed(1), category: e.kind })),
    generated: new Date().toISOString(),
  }, null, 2));
  console.log(`\n-> ${path.relative(process.cwd(), out)} (feed to scripts/wkit/export_lods.js)`);
}
