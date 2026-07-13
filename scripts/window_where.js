#!/usr/bin/env node
/**
 * scripts/window_where.js
 * ─────────────────────────────────────────────────────────────────────────
 * WHERE ARE THE WINDOWS? (XYZ)
 *
 * The night model's real problem is not "how much of a district is glass" — it is
 * "which of THIS building's parts carry the window material, and WHERE do they sit on it".
 * The reference frames settle it: Night City's facades are mostly solid, with windows
 * CLUSTERED into specific kit parts. No per-district scalar, spread uniformly over every
 * wall, can produce that at any average.
 *
 * So: sweep every field in the dump that could carry positional signal about windows.
 *
 *   1. Do glass nodes have EXACT positions? (non-instanced ⇒ real XYZ + quaternion)
 *   2. The sector tag is X_Y_Z — three coords. night_analyse reads only X and Y.
 *      If the third is a VERTICAL index, then even INSTANCED nodes (which carry no
 *      position at all) have a coarse Z, and we have been throwing it away.
 *   3. Prefabs group parts into one object. ncz_prefabs.csv has 135,854 refs and NOTHING
 *      reads it. If a prefab holds a building's glass AND its walls, that is the
 *      "which windows belong to which building" link, for free.
 *
 * Rules of engagement: this reports what the data SAYS. It does not rule anything out.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const readline = require('readline');

const RAW = process.argv.includes('--raw')
  ? process.argv[process.argv.indexOf('--raw') + 1]
  : 'd:/Modding/CP2077 Mods/MyMods/map_data_export/source/raw';

const SEP = /[\\/]/;
const ARCH = /[\\/]architecture[\\/]|[\\/]megabuilding[\\/]/i;
const WIN = /window_parallax_interior|window_interior_uv/i;

function readCsv(file) {
  const lines = fs.readFileSync(path.join(RAW, file), 'utf8').split(/\r?\n/);
  const head = lines[0].split(',');
  const out = [];
  for (let i = 1; i < lines.length; i++) {
    const L = lines[i];
    if (!L) continue;
    const f = []; let cur = '', q = false;
    for (const ch of L) {
      if (ch === '"') q = !q;
      else if (ch === ',' && !q) { f.push(cur); cur = ''; }
      else cur += ch;
    }
    f.push(cur);
    const o = {}; head.forEach((h, k) => { o[h] = f[k]; });
    out.push(o);
  }
  return out;
}

const matRoot = {};
for (const m of readCsv('ncz_materials.csv')) {
  matRoot[m.path.toLowerCase()] = (m.root_mt || '').split(SEP).pop();
}

const glassMesh = new Set(), archMesh = new Set();
for (const a of readCsv('ncz_assets.csv')) {
  if (!ARCH.test(a.path)) continue;
  archMesh.add(a.id);
  const names = (a.mat_names || '').split('|');
  const paths = (a.mat_paths || '').split('|');
  const isG = names.some((n) => WIN.test(n))
    || paths.some((p) => WIN.test(p) || WIN.test(matRoot[p.toLowerCase()] || ''));
  if (isG) glassMesh.add(a.id);
}
console.log(`arch meshes ${archMesh.size}  |  glass meshes ${glassMesh.size}\n`);

const COL = {};
let first = true;
let gPos = 0, gInst = 0, gPosNodes = 0, gInstNodes = 0;
const zByGlass = {}, zByAll = {};
const prefabHasGlass = {}, prefabHasWall = {};
let glassNoPrefab = 0;
const zSpread = [];   // exact-position glass: world Z, to see the vertical distribution

const rl = readline.createInterface({
  input: fs.createReadStream(path.join(RAW, 'ncz_nodes.csv')), crlfDelay: Infinity,
});
rl.on('line', (l) => {
  if (!l) return;
  if (first) { l.split(',').forEach((h, i) => { COL[h] = i; }); first = false; return; }
  const f = l.split(',');
  const id = f[COL.asset];
  if (!archMesh.has(id)) return;
  const inst = Math.max(1, +f[COL.inst] || 1);
  const isGlass = glassMesh.has(id);
  const pf = f[COL.prefab];
  const g = (f[COL.sector] || '').split('_');
  const z = g[2];

  zByAll[z] = (zByAll[z] || 0) + inst;
  if (pf) {
    if (isGlass) prefabHasGlass[pf] = (prefabHasGlass[pf] || 0) + inst;
    else prefabHasWall[pf] = (prefabHasWall[pf] || 0) + inst;
  }
  if (!isGlass) return;

  if (inst === 1) {
    gPos += 1; gPosNodes++;
    const wz = +f[COL.z];
    if (Number.isFinite(wz)) zSpread.push(wz);
  } else { gInst += inst; gInstNodes++; }
  if (!pf) glassNoPrefab += inst;
  zByGlass[z] = (zByGlass[z] || 0) + inst;
});

rl.on('close', () => {
  const tot = gPos + gInst;

  console.log('=== 1. DO WINDOWS HAVE EXACT POSITIONS?\n');
  console.log(`  glass instances with EXACT XYZ : ${gPos.toLocaleString().padStart(9)}  (${(100 * gPos / tot).toFixed(1)}%)  from ${gPosNodes.toLocaleString()} nodes`);
  console.log(`  glass instances with NO position: ${gInst.toLocaleString().padStart(9)}  (${(100 * gInst / tot).toFixed(1)}%)  from ${gInstNodes.toLocaleString()} instanced nodes`);
  if (zSpread.length) {
    zSpread.sort((a, b) => a - b);
    const q = (p) => zSpread[Math.floor(zSpread.length * p)].toFixed(0);
    console.log(`\n  exact-position glass, world Z: p10 ${q(0.1)}  median ${q(0.5)}  p90 ${q(0.9)}  max ${zSpread[zSpread.length - 1].toFixed(0)} m`);
    console.log('  (a real vertical spread ⇒ these ARE the windows up the facades, not just ground floor)');
  }

  console.log('\n=== 2. IS THE SECTOR TAG\'S 3rd COORD A VERTICAL INDEX?\n');
  const zs = Object.keys(zByGlass).filter((z) => z !== '' && z !== 'undefined')
    .map(Number).filter(Number.isFinite).sort((a, b) => a - b);
  console.log(`  distinct 3rd-coord values on glass nodes: ${zs.length}  →  ${zs.slice(0, 14).join(', ')}${zs.length > 14 ? ' …' : ''}`);
  console.log('\n  value   glass instances   ALL arch instances');
  for (const z of zs.slice(0, 10)) {
    console.log(`   ${String(z).padStart(4)}   ${String(zByGlass[z] || 0).padStart(15)}   ${String(zByAll[z] || 0).padStart(18)}`);
  }
  console.log('\n  Many values, glass spread across them ⇒ a real vertical (or LOD/variant) index.');
  console.log('  One dominant value ⇒ it is not vertical and carries nothing for us.');

  console.log('\n=== 3. PREFABS — do they group windows WITH their building?\n');
  const withGlass = Object.keys(prefabHasGlass);
  const both = withGlass.filter((p) => prefabHasWall[p]);
  console.log(`  prefabs containing glass        : ${withGlass.length.toLocaleString()}`);
  console.log(`  ...that ALSO contain wall parts : ${both.length.toLocaleString()}   <- these are BUILDINGS`);
  console.log(`  ...glass-only prefabs           : ${(withGlass.length - both.length).toLocaleString()}`);
  console.log(`  glass instances with NO prefab  : ${glassNoPrefab.toLocaleString()}  (${(100 * glassNoPrefab / tot).toFixed(1)}%)`);
  if (both.length) {
    const ratios = both.map((p) => prefabHasGlass[p] / (prefabHasGlass[p] + prefabHasWall[p])).sort((a, b) => a - b);
    const q = (x) => (100 * ratios[Math.floor(ratios.length * x)]).toFixed(1);
    console.log(`\n  PER-BUILDING glass share (glass parts / all parts, within one prefab):`);
    console.log(`    p10 ${q(0.1)}%   median ${q(0.5)}%   p90 ${q(0.9)}%`);
    console.log('    ⇒ THIS is the number the shader wants — per building, not per district.');
  }
});
