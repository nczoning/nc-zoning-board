#!/usr/bin/env node
/**
 * scripts/prefab_depth.js
 * ─────────────────────────────────────────────────────────────────────────
 * WHAT LEVEL OF THE PREFAB PATH IS "A BUILDING"?
 *
 * ncz_prefabs.csv's `ref` is not an id — it is a NodeRef PATH into the world's
 * scene graph, and it is per-PLACEMENT:
 *
 *   $/03_night_city/#c_santo_domingo/rancho_coronado
 *     /{sdrc_}04_prefab.../sdrc_04_a_env_prefab.../sdrc_04_a_subdistrict_prefab...
 *     /sdrc_04_a_ARCHITECTURE_prefab...        <- the district's architecture bucket
 *     /std_rcr_house_a_v5_ap2_004_prefab...    <- A BUILDING
 *     /decoset_.../airconditioner_003_prefab   <- one air conditioner
 *
 * window_where.js grouped by the WHOLE ref, i.e. by whatever leaf depth each mesh
 * happened to sit at. That is not "per building" — it is "per deepest prefab", which
 * for one building is many different groups, and its 4,024-both-glass-and-wall figure
 * is an artefact of that choice.
 *
 * Building identity is a path PREFIX, and which prefix is an empirical question.
 * This script asks the data, and does not choose for it:
 *
 *   1. How deep do refs go, and how deep are the ones carrying ARCHITECTURE meshes?
 *   2. Is there a consistent naming level (an `_architecture_` bucket) to anchor on?
 *   3. At each candidate depth, how many groups hold BOTH glass and wall — and how
 *      big is a group? (Too shallow: one group = a whole district. Too deep: glass
 *      and wall never co-occur and every group is one kit part.)
 *
 * Reports. Decides nothing.
 */
'use strict';
const fs = require('fs');
const path = require('path');

const RAW = process.argv.includes('--raw')
  ? process.argv[process.argv.indexOf('--raw') + 1]
  : 'd:/Modding/CP2077 Mods/MyMods/map_data_export/source/raw';

// ncz_prefabs.csv is id,"ref" — the ref is quoted and contains no quotes of its own.
function readPrefabs() {
  const lines = fs.readFileSync(path.join(RAW, 'ncz_prefabs.csv'), 'utf8').split(/\r?\n/);
  const out = {};
  for (let i = 1; i < lines.length; i++) {
    const L = lines[i];
    if (!L) continue;
    const c = L.indexOf(',');
    const id = L.slice(0, c);
    let ref = L.slice(c + 1);
    if (ref.startsWith('"')) ref = ref.slice(1, -1);
    out[id] = ref;
  }
  return out;
}

const refs = readPrefabs();
const ids = Object.keys(refs);
console.log(`prefab refs: ${ids.length.toLocaleString()}\n`);

// ── 1. DEPTH DISTRIBUTION ────────────────────────────────────────────────
const depth = {};
for (const id of ids) {
  const d = refs[id].split('/').length;
  depth[d] = (depth[d] || 0) + 1;
}
console.log('=== 1. REF DEPTH (segments per path)\n');
for (const d of Object.keys(depth).map(Number).sort((a, b) => a - b)) {
  const bar = '#'.repeat(Math.round(60 * depth[d] / ids.length));
  console.log(`  ${String(d).padStart(3)} segs  ${String(depth[d]).padStart(7)}  ${bar}`);
}

// ── 2. IS THERE AN ANCHOR LEVEL? ─────────────────────────────────────────
// If `_architecture_prefab` is a consistent bucket node, then "the building" is the
// segment IMMEDIATELY AFTER it, at a stable index — which gives us a rule rather than
// a magic depth number.
console.log('\n=== 2. ANCHOR SEGMENTS — which naming levels actually recur?\n');
const seg = {};   // segment "kind" (the _word_ before `_prefab`) → count, by position from root
for (const id of ids) {
  const parts = refs[id].split('/');
  for (let i = 0; i < parts.length; i++) {
    const m = /_(architecture|subdistrict|env|decoration|interior|megabuilding|building)_prefab/i.exec(parts[i]);
    if (m) {
      const k = m[1].toLowerCase();
      (seg[k] || (seg[k] = { n: 0, idx: {} })).n++;
      seg[k].idx[i] = (seg[k].idx[i] || 0) + 1;
    }
  }
}
for (const k of Object.keys(seg).sort((a, b) => seg[b].n - seg[a].n)) {
  const idxs = Object.keys(seg[k].idx).map(Number).sort((a, b) => seg[k].idx[b] - seg[k].idx[a]);
  const spread = idxs.slice(0, 4).map((i) => `${i}(${seg[k].idx[i]})`).join(' ');
  console.log(`  _${k}_prefab  ${String(seg[k].n).padStart(7)} refs   depth-index: ${spread}`);
}
console.log('\n  A tight depth-index spread ⇒ a stable anchor we can slice on.');

// ── 3. HOW MANY REFS SIT UNDER AN ARCHITECTURE BUCKET AT ALL? ────────────
const ARCHSEG = /_architecture_prefab/i;
let underArch = 0;
const buildingOf = {};   // prefabId → the segment right after the architecture bucket
for (const id of ids) {
  const parts = refs[id].split('/');
  const ai = parts.findIndex((p) => ARCHSEG.test(p));
  if (ai < 0) continue;
  underArch++;
  // the building is the child of the architecture bucket; if the ref ENDS at the
  // bucket, the ref itself is the building-level node.
  buildingOf[id] = parts.slice(0, Math.min(ai + 2, parts.length)).join('/');
}
console.log(`\n=== 3. THE ARCHITECTURE BUCKET\n`);
console.log(`  refs under an _architecture_ node : ${underArch.toLocaleString()}  (${(100 * underArch / ids.length).toFixed(1)}%)`);
console.log(`  distinct BUILDING-level prefixes  : ${new Set(Object.values(buildingOf)).size.toLocaleString()}`);
console.log('\n  (a ref NOT under _architecture_ is decoration/env/interior — it is not a building');
console.log('   part, and the window model does not care about it)');

// Show a few, so the shape is visible rather than asserted.
console.log('\n  sample building-level prefixes:');
const uniq = [...new Set(Object.values(buildingOf))].slice(0, 5);
for (const b of uniq) console.log(`    ${b.split('/').slice(-2).join('/')}`);
