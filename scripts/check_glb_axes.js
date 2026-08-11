#!/usr/bin/env node
/**
 * check_glb_axes.js: prove the GLB-to-CET axis mapping against a second source.
 *
 * glb_lib maps a glTF vertex (X, Y, Z) to CET (X, -Z, Y). ncz_assets.csv
 * carries each mesh's CET-local bounding box, read by WolvenKit's own decoder
 * on a different code path from the glTF exporter, so the two agree only if the
 * mapping is right. A wrong mapping swaps a building's height for its depth,
 * and every downstream number still reads as reasonable.
 *
 * Usage: node scripts/check_glb_axes.js [--n 300]
 */
'use strict';

const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { glbPathFor, meshTriangles, meshBounds } = require('./glb_lib');

const RAW = 'd:/Modding/CP2077 Mods/MyMods/map_data_export/source/raw';
const args = process.argv.slice(2);
const N = (i => i > 0 ? +args[i + 1] : 300)(args.indexOf('--n'));

// The candidate mappings, so a failure says which one IS right rather than
// only that this one is wrong.
const MAPPINGS = {
  'X,-Z,Y  (glTF Y-up -> CET Z-up)': v => [v[0], -v[2], v[1]],
  'X,Y,Z   (identity)': v => [v[0], v[1], v[2]],
  'X,Z,-Y': v => [v[0], v[2], -v[1]],
  '-X,Z,Y': v => [-v[0], v[2], v[1]],
};

async function main() {
  const rl = readline.createInterface({
    input: fs.createReadStream(path.join(RAW, 'ncz_assets.csv')), crlfDelay: Infinity,
  });
  const sample = [];
  let header = null;
  rl.on('line', line => {
    if (header === null) { header = line; return; }
    if (!line || sample.length >= N * 20) return;
    const m = line.match(/^(\d+),"([^"]*)",(\d+),([^,]+),([^,]+),([^,]+),([^,]+),([^,]+),([^,]+),/);
    if (!m) return;
    const bb = [+m[4], +m[5], +m[6], +m[7], +m[8], +m[9]];
    if (bb.some(v => !Number.isFinite(v))) return;
    sample.push({ p: m[2], bb });
  });
  await new Promise(r => rl.on('close', r));

  const score = Object.fromEntries(Object.keys(MAPPINGS).map(k => [k, { ok: 0, err: 0 }]));
  let tested = 0, missing = 0, empty = 0;

  for (const s of sample) {
    if (tested >= N) break;
    const file = glbPathFor(RAW, s.p);
    if (!fs.existsSync(file)) { missing++; continue; }
    let tris;
    try { tris = meshTriangles(file); } catch { continue; }
    if (!tris.length) { empty++; continue; }
    tested++;

    // meshTriangles already applies the library's mapping, so undo it to get
    // the raw glTF vertices back and try each candidate against them.
    for (const [name, map] of Object.entries(MAPPINGS)) {
      const b = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];
      for (let i = 0; i < tris.length; i += 3) {
        // library CET (x, y, z) came from glTF (x, z, -y)
        const g = [tris[i], tris[i + 2], -tris[i + 1]];
        const v = map(g);
        for (let a = 0; a < 3; a++) {
          if (v[a] < b[a]) b[a] = v[a];
          if (v[a] > b[a + 3]) b[a + 3] = v[a];
        }
      }
      // Compare MIN AND MAX, not extents. An extent is unchanged by a sign
      // flip, so three of these candidates score identically on extents while
      // two of them mirror the mesh. The csv bbox is in the same local frame
      // with the same origin, so its min and max separate them.
      let err = 0;
      for (let a = 0; a < 3; a++) {
        const scale = Math.max(s.bb[a + 3] - s.bb[a], 0.01);
        err += (Math.abs(s.bb[a] - b[a]) + Math.abs(s.bb[a + 3] - b[a + 3])) / (2 * scale);
      }
      err /= 3;
      score[name].err += err;
      if (err < 0.02) score[name].ok++;
    }
  }

  console.log(`tested ${tested} meshes (${missing} not exported yet, ${empty} with no triangles)\n`);
  console.log('mapping'.padEnd(34) + 'extent match'.padStart(14) + 'mean error'.padStart(13));
  for (const [name, s] of Object.entries(score)) {
    console.log(name.padEnd(34) + `${s.ok}/${tested}`.padStart(14) + (100 * s.err / Math.max(tested, 1)).toFixed(1).padStart(12) + '%');
  }
}

main();
