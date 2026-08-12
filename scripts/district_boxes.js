#!/usr/bin/env node
/**
 * district_boxes.js: stage 1 of the box-cloud rebuild.
 *
 * Takes every placement the world dump recorded inside one district's CET
 * footprint, joins it to its mesh bounding box, and emits one ORIENTED world
 * box per placement. Pure arithmetic: no filtering by depot path, because the
 * cityscape is not under \architecture\ (a ship, a roller coaster and dockyard
 * cranes are all part of the skyline and none of them live there). Size is the
 * signal, and the size histogram this prints is the input to that decision.
 *
 * Stage 2 (not here) voxelises these and extracts the outer shell. Stage 3
 * scores the result with scripts/window_faces.js against the real windows.
 *
 * Usage:
 *   node scripts/district_boxes.js city_center
 *   node scripts/district_boxes.js city_center --dump "d:\\path\\to\\raw"
 *
 * Output: data/district-boxes-<name>.bin  (13 float32 per box, 52 bytes)
 *           centre xyz | half-extent xyz | quaternion xyzw
 *           | assetId | typeCode | streamingLevel
 *         data/district-boxes-<name>.json (counts, bounds, size histogram,
 *           the type dictionary, and the assets contributing the most volume)
 *
 * The assetId, typeCode and streaming level travel with every box on purpose.
 * Without them a later stage can only report THAT the grid filled up, never
 * WHAT filled it. The streaming level is the second size signal: it comes off
 * the sector name's _L<n> suffix, and a level IS an object size (L0 = 64 m
 * cells = props, L5-L6 = kilometre cells = whole-subdistrict proxies).
 *
 * THE ASSEMBLY ID IS THE BUILDING. The dump's `prefab` column is the NodeRef
 * that groups placements into the thing an artist actually placed, and
 * sector|prefab is its key: `-8_0_0_L2|298522` is 1,828 placements spanning
 * 183 m and rising 112 m, every one of them within 5 degrees of one yaw. That
 * is one tower. Stage 3 needs it because a per-placement local frame quantises
 * each panel of a wall independently and the seams jitter by up to a cell,
 * which no coverage metric can see. It is emitted as a small integer here,
 * where the dictionary is already being built, rather than re-derived later.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const readline = require('readline');

const DEFAULT_DUMP = 'd:\\Modding\\CP2077 Mods\\MyMods\\map_data_export\\source\\raw';

const { DISTRICTS, worldBounds, districtPolygon, inPolygon, polygonBounds } = require('./district_meta');

/** Rotate a vector by a quaternion (x, y, z, w). */
function rotate(v, q) {
  const [x, y, z] = v, [qx, qy, qz, qw] = q;
  const ix =  qw * x + qy * z - qz * y;
  const iy =  qw * y + qz * x - qx * z;
  const iz =  qw * z + qx * y - qy * x;
  const iw = -qx * x - qy * y - qz * z;
  return [
    ix * qw + iw * -qx + iy * -qz - iz * -qy,
    iy * qw + iw * -qy + iz * -qx - ix * -qz,
    iz * qw + iw * -qz + ix * -qy - iy * -qx,
  ];
}

/** Read ncz_assets.csv into id -> mesh-local bounding box. */
function loadAssets(file) {
  return new Promise(resolve => {
    const byId = new Map();
    const rl = readline.createInterface({ input: fs.createReadStream(file), crlfDelay: Infinity });
    let header = null;
    rl.on('line', line => {
      if (header === null) { header = line; return; }
      if (!line) return;
      // id,path,chunks,bbx0,bby0,bbz0,bbx1,bby1,bbz1,mat_names,mat_paths
      const m = line.match(/^(\d+),"([^"]*)",(\d+),([^,]+),([^,]+),([^,]+),([^,]+),([^,]+),([^,]+),/);
      if (!m) return;
      const n = Number(m[1]);
      const bb = [+m[4], +m[5], +m[6], +m[7], +m[8], +m[9]];
      if (bb.some(v => !Number.isFinite(v))) return;
      byId.set(n, { path: m[2], bb });
    });
    rl.on('close', () => resolve(byId));
  });
}

async function main() {
  const name = process.argv[2];
  if (!name || !DISTRICTS[name]) {
    console.error(`usage: node scripts/district_boxes.js <${Object.keys(DISTRICTS).join('|')}> [--dump DIR]`);
    process.exit(1);
  }
  const di = process.argv.indexOf('--dump');
  const dumpDir = di > 0 ? process.argv[di + 1] : DEFAULT_DUMP;
  const keepFx = process.argv.includes('--keepfx');
  const useBbox = process.argv.includes('--bbox');
  const texBounds = worldBounds(DISTRICTS[name]);

  // The district's real boundary, not its texture's bbox. See district_meta.
  const poly = useBbox ? null : districtPolygon(name);
  let bounds = texBounds;
  if (poly) {
    const [px0, py0, px1, py1] = polygonBounds(poly);
    bounds = { min: [px0, py0, texBounds.min[2]], max: [px1, py1, texBounds.max[2]] };
  }

  console.log(`district ${name}`);
  if (poly) {
    const tex = (texBounds.max[0] - texBounds.min[0]) * (texBounds.max[1] - texBounds.min[1]);
    const box = (bounds.max[0] - bounds.min[0]) * (bounds.max[1] - bounds.min[1]);
    console.log(`  boundary  ${poly.length}-point trigger polygon; bbox ${(box / 1e6).toFixed(2)} km2 ` +
                `against the texture's ${(tex / 1e6).toFixed(2)} km2`);
  } else {
    console.log('  boundary  TEXTURE BBOX (--bbox): includes the neighbours');
  }
  console.log(`  CET bbox  x ${bounds.min[0].toFixed(0)}..${bounds.max[0].toFixed(0)}` +
              `  y ${bounds.min[1].toFixed(0)}..${bounds.max[1].toFixed(0)}` +
              `  z ${bounds.min[2].toFixed(0)}..${bounds.max[2].toFixed(0)}`);

  const assets = await loadAssets(path.join(dumpDir, 'ncz_assets.csv'));
  console.log(`  assets    ${assets.size.toLocaleString()} with a bounding box`);

  // 19 float32 per box. Grown in slabs so the pass stays single-shot.
  //
  // The raw POSITION and SCALE travel alongside the derived centre because the
  // two consumers need different things: voxelising a bounding box wants the
  // box (centre, half-extent, rotation), and voxelising the mesh's triangles
  // wants the placement transform itself, which the centre has already folded
  // the local bbox offset into.
  const STRIDE = 20;
  let cap = 1 << 20, out = new Float32Array(cap * STRIDE), count = 0;
  let scanned = 0, inside = 0, noAsset = 0, droppedFx = 0, outsidePoly = 0, noAssembly = 0;
  const heights = [];
  const typeCode = new Map();   // node type name -> small integer
  const volByAsset = new Map(); // asset id -> total AABB volume placed
  // sector|prefab -> assembly id. Sector is part of the key because the prefab
  // dictionary is city-wide and the same ref can be instantiated per sector;
  // a group must never straddle two of them.
  const assemblyId = new Map();

  const rl = readline.createInterface({
    input: fs.createReadStream(path.join(dumpDir, 'ncz_instances.csv')), crlfDelay: Infinity,
  });
  let header = null;
  rl.on('line', line => {
    if (header === null) { header = line; return; }
    if (!line) return;
    scanned++;
    // sector,src,type,asset,prefab,x,y,z,qi,qj,qk,qr,sx,sy,sz,app
    const p = line.split(',');
    const x = +p[5], y = +p[6], z = +p[7];
    if (!(x >= bounds.min[0] && x <= bounds.max[0] && y >= bounds.min[1] && y <= bounds.max[1])) return;
    if (poly && !inPolygon(poly, x, y)) { outsidePoly++; return; }
    inside++;
    const a = assets.get(+p[3]);
    if (!a) { noAsset++; return; }

    // Visual effects and cyberspace are not the city. This is NOT the
    // "\architecture\ means building" mistake in reverse: the exclusion is by
    // what the folder IS (effects, lighting volumes), not by using a folder to
    // guess what counts as skyline. Measured on city_center, keeping them puts
    // a solid mass over 2% of the district footprint at 620 m altitude, from
    // the Mikoshi and cyberspace meshes anchored near Arasaka Tower.
    if (!keepFx && (a.path.startsWith('base\\fx\\') || a.path.startsWith('base\\lighting\\'))) {
      droppedFx++;
      return;
    }

    const q = [+p[8], +p[9], +p[10], +p[11]];
    const s = [+p[12] || 1, +p[13] || 1, +p[14] || 1];
    const bb = a.bb;

    // Mesh-local bbox centre and half-extent, scaled. Rotation stays as the
    // quaternion so the box remains ORIENTED: taking an axis-aligned bound
    // here is the mistake that made every earlier script read a fat box
    // (see the-aabb-is-a-different-box).
    const hx = (bb[3] - bb[0]) * 0.5 * s[0];
    const hy = (bb[4] - bb[1]) * 0.5 * s[1];
    const hz = (bb[5] - bb[2]) * 0.5 * s[2];
    const lc = [(bb[0] + bb[3]) * 0.5 * s[0], (bb[1] + bb[4]) * 0.5 * s[1], (bb[2] + bb[5]) * 0.5 * s[2]];
    const rc = rotate(lc, q);

    if (count === cap) {
      cap *= 2;
      const bigger = new Float32Array(cap * STRIDE);
      bigger.set(out); out = bigger;
    }
    const t = p[2];
    if (!typeCode.has(t)) typeCode.set(t, typeCode.size);
    const aid = +p[3];
    // Sector names are cell coordinates with a level suffix: -62_39_0_L1.
    const lm = /_L(\d+)$/.exec(p[0]);
    const level = lm ? +lm[1] : -1;

    // -1 where the node carries no prefab ref: 49.5% of placements citywide,
    // and stage 3 keeps its per-placement path for exactly those.
    let asm = -1;
    if (p[4]) {
      const key = `${p[0]}|${p[4]}`;
      asm = assemblyId.get(key);
      if (asm === undefined) assemblyId.set(key, asm = assemblyId.size);
    } else noAssembly++;

    const o = count * STRIDE;
    out[o]      = x + rc[0]; out[o + 1] = y + rc[1]; out[o + 2] = z + rc[2];
    out[o + 3]  = hx;        out[o + 4] = hy;        out[o + 5] = hz;
    out[o + 6]  = q[0];      out[o + 7] = q[1];      out[o + 8] = q[2]; out[o + 9] = q[3];
    out[o + 10] = aid;       out[o + 11] = typeCode.get(t); out[o + 12] = level;
    out[o + 13] = x;         out[o + 14] = y;               out[o + 15] = z;
    out[o + 16] = s[0];      out[o + 17] = s[1];            out[o + 18] = s[2];
    out[o + 19] = asm;
    count++;
    heights.push(hz * 2);
    volByAsset.set(aid, (volByAsset.get(aid) || 0) + hx * hy * hz * 8);
  });

  await new Promise(r => rl.on('close', r));

  // Size histogram: the SIZE classifier's evidence, printed rather than
  // decided here. Buckets are metres of height.
  const edges = [0, 2, 5, 10, 20, 40, 80, 160, Infinity];
  const hist = new Array(edges.length - 1).fill(0);
  for (const h of heights) {
    for (let i = 0; i < hist.length; i++) if (h >= edges[i] && h < edges[i + 1]) { hist[i]++; break; }
  }

  // The assets placing the most volume: the first thing to look at when a
  // later stage reports a grid that filled up.
  const topVolume = [...volByAsset].sort((a, b) => b[1] - a[1]).slice(0, 25)
    .map(([id, v]) => ({ id, path: (assets.get(id) || {}).path || '?', volumeM3: Math.round(v) }));

  const outDir = path.join(__dirname, '..', 'data');
  const binPath = path.join(outDir, `district-boxes-${name}.bin`);
  fs.writeFileSync(binPath, Buffer.from(out.buffer, 0, count * STRIDE * 4));
  const meta = {
    district: name, bounds, boxes: count,
    scanned, insideFootprint: inside, outsidePolygon: outsidePoly,
    droppedNoAssetBbox: noAsset, droppedFx,
    boundary: poly ? 'district trigger polygon' : 'texture bbox',
    textureBounds: texBounds,
    stride: STRIDE,
    layout: 'centre xyz, halfExtent xyz, quat xyzw, assetId, typeCode, streamingLevel, position xyz, scale xyz, assemblyId (float32)',
    assemblies: assemblyId.size,
    types: Object.fromEntries([...typeCode].map(([k, v]) => [v, k])),
    // id -> depot path for every asset this district actually places, so a
    // later stage can name what it is looking at rather than report an id.
    assetPaths: Object.fromEntries([...volByAsset.keys()].map(id => [id, (assets.get(id) || {}).path || '?'])),
    heightHistogram: hist.map((n, i) => ({ from: edges[i], to: edges[i + 1], n })),
    topVolumeAssets: topVolume,
    generated: new Date().toISOString(),
  };
  fs.writeFileSync(path.join(outDir, `district-boxes-${name}.json`), JSON.stringify(meta, null, 2));

  console.log(`  scanned   ${scanned.toLocaleString()} placements`);
  console.log(`  inside    ${inside.toLocaleString()}`);
  console.log(`  outside   ${outsidePoly.toLocaleString()} in the bbox but outside the district itself`);
  console.log(`  no bbox   ${noAsset.toLocaleString()} (asset id absent from ncz_assets.csv)`);
  console.log(`  fx/light  ${droppedFx.toLocaleString()} dropped (--keepfx to keep them)`);
  console.log(`  assembly  ${assemblyId.size.toLocaleString()} sector|prefab groups over ` +
              `${(count - noAssembly).toLocaleString()} boxes; ${noAssembly.toLocaleString()} have no prefab ref`);
  console.log(`  BOXES     ${count.toLocaleString()} -> ${path.relative(process.cwd(), binPath)}`);
  console.log('\n  height histogram (m):');
  hist.forEach((n, i) => {
    const label = `${edges[i]}..${edges[i + 1] === Infinity ? 'inf' : edges[i + 1]}`;
    console.log(`    ${label.padStart(10)}  ${String(n).padStart(9)}  ${'#'.repeat(Math.round(60 * n / Math.max(...hist)))}`);
  });
}

main();
