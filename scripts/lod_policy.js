#!/usr/bin/env node
/**
 * lod_policy.js: what a LOD-and-size policy actually costs, weighted by
 * placements.
 *
 * lod_census.js counted unique meshes, which answers "what did CDPR author"
 * and not "what does the city draw". A panel placed 40,000 times and a statue
 * placed once count the same there, and the city is a kit: the common meshes
 * are the cheap ones and the rare meshes are the expensive ones, so an
 * unweighted census flatters the detail and hides the bulk.
 *
 * This walks the real placements of the built districts, joins each to the
 * LOD levels its mesh actually has, and prices whole policies:
 *
 *   lod        ask for a level, fall back to FINER where a mesh has none
 *   size gate  drop placements whose largest dimension is under N metres
 *
 * The size gate is the interesting half. 73% of meshes have no LOD2, and their
 * names (drywall, window frames, collars) suggest CDPR never authored one
 * because the piece stops being drawn before it needs one. The map's camera
 * never comes closer than 800 units, so the same argument applies here.
 *
 * Usage:
 *   node scripts/lod_policy.js
 *   node scripts/lod_policy.js city_center --gates 0,1,2,4,6
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { readGlb, glbPathFor } = require('./glb_lib');
const { categorize } = require('./asset_category');

const LOD_ROOT = 'd:/Modding/CP2077 Mods/MyMods/map_data_export/source/raw_alllod';
const args = process.argv.slice(2);
const flag = (k, d) => { const i = args.indexOf(`--${k}`); return i > 0 ? args[i + 1] : d; };
const GATES = flag('gates', '0,1,2,4,6').split(',').map(Number);
const dataDir = path.join(__dirname, '..', 'data');

let districts = args.filter(a => !a.startsWith('--') && !/^[\d.,]+$/.test(a));
if (!districts.length) {
  districts = fs.readdirSync(dataDir)
    .map(f => f.match(/^district-boxes-(.+)\.bin$/))
    .filter(Boolean).map(m => m[1]);
}

/** Triangles per LOD level for one mesh, read once and cached. */
const lodCache = new Map();
function lodsFor(depot) {
  if (lodCache.has(depot)) return lodCache.get(depot);
  let out = null;
  const file = glbPathFor(LOD_ROOT, depot);
  if (fs.existsSync(file)) {
    try {
      const g = readGlb(file);
      const here = new Map();
      for (const m of g.json.meshes || []) {
        const mm = /_LOD_(\d+)$/.exec(m.name || '');
        const lod = mm ? +mm[1] : 1;
        let t = 0;
        for (const p of m.primitives || []) {
          if (p.indices === undefined) continue;
          t += g.json.accessors[p.indices].count / 3;
        }
        here.set(lod, (here.get(lod) || 0) + t);
      }
      if (here.size) out = here;
    } catch { out = null; }
  }
  lodCache.set(depot, out);
  return out;
}

/** Triangles this mesh draws when the policy asks for `want`. */
function trisAt(here, want) {
  const at = [...here.keys()].sort((a, b) => a - b);
  const use = at.filter(l => l <= want).pop() ?? at[0];
  return { tris: here.get(use) || 0, level: use, hasWanted: here.has(want) };
}

const totals = {};   // `${want}|${gate}` -> triangles
let placements = 0, noGlb = 0, skipped = 0;
let unlodTris = 0, unlodPlacements = 0;   // cost carried by meshes with no LOD2
const unlodBySize = new Map();

for (const name of districts) {
  const meta = JSON.parse(fs.readFileSync(path.join(dataDir, `district-boxes-${name}.json`), 'utf8'));
  const raw = fs.readFileSync(path.join(dataDir, `district-boxes-${name}.bin`));
  const box = new Float32Array(raw.buffer, raw.byteOffset, raw.length / 4);
  const S = meta.stride, PATHS = meta.assetPaths || {}, TYPE = meta.types || {};
  process.stdout.write(`  ${name}: ${meta.boxes.toLocaleString()} placements\r`);

  for (let i = 0; i < meta.boxes; i++) {
    const o = i * S;
    const depot = PATHS[box[o + 10]];
    if (!depot) { noGlb++; continue; }
    const kind = categorize(depot, TYPE[box[o + 11]] || '');
    if (kind === 'never' || kind === 'boundary' || kind === 'terrain') { skipped++; continue; }
    const here = lodsFor(depot);
    if (!here) { noGlb++; continue; }
    placements++;
    const dim = Math.max(box[o + 3], box[o + 4], box[o + 5]) * 2;

    for (const want of [1, 2, 4]) {
      const r = trisAt(here, want);
      for (const gate of GATES) {
        if (dim < gate) continue;
        const k = `${want}|${gate}`;
        totals[k] = (totals[k] || 0) + r.tris;
      }
    }
    // What the un-LODed meshes cost when the policy asks for LOD2.
    const r2 = trisAt(here, 4);
    if (!r2.hasWanted) {
      unlodTris += r2.tris;
      unlodPlacements++;
      const bucket = dim < 1 ? '<1m' : dim < 2 ? '1-2m' : dim < 4 ? '2-4m' : dim < 8 ? '4-8m' : '8m+';
      const e = unlodBySize.get(bucket) || { n: 0, tris: 0 };
      e.n++; e.tris += r2.tris;
      unlodBySize.set(bucket, e);
    }
  }
}
process.stdout.write(' '.repeat(60) + '\r');

const base = totals['1|0'];
console.log(`districts ${districts.join(', ')}`);
console.log(`placements ${placements.toLocaleString()} priced (${noGlb.toLocaleString()} without a GLB, ${skipped.toLocaleString()} not geometry)\n`);

console.log('drawn triangles, millions (rows = lod asked for, cols = size gate in metres)');
process.stdout.write('        ');
for (const g of GATES) process.stdout.write(String(`>=${g}m`).padStart(11));
console.log();
for (const want of [1, 2, 4]) {
  process.stdout.write(`  lod${want === 1 ? 0 : want === 2 ? 1 : 2}  `);
  for (const g of GATES) {
    const v = totals[`${want}|${g}`] || 0;
    process.stdout.write(`${(v / 1e6).toFixed(1)}M`.padStart(11));
  }
  console.log();
}
console.log('\nsame, as a share of LOD0 with no gate');
process.stdout.write('        ');
for (const g of GATES) process.stdout.write(String(`>=${g}m`).padStart(11));
console.log();
for (const want of [1, 2, 4]) {
  process.stdout.write(`  lod${want === 1 ? 0 : want === 2 ? 1 : 2}  `);
  for (const g of GATES) {
    const v = totals[`${want}|${g}`] || 0;
    process.stdout.write(`${(100 * v / base).toFixed(1)}%`.padStart(11));
  }
  console.log();
}

console.log(`\nmeshes with NO LOD2, priced at whatever they do have:`);
console.log(`  ${unlodPlacements.toLocaleString()} placements carrying ${(unlodTris / 1e6).toFixed(1)}M triangles ` +
            `(${(100 * unlodTris / (totals['4|0'] || 1)).toFixed(1)}% of the lod2 policy's cost)`);
for (const b of ['<1m', '1-2m', '2-4m', '4-8m', '8m+']) {
  const e = unlodBySize.get(b);
  if (!e) continue;
  console.log(`    ${b.padEnd(6)} ${String(e.n).padStart(8)} placements  ${(e.tris / 1e6).toFixed(2)}M triangles`);
}
