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
 *        GLASS SHARE  = glass AREA / (glass + wall) AREA → x0.5 = the lit fraction
 *        SIGN AREA    = emissive sign face area per km²  (a billboard is ~30 m2, a
 *                       shopfront neon ~2 m2 — counting them equally is meaningless)
 *   5. Harvest the game's own window parameters as a HISTOGRAM, and emit the whole
 *      lot to data/night-profile.json for the renderer to fetch.
 *
 * AREA, NOT COUNT — the bug this file already fixed once, in the other half.
 *   The share the SHADER needs is "what fraction of the facade is glass". Counting
 *   instances answers a different question — "what fraction of placed PIECES are glass
 *   pieces" — and the two agree only if every piece is the same size. They are not:
 *   Corpo Plaza's bespoke towers carry glass as CHUNK MATERIALS on single huge meshes
 *   (one instance, vast area), while Kabuki and Charter Hill are kit-bashed from many
 *   small panels (many instances, small area each). Counting therefore systematically
 *   UNDER-weights monolithic glass and OVER-weights kit-bash.
 *
 *   The sign pass below already learned this and switched to area, with a comment
 *   saying counts are meaningless. The glass pass, ten lines above it, kept counting —
 *   and produced a table where Charter Hill (35.6%) out-glasses Corpo Plaza (27.9%),
 *   which the maintainer's own footage contradicts. Both shares are now emitted so the
 *   correction is visible rather than asserted.
 *
 * Usage:  node scripts/night_analyse.js [--raw <dir>] [--emit <file>]
 *         --emit writes data/night-profile.json (the artefact the scene fetches).
 */
'use strict';

const fs = require('fs');
const path = require('path');

const RAW = process.argv.includes('--raw')
  ? process.argv[process.argv.indexOf('--raw') + 1]
  : 'd:/Modding/CP2077 Mods/MyMods/map_data_export/source/raw';
const EMIT = process.argv.includes('--emit')
  ? process.argv[process.argv.indexOf('--emit') + 1]
  : null;
const ROOT = path.join(__dirname, '..');

// A district row built on a handful of pieces is noise wearing a percentage sign.
// Below this, the row still ships but is flagged `low-sample` / confidence: low.
const MIN_ARCH_SAMPLES = 2000;

// How much of the placed glass area a parameter value must cover before we treat it as
// "the game's rule" rather than "the common case". A handful of special-case materials
// (a lobby that never darkens, one that always does) should not overturn a rule that 95%
// of the city's glass obeys — but a 60/40 split is not a rule, it is a variable we are
// about to hard-code as a constant. This is where that line sits.
const CLAIM_DOMINANCE = 0.90;

// subId → districtId. Filled by loadPolys(); a key absent here is a DISTRICT-level row
// (dogtown, ncx_morro_rock — the two with no subdistricts of their own).
const PARENT = {};
let MAT_N = 0, MESH_N = 0;

// The committed, hand-tuned sign profile — read so the measurement can be compared
// against it MECHANICALLY, and so a disagreement lands in the artefact as a flag rather
// than in a comment nobody re-reads. It is NOT overwritten: the LLM-verified bands (127
// curated shots) and the sector measurement are two measurements of different things,
// and where they disagree that is a finding, not a bug to paper over.
const TUNED_SIGN = (() => {
  const src = fs.readFileSync(path.join(ROOT, 'assets/js/constants.js'), 'utf8');
  const at = src.indexOf('NCZ.SIGN_DENSITY_PROFILE');
  if (at < 0) return {};
  const open = src.indexOf('{', at);
  let depth = 0, end = open;
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}' && --depth === 0) { end = i + 1; break; }
  }
  try { return eval(`(${src.slice(open, end)})`); } catch { return {}; }
})();

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

// The game's OWN window parameters, harvested across every window material as a
// HISTOGRAM — not a first sample.
//
// "AmountTurnOffAtNight = 0.5, identical for every archetype" is the load-bearing claim
// of the whole rebuild: it is the second term of `lit = glass_share x 0.5`. It is also
// still a CLAIM. If this histogram comes back with more than one value, the claim is
// false, the model is wrong, and we find that out here — offline, in ten seconds, for
// free — rather than by tuning a shader against it for a week.
const WINDOW_PARAM = /^(amountturnoffatnight|tintcoloratnight|lightstempvariationatnight|emissiveev|roomwidth|roomheight|roomdepth)$/i;

function classifyMaterials() {
  const mats = readCsv('ncz_materials.csv');
  const byPath = {};
  const gameParams = {};   // canonical param name → { rawValue: count }
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
    if (isWindow) {
      for (const k in params) {
        if (!WINDOW_PARAM.test(k)) continue;
        const canon = k.toLowerCase();
        (gameParams[canon] || (gameParams[canon] = {}));
        const v = params[k];
        gameParams[canon][v] = (gameParams[canon][v] || 0) + 1;
      }
    }
    byPath[m.path.toLowerCase()] = { root, isWindow, isEmissive, params };
  }
  MAT_N = mats.length;
  console.log(`materials: ${mats.length}  |  window ${win}  |  emissive ${emi}`);
  return { byPath, gameParams };
}

// The AREA-WEIGHTED MEAN of a numeric histogram — and for a PROBABILITY parameter this,
// not the mode, is the number the shader wants.
//
// The shader has one global constant where the game has a distribution. The mode throws
// away the tail; the mean is the unbiased estimate of what the city actually does. When
// the distribution is nearly a spike (roomHeight: 4 on 97% of glass) mean and mode agree
// and the choice is moot. When it is not (roomWidth: 3/4/6, no value over 41%) the mean is
// the only honest single number — and the spread, which is reported next to it, is the
// warning that a single number is a compromise at all.
function meanOf(hist) {
  if (!hist) return null;
  let sum = 0, w = 0;
  for (const [k, v] of Object.entries(hist)) {
    const x = parseFloat(k);
    if (!Number.isFinite(x)) return null;      // non-numeric (a colour) — no mean exists
    sum += x * v; w += v;
  }
  return w ? sum / w : null;
}

// Collapse a histogram to its modal value + how dominant that mode is.
function modeOf(hist) {
  if (!hist) return null;
  const entries = Object.entries(hist).sort((a, b) => b[1] - a[1]);
  const total = entries.reduce((s, e) => s + e[1], 0);
  return {
    value: entries[0][0],
    share: entries[0][1] / total,
    distinct: entries.length,
    unanimous: entries.length === 1,
    dist: Object.fromEntries(entries.slice(0, 8)),
  };
}

// ── 2. Mesh → its materials → glass / emissive ──────────────────────────────
// A mesh is glass if ANY material it references is a window material. Chunk-material
// NAMES are matched too, because a mesh can name `window_parallax_interior` directly
// as a chunk material without an external .mi (that is exactly how Corpo Plaza's
// bespoke towers carry their glass — and why the mesh-NAME test read them as 4%).
function classifyMeshes(matByPath) {
  const assets = readCsv('ncz_assets.csv');
  const byId = {};
  let glass = 0, emissive = 0, boxed = 0;
  for (const a of assets) {
    // THE ASSET'S OWN BOUNDING BOX — local, exact, and present for every mesh.
    //
    // This replaces an entire pre-pass that tried to LEARN each asset's size and
    // orientation from its non-instanced placements, using the node's `Bounds` field.
    // That field is populated on 1.9% of nodes (InstancedMesh: 0.0%), so the "learned"
    // sizes were a 2% sample nobody had checked was a sample — and they swung the
    // district glass shares 2x when a single filter changed. A mesh knows its own size.
    // Ask the mesh.
    //
    // Local dims x the node's Scale = the placed object's real box. That works for an
    // INSTANCED node too — every copy is the same mesh at the same scale — so area
    // coverage goes from ~76% to ~100%. Only ORIENTATION still needs a quaternion, which
    // instanced nodes genuinely lack.
    const bx = [+a.bbx0, +a.bby0, +a.bbz0, +a.bbx1, +a.bby1, +a.bbz1];
    const hasBox = bx.every(Number.isFinite) && bx[3] > bx[0] && bx[4] > bx[1] && bx[5] > bx[2];
    const dims = hasBox ? [bx[3] - bx[0], bx[4] - bx[1], bx[5] - bx[2]] : null;
    if (dims) boxed++;
    const names = (a.mat_names || '').split('|').filter(Boolean);
    const paths = (a.mat_paths || '').split('|').filter(Boolean);
    let isGlass = false, isEmissive = false;
    const winMats = [];   // the WINDOW materials this mesh actually uses — so the game's
                          // params can be weighted by the glass AREA that carries them.
    for (const n of names) {
      if (WINDOW_MT.test(n)) isGlass = true;
      if (EMISSIVE_MT.test(n)) isEmissive = true;
    }
    for (const p of paths) {
      const m = matByPath[p.toLowerCase()];
      if (m) {
        if (m.isWindow) { isGlass = true; winMats.push(m); }
        if (m.isEmissive) isEmissive = true;
      } else {
        if (WINDOW_MT.test(p)) isGlass = true;
        if (EMISSIVE_MT.test(p)) isEmissive = true;
      }
    }
    if (isGlass) glass++;
    if (isEmissive) emissive++;
    byId[a.id] = { path: a.path, isGlass, isEmissive, winMats, dims };
  }
  MESH_N = assets.length;
  console.log(`meshes:    ${assets.length}  |  glass ${glass}  |  emissive ${emissive}`);
  const pct = 100 * boxed / assets.length;
  console.log(`bounds:    ${boxed}/${assets.length} meshes carry a bounding box (${pct.toFixed(1)}%)`);
  if (pct < 50) {
    console.error('\n!! ncz_assets.csv has no usable bounding boxes.');
    console.error('   Re-run scripts/wkit/dump_night_raw.wscript in WolvenKit — the asset box columns');
    console.error('   (bbx0..bbz1) are what every size and orientation number below is built on.');
    console.error('   Without them the old code fell back to the node Bounds field, which is present');
    console.error('   on 1.9% of nodes and silently produced a 2%-sample answer.\n');
    process.exit(1);
  }
  return byId;
}

// A placed node's real box: the mesh's LOCAL dims x this node's Scale. Returns the largest
// face area (what a facade contributes) plus the local axis of the thinnest side, which is
// the panel's normal before rotation.
function placedBox(dims, sx, sy, sz) {
  const d = [dims[0] * (sx || 1), dims[1] * (sy || 1), dims[2] * (sz || 1)];
  const face = Math.max(d[0] * d[1], d[0] * d[2], d[1] * d[2]);
  const mn = Math.min(d[0], d[1], d[2]), mx = Math.max(d[0], d[1], d[2]);
  const thin = mn === d[0] ? 0 : mn === d[1] ? 1 : 2;
  return { d, face, thin, thinness: mx > 0 ? mn / mx : 1, minM: mn };
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
    for (const s of kids) {
      polys.push({ id: s.id, ring: s.polygon, area: area(s.polygon) });
      PARENT[s.id] = d.id;   // so the artefact can fall back sub → district, as the runtime does
    }
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
// SECTOR_M IS GONE, and the note that used to be here had the answer in it the whole time:
//
//   "sector exterior_-15_-2_0_1's own node positions fall inside [-15*128, -14*128] — the
//    grid coord times the cell size. LOD0 is half that: 64 m."
//
// A LEVEL-1 sector has 128 m cells and a level-0 sector has 64 m. The cell size DOUBLES per
// streaming level — so a level-6 cell is 64 x 2^6 = 4,096 m, a quarter of Night City in one
// sector. That is not a level of DETAIL, it is a level of SIZE: the game files each object
// into the level whose cell can contain it, which is why every megabuilding lives in levels
// 3-6 and why filtering the dump to level 0 read the city's props and none of its towers.
//
// Nothing may bin a node by its sector grid coords any more: those indices are
// level-relative and mean different distances in different sectors. Positions are exact now;
// use them.
const APPEARANCE_OFF = /windows_off|_off$/i;

// ── Quaternion (CET: x,y,z,w with Z UP) ─────────────────────────────────────
const qConj = (q) => [-q[0], -q[1], -q[2], q[3]];
// v' = v + 2·(q.xyz × (q.xyz × v + w·v)) — the standard Rodrigues form, no matrix needed.
function qRot(q, v) {
  const [x, y, z, w] = q, [a, b, c] = v;
  const tx = 2 * (y * c - z * b), ty = 2 * (z * a - x * c), tz = 2 * (x * b - y * a);
  return [a + w * tx + (y * tz - z * ty), b + w * ty + (z * tx - x * tz), c + w * tz + (x * ty - y * tx)];
}

// A surface's ROOFNESS = |world normal · Z|, CET being Z-up. 0 = a vertical wall,
// 1 = a flat roof, and the middle is a rake. The bands below are what the SHADER can
// actually act on — and they are not symmetric, because our geometry is not:
//
//   WALL   (< 20° from vertical)  → our box's side faces. Lit today.
//   ANGLED (20°–70°)              → a RAKED FACADE, e.g. the Downtown waterfront towers.
//                                   Our buildings are axis-aligned BOXES with no raked
//                                   faces, so this glass lands on a box SIDE in our scene.
//                                   It is facade, not roof: it should be LIT, and the
//                                   fact we cannot render its rake is a geometry
//                                   limitation, not a lighting one.
//   ROOF   (> 70° from vertical)  → our box's TOP faces. Killed outright by `onWall`.
//                                   This is the bucket that is actually being thrown away.
const ROOFNESS_WALL = Math.sin(20 * Math.PI / 180);   // 0.342
const ROOFNESS_ROOF = Math.sin(70 * Math.PI / 180);   // 0.940

async function main() {
  const { byPath: matByPath, gameParams } = classifyMaterials();
  const meshById = classifyMeshes(matByPath);
  const polys = loadPolys();
  const apps = {};
  for (const a of readCsv('ncz_appearances.csv')) apps[a.id] = a.appearance;

  // NO PRE-PASS. There used to be an 80-line one here — a median over each asset's
  // single placements to guess its size, and a "min-volume reference pose" trick to
  // recover its local normal by un-rotating the tightest AABB it was ever seen in.
  //
  // Every line of it existed to work around a hole: the node `Bounds` field is populated
  // on 1.9% of nodes. All of that machinery was elaborate inference over a 2% sample, and
  // it produced answers that swung 2x when a single filter changed.
  //
  // The mesh knows its own size. ncz_assets.csv now carries each mesh's LOCAL bounding
  // box (dump_night_raw PASS C), so size and orientation are now exact arithmetic:
  //
  //     placed box   = local dims x node Scale
  //     world normal = node Quaternion x (thinnest local axis)
  //
  // and both work for INSTANCED nodes' area too (every copy is the same mesh at the same
  // scale), which is why coverage goes from ~76% to ~100%. Orientation still needs a
  // quaternion, which instanced nodes genuinely do not have — that one is a real limit,
  // not an inference gap, and it is counted rather than guessed.
  // WHAT COUNTS AS A PANEL — and it takes BOTH tests, because the ratio alone is a hole.
  //
  // A ratio test says "thin relative to itself". A warehouse 100 x 80 x 30 m has a min/max
  // ratio of 0.30 and sails through — so an ENTIRE FLAT BUILDING gets classified as a kit
  // panel, and if any of its materials is a window material its whole 8,000 m2 footprint
  // lands in the glass bucket. That is the bespoke-megamesh problem the panel test exists
  // to exclude, walking back in through the front door.
  //
  // It showed up as Jackson Plains — Badlands scrub — at 43.5% glass off 116 glass pieces
  // against 7,093 wall pieces, and Northside (a windowless industrial dock) at 17.7%.
  // Absurd on sight, which is the only reason it got caught.
  //
  // A panel is thin in METRES, not merely in proportion. The game's glass module is
  // 3 x 4 m; nothing that is a facade kit piece is 2 m thick.
  const PANEL_THIN = 0.34;      // min/max dim ratio — thin relative to itself
  const PANEL_MAX_M = 2.0;      // ...AND thin in absolute metres. Both, or a building qualifies.

  // --top <subId>: which ASSETS actually supply this subdistrict's glass and wall area?
  // Probing from inside the real classifier, never with a re-implementation of it: a glass
  // panel's material path is `..._h400_w300_mlt.mi`, which contains no window name at all
  // — only the resolved .mi → root .mt chain knows it is glass. A regex on the CSV line
  // finds nothing and reports it as zero.
  const TOP = process.argv.includes('--top') ? process.argv[process.argv.indexOf('--top') + 1] : null;
  const topTally = {};   // 'glass'|'wall' → assetPath → { m2, n, dims }

  const tally = {};
  // The game's window params, weighted by PLACED GLASS AREA rather than by material count.
  // gameParams (from classifyMaterials) is the unweighted twin; both are reported, because
  // where they disagree is exactly where a rare material was masquerading as a common rule.
  const paramArea = {};
  // GLASS PANEL SIZE — the game's glass module, weighted by how much of the city is built
  // from it. Directly answers what the shader's GLASS_BLOCK grid should be: the block is
  // the kit panel, and the kit panel is a thing we can measure rather than choose.
  const panelSize = [];   // { long, short, m2 } per placed glass panel node
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

    // POSITION. NO FALLBACK — AND THE FALLBACK THAT WAS HERE IS NOW A HAZARD.
    //
    // This used to bin position-less (instanced) nodes at their SECTOR CENTRE, on the
    // reasoning that "a LOD0 sector is a 64 m cell, so its centre is a ±32 m position".
    // BOTH halves of that are now dead:
    //
    //   1. Instanced nodes are NOT position-less. Their transforms were always in the
    //      sector's shared pool, behind a handle nobody dereferenced. Every copy has an
    //      exact XYZ — see ncz_instances.csv and
    //      [[instanced-transforms-were-always-readable]].
    //
    //   2. "A sector is a 64 m cell" is only true of STREAMING LEVEL 0. The trailing digit
    //      of `exterior_X_Y_Z_L` is the level, and it sets the CELL SIZE — level 0 holds
    //      props, levels 3-6 hold megabuildings in enormous cells. The dump now reads all
    //      of them, so `(gx + 0.5) * 64` is not merely imprecise across levels, it points
    //      at the wrong part of the city entirely.
    //
    // So a node with no position is DROPPED and COUNTED. Its copies are in the instances
    // file with real transforms; guessing at it here would invent geometry.
    const x = +f[COL.x], y = +f[COL.y];
    if (!Number.isFinite(x) || !Number.isFinite(y) || (x === 0 && y === 0)) { viaSector++; return; }

    let hit = null;
    for (const p of polys) {
      const b = p.bb;
      if (x < b[0] || x > b[2] || y < b[1] || y > b[3]) continue;   // cheap reject first
      if (inPoly(x, y, p.ring)) { hit = p; break; }
    }
    if (!hit) { outside++; return; }
    n++;
    const t = tally[hit.id] || (tally[hit.id] = {
      area: hit.area, glass: 0, glassOff: 0, wall: 0, signArea: 0, signs: 0,
      glassA: 0, glassOffA: 0, wallA: 0, noAreaArch: 0,
      glassAV: 0, glassAAng: 0, glassAH: 0, glassAUnk: 0,
      pGlassA: 0, pWallA: 0, bulkArchA: 0,
    });

    // The placed object's REAL box: the mesh's local dims x this node's Scale. Exact for
    // every node including instanced ones, because a copy is the same mesh at the same
    // scale. No inference, no sampling, no median.
    const box = mesh.dims
      ? placedBox(mesh.dims, +f[COL.sx], +f[COL.sy], +f[COL.sz])
      : null;
    const m2 = box ? box.face * inst : 0;

    const isArch = ARCH.test(mesh.path);
    if (isArch) {
      const off = APPEARANCE_OFF.test(apps[f[COL.app]] || '');
      if (!box) t.noAreaArch += inst;   // mesh had no bounding box at all — reported, not hidden

      // PANELS ONLY, for the area share — the correction that makes the AREA column mean
      // anything.
      //
      // A mesh is classified glass-or-wall WHOLESALE. For a kit-bashed panel that is true:
      // the panel really is all glass or all concrete. For a BESPOKE MEGATOWER it is a
      // fiction — the tower is a mix, and weighting it by area dumps its ENTIRE 300 m
      // facade into whichever bucket won the coin toss. One such mesh landing in "wall"
      // craters a district's glass share; by instance count it was worth 1, which is why
      // the bug stayed invisible until we started weighting by area.
      //
      // So the share is computed over the pieces where the binary IS valid (panels), and
      // the unapportionable bulk area is reported separately rather than silently shoved
      // into one side. `thinness` is now the mesh's OWN aspect — not a guess from the one
      // placement that happened to be axis-aligned.
      const isPanel = box && box.thinness <= PANEL_THIN && box.minM <= PANEL_MAX_M;
      if (box && !isPanel) t.bulkArchA += m2;
      else if (isPanel) { if (mesh.isGlass && !off) t.pGlassA += m2; else if (!mesh.isGlass) t.pWallA += m2; }

      if (TOP && hit.id === TOP && isPanel) {
        const bucket = mesh.isGlass && !off ? 'glass' : (!mesh.isGlass ? 'wall' : null);
        if (bucket) {
          const g = topTally[bucket] || (topTally[bucket] = {});
          const r = g[mesh.path] || (g[mesh.path] = { m2: 0, n: 0, d: box.d });
          r.m2 += m2; r.n += inst;
        }
      }

      if (mesh.isGlass) {
        if (off) { t.glassOff += inst; t.glassOffA += m2; }
        else {
          t.glass += inst; t.glassA += m2;
          // WALL / ANGLED / ROOF — the measurement behind whether the shader's
          // vertical-surfaces-only rule is throwing away real light.
          //
          // The panel's normal is its thinnest LOCAL axis (from the mesh's own box), turned
          // into the world by this node's quaternion. `roofness` = |n.Z|, CET being Z-up.
          //
          // An INSTANCED node still cannot be oriented — its per-copy transforms live in a
          // binary buffer WolvenKit will not expand, so it has no usable quaternion, and
          // one panel asset is placed at many rotations so the asset's own normal cannot
          // stand in. That is a REAL limit of the data, not an inference gap: it is counted
          // as unoriented and the coverage is reported, so the roof number is always read
          // against how much of the glass it actually saw.
          if (isPanel) {
            // Panel module size (w x h) for the glass-block grid, in WORLD metres: rotate
            // the two in-plane axes and let the more vertical one be the height.
            const q = [+f[COL.qi] || 0, +f[COL.qj] || 0, +f[COL.qk] || 0, +f[COL.qr] || 1];
            const ax = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
            const inPlane = [0, 1, 2].filter((i) => i !== box.thin);
            const nrm = qRot(q, ax[box.thin]);
            const roofness = Math.abs(nrm[2]);
            if (inst > 1) t.glassAUnk += m2;
            else if (roofness < ROOFNESS_WALL)      t.glassAV += m2;
            else if (roofness > ROOFNESS_ROOF)      t.glassAH += m2;
            else                                    t.glassAAng += m2;
            if (inst === 1 && roofness < ROOFNESS_ROOF) {
              const w0 = qRot(q, ax[inPlane[0]]), w1 = qRot(q, ax[inPlane[1]]);
              const vertIsFirst = Math.abs(w0[2]) > Math.abs(w1[2]);
              const h = box.d[inPlane[vertIsFirst ? 0 : 1]];
              const w = box.d[inPlane[vertIsFirst ? 1 : 0]];
              panelSize.push({ w, h, m2 });
            }
          } else {
            t.glassAUnk += m2;   // bulk mesh — no single normal exists to report
          }
          // Weight the game's window params by the glass AREA that actually carries them.
          // Counting MATERIALS would repeat, in the histogram, the exact bug this file
          // fixed in the glass tally: a material used on three meshes would weigh the same
          // as one used on three thousand. A parameter's authority is how much of Night
          // City is wearing it.
          for (const wm of mesh.winMats) {
            const w = m2 / mesh.winMats.length;   // a mesh with 2 window mats splits its area
            for (const k in wm.params) {
              if (!WINDOW_PARAM.test(k)) continue;
              const canon = k.toLowerCase();
              const h = paramArea[canon] || (paramArea[canon] = {});
              h[wm.params[k]] = (h[wm.params[k]] || 0) + w;
            }
          }
        }
      } else { t.wall += inst; t.wallA += m2; }
    }
    // EMITS *and* IS SIGNAGE (see SIGNAGE above). Weighted by AREA — a billboard is ~30 m2
    // against a shopfront neon's ~2 m2; counting them equally is meaningless.
    //
    // AREA COMES FROM THE MESH'S OWN BOX, NOT FROM THE NODE. The node's Bounds field would
    // be wrong twice over: on an INSTANCED node it encloses ALL the copies spread across a
    // block (`bounds x instances` gave a deco-font LETTER 32 m2 and a grocery sign 667 m2),
    // and it is absent on 98% of nodes anyway. The mesh box x the node's scale is the real
    // size of one copy — and now that it works for instanced nodes too, the small repeated
    // shopfront neons finally get counted at all.
    if (mesh.isEmissive && !isArch && SIGNAGE.test(mesh.path)) {
      if (box) { t.signArea += m2; t.signs += inst; }
      else noArea += inst;   // mesh carries no bounding box — counted, not measured.
    }
  });
  await new Promise((res) => rl.on('close', res));
  console.log(`nodes:     ${total}  |  binned ${n}  |  outside all polygons ${outside}`);
  console.log(`           ${viaSector} placed by SECTOR CENTRE (instanced nodes carry no position) — +-32 m, fine for districts\n`);

  if (TOP) {
    for (const bucket of ['glass', 'wall']) {
      const g = topTally[bucket] || {};
      const tot = Object.values(g).reduce((s, r) => s + r.m2, 0);
      console.log(`\n=== ${TOP} — top ${bucket.toUpperCase()} panel assets by AREA  (total ${(tot / 1000).toFixed(0)}k m2)\n`);
      for (const [p, r] of Object.entries(g).sort((a, b) => b[1].m2 - a[1].m2).slice(0, 10)) {
        console.log('  ' + ((100 * r.m2 / tot).toFixed(1) + '%').padStart(6),
          (r.m2 / 1000).toFixed(1).padStart(7) + 'k m2',
          ('x' + r.n).padStart(8),
          'box ' + r.d.map((x) => x.toFixed(1)).join('x').padEnd(18),
          p.replace(/^"?base.environment./, '').slice(0, 62));
      }
    }
    console.log('');
    return;
  }

  // ── THE FALSIFICATION TEST ────────────────────────────────────────────────
  // Everything downstream multiplies glass_share by 0.5, and that 0.5 is a claim about
  // the game, not a tuning choice. Check it before reporting a single district number.
  const KEYS = ['amountturnoffatnight', 'roomwidth', 'roomheight', 'roomdepth', 'lightstempvariationatnight', 'emissiveev', 'tintcoloratnight'];
  const turnOff = modeOf(paramArea.amountturnoffatnight);
  const litInGlass = turnOff ? parseFloat(turnOff.value) : null;
  console.log("THE GAME'S OWN WINDOW PARAMETERS — weighted by PLACED GLASS AREA.\n");
  console.log('  Weighting by area, not by material count, for the same reason the glass share is:');
  console.log('  a material used on three meshes must not outvote one used on three thousand. The');
  console.log('  by-count column is shown beside it, and where they DISAGREE is the interesting part —');
  console.log('  that is a rare material that was masquerading as a common rule.\n');
  console.log('  ' + 'param'.padEnd(28) + 'BY AREA'.padEnd(22) + 'by material count');
  console.log('  ' + '-'.repeat(74));
  for (const key of KEYS) {
    const a = modeOf(paramArea[key]);
    const c = modeOf(gameParams[key]);
    if (!a && !c) { console.log(`  ${key.padEnd(28)}— not present in any window material`); continue; }
    const fmt = (m) => !m ? '—'
      : `${String(m.value).slice(0, 17).padEnd(18)}${m.unanimous ? '100%' : (100 * m.share).toFixed(0) + '%'}`;
    console.log(`  ${key.padEnd(28)}${fmt(a).padEnd(22)}${fmt(c)}`);
  }
  console.log('\n  Area-weighted distributions (top values):');
  for (const key of KEYS) {
    const a = modeOf(paramArea[key]);
    if (!a || a.unanimous) continue;
    const pct = Object.fromEntries(Object.entries(a.dist).map(([k, v]) =>
      [k, (100 * v / Object.values(paramArea[key]).reduce((s, x) => s + x, 0)).toFixed(1) + '%']));
    console.log(`    ${key.padEnd(28)} ${JSON.stringify(pct)}`);
  }

  // THE SECOND TERM. Everything downstream multiplies glass_share by this number, so it
  // gets its own verdict rather than a footnote.
  //
  // READ THE NAME. It is `AmountTurnOff AtNight` — the fraction that go DARK, not the
  // fraction that stay lit. So:
  //
  //     lit_within_glass  =  1 - AmountTurnOffAtNight
  //
  // At the modal 0.5 the two readings coincide exactly, which is why the ambiguity
  // survived this long unnoticed. The OUTLIERS are what disambiguate it: a value of 0
  // means "none of them turn off" — a lobby or shopfront lit all night, which is
  // sensible. Under the other reading it would mean "0% lit", i.e. a window material
  // that is never lit at night, which is not a thing. The name is telling the truth.
  console.log('');
  const turnOffMean = meanOf(paramArea.amountturnoffatnight);
  const LIT = turnOffMean === null ? 0.5 : 1 - turnOffMean;
  if (!turnOff) {
    console.log('  !! AmountTurnOffAtNight NOT FOUND. The lit-fraction model has no second term. STOP.\n');
  } else {
    const unanimousish = turnOff.share >= CLAIM_DOMINANCE;
    console.log(`  AmountTurnOffAtNight = the fraction that go DARK. Lit = 1 - it.`);
    console.log(`    mode  ${turnOff.value} on ${(100 * turnOff.share).toFixed(1)}% of placed glass area`);
    console.log(`    mean  ${turnOffMean.toFixed(4)}  (area-weighted over ${turnOff.distinct} distinct values)`);
    console.log(`    ⇒ LIT WITHIN GLASS = ${LIT.toFixed(4)}`);
    if (unanimousish) {
      console.log('\n  The handover\'s "identical for every archetype" is not literally true, but the');
      console.log('  outliers are a rounding error by area. A single global constant is defensible.\n');
    } else {
      console.log('\n  !! "CDPR does not vary it by archetype" is FALSE — and false BY AREA, not merely');
      console.log('     by material count. The mean above is used as the single global term, but the');
      console.log('     spread is real: if the look is wrong, this is a place a per-archetype term');
      console.log('     genuinely belongs, not a knob to tune.\n');
    }
  }
  void litInGlass;
  const rows = Object.entries(tally).map(([id, t]) => {
    const cnt = t.glass + t.wall;
    const m2  = t.glassA + t.wallA;
    const glassKnown = t.glassAV + t.glassAAng + t.glassAH;   // the glass we could ORIENT
    return {
      id,
      km2: t.area / 1e6,
      glass: t.glass, wall: t.wall, off: t.glassOff,
      shareCount: cnt ? t.glass / cnt : 0,
      shareArea:  m2  ? t.glassA / m2 : 0,                        // naive: bulk meshes counted wholesale
      sharePanel: (t.pGlassA + t.pWallA) ? t.pGlassA / (t.pGlassA + t.pWallA) : 0,   // THE TRUSTED ONE
      // How much arch area we had to set aside as unapportionable (bespoke meshes that are
      // part glass, part concrete, with no way to split them). High ⇒ the panel share is
      // speaking for a minority of the district's facade.
      bulkArchShare: (t.pGlassA + t.pWallA + t.bulkArchA) ? t.bulkArchA / (t.pGlassA + t.pWallA + t.bulkArchA) : 0,
      // Fraction of arch instances we could size. With the mesh's own bounding box this
      // should now be ~100% — it was ~76% when size was inferred from the node Bounds
      // field. Anything materially below 1.0 here means meshes without a bounding box,
      // which is a NEW problem, not the old one.
      areaCoverage: cnt ? 1 - t.noAreaArch / cnt : 0,
      // Of the glass we CAN orient: how much is roof (killed by `onWall`) and how much is
      // a raked facade (lands on our box sides, so already lit — but we cannot render its
      // rake)? `orientCoverage` is how much of the district's glass carried a usable
      // rotation at all; a low value means these two shares are a small sample talking.
      roofGlassShare:   glassKnown ? t.glassAH / glassKnown : 0,
      angledGlassShare: glassKnown ? t.glassAAng / glassKnown : 0,
      orientCoverage:   t.glassA ? glassKnown / t.glassA : 0,
      signs: t.signs,
      signM2PerKm2: t.signArea / (t.area / 1e6),
    };
  }).filter((r) => r.glass + r.wall + r.signs > 0);

  const maxSign = Math.max(...rows.map((r) => r.signM2PerKm2), 1);
  for (const r of rows) {
    r.signOrdinal = r.signM2PerKm2 / maxSign;
    r.litFraction = r.sharePanel * LIT;             // stored DERIVED — nothing downstream re-applies the 0.5
    r.flags = [];
    if (r.glass + r.wall < MIN_ARCH_SAMPLES) r.flags.push('low-sample');
    if (r.areaCoverage < 0.80) r.flags.push('low-area-coverage');
    if (r.bulkArchShare > 0.40) r.flags.push('bulk-heavy');       // panel share speaks for a minority
    if (Math.abs(r.sharePanel - r.shareCount) > 0.10) r.flags.push('count-area-divergence');
    if (TUNED_SIGN[r.id] !== undefined && Math.abs(r.signOrdinal - TUNED_SIGN[r.id]) > 0.4) {
      r.flags.push('contradicts-tuned-profile');    // e.g. Little China: measured 0.29 vs tuned 1.0
    }
    r.confidence = (r.flags.includes('low-sample') || r.flags.includes('low-area-coverage')) ? 'low' : 'high';
  }

  console.log(`WINDOWS — lit fraction = glass share x ${LIT.toFixed(4)}\n`);
  console.log('  PANEL%  the trusted share: glass AREA / facade AREA, over kit PANELS only — the pieces');
  console.log('          where "this mesh is glass" is actually true of the whole mesh.');
  console.log('  naive%  the same thing WITHOUT excluding bespoke part-glass megameshes, whose entire');
  console.log('          facade gets dumped into one bucket. Kept to show what that does.');
  console.log('  count%  the original instance-count share. Kept to show what THAT does.');
  console.log('  bulk%   facade area we could not apportion. High ⇒ PANEL% speaks for a minority.\n');
  console.log('subdistrict'.padEnd(24), 'PANEL%'.padStart(7), 'naive%'.padStart(7), 'count%'.padStart(7),
    'LIT'.padStart(6), 'bulk%'.padStart(6), 'roof%'.padStart(6), '  flags');
  console.log('-'.repeat(96));
  for (const r of [...rows].sort((a, b) => b.sharePanel - a.sharePanel)) {
    console.log(r.id.padEnd(24),
      (100 * r.sharePanel).toFixed(1).padStart(6) + '%',
      (100 * r.shareArea).toFixed(1).padStart(6) + '%',
      (100 * r.shareCount).toFixed(1).padStart(6) + '%',
      r.litFraction.toFixed(3).padStart(6),
      (100 * r.bulkArchShare).toFixed(1).padStart(5) + '%',
      (100 * r.roofGlassShare).toFixed(1).padStart(5) + '%',
      ' ' + r.flags.join(' '));
  }

  // City-wide verdict on the shader's `onWall` gate. Reported over the glass we could
  // ORIENT — i.e. the non-instanced glass whose quaternion is real.
  const sum = (k) => Object.values(tally).reduce((s, t) => s + t[k], 0);
  const gAV = sum('glassAV'), gAA = sum('glassAAng'), gAH = sum('glassAH'), gAU = sum('glassAUnk');
  const gKnown = gAV + gAA + gAH;
  console.log('\nGLASS BY SURFACE TILT — what is the vertical-surfaces-only rule throwing away?\n');
  console.log(`  wall    (<20° from vertical)  ${(100 * gAV / gKnown).toFixed(1).padStart(5)}%  ${(gAV / 1e6).toFixed(2)} km2   → our box SIDES. Lit today.`);
  console.log(`  angled  (20°-70°, raked)      ${(100 * gAA / gKnown).toFixed(1).padStart(5)}%  ${(gAA / 1e6).toFixed(2)} km2   → also lands on box sides: FACADE, not roof.`);
  console.log(`  roof    (>70°, near-flat)     ${(100 * gAH / gKnown).toFixed(1).padStart(5)}%  ${(gAH / 1e6).toFixed(2)} km2   → our box TOPS. KILLED by onWall.`);
  console.log(`\n  oriented over ${(100 * gKnown / (gKnown + gAU)).toFixed(1)}% of placed glass area`);
  console.log(`  (${(gAU / 1e6).toFixed(2)} km2 unoriented: instanced nodes carry no rotation, and non-panel`);
  console.log('   chunk-material meshes have no single normal. Neither is guessed at.)');

  // ── THE GLASS MODULE — what the shader's GLASS_BLOCK grid should be ───────
  // Weighted by placed area, so a panel that tiles half the city outweighs a one-off.
  // Median, not mean: panel sizes are a handful of discrete kit values with a long tail,
  // and a mean of a multi-modal set is a number that describes nothing.
  const wMedian = (arr, key) => {
    const s = [...arr].sort((a, b) => a[key] - b[key]);
    const half = s.reduce((t, x) => t + x.m2, 0) / 2;
    let acc = 0;
    for (const x of s) { acc += x.m2; if (acc >= half) return x[key]; }
    return s.length ? s[s.length - 1][key] : 0;
  };
  let panelW = 0, panelH = 0;
  if (panelSize.length) {
    const bucket = {};
    for (const p of panelSize) {
      const k = `${Math.round(p.w)}w x ${Math.round(p.h)}h`;
      bucket[k] = (bucket[k] || 0) + p.m2;
    }
    const totalM2 = Object.values(bucket).reduce((s, x) => s + x, 0);
    const top = Object.entries(bucket).sort((a, b) => b[1] - a[1]).slice(0, 10);
    panelW = wMedian(panelSize, 'w'); panelH = wMedian(panelSize, 'h');
    console.log('\nGLASS PANEL SIZE — the game\'s glass MODULE (vertical panels), by placed area.\n');
    console.log('  The shader\'s glass BLOCK should be this, not a number we invent: the coherent');
    console.log('  slab of window the city is kit-bashed from. (The window CELL inside it is the');
    console.log('  ROOM — roomWidth x roomHeight, measured separately above.)\n');
    console.log('  module (m)'.padEnd(16), 'share of glass area'.padStart(20));
    console.log('  ' + '-'.repeat(36));
    for (const [k, m2] of top) {
      console.log('  ' + k.padEnd(14), ((100 * m2 / totalM2).toFixed(1) + '%').padStart(20));
    }
    console.log(`\n  area-weighted MEDIAN module: ${panelW.toFixed(1)} w x ${panelH.toFixed(1)} h m`);
    console.log(`  (over ${panelSize.length.toLocaleString()} placed glass panels)`);
  }

  console.log('\nSIGNS — emissive AREA per km2 (NOT count: a billboard is ~30 m2, a neon ~2 m2)\n');
  console.log('subdistrict'.padEnd(24), 'signs'.padStart(7), 'm2/km2'.padStart(10), 'ORDINAL'.padStart(8), 'tuned'.padStart(7));
  console.log('-'.repeat(64));
  for (const r of [...rows].sort((a, b) => b.signM2PerKm2 - a.signM2PerKm2)) {
    if (!r.signs) continue;
    const tuned = TUNED_SIGN[r.id];
    console.log(r.id.padEnd(24), String(r.signs).padStart(7), r.signM2PerKm2.toFixed(0).padStart(10),
      r.signOrdinal.toFixed(2).padStart(8),
      (tuned === undefined ? '—' : tuned.toFixed(2)).padStart(7),
      r.flags.includes('contradicts-tuned-profile') ? ' <- DISAGREES' : '');
  }

  // ── EMIT ──────────────────────────────────────────────────────────────────
  if (!EMIT) { console.log('\n(no --emit: nothing written. `--emit data/night-profile.json` to persist.)'); return; }

  const byId = Object.fromEntries(rows.map((r) => [r.id, r]));
  const shape = (r) => ({
    districtId: PARENT[r.id] ?? null,
    areaKm2: +r.km2.toFixed(4),
    glassInstances: r.glass, wallInstances: r.wall, glassOffInstances: r.off,
    glassSharePanel: +r.sharePanel.toFixed(4),      // THE one the renderer should use
    glassShareArea: +r.shareArea.toFixed(4),        // naive area (bulk meshes counted wholesale)
    glassShareCount: +r.shareCount.toFixed(4),      // original instance count
    bulkArchShare: +r.bulkArchShare.toFixed(3),
    areaCoverage: +r.areaCoverage.toFixed(3),
    roofGlassShare: +r.roofGlassShare.toFixed(3),
    angledGlassShare: +r.angledGlassShare.toFixed(3),
    orientCoverage: +r.orientCoverage.toFixed(3),
    litFraction: +r.litFraction.toFixed(4),
    signCount: r.signs,
    signAreaPerKm2: +r.signM2PerKm2.toFixed(1),
    signOrdinal: +r.signOrdinal.toFixed(3),
    confidence: r.confidence,
    flags: r.flags,
  });

  const profile = {
    _comment: 'GENERATED by scripts/night_analyse.js — do not hand-edit. Re-run with --emit. '
            + 'Hand-tuned overrides live in constants.js (GLASS_SHARE_OVERRIDE, SIGN_DENSITY_PROFILE), '
            + 'deliberately NOT here, so measured and tuned stay separable.',
    generator: 'scripts/night_analyse.js',
    sourceRaw: RAW,
    counts: { materials: MAT_N, meshes: MESH_N, nodes: total, binned: n, outsideAllPolygons: outside, placedBySectorCentre: viaSector },
    // Straight from window_parallax_interior.mt, WEIGHTED BY PLACED GLASS AREA — `share`
    // is the fraction of Night City's glass wearing the modal value, and it is the number
    // that says whether a value is a RULE or merely the common case. The by-material-count
    // twin is kept beside it: they disagree, and the disagreement is the point.
    game: {
      amountTurnOffAtNight: modeOf(paramArea.amountturnoffatnight),
      roomWidth:            modeOf(paramArea.roomwidth),
      roomHeight:           modeOf(paramArea.roomheight),
      roomDepth:            modeOf(paramArea.roomdepth),
      tintColorAtNight:     modeOf(paramArea.tintcoloratnight),
      emissiveEV:           modeOf(paramArea.emissiveev),
      lightsTempVariationAtNight: modeOf(paramArea.lightstempvariationatnight),
    },
    gameByMaterialCount: {
      amountTurnOffAtNight: modeOf(gameParams.amountturnoffatnight),
      roomWidth:            modeOf(gameParams.roomwidth),
      roomHeight:           modeOf(gameParams.roomheight),
      tintColorAtNight:     modeOf(gameParams.tintcoloratnight),
    },
    // Shares of the glass we could ORIENT (see orientedFraction). `angled` is raked
    // FACADE — it lands on our boxes' side faces, so it is already lit; only `roof`
    // is what the shader's onWall gate discards.
    // The game's glass MODULE (area-weighted median over placed vertical glass panels).
    // This is what the shader's GLASS_BLOCK grid should be — the coherent slab of window
    // the city is kit-bashed from — as opposed to the window CELL inside it, which is the
    // ROOM (game.roomWidth x game.roomHeight).
    glassModule: { widthM: +panelW.toFixed(2), heightM: +panelH.toFixed(2), samples: panelSize.length },
    glassByTilt: {
      wall:             +(gAV / gKnown).toFixed(4),
      angled:           +(gAA / gKnown).toFixed(4),
      roof:             +(gAH / gKnown).toFixed(4),
      orientedFraction: +(gKnown / (gKnown + gAU)).toFixed(4),
    },
    subdistricts: Object.fromEntries(rows.filter((r) => PARENT[r.id] !== undefined).map((r) => [r.id, shape(r)])),
    districts:    Object.fromEntries(rows.filter((r) => PARENT[r.id] === undefined).map((r) => [r.id, shape(r)])),
  };
  const out = path.isAbsolute(EMIT) ? EMIT : path.join(ROOT, EMIT);
  fs.writeFileSync(out, JSON.stringify(profile, null, 2) + '\n');
  console.log(`\nwrote ${out}  (${rows.length} rows)`);
  void byId;
}

main();
