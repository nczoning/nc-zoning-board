#!/usr/bin/env node
/**
 * exposure.js: decide, per placement, whether any camera the map permits can
 * ever see it.
 *
 * "Do not render interiors" is a statement about VISIBILITY, so it is measured
 * rather than inferred from a mesh's name. A folder called `\int\` says where
 * an artist filed a kit piece in 2019, not where it stands today, and this
 * pipeline has already been caught twice gating on a name (roads typed
 * GenericProxyMesh, signage not typed Advertisement).
 *
 * THE TEST IS THE CAMERA, NOT THE ROOM. An earlier version asked whether a ray
 * could travel N metres unobstructed, and the verdict simply tracked N: at 20 m
 * 88% of exterior placements passed against 85% of interior-named ones, at
 * 150 m it was 64% against 46%. Free path is not bimodal in a dense city, where
 * a street facade is blocked by the building opposite at 30 m and an interior
 * corridor runs 40 m clear.
 *
 * The map's own controls settle it without a tunable. OrbitControls is clamped
 * to CAMERA_MIN_TILT..CAMERA_MAX_TILT (dead top-down to ~70 degrees off
 * vertical, so never below 20 degrees above the horizon) at 800..15,000 units.
 * A surface is renderable exactly when a ray from it reaches open sky inside
 * that cone. Interiors stop being a special case: they are one subset of the
 * geometry that fails, alongside light wells, arcades and the undersides of
 * everything.
 *
 * Two properties follow, and both are deliberate:
 *
 *   - It errs toward VISIBLE. One ray out of the cone is enough, so a balcony
 *     or an alley wall that catches the camera at one angle stays.
 *   - Nothing is deleted. The verdict is written alongside the placements as a
 *     per-placement byte, so a consumer chooses what to do with it and this
 *     pass can be re-run without regenerating anything upstream.
 *
 * Known limit: a doorway or a missing wall leaks a room to the sky. Interiors
 * in this game are reached through closed doors, so the leak should be small,
 * and the disagreement lists printed here are the check on that rather than an
 * assumption.
 *
 * Usage:
 *   node scripts/exposure.js city_center                 # every placement
 *   node scripts/exposure.js city_center --only-int      # interior-named only
 *   node scripts/exposure.js city_center --rays 48 --tilt 70.2
 *
 * Output: data/exposure-<district>.bin   one Uint8 per stage-1 box
 *           0 unknown / 1 exposed / 2 enclosed / 3 skipped (no geometry)
 *         data/exposure-<district>.json  counts, settings, and the two
 *           disagreement lists that decide whether a name gate would have been
 *           safe: interior-named yet exposed, and enclosed yet not named.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const { MeshBvh, SceneBvh } = require('./bvh');
const { glbPathFor, meshTriangles } = require('./glb_lib');
const { categorize } = require('./asset_category');

const RAW_ROOT = 'd:/Modding/CP2077 Mods/MyMods/map_data_export/source/raw';
const args = process.argv.slice(2);
const name = args[0];
const flag = (k, d) => { const i = args.indexOf(`--${k}`); return i > 0 ? Number(args[i + 1]) : d; };

const RAYS    = flag('rays', 48);      // directions sampled inside the camera cone
// Degrees off vertical the map's OrbitControls allows: NCZ.CAMERA_MAX_TILT is
// Math.PI * 0.39. Kept as a flag so a future camera change is one number here,
// but it is a property of the product, not a tuning knob.
const TILT    = flag('tilt', 180 * 0.39);
const SAMPLES = flag('samples', 8);    // triangles sampled per placement, at least
const MAX_SAMPLES = flag('maxsamples', 24);
// Occluders nearer than this along a ray are ignored: a kit panel is bolted
// to its neighbours, and without it every direction off a facade reads blocked
// by the trim in front of it. Anything real that hides a surface is further
// away than a fitting, and the ray carries on past what is skipped, so a
// panel with a whole building behind it is still occluded by the building.
const NEAR_HIT = flag('nearhit', 0.35);
const MIN_DIM = flag('mindim', 1);     // ignore placements smaller than this
const LIMIT   = flag('limit', 0);      // test at most this many, spread evenly (0 = all)
const ONLY_INT = args.includes('--only-int');
// Test one asset across the whole district. An aggregate cannot answer "is
// this mesh being cut when it should not be", and a whole-population wipe on
// one asset is the signature that finds a bug: `207 cut / 0 kept` said more
// than any percentage did.
const ai = args.indexOf('--asset');
const ONLY_ASSET = ai > 0 ? args[ai + 1].toLowerCase() : null;

/**
 * What may occlude. A subdistrict shell is a kilometre-wide extruded boundary
 * polygon and an area proxy is a district-sized hollow box: either one in the
 * occluder set encloses the city and every placement reads as interior. They
 * are excluded here for the same reason the hull excludes them, and the
 * exclusion is by CATEGORY so it tracks asset_category.js rather than drifting
 * from it.
 */
const NOT_OCCLUDERS = new Set(['never', 'boundary', 'proxy']);

const INT_NAME = /\\int\\|\\int_|_int_|interior/i;

if (!name) {
  console.error('usage: node scripts/exposure.js <district> [--rays 32] [--escape 60] [--only-int]');
  process.exit(1);
}

const dataDir = path.join(__dirname, '..', 'data');
const meta = JSON.parse(fs.readFileSync(path.join(dataDir, `district-boxes-${name}.json`), 'utf8'));
const raw = fs.readFileSync(path.join(dataDir, `district-boxes-${name}.bin`));
const box = new Float32Array(raw.buffer, raw.byteOffset, raw.length / 4);
const S = meta.stride, nBox = meta.boxes;
const PATHS = meta.assetPaths || {};
const TYPE = meta.types || {};

console.log(`district ${name}`);
console.log(`  input     ${nBox.toLocaleString()} placements, stride ${S}`);

/**
 * Directions toward every camera position the map allows: the spherical cap
 * from straight up to `tiltDeg` off vertical, sampled by area so the oblique
 * angles are not under-represented (z uniform in [cos(tilt), 1] does that;
 * uniform in the ANGLE would crowd the samples at the pole).
 *
 * The golden angle spreads azimuth without the lat/long grid's seam.
 */
function coneDirections(n, tiltDeg) {
  const cosMax = Math.cos(tiltDeg * Math.PI / 180);
  const d = new Float64Array(n * 3);
  const phi = Math.PI * (3 - Math.sqrt(5));
  for (let i = 0; i < n; i++) {
    const z = cosMax + (1 - cosMax) * ((i + 0.5) / n);
    const r = Math.sqrt(Math.max(0, 1 - z * z));
    const th = phi * i;
    d[i * 3] = Math.cos(th) * r;
    d[i * 3 + 1] = Math.sin(th) * r;
    d[i * 3 + 2] = z;
  }
  return d;
}

// ── Build the scene ───────────────────────────────────────────────────────
// One BLAS per unique mesh, one instance per placement. Placements whose GLB
// is missing get no geometry: they cannot occlude and cannot be tested, and
// they are counted rather than silently dropped.
const blasByAsset = new Map();
const scene = new SceneBvh();
const instOfBox = new Int32Array(nBox).fill(-1);

let noGlb = 0, tooSmall = 0, neverKind = 0, tris = 0;
const t0 = Date.now();

for (let i = 0; i < nBox; i++) {
  const o = i * S;
  const dim = Math.max(box[o + 3], box[o + 4], box[o + 5]) * 2;
  if (dim < MIN_DIM) { tooSmall++; continue; }
  const aid = box[o + 10];
  const p = PATHS[aid] || '';
  const kind = categorize(p, TYPE[box[o + 11]] || '');
  if (NOT_OCCLUDERS.has(kind)) { neverKind++; continue; }

  let blas = blasByAsset.get(aid);
  if (blas === undefined) {
    blas = null;
    const file = glbPathFor(RAW_ROOT, p);
    if (p && fs.existsSync(file)) {
      try {
        const t = meshTriangles(file);
        if (t.length) { blas = new MeshBvh(t); tris += t.length / 9; }
      } catch { blas = null; }
    }
    blasByAsset.set(aid, blas);
  }
  if (!blas) { noGlb++; continue; }

  instOfBox[i] = scene.add(blas,
    [box[o + 13], box[o + 14], box[o + 15]],
    [box[o + 6], box[o + 7], box[o + 8], box[o + 9]],
    [box[o + 16], box[o + 17], box[o + 18]],
    i);
}

for (const b of blasByAsset.values()) if (b) b.trimBounds();
console.log(`  meshes    ${[...blasByAsset.values()].filter(Boolean).length.toLocaleString()} unique, ${Math.round(tris).toLocaleString()} triangles`);
console.log(`  instances ${scene.instances.length.toLocaleString()} placed (${noGlb.toLocaleString()} no GLB, ${tooSmall.toLocaleString()} under ${MIN_DIM} m, ${neverKind.toLocaleString()} never-geometry)`);
scene.build();
console.log(`  bvh       built in ${((Date.now() - t0) / 1000).toFixed(1)}s`);

// ── Test ──────────────────────────────────────────────────────────────────
const dirs = coneDirections(RAYS, TILT);
// A ray "reaches the sky" when it leaves the scene without hitting anything,
// so the cast length is the scene's own diagonal. Nothing exists beyond it,
// which is what makes this a property of the geometry and not of a constant.
const rootBox = scene.built ? Array.from(scene.built.nodes.subarray(0, 6)) : [0, 0, 0, 0, 0, 0];
const SKY = Math.hypot(rootBox[3] - rootBox[0], rootBox[4] - rootBox[1], rootBox[5] - rootBox[2]) * 1.05;
console.log(`  cone      ${RAYS} directions within ${TILT.toFixed(1)}deg of vertical, cast ${Math.round(SKY)} m to clear the scene`);
const verdict = new Uint8Array(nBox);   // 0 unknown, 1 exposed, 2 enclosed, 3 skipped
const intExposed = [], enclosedUnnamed = [];
let tested = 0, exposed = 0, enclosed = 0, rays = 0;
const t1 = Date.now();

// Which placements get tested. Every instance still occludes; this only
// narrows what is asked about, so a calibration run costs minutes instead of
// hours and reads the same as the full pass.
const candidates = [];
for (let i = 0; i < nBox; i++) {
  if (instOfBox[i] < 0) { verdict[i] = 3; continue; }
  if (ONLY_INT && !INT_NAME.test(PATHS[box[i * S + 10]] || '')) { verdict[i] = 0; continue; }
  if (ONLY_ASSET && !(PATHS[box[i * S + 10]] || '').toLowerCase().includes(ONLY_ASSET)) { verdict[i] = 0; continue; }
  candidates.push(i);
}
let todo = candidates;
if (LIMIT > 0 && candidates.length > LIMIT) {
  const step = candidates.length / LIMIT;
  todo = [];
  for (let k = 0; k < LIMIT; k++) todo.push(candidates[Math.floor(k * step)]);
}
console.log(`  testing   ${todo.length.toLocaleString()} of ${candidates.length.toLocaleString()} candidates` +
            `${ONLY_INT ? ' (interior-named only)' : ''}`);

for (const i of todo) {
  const inst = instOfBox[i];
  const o = i * S;

  // Sample the MESH, not the bounding box. A floor slab's box faces stand at
  // the slab's edges, which can be outside the room the slab is in, and a ray
  // launched from there escapes down the wall cavity and calls the floor
  // exposed. A triangle centroid is on the surface being asked about.
  const qx = box[o + 6], qy = box[o + 7], qz = box[o + 8], qw = box[o + 9];
  const m00 = 1 - 2 * (qy * qy + qz * qz), m01 = 2 * (qx * qy - qz * qw), m02 = 2 * (qx * qz + qy * qw);
  const m10 = 2 * (qx * qy + qz * qw), m11 = 1 - 2 * (qx * qx + qz * qz), m12 = 2 * (qy * qz - qx * qw);
  const m20 = 2 * (qx * qz - qy * qw), m21 = 2 * (qy * qz + qx * qw), m22 = 1 - 2 * (qx * qx + qy * qy);
  const px0 = box[o + 13], py0 = box[o + 14], pz0 = box[o + 15];
  const sx0 = box[o + 16], sy0 = box[o + 17], sz0 = box[o + 18];
  const cx = box[o], cy = box[o + 1], cz = box[o + 2];

  const tri = scene.instances[inst].blas.tris;
  const nTri = tri.length / 9;
  // Sample count follows mesh complexity: eight points describe a wall panel
  // and say almost nothing about a whole building shell. Square root keeps the
  // cost of the big meshes bounded while still walking their length.
  //
  // THE BUDGET IS TRIANGLES, NOT POINTS, and the difference is not cosmetic.
  // Budgeting points while pushing two per triangle stops the walk halfway
  // down the triangle list, so a mesh whose outward face is authored in the
  // second half is never sampled at all. Measured on one building:
  // wat_lch_building_c_facade_bottom_b was cut 207 times out of 207, an
  // exterior wall declared unreachable because the test only ever looked at
  // its inside.
  const wantTris = Math.min(MAX_SAMPLES, Math.max(SAMPLES, Math.round(Math.sqrt(nTri))));
  const step = Math.max(1, Math.floor(nTri / wantTris));
  const pts = [];
  for (let k = 0, taken = 0; k < nTri && taken < wantTris; k += step, taken++) {
    const t = k * 9;
    // Centroid and normal in mesh space, then scaled and rotated into world.
    const lx = (tri[t] + tri[t + 3] + tri[t + 6]) / 3 * sx0;
    const ly = (tri[t + 1] + tri[t + 4] + tri[t + 7]) / 3 * sy0;
    const lz = (tri[t + 2] + tri[t + 5] + tri[t + 8]) / 3 * sz0;
    const e1x = (tri[t + 3] - tri[t]) * sx0, e1y = (tri[t + 4] - tri[t + 1]) * sy0, e1z = (tri[t + 5] - tri[t + 2]) * sz0;
    const e2x = (tri[t + 6] - tri[t]) * sx0, e2y = (tri[t + 7] - tri[t + 1]) * sy0, e2z = (tri[t + 8] - tri[t + 2]) * sz0;
    let nx = e1y * e2z - e1z * e2y, ny = e1z * e2x - e1x * e2z, nz = e1x * e2y - e1y * e2x;
    const len = Math.hypot(nx, ny, nz);
    if (!(len > 0)) continue;
    nx /= len; ny /= len; nz /= len;
    const wx = px0 + m00 * lx + m01 * ly + m02 * lz;
    const wy = py0 + m10 * lx + m11 * ly + m12 * lz;
    const wz = pz0 + m20 * lx + m21 * ly + m22 * lz;
    const wnx = m00 * nx + m01 * ny + m02 * nz;
    const wny = m10 * nx + m11 * ny + m12 * nz;
    const wnz = m20 * nx + m21 * ny + m22 * nz;
    // Both sides: a kit panel is one-sided geometry whose winding says
    // nothing about which face is the room and which is the street.
    //
    // The origin stays ON the surface, a couple of centimetres clear. Pushing
    // it further to escape the neighbour is what NEAR_HIT does instead, and it
    // has to: a 0.20 m offset lands past the far face of a 0.18 m panel, which
    // cut wat_lch_building_c_facade_bottom_b 207 times out of 207 while the
    // 0.60 m panel beside it survived.
    pts.push([wx + wnx * 0.02, wy + wny * 0.02, wz + wnz * 0.02]);
    pts.push([wx - wnx * 0.02, wy - wny * 0.02, wz - wnz * 0.02]);
  }

  let free = false;
  for (const [px, py, pz] of pts) {
    for (let d = 0; d < RAYS; d++) {
      rays++;
      if (!scene.occluded(px, py, pz, dirs[d * 3], dirs[d * 3 + 1], dirs[d * 3 + 2], SKY, inst, NEAR_HIT)) { free = true; break; }
    }
    if (free) break;
  }

  verdict[i] = free ? 1 : 2;
  tested++;
  if (free) exposed++; else enclosed++;

  const p = PATHS[box[o + 10]] || '';
  const named = INT_NAME.test(p);
  if (named && free && intExposed.length < 400) {
    intExposed.push({ box: i, asset: p, x: +cx.toFixed(1), y: +cy.toFixed(1), z: +cz.toFixed(1) });
  }
  if (!named && !free && enclosedUnnamed.length < 400) {
    enclosedUnnamed.push({ box: i, asset: p, x: +cx.toFixed(1), y: +cy.toFixed(1), z: +cz.toFixed(1) });
  }

  if (tested % 1000 === 0) {
    const rate = tested / ((Date.now() - t1) / 1000);
    process.stdout.write(`\r  tested    ${tested.toLocaleString()} (${rate.toFixed(0)}/s, ${((todo.length - tested) / rate / 60).toFixed(1)} min left)   `);
  }
}
process.stdout.write('\r' + ' '.repeat(70) + '\r');

const secs = (Date.now() - t1) / 1000;
console.log(`  tested    ${tested.toLocaleString()} in ${secs.toFixed(1)}s (${rays.toLocaleString()} rays)`);
console.log(`  visible   ${exposed.toLocaleString()} (${(100 * exposed / Math.max(1, tested)).toFixed(1)}%)`);
console.log(`  hidden    ${enclosed.toLocaleString()} (${(100 * enclosed / Math.max(1, tested)).toFixed(1)}%)  never reachable by any permitted camera`);

// The two numbers that judge a name gate, in both directions.
let named = 0, namedExposed = 0, unnamedEnclosed = 0;
for (let i = 0; i < nBox; i++) {
  if (verdict[i] !== 1 && verdict[i] !== 2) continue;
  const p = PATHS[box[i * S + 10]] || '';
  if (INT_NAME.test(p)) { named++; if (verdict[i] === 1) namedExposed++; }
  else if (verdict[i] === 2) unnamedEnclosed++;
}
console.log(`\n  a \\int\\ name gate, judged against the measurement:`);
console.log(`    interior-named        ${named.toLocaleString()}`);
console.log(`    ...but VISIBLE        ${namedExposed.toLocaleString()} (${(100 * namedExposed / Math.max(1, named)).toFixed(1)}%)  <- the gate would delete these`);
console.log(`    hidden, NOT named     ${unnamedEnclosed.toLocaleString()}  <- the gate would keep these`);

fs.writeFileSync(path.join(dataDir, `exposure-${name}.bin`), Buffer.from(verdict.buffer, 0, nBox));
fs.writeFileSync(path.join(dataDir, `exposure-${name}.json`), JSON.stringify({
  district: name, boxes: nBox, rays: RAYS, tiltDegrees: TILT, skyMetres: Math.round(SKY),
  samples: SAMPLES, minDim: MIN_DIM,
  tested, visible: exposed, hidden: enclosed, skipped: nBox - tested,
  interiorNamed: named, interiorNamedButVisible: namedExposed, hiddenButNotNamed: unnamedEnclosed,
  legend: { 0: 'untested', 1: 'visible from the camera cone', 2: 'never visible', 3: 'skipped (no geometry)' },
  sampleInteriorNamedButExposed: intExposed,
  sampleEnclosedButNotNamed: enclosedUnnamed,
  generated: new Date().toISOString(),
}, null, 2));
console.log(`\n  wrote data/exposure-${name}.bin and .json`);
