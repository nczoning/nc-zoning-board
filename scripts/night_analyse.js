#!/usr/bin/env node
/**
 * scripts/night_analyse.js
 * ─────────────────────────────────────────────────────────────────────────
 * Offline analysis of the raw sector dump (scripts/wkit/dump_night_raw.wscript).
 *
 * ALL judgement calls live HERE, not in the wscript. That is the whole point: the
 * export is raw facts, so every classification can be revised in seconds instead of
 * costing a 15-minute re-scan. Every earlier attempt baked its assumptions into the
 * extractor and every one of them was wrong (mesh-name glass, prefab districts,
 * asset-origin as district, sign count instead of area).
 *
 * WHAT IT DOES
 *   1. Resolve every material to its ROOT SHADER  → is it a WINDOW / does it EMIT?
 *      Definitional, not name-matching: a piece is a window iff its chain roots at
 *      window_parallax_interior.mt (or window_interior_uv.mt); it is a sign iff it
 *      roots at an emissive shader (signages.mt, *_emissive*.mt, *diode*.mt) or sets
 *      a non-zero emissive parameter on an ordinary one.
 *   2. Join meshes → materials, so each mesh is glass / emissive / neither.
 *   3. Bin every placed node into a subdistrict POLYGON by its CET position.
 *      (Position, never the asset's district prefix: 59% of architecture comes from
 *       architecture\common\, placed city-wide. Asset origin is not location.)
 *   4. Report per subdistrict:
 *        GLASS SHARE  = glass instances / (glass + wall) → x0.5 = the lit fraction
 *        SIGN AREA    = emissive sign face area per km²  (a billboard is ~30 m2, a
 *                       shopfront neon ~2 m2 — counting them equally is meaningless)
 *
 * Usage:  node scripts/night_analyse.js [--raw <dir>]
 */
'use strict';

const fs = require('fs');
const path = require('path');

const RAW = process.argv.includes('--raw')
  ? process.argv[process.argv.indexOf('--raw') + 1]
  : 'd:/Modding/CP2077 Mods/MyMods/map_data_export/source/raw';
const ROOT = path.join(__dirname, '..');

// ── CSV (quoted fields, embedded commas) ────────────────────────────────────
function readCsv(file) {
  const txt = fs.readFileSync(path.join(RAW, file), 'utf8');
  const lines = txt.split(/\r?\n/);
  const head = lines[0].split(',');
  const out = [];
  for (let i = 1; i < lines.length; i++) {
    const L = lines[i];
    if (!L) continue;
    const f = [];
    let cur = '', q = false;
    for (let k = 0; k < L.length; k++) {
      const c = L[k];
      if (c === '"') q = !q;
      else if (c === ',' && !q) { f.push(cur); cur = ''; }
      else cur += c;
    }
    f.push(cur);
    const o = {};
    for (let k = 0; k < head.length; k++) o[head[k]] = f[k];
    out.push(o);
  }
  return out;
}

// ── 1. Material → root shader → what does it DO? ────────────────────────────
// The game's own shader families, learned from the resolved chains (PASS A), not
// guessed. `signages.mt` in particular was never found by searching .mt names for
// "emissive" or "sign" — it only surfaced by walking the chain.
const WINDOW_MT   = /window_parallax_interior|window_interior_uv/i;
const EMISSIVE_MT = /signages|emissive|diode|earth_globe_lights|vehicle_lights/i;
// …and an ordinary shader (multilayered.mt et al.) that SETS an emissive value still
// glows. Both routes count.
const EMISSIVE_PARAM = /^(emissive|glow)/i;

function classifyMaterials() {
  const mats = readCsv('ncz_materials.csv');
  const byPath = {};
  let win = 0, emi = 0;
  for (const m of mats) {
    const root = (m.root_mt || '').split('\\').pop();
    const params = {};
    for (const kv of (m.params || '').split('|')) {
      if (!kv) continue;
      const i = kv.indexOf('=');
      if (i > 0) params[kv.slice(0, i)] = kv.slice(i + 1);
    }
    let emissiveByParam = false;
    for (const k in params) {
      if (!EMISSIVE_PARAM.test(k)) continue;
      const v = parseFloat(params[k]);
      if (Number.isFinite(v) ? v > 0 : true) { emissiveByParam = true; break; }
    }
    const isWindow = WINDOW_MT.test(root);
    const isEmissive = EMISSIVE_MT.test(root) || emissiveByParam;
    if (isWindow) win++;
    if (isEmissive) emi++;
    byPath[m.path.toLowerCase()] = { root, isWindow, isEmissive, params };
  }
  console.log(`materials: ${mats.length}  |  window ${win}  |  emissive ${emi}`);
  return byPath;
}

// ── 2. Mesh → its materials → glass / emissive ──────────────────────────────
// A mesh is glass if ANY material it references is a window material. Chunk-material
// NAMES are matched too, because a mesh can name `window_parallax_interior` directly
// as a chunk material without an external .mi (that is exactly how Corpo Plaza's
// bespoke towers carry their glass — and why the mesh-NAME test read them as 4%).
function classifyMeshes(matByPath) {
  const assets = readCsv('ncz_assets.csv');
  const byId = {};
  let glass = 0, emissive = 0;
  for (const a of assets) {
    const names = (a.mat_names || '').split('|').filter(Boolean);
    const paths = (a.mat_paths || '').split('|').filter(Boolean);
    let isGlass = false, isEmissive = false;
    for (const n of names) {
      if (WINDOW_MT.test(n)) isGlass = true;
      if (EMISSIVE_MT.test(n)) isEmissive = true;
    }
    for (const p of paths) {
      const m = matByPath[p.toLowerCase()];
      if (m) { if (m.isWindow) isGlass = true; if (m.isEmissive) isEmissive = true; }
      else { if (WINDOW_MT.test(p)) isGlass = true; if (EMISSIVE_MT.test(p)) isEmissive = true; }
    }
    if (isGlass) glass++;
    if (isEmissive) emissive++;
    byId[a.id] = { path: a.path, isGlass, isEmissive };
  }
  console.log(`meshes:    ${assets.length}  |  glass ${glass}  |  emissive ${emissive}`);
  return byId;
}

// ── 3. Subdistrict polygons (CET) ───────────────────────────────────────────
function loadPolys() {
  const sub = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/subdistricts.json'), 'utf8'));
  const polys = [];
  const area = (r) => {
    let a = 0;
    for (let i = 0, n = r.length; i < n; i++) {
      const [x1, y1] = r[i], [x2, y2] = r[(i + 1) % n];
      a += x1 * y2 - x2 * y1;
    }
    return Math.abs(a / 2);
  };
  for (const d of sub.districts) {
    const kids = d.subdistricts || [];
    if (!kids.length) polys.push({ id: d.id, ring: d.polygon, area: area(d.polygon) });
    for (const s of kids) polys.push({ id: s.id, ring: s.polygon, area: area(s.polygon) });
  }
  polys.sort((a, b) => a.area - b.area);   // smallest wins → a subdistrict beats its parent
  // Bounding box per polygon. Without it, 2.4M nodes x ~29 polygons x hundreds of
  // vertices is billions of ray-casts and the run never finishes; the box rejects
  // almost every (node, polygon) pair in four comparisons.
  for (const p of polys) {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const [x, y] of p.ring) {
      if (x < x0) x0 = x; if (x > x1) x1 = x;
      if (y < y0) y0 = y; if (y > y1) y1 = y;
    }
    p.bb = [x0, y0, x1, y1];
  }
  return polys;
}
const inPoly = (x, y, r) => {
  let c = false;
  for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
    const [xi, yi] = r[i], [xj, yj] = r[j];
    if (((yi > y) !== (yj > y)) && (x < (xj - xi) * (y - yi) / (yj - yi) + xi)) c = !c;
  }
  return c;
};

// ── 4. Walk the nodes ───────────────────────────────────────────────────────
// A WALL is a facade piece that is NOT glass. The glass share is glass/(glass+wall),
// and only architecture counts — props, vehicles and street furniture are not facade.
const ARCH = /[\\/]architecture[\\/]|[\\/]megabuilding[\\/]/i;

// SIGNAGE = it EMITS *and* it IS SIGNAGE. Both tests are needed, and neither is a fudge.
//
// The material answers "does it glow" — definitionally, via the shader chain. It does not
// answer "is it a sign". Emissive alone counts vending machines (39,780 m2 — the single
// largest emitter in the city), servers (38,481), stand generators, spotlights, wall lamps
// and BEER KEGS. 98.4% of all emissive area is environment\decoration\ props. The material
// never lied: a vending machine really does have a glowing screen. I asked the wrong
// question. It ranked empty Badlands (Red Peaks) as the city's second-loudest district.
//
// So the shader says WHETHER it emits; the asset tree says WHAT it is. Our map renders
// buildings, windows and signage — it does not render vending machines.
const SIGNAGE = /[\\/]advertising[\\/]|signage|billboard|neon_|screen_\d/i;
// LOD0 streaming-sector cell size in CET metres. Verified: sector exterior_-15_-2_0_1's
// own node positions fall inside [-15*128, -14*128] — the grid coord times the cell size.
// LOD0 is half that: 64 m.
const SECTOR_M = 64;
const APPEARANCE_OFF = /windows_off|_off$/i;

async function main() {
  const matByPath = classifyMaterials();
  const meshById = classifyMeshes(matByPath);
  const polys = loadPolys();
  const apps = {};
  for (const a of readCsv('ncz_appearances.csv')) apps[a.id] = a.appearance;

  // ── PRE-PASS: learn each asset's TRUE size from its non-instanced placements ──
  // An instanced node's bounds enclose all its copies, so they cannot size one copy. But
  // most assets also appear singly somewhere in the city, and there the bounds ARE the
  // object. Take the median across those (median, not mean: a few nodes have degenerate
  // zero bounds, and one bad outlier should not set an asset's size).
  const assetArea = {};
  {
    const samples = {};
    const rl0 = require('readline').createInterface({
      input: fs.createReadStream(path.join(RAW, 'ncz_nodes.csv')), crlfDelay: Infinity,
    });
    let f0 = true; const C0 = {};
    rl0.on('line', (line) => {
      if (!line) return;
      if (f0) { line.split(',').forEach((h, i) => { C0[h] = i; }); f0 = false; return; }
      const f = line.split(',');
      if ((+f[C0.inst] || 1) !== 1) return;          // only singly-placed copies can size an asset
      const bw = +f[C0.bw] || 0, bh = +f[C0.bh] || 0, bd = +f[C0.bd] || 0;
      const face = Math.max(bw * bh, bw * bd, bh * bd);
      if (!(face > 0)) return;
      (samples[f[C0.asset]] || (samples[f[C0.asset]] = [])).push(face);
    });
    await new Promise((res) => rl0.on('close', res));
    for (const id in samples) {
      const s = samples[id].sort((a, b) => a - b);
      assetArea[id] = s[Math.floor(s.length / 2)];
    }
    console.log(`asset sizes: ${Object.keys(assetArea).length} learned from single placements\n`);
  }

  const tally = {};
  let total = 0, n = 0, outside = 0, viaSector = 0, noArea = 0;

  // ncz_nodes.csv is ~2.4M rows / ~270 MB. Parsing it into objects would cost GBs, so
  // it is STREAMED line-by-line with positional field access. The columns are fixed and
  // never quoted (ids and numbers only), so a plain split is safe here — unlike the
  // other files, which carry quoted paths.
  const COL = {};
  const rl = require('readline').createInterface({
    input: fs.createReadStream(path.join(RAW, 'ncz_nodes.csv')),
    crlfDelay: Infinity,
  });
  let first = true;
  rl.on('line', (line) => {
    if (!line) return;
    if (first) {
      line.split(',').forEach((h, i) => { COL[h] = i; });
      first = false;
      return;
    }
    total++;
    const f = line.split(',');
    const mesh = meshById[f[COL.asset]];
    if (!mesh) return;
    const inst = Math.max(1, +f[COL.inst] || 1);

    // POSITION, OR THE SECTOR IF THERE ISN'T ONE.
    //
    // An InstancedMesh node has NO position: nodeData.Position is (0,0,0), because the
    // real per-instance transforms live in a binary buffer WolvenKit will not expand.
    // That is 602,812 nodes — 24% of the city, but carrying 2,172,830 instances, i.e.
    // 54% of EVERY placed instance, and essentially all the kit-bashed facade panels.
    //
    // Binning them at (0,0) silently dumped the entire lot into whichever subdistrict
    // contains the origin (Charter Hill), which read 975,883 wall instances — an order
    // of magnitude more than every other district combined — and made Dogtown the
    // loudest sign district and empty Badlands the second. Obvious nonsense, which is
    // the only reason it got caught.
    //
    // The node still knows its SECTOR, and a LOD0 sector is a 64 m cell. Its centre is a
    // ±32 m position — far finer than districts, which are hundreds of metres across. So
    // fall back to it. Exact placement of instanced copies is still unavailable (that
    // needs the transforms buffer), but DENSITY per district is fully recovered.
    let x = +f[COL.x], y = +f[COL.y];
    if (!Number.isFinite(x) || !Number.isFinite(y) || (x === 0 && y === 0)) {
      const g = (f[COL.sector] || '').split('_');
      const gx = +g[0], gy = +g[1];
      if (!Number.isFinite(gx) || !Number.isFinite(gy)) return;
      x = (gx + 0.5) * SECTOR_M;
      y = (gy + 0.5) * SECTOR_M;
      viaSector++;
    }

    let hit = null;
    for (const p of polys) {
      const b = p.bb;
      if (x < b[0] || x > b[2] || y < b[1] || y > b[3]) continue;   // cheap reject first
      if (inPoly(x, y, p.ring)) { hit = p; break; }
    }
    if (!hit) { outside++; return; }
    n++;
    const t = tally[hit.id] || (tally[hit.id] = { area: hit.area, glass: 0, glassOff: 0, wall: 0, signArea: 0, signs: 0 });

    const isArch = ARCH.test(mesh.path);
    if (isArch) {
      const off = APPEARANCE_OFF.test(apps[f[COL.app]] || '');
      if (mesh.isGlass) { if (off) t.glassOff += inst; else t.glass += inst; }
      else t.wall += inst;
    }
    // EMITS *and* IS SIGNAGE (see SIGNAGE above). Weighted by AREA — a billboard is ~30 m2
    // against a shopfront neon's ~2 m2; counting them equally is meaningless.
    //
    // AREA COMES FROM THE ASSET, NOT THE NODE'S BOUNDS. On an INSTANCED node the bounds
    // enclose ALL its copies spread across a block, so `bounds x instances` double-counts
    // wildly: it gave a single deco-font LETTER 32 m2, and a grocery sign 667 m2. Instead
    // each asset's true size is learned from its non-instanced (inst == 1) placements —
    // see `assetArea` — and multiplied by the instance count.
    if (mesh.isEmissive && !isArch && SIGNAGE.test(mesh.path)) {
      const a = assetArea[f[COL.asset]];
      if (a !== undefined) { t.signArea += a * inst; t.signs += inst; }
      else noArea += inst;   // never seen singly — cannot size it. Counted, not measured.
    }
  });
  await new Promise((res) => rl.on('close', res));
  console.log(`nodes:     ${total}  |  binned ${n}  |  outside all polygons ${outside}`);
  console.log(`           ${viaSector} placed by SECTOR CENTRE (instanced nodes carry no position) — +-32 m, fine for districts\n`);

  const rows = Object.entries(tally).map(([id, t]) => ({
    id,
    km2: t.area / 1e6,
    glass: t.glass, wall: t.wall, off: t.glassOff,
    share: (t.glass + t.wall) ? t.glass / (t.glass + t.wall) : 0,
    signs: t.signs,
    signM2PerKm2: t.signArea / (t.area / 1e6),
  })).filter((r) => r.glass + r.wall + r.signs > 0);

  const maxSign = Math.max(...rows.map((r) => r.signM2PerKm2), 1);

  console.log('WINDOWS — glass share x 0.5 = the lit fraction (the game sets 0.5 for every archetype)\n');
  console.log('subdistrict'.padEnd(24), 'glass'.padStart(8), 'wall'.padStart(8), 'off'.padStart(6), 'share'.padStart(7), 'LIT'.padStart(6));
  console.log('-'.repeat(64));
  for (const r of [...rows].sort((a, b) => b.share - a.share)) {
    console.log(r.id.padEnd(24), String(r.glass).padStart(8), String(r.wall).padStart(8), String(r.off).padStart(6),
      (100 * r.share).toFixed(1).padStart(6) + '%', (r.share * 0.5).toFixed(3).padStart(6));
  }

  console.log('\nSIGNS — emissive AREA per km2 (NOT count: a billboard is ~30 m2, a neon ~2 m2)\n');
  console.log('subdistrict'.padEnd(24), 'signs'.padStart(7), 'm2/km2'.padStart(10), 'ORDINAL'.padStart(8));
  console.log('-'.repeat(54));
  for (const r of [...rows].sort((a, b) => b.signM2PerKm2 - a.signM2PerKm2)) {
    if (!r.signs) continue;
    console.log(r.id.padEnd(24), String(r.signs).padStart(7), r.signM2PerKm2.toFixed(0).padStart(10),
      (r.signM2PerKm2 / maxSign).toFixed(2).padStart(8));
  }
}

main();
