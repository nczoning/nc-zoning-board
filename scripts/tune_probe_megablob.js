#!/usr/bin/env node
/**
 * scripts/tune_probe_megablob.js
 * ─────────────────────────────────────────────────────────────────────────
 * "Measure first" probe for how to split the dense-downtown megablob. Answers:
 *
 *   Q1  Do STREET GAPS exist in the box data? → fine-resolution footprint
 *       connected-components. If the megablob splits into many components at a
 *       small cell, streets exist and a 2D footprint-CC is the splitter.
 *   Q2  Are there HEIGHT RIDGES between buildings? → per-cell height-above-ground
 *       field. If distinct tops/valleys are visible, a height-watershed can split
 *       where footprints touch.
 *
 * Renders top-down PNGs (top-down is correct HERE — segmentation is a footprint
 * question, not a verticality one):
 *   megablob_<d>_height.png   — height-above-ground (black=empty → bright=tall)
 *   megablob_<d>_cc<cell>.png — footprint connected-components, colour per piece
 *
 * Output: PNGs + _lighting_demo/tune/MEGABLOB.md
 * Run: node scripts/tune_probe_megablob.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const sharp = require('sharp');
const L = require('./tune_lib.js');

const OUT_DIR = path.join(L.ROOT, '_lighting_demo', 'tune', 'cap');
const TARGETS = ['city_center', 'watson'];
const CC_CELLS = [4, 8, 16];     // street-gap sensitivity sweep
const RENDER_CELL = 8;           // cell used for the rendered images
const OUT_MAX_PX = 1100;         // upscale target for legibility

function grid(decoded, C) {
  const { bcx, bcz, bhx, bhz, bcy, bhy, count } = decoded;
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
  for (let i = 0; i < count; i++) {
    if (bcx[i] - bhx[i] < minX) minX = bcx[i] - bhx[i];
    if (bcx[i] + bhx[i] > maxX) maxX = bcx[i] + bhx[i];
    if (bcz[i] - bhz[i] < minZ) minZ = bcz[i] - bhz[i];
    if (bcz[i] + bhz[i] > maxZ) maxZ = bcz[i] + bhz[i];
  }
  const col0 = Math.floor(minX / C), row0 = Math.floor(minZ / C);
  const cols = Math.floor(maxX / C) - col0 + 1, rows = Math.floor(maxZ / C) - row0 + 1;
  const occ = new Uint8Array(cols * rows);
  const top = new Float32Array(cols * rows).fill(-Infinity);
  const grd = new Float32Array(cols * rows).fill(Infinity);
  for (let i = 0; i < count; i++) {
    const c0 = Math.floor((bcx[i] - bhx[i]) / C) - col0, c1 = Math.floor((bcx[i] + bhx[i]) / C) - col0;
    const r0 = Math.floor((bcz[i] - bhz[i]) / C) - row0, r1 = Math.floor((bcz[i] + bhz[i]) / C) - row0;
    const cc1 = Math.min(c1, c0 + 12), rr1 = Math.min(r1, r0 + 12); // cap huge boxes
    const t = bcy[i] + bhy[i], b = bcy[i] - bhy[i];
    for (let r = r0; r <= rr1; r++) for (let c = c0; c <= cc1; c++) {
      const k = r * cols + c;
      occ[k] = 1;
      if (t > top[k]) top[k] = t;
      if (b < grd[k]) grd[k] = b;
    }
  }
  return { cols, rows, occ, top, grd };
}

// 8-connected components over occupied cells.
function connectedComponents(g) {
  const { cols, rows, occ } = g;
  const label = new Int32Array(cols * rows).fill(-1);
  const sizes = [];
  const stack = [];
  let next = 0;
  for (let s = 0; s < occ.length; s++) {
    if (!occ[s] || label[s] !== -1) continue;
    const id = next++;
    label[s] = id; stack.length = 0; stack.push(s);
    let size = 0;
    while (stack.length) {
      const k = stack.pop(); size++;
      const r = (k / cols) | 0, c = k % cols;
      for (let dr = -1; dr <= 1; dr++) for (let dc = -1; dc <= 1; dc++) {
        if (!dr && !dc) continue;
        const nr = r + dr, nc = c + dc;
        if (nr < 0 || nc < 0 || nr >= rows || nc >= cols) continue;
        const nk = nr * cols + nc;
        if (occ[nk] && label[nk] === -1) { label[nk] = id; stack.push(nk); }
      }
    }
    sizes.push(size);
  }
  return { label, sizes, count: next };
}

function ccStats(g) {
  const { sizes, count } = connectedComponents(g);
  const total = sizes.reduce((s, v) => s + v, 0);
  const sorted = [...sizes].sort((a, b) => b - a);
  return {
    count, largestShare: (sorted[0] || 0) / Math.max(total, 1),
    top5: sorted.slice(0, 5), ge10: sizes.filter((s) => s >= 10).length,
  };
}

function hashColor(id) {
  // distinct-ish colour per component
  const h = (id * 2654435761) >>> 0;
  return [80 + (h & 0x7f), 80 + ((h >> 8) & 0x7f), 80 + ((h >> 16) & 0x7f)];
}

async function renderHeight(g, file) {
  const { cols, rows, occ, top, grd } = g;
  // height above ground, percentile-clipped for contrast
  const hs = [];
  for (let k = 0; k < occ.length; k++) if (occ[k]) hs.push(top[k] - grd[k]);
  hs.sort((a, b) => a - b);
  const lo = hs[Math.floor(hs.length * 0.02)] || 0, hi = hs[Math.floor(hs.length * 0.98)] || 1;
  const buf = Buffer.alloc(cols * rows * 3);
  for (let k = 0; k < occ.length; k++) {
    if (!occ[k]) continue;
    let t = ((top[k] - grd[k]) - lo) / Math.max(hi - lo, 1e-3);
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    // dark-blue → cyan → white ramp
    const v = Math.round(40 + 215 * t);
    buf[k * 3] = Math.round(v * 0.3); buf[k * 3 + 1] = Math.round(v * 0.8); buf[k * 3 + 2] = v;
  }
  await writePng(buf, cols, rows, file);
}

async function renderCC(g, file) {
  const { cols, rows, occ } = g;
  const { label, sizes } = connectedComponents(g);
  const buf = Buffer.alloc(cols * rows * 3);
  for (let k = 0; k < occ.length; k++) {
    if (!occ[k]) continue;
    const id = label[k];
    if (sizes[id] < 5) { buf[k * 3] = buf[k * 3 + 1] = buf[k * 3 + 2] = 45; continue; } // tiny = grey
    const [r, gg, b] = hashColor(id);
    buf[k * 3] = r; buf[k * 3 + 1] = gg; buf[k * 3 + 2] = b;
  }
  await writePng(buf, cols, rows, file);
}

async function writePng(buf, w, h, file) {
  const scale = Math.max(1, Math.floor(OUT_MAX_PX / Math.max(w, h)));
  await sharp(buf, { raw: { width: w, height: h, channels: 3 } })
    .resize(w * scale, h * scale, { kernel: 'nearest' })
    .png().toFile(file);
}

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const O = [];
  O.push('# Megablob internals — how to split the dense downtown\n');
  O.push('_Generated by `scripts/tune_probe_megablob.js`. Top-down (segmentation is a');
  O.push('footprint question). Renders in `cap/`._\n');
  O.push('## Q1 — footprint connected-components at decreasing cell size (street gaps?)\n');
  O.push('If streets exist in the box data, the megablob splits into many components');
  O.push('as the cell shrinks, and `largest%` drops. If it stays ~1 giant component,');
  O.push('downtown is solidly built (no streets) → need a height-ridge split instead.\n');
  O.push('| cloud | cell | components | ≥10-cell | largest% | top-5 sizes |');
  O.push('| --- | --- | --- | --- | --- | --- |');

  for (const name of TARGETS) {
    const meta = L.DISTRICTS.find((m) => m.name === name);
    const d = L.decodeDistrict(meta);
    for (const C of CC_CELLS) {
      const g = grid(d, C);
      const s = ccStats(g);
      O.push(`| ${name} | ${C} | ${s.count} | ${s.ge10} | ${(s.largestShare * 100).toFixed(0)}% | ${s.top5.join(', ')} |`);
      console.log(`${name.padEnd(13)} cell=${String(C).padStart(2)} → ${String(s.count).padStart(5)} components, largest ${(s.largestShare * 100).toFixed(0)}% (≥10-cell: ${s.ge10})`);
    }
    // render at RENDER_CELL
    const gr = grid(d, RENDER_CELL);
    await renderHeight(gr, path.join(OUT_DIR, `megablob_${name}_height.png`));
    await renderCC(gr, path.join(OUT_DIR, `megablob_${name}_cc${RENDER_CELL}.png`));
    console.log(`  rendered megablob_${name}_height.png + _cc${RENDER_CELL}.png`);
  }
  O.push('');
  O.push(`## Q2 — height ridges\n`);
  O.push(`See \`megablob_<d>_height.png\`: distinct bright tops separated by darker`);
  O.push(`valleys ⇒ a height-watershed can split touching buildings. A uniform`);
  O.push(`plateau ⇒ no height cue, footprint-CC (or block-unit) is the only option.\n`);
  fs.writeFileSync(path.join(L.ROOT, '_lighting_demo', 'tune', 'MEGABLOB.md'), O.join('\n'));
  console.log(`\nDone. See _lighting_demo/tune/MEGABLOB.md and cap/megablob_*.png`);
}

main();
