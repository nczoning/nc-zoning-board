#!/usr/bin/env node
/**
 * scripts/find_instanced_glass.js
 * ─────────────────────────────────────────────────────────────────────────
 * Pick a concrete TEST CASE for the one unverified assumption in the night model:
 *
 *   "An InstancedMesh node's per-copy transforms live in worldTransformsBuffer,
 *    which WolvenKit will not expand."
 *
 * That claim is INHERITED and has never been tested. It is why 88.7% of Night City's
 * window glass has no position, and therefore why the window model is still statistical
 * instead of placed. If the buffer CAN be read, the placement model gets exact positions
 * for the whole city.
 *
 * This finds the biggest single instanced GLASS node — one node, many window copies, and a
 * recorded Position of (0,0,0) — so it can be opened in WolvenKit and looked at directly.
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

const glass = {};
for (const a of readCsv('ncz_assets.csv')) {
  if (!ARCH.test(a.path)) continue;
  const names = (a.mat_names || '').split('|');
  const paths = (a.mat_paths || '').split('|');
  const isG = names.some((n) => WIN.test(n))
    || paths.some((p) => WIN.test(p) || WIN.test(matRoot[p.toLowerCase()] || ''));
  if (isG) glass[a.id] = a.path.replace(/^"|"$/g, '');
}

const rows = [];
const COL = {};
let first = true;
const rl = readline.createInterface({
  input: fs.createReadStream(path.join(RAW, 'ncz_nodes.csv')), crlfDelay: Infinity,
});
rl.on('line', (l) => {
  if (!l) return;
  if (first) { l.split(',').forEach((h, i) => { COL[h] = i; }); first = false; return; }
  const f = l.split(',');
  const id = f[COL.asset];
  if (!glass[id]) return;
  const inst = +f[COL.inst] || 1;
  if (inst < 2) return;
  rows.push({
    inst, sector: f[COL.sector], asset: glass[id], type: f[COL.type],
    pos: `(${f[COL.x]}, ${f[COL.y]}, ${f[COL.z]})`,
  });
});

rl.on('close', () => {
  rows.sort((a, b) => b.inst - a.inst);
  console.log('BIGGEST INSTANCED GLASS NODES — one node, many window copies, no position.\n');
  console.log('Open the sector in WolvenKit, find the node with this mesh, and look at it.\n');
  for (const r of rows.slice(0, 5)) {
    console.log(`  sector : exterior_${r.sector}_0.streamingsector`);
    console.log(`  node   : ${r.type}   — ${r.inst} copies in this ONE node`);
    console.log(`  Position recorded: ${r.pos}   <-- the whole problem`);
    console.log(`  mesh   : ${r.asset}`);
    console.log('');
  }
  const totalInst = rows.reduce((s, r) => s + r.inst, 0);
  console.log(`(${rows.length.toLocaleString()} instanced glass nodes city-wide, ${totalInst.toLocaleString()} window copies with no position.)`);
});
