#!/usr/bin/env node
/**
 * scripts/tune_archetypes.js
 * ─────────────────────────────────────────────────────────────────────────
 * Automated tuner for the 3D-map building CLUSTERING + ARCHETYPE classification
 * (night-lighting Stage 2). Sweeps the param space and scores each set so we
 * pin down good values instead of eyeballing `?archdebug`.
 *
 * Params swept:
 *   BUILDING_CLUSTER_GAP, ARCH_VERTICALITY_LO/HI, ARCH_FOOTPRINT_BIG,
 *   ARCH_MIN_FOOTPRINT, ARCH_MAX_ELONGATION
 *
 * WHY THIS IS FAITHFUL (no drift from the live scene):
 *   - DISTRICT_META and clusterBuildingBoxes() are LIFTED VERBATIM out of
 *     assets/js/three-scene.js at runtime (read as text → brace-match → eval).
 *     The tuner runs the EXACT clustering code the renderer runs.
 *   - The DDS decode is a faithful port of loadBuildings() (the .dds is
 *     uncompressed R16G16B16A16 — pure arithmetic, no GPU needed).
 *   - The classify chain is the one piece that can't be shared literally (it's
 *     TSL node-graph in the shader). It's mirrored numerically below with line
 *     references to three-scene.js — keep the two in sync. (See classifyBuilding.)
 *
 * Metric (baseline, per the divisions-of-labour discussion 2026-06-20):
 *   class-distribution bands + cluster-count + gap-stability guardrails.
 *   Landmark ground-truth scoring is a later refinement layered on this baseline.
 *
 * Output (throwaway, gitignored-by-convention dir):
 *   _lighting_demo/tune/sweep.json   — full ranked results
 *   _lighting_demo/tune/RESULTS.md   — human-readable shortlist + recommendation
 *
 * Run: node scripts/tune_archetypes.js
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const OUT_DIR = path.join(ROOT, '_lighting_demo', 'tune');
const SCENE = fs.readFileSync(path.join(ROOT, 'assets/js/three-scene.js'), 'utf8');
const CONSTS = fs.readFileSync(path.join(ROOT, 'assets/js/constants.js'), 'utf8');

// ── 1. Lift verbatim code out of three-scene.js ──────────────────────────────
// Slice a balanced bracketed region starting at `marker`, matching open/close.
// Good enough because neither DISTRICT_META nor clusterBuildingBoxes has the
// bracket char inside a string/comment (verified).
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

// ── 2. Read numeric NCZ.* constants from constants.js ────────────────────────
const NCZ = {};
for (const m of CONSTS.matchAll(/NCZ\.(\w+)\s*=\s*(-?\d+(?:\.\d+)?)\s*;/g)) {
  NCZ[m[1]] = parseFloat(m[2]);
}
const REQUIRED = [
  'WINDOW_MIN_HEIGHT', 'WINDOW_HEIGHT_BAND', 'ARCH_VERTICALITY_LO', 'ARCH_VERTICALITY_HI',
  'ARCH_FOOTPRINT_BIG', 'ARCH_MIN_FOOTPRINT', 'ARCH_MAX_ELONGATION', 'BUILDING_CLUSTER_GAP',
  'DDS_ALPHA_THRESH', 'UINT16_MAX', 'DDS_PIXEL_OFFSET',
];
for (const k of REQUIRED) if (NCZ[k] === undefined) throw new Error(`missing NCZ.${k} from constants.js`);

// Districts to tune over: everything the 'fixed' asset set actually renders,
// minus the `ugly_building` debug isolate (a single building → skews stats).
const DISTRICTS = DISTRICT_META.filter((m) => m.name !== 'ugly_building');

// ── 3. DDS decode — faithful port of loadBuildings() (three-scene.js ~2068) ──
function loadDataDds(absPath) {
  const buf = fs.readFileSync(absPath);
  const width = buf.readUInt32LE(16);   // header uint32 index 4
  const height = buf.readUInt32LE(12);  // header uint32 index 3
  const off = NCZ.DDS_PIXEL_OFFSET;
  const pixels = new Uint16Array(buf.buffer, buf.byteOffset + off, (buf.length - off) >> 1);
  return { pixels, width, height };
}

// Port of the per-box decode loop: position/rotation/scale blocks → world centre
// + world-AABB half-extents (matching three-scene.js:2083-2131 exactly).
function decodeDistrict(meta) {
  const ddsPath = meta.dataDdsFixed || meta.dataDds; // 'fixed' asset set (ASSET_SET_DEFAULT)
  const { pixels, width: texW, height: texH } = loadDataDds(path.join(ROOT, ddsPath));
  const blockW = Math.floor(texW / 3);
  const blockH = Math.min(texH, blockW);
  const T = NCZ.DDS_ALPHA_THRESH, U = NCZ.UINT16_MAX, CS = meta.cubeSize;
  const tMin = meta.transMin, tMax = meta.transMax, ofs = meta.offset;

  const bcx = [], bcy = [], bcz = [], bhx = [], bhy = [], bhz = [];
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

      // quaternion: [0,65535]→[-1,1], CET Z-up → three.js Y-up = (qx, qz, -qy, qw)
      const qr = pixels[ri] / U * 2 - 1, qg = pixels[ri + 1] / U * 2 - 1;
      const qb = pixels[ri + 2] / U * 2 - 1, qa = pixels[ri + 3] / U * 2 - 1;
      const ql = Math.hypot(qr, qg, qb, qa) || 1;
      const X = qr / ql, Y = qb / ql, Z = -qg / ql, W = qa / ql;

      const hx = pixels[si] / U * CS, hy = pixels[si + 1] / U * CS, hz = pixels[si + 2] / U * CS;
      const sx = hx * 2, sy = hz * 2, sz = hy * 2; // CET X→X, Z→Y, Y→Z

      // THREE.Matrix4.compose() 3×3; world-AABB half = 0.5·Σ|row entries|
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
    }
  }
  return {
    name: meta.name,
    count: bcx.length,
    bcx: Float32Array.from(bcx), bcy: Float32Array.from(bcy), bcz: Float32Array.from(bcz),
    bhx: Float32Array.from(bhx), bhy: Float32Array.from(bhy), bhz: Float32Array.from(bhz),
  };
}

// ── 4. Classify — numeric mirror of the TSL chain (three-scene.js:2480-2517) ─
// IF YOU EDIT THE SHADER'S ARCHETYPE MATH, EDIT THIS TOO.
function smoothstep(e0, e1, x) {
  let t = (x - e0) / (e1 - e0);
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  return t * t * (3 - 2 * t);
}

// dims: building (clustered) aggregate — h=heightHalf, fMax=footMaxHalf, fMin=footMinHalf.
// Returns the discrete class matching the ?archdebug legend, plus the continuous
// archMask "lit" weight (district-density stubbed to 1: it's region-gating, not
// shape, and is independent of the params we sweep).
function classifyBuilding(h, fMax, fMin, p) {
  const tallEnough = smoothstep(p.WINDOW_MIN_HEIGHT, p.WINDOW_MIN_HEIGHT + p.WINDOW_HEIGHT_BAND, h);
  const verticality = h / (fMax + 1);
  const towerness = smoothstep(p.ARCH_VERTICALITY_LO, p.ARCH_VERTICALITY_HI, verticality);
  const solidNarrow = smoothstep(p.ARCH_MIN_FOOTPRINT * 0.6, p.ARCH_MIN_FOOTPRINT, fMin);
  const elongation = fMax / (fMin + 0.5);
  const blocky = 1 - smoothstep(p.ARCH_MAX_ELONGATION, p.ARCH_MAX_ELONGATION * 1.5, elongation);
  const broad = smoothstep(p.ARCH_FOOTPRINT_BIG, p.ARCH_FOOTPRINT_BIG * 2, fMax);
  const industrial = broad * (1 - towerness);

  // archdebug paints later mixes over earlier ones; the discrete class is the
  // LAST layer whose weight crosses 0.5 (short > thin > elongated > podium >
  // tower/block). This is exactly what the eye reads off ?archdebug.
  let cls;
  if (tallEnough < 0.5) cls = 'short';
  else if (solidNarrow < 0.5) cls = 'thin';
  else if (blocky < 0.5) cls = 'elongated';
  else if (industrial > 0.5) cls = 'podium';
  else cls = towerness >= 0.5 ? 'tower' : 'block';

  const lit = tallEnough * (1 - industrial) * solidNarrow * blocky; // archMask, density=1
  return { cls, lit };
}

// Per-(district, gap) clustering → one representative dims per BUILDING.
function buildingsOf(decoded, gap) {
  const { attr, clusterCount } = clusterBuildingBoxes(
    decoded.bcx, decoded.bcy, decoded.bcz, decoded.bhx, decoded.bhy, decoded.bhz,
    decoded.count, gap,
  );
  const seen = new Set();
  const dims = [];
  for (let i = 0; i < decoded.count; i++) {
    const id = attr[i * 4 + 3];
    if (seen.has(id)) continue;
    seen.add(id);
    dims.push([attr[i * 4 + 0], attr[i * 4 + 1], attr[i * 4 + 2]]); // h, fMax, fMin
  }
  return { dims, clusterCount };
}

// ── 5. Metric ────────────────────────────────────────────────────────────────
// Class-distribution bands + cluster-count + gap-stability. Weights/targets are
// v0 (the reported symptom is "too much podium/yellow", so podium is weighted
// hardest). Lower score = better. Targets/weights are deliberately easy to tweak.
const TARGET = {
  podiumMax: 0.15,   // podium fraction of tall-enough buildings should stay low
  litMin: 0.55,      // tower+block should be the majority of tall-enough
  infraMax: 0.30,    // thin+elongated (infra rejects) among tall-enough
  countLo: 250,      // sane buildings-per-district band
  countHi: 4000,
};
const WEIGHT = { podium: 3, lit: 2, infra: 1, count: 0.5, stab: 1 };

function scoreParams(p, cache) {
  const g = p.BUILDING_CLUSTER_GAP;
  let total = 0;
  const perDistrict = [];
  for (const name of Object.keys(cache)) {
    const { dims, clusterCount } = cache[name][g];
    const counts = { short: 0, thin: 0, elongated: 0, podium: 0, tower: 0, block: 0 };
    for (const d of dims) counts[classifyBuilding(d[0], d[1], d[2], p).cls]++;

    const tallTotal = clusterCount - counts.short;
    const denom = Math.max(tallTotal, 1);
    const podiumFrac = counts.podium / denom;
    const litFrac = (counts.tower + counts.block) / denom;
    const infraFrac = (counts.thin + counts.elongated) / denom;

    const pPod = Math.max(0, podiumFrac - TARGET.podiumMax);
    const pLit = Math.max(0, TARGET.litMin - litFrac);
    const pInfra = Math.max(0, infraFrac - TARGET.infraMax);
    let pCount = 0;
    if (clusterCount < TARGET.countLo) pCount = (TARGET.countLo - clusterCount) / TARGET.countLo;
    else if (clusterCount > TARGET.countHi) pCount = (clusterCount - TARGET.countHi) / TARGET.countHi;

    const ccm = cache[name][g - 1]?.clusterCount;
    const ccp = cache[name][g + 1]?.clusterCount;
    let stab = 0, n = 0;
    if (ccm != null) { stab += Math.abs(ccm - clusterCount) / Math.max(clusterCount, 1); n++; }
    if (ccp != null) { stab += Math.abs(ccp - clusterCount) / Math.max(clusterCount, 1); n++; }
    const pStab = n ? stab / n : 0;

    const dScore = WEIGHT.podium * pPod + WEIGHT.lit * pLit + WEIGHT.infra * pInfra
                 + WEIGHT.count * pCount + WEIGHT.stab * pStab;
    total += dScore;
    perDistrict.push({ name, clusterCount, podiumFrac, litFrac, infraFrac, pStab, counts });
  }
  return { total, perDistrict };
}

// ── Sweep grid ────────────────────────────────────────────────────────────────
const GRID = {
  BUILDING_CLUSTER_GAP: [-3, -2.5, -2, -1.5, -1, -0.5, 0],
  ARCH_VERTICALITY_LO: [0.4, 0.5, 0.6, 0.7],
  ARCH_VERTICALITY_HI: [1.4, 1.6, 1.8, 2.0, 2.2],
  ARCH_FOOTPRINT_BIG: [90, 120, 150, 180, 220, 260],
  ARCH_MIN_FOOTPRINT: [6, 8, 10, 12],
  ARCH_MAX_ELONGATION: [3, 4, 5, 6],
};
// Gaps to pre-cluster: grid gaps plus ±1 neighbours (for the stability term).
const GAP_SET = (() => {
  const s = new Set();
  for (const g of GRID.BUILDING_CLUSTER_GAP) { s.add(g); s.add(g - 1); s.add(g + 1); }
  return [...s].sort((a, b) => a - b);
})();

function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const t0 = Date.now();

  console.log('Decoding districts (fixed asset set)…');
  const decoded = DISTRICTS.map(decodeDistrict);
  for (const d of decoded) console.log(`  ${d.name.padEnd(16)} ${d.count} boxes`);

  // Pre-cluster every district at every gap in GAP_SET (clustering depends only
  // on gap, not the ARCH params — so the expensive step runs ~108×, not 13k×).
  console.log('\nClustering at each gap…');
  const cache = {}; // cache[name][gap] = { dims, clusterCount }
  for (const d of decoded) {
    cache[d.name] = {};
    for (const g of GAP_SET) cache[d.name][g] = buildingsOf(d, g);
  }
  // Report cluster counts at the current default gap to validate the port.
  const defGap = NCZ.BUILDING_CLUSTER_GAP;
  console.log(`\nCluster counts at current BUILDING_CLUSTER_GAP=${defGap}:`);
  for (const d of decoded) {
    const cc = cache[d.name][defGap]?.clusterCount;
    console.log(`  ${d.name.padEnd(16)} ${d.count} boxes → ${cc != null ? cc : '(gap not in set)'} buildings`);
  }

  // Sweep.
  console.log('\nSweeping…');
  const keys = Object.keys(GRID);
  const results = [];
  const idx = new Array(keys.length).fill(0);
  let combos = 1;
  for (const k of keys) combos *= GRID[k].length;
  for (let c = 0; c < combos; c++) {
    let rem = c;
    const p = {
      WINDOW_MIN_HEIGHT: NCZ.WINDOW_MIN_HEIGHT,
      WINDOW_HEIGHT_BAND: NCZ.WINDOW_HEIGHT_BAND,
      ARCH_PODIUM_HEIGHT_LO: NCZ.ARCH_PODIUM_HEIGHT_LO,
      ARCH_PODIUM_HEIGHT_HI: NCZ.ARCH_PODIUM_HEIGHT_HI,
    };
    for (const k of keys) { p[k] = GRID[k][rem % GRID[k].length]; rem = Math.floor(rem / GRID[k].length); }
    const { total, perDistrict } = scoreParams(p, cache);
    results.push({ params: p, score: total, perDistrict });
  }
  results.sort((a, b) => a.score - b.score);

  // Score the CURRENT defaults too, for the before/after.
  const cur = {
    WINDOW_MIN_HEIGHT: NCZ.WINDOW_MIN_HEIGHT, WINDOW_HEIGHT_BAND: NCZ.WINDOW_HEIGHT_BAND,
    BUILDING_CLUSTER_GAP: NCZ.BUILDING_CLUSTER_GAP,
    ARCH_VERTICALITY_LO: NCZ.ARCH_VERTICALITY_LO, ARCH_VERTICALITY_HI: NCZ.ARCH_VERTICALITY_HI,
    ARCH_FOOTPRINT_BIG: NCZ.ARCH_FOOTPRINT_BIG, ARCH_MIN_FOOTPRINT: NCZ.ARCH_MIN_FOOTPRINT,
    ARCH_MAX_ELONGATION: NCZ.ARCH_MAX_ELONGATION,
    ARCH_PODIUM_HEIGHT_LO: NCZ.ARCH_PODIUM_HEIGHT_LO, ARCH_PODIUM_HEIGHT_HI: NCZ.ARCH_PODIUM_HEIGHT_HI,
  };
  const curScore = GAP_SET.includes(cur.BUILDING_CLUSTER_GAP)
    ? scoreParams(cur, cache) : { total: NaN, perDistrict: [] };

  const dt = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(`\nSwept ${combos} combos in ${dt}s. Writing report…`);

  writeReport(results, { params: cur, ...curScore }, decoded, cache, defGap);
  fs.writeFileSync(path.join(OUT_DIR, 'sweep.json'),
    JSON.stringify({ top: results.slice(0, 200), current: { params: cur, score: curScore.total } }, null, 2));
  console.log(`Done. See ${path.relative(ROOT, path.join(OUT_DIR, 'RESULTS.md'))}`);
}

function fmtParams(p) {
  return `gap=${p.BUILDING_CLUSTER_GAP} vLO=${p.ARCH_VERTICALITY_LO} vHI=${p.ARCH_VERTICALITY_HI} `
       + `fBIG=${p.ARCH_FOOTPRINT_BIG} minF=${p.ARCH_MIN_FOOTPRINT} maxE=${p.ARCH_MAX_ELONGATION}`;
}
function avg(rows, key) { return rows.reduce((s, r) => s + r[key], 0) / Math.max(rows.length, 1); }

function writeReport(results, current, decoded, cache, defGap) {
  const L = [];
  L.push('# Archetype tuning — sweep results\n');
  L.push('_Generated by `scripts/tune_archetypes.js`. Metric: class-distribution bands +');
  L.push('cluster-count + gap-stability guardrails (v0 weights). Lower score = better._\n');
  L.push('**Class legend (matches `?archdebug`):** grey=short · red=thin · orange=elongated ·');
  L.push('yellow=podium · green=tower · blue=block. "lit" = tower+block (what gets windows/signs).\n');

  L.push('## Decode / cluster sanity (current gap = ' + defGap + ')\n');
  L.push('| district | boxes | buildings |');
  L.push('| --- | --- | --- |');
  for (const d of decoded) L.push(`| ${d.name} | ${d.count} | ${cache[d.name][defGap]?.clusterCount ?? '—'} |`);
  L.push('');

  if (Number.isFinite(current.score)) {
    L.push('## CURRENT defaults (baseline)\n');
    L.push('`' + fmtParams(current.params) + '`  → **score ' + current.score.toFixed(3) + '**\n');
    L.push('| district | buildings | podium% | lit% | infra% |');
    L.push('| --- | --- | --- | --- | --- |');
    for (const r of current.perDistrict) {
      L.push(`| ${r.name} | ${r.clusterCount} | ${(r.podiumFrac * 100).toFixed(1)} | ${(r.litFrac * 100).toFixed(1)} | ${(r.infraFrac * 100).toFixed(1)} |`);
    }
    L.push(`| **avg** |  | ${(avg(current.perDistrict, 'podiumFrac') * 100).toFixed(1)} | ${(avg(current.perDistrict, 'litFrac') * 100).toFixed(1)} | ${(avg(current.perDistrict, 'infraFrac') * 100).toFixed(1)} |`);
    L.push('');
  }

  L.push('## Top 15 candidates\n');
  L.push('| # | score | params | avg podium% | avg lit% | avg infra% |');
  L.push('| --- | --- | --- | --- | --- | --- |');
  results.slice(0, 15).forEach((r, i) => {
    L.push(`| ${i + 1} | ${r.score.toFixed(3) } | \`${fmtParams(r.params)}\` | `
      + `${(avg(r.perDistrict, 'podiumFrac') * 100).toFixed(1)} | `
      + `${(avg(r.perDistrict, 'litFrac') * 100).toFixed(1)} | `
      + `${(avg(r.perDistrict, 'infraFrac') * 100).toFixed(1)} |`);
  });
  L.push('');

  const best = results[0];
  L.push('## Recommended (rank 1)\n');
  L.push('```js');
  L.push(`NCZ.BUILDING_CLUSTER_GAP  = ${best.params.BUILDING_CLUSTER_GAP};`);
  L.push(`NCZ.ARCH_VERTICALITY_LO   = ${best.params.ARCH_VERTICALITY_LO};`);
  L.push(`NCZ.ARCH_VERTICALITY_HI   = ${best.params.ARCH_VERTICALITY_HI};`);
  L.push(`NCZ.ARCH_FOOTPRINT_BIG    = ${best.params.ARCH_FOOTPRINT_BIG};`);
  L.push(`NCZ.ARCH_MIN_FOOTPRINT    = ${best.params.ARCH_MIN_FOOTPRINT};`);
  L.push(`NCZ.ARCH_MAX_ELONGATION   = ${best.params.ARCH_MAX_ELONGATION};`);
  L.push('```\n');
  L.push('_View any candidate live (after the override hook lands):_ ');
  L.push('`?archdebug&gap=…&vlo=…&vhi=…&fbig=…&minf=…&maxe=…`\n');

  fs.writeFileSync(path.join(OUT_DIR, 'RESULTS.md'), L.join('\n'));
}

main();
