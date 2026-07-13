#!/usr/bin/env node
/**
 * scripts/window_expand.js
 * ─────────────────────────────────────────────────────────────────────────
 * FIND THE WINDOW MATERIALS WE MISSED.
 *
 * We know two window shaders — window_parallax_interior.mt and window_interior_uv.mt —
 * and we found them by searching .mt names. That is a NAME search, and this project has
 * a wiki page about what name searches do. Night City has several different window
 * SHAPES; there is no reason to believe two shaders cover them all.
 *
 * So work the other way: take the meshes we KNOW are windows (they root at one of the two
 * confirmed shaders), and look at every OTHER material those same meshes carry. A window
 * panel mesh that also carries an unknown emissive material is telling us that material is
 * probably window-ish too — a different pane shape in the same kit piece.
 *
 * Then expand: which OTHER meshes carry those co-occurring materials, and do they look
 * like windows (architecture, panel-shaped)? That is a graph walk, not a regex.
 *
 * Reports candidates ranked by how much placed AREA they would add — because a shader on
 * three meshes is a curiosity and a shader on thirty thousand is a hole in the model.
 */
'use strict';
const fs = require('fs'), path = require('path');
const RAW = 'd:/Modding/CP2077 Mods/MyMods/map_data_export/source/raw';

function readCsv(file) {
  const txt = fs.readFileSync(path.join(RAW, file), 'utf8');
  const lines = txt.split(/\r?\n/);
  const head = lines[0].split(',');
  const out = [];
  for (let i = 1; i < lines.length; i++) {
    const L = lines[i]; if (!L) continue;
    const f = []; let cur = '', q = false;
    for (let k = 0; k < L.length; k++) {
      const c = L[k];
      if (c === '"') q = !q;
      else if (c === ',' && !q) { f.push(cur); cur = ''; }
      else cur += c;
    }
    f.push(cur);
    const o = {}; for (let k = 0; k < head.length; k++) o[head[k]] = f[k];
    out.push(o);
  }
  return out;
}

const KNOWN_WINDOW = /window_parallax_interior|window_interior_uv/i;
const ARCH = /[\\/]architecture[\\/]|[\\/]megabuilding[\\/]/i;
const baseName = (p) => p.split(/[\\/]/).pop();

// 1. materials → root shader + params
const mats = readCsv('ncz_materials.csv');
const matByPath = {};
for (const m of mats) {
  const params = {};
  for (const kv of (m.params || '').split('|')) {
    if (!kv) continue;
    const i = kv.indexOf('=');
    if (i > 0) params[kv.slice(0, i)] = kv.slice(i + 1);
  }
  matByPath[m.path.toLowerCase()] = { path: m.path, root: baseName(m.root_mt || ''), params };
}

// 2. meshes: which are KNOWN windows, and what else do they carry?
const assets = readCsv('ncz_assets.csv');
const meshMats = {};        // asset id → [material path]
const knownWindowMesh = new Set();
for (const a of assets) {
  const paths = (a.mat_paths || '').split('|').filter(Boolean);
  const names = (a.mat_names || '').split('|').filter(Boolean);
  meshMats[a.id] = { paths, names, path: a.path };
  const isWin = names.some((n) => KNOWN_WINDOW.test(n))
    || paths.some((p) => KNOWN_WINDOW.test(p) || KNOWN_WINDOW.test(matByPath[p.toLowerCase()]?.root || ''));
  if (isWin && ARCH.test(a.path)) knownWindowMesh.add(a.id);
}

// 3. CO-OCCURRENCE: what root shaders live on the same meshes as a known window?
const coRoot = {};   // root .mt → { meshes:Set, sampleMats:Set }
for (const id of knownWindowMesh) {
  for (const p of meshMats[id].paths) {
    const m = matByPath[p.toLowerCase()];
    const root = m ? m.root : baseName(p);
    if (!root || KNOWN_WINDOW.test(root)) continue;
    const r = coRoot[root] || (coRoot[root] = { meshes: new Set(), mats: new Set() });
    r.meshes.add(id);
    r.mats.add(m ? m.path : p);
  }
}

console.log(`known window meshes (architecture): ${knownWindowMesh.size}\n`);
console.log('ROOT SHADERS THAT SHARE A MESH WITH A CONFIRMED WINDOW\n');
console.log('  Ranked by how many window meshes also carry them. A shader on nearly EVERY');
console.log('  window mesh is the kit\'s frame/wall material, not another window. The interesting');
console.log('  ones sit in the middle: on many window meshes, but not all.\n');
console.log('  ' + 'root .mt'.padEnd(38) + 'on N window meshes'.padStart(20));
console.log('  ' + '-'.repeat(58));
for (const [root, r] of Object.entries(coRoot).sort((a, b) => b[1].meshes.size - a[1].meshes.size).slice(0, 20)) {
  console.log('  ' + root.padEnd(38) + String(r.meshes.size).padStart(20)
    + (r.meshes.size === knownWindowMesh.size ? '  <- ALL of them' : ''));
}

// 4. The real question: which of these look EMISSIVE / window-ish by their PARAMS?
//    A window material fakes a lit interior — it will carry night/interior/room params.
const WINDOWY = /night|room|interior|emissive|glow|lightstemp|tintcolor/i;
console.log('\n\nCANDIDATE WINDOW SHADERS — co-occurring roots whose MATERIALS carry window-ish params');
console.log('  (AmountTurnOffAtNight / TintColorAtNight / roomWidth / EmissiveEV ...)\n');
for (const [root, r] of Object.entries(coRoot)) {
  const hits = {};
  for (const mp of r.mats) {
    const m = matByPath[mp.toLowerCase()];
    if (!m) continue;
    for (const k in m.params) if (WINDOWY.test(k)) hits[k] = (hits[k] || 0) + 1;
  }
  const keys = Object.keys(hits);
  if (!keys.length) continue;
  console.log(`  ${root}`);
  console.log(`     on ${r.meshes.size} window meshes, ${r.mats.size} materials`);
  console.log(`     window-ish params: ${keys.slice(0, 8).join(', ')}`);
}

// ── 5. THE EXPANSION — the point of the whole exercise ─────────────────────
// A candidate shader matters only if it appears on ARCHITECTURE meshes that we are NOT
// already counting as windows. Those meshes are the hole in the model: real windows the
// glass share never saw. Weighted by PLACED AREA, because a shader on three meshes is a
// curiosity and a shader on thirty thousand placements is a missing district.
const rootToMeshes = {};
for (const a of assets) {
  if (!ARCH.test(a.path)) continue;
  const paths = (a.mat_paths || '').split('|').filter(Boolean);
  const roots = new Set(paths.map((p) => matByPath[p.toLowerCase()]?.root || baseName(p)));
  for (const rt of roots) (rootToMeshes[rt] || (rootToMeshes[rt] = new Set())).add(a.id);
}

// Placed instance count per mesh — so "would add N placements" is real, not hypothetical.
const placed = {};
{
  const rl = require('readline').createInterface({
    input: fs.createReadStream(path.join(RAW, 'ncz_nodes.csv')), crlfDelay: Infinity,
  });
  let first = true; const C = {};
  rl.on('line', (l) => {
    if (!l) return;
    if (first) { l.split(',').forEach((h, i) => { C[h] = i; }); first = false; return; }
    const f = l.split(',');
    const inst = Math.max(1, +f[C.inst] || 1);
    placed[f[C.asset]] = (placed[f[C.asset]] || 0) + inst;
  });
  rl.on('close', report);
}

function report() {
  console.log('\n\nTHE EXPANSION — architecture meshes carrying a candidate shader that we are');
  console.log('NOT already counting as windows. These are the hole.\n');
  console.log('  ' + 'root .mt'.padEnd(30) + 'arch meshes'.padStart(12) + 'NEW'.padStart(7)
    + 'placements'.padStart(12) + '   verdict');
  console.log('  ' + '-'.repeat(78));
  const cands = Object.keys(coRoot)
    .filter((r) => !/multilayered|metal_base|_decal(?!_parallax)/i.test(r));
  const rows = [];
  for (const root of cands) {
    const all = rootToMeshes[root] || new Set();
    const fresh = [...all].filter((id) => !knownWindowMesh.has(id));
    const newPlacements = fresh.reduce((s, id) => s + (placed[id] || 0), 0);
    rows.push({ root, all: all.size, fresh: fresh.length, newPlacements });
  }
  for (const r of rows.sort((a, b) => b.newPlacements - a.newPlacements)) {
    const verdict = r.newPlacements > 20000 ? 'INVESTIGATE — big'
      : r.newPlacements > 2000 ? 'worth a look'
      : 'negligible';
    console.log('  ' + r.root.padEnd(30) + String(r.all).padStart(12) + String(r.fresh).padStart(7)
      + String(r.newPlacements).padStart(12) + '   ' + verdict);
  }
  console.log('\n  arch meshes = total architecture meshes carrying this shader');
  console.log('  NEW         = those NOT already classed as windows (the hole)');
  console.log('  placements  = how many placed instances those NEW meshes account for\n');
}
