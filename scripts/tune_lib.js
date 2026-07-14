/**
 * scripts/tune_lib.js
 * ─────────────────────────────────────────────────────────────────────────
 * Shared headless pipeline for the archetype/clustering tooling. LIFTS the
 * canonical code (DISTRICT_META, clusterBuildingBoxes, pointInPolygon) verbatim
 * out of the live source so the tools can't drift from what renders, and ports
 * the DDS decode + classify chain. Consumed by:
 *   - scripts/tune_archetypes.js   (param sweep + scoring)
 *   - scripts/tune_analyze.js      (cluster-size + district-span analysis)
 *
 * If you change clustering / classify in three-scene.js, re-run the tools — the
 * lifted pieces auto-update; only classifyBuilding() is a hand-mirror (kept in
 * sync by comment reference to three-scene.js:2480-2517).
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const SCENE = fs.readFileSync(path.join(ROOT, 'assets/js/three-scene.js'), 'utf8');
const CONSTS = fs.readFileSync(path.join(ROOT, 'assets/js/constants.js'), 'utf8');
const UTILS = fs.readFileSync(path.join(ROOT, 'assets/js/utils.js'), 'utf8');

// ── lift balanced bracketed regions out of source ────────────────────────────
function sliceBalanced(src, marker, open, close) {
  const i = src.indexOf(marker);
  if (i < 0) throw new Error(`marker not found: ${marker}`);
  const start = src.indexOf(open, i);
  let depth = 0;
  for (let k = start; k < src.length; k++) {
    if (src[k] === open) depth++;
    else if (src[k] === close && --depth === 0) return src.slice(i, k + 1);
  }
  throw new Error(`unbalanced region from ${marker}`);
}

const metaSrc = sliceBalanced(SCENE, 'const DISTRICT_META', '[', ']')
  .replace(/^const\s+DISTRICT_META\s*=\s*/, '');
// eslint-disable-next-line no-eval
const DISTRICT_META = eval(`(${metaSrc})`);

const clusterSrc = sliceBalanced(SCENE, 'function clusterBuildingBoxes', '{', '}');
// eslint-disable-next-line no-eval
const clusterBuildingBoxes = eval(`(${clusterSrc})`);

// pointInPolygon is an assignment `NCZ.pointInPolygon = function (...) {...};`
const pipSrc = sliceBalanced(UTILS, 'NCZ.pointInPolygon = function', '{', '}');
// eslint-disable-next-line no-eval
const pointInPolygon = eval(`(function ${pipSrc.slice(pipSrc.indexOf('('))})`);

// ── numeric NCZ.* constants ──────────────────────────────────────────────────
const NCZ = {};
for (const m of CONSTS.matchAll(/NCZ\.(\w+)\s*=\s*(-?\d+(?:\.\d+)?)\s*;/g)) {
  NCZ[m[1]] = parseFloat(m[2]);
}

// The live height-discontinuity segmenter, lifted verbatim. It references
// NCZ.BUILDING_SEG_* — resolved from this module's NCZ (built just above), so it
// must be eval'd here, after NCZ exists. This is now the canonical grouping used
// by both the renderer and the harness.
const segSrc = sliceBalanced(SCENE, 'function segmentBuildings', '{', '}');
// eslint-disable-next-line no-eval
const segmentBuildings = eval(`(${segSrc})`);

// Districts the 'fixed' asset set renders, minus the single-building debug isolate.
const DISTRICTS = DISTRICT_META.filter((m) => m.name !== 'ugly_building');

// ── DDS decode (port of loadBuildings, three-scene.js ~2068) ─────────────────
function loadDataDds(absPath) {
  const buf = fs.readFileSync(absPath);
  const width = buf.readUInt32LE(16);
  const height = buf.readUInt32LE(12);
  const off = NCZ.DDS_PIXEL_OFFSET;
  const pixels = new Uint16Array(buf.buffer, buf.byteOffset + off, (buf.length - off) >> 1);
  return { pixels, width, height };
}

function decodeDistrict(meta) {
  const ddsPath = meta.dataDdsFixed || meta.dataDds;
  const { pixels, width: texW, height: texH } = loadDataDds(path.join(ROOT, ddsPath));
  const blockW = Math.floor(texW / 3);
  const blockH = Math.min(texH, blockW);
  const T = NCZ.DDS_ALPHA_THRESH, U = NCZ.UINT16_MAX, CS = meta.cubeSize;
  const tMin = meta.transMin, tMax = meta.transMax, ofs = meta.offset;

  // TWO descriptions of the same box, and they are NOT interchangeable:
  //
  //   bh*  the world AABB      — axis-aligned, and for a yawed box it is a DIFFERENT, BIGGER box.
  //                              Median 1.96x the true volume; 3.39x on the City Center slab below.
  //                              Correct for a broad-phase (culling, spatial hash). Nothing else.
  //   bt*  the TRUE half-extents + bq* the quaternion — the box the RENDERER actually draws.
  //
  // The rotation used to be decoded here, used to build the matrix, and then thrown away. Only
  // 26.6% of the city's boxes are within 5 deg of an axis; the median box is yawed 26.3 deg. So
  // every script that asked "which way does this wall face" got an answer about a bounding box:
  //
  //   a real 12.1 x 60.7 x 68.0 m slab in City Center, yawed 33 deg
  //     TRUE  side faces 57 deg (NNE)                       elongation 60.7/12.1 = 5.0  (a SLAB)
  //     AABB  57.5 x 43.3 x 68.0, side faces 0 deg (E)      elongation 57.5/43.3 = 1.3  (a BLOCK)
  //
  // That single collapse is why the game's windows would not land (48.7% of them matched no wall
  // at all), and why a yawed slab classifies as a chunky block. USE bt*/bq* FOR ANYTHING THAT
  // CARES WHAT SHAPE OR WHICH WAY. Use bh* only when a conservative bound is genuinely what you
  // want. See wiki/learnings/the-aabb-is-a-different-box.
  const bcx = [], bcy = [], bcz = [], bhx = [], bhy = [], bhz = [];
  const btx = [], bty = [], btz = [];                       // TRUE half-extents (THREE space)
  const bqx = [], bqy = [], bqz = [], bqw = [];             // orientation (THREE space)
  for (let y = 0; y < blockH; y++) {
    for (let x = 0; x < blockW; x++) {
      const pi = (y * texW + x) * 4;
      const ri = (y * texW + x + blockW) * 4;
      const si = (y * texW + x + 2 * blockW) * 4;
      const scaleEmpty = pixels[si] < T && pixels[si + 1] < T && pixels[si + 2] < T;
      if (pixels[pi + 3] < T || scaleEmpty) continue;

      const pr = pixels[pi] / U, pg = pixels[pi + 1] / U, pb = pixels[pi + 2] / U;
      const cetX = tMin[0] + (tMax[0] - tMin[0]) * pr + ofs[0];
      const cetY = tMin[1] + (tMax[1] - tMin[1]) * pg + ofs[1];
      const cetZ = tMin[2] + (tMax[2] - tMin[2]) * pb;

      const qr = pixels[ri] / U * 2 - 1, qg = pixels[ri + 1] / U * 2 - 1;
      const qb = pixels[ri + 2] / U * 2 - 1, qa = pixels[ri + 3] / U * 2 - 1;
      const ql = Math.hypot(qr, qg, qb, qa) || 1;
      const X = qr / ql, Y = qb / ql, Z = -qg / ql, W = qa / ql;

      const hx = pixels[si] / U * CS, hy = pixels[si + 1] / U * CS, hz = pixels[si + 2] / U * CS;
      const sx = hx * 2, sy = hz * 2, sz = hy * 2;

      const x2 = X + X, y2 = Y + Y, z2 = Z + Z;
      const xx = X * x2, xy = X * y2, xz = X * z2;
      const yy = Y * y2, yz = Y * z2, zz = Z * z2;
      const wx = W * x2, wy = W * y2, wz = W * z2;
      const e0 = (1 - (yy + zz)) * sx, e1 = (xy + wz) * sx, e2 = (xz - wy) * sx;
      const e4 = (xy - wz) * sy, e5 = (1 - (xx + zz)) * sy, e6 = (yz + wx) * sy;
      const e8 = (xz + wy) * sz, e9 = (yz - wx) * sz, e10 = (1 - (xx + yy)) * sz;

      bcx.push(cetX); bcy.push(cetZ); bcz.push(-cetY);
      bhx.push(0.5 * (Math.abs(e0) + Math.abs(e4) + Math.abs(e8)));
      bhy.push(0.5 * (Math.abs(e1) + Math.abs(e5) + Math.abs(e9)));
      bhz.push(0.5 * (Math.abs(e2) + Math.abs(e6) + Math.abs(e10)));
      // The box as DRAWN. sx/sy/sz above are the THREE-space FULL extents, so half them; the
      // quaternion is the same THREE-space one the renderer feeds to `dummy.quaternion.set`.
      btx.push(sx * 0.5); bty.push(sy * 0.5); btz.push(sz * 0.5);
      bqx.push(X); bqy.push(Y); bqz.push(Z); bqw.push(W);
    }
  }
  return {
    name: meta.name,
    count: bcx.length,
    bcx: Float32Array.from(bcx), bcy: Float32Array.from(bcy), bcz: Float32Array.from(bcz),
    // the AABB — a bigger, different box. Broad-phase only.
    bhx: Float32Array.from(bhx), bhy: Float32Array.from(bhy), bhz: Float32Array.from(bhz),
    // the box we actually draw.
    btx: Float32Array.from(btx), bty: Float32Array.from(bty), btz: Float32Array.from(btz),
    bqx: Float32Array.from(bqx), bqy: Float32Array.from(bqy), bqz: Float32Array.from(bqz),
    bqw: Float32Array.from(bqw),
  };
}

// ── classify — numeric mirror of TSL chain (three-scene.js:2480-2517) ────────
function smoothstep(e0, e1, x) {
  let t = (x - e0) / (e1 - e0);
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  return t * t * (3 - 2 * t);
}

function classifyBuilding(h, fMax, fMin, p) {
  const tallEnough = smoothstep(p.WINDOW_MIN_HEIGHT, p.WINDOW_MIN_HEIGHT + p.WINDOW_HEIGHT_BAND, h);
  const verticality = h / (fMax + 1);
  const towerness = smoothstep(p.ARCH_VERTICALITY_LO, p.ARCH_VERTICALITY_HI, verticality);
  const solidNarrow = smoothstep(p.ARCH_MIN_FOOTPRINT * 0.6, p.ARCH_MIN_FOOTPRINT, fMin);
  const elongation = fMax / (fMin + 0.5);
  const blocky = 1 - smoothstep(p.ARCH_MAX_ELONGATION, p.ARCH_MAX_ELONGATION * 1.5, elongation);
  const broad = smoothstep(p.ARCH_FOOTPRINT_BIG, p.ARCH_FOOTPRINT_BIG * 2, fMax);
  // Height veto on podium (mirrors three-scene.js): a tall mass is never podium.
  const podiumLow = 1 - smoothstep(p.ARCH_PODIUM_HEIGHT_LO, p.ARCH_PODIUM_HEIGHT_HI, h);
  const industrial = broad * (1 - towerness) * podiumLow;
  let cls;
  if (tallEnough < 0.5) cls = 'short';
  else if (solidNarrow < 0.5) cls = 'thin';
  else if (blocky < 0.5) cls = 'elongated';
  else if (industrial > 0.5) cls = 'podium';
  else cls = towerness >= 0.5 ? 'tower' : 'block';
  const lit = tallEnough * (1 - industrial) * solidNarrow * blocky;
  return { cls, lit };
}

// ── clustering with per-cluster aggregates (size, dims, footprint AABB) ──────
// Wraps the lifted clusterBuildingBoxes and rebuilds per-cluster aggregates
// (the box->cluster map plus box-count, centroid, and XZ footprint AABB) that
// the shader doesn't need but the analysis does.
function clusterAggregates(decoded, gap) {
  const { attr, clusterCount } = clusterBuildingBoxes(
    decoded.bcx, decoded.bcy, decoded.bcz, decoded.bhx, decoded.bhy, decoded.bhz,
    decoded.count, gap,
  );
  // clusterId in attr[i*4+3] is 0..clusterCount-1 (dense). Aggregate per id.
  const agg = new Array(clusterCount);
  for (let i = 0; i < decoded.count; i++) {
    const id = attr[i * 4 + 3];
    let a = agg[id];
    if (!a) {
      a = agg[id] = {
        id, size: 0,
        h: attr[i * 4 + 0], fMax: attr[i * 4 + 1], fMin: attr[i * 4 + 2],
        minX: Infinity, maxX: -Infinity, minZ: Infinity, maxZ: -Infinity, // world footprint (x, z)
        sumX: 0, sumZ: 0,
      };
    }
    a.size++;
    // world centre x=bcx, z=bcz (cetY = -bcz). Footprint AABB in (x, z).
    const cx = decoded.bcx[i], cz = decoded.bcz[i], hx = decoded.bhx[i], hz = decoded.bhz[i];
    if (cx - hx < a.minX) a.minX = cx - hx;
    if (cx + hx > a.maxX) a.maxX = cx + hx;
    if (cz - hz < a.minZ) a.minZ = cz - hz;
    if (cz + hz > a.maxZ) a.maxZ = cz + hz;
    a.sumX += cx; a.sumZ += cz;
  }
  for (const a of agg) { a.cx = a.sumX / a.size; a.cz = a.sumZ / a.size; }
  return { agg, clusterCount, attr };
}

// ── district polygons (CET space) from data/subdistricts.json ────────────────
function loadDistrictPolygons() {
  const data = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/subdistricts.json'), 'utf8'));
  const districts = [];
  for (const d of (data.districts || [])) {
    if (d.polygon && d.polygon.length >= 3) districts.push({ id: d.id, ring: d.polygon, area: ringArea(d.polygon) });
    for (const s of (d.subdistricts || [])) {
      if (s.polygon && s.polygon.length >= 3) {
        districts.push({ id: s.id || d.id, parent: d.id, sub: true, ring: s.polygon, area: ringArea(s.polygon) });
      }
    }
  }
  return districts;
}

function ringArea(ring) {
  let a = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    a += (ring[j][0] + ring[i][0]) * (ring[j][1] - ring[i][1]);
  }
  return Math.abs(a) / 2;
}

// Tag a CET point to the smallest-area district/subdistrict polygon containing it
// (mirrors the app's "smallest area wins" pick). Returns {id, parent, sub} or null.
function tagDistrict(cetX, cetY, polys) {
  let best = null;
  for (const f of polys) {
    if (pointInPolygon([cetX, cetY], f.ring) && (!best || f.area < best.area)) best = f;
  }
  return best;
}

module.exports = {
  ROOT, NCZ, DISTRICT_META, DISTRICTS,
  SCENE, sliceBalanced,
  clusterBuildingBoxes, segmentBuildings, pointInPolygon,
  loadDataDds, decodeDistrict,
  smoothstep, classifyBuilding,
  clusterAggregates, loadDistrictPolygons, tagDistrict,
};
