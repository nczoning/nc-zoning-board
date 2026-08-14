#!/usr/bin/env node
/**
 * topdown_hull.js: stage 2 by top-down splitting, the way CDPR's own cloud
 * was measurably built.
 *
 * 76.7% of CDPR's city_center boxes share an exact face plane (within 15 cm)
 * with a same-yaw neighbour. Independent bounds, hand work, or any bottom-up
 * merge cannot produce that off-grid; a SPLIT can only produce it, because two
 * children inherit their parent's cut plane exactly. So their tool fit a box
 * per building and recursively split it where it over-covered. This generator
 * does the same:
 *
 *   1. Sample the real surface (LOD2 triangles) into a point cloud with
 *      normals. Points, not voxels: the output must carry no lattice.
 *   2. Label DISTRICT-WIDE connected components on a coarse marking grid.
 *      Per-group components were the footprint generator's failure: a 64 m
 *      cell slices a building at the border and the clutter gate then deletes
 *      the slices one at a time (city_center: 20,013 dropped fragments, the
 *      maintainer's "missing sections"). A component must be a whole mass
 *      before any gate looks at it.
 *   3. Per component, recursively split its points: each node estimates its
 *      own yaw from wall normals (an annex at its own angle tightens its own
 *      subtree), takes oriented bounds, and splits at the largest interior
 *      GAP (empty slab: two masses bridged by nothing), else at the biggest
 *      SETBACK (cross-section step), else at the median of the longest axis
 *      while any dimension exceeds the leaf size. Leaves are the boxes.
 *
 * Holes are impossible (a leaf bounds its points), steps are impossible (no
 * grid anywhere in the output), and detail is adaptive: a clean slab stays
 * one box while an articulated facade earns its splits.
 *
 * Output: district-hull-<name>.bin, shared 10-float layout.
 *
 * Usage:
 *   node --max-old-space-size=12288 scripts/topdown_hull.js city_center
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { glbPathFor, meshTriangles } = require('./glb_lib');
const { categorize } = require('./asset_category');
const { loadTerrain, indexTris, heightAtCet } = require('./terrain_lib');

const LOD_ROOT = 'd:/Modding/CP2077 Mods/MyMods/map_data_export/source/raw_alllod';
const RAW_ROOT = 'd:/Modding/CP2077 Mods/MyMods/map_data_export/source/raw';

const args = process.argv.slice(2);
const name = args[0];
const flag = (k, d) => { const i = args.indexOf(`--${k}`); return i > 0 ? Number(args[i + 1]) : d; };

const SAMP     = flag('samp', 2.5);     // metres between surface samples
const MARK     = flag('mark', 2);       // marking-grid cell for connectivity
const MIN_SIZE = flag('minsize', 2);
const MAX_SIZE = flag('maxsize', 1000);
const PROXY_MAX = flag('proxymax', 450);
const PROXY_COVER = flag('proxycover', 0.25);
const BELOW    = flag('below', 16);     // terrain clip, as everywhere else
const MIN_BBOX = flag('minbbox', 1000); // m3: drop components whose bbox is smaller
const MIN_HEIGHT = flag('minheight', 3);// m: drop components flatter than this (ground sheets)
const LEAF_MAX = flag('leafmax', 96);   // m: split any node bigger than this
const GAP_MIN  = flag('gapmin', 2.5);   // m: an interior empty slab this wide splits a node
const STEP_MIN = flag('stepmin', 0.35); // relative cross-section jump that counts as a setback
const MIN_DIM  = flag('mindim', 1.5);   // m: never split below this
const MIN_PTS  = 12;                    // never split a node with fewer points
const BIN      = 0.5;                   // m: histogram bin for gaps and setbacks
const FIT_TOL  = flag('fittol', 1.5);   // m: a point this close to a face supports it
const FIT_COV  = flag('fitcov', 0.55);  // every face at least this covered = the box IS the building
const FIT_BIN  = 3;                     // m: face-coverage bin

if (!name) { console.error('usage: node scripts/topdown_hull.js <district>'); process.exit(1); }

const dataDir = path.join(__dirname, '..', 'data');
const meta = JSON.parse(fs.readFileSync(path.join(dataDir, `district-boxes-${name}.json`), 'utf8'));
const raw  = fs.readFileSync(path.join(dataDir, `district-boxes-${name}.bin`));
const box  = new Float32Array(raw.buffer, raw.byteOffset, raw.length / 4);
const nBox = meta.boxes;
const S    = meta.stride;
const TYPE = meta.types || {};
const PATHS = meta.assetPaths || {};

const [minX, minY, minZ] = meta.bounds.min;
const [maxX, maxY, maxZ] = meta.bounds.max;

console.log(`district ${name}`);

// ── Classify ──────────────────────────────────────────────────────────────
const builders = [];
const proxies = [];
let skippedSmall = 0, skippedHuge = 0, skippedNever = 0, skippedProxy = 0;
for (let i = 0; i < nBox; i++) {
  const o = i * S;
  const largest = Math.max(box[o + 3], box[o + 4], box[o + 5]) * 2;
  if (largest < MIN_SIZE) { skippedSmall++; continue; }
  const cat = categorize(PATHS[box[o + 10]] || '', TYPE[box[o + 11]] || '');
  if (cat !== 'building' && cat !== 'proxy') { skippedNever++; continue; }
  if (largest > MAX_SIZE) { skippedHuge++; continue; }
  if (cat === 'proxy') {
    if (largest > PROXY_MAX) { skippedProxy++; continue; }
    proxies.push(i);
  } else builders.push(i);
}
console.log(`  input     ${builders.length.toLocaleString()} building placements, ${proxies.length.toLocaleString()} proxies held back`);
console.log(`  skipped   ${skippedSmall.toLocaleString()} small, ${skippedHuge.toLocaleString()} huge, ${skippedNever.toLocaleString()} never-geometry, ${skippedProxy.toLocaleString()} area proxies`);

// ── Triangle cache ────────────────────────────────────────────────────────
const trisCache = new Map();
function trisFor(aid) {
  if (trisCache.has(aid)) return trisCache.get(aid);
  let t = null;
  const p = PATHS[aid] || '';
  if (p) {
    let file = glbPathFor(LOD_ROOT, p);
    if (!fs.existsSync(file)) file = glbPathFor(RAW_ROOT, p);
    if (fs.existsSync(file)) { try { t = meshTriangles(file, 2); if (!t.length) t = null; } catch { t = null; } }
  }
  trisCache.set(aid, t);
  return t;
}

const terrain = indexTris(loadTerrain());

const quatToMat = (qx, qy, qz, qw) => [
  1 - 2 * (qy * qy + qz * qz), 2 * (qx * qy - qz * qw), 2 * (qx * qz + qy * qw),
  2 * (qx * qy + qz * qw), 1 - 2 * (qx * qx + qz * qz), 2 * (qy * qz - qx * qw),
  2 * (qx * qz - qy * qw), 2 * (qy * qz + qx * qw), 1 - 2 * (qx * qx + qy * qy),
];

// ── 1. Sample the surface ─────────────────────────────────────────────────
// Growable point store: xyz + packed wall-normal angle. The angle is the
// normal's horizontal direction folded mod 90 in tenths of a degree, or -1
// for faces too horizontal to say anything about yaw (roofs, floors).
let thinCounter = 0;
let cap = 1 << 22;
let PX = new Float32Array(cap), PY = new Float32Array(cap), PZ = new Float32Array(cap);
let PA = new Int16Array(cap);
let NP = 0;
function pushPt(x, y, z, ang) {
  if (NP === cap) {
    cap *= 2;
    const nx = new Float32Array(cap); nx.set(PX); PX = nx;
    const ny = new Float32Array(cap); ny.set(PY); PY = ny;
    const nz = new Float32Array(cap); nz.set(PZ); PZ = nz;
    const na = new Int16Array(cap); na.set(PA); PA = na;
  }
  PX[NP] = x; PY[NP] = y; PZ[NP] = z; PA[NP] = ang; NP++;
}

function samplePlacement(i) {
  const o = i * S;
  const tris = trisFor(box[o + 10]);
  const mq = quatToMat(box[o + 6], box[o + 7], box[o + 8], box[o + 9]);
  if (!tris) {
    // No GLB: the oriented box's corners and face centres stand in.
    const cx = box[o], cy = box[o + 1], cz = box[o + 2];
    const hx = box[o + 3], hy = box[o + 4], hz = box[o + 5];
    const yawDeg = Math.atan2(mq[3], mq[0]) * 180 / Math.PI;
    const ang = Math.round((((yawDeg % 90) + 90) % 90) * 10);
    for (let sx = -1; sx <= 1; sx++) for (let sy = -1; sy <= 1; sy++) for (let sz = -1; sz <= 1; sz++) {
      if (!sx && !sy && !sz) continue;
      const lx = sx * hx, ly = sy * hy, lz = sz * hz;
      pushPt(cx + mq[0] * lx + mq[1] * ly + mq[2] * lz,
             cy + mq[3] * lx + mq[4] * ly + mq[5] * lz,
             cz + mq[6] * lx + mq[7] * ly + mq[8] * lz, ang);
    }
    return;
  }
  const px0 = box[o + 13], py0 = box[o + 14], pz0 = box[o + 15];
  const sx = box[o + 16], sy = box[o + 17], sz = box[o + 18];
  for (let t = 0; t < tris.length; t += 9) {
    const a1 = tris[t] * sx,     a2 = tris[t + 1] * sy, a3 = tris[t + 2] * sz;
    const b1 = tris[t + 3] * sx, b2 = tris[t + 4] * sy, b3 = tris[t + 5] * sz;
    const c1 = tris[t + 6] * sx, c2 = tris[t + 7] * sy, c3 = tris[t + 8] * sz;
    const ax = px0 + mq[0] * a1 + mq[1] * a2 + mq[2] * a3, ay = py0 + mq[3] * a1 + mq[4] * a2 + mq[5] * a3, az = pz0 + mq[6] * a1 + mq[7] * a2 + mq[8] * a3;
    const bx = px0 + mq[0] * b1 + mq[1] * b2 + mq[2] * b3, by = py0 + mq[3] * b1 + mq[4] * b2 + mq[5] * b3, bz = pz0 + mq[6] * b1 + mq[7] * b2 + mq[8] * b3;
    const cx = px0 + mq[0] * c1 + mq[1] * c2 + mq[2] * c3, cy = py0 + mq[3] * c1 + mq[4] * c2 + mq[5] * c3, cz = pz0 + mq[6] * c1 + mq[7] * c2 + mq[8] * c3;
    const ux = bx - ax, uy = by - ay, uz = bz - az;
    const vx = cx - ax, vy = cy - ay, vz = cz - az;
    let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const nl = Math.hypot(nx, ny, nz);
    if (!(nl > 0)) continue;
    const area = 0.5 * nl;
    nx /= nl; ny /= nl; nz /= nl;
    let ang = -1;
    if (Math.abs(nz) < 0.7) {
      const deg = Math.atan2(ny, nx) * 180 / Math.PI;
      ang = Math.round((((deg % 90) + 90) % 90) * 10);
    }
    // A triangle smaller than the sample spacing contributes at most its
    // centroid, THINNED in proportion to its area: a 0.1 m2 sliver gets one
    // point per ~60 triangles, not one each. The kit is tens of millions of
    // sub-metre triangles; unthinned centroids alone were 50M points, and the
    // barycentric loop's six-point minimum before that was 294M and 4 GB.
    // Deterministic counter, not Math.random: reruns must be identical.
    if (area < SAMP * SAMP) {
      const k = Math.max(1, Math.round(SAMP * SAMP / Math.max(0.01, area)));
      if ((thinCounter++ % k) === 0) {
        pushPt((ax + bx + cx) / 3, (ay + by + cy) / 3, (az + bz + cz) / 3, ang);
      }
      continue;
    }
    let n = Math.ceil(Math.sqrt(area) / SAMP) + 1;
    if (n > 512) n = 512;
    for (let p = 0; p <= n; p++) for (let q = 0; p + q <= n; q++) {
      const s = p / n, t2 = q / n;
      pushPt(ax + ux * s + vx * t2, ay + uy * s + vy * t2, az + uz * s + vz * t2, ang);
    }
  }
}

for (const i of builders) samplePlacement(i);
console.log(`  sampled   ${NP.toLocaleString()} surface points from ${builders.length.toLocaleString()} placements`);

// ── 2. District-wide components on a marking grid ─────────────────────────
const NX = Math.ceil((maxX - minX) / MARK) + 2;
const NY = Math.ceil((maxY - minY) / MARK) + 2;
const NZ = Math.ceil((maxZ - minZ) / MARK) + 2;
const cellIdx = (x, y, z) => (z * NY + y) * NX + x;
const cellOf = p => {
  const gx = Math.min(NX - 1, Math.max(0, ((PX[p] - minX) / MARK) | 0));
  const gy = Math.min(NY - 1, Math.max(0, ((PY[p] - minY) / MARK) | 0));
  const gz = Math.min(NZ - 1, Math.max(0, ((PZ[p] - minZ) / MARK) | 0));
  return cellIdx(gx, gy, gz);
};
// Cell -> small component id via a Map (the grid is sparse: only marked cells).
const marked = new Map();   // cell -> -1 unlabelled, else component id
for (let p = 0; p < NP; p++) marked.set(cellOf(p), -1);
console.log(`  marked    ${marked.size.toLocaleString()} cells at ${MARK} m over a ${NX}x${NY}x${NZ} grid`);

// Strip the ground sheet BEFORE labelling, as district_hull does. Sidewalks
// and plaza plates connect every building on a block into one component, and
// a merged block defeats the splitter twice: streets stop reading as gaps
// (their columns hold ground points) and windows end up metres inside the
// merged bounds. Measured on pacifica before this strip: depth p50 8.51 m.
// A column of marked cells flatter than MIN_HEIGHT is ground; its points are
// dropped from the split set (buildings keep their own ground floors: their
// columns are tall).
{
  const colZ = new Map();   // xy key -> [zmin, zmax] over marked cells
  for (const k of marked.keys()) {
    const z = (k / (NX * NY)) | 0, xy = k % (NX * NY);
    const e = colZ.get(xy);
    if (!e) colZ.set(xy, [z, z]);
    else { if (z < e[0]) e[0] = z; if (z > e[1]) e[1] = z; }
  }
  let strippedCells = 0;
  for (const k of [...marked.keys()]) {
    const e = colZ.get(k % (NX * NY));
    if ((e[1] - e[0] + 1) * MARK < MIN_HEIGHT) { marked.delete(k); strippedCells++; }
  }
  console.log(`  ground    ${strippedCells.toLocaleString()} flat-column cells stripped before labelling`);
}

let nComp = 0;
{
  const stack = [];
  for (const seed of marked.keys()) {
    if (marked.get(seed) !== -1) continue;
    const id = nComp++;
    marked.set(seed, id); stack.push(seed);
    while (stack.length) {
      const k = stack.pop();
      const x = k % NX, y = ((k / NX) | 0) % NY, z = (k / (NX * NY)) | 0;
      // 26-connectivity: diagonal touches are one building.
      for (let dz = -1; dz <= 1; dz++) for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        if (!dx && !dy && !dz) continue;
        const x2 = x + dx, y2 = y + dy, z2 = z + dz;
        if (x2 < 0 || y2 < 0 || z2 < 0 || x2 >= NX || y2 >= NY || z2 >= NZ) continue;
        const k2 = cellIdx(x2, y2, z2);
        if (marked.get(k2) === -1) { marked.set(k2, id); stack.push(k2); }
      }
    }
  }
}
console.log(`  components ${nComp.toLocaleString()} district-wide`);

// Assign points to components, bucket by component. Points whose cell was
// stripped as ground carry no component and leave the split set.
const compOf = new Int32Array(NP);
const compCount = new Int32Array(nComp);
let groundPts = 0;
for (let p = 0; p < NP; p++) {
  const c = marked.get(cellOf(p));
  if (c === undefined) { compOf[p] = -1; groundPts++; continue; }
  compOf[p] = c; compCount[c]++;
}
const compStart = new Int32Array(nComp + 1);
for (let c = 0; c < nComp; c++) compStart[c + 1] = compStart[c] + compCount[c];
let order = new Int32Array(NP - groundPts);   // let: the proxy pass appends its own ranges
{
  const cursor = compStart.slice(0, nComp);
  for (let p = 0; p < NP; p++) if (compOf[p] >= 0) order[cursor[compOf[p]]++] = p;
}
console.log(`  ground    ${groundPts.toLocaleString()} points dropped with the sheet`);

// ── 3. Recursive splitting ────────────────────────────────────────────────
const out = [];
let leaves = 0, gapSplits = 0, stepSplits = 0, medianSplits = 0;
let compsDropped = 0, compsFlat = 0, compsKept = 0;

/** Dominant folded yaw (radians) of points [lo,hi) from wall normals; -1 if none vote. */
function yawOf(ord, lo, hi) {
  const hist = new Float64Array(90);
  let votes = 0;
  for (let k = lo; k < hi; k++) {
    const a = PA[ord[k]];
    if (a < 0) continue;
    hist[Math.min(89, (a / 10) | 0)]++;
    votes++;
  }
  if (!votes) return -1;
  let best = 0;
  for (let b = 1; b < 90; b++) if (hist[b] > hist[best]) best = b;
  // Refine within +-2 buckets of the peak (circular in the folded quarter).
  let sum = 0, w = 0;
  for (let d = -2; d <= 2; d++) {
    const b = ((best + d) % 90 + 90) % 90;
    let centre = best + d + 0.5;
    sum += hist[b] * centre; w += hist[b];
  }
  const deg = w ? sum / w : best + 0.5;
  return (deg % 90) * Math.PI / 180;
}

/**
 * Split node [lo,hi) of `order` in place. yaw is inherited when the node's own
 * walls cast no vote. depth caps runaway recursion on pathological input.
 */
function split(ord, lo, hi, inheritYaw, depth) {
  const n = hi - lo;
  let yaw = yawOf(ord, lo, hi);
  if (yaw < 0) yaw = inheritYaw;
  const ca = Math.cos(yaw), sa = Math.sin(yaw);

  // Oriented bounds in the yaw frame (z stays world-vertical).
  let x0 = Infinity, y0 = Infinity, z0 = Infinity, x1 = -Infinity, y1 = -Infinity, z1 = -Infinity;
  for (let k = lo; k < hi; k++) {
    const p = ord[k];
    const lx = ca * PX[p] + sa * PY[p];
    const ly = -sa * PX[p] + ca * PY[p];
    if (lx < x0) x0 = lx; if (lx > x1) x1 = lx;
    if (ly < y0) y0 = ly; if (ly > y1) y1 = ly;
    const z = PZ[p];
    if (z < z0) z0 = z; if (z > z1) z1 = z;
  }
  const dims = [x1 - x0, y1 - y0, z1 - z0];

  // ── The stopping criterion ──────────────────────────────────────────────
  // A node is DONE when every face of its box is made of surface: bin each
  // face at FIT_BIN and ask what fraction of bins hold a point within
  // FIT_TOL of the face plane. Interior mass (floor plates, interior walls)
  // is allowed to sit anywhere inside; massing swallows it. Without this
  // test the splitter keeps cutting at every interior density valley until
  // the leaves are the walls themselves: measured on pacifica, median box
  // 6.8 m, total volume 7.49 km3, the voxel shell reinvented with extra
  // steps. The bottom face is exempt (buildings stand on ground, which was
  // stripped), and faces under one bin are exempt (nothing to cover).
  //
  // CHECKED ONLY WHEN NO GAP OR VALLEY EXISTS. A Watson perimeter block
  // passes the face test as one box (buildings line the block's edge, so
  // every outer face is surface) while its interior alleys are buried up to
  // 20 m deep: a detected street always splits before fitness is asked.
  const fitsNow = () => {
    if (dims[0] > LEAF_MAX || dims[1] > LEAF_MAX || dims[2] > LEAF_MAX) return false;
    const nbx = Math.max(1, Math.ceil(dims[0] / FIT_BIN));
    const nby = Math.max(1, Math.ceil(dims[1] / FIT_BIN));
    const nbz = Math.max(1, Math.ceil(dims[2] / FIT_BIN));
    // Five tested faces: -x, +x, -y, +y, +z. 2D occupancy each.
    const fxm = new Uint8Array(nby * nbz), fxp = new Uint8Array(nby * nbz);
    const fym = new Uint8Array(nbx * nbz), fyp = new Uint8Array(nbx * nbz);
    const fzp = new Uint8Array(nbx * nby);
    for (let k = lo; k < hi; k++) {
      const p = ord[k];
      const lx = ca * PX[p] + sa * PY[p] - x0;
      const ly = -sa * PX[p] + ca * PY[p] - y0;
      const lz = PZ[p] - z0;
      const bx2 = Math.min(nbx - 1, (lx / FIT_BIN) | 0);
      const by2 = Math.min(nby - 1, (ly / FIT_BIN) | 0);
      const bz2 = Math.min(nbz - 1, (lz / FIT_BIN) | 0);
      if (lx < FIT_TOL) fxm[bz2 * nby + by2] = 1;
      if (dims[0] - lx < FIT_TOL) fxp[bz2 * nby + by2] = 1;
      if (ly < FIT_TOL) fym[bz2 * nbx + bx2] = 1;
      if (dims[1] - ly < FIT_TOL) fyp[bz2 * nbx + bx2] = 1;
      if (dims[2] - lz < FIT_TOL) fzp[by2 * nbx + bx2] = 1;
    }
    const cov = a => { let s = 0; for (let i = 0; i < a.length; i++) s += a[i]; return s / a.length; };
    for (const f of [fxm, fxp, fym, fyp, fzp]) {
      if (f.length <= 1) continue;
      if (cov(f) < FIT_COV) return false;
    }
    return true;
  };

  let cut = null;   // { axis: 0|1|2, at: coordinate, why }
  if (n >= MIN_PTS * 2 && depth < 24) {
    // a) largest interior gap across all three axes.
    let bestGap = GAP_MIN;
    for (let axis = 0; axis < 3; axis++) {
      if (dims[axis] < MIN_DIM * 2 + GAP_MIN) continue;
      const lo0 = axis === 0 ? x0 : axis === 1 ? y0 : z0;
      const nb = Math.max(1, Math.ceil(dims[axis] / BIN));
      const bins = new Int32Array(nb);
      for (let k = lo; k < hi; k++) {
        const p = ord[k];
        const v = axis === 0 ? ca * PX[p] + sa * PY[p] : axis === 1 ? -sa * PX[p] + ca * PY[p] : PZ[p];
        bins[Math.min(nb - 1, ((v - lo0) / BIN) | 0)]++;
      }
      let run = 0;
      for (let b = 1; b < nb - 1; b++) {
        if (bins[b] === 0) {
          run++;
          const gap = run * BIN;
          const edge0 = (b - run + 1) * BIN, edge1 = b * BIN;
          if (gap > bestGap && edge0 > MIN_DIM && dims[axis] - edge1 > MIN_DIM) {
            bestGap = gap;
            cut = { axis, at: lo0 + (edge0 + edge1) / 2 + BIN / 2, why: 'gap' };
          }
        } else run = 0;
      }
    }
    // a2) density VALLEY. Inside a merged block a street is never EMPTY (a
    // skybridge, a sign, one balcony kills the exact gap), but it is a deep
    // local minimum between two real masses. Split at the deepest bin that
    // holds under 10% of the smaller neighbouring peak, with at least 20% of
    // the node's points on each side, and the valley at least MIN_DIM from
    // both edges. Splitting a legitimate sparse waist costs one extra
    // shared-plane box; NOT splitting a street costs a box across the road,
    // which is where the 14.35 m median window burial came from.
    if (!cut) {
      let bestScore = 0;
      for (let axis = 0; axis < 3; axis++) {
        if (dims[axis] < MIN_DIM * 4) continue;
        const lo0 = axis === 0 ? x0 : axis === 1 ? y0 : z0;
        const nb = Math.max(4, Math.ceil(dims[axis] / (BIN * 2)));   // 1 m bins
        const bins = new Float64Array(nb);
        for (let k = lo; k < hi; k++) {
          const p = ord[k];
          const v = axis === 0 ? ca * PX[p] + sa * PY[p] : axis === 1 ? -sa * PX[p] + ca * PY[p] : PZ[p];
          bins[Math.min(nb - 1, ((v - lo0) / (BIN * 2)) | 0)]++;
        }
        // Prefix mass so the 20%-each-side test is O(1) per bin.
        const pre = new Float64Array(nb + 1);
        for (let b = 0; b < nb; b++) pre[b + 1] = pre[b] + bins[b];
        const total = pre[nb];
        const sufMax = new Float64Array(nb + 1);
        for (let b = nb - 1; b >= 0; b--) sufMax[b] = Math.max(sufMax[b + 1], bins[b]);
        let maxL = bins[0];
        for (let b = 1; b < nb - 1; b++) {
          maxL = Math.max(maxL, bins[b - 1]);
          if (pre[b] < total * 0.2 || total - pre[b + 1] < total * 0.2) continue;
          const at = lo0 + (b + 0.5) * BIN * 2;
          if (at - lo0 < MIN_DIM || (lo0 + dims[axis]) - at < MIN_DIM) continue;
          const peak = Math.min(maxL, sufMax[b + 1]);
          if (peak < MIN_PTS || bins[b] > peak * 0.1) continue;
          const score = peak / (bins[b] + 1);
          if (score > bestScore) { bestScore = score; cut = { axis, at, why: 'valley' }; }
        }
      }
    }
    // b) biggest sustained cross-section step (setback), horizontal axes and z.
    if (!cut) {
      let bestStep = STEP_MIN;
      for (let axis = 0; axis < 3; axis++) {
        if (dims[axis] < MIN_DIM * 4) continue;
        const lo0 = axis === 0 ? x0 : axis === 1 ? y0 : z0;
        const nb = Math.max(4, Math.ceil(dims[axis] / (BIN * 4)));   // coarser: 2 m slabs
        const bins = new Float64Array(nb);
        for (let k = lo; k < hi; k++) {
          const p = ord[k];
          const v = axis === 0 ? ca * PX[p] + sa * PY[p] : axis === 1 ? -sa * PX[p] + ca * PY[p] : PZ[p];
          bins[Math.min(nb - 1, ((v - lo0) / (BIN * 4)) | 0)]++;
        }
        for (let b = 1; b < nb - 1; b++) {
          const a = (bins[b - 1] + bins[b]) / 2, c = (bins[b] + bins[b + 1]) / 2;
          const hiV = Math.max(a, c), loV = Math.min(a, c);
          if (hiV < MIN_PTS) continue;
          const at = lo0 + (b + 0.5) * BIN * 4;
          if (at - lo0 < MIN_DIM || (lo0 + dims[axis]) - at < MIN_DIM) continue;
          const step = (hiV - loV) / hiV;
          if (step > bestStep) { bestStep = step; cut = { axis, at, why: 'step' }; }
        }
      }
    }
    // c) too big to be one box: median of the longest axis.
    if (!cut) {
      const axis = dims.indexOf(Math.max(...dims));
      if (dims[axis] > LEAF_MAX) {
        const vals = new Float32Array(n);
        for (let k = lo; k < hi; k++) {
          const p = ord[k];
          vals[k - lo] = axis === 0 ? ca * PX[p] + sa * PY[p] : axis === 1 ? -sa * PX[p] + ca * PY[p] : PZ[p];
        }
        vals.sort();
        cut = { axis, at: vals[n >> 1], why: 'median' };
      }
    }
  }

  // A vertical cut must change the FOOTPRINT, or it is a floor plate. Plates
  // are density peaks and the bands between them valleys, so an unvalidated
  // z-valley slices every tower into storey slabs. A true shoulder (tower
  // over podium) leaves different XY occupancy above and below; a plate
  // leaves the same footprint on both sides. Empty-gap cuts are exempt: real
  // air (an arch, a bridge over nothing) may keep the footprint.
  if (cut && cut.axis === 2 && cut.why !== 'gap') {
    const nbx = Math.max(1, Math.ceil(dims[0] / 4)), nby = Math.max(1, Math.ceil(dims[1] / 4));
    const below2 = new Uint8Array(nbx * nby), above2 = new Uint8Array(nbx * nby);
    for (let k = lo; k < hi; k++) {
      const p = ord[k];
      const lx = ca * PX[p] + sa * PY[p] - x0;
      const ly = -sa * PX[p] + ca * PY[p] - y0;
      const bx2 = Math.min(nbx - 1, (lx / 4) | 0), by2 = Math.min(nby - 1, (ly / 4) | 0);
      (PZ[p] <= cut.at ? below2 : above2)[by2 * nbx + bx2] = 1;
    }
    let nb2 = 0, na2 = 0, shared = 0;
    for (let i = 0; i < nbx * nby; i++) {
      nb2 += below2[i]; na2 += above2[i];
      if (below2[i] && above2[i]) shared++;
    }
    const small = Math.min(nb2, na2), large = Math.max(nb2, na2);
    if (large > 0 && small / large > 0.8 && shared / (large || 1) > 0.8) cut = null;
  }

  if (cut) {
    // Partition in place around the cut.
    let i = lo, j = hi - 1;
    while (i <= j) {
      const p = ord[i];
      const v = cut.axis === 0 ? ca * PX[p] + sa * PY[p] : cut.axis === 1 ? -sa * PX[p] + ca * PY[p] : PZ[p];
      if (v <= cut.at) i++;
      else { const tmp = ord[i]; ord[i] = ord[j]; ord[j] = tmp; j--; }
    }
    if (i > lo && i < hi) {
      if (cut.why === 'gap' || cut.why === 'valley') gapSplits++; else if (cut.why === 'step') stepSplits++; else medianSplits++;
      split(ord, lo, i, yaw, depth + 1);
      split(ord, i, hi, yaw, depth + 1);
      return;
    }
    // Degenerate partition: fall through and emit as a leaf.
  }

  emitLeaf(yaw, ca, sa, x0, x1, y0, y1, z0, z1);
}

/** Emit one oriented leaf box, terrain-clipped. */
function emitLeaf(yaw, ca, sa, x0, x1, y0, y1, z0, z1) {
  const wcx0 = (x0 + x1) / 2, wcy0 = (y0 + y1) / 2;
  const wcx = ca * wcx0 - sa * wcy0, wcy = sa * wcx0 + ca * wcy0;
  const g = heightAtCet(terrain, wcx, wcy);
  let zBot = z0;
  const zTop = z1;
  if (g !== null) {
    const floor = g - BELOW;
    if (zTop <= floor) return;
    if (zBot < floor) zBot = floor;
  }
  const qz = Math.sin(yaw * 0.5), qw = Math.cos(yaw * 0.5);
  out.push({
    c: [wcx, wcy, (zBot + zTop) / 2],
    h: [Math.max(MIN_DIM, x1 - x0) / 2, Math.max(MIN_DIM, y1 - y0) / 2, Math.max(0.5, zTop - zBot) / 2],
    q: yaw === 0 ? [0, 0, 0, 1] : [0, 0, qz, qw],
  });
  leaves++;
}

for (let c = 0; c < nComp; c++) {
  const lo = compStart[c], hi = compStart[c + 1];
  if (hi - lo < 3) { compsDropped++; continue; }
  // Bbox gates on the raw axis bounds: clutter and ground sheets.
  let x0 = Infinity, y0 = Infinity, z0 = Infinity, x1 = -Infinity, y1 = -Infinity, z1 = -Infinity;
  for (let k = lo; k < hi; k++) {
    const p = order[k];
    if (PX[p] < x0) x0 = PX[p]; if (PX[p] > x1) x1 = PX[p];
    if (PY[p] < y0) y0 = PY[p]; if (PY[p] > y1) y1 = PY[p];
    if (PZ[p] < z0) z0 = PZ[p]; if (PZ[p] > z1) z1 = PZ[p];
  }
  if ((x1 - x0) * (y1 - y0) * (z1 - z0) < MIN_BBOX) { compsDropped++; continue; }
  if (z1 - z0 < MIN_HEIGHT) { compsFlat++; continue; }
  compsKept++;
  split(order, lo, hi, 0, 0);
}
console.log(`  split     ${compsKept.toLocaleString()} components -> ${leaves.toLocaleString()} leaf boxes ` +
            `(${gapSplits.toLocaleString()} gap + ${stepSplits.toLocaleString()} setback + ${medianSplits.toLocaleString()} median splits; ` +
            `${compsDropped.toLocaleString()} clutter, ${compsFlat.toLocaleString()} ground sheets dropped)`);

// ── Proxies: split only where the massing left a hole ─────────────────────
const CELL = 32;
const hash = new Map();
const boxesAt = (x, y) => hash.get(`${Math.floor(x / CELL)},${Math.floor(y / CELL)}`) || [];
function indexBox(b, i) {
  const r = Math.hypot(b.h[0], b.h[1]);
  for (let cx = Math.floor((b.c[0] - r) / CELL); cx <= Math.floor((b.c[0] + r) / CELL); cx++)
    for (let cy = Math.floor((b.c[1] - r) / CELL); cy <= Math.floor((b.c[1] + r) / CELL); cy++) {
      const k = `${cx},${cy}`;
      let l = hash.get(k); if (!l) hash.set(k, l = []);
      l.push(i);
    }
}
out.forEach((b, i) => indexBox(b, i));
const mats = out.map(b => quatToMat(b.q[0], b.q[1], b.q[2], b.q[3]));
function insideAny(x, y, z) {
  for (const i of boxesAt(x, y)) {
    const b = out[i], m = mats[i];
    const dx = x - b.c[0], dy = y - b.c[1], dz = z - b.c[2];
    const bx = m[0] * dx + m[3] * dy + m[6] * dz;
    const by = m[1] * dx + m[4] * dy + m[7] * dz;
    const bz = m[2] * dx + m[5] * dy + m[8] * dz;
    if (Math.abs(bx) <= b.h[0] && Math.abs(by) <= b.h[1] && Math.abs(bz) <= b.h[2]) return true;
  }
  return false;
}

let proxyUsed = 0, proxyCovered = 0;
proxies.sort((a, b) =>
  box[a * S + 3] * box[a * S + 4] * box[a * S + 5] - box[b * S + 3] * box[b * S + 4] * box[b * S + 5]);
for (const i of proxies) {
  const o = i * S;
  const m = quatToMat(box[o + 6], box[o + 7], box[o + 8], box[o + 9]);
  let occ = 0;
  for (let fz = -1; fz <= 1; fz++) for (let fy = -1; fy <= 1; fy++) for (let fx = -1; fx <= 1; fx++) {
    const lx = fx * box[o + 3] * 0.66, ly = fy * box[o + 4] * 0.66, lz = fz * box[o + 5] * 0.66;
    const wx = box[o]     + m[0] * lx + m[1] * ly + m[2] * lz;
    const wy = box[o + 1] + m[3] * lx + m[4] * ly + m[5] * lz;
    const wz = box[o + 2] + m[6] * lx + m[7] * ly + m[8] * lz;
    if (insideAny(wx, wy, wz)) occ++;
  }
  if (occ / 27 >= PROXY_COVER) { proxyCovered++; continue; }

  // Sample the proxy's own surface into a fresh point range and split it.
  const before = out.length;
  const npBefore = NP;
  samplePlacement(i);
  if (NP > npBefore) {
    // split() takes its index array explicitly, so a proxy's points get a
    // small local one instead of reallocating the district's.
    const localOrder = new Int32Array(NP - npBefore);
    for (let k = 0; k < localOrder.length; k++) localOrder[k] = npBefore + k;
    split(localOrder, 0, localOrder.length, 0, 0);
  }
  if (out.length === before) {
    // Nothing sampled (no GLB): the dump's box, terrain-clipped.
    const g = heightAtCet(terrain, box[o], box[o + 1]);
    let zBot = box[o + 2] - box[o + 5];
    const zTop = box[o + 2] + box[o + 5];
    if (g !== null) {
      const floor = g - BELOW;
      if (zTop <= floor) continue;
      if (zBot < floor) zBot = floor;
    }
    out.push({
      c: [box[o], box[o + 1], (zBot + zTop) * 0.5],
      h: [box[o + 3], box[o + 4], (zTop - zBot) * 0.5],
      q: [box[o + 6], box[o + 7], box[o + 8], box[o + 9]],
    });
  }
  for (let j = before; j < out.length; j++) {
    indexBox(out[j], j);
    mats.push(quatToMat(out[j].q[0], out[j].q[1], out[j].q[2], out[j].q[3]));
  }
  proxyUsed++;
}
console.log(`  proxies   ${proxyUsed.toLocaleString()} split in where the massing left a hole, ${proxyCovered.toLocaleString()} rejected as covered`);

// ── Shape statistics ──────────────────────────────────────────────────────
{
  const dims = out.map(b => Math.max(b.h[0], b.h[1], b.h[2]) * 2).sort((a, b) => a - b);
  const med = dims.length ? dims[dims.length >> 1] : 0;
  let vol = 0, axis = 0;
  for (const b of out) { vol += 8 * b.h[0] * b.h[1] * b.h[2]; if (b.q[3] === 1) axis++; }
  console.log(`  shape     median largest dim ${med.toFixed(1)} m, ` +
              `${(100 * (out.length - axis) / (out.length || 1)).toFixed(1)}% oriented, ` +
              `${(vol / 1e9).toFixed(2)} km3 (CDPR city_center: 24.0 m, 86.6%, 101.38 km3)`);
}
console.log(`  BOXES     ${out.length.toLocaleString()} after top-down splitting ` +
            `(${out.filter(b => b.q[3] === 1).length.toLocaleString()} axis + ${out.filter(b => b.q[3] !== 1).length.toLocaleString()} oriented)`);

// ── Write ─────────────────────────────────────────────────────────────────
const buf = new Float32Array(out.length * 10);
out.forEach((b, i) => {
  const o = i * 10;
  buf[o] = b.c[0]; buf[o + 1] = b.c[1]; buf[o + 2] = b.c[2];
  buf[o + 3] = b.h[0]; buf[o + 4] = b.h[1]; buf[o + 5] = b.h[2];
  buf[o + 6] = b.q[0]; buf[o + 7] = b.q[1]; buf[o + 8] = b.q[2]; buf[o + 9] = b.q[3];
});
fs.writeFileSync(path.join(dataDir, `district-hull-${name}.bin`), Buffer.from(buf.buffer));
// A fresh cloud invalidates the pre-snap backup, or snap_hull re-snaps the
// old cloud from .presnap.bin and this run's output never ships.
fs.rmSync(path.join(dataDir, `district-hull-${name}.presnap.bin`), { force: true });

fs.writeFileSync(path.join(dataDir, `district-hull-${name}.json`), JSON.stringify({
  // No `grid` key on purpose: score_hull pairs it with district-grid-<name>.bin,
  // which this generator does not write.
  district: name, bounds: meta.bounds, generator: 'topdown',
  samp: SAMP, mark: MARK, minSize: MIN_SIZE, maxSize: MAX_SIZE,
  minBbox: MIN_BBOX, minHeight: MIN_HEIGHT, leafMax: LEAF_MAX,
  gapMin: GAP_MIN, stepMin: STEP_MIN, below: BELOW, proxyMax: PROXY_MAX,
  points: NP, components: nComp, compsKept, compsDropped, compsFlat,
  gapSplits, stepSplits, medianSplits,
  boxes: out.length, proxyUsed, proxyCovered,
  stride: 10, layout: 'centre xyz, halfExtent xyz, quat xyzw (float32)',
  generated: new Date().toISOString(),
}, null, 2));

console.log(`\n  wrote data/district-hull-${name}.bin`);
console.log(`  CDPR ships 41,291 boxes for city_center; this run produced ${out.length.toLocaleString()}.`);
