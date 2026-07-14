#!/usr/bin/env node
/**
 * scripts/rebuild_night_data.js
 * ─────────────────────────────────────────────────────────────────────────
 * RE-DERIVE THE WHOLE NIGHT-LIGHTING CHAIN FROM A FRESH WORLD DUMP.
 *
 * The chain has four links and they must run in order, because each one reads the last one's
 * output. Running them by hand is how you end up baking window boxes against yesterday's
 * geometry and spending an afternoon wondering why a number moved.
 *
 *   1. merge_dump_parts   ncz_*_pN.csv  ->  ncz_nodes.csv + ncz_instances.csv
 *   2. window_geom        the GLBs      ->  data/window-geom.json   (the EMISSIVE window rects)
 *   3. window_boxes       + the boxes   ->  data/window-boxes-{fixed,vanilla}.bin   (the runtime bake)
 *   4. window_faces       + the boxes   ->  data/window-faces-fixed.bin + the ?windebug cloud
 *
 * The GLB library does NOT need re-exporting. `export_glass_meshes.wscript` scans ARCHIVE
 * MESHES, not sectors, so it already covers anything the new quest/interior sectors reference.
 * Only the world dump goes stale.
 *
 * PRINTS THE HEADLINE NUMBERS AT EACH STEP so a regression is visible while it happens rather
 * than three scripts later. If a number moves in a direction you did not expect, stop — that is
 * the only warning this pipeline has ever given, and today it gave it six times.
 *
 * Usage:  node scripts/rebuild_night_data.js [--skip-merge]
 */
'use strict';
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const RAW = 'd:/Modding/CP2077 Mods/MyMods/map_data_export/source/raw';
const NODE = `node --max-old-space-size=12288`;
const run = (label, cmd) => {
  console.log(`\n${'='.repeat(78)}\n${label}\n${'='.repeat(78)}\n`);
  execSync(cmd, { stdio: 'inherit', cwd: path.join(__dirname, '..') });
};

// The numbers worth watching across a re-derive. Anything that moves a long way is either the
// fix working or a new hole; both need a human to look.
const before = {};
const geomPath = path.join(__dirname, '..', 'data', 'window-geom.json');
if (fs.existsSync(geomPath)) {
  const g = JSON.parse(fs.readFileSync(geomPath, 'utf8'));
  const v = Object.values(g);
  before.meshes = v.length;
  before.emisArea = v.reduce((s, x) => s + (x.emisArea || 0), 0);
  before.glassArea = v.reduce((s, x) => s + (x.glassArea || 0), 0);
}
for (const f of ['ncz_instances.csv', 'ncz_nodes.csv']) {
  const p = path.join(RAW, f);
  if (fs.existsSync(p)) before[f] = fs.statSync(p).size;
}

if (!process.argv.includes('--skip-merge')) {
  run('1/4  MERGE the dump parts', `${NODE} scripts/merge_dump_parts.js`);
}
run('2/4  WINDOW GEOMETRY  — the emissive window rects, out of the GLBs',
  `${NODE} scripts/window_geom.js`);
run('3/4  WINDOW BOXES (fixed)  — the runtime bake',
  `${NODE} scripts/window_boxes.js --margin 2 --assign volume --bake --set fixed`);
run('3/4  WINDOW BOXES (vanilla)',
  `${NODE} scripts/window_boxes.js --margin 2 --assign volume --bake --set vanilla`);
run('4/4  WINDOW FACES  — the real layout + the ?windebug cloud',
  `${NODE} scripts/window_faces.js --set fixed --margin 4 --bake`);

// ── WHAT MOVED ──────────────────────────────────────────────────────────────
console.log(`\n${'='.repeat(78)}\nWHAT MOVED\n${'='.repeat(78)}\n`);
const g = JSON.parse(fs.readFileSync(geomPath, 'utf8'));
const v = Object.values(g);
const now = {
  meshes: v.length,
  emisArea: v.reduce((s, x) => s + (x.emisArea || 0), 0),
  glassArea: v.reduce((s, x) => s + (x.glassArea || 0), 0),
};
const line = (k, b, n, unit) => {
  if (b === undefined) { console.log(`  ${k.padEnd(22)} ${n}${unit}   (no baseline)`); return; }
  const d = n - b;
  const pc = b ? ((d / b) * 100).toFixed(1) : '—';
  console.log(`  ${k.padEnd(22)} ${String(b).padStart(12)}${unit}  ->  ${String(n).padStart(12)}${unit}   ${d >= 0 ? '+' : ''}${pc}%`);
};
line('meshes with glass', before.meshes, now.meshes, '');
line('EMISSIVE area (m2)', Math.round(before.emisArea || 0), Math.round(now.emisArea), '');
line('all glass area (m2)', Math.round(before.glassArea || 0), Math.round(now.glassArea), '');
for (const f of ['ncz_instances.csv', 'ncz_nodes.csv']) {
  const p = path.join(RAW, f);
  if (fs.existsSync(p)) line(f, before[f], fs.statSync(p).size, ' B');
}
console.log('\n  A number that moved a long way is either the fix working or a new hole.');
console.log('  Both need a human to look at it. That has been true six times today.\n');
