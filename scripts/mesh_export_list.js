#!/usr/bin/env node
/**
 * mesh_export_list.js: which meshes the box-cloud rebuild needs as geometry.
 *
 * Voxelising a placement's BOUNDING BOX yields featureless rectangles: one
 * Corpo Plaza proxy carries 10,358 triangles across 608 m and reduces to a
 * single box. Voxelising the real triangles keeps the shape, and keeps
 * orientation with it, because transformed triangles carry their own rotation.
 *
 * This writes the export list: every distinct mesh placed inside any district's
 * true boundary, after the filters that already decide what is not a building.
 *
 * OVER-INCLUDE ON PURPOSE, following export_glass_meshes.wscript. A mesh that
 * turns out not to matter costs one GLB on disk. A mesh that is missing costs a
 * building its shape and is invisible in the output.
 *
 * Usage:
 *   node scripts/mesh_export_list.js
 *   node scripts/mesh_export_list.js --districts city_center,watson
 *
 * Output: data/mesh-export-list.txt   one depot path per line, for the wscript
 *         data/mesh-export-list.json  counts, and the placement weight behind
 *                                     each mesh so the export can be ordered
 *                                     by how much of the city depends on it
 */
'use strict';

const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { DISTRICTS, districtPolygon, inPolygon, polygonBounds } = require('./district_meta');

const DEFAULT_DUMP = 'd:\\Modding\\CP2077 Mods\\MyMods\\map_data_export\\source\\raw';
const args = process.argv.slice(2);
const argOf = (k, d) => { const i = args.indexOf(`--${k}`); return i > 0 ? args[i + 1] : d; };
const dumpDir = argOf('dump', DEFAULT_DUMP);
const only = argOf('districts', null);

// 2 m was the floor while every placement became a box, on the argument that a
// box approximates a bollard well enough. Real geometry has no such fallback:
// below the floor an asset is absent, not coarse. A railing along a roof edge
// or a cluster of vents is what makes a roofline read as a building rather than
// an extruded slab, and in a blueprint style, where the drawing is silhouette
// and edge, small vertical relief earns more per triangle than it would in a
// lit render. It also costs nothing at distance, because it only ever needs to
// exist in the near LOD tier.
const MIN_SIZE = Number(argOf('minsize', 0.3));
const MAX_SIZE = Number(argOf('maxsize', 1000));   // above this it is not a building
const NEVER = new Set([
  'StaticOccluderMesh', 'StaticLight', 'Advertisement', 'WaterPatch', 'Foliage', 'Mirror',
  'TerrainProxyMesh',
]);
// Destructible pools are LITTER, measured: 59.8% of them are under 0.5 m and
// 98.3% under 2 m, and the top assets are soda cans, beer bottles, bloody rags
// and takeout cups. Lowering the size floor would sweep all of it in, so the
// floor is not the gate for this class; the node type is.
const CLUTTER = new Set(['InstancedDestructibleMesh', 'PhysicalDestruction', 'BakedDestruction']);

// Every district the game defines a trigger polygon for, plus its bbox so the
// point test runs only where it can pass. Read from subdistricts.json rather
// than DISTRICTS, because two districts (ncx_morro_rock, badlands) have no
// shipped box-cloud texture and still hold geometry.
const sd = require('../data/subdistricts.json');
const regions = [];
for (const d of sd.districts) {
  if (!d.polygon) continue;
  if (only && !only.split(',').includes(d.id)) continue;
  const [x0, y0, x1, y1] = polygonBounds(d.polygon);
  regions.push({ name: d.id, poly: d.polygon, x0, y0, x1, y1 });
}

// BADLANDS IS THE COMPLEMENT. The game gives it no polygon: it is whatever is
// not one of the other districts. Its geometry is rock formations, wind
// turbines and open world rather than architecture.
const withBadlands = !args.includes('--no-badlands') && (!only || only.split(',').includes('badlands'));
console.log(`districts: ${regions.map(r => r.name).join(', ')}${withBadlands ? ' + badlands (everything else)' : ''}`);

/** id -> depot path and bounding box, from the world dump's asset table. */
function loadAssets(file) {
  return new Promise(resolve => {
    const byId = new Map();
    const rl = readline.createInterface({ input: fs.createReadStream(file), crlfDelay: Infinity });
    let header = null;
    rl.on('line', line => {
      if (header === null) { header = line; return; }
      if (!line) return;
      const m = line.match(/^(\d+),"([^"]*)",(\d+),([^,]+),([^,]+),([^,]+),([^,]+),([^,]+),([^,]+),/);
      if (!m) return;
      const bb = [+m[4], +m[5], +m[6], +m[7], +m[8], +m[9]];
      if (bb.some(v => !Number.isFinite(v))) return;
      byId.set(Number(m[1]), { path: m[2], bb });
    });
    rl.on('close', () => resolve(byId));
  });
}

async function main() {
  const assets = await loadAssets(path.join(dumpDir, 'ncz_assets.csv'));
  console.log(`assets with a bounding box: ${assets.size.toLocaleString()}`);

  const need = new Map();  // depot path -> { placements, districts:Set, maxDim }
  let scanned = 0, inAny = 0;

  const rl = readline.createInterface({
    input: fs.createReadStream(path.join(dumpDir, 'ncz_instances.csv')), crlfDelay: Infinity,
  });
  let header = null;
  rl.on('line', line => {
    if (header === null) { header = line; return; }
    if (!line) return;
    scanned++;
    const p = line.split(',');
    const x = +p[5], y = +p[6];

    let district = null;
    for (const r of regions) {
      if (x < r.x0 || x > r.x1 || y < r.y0 || y > r.y1) continue;
      if (inPolygon(r.poly, x, y)) { district = r.name; break; }
    }
    if (!district) {
      if (!withBadlands) return;
      district = 'badlands';
    }
    inAny++;

    if (NEVER.has(p[2]) || CLUTTER.has(p[2])) return;
    const a = assets.get(+p[3]);
    if (!a) return;
    if (a.path.startsWith('base\\fx\\') || a.path.startsWith('base\\lighting\\')) return;
    if (a.path.includes('\\_global\\terrain\\')) return;

    const s = [+p[12] || 1, +p[13] || 1, +p[14] || 1];
    const dim = Math.max((a.bb[3] - a.bb[0]) * s[0], (a.bb[4] - a.bb[1]) * s[1], (a.bb[5] - a.bb[2]) * s[2]);
    if (dim < MIN_SIZE || dim > MAX_SIZE) return;

    let e = need.get(a.path);
    if (!e) need.set(a.path, e = { placements: 0, districts: new Set(), maxDim: 0 });
    e.placements++;
    e.districts.add(district);
    if (dim > e.maxDim) e.maxDim = dim;
  });

  await new Promise(r => rl.on('close', r));

  // Biggest first: a mesh that spans a block matters more than a bin, and an
  // interrupted export then leaves the most useful geometry on disk.
  const rows = [...need].sort((a, b) => b[1].maxDim - a[1].maxDim);

  const outDir = path.join(__dirname, '..', 'data');
  fs.writeFileSync(path.join(outDir, 'mesh-export-list.txt'), rows.map(r => r[0]).join('\n'));
  fs.writeFileSync(path.join(outDir, 'mesh-export-list.json'), JSON.stringify({
    districts: regions.map(r => r.name),
    scanned, placementsInADistrict: inAny, meshes: rows.length,
    minSize: MIN_SIZE, maxSize: MAX_SIZE,
    meshList: rows.map(([p, e]) => ({ path: p, placements: e.placements, maxDim: +e.maxDim.toFixed(1), districts: [...e.districts] })),
    generated: new Date().toISOString(),
  }, null, 2));

  // The same list as a wscript module. A wscript cannot read the repo, and
  // `import` resolves from the script's own folder, so the list ships beside
  // the exporter rather than being pasted into it.
  fs.writeFileSync(path.join(__dirname, 'wkit', 'ncz_mesh_list.wscript'),
    '// GENERATED by scripts/mesh_export_list.js. Do not hand-edit.\n' +
    `// ${rows.length} meshes, largest dimension first.\n` +
    'export const MESHES = [\n' +
    rows.map(r => `  ${JSON.stringify(r[0])},`).join('\n') +
    '\n];\n');

  const buckets = [0, 5, 10, 25, 50, 100, 250, Infinity];
  const hist = new Array(buckets.length - 1).fill(0);
  for (const [, e] of rows) for (let i = 0; i < hist.length; i++) if (e.maxDim >= buckets[i] && e.maxDim < buckets[i + 1]) { hist[i]++; break; }

  console.log(`scanned ${scanned.toLocaleString()} placements, ${inAny.toLocaleString()} inside a district`);
  console.log(`MESHES TO EXPORT: ${rows.length.toLocaleString()} -> data/mesh-export-list.txt`);
  console.log('\nlargest dimension:');
  hist.forEach((v, i) => v && console.log(`  ${String(buckets[i]).padStart(4)}-${String(buckets[i + 1]).padStart(4)} m  ${String(v).padStart(6)}`));
}

main();
