#!/usr/bin/env node
/**
 * lod_census.js: what the all-LOD export actually bought, across the library.
 *
 * A per-building sample said LOD2 is 8.6% of LOD0's triangles, but a sample of
 * one building is a sample of one artist's kit. This reads every exported GLB
 * and reports the whole distribution, including the meshes that HAVE no lower
 * level: those fall back to finer geometry, so they set the floor on what any
 * LOD policy can save.
 *
 * Usage:
 *   node scripts/lod_census.js
 *   node scripts/lod_census.js --root <dir> --sample 2000
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { readGlb } = require('./glb_lib');

const args = process.argv.slice(2);
const flag = (k, d) => { const i = args.indexOf(`--${k}`); return i > 0 ? args[i + 1] : d; };
const ROOT = flag('root', 'd:/Modding/CP2077 Mods/MyMods/map_data_export/source/raw_alllod');
const SAMPLE = Number(flag('sample', 0));

/** Every .glb under a directory tree. */
function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.name.endsWith('.glb')) out.push(p);
  }
  return out;
}

console.log(`scanning ${ROOT}`);
let files = walk(ROOT);
console.log(`${files.length.toLocaleString()} glb files`);
if (SAMPLE > 0 && files.length > SAMPLE) {
  const step = files.length / SAMPLE;
  files = Array.from({ length: SAMPLE }, (_, i) => files[Math.floor(i * step)]);
  console.log(`sampling ${files.length.toLocaleString()}`);
}

const perLod = new Map();       // lod mask -> triangles
const meshesWith = new Map();   // lod mask -> mesh count
let read = 0, failed = 0, deepest = 0;
const only0 = [];

for (const f of files) {
  let g;
  try { g = readGlb(f); } catch { failed++; continue; }
  read++;
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
  for (const [lod, t] of here) {
    perLod.set(lod, (perLod.get(lod) || 0) + t);
    meshesWith.set(lod, (meshesWith.get(lod) || 0) + 1);
    if (lod > deepest) deepest = lod;
  }
  if (here.size === 1 && here.has(1) && only0.length < 8) only0.push(path.basename(f));
  if (read % 5000 === 0) process.stdout.write(`\r  read ${read.toLocaleString()}   `);
}
process.stdout.write('\r' + ' '.repeat(40) + '\r');

const base = perLod.get(1) || 1;
console.log(`read ${read.toLocaleString()} (${failed} unreadable)\n`);
console.log('  lod   meshes having it        triangles      vs LOD0');
for (const lod of [...perLod.keys()].sort((a, b) => a - b)) {
  const n = meshesWith.get(lod);
  console.log(`  ${String(lod).padStart(3)}   ${String(n).padStart(7)} (${(100 * n / read).toFixed(1)}%)   ` +
              `${String(Math.round(perLod.get(lod)).toLocaleString()).padStart(12)}   ${(100 * perLod.get(lod) / base).toFixed(1)}%`);
}

// What a policy actually costs: a mesh with no chunk at the requested level
// keeps its finest, so the saving is never the headline percentage.
for (const want of [2, 4, 8]) {
  if (!perLod.has(want)) continue;
  let total = 0;
  for (const f of files) {
    let g;
    try { g = readGlb(f); } catch { continue; }
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
    const at = [...here.keys()].sort((a, b) => a - b);
    const use = at.filter(l => l <= want).pop() ?? at[0];
    total += here.get(use) || 0;
  }
  console.log(`\n  asking for lod ${want}, with fallback to finer: ${Math.round(total).toLocaleString()} triangles ` +
              `(${(100 * total / base).toFixed(1)}% of LOD0)`);
}

if (only0.length) console.log(`\n  examples with LOD0 only: ${only0.join(', ')}`);
