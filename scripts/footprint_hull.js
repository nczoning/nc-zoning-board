#!/usr/bin/env node
/**
 * footprint_hull.js: stage 2, targeting CDPR's SHAPE instead of surface
 * accuracy.
 *
 * The voxel hull (district_hull.js) beats CDPR's shipped cloud on accuracy AND
 * completeness and still looks worse, because it is a fine shell of small
 * axis-aligned boxes: every gap shows the empty interior, every diagonal wall
 * steps. CDPR's cloud is the opposite shape: a tenth of the boxes at four
 * times the size, 87% oriented, holding 2.3x the volume. Coarse solid massing
 * over-covers, and at map distance the eye reads silhouette and mass, so it
 * wins. See wiki learning the-box-cloud-metric-only-ever-measured-accuracy.
 *
 * So this generator answers CDPR's question ("what mass does this building
 * occupy"), not the hull's ("where is every surface"):
 *
 *   1. GROUP placements spatially: the dump's assembly where it names one,
 *      else the game's own 64 m L0 cell. Position is the only key every
 *      placement has; sector|prefab alone loses half the city (see wiki
 *      learning prefab-is-an-annotation-not-an-organising-principle).
 *   2. Per group, find the dominant YAW (volume-weighted, folded mod 90) and
 *      work in that frame, so diagonals come out diagonal instead of stepped.
 *   3. Rasterise the group's real geometry into a local grid, reduce each XY
 *      column to its top and bottom, and read the FOOTPRINT at height z as
 *      "columns reaching z". That function only ever shrinks with height, so
 *      it segments cleanly into bands where the massing steps back.
 *   4. Per connected footprint component, per band: a few oriented boxes from
 *      a greedy 2D rectangle cover of the band's footprint (mergeGrid's rules
 *      one dimension down, with air tolerance so surface noise does not
 *      fragment the massing). One rect per band was measured first and buried
 *      city_center's windows 2.4 m deep: a concave footprint's bounding
 *      rectangle is mostly air.
 *
 * Proxies keep district_hull's semantics: smallest first, a proxy counts only
 * where the boxes already emitted do not cover it, and an ACCEPTED proxy is
 * extruded from its TRIANGLES like any building group. Its raw box is the
 * fallback, not the answer: cct_cpz_building_a_v1_horizontal's box includes
 * the air between the towers it stands for. Thousands of towers exist in the
 * dump only as their proxy.
 *
 * Output is district-hull-<name>.bin in the shared 10-float layout, so
 * snap_hull, score_hull, coverage, encode_hull_dds and the renderer all read
 * it unchanged.
 *
 * Usage:
 *   node scripts/footprint_hull.js city_center
 *   node scripts/footprint_hull.js watson --res 1 --drop 0.2 --air2d 0.25
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

const RES      = flag('res', 1);       // local raster cell, metres
const GRID     = flag('grid', 64);     // spatial group cell (the game's L0)
const MIN_SIZE = flag('minsize', 2);   // placement gates, same as district_hull
const MAX_SIZE = flag('maxsize', 1000);
const PROXY_MAX = flag('proxymax', 450);
const PROXY_COVER = flag('proxycover', 0.25);
const BELOW    = flag('below', 16);    // metres kept below the terrain surface
const MIN_MASS = flag('minmass', 1536); // m3: drop footprint components smaller than this
// Shape defaults measured on city_center against CDPR's cloud (window score
// 36.3% vs their 30.9% at 0.5 m, depth p50 0.95 vs 1.37 m, 27,845 boxes vs
// their 40,128). Tighter settings (drop 0.2, band 4, air 0.25, no minrect)
// scored 43.7% but cost 117,593 boxes, triple CDPR's count: past this point
// accuracy is bought with the box budget, and the budget is the look.
const DROP     = flag('drop', 0.3);    // start a new band when the footprint shrinks by this fraction
const MIN_BAND = flag('minband', 6);   // metres: a band thinner than this joins its neighbour
const AIR2D    = flag('air2d', 0.4);   // a band rectangle may be this much air
const MIN_RECT = flag('minrect', 12);  // m2: drop band rects smaller than this unless they carry the band
const MAX_CELLS = 48e6;                // local grid budget; res coarsens to fit

if (!name) { console.error('usage: node scripts/footprint_hull.js <district> [--res 1]'); process.exit(1); }

const dataDir = path.join(__dirname, '..', 'data');
const meta = JSON.parse(fs.readFileSync(path.join(dataDir, `district-boxes-${name}.json`), 'utf8'));
const raw  = fs.readFileSync(path.join(dataDir, `district-boxes-${name}.bin`));
const box  = new Float32Array(raw.buffer, raw.byteOffset, raw.length / 4);
const nBox = meta.boxes;
const S    = meta.stride;
const TYPE = meta.types || {};
const PATHS = meta.assetPaths || {};

console.log(`district ${name}`);
console.log(`  input     ${nBox.toLocaleString()} placements, grouping on assembly else ${GRID} m cell`);

// ── Classify and group ────────────────────────────────────────────────────
const groups = new Map();
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
    continue;
  }
  const aid = box[o + 19];
  const key = aid >= 0 ? `a${aid}`
    : `g${Math.floor(box[o] / GRID)}_${Math.floor(box[o + 1] / GRID)}`;
  let g = groups.get(key); if (!g) groups.set(key, g = []);
  g.push(i);
}
console.log(`  groups    ${groups.size.toLocaleString()} (${proxies.length.toLocaleString()} proxies held back)`);
console.log(`  skipped   ${skippedSmall.toLocaleString()} under ${MIN_SIZE} m, ${skippedHuge.toLocaleString()} over ${MAX_SIZE} m, ` +
            `${skippedNever.toLocaleString()} never-geometry, ${skippedProxy.toLocaleString()} area proxies`);

// ── Triangle cache: one GLB read per asset, coarsest authored LOD ─────────
// Massing needs silhouette, not mullions, and LOD2 is a quarter of the
// triangles. meshTriangles picks the coarsest level at or below the ask.
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

/** Folded yaw (0..90 deg) of placement i; a rectangle repeats every quarter turn. */
function foldedYawDeg(i) {
  const o = i * S;
  const yaw = Math.atan2(2 * (box[o + 9] * box[o + 8] + box[o + 6] * box[o + 7]),
    1 - 2 * (box[o + 7] * box[o + 7] + box[o + 8] * box[o + 8])) * 180 / Math.PI;
  return ((yaw % 90) + 90) % 90;
}

/**
 * Greedy rectangle cover of a 2D 0/1 mask: mergeGrid's growth rules one
 * dimension down. A rect may take in air while it stays at least minFrac
 * solid, a slab with no new solid cell stops growth (a street never bridges),
 * and a slab holding an already-claimed cell stops it (no cell covered
 * twice). Mutates the mask: covered solid cells become 2.
 */
function coverRects(mask, nx, ny, minFrac) {
  const rects = [];
  const census = (x0, x1, y0, y1) => {
    let s = 0;
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
      const v = mask[y * nx + x];
      if (v === 2) return -1;
      if (v === 1) s++;
    }
    return s;
  };
  for (let y = 0; y < ny; y++) for (let x = 0; x < nx; x++) {
    if (mask[y * nx + x] !== 1) continue;
    let ex = x, ey = y, solid = 1, cells = 1, grew = true;
    while (grew) {
      grew = false;
      if (ex + 1 < nx) {
        const s = census(ex + 1, ex + 1, y, ey);
        if (s > 0 && (solid + s) / (cells + (ey - y + 1)) >= minFrac) { ex++; solid += s; cells += ey - y + 1; grew = true; }
      }
      if (ey + 1 < ny) {
        const s = census(x, ex, ey + 1, ey + 1);
        if (s > 0 && (solid + s) / (cells + (ex - x + 1)) >= minFrac) { ey++; solid += s; cells += ex - x + 1; grew = true; }
      }
    }
    for (let yy = y; yy <= ey; yy++) for (let xx = x; xx <= ex; xx++)
      if (mask[yy * nx + xx] === 1) mask[yy * nx + xx] = 2;
    rects.push([x, y, ex, ey, solid]);
  }
  return rects;
}

const out = [];   // { c:[x,y,z], h:[hx,hy,hz], q:[x,y,z,w] }
let groupsDone = 0, groupsSkipped = 0, boxesEmitted = 0, compsDropped = 0;
let axisCount = 0, orientedCount = 0;

/**
 * Extrude one spatial group of placements into massing boxes, pushed onto
 * `out`. minMass gates footprint components; a proxy extruding alone passes 0
 * because its clutter gate already ran at classification. Returns boxes
 * pushed, or -1 when the group exceeded the raster budget.
 */
function extrudeMembers(members, minMass) {
  const before = out.length;

  // Dominant yaw, weighted by box volume so trim never outvotes the tower.
  const hist = new Array(90).fill(0);
  for (const i of members) {
    const o = i * S;
    hist[Math.floor(foldedYawDeg(i)) % 90] += box[o + 3] * box[o + 4] * box[o + 5];
  }
  let best = 0;
  for (let b = 0; b < 90; b++) if (hist[b] > hist[best]) best = b;
  // Bucket 0 is called axis-aligned and gets yaw 0 exactly: emitting identity
  // quats for boxes fitted in a half-degree frame would smear long walls.
  const yaw = best === 0 ? 0 : (best + 0.5) * Math.PI / 180;
  const ca = Math.cos(yaw), sa = Math.sin(yaw);
  const w2lx = (dx, dy) => ca * dx + sa * dy;   // world -> group (inverse yaw)
  const w2ly = (dx, dy) => -sa * dx + ca * dy;

  // Group bounds from each member's oriented box corners, in the group frame.
  // The anchor is the first member's position; only differences matter.
  const a0 = members[0] * S;
  const ax = box[a0 + 13], ay = box[a0 + 14], az = box[a0 + 15];
  let lx0 = Infinity, ly0 = Infinity, lz0 = Infinity, lx1 = -Infinity, ly1 = -Infinity, lz1 = -Infinity;
  for (const i of members) {
    const o = i * S;
    const m = quatToMat(box[o + 6], box[o + 7], box[o + 8], box[o + 9]);
    for (let s0 = -1; s0 <= 1; s0 += 2) for (let s1 = -1; s1 <= 1; s1 += 2) for (let s2 = -1; s2 <= 1; s2 += 2) {
      const ex = s0 * box[o + 3], ey = s1 * box[o + 4], ez = s2 * box[o + 5];
      const wx = box[o]     + m[0] * ex + m[1] * ey + m[2] * ez;
      const wy = box[o + 1] + m[3] * ex + m[4] * ey + m[5] * ez;
      const wz = box[o + 2] + m[6] * ex + m[7] * ey + m[8] * ez;
      const px = w2lx(wx - ax, wy - ay), py = w2ly(wx - ax, wy - ay), pz = wz - az;
      if (px < lx0) lx0 = px; if (px > lx1) lx1 = px;
      if (py < ly0) ly0 = py; if (py > ly1) ly1 = py;
      if (pz < lz0) lz0 = pz; if (pz > lz1) lz1 = pz;
    }
  }

  // Coarsen the raster until the group fits the budget rather than skipping it.
  let res = RES;
  let nx, ny, nz;
  for (;;) {
    nx = Math.max(1, Math.ceil((lx1 - lx0) / res) + 2);
    ny = Math.max(1, Math.ceil((ly1 - ly0) / res) + 2);
    nz = Math.max(1, Math.ceil((lz1 - lz0) / res) + 2);
    if (nx * ny * nz <= MAX_CELLS) break;
    res *= 1.5;
    if (res > 16) break;
  }
  if (nx * ny * nz > MAX_CELLS) { groupsSkipped++; return -1; }
  const gx0 = lx0 - res, gy0 = ly0 - res, gz0 = lz0 - res;
  const lg = new Uint8Array(nx * ny * nz);
  const li = (x, y, z) => (z * ny + y) * nx + x;

  for (const i of members) {
    const o = i * S;
    const tris = trisFor(box[o + 10]);
    const mq = quatToMat(box[o + 6], box[o + 7], box[o + 8], box[o + 9]);
    if (tris) {
      // Mesh -> group in one matrix: placement rotation, then inverse yaw.
      const m = [
        ca * mq[0] + sa * mq[3], ca * mq[1] + sa * mq[4], ca * mq[2] + sa * mq[5],
        -sa * mq[0] + ca * mq[3], -sa * mq[1] + ca * mq[4], -sa * mq[2] + ca * mq[5],
        mq[6], mq[7], mq[8],
      ];
      const dx = box[o + 13] - ax, dy = box[o + 14] - ay;
      const ox = w2lx(dx, dy), oy = w2ly(dx, dy), oz = box[o + 15] - az;
      const sx = box[o + 16], sy = box[o + 17], sz = box[o + 18];
      for (let t = 0; t < tris.length; t += 9) {
        const a1 = tris[t] * sx,     a2 = tris[t + 1] * sy, a3 = tris[t + 2] * sz;
        const b1 = tris[t + 3] * sx, b2 = tris[t + 4] * sy, b3 = tris[t + 5] * sz;
        const c1 = tris[t + 6] * sx, c2 = tris[t + 7] * sy, c3 = tris[t + 8] * sz;
        const pax = ox + m[0] * a1 + m[1] * a2 + m[2] * a3, pay = oy + m[3] * a1 + m[4] * a2 + m[5] * a3, paz = oz + m[6] * a1 + m[7] * a2 + m[8] * a3;
        const pbx = ox + m[0] * b1 + m[1] * b2 + m[2] * b3, pby = oy + m[3] * b1 + m[4] * b2 + m[5] * b3, pbz = oz + m[6] * b1 + m[7] * b2 + m[8] * b3;
        const pcx = ox + m[0] * c1 + m[1] * c2 + m[2] * c3, pcy = oy + m[3] * c1 + m[4] * c2 + m[5] * c3, pcz = oz + m[6] * c1 + m[7] * c2 + m[8] * c3;
        const ux = pbx - pax, uy = pby - pay, uz = pbz - paz;
        const vx = pcx - pax, vy = pcy - pay, vz = pcz - paz;
        const cxn = uy * vz - uz * vy, cyn = uz * vx - ux * vz, czn = ux * vy - uy * vx;
        const area = 0.5 * Math.hypot(cxn, cyn, czn);
        if (!(area > 0)) continue;
        let n = Math.ceil(Math.sqrt(area) / (res * 0.5)) + 1;
        if (n > 512) n = 512;
        for (let p = 0; p <= n; p++) for (let q = 0; p + q <= n; q++) {
          const s = p / n, t2 = q / n;
          const gx = ((pax + ux * s + vx * t2 - gx0) / res) | 0;
          const gy = ((pay + uy * s + vy * t2 - gy0) / res) | 0;
          const gz = ((paz + uz * s + vz * t2 - gz0) / res) | 0;
          if (gx < 0 || gy < 0 || gz < 0 || gx >= nx || gy >= ny || gz >= nz) continue;
          lg[li(gx, gy, gz)] = 1;
        }
      }
    } else {
      // No GLB: the placement's oriented box marks the cells it covers, the
      // same fallback the voxel hull uses.
      const cxw = box[o], cyw = box[o + 1], czw = box[o + 2];
      const hx = box[o + 3], hy = box[o + 4], hz = box[o + 5];
      const lcx = w2lx(cxw - ax, cyw - ay), lcy = w2ly(cxw - ax, cyw - ay), lcz = czw - az;
      // Conservative local AABB of the rotated box.
      const ex = Math.abs(mq[0]) * hx + Math.abs(mq[1]) * hy + Math.abs(mq[2]) * hz;
      const ey = Math.abs(mq[3]) * hx + Math.abs(mq[4]) * hy + Math.abs(mq[5]) * hz;
      const er = Math.hypot(ex, ey);
      const x0 = Math.max(0, ((lcx - er - gx0) / res) | 0), x1 = Math.min(nx - 1, ((lcx + er - gx0) / res) | 0);
      const y0 = Math.max(0, ((lcy - er - gy0) / res) | 0), y1 = Math.min(ny - 1, ((lcy + er - gy0) / res) | 0);
      const ez2 = Math.abs(mq[6]) * hx + Math.abs(mq[7]) * hy + Math.abs(mq[8]) * hz;
      const z0 = Math.max(0, ((lcz - ez2 - gz0) / res) | 0), z1 = Math.min(nz - 1, ((lcz + ez2 - gz0) / res) | 0);
      // Test cell centres against the ORIENTED box (world-space inverse rotate),
      // so a yawed box does not fatten to its AABB.
      for (let z = z0; z <= z1; z++) for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
        const lxc = gx0 + (x + 0.5) * res, lyc = gy0 + (y + 0.5) * res, lzc = gz0 + (z + 0.5) * res;
        const wxc = ax + ca * lxc - sa * lyc, wyc = ay + sa * lxc + ca * lyc, wzc = az + lzc;
        const dxw = wxc - cxw, dyw = wyc - cyw, dzw = wzc - czw;
        const bx = mq[0] * dxw + mq[3] * dyw + mq[6] * dzw;
        const by = mq[1] * dxw + mq[4] * dyw + mq[7] * dzw;
        const bz = mq[2] * dxw + mq[5] * dyw + mq[8] * dzw;
        if (Math.abs(bx) > hx + res * 0.5 || Math.abs(by) > hy + res * 0.5 || Math.abs(bz) > hz + res * 0.5) continue;
        lg[li(x, y, z)] = 1;
      }
    }
  }

  // ── Columns: top and bottom of solid per XY cell ────────────────────────
  const colTop = new Int32Array(nx * ny).fill(-1);
  const colBot = new Int32Array(nx * ny).fill(-1);
  for (let z = 0; z < nz; z++) for (let y = 0; y < ny; y++) {
    const row = (z * ny + y) * nx, cRow = y * nx;
    for (let x = 0; x < nx; x++) {
      if (!lg[row + x]) continue;
      if (colBot[cRow + x] < 0) colBot[cRow + x] = z;
      colTop[cRow + x] = z;
    }
  }

  // ── Components on the full footprint (8-connected) ──────────────────────
  const label = new Int32Array(nx * ny).fill(-1);
  const compCols = [];
  const stack = [];
  for (let start = 0; start < nx * ny; start++) {
    if (colTop[start] < 0 || label[start] >= 0) continue;
    const id = compCols.length;
    const cols = [];
    label[start] = id; stack.push(start);
    while (stack.length) {
      const k = stack.pop();
      cols.push(k);
      const x = k % nx, y = (k / nx) | 0;
      for (let dy2 = -1; dy2 <= 1; dy2++) for (let dx2 = -1; dx2 <= 1; dx2++) {
        if (!dx2 && !dy2) continue;
        const x2 = x + dx2, y2 = y + dy2;
        if (x2 < 0 || y2 < 0 || x2 >= nx || y2 >= ny) continue;
        const k2 = y2 * nx + x2;
        if (colTop[k2] < 0 || label[k2] >= 0) continue;
        label[k2] = id; stack.push(k2);
      }
    }
    compCols.push(cols);
  }

  // ── Per component: mass gate, bands, rectangle cover per band ───────────
  const mask = new Uint8Array(nx * ny);
  for (const cols of compCols) {
    let vol = 0, zMin = Infinity, zMax = -1;
    for (const k of cols) {
      vol += (colTop[k] - colBot[k] + 1);
      if (colBot[k] < zMin) zMin = colBot[k];
      if (colTop[k] > zMax) zMax = colTop[k];
    }
    vol *= res * res * res;
    if (vol < minMass) { compsDropped++; continue; }

    // Footprint area by height: columns reaching z. Monotone non-increasing.
    const reach = new Int32Array(zMax - zMin + 1);
    for (const k of cols) reach[colTop[k] - zMin]++;
    for (let z = reach.length - 2; z >= 0; z--) reach[z] += reach[z + 1];

    // Band cuts where the footprint has shrunk DROP from the band's start.
    const minBandCells = Math.max(1, Math.round(MIN_BAND / res));
    const cuts = [0];
    let startArea = reach[0];
    for (let z = 1; z < reach.length; z++) {
      if (reach[z] < startArea * (1 - DROP) && z - cuts[cuts.length - 1] >= minBandCells) {
        cuts.push(z); startArea = reach[z];
      }
    }
    cuts.push(reach.length);

    for (let b = 0; b + 1 < cuts.length; b++) {
      const bz0 = zMin + cuts[b], bz1 = zMin + cuts[b + 1] - 1;   // inclusive slice range
      let any = 0;
      for (const k of cols) if (colTop[k] >= bz0) { mask[k] = 1; any++; }
      if (!any) continue;
      const rects = coverRects(mask, nx, ny, 1 - AIR2D);
      for (const k of cols) mask[k] = 0;   // reset, including claimed cells

      for (const [rx0, ry0, rx1, ry1, solid] of rects) {
        // A sliver at the band's edge adds a box and no silhouette. It is
        // dropped unless it IS the band (a thin tower or antenna whose whole
        // footprint is small carries most of the band's solid cells).
        const rArea = (rx1 - rx0 + 1) * (ry1 - ry0 + 1) * res * res;
        if (MIN_RECT && rArea < MIN_RECT && solid < any * 0.5) continue;
        const lcx = gx0 + (rx0 + rx1 + 1) * 0.5 * res;
        const lcy = gy0 + (ry0 + ry1 + 1) * 0.5 * res;
        const hx = (rx1 - rx0 + 1) * res * 0.5;
        const hy = (ry1 - ry0 + 1) * res * 0.5;
        let zBot = az + gz0 + bz0 * res;
        const zTop = az + gz0 + (bz1 + 1) * res;
        const wcx = ax + ca * lcx - sa * lcy;
        const wcy = ay + sa * lcx + ca * lcy;

        // Terrain clip, same policy as the hull: keep BELOW metres, cut deeper.
        const g = heightAtCet(terrain, wcx, wcy);
        let zBot2 = zBot;
        if (g !== null) {
          const floor = g - BELOW;
          if (zTop <= floor) continue;
          if (zBot2 < floor) zBot2 = floor;
        }

        const qz = Math.sin(yaw * 0.5), qw = Math.cos(yaw * 0.5);
        const aligned = best === 0;
        out.push({
          c: [wcx, wcy, (zBot2 + zTop) * 0.5],
          h: [hx, hy, (zTop - zBot2) * 0.5],
          q: aligned ? [0, 0, 0, 1] : [0, 0, qz, qw],
        });
        if (aligned) axisCount++; else orientedCount++;
        boxesEmitted++;
      }
    }
  }
  return out.length - before;
}

for (const members of groups.values()) {
  if (extrudeMembers(members, MIN_MASS) >= 0) groupsDone++;
}

console.log(`  extruded  ${groupsDone.toLocaleString()} groups -> ${boxesEmitted.toLocaleString()} band boxes ` +
            `(${compsDropped.toLocaleString()} components under ${MIN_MASS} m3 dropped, ${groupsSkipped} groups over budget)`);

// ── Proxies: extrude only where the massing left a hole ───────────────────
// Smallest first, so a building-scale proxy claims its own gap before a
// subdistrict shell is asked. The probe is 27 samples against the boxes
// already emitted; an accepted proxy extrudes from its triangles, and only a
// proxy with no GLB emits the raw box the dump gives it.
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

let proxyUsed = 0, proxyCovered = 0, proxyMeshed = 0;
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

  const before = out.length;
  if (trisFor(box[o + 10])) {
    // The proxy's clutter gate already ran (>= MIN_SIZE at classification),
    // so the component mass gate passes 0: a proxy IS a building's massing.
    if (extrudeMembers([i], 0) > 0) proxyMeshed++;
  }
  if (out.length === before) {
    // No GLB, or the extrusion produced nothing: fall back to the dump's box.
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
    orientedCount++;
  }
  for (let j = before; j < out.length; j++) {
    indexBox(out[j], j);
    mats.push(quatToMat(out[j].q[0], out[j].q[1], out[j].q[2], out[j].q[3]));
  }
  proxyUsed++;
}
console.log(`  proxies   ${proxyUsed.toLocaleString()} emitted where the massing left a hole ` +
            `(${proxyMeshed.toLocaleString()} extruded from triangles), ` +
            `${proxyCovered.toLocaleString()} rejected as covered (>= ${(PROXY_COVER * 100).toFixed(0)}%)`);

// ── Shape statistics: the target is CDPR's numbers, so print them ─────────
{
  const dims = out.map(b => Math.max(b.h[0], b.h[1], b.h[2]) * 2).sort((a, b) => a - b);
  const med = dims.length ? dims[dims.length >> 1] : 0;
  let vol = 0;
  for (const b of out) vol += 8 * b.h[0] * b.h[1] * b.h[2];
  console.log(`  shape     median largest dim ${med.toFixed(1)} m, ` +
              `${(100 * orientedCount / (out.length || 1)).toFixed(1)}% oriented, ` +
              `${(vol / 1e9).toFixed(2)} km3 total volume (CDPR city_center: 24.0 m, 86.6%, 101.38 km3)`);
}

console.log(`  BOXES     ${out.length.toLocaleString()} after footprint extrusion ` +
            `(${axisCount.toLocaleString()} axis + ${orientedCount.toLocaleString()} oriented)`);

// ── Write, in the shared 10-float layout ──────────────────────────────────
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
  // No `grid` key on purpose: score_hull pairs district-hull JSON's grid
  // fields with district-grid-<name>.bin, which this generator does not write,
  // and a stale voxel grid must not be read as if it described this cloud.
  district: name, bounds: meta.bounds, generator: 'footprint',
  res: RES, groupCell: GRID, minSize: MIN_SIZE, maxSize: MAX_SIZE, minMass: MIN_MASS,
  drop: DROP, minBand: MIN_BAND, air2d: AIR2D, below: BELOW, proxyMax: PROXY_MAX,
  groups: groups.size, groupsDone, groupsSkipped, compsDropped,
  boxes: out.length, axisBoxes: axisCount, orientedBoxes: orientedCount,
  proxyUsed, proxyMeshed, proxyCovered,
  stride: 10, layout: 'centre xyz, halfExtent xyz, quat xyzw (float32)',
  generated: new Date().toISOString(),
}, null, 2));

console.log(`\n  wrote data/district-hull-${name}.bin`);
console.log(`  CDPR ships 41,291 boxes for city_center; this run produced ${out.length.toLocaleString()}.`);
