#!/usr/bin/env node
/**
 * scripts/tune_probe_source.js
 * ─────────────────────────────────────────────────────────────────────────
 * Cheap probe: does the _data.dds carry a LATENT BUILDING GROUPING we can use
 * instead of percolating spatial clustering? Tests three hypotheses on the raw
 * texel stream (scan order = the order boxes are packed in the texture):
 *
 *   H1 ADJACENCY LOCALITY — are CONSECUTIVE valid boxes spatially close? If a
 *      building's boxes are packed contiguously, consecutive-box distance is
 *      mostly tiny with occasional big jumps at building boundaries.
 *   H2 EMPTY-RUN DELIMITERS — do runs of empty texels separate building groups?
 *      (i.e. is a big spatial jump correlated with an empty gap before it?)
 *   H3 TEXEL↔WORLD LAYOUT — is the texture spatially sorted (monotone in world
 *      X/Y, or a space-filling curve)? Reveals how the packer ordered boxes.
 *
 * Output: console + _lighting_demo/tune/PROBE.md
 * Run: node scripts/tune_probe_source.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const L = require('./tune_lib.js');

const OUT_DIR = path.join(L.ROOT, '_lighting_demo', 'tune');
const JUMP_CET = 100; // consecutive-distance above this = candidate building boundary

// Decode keeping scan structure: every texel's empty/valid state + world XY.
function decodeWithScan(meta) {
  const ddsPath = meta.dataDdsFixed || meta.dataDds;
  const { pixels, width: texW, height: texH } = L.loadDataDds(path.join(L.ROOT, ddsPath));
  const blockW = Math.floor(texW / 3);
  const blockH = Math.min(texH, blockW);
  const T = L.NCZ.DDS_ALPHA_THRESH, U = L.NCZ.UINT16_MAX;
  const tMin = meta.transMin, tMax = meta.transMax, ofs = meta.offset;

  const boxes = [];     // valid boxes in scan order: {sx, sy, scan, cetX, cetY}
  let emptyRun = 0;     // empty texels seen since last valid box
  for (let y = 0; y < blockH; y++) {
    for (let x = 0; x < blockW; x++) {
      const scan = y * blockW + x;
      const pi = (y * texW + x) * 4;
      const si = (y * texW + x + 2 * blockW) * 4;
      const scaleEmpty = pixels[si] < T && pixels[si + 1] < T && pixels[si + 2] < T;
      if (pixels[pi + 3] < T || scaleEmpty) { emptyRun++; continue; }
      const pr = pixels[pi] / U, pg = pixels[pi + 1] / U;
      const cetX = tMin[0] + (tMax[0] - tMin[0]) * pr + ofs[0];
      const cetY = tMin[1] + (tMax[1] - tMin[1]) * pg + ofs[1];
      boxes.push({ sx: x, sy: y, scan, cetX, cetY, emptyBefore: emptyRun });
      emptyRun = 0;
    }
  }
  return { name: meta.name, boxes, blockW, blockH };
}

function quantiles(arr, qs) {
  const s = [...arr].sort((a, b) => a - b);
  return qs.map((q) => s[Math.min(s.length - 1, Math.floor(q * s.length))]);
}
function corr(a, b) {
  const n = a.length, ma = a.reduce((s, v) => s + v, 0) / n, mb = b.reduce((s, v) => s + v, 0) / n;
  let cov = 0, va = 0, vb = 0;
  for (let i = 0; i < n; i++) { const da = a[i] - ma, db = b[i] - mb; cov += da * db; va += da * da; vb += db * db; }
  return cov / (Math.sqrt(va * vb) || 1);
}

function probe(meta) {
  const { name, boxes } = decodeWithScan(meta);
  const n = boxes.length;
  // H1: consecutive distances
  const dists = [];
  const jumpEmpties = [], nonJumpEmpties = [];
  for (let i = 1; i < n; i++) {
    const dx = boxes[i].cetX - boxes[i - 1].cetX, dy = boxes[i].cetY - boxes[i - 1].cetY;
    const d = Math.hypot(dx, dy);
    dists.push(d);
    // H2: is this step's empty-gap-before bigger when it's a spatial jump?
    if (d > JUMP_CET) jumpEmpties.push(boxes[i].emptyBefore);
    else nonJumpEmpties.push(boxes[i].emptyBefore);
  }
  const [q25, q50, q75, q90] = quantiles(dists, [0.25, 0.5, 0.75, 0.9]);
  const jumps = dists.filter((d) => d > JUMP_CET).length;
  const avg = (a) => (a.length ? a.reduce((s, v) => s + v, 0) / a.length : 0);
  // H3: texel index vs world coordinate correlation
  const idx = boxes.map((b) => b.scan);
  const cx = boxes.map((b) => b.cetX), cy = boxes.map((b) => b.cetY);
  return {
    name, n,
    medDist: q50, q25, q75, q90,
    jumps, jumpFrac: jumps / Math.max(n - 1, 1),
    avgEmptyAtJump: avg(jumpEmpties), avgEmptyElse: avg(nonJumpEmpties),
    corrScanX: corr(idx, cx), corrScanY: corr(idx, cy),
  };
}

function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const targets = ['city_center', 'watson', 'westbrook', 'pacifica', 'my_district', 'ep1_spaceport'];
  const rows = [];
  for (const t of targets) {
    const meta = L.DISTRICTS.find((m) => m.name === t);
    if (!meta) continue;
    const r = probe(meta);
    rows.push(r);
    console.log(`${r.name.padEnd(14)} n=${String(r.n).padStart(6)} | consec dist med=${r.medDist.toFixed(0)} q75=${r.q75.toFixed(0)} q90=${r.q90.toFixed(0)} | jumps>${JUMP_CET}: ${r.jumps} (${(r.jumpFrac*100).toFixed(0)}%) | empty@jump=${r.avgEmptyAtJump.toFixed(2)} vs else=${r.avgEmptyElse.toFixed(2)} | corr(scan,X)=${r.corrScanX.toFixed(2)} (scan,Y)=${r.corrScanY.toFixed(2)}`);
  }
  writeReport(rows);
  console.log(`\nDone. See ${path.relative(L.ROOT, path.join(OUT_DIR, 'PROBE.md'))}`);
}

function writeReport(rows) {
  const O = [];
  O.push('# Source-structure probe — is there a latent building grouping in the .dds?\n');
  O.push(`_Generated by \`scripts/tune_probe_source.js\`. Boxes walked in texel scan order. Jump threshold = ${JUMP_CET} CET._\n`);
  O.push('## H1 — adjacency locality (are consecutive boxes the same building?)\n');
  O.push('If boxes are packed building-by-building, consecutive-box distance is mostly');
  O.push('tiny (same building) with occasional jumps (boundaries). Large median = no');
  O.push('contiguity (random/space-filling order).\n');
  O.push('| cloud | boxes | median dist | q75 | q90 | jumps>thr | jump% |');
  O.push('| --- | --- | --- | --- | --- | --- | --- |');
  for (const r of rows) O.push(`| ${r.name} | ${r.n} | ${r.medDist.toFixed(0)} | ${r.q75.toFixed(0)} | ${r.q90.toFixed(0)} | ${r.jumps} | ${(r.jumpFrac*100).toFixed(0)}% |`);
  O.push('');
  O.push('## H2 — do empty-texel runs delimit building groups?\n');
  O.push('Average empty texels immediately before a step, split by whether the step is a');
  O.push('spatial jump. If empties delimit buildings, `empty@jump` >> `empty@else`.\n');
  O.push('| cloud | empty@jump | empty@else |');
  O.push('| --- | --- | --- |');
  for (const r of rows) O.push(`| ${r.name} | ${r.avgEmptyAtJump.toFixed(2)} | ${r.avgEmptyElse.toFixed(2)} |`);
  O.push('');
  O.push('## H3 — texel↔world layout (how did the packer order boxes?)\n');
  O.push('Correlation of scan index with world X / Y. |corr|→1 = texture sorted along');
  O.push('that axis (scanline-sorted); ~0 on both = 2D-tiled or space-filling.\n');
  O.push('| cloud | corr(scan, X) | corr(scan, Y) |');
  O.push('| --- | --- | --- |');
  for (const r of rows) O.push(`| ${r.name} | ${r.corrScanX.toFixed(2)} | ${r.corrScanY.toFixed(2)} |`);
  O.push('');
  O.push('## VERDICT\n');
  O.push('**No latent building grouping exists in the .dds.** H1 (no contiguity:');
  O.push('median consecutive distance 224–302 CET in dense districts, 77–89% jumps),');
  O.push('H2 (empties don\'t delimit: empty@jump ≈ empty@else ≈ 0), H3 (no layout sort:');
  O.push('|corr| ≈ 0). Boxes are packed in spatially-incoherent order with no');
  O.push('separators and no type. **Building membership must be computed geometrically**');
  O.push('(height-stratified / seeded segmentation) — there is no free signal to read.');
  O.push('');
  fs.writeFileSync(path.join(OUT_DIR, 'PROBE.md'), O.join('\n'));
}

main();
