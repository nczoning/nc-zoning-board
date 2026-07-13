#!/usr/bin/env node
/**
 * scripts/glass_prefab_level.js
 * ─────────────────────────────────────────────────────────────────────────
 * DOES A GLASS NODE'S PREFAB REF NAME A BUILDING, OR A SECTOR?
 *
 * The placement model assumes `ncz_prefabs.csv` supplies BUILDING IDENTITY — "which
 * windows belong to which building". That assumption has never been tested, and there
 * is an obvious way for it to be false:
 *
 *   An INSTANCED node is a RENDERING batch, not a building. If the exporter batched
 *   every window pane in a sector into one worldInstancedMeshNode, that node has ONE
 *   nodeData entry, hence ONE prefab ref — and it would be the sector's architecture
 *   bucket, not any individual building. Every pane in the sector would then "belong"
 *   to the same prefab, and per-building glass share would be measuring a sector.
 *
 * 88.7% of glass instances are instanced, so if this is true it is true of nearly all
 * of the windows, and the prefab channel is worthless for identity (we would join panes
 * to buildings by POSITION instead — which we can now do).
 *
 * The test, on data already on disk:
 *
 *   For glass nodes, split by instanced vs not, ask what their prefab ref's LAST segment
 *   is named and how many INSTANCES share a single ref. A ref shared by 800 panes with a
 *   name like `..._architecture_prefab...` is a sector bucket. A ref shared by ~20 panes
 *   named `megabuilding_h11_...` is a building.
 *
 * Reports. Decides nothing.
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

// prefab id → ref path
const refOf = {};
for (const p of readCsv('ncz_prefabs.csv')) refOf[p.id] = p.ref;

// Which meshes are glass? (same classifier window_where.js uses: the resolved .mi → .mt
// chain, never a regex on the mesh name — a glass panel's material is `..._h400_w300_mlt.mi`
// and carries no window name at all.)
const matRoot = {};
for (const m of readCsv('ncz_materials.csv')) {
  matRoot[m.path.toLowerCase()] = (m.root_mt || '').split(SEP).pop();
}
const glassMesh = new Set();
for (const a of readCsv('ncz_assets.csv')) {
  if (!ARCH.test(a.path)) continue;
  const names = (a.mat_names || '').split('|');
  const paths = (a.mat_paths || '').split('|');
  if (names.some((n) => WIN.test(n))
   || paths.some((p) => WIN.test(p) || WIN.test(matRoot[p.toLowerCase()] || ''))) glassMesh.add(a.id);
}

const COL = {};
let first = true;
// per prefab ref: how many GLASS instances hang off it, and from how many nodes
const inst = {}, nodes = {};
let noRef = 0, instTot = 0, singleTot = 0;

const rl = readline.createInterface({
  input: fs.createReadStream(path.join(RAW, 'ncz_nodes.csv')), crlfDelay: Infinity,
});
rl.on('line', (l) => {
  if (!l) return;
  if (first) { l.split(',').forEach((h, i) => { COL[h] = i; }); first = false; return; }
  const f = l.split(',');
  if (!glassMesh.has(f[COL.asset])) return;
  const n = Math.max(1, +f[COL.inst] || 1);
  if (n > 1) instTot += n; else singleTot += n;
  const pf = f[COL.prefab];
  if (!pf) { noRef += n; return; }
  inst[pf] = (inst[pf] || 0) + n;
  nodes[pf] = (nodes[pf] || 0) + 1;
});

rl.on('close', () => {
  const refs = Object.keys(inst);
  const tot = instTot + singleTot;
  console.log(`glass instances: ${tot.toLocaleString()}  (instanced ${instTot.toLocaleString()}, single ${singleTot.toLocaleString()}, no prefab ${noRef.toLocaleString()})`);
  console.log(`distinct prefab refs carrying glass: ${refs.length.toLocaleString()}\n`);

  // HOW MANY PANES SHARE ONE REF? This is the whole test.
  const per = refs.map((r) => inst[r]).sort((a, b) => a - b);
  const q = (p) => per[Math.floor(per.length * p)];
  console.log('=== GLASS INSTANCES PER PREFAB REF\n');
  console.log(`  p10 ${q(0.1)}   median ${q(0.5)}   p90 ${q(0.9)}   max ${per[per.length - 1]}`);
  console.log('\n  ~10s of panes per ref  ⇒ the ref is a BUILDING. Identity works.');
  console.log('  ~100s-1000s per ref    ⇒ the ref is a SECTOR BUCKET. Identity is a mirage;');
  console.log('                           join panes to buildings by POSITION instead.\n');

  // WHAT ARE THEY NAMED? A bucket and a building do not look alike.
  console.log('=== THE 12 REFS CARRYING THE MOST GLASS\n');
  refs.sort((a, b) => inst[b] - inst[a]);
  for (const r of refs.slice(0, 12)) {
    const segs = (refOf[r] || '?').split('/');
    const leaf = segs[segs.length - 1] || '?';
    const parent = segs[segs.length - 2] || '';
    console.log(`  ${String(inst[r]).padStart(6)} panes  ${String(nodes[r]).padStart(4)} nodes   …/${parent}/${leaf}`);
  }

  // Does the LEAF segment look like an architecture BUCKET rather than an object?
  let bucketPanes = 0, objectPanes = 0;
  for (const r of refs) {
    const leaf = ((refOf[r] || '').split('/').pop() || '');
    if (/_architecture_prefab|_subdistrict_prefab|_env_prefab/i.test(leaf)) bucketPanes += inst[r];
    else objectPanes += inst[r];
  }
  console.log('\n=== IS THE REF ITSELF A BUCKET NODE?\n');
  const s = bucketPanes + objectPanes;
  console.log(`  panes whose ref LEAF is a bucket (_architecture_/_subdistrict_/_env_): ${bucketPanes.toLocaleString()}  (${(100 * bucketPanes / s).toFixed(1)}%)`);
  console.log(`  panes whose ref LEAF is a named object                              : ${objectPanes.toLocaleString()}  (${(100 * objectPanes / s).toFixed(1)}%)`);
});
