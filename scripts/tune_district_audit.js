#!/usr/bin/env node
/**
 * scripts/tune_district_audit.js
 * ─────────────────────────────────────────────────────────────────────────
 * Headless per-district / per-subdistrict classification audit for the night
 * lighting work. Runs the REAL decode + segmentation + classify chain (lifted
 * from three-scene.js via tune_lib) so it can't drift from what renders, then
 * reports per-district building counts, class distribution, and — the point —
 * the MEGA-BLOB outliers (over-merged "buildings" of thousands of boxes spanning
 * 1000+ CET) that drive the giant-billboard + mis-classification artefacts.
 *
 * It also A/B's a candidate SEGMENTATION-SPLIT (subdivide oversized regions by a
 * world grid) so we can measure how many mega-blobs it removes before porting it
 * into segmentBuildings.
 *
 * Usage:
 *   node scripts/tune_district_audit.js            # audit current segmentation
 *   node scripts/tune_district_audit.js --split    # audit + A/B the grid split
 *   node scripts/tune_district_audit.js --split --splitcell=200 --splitmin=900
 *
 * "mega-blob" = a building with footMax > MEGA_FOOT (CET) OR boxCount > MEGA_BOX.
 */
'use strict';

const lib = require('./tune_lib');
const { NCZ, DISTRICTS, decodeDistrict, segmentBuildings, classifyBuilding,
        loadDistrictPolygons, tagDistrict } = lib;

// ── CLI args ─────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const flag = (k) => args.includes(`--${k}`);
const val = (k, d) => {
  const a = args.find((s) => s.startsWith(`--${k}=`));
  return a ? parseFloat(a.split('=')[1]) : d;
};
const DO_SPLIT = flag('split');
const SPLIT_CELL = val('splitcell', 200);   // world grid (CET) used to chop oversized regions
const SPLIT_MIN = val('splitmin', 900);      // region footMax (CET, full span) above which the split fires
const MEGA_FOOT = val('megafoot', 350);      // footMax half-extent flagged as mega
const MEGA_BOX = val('megabox', 3000);       // box-count flagged as mega

const P = NCZ; // classify params live on NCZ

// ── aggregate segmentBuildings output → per-building records ──────────────────
// segmentBuildings returns per-BOX attr [h, fMax, fMin, id]; all boxes of one
// building share h/fMax/fMin. Collapse to one record per id.
function aggregateBuildings(decoded, attr) {
  const map = new Map();
  for (let i = 0; i < decoded.count; i++) {
    const id = attr[i * 4 + 3];
    let a = map.get(id);
    if (!a) {
      a = { id, n: 0, h: attr[i * 4 + 0], fMax: attr[i * 4 + 1], fMin: attr[i * 4 + 2], sx: 0, sz: 0 };
      map.set(id, a);
    }
    a.n++; a.sx += decoded.bcx[i]; a.sz += decoded.bcz[i];
  }
  const out = [];
  for (const a of map.values()) {
    out.push({ id: a.id, boxCount: a.n, h: a.h, fMax: a.fMax, fMin: a.fMin,
               cetX: a.sx / a.n, cetY: -(a.sz / a.n) }); // CET = (x, -z)
  }
  return out;
}

// ── candidate segmentation-split (post-process) ──────────────────────────────
// Subdivide any building whose footprint full-span exceeds SPLIT_MIN by a world
// grid of SPLIT_CELL, so an over-merged mega-blob becomes building-sized chunks.
// Pure spatial chop: flat same-height plateaus carry no geometric split signal,
// so the grid is the pragmatic fallback (per the percolation learning). Returns a
// NEW per-box id array.
function splitOversized(decoded, attr, opts) {
  const { cell, minSpan } = opts;
  // per-id footprint AABB
  const box = new Map();
  for (let i = 0; i < decoded.count; i++) {
    const id = attr[i * 4 + 3];
    const cx = decoded.bcx[i], cz = decoded.bcz[i];
    let b = box.get(id);
    if (!b) { b = { minX: Infinity, maxX: -Infinity, minZ: Infinity, maxZ: -Infinity }; box.set(id, b); }
    if (cx < b.minX) b.minX = cx; if (cx > b.maxX) b.maxX = cx;
    if (cz < b.minZ) b.minZ = cz; if (cz > b.maxZ) b.maxZ = cz;
  }
  const oversized = new Set();
  for (const [id, b] of box) {
    if (Math.max(b.maxX - b.minX, b.maxZ - b.minZ) > minSpan) oversized.add(id);
  }
  // remap: oversized ids → sub-ids keyed by world grid cell; others keep id.
  const newId = new Int32Array(decoded.count);
  const subMap = new Map(); // "id|gx|gz" → dense new id
  let next = 0;
  const seen = new Map();   // original id → new id (for non-split)
  for (let i = 0; i < decoded.count; i++) {
    const id = attr[i * 4 + 3];
    let nid;
    if (oversized.has(id)) {
      const gx = Math.floor(decoded.bcx[i] / cell), gz = Math.floor(decoded.bcz[i] / cell);
      const key = id + '|' + gx + '|' + gz;
      nid = subMap.get(key);
      if (nid === undefined) { nid = next++; subMap.set(key, nid); }
    } else {
      nid = seen.get(id);
      if (nid === undefined) { nid = next++; seen.set(id, nid); }
    }
    newId[i] = nid;
  }
  // rebuild attr with re-aggregated dims per new id (h/fMax/fMin recomputed from
  // each chunk's own world AABB — that's the whole point: chunk dims, not blob dims)
  const agg = new Map();
  for (let i = 0; i < decoded.count; i++) {
    const id = newId[i];
    let a = agg.get(id);
    if (!a) { a = { minX: Infinity, maxX: -Infinity, minY: Infinity, maxY: -Infinity, minZ: Infinity, maxZ: -Infinity }; agg.set(id, a); }
    const cx = decoded.bcx[i], cy = decoded.bcy[i], cz = decoded.bcz[i];
    const hx = decoded.bhx[i], hy = decoded.bhy[i], hz = decoded.bhz[i];
    if (cx - hx < a.minX) a.minX = cx - hx; if (cx + hx > a.maxX) a.maxX = cx + hx;
    if (cy - hy < a.minY) a.minY = cy - hy; if (cy + hy > a.maxY) a.maxY = cy + hy;
    if (cz - hz < a.minZ) a.minZ = cz - hz; if (cz + hz > a.maxZ) a.maxZ = cz + hz;
  }
  const out = new Float32Array(decoded.count * 4);
  for (let i = 0; i < decoded.count; i++) {
    const id = newId[i], a = agg.get(id);
    const fx = (a.maxX - a.minX) * 0.5, fz = (a.maxZ - a.minZ) * 0.5;
    out[i * 4 + 0] = (a.maxY - a.minY) * 0.5;
    out[i * 4 + 1] = Math.max(fx, fz);
    out[i * 4 + 2] = Math.min(fx, fz);
    out[i * 4 + 3] = id;
  }
  return out;
}

// ── run one segmentation variant, return per-(sub)district stats ─────────────
function audit(label, splitOpts) {
  const polys = loadDistrictPolygons();
  const districts = new Map(); // key → { count, cls:{}, mega:[], boxes }
  let totalBuildings = 0, totalMega = 0;
  const allMega = [];

  for (const meta of DISTRICTS) {
    let decoded;
    try { decoded = decodeDistrict(meta); } catch (e) { continue; }
    if (!decoded.count) continue;
    let { attr } = segmentBuildings(
      decoded.bcx, decoded.bcy, decoded.bcz, decoded.bhx, decoded.bhy, decoded.bhz, decoded.count, null);
    if (splitOpts) attr = splitOversized(decoded, attr, splitOpts);

    for (const b of aggregateBuildings(decoded, attr)) {
      totalBuildings++;
      const tag = tagDistrict(b.cetX, b.cetY, polys);
      const key = tag ? (tag.sub ? `${tag.parent}/${tag.id}` : tag.id) : (meta.name + '?');
      let r = districts.get(key);
      if (!r) { r = { count: 0, cls: {} }; districts.set(key, r); }
      r.count++;
      const { cls } = classifyBuilding(b.h, b.fMax, b.fMin, P);
      r.cls[cls] = (r.cls[cls] || 0) + 1;
      const isMega = b.fMax > MEGA_FOOT || b.boxCount > MEGA_BOX;
      if (isMega && (cls === 'tower' || cls === 'block')) {
        totalMega++;
        allMega.push({ key, cls, fMax: Math.round(b.fMax), h: Math.round(b.h), box: b.boxCount, cet: [Math.round(b.cetX), Math.round(b.cetY)], cloud: meta.name });
      }
    }
  }
  return { label, totalBuildings, totalMega, districts, allMega };
}

// ── report ───────────────────────────────────────────────────────────────────
function printReport(r) {
  const CLS = ['tower', 'block', 'podium', 'short', 'thin', 'elongated'];
  console.log(`\n=== ${r.label} ===`);
  console.log(`buildings: ${r.totalBuildings}   mega-blobs(lit): ${r.totalMega}`);
  const keys = [...r.districts.keys()].sort();
  const pad = (s, n) => String(s).padEnd(n);
  console.log('\n' + pad('district/subdistrict', 28) + pad('bld', 6) + CLS.map((c) => pad(c, 7)).join(''));
  for (const k of keys) {
    const d = r.districts.get(k);
    console.log(pad(k, 28) + pad(d.count, 6) + CLS.map((c) => pad(d.cls[c] || 0, 7)).join(''));
  }
  console.log('\n-- mega-blobs (lit tower/block, footMax>' + MEGA_FOOT + ' or box>' + MEGA_BOX + ') --');
  r.allMega.sort((a, b) => b.box - a.box).slice(0, 20).forEach((m) =>
    console.log(`  ${pad(m.key, 26)} ${pad(m.cls, 6)} fMax=${pad(m.fMax, 6)} h=${pad(m.h, 5)} box=${pad(m.box, 7)} cet=${m.cet}`));
}

const base = audit('CURRENT segmentation', null);
printReport(base);

if (DO_SPLIT) {
  const split = audit(`WITH grid-split (cell=${SPLIT_CELL} minSpan=${SPLIT_MIN})`, { cell: SPLIT_CELL, minSpan: SPLIT_MIN });
  printReport(split);
  console.log(`\n>>> split effect: buildings ${base.totalBuildings} → ${split.totalBuildings}` +
              `   mega-blobs ${base.totalMega} → ${split.totalMega}`);
}
