#!/usr/bin/env node
/**
 * scripts/window_geom.js
 * ─────────────────────────────────────────────────────────────────────────
 * THE WINDOW IS A SUBMESH. Pull it out of the GLB and measure the GLASS, not the wall.
 *
 * `cct_cpz_building_a_b_6m_window` is ONE 6 x 8 m facade slab holding TWO submeshes:
 *
 *     submesh_00   194 verts   224 tris   0.24 m thick   the CONCRETE
 *     submesh_01    16 verts     8 tris   0.00 m thick   the GLASS — four window strips
 *
 * Every window model this project has built measured the SLAB:
 *
 *     whole-panel bbox   48.00 m2   <- what we light today
 *     glass submesh bbox 35.13 m2   <- the tempting fix, and still 2x WRONG
 *     glass TRIANGLE area17.10 m2   <- the truth
 *
 * 2.8x too much glass. Note the middle row: a bbox drawn around four separate strips is
 * mostly the GAPS BETWEEN THEM. Taking the glass bbox does not fix the overcount, it just
 * moves it one level down where it is harder to see. AREA IS SUMMED OVER TRIANGLES. If you
 * ever find yourself multiplying two bbox extents in this file, you have reintroduced the bug.
 *
 * ─── HOW A SUBMESH IS KNOWN TO BE GLASS ──────────────────────────────────────
 * BY MATERIAL, and only by material. `<mesh>.Material.json` -> `Appearances.<first>` is the
 * chunk material list, one name per chunk. GLB submesh names are `submesh_NN_LOD_L` and NN
 * indexes that list (world-asset-reference S9, confirmed on 3 meshes from 3 kits) — the name
 * CARRIES the index, so nothing is inferred from array order. Look the name up in
 * `Materials[]` and read `MaterialTemplate`: the ROOT .mt, ALREADY RESOLVED by WolvenKit.
 *
 * So this file needs NO NAME REGEX. `glass_windows` — the material that defeated every
 * previous name-based test — resolves correctly here for free. The classifier is the game's
 * own chunk->material assignment, which is what the renderer itself shades. It is not a
 * heuristic and it cannot be "widened" later.
 *
 * ─── THE SHAPE HEURISTIC DOES NOT GENERALISE — MEASURED, 2026-07-14 ──────────
 * The plan said glass could be cross-checked by shape: "flat (thinnest dim 0.0), 4-16 verts,
 * while concrete is 0.24-0.6 m thick". That was derived from ONE kit and it is FALSE city-wide:
 *
 *   - SLOPED glazing is planar but not AXIS-planar. `cct_cpz_building_a_a_6m_slope_window` is
 *     a single flat quad whose AABB is 2.8 m "thick". Corpo Plaza is full of them.
 *   - Corner glazing is genuinely non-planar: `..._slope_corner_a_v1_a_window` is 6 facets.
 *   - "Has a back face" does not separate glass from concrete either: 43% of GLASS submeshes
 *     have opposing faces — and so do 73% of NON-glass ones.
 *
 * The shape test is therefore kept only as a REPORTED DIAGNOSTIC. It is not a gate and it does
 * not get a vote. Material is authoritative BY CONSTRUCTION; shape was only ever a proxy for it.
 *
 * ─── GLASS IS OFTEN DOUBLE-SIDED — COUNT ONE SIDE ────────────────────────────
 * 43% of glass submeshes, holding 44% of all glass area, are modelled as TWO COINCIDENT SHEETS
 * facing opposite ways (you can see a window from inside and out). Summing every triangle
 * double-counts those — a 1.8x error, and the SAME class of bug as the panel-vs-window one this
 * script exists to fix, just one level further down.
 *
 * So: cluster triangles by normal; where two clusters are near-antiparallel AND of comparable
 * area, they are the two faces of one sheet — keep the larger, drop the smaller.
 *
 * The check that this is right: `cct_cpz_building_a_a_24m_h16m_st` is a 24 x 16 m tower panel
 * (384 m2 of face). Raw triangle area 762.6 m2; one-sided 381.3 m2. It is a fully-glazed curtain
 * wall, and the corrected number lands on its own face area. That is not a fitted constant —
 * it is the geometry agreeing with itself.
 *
 * ─── GLASS IS NOT A WINDOW. EMISSIVE IS. ────────────────────────────────────
 * 43% of the glass area we were counting DOES NOT GLOW — 40,300 m2 of it. `glass.mt` and
 * `glass_onesided.mt` are doors, balustrades, shopfronts, railings, the Corpo Plaza roundabout
 * canopy. They are glass. They are not windows, and lighting them lights the wrong city.
 *
 *   EMISSIVE   window_parallax_interior (EV 4) · window_corpo_plaza (EV 5) · parallax_windows
 *              xx_fake_interior (EV 5) · window_blue · window_orange        53.4k m2   57%
 *   NOT        Glass · glass · glass_1 · z_glass · xx_glass · glass_a       40.3k m2   43%
 *
 * So the classifier is EMISSIVE, and it is asked of the material, which states it outright.
 * NOT "does it glow at night" — `AmountTurnOffAtNight` is a night MODIFIER (the fraction that
 * go dark; lit = 1 - it), not the definition. A thing that glows, glows.
 *
 * AND NO PARAMETER ALLOW-LIST. Emissive is spelled differently on different templates
 * (`EmissiveEV`, `EmissiveColor`, `EmissiveIntensity`, …), so match on the NAME —
 * /emissive/i with a non-zero value — rather than on the handful this file happens to know.
 * Listing the params you "know" you want is the same mistake as name-matching a material, one
 * level up, and this pipeline has now made it three times.
 *
 * PER CHUNK, NOT PER MESH. One facade panel can carry an emissive window chunk AND a plain
 * glass door chunk. Reading the emissive params off the mesh's FIRST glass material gives the
 * door the window's glow, or the window the door's darkness. The geometry is per chunk; so is
 * this.
 *
 * ─── NO FALLBACK ─────────────────────────────────────────────────────────────
 * A mesh with no glass submesh emits NO windows and is COUNTED. It does not get a guessed
 * area. The export deliberately over-includes (a false positive costs one GLB on disk), so
 * "no glass here" is an expected, healthy answer for a chunk of the input.
 *
 * Usage:  node scripts/window_geom.js [--raw <dir>] [--out <file>] [--verbose]
 */
'use strict';
const fs = require('fs');
const path = require('path');

const arg = (f, d) => (process.argv.includes(f) ? process.argv[process.argv.indexOf(f) + 1] : d);
const RAW = arg('--raw', 'd:/Modding/CP2077 Mods/MyMods/map_data_export/source/raw');
const OUT = arg('--out', path.join(__dirname, '..', 'data', 'window-geom.json'));
const VERBOSE = process.argv.includes('--verbose');

// The ROOT .mt templates that are glass. Applied ONLY to a resolved `MaterialTemplate` from
// the Material.json — never to a material's name. (scripts/glass_lib.js is the shared
// definition; this is the same set, matched against a .mt path rather than a CSV column.)
const GLASS_MT = /(^|[\\/])(window_parallax_interior|window_interior_uv|glass|glass_onesided)\.mt$/i;

// A submesh is FLAT if its thinnest extent is under this. The glass in the reference mesh is
// 0.000 m; the concrete it is set into is 0.240 m. There is no ambiguous middle in practice —
// this threshold sits in a gap, it does not cut through a distribution.
const FLAT_M = 0.02;

/**
 * DOES THIS MATERIAL GLOW?
 *
 * Asked of the material's own parameters, by NAME — /emissive/i with a non-zero value — not
 * against a list of the fields this file happens to know about. `EmissiveEV` is what the window
 * templates use; other templates spell it differently, and an allow-list would silently miss
 * them exactly the way a material-name regex silently missed `glass_windows`.
 *
 * Returns null when nothing emissive is set: that is a pane of glass, not a window.
 */
function emissiveOf(mat) {
  if (!mat || !mat.Data) return null;
  const out = {};
  let glows = false;
  for (const [k, v] of Object.entries(mat.Data)) {
    if (!/emissive/i.test(k)) continue;
    if (typeof v === 'number') { out[k] = v; if (v !== 0) glows = true; }
    else if (v && typeof v === 'object' && 'Red' in v) {
      out[k] = [v.Red, v.Green, v.Blue];
      if (v.Red || v.Green || v.Blue) glows = true;
    } else if (typeof v === 'string' && v) { out[k] = v; glows = true; }   // an emissive TEXTURE
  }
  if (!glows) return null;
  // The night MODIFIERS. Not what makes it emissive — what happens to it after dark. Carried
  // because the model needs them, and because the game states them and we should not invent them.
  const d = mat.Data;
  if (typeof d.AmountTurnOffAtNight === 'number') out.turnOffAtNight = d.AmountTurnOffAtNight;
  if (d.TintColorAtNight) out.tintAtNight = [d.TintColorAtNight.Red, d.TintColorAtNight.Green, d.TintColorAtNight.Blue];
  if (typeof d.LightsTempVariationAtNight === 'number') out.tempVarAtNight = d.LightsTempVariationAtNight;
  return out;
}

// ── GLB: minimal reader ─────────────────────────────────────────────────────
// WolvenKit's export is uncompressed float32 with indices (no Draco, no meshopt), verified on
// the reference mesh. If `extensionsUsed` ever appears, this reader must be told about it
// rather than silently reading garbage — so it THROWS instead.
function readGlb(file) {
  const b = fs.readFileSync(file);
  if (b.readUInt32LE(0) !== 0x46546c67) throw new Error(`not a GLB: ${file}`);
  const jsonLen = b.readUInt32LE(12);
  const json = JSON.parse(b.slice(20, 20 + jsonLen).toString('utf8'));
  if (json.extensionsUsed && json.extensionsUsed.length) {
    throw new Error(`${path.basename(file)} uses ${json.extensionsUsed} — this reader assumes raw float32`);
  }
  const bin = 20 + jsonLen + 8; // header + JSON chunk + BIN chunk header
  return { json, b, bin };
}

function accessorOffset({ json, bin }, i) {
  const a = json.accessors[i];
  const v = json.bufferViews[a.bufferView];
  return { a, off: bin + (v.byteOffset || 0) + (a.byteOffset || 0) };
}

function readPositions(glb, i) {
  const { a, off } = accessorOffset(glb, i);
  if (a.componentType !== 5126) throw new Error(`POSITION is not float32 (${a.componentType})`);
  const P = new Array(a.count);
  for (let k = 0; k < a.count; k++) {
    const o = off + k * 12;
    P[k] = [glb.b.readFloatLE(o), glb.b.readFloatLE(o + 4), glb.b.readFloatLE(o + 8)];
  }
  return P;
}

function readIndices(glb, i) {
  const { a, off } = accessorOffset(glb, i);
  const I = new Array(a.count);
  for (let k = 0; k < a.count; k++) {
    I[k] = a.componentType === 5125 ? glb.b.readUInt32LE(off + k * 4)
      : a.componentType === 5123 ? glb.b.readUInt16LE(off + k * 2)
        : glb.b.readUInt8(off + k);
  }
  return I;
}

// ── geometry ────────────────────────────────────────────────────────────────
// Two triangle normals belong to the same FACE if they point within ~20 deg of each other.
const SAME_FACE = 0.94;
// Two faces are the FRONT AND BACK OF ONE SHEET if they point within ~20 deg of opposite...
const OPPOSED = -0.94;
// ...AND their areas are within 30% of each other. A window's back face mirrors its front; a
// wall's back face does not resemble its front at all. Without this, an L-shaped piece whose
// two limbs happen to face away from each other would be wrongly halved.
const AREA_MATCH = 0.7;

/**
 * Cluster a submesh's triangles by facing direction.
 * @returns {{n: number[], area: number}[]} area-weighted, largest first
 */
function faces(P, I) {
  const cl = [];
  for (let k = 0; k + 2 < I.length; k += 3) {
    const a = P[I[k]], b = P[I[k + 1]], c = P[I[k + 2]];
    const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2];
    const vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2];
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const len = Math.hypot(nx, ny, nz);
    if (!(len > 1e-12)) continue;                          // degenerate triangle
    const area = 0.5 * len;
    const u = [nx / len, ny / len, nz / len];
    let hit = cl.find((f) => f.n[0] * u[0] + f.n[1] * u[1] + f.n[2] * u[2] > SAME_FACE);
    if (!hit) cl.push(hit = { n: u, area: 0 });
    hit.area += area;
  }
  return cl.sort((a, b) => b.area - a.area);
}

/**
 * THE definition of glass area, and the only one in this file.
 *
 * Sum of TRIANGLE areas — never a bounding box, because a box drawn around four separate
 * window strips is mostly the gaps between them (35.13 m2 vs a true 17.10 m2 on the reference
 * mesh) — MINUS the back face of any double-sided sheet, because a pane you can see from both
 * sides is modelled twice and is still one pane of glass.
 */
function glassArea(P, I) {
  const F = faces(P, I);
  const dropped = new Set();
  for (let i = 0; i < F.length; i++) {
    if (dropped.has(i)) continue;
    for (let j = i + 1; j < F.length; j++) {
      if (dropped.has(j)) continue;
      const d = F[i].n[0] * F[j].n[0] + F[i].n[1] * F[j].n[1] + F[i].n[2] * F[j].n[2];
      const ratio = Math.min(F[i].area, F[j].area) / Math.max(F[i].area, F[j].area);
      if (d < OPPOSED && ratio > AREA_MATCH) { dropped.add(j); break; }  // F is sorted: j is the smaller
    }
  }
  let area = 0, raw = 0;
  for (let i = 0; i < F.length; i++) { raw += F[i].area; if (!dropped.has(i)) area += F[i].area; }
  return { area, raw, doubleSided: dropped.size > 0 };
}

/**
 * Split a submesh into its separate WINDOW PANES.
 *
 * The four strips of `..._6m_window` share no vertices with each other, so triangles that are
 * connected by a shared vertex index belong to the same pane. Union-find over the index
 * buffer recovers them: 8 triangles -> 4 panes, without assuming a quad layout, a winding, or
 * a vertex count.
 *
 * Each pane's rect is its own bbox — which is FINE, because a single pane IS a rectangle. The
 * error that this whole file exists to kill comes from taking a bbox over MULTIPLE panes.
 */
function panes(P, I) {
  const parent = new Array(P.length).fill(0).map((_, i) => i);
  const find = (x) => { while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; } return x; };
  const join = (x, y) => { const a = find(x), b = find(y); if (a !== b) parent[a] = b; };
  for (let k = 0; k + 2 < I.length; k += 3) { join(I[k], I[k + 1]); join(I[k + 1], I[k + 2]); }

  const group = new Map();
  for (let k = 0; k + 2 < I.length; k += 3) {
    const r = find(I[k]);
    if (!group.has(r)) group.set(r, []);
    group.get(r).push(I[k], I[k + 1], I[k + 2]);
  }

  const out = [];
  for (const idx of group.values()) {
    const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
    for (const v of idx) for (let d = 0; d < 3; d++) {
      if (P[v][d] < lo[d]) lo[d] = P[v][d];
      if (P[v][d] > hi[d]) hi[d] = P[v][d];
    }
    out.push({
      c: [0, 1, 2].map((d) => +((lo[d] + hi[d]) / 2).toFixed(4)),   // centre, LOCAL mesh space
      s: [0, 1, 2].map((d) => +(hi[d] - lo[d]).toFixed(4)),         // size
      a: +glassArea(P, idx).area.toFixed(4),                        // one-sided, same rule as the total
    });
  }
  return out;
}

function extents(acc) {
  return [0, 1, 2].map((d) => acc.max[d] - acc.min[d]);
}

// ── THE GLB IS Y-UP. THE GAME IS Z-UP. ──────────────────────────────────────
// glTF is Y-up by spec, so WolvenKit rotates the mesh on export. Same panel, both ways:
//
//   game (mesh JSON / ncz_assets.csv)   X[-6, 0]   Y[0, 0.24]   Z[0, 8]     Y is the thin axis
//   GLB                                 X[-6, 0]   Y[0, 8]      Z[-0.24, 0] Y is HEIGHT
//
// so  game = (x, -z, y).
//
// EVERYTHING THIS FILE EMITS IS IN GAME SPACE. It has to be: the consumer rotates these vectors
// by the node's GAME-space quaternion. Handing it a GLB-space normal and a game-space rotation
// silently turns every wall into a roof — the glass normal [0,0,-1] reads as "up", and the city's
// glass share came out 85% ROOF, which is how this was caught. A wrong basis does not throw; it
// produces a complete, plausible, and entirely wrong answer.
const toGame = (v) => [v[0], -v[2], v[1]];
// Sizes are magnitudes, so the axes swap but nothing is negated.
const sizeToGame = (v) => [v[0], v[2], v[1]];

// ── walk the exported GLBs ──────────────────────────────────────────────────
function walk(dir, hits) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, hits);
    else if (e.name.endsWith('.glb')) hits.push(p);
  }
  return hits;
}

const roots = ['base', 'ep1'].map((r) => path.join(RAW, r)).filter(fs.existsSync);
const glbs = roots.flatMap((r) => walk(r, []));
console.log(`\n${glbs.length} exported .glb found under ${roots.map((r) => path.basename(r)).join(', ')}\n`);

// ── extract ─────────────────────────────────────────────────────────────────
// KEYED BY CHUNK, not by appearance.
//
// 30.2% of the city's 7.6M placed instances use a NON-DEFAULT appearance, and on 190 meshes a
// non-default appearance glazes DIFFERENT CHUNKS than the default does (`default0` glazes
// chunks 1,3,4; `yellow2` glazes 1,3,5). Resolving glass against the default appearance alone
// would therefore misglaze up to a third of Night City — the same shape of silent, plausible,
// city-wide error as every other bug in this pipeline.
//
// So geometry is stored PER CHUNK (a chunk's triangles are the same whatever material is
// painted on it), and each appearance just lists WHICH chunks it glazes. Every instance already
// carries its appearance id (`ncz_instances.csv` -> `app`), so the join downstream is exact.
const geom = {};
const stat = {
  meshes: 0, withGlass: 0, withEmissive: 0, noGlass: 0, noMaterialJson: 0, unreadable: 0,
  glassChunks: 0, panes: 0, aabbThick: 0, doubleSided: 0, appVaries: 0,
};
const conflicts = [];
let totalGlass = 0, totalRaw = 0, totalPanel = 0, totalEmis = 0, totalNonEmis = 0;

for (const file of glbs) {
  const matFile = file.replace(/\.glb$/i, '.Material.json');
  // Key by the DEPOT path (`base\environment\...\x.mesh`) — that is what ncz_assets.csv holds,
  // and the join downstream is on that string.
  const depot = path.relative(RAW, file).replace(/\//g, '\\').replace(/\.glb$/i, '.mesh');
  stat.meshes++;

  if (!fs.existsSync(matFile)) { stat.noMaterialJson++; continue; }

  let glb, mat;
  try {
    glb = readGlb(file);
    mat = JSON.parse(fs.readFileSync(matFile, 'utf8'));
  } catch (e) {
    stat.unreadable++;
    if (conflicts.length < 40) conflicts.push(`UNREADABLE ${depot} — ${e.message}`);
    continue;
  }

  const byName = {};
  for (const m of (mat.Materials || [])) byName[m.Name] = m;
  const isGlassMat = (n) => {
    const m = byName[n];
    return !!(m && GLASS_MT.test(m.MaterialTemplate || ''));
  };

  // WolvenKit appends the appearance's INDEX to its name: `default0`, `yellow2`,
  // `brighter_ep17`. Strip it BY POSITION — a regex for trailing digits turns `brighter_ep17`
  // into `brighter_ep`, losing the `1` that is part of the real name (`brighter_ep1`).
  const appKeys = Object.keys(mat.Appearances || {});
  const appName = (key, i) => (key.endsWith(String(i)) ? key.slice(0, key.length - String(i).length) : key);

  // ── per-chunk geometry, computed once ──
  const chunks = {};                         // chunk index -> { area, raw, rects, n }
  let panelArea = 0;
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];

  for (const m of (glb.json.meshes || [])) {
    // `submesh_NN_LOD_L` — NN is the CHUNK INDEX. Read it; never infer it from array order
    // (the GLB exports one LOD, so the array is NOT the chunk list).
    const nn = /^submesh_(\d+)/.exec(m.name);
    if (!nn) continue;
    const c = parseInt(nn[1], 10);

    for (const pr of m.primitives) {
      const acc = glb.json.accessors[pr.attributes.POSITION];
      for (let d = 0; d < 3; d++) {          // whole-mesh bbox, for the overcount report only
        if (acc.min[d] < lo[d]) lo[d] = acc.min[d];
        if (acc.max[d] > hi[d]) hi[d] = acc.max[d];
      }

      // Is this chunk glass under ANY appearance? If no appearance ever paints glass on it, it
      // is concrete and we never need its geometry.
      const everGlass = appKeys.some((k) => isGlassMat(mat.Appearances[k][c]));
      if (!everGlass) continue;

      const P = readPositions(glb, pr.attributes.POSITION);
      const I = pr.indices !== undefined ? readIndices(glb, pr.indices)
        : Array.from({ length: P.length }, (_, i) => i);
      const g = glassArea(P, I);
      if (!(g.area > 0)) continue;

      // The shape heuristic, RECORDED not enforced (see the header). AABB-thick glass is a
      // SLOPED or CORNER pane — Corpo Plaza is full of them, and gating on flatness would
      // silently delete the most glazed district in Night City.
      const flat = [...extents(acc)].sort((a, b) => a - b)[0];
      if (flat >= FLAT_M) stat.aabbThick++;
      if (g.doubleSided) stat.doubleSided++;

      chunks[c] = {
        area: +g.area.toFixed(4),
        raw: +g.raw.toFixed(4),
        // Dominant glass normal, LOCAL mesh space — but converted to the GAME's Z-up basis,
        // because the consumer rotates it by the node's game-space quaternion.
        n: toGame(faces(P, I)[0].n).map((v) => +v.toFixed(4)),
        rects: panes(P, I).map((r) => ({ c: toGame(r.c), s: sizeToGame(r.s), a: r.a })),
      };
      stat.glassChunks++;
      stat.panes += chunks[c].rects.length;
    }
  }

  if (!Object.keys(chunks).length) { stat.noGlass++; continue; }

  const e = [0, 1, 2].map((d) => hi[d] - lo[d]).sort((a, b) => a - b);
  panelArea = e[1] * e[2];                   // what the OLD model lit. Reported, never consumed.

  // ── which chunks does each appearance glaze, and which of those GLOW? ──
  //
  // Both, because they are different questions and the answer differs. 43% of the glass area in
  // this city never lights up: `glass.mt` on doors, balustrades, shopfronts and the Corpo Plaza
  // roundabout canopy. Counting it as a window lights the wrong city.
  //
  // And it is per (appearance, chunk): the SAME chunk can be `window_parallax_interior` in one
  // appearance and plain `glass` in another, so "does this mesh glow" is not a question that has
  // one answer.
  const apps = {};
  const matParams = {};                        // material name -> its emissive params (or null)
  for (let i = 0; i < appKeys.length; i++) {
    const list = mat.Appearances[appKeys[i]];
    const g = [], e = [], mOf = {};
    for (const c of Object.keys(chunks).map(Number).sort((a, b) => a - b)) {
      const mn = list[c];
      if (!isGlassMat(mn)) continue;
      g.push(c);
      mOf[c] = mn;
      if (!(mn in matParams)) matParams[mn] = emissiveOf(byName[mn]);
      if (matParams[mn]) e.push(c);            // it GLOWS. This one is a window.
    }
    apps[appName(appKeys[i], i)] = { g, e, m: mOf };
  }
  // Does the choice of appearance actually change the glazed area? (It does on 222 meshes.)
  const areaOf = (list) => list.reduce((s, c) => s + chunks[c].area, 0);
  const defName = appName(appKeys[0], 0);
  const defA = apps[defName] || { g: [], e: [] };
  const defArea = areaOf(defA.g);
  const defEmis = areaOf(defA.e);
  if (Object.values(apps).some((a) => Math.abs(areaOf(a.g) - defArea) > 0.01)) stat.appVaries++;
  if (defEmis > 0) stat.withEmissive++;
  totalEmis += defEmis;
  totalNonEmis += defArea - defEmis;

  stat.withGlass++;
  totalGlass += defArea;
  totalRaw += Object.values(chunks).reduce((s, c) => s + c.raw, 0);
  totalPanel += panelArea;

  geom[depot.toLowerCase()] = {
    glassArea: +defArea.toFixed(4),      // ALL glass, default appearance. One-sided, m2.
    emisArea: +defEmis.toFixed(4),       // …of which GLOWS. THIS is the window area.
    panelArea: +panelArea.toFixed(4),    // what the old model lit — for the report only
    chunks,                              // chunk -> { area, raw, n, rects }
    apps,                                // appearance -> { g: glazed chunks, e: EMISSIVE chunks, m: chunk->material }
    matParams,                           // material -> its emissive params, or null if it does not glow
  };
}

// ── report ──────────────────────────────────────────────────────────────────
// COVERAGE NEXT TO EVERY AGGREGATE. Every hole in this pipeline was a silent filter that
// produced a complete-looking number, and not one was caught by tooling — each was caught by
// someone looking at a total and saying "that cannot be right". Make that easy to do.
const pct = (n, d) => (d ? `${((n / d) * 100).toFixed(1)}%` : '—');

console.log('=== INPUT');
console.log(`  .glb read               ${stat.meshes}`);
console.log(`  no .Material.json       ${stat.noMaterialJson}`);
console.log(`  unreadable              ${stat.unreadable}`);
console.log('\n=== OUTPUT');
console.log(`  meshes WITH glass       ${stat.withGlass}  (${pct(stat.withGlass, stat.meshes)} of exported)`);
console.log(`  meshes with NO glass    ${stat.noGlass}  (${pct(stat.noGlass, stat.meshes)}) — the over-include, working as intended`);
console.log(`  glass chunks            ${stat.glassChunks}`);
console.log(`  window panes            ${stat.panes}`);
console.log(`  appearance CHANGES area ${stat.appVaries}  (${pct(stat.appVaries, stat.withGlass)}) — resolved per-instance via \`app\``);
console.log('\n=== SHAPE — reported, NOT enforced (the heuristic does not generalise; see header)');
console.log(`  AABB-thick glass        ${stat.aabbThick}  (${pct(stat.aabbThick, stat.glassChunks)}) — sloped/corner glazing; area still exact`);
console.log(`  double-sided glass      ${stat.doubleSided}  (${pct(stat.doubleSided, stat.glassChunks)}) — back face dropped`);
console.log('\n=== GLASS IS NOT A WINDOW — EMISSIVE IS');
console.log(`  meshes with EMISSIVE glass ${stat.withEmissive}  (${pct(stat.withEmissive, stat.withGlass)} of glass-bearing)`);
console.log(`  EMISSIVE area              ${(totalEmis / 1000).toFixed(1)}k m2   <- the windows. Light these.`);
console.log(`  glass that does NOT glow   ${(totalNonEmis / 1000).toFixed(1)}k m2   (${pct(totalNonEmis, totalGlass)}) — doors, balustrades, shopfronts, canopies`);
console.log('     ^ counting these as windows lights the wrong city. The material says which is which.');

console.log('\n=== THE OVERCOUNT BEING KILLED');
console.log(`  raw triangle area       ${(totalRaw / 1000).toFixed(1)}k m2   (both faces of every double-sided pane)`);
console.log(`  ONE-SIDED glass area    ${(totalGlass / 1000).toFixed(1)}k m2   -> back faces were ${(totalRaw / totalGlass).toFixed(2)}x`);
console.log(`  panel area (TODAY)      ${(totalPanel / 1000).toFixed(1)}k m2   (the whole facade slab, concrete and all)`);
console.log(`\n  per-asset ratio         ${(totalPanel / totalGlass).toFixed(1)}x  <- UNWEIGHTED, and therefore NOT the answer.`);
console.log('  A mesh placed once counts the same here as one placed 40,000 times. The ratio that');
console.log('  matters is INSTANCE-WEIGHTED, and only window_boxes.js knows the placement counts.');

if (conflicts.length) {
  console.log('\n=== NOTES (first 40)');
  for (const c of conflicts) console.log(`  ${c}`);
}

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, JSON.stringify(geom));
console.log(`\nwrote ${OUT}  (${stat.withGlass} meshes, ${(fs.statSync(OUT).size / 1e6).toFixed(1)} MB)`);
console.log('then: node scripts/window_boxes.js --margin 2 --assign volume --bake --set fixed\n');
