#!/usr/bin/env node
/**
 * spike_assembly.js: pull one building out of the dump as real geometry, so
 * the choice between representations can be made by looking rather than by
 * argument.
 *
 * The building is a sector|prefab group, which is what an artist placed as one
 * thing: `-8_0_0_L2|298522` is 1,828 placements spanning 183 m and rising
 * 112 m, every member within 5 degrees of one yaw.
 *
 * Emits the two things a viewer needs and nothing else:
 *
 *   kit       the unique meshes, once each, plus one transform per placement.
 *             This is the instanced representation: the library is small
 *             because the city is a kit and the same panel stands in hundreds
 *             of places.
 *   merged    every placement's triangles baked into world space as one
 *             buffer. Same triangles, one draw call. NOT decimated: this
 *             isolates draw-call cost from triangle cost, and decimation is a
 *             separate question with its own trade.
 *
 * Placements the camera can never reach are dropped when an exposure verdict
 * exists for the district, because "44% of it is unreachable" is only a saving
 * if the exporter acts on it.
 *
 * Usage:
 *   node scripts/spike_assembly.js city_center -8_0_0_L2 298522
 *   node scripts/spike_assembly.js city_center -8_0_0_L2 298522 --keep-hidden
 *
 * Output: data/spike-<sector>-<prefab>.bin   geometry, tightly packed
 *         data/spike-<sector>-<prefab>.json  the index into it
 */
'use strict';

const fs = require('fs');
const path = require('path');
const readline = require('readline');

const { glbPathFor, meshTriangles } = require('./glb_lib');
const { categorize } = require('./asset_category');

const RAW = 'D:\\Modding\\CP2077 Mods\\MyMods\\map_data_export\\source\\raw\\';
const RAW_ROOT = 'd:/Modding/CP2077 Mods/MyMods/map_data_export/source/raw';

const args = process.argv.slice(2);
const district = args[0];
const sector = args[1];
const prefab = args[2];
const KEEP_HIDDEN = args.includes('--keep-hidden');

if (!district || !sector || !prefab) {
  console.error('usage: node scripts/spike_assembly.js <district> <sector> <prefabId> [--keep-hidden]');
  process.exit(1);
}

function splitCsv(line) {
  const out = []; let cur = '', q = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (q) { if (c === '"') { if (line[i + 1] === '"') { cur += '"'; i++; } else q = false; } else cur += c; }
    else if (c === '"') q = true;
    else if (c === ',') { out.push(cur); cur = ''; }
    else cur += c;
  }
  out.push(cur); return out;
}

function loadAssets() {
  return new Promise((resolve) => {
    const map = new Map(); let header = null;
    const rl = readline.createInterface({ input: fs.createReadStream(RAW + 'ncz_assets.csv'), crlfDelay: Infinity });
    rl.on('line', (l) => {
      if (header === null) { header = l; return; }
      if (!l) return;
      const f = splitCsv(l);
      map.set(f[0], f[1]);
    });
    rl.on('close', () => resolve(map));
  });
}

/**
 * The exposure verdict, keyed by the placement's world position.
 *
 * The stage-1 bin and the raw CSV are two different orderings of the same
 * placements with no shared id, so the join is spatial: position rounded to a
 * decimetre is unique enough here and needs no new field in either file.
 */
function loadExposure() {
  const metaFile = path.join(__dirname, '..', 'data', `district-boxes-${district}.json`);
  const expFile = path.join(__dirname, '..', 'data', `exposure-${district}.bin`);
  if (!fs.existsSync(metaFile) || !fs.existsSync(expFile)) return null;
  const meta = JSON.parse(fs.readFileSync(metaFile, 'utf8'));
  const raw = fs.readFileSync(path.join(__dirname, '..', 'data', `district-boxes-${district}.bin`));
  const box = new Float32Array(raw.buffer, raw.byteOffset, raw.length / 4);
  const verdict = new Uint8Array(fs.readFileSync(expFile));
  const S = meta.stride;
  const key = new Map();
  for (let i = 0; i < meta.boxes && i < verdict.length; i++) {
    const o = i * S;
    key.set(`${box[o + 13].toFixed(1)},${box[o + 14].toFixed(1)},${box[o + 15].toFixed(1)}`, verdict[i]);
  }
  return key;
}

(async () => {
  const assets = await loadAssets();
  const exposure = loadExposure();
  console.log(`assets ${assets.size.toLocaleString()}, exposure ${exposure ? 'loaded' : 'ABSENT (keeping everything)'}`);

  // ── Collect the assembly's placements ───────────────────────────────────
  const placements = [];
  let hiddenDropped = 0, notBuilding = 0;
  await new Promise((resolve) => {
    let header = null;
    const rl = readline.createInterface({ input: fs.createReadStream(RAW + 'ncz_instances.csv'), crlfDelay: Infinity });
    rl.on('line', (l) => {
      if (header === null) { header = l; return; }
      if (!l) return;
      const p = l.split(',');
      if (p[0] !== sector || p[4] !== prefab) return;
      const depot = assets.get(p[3]);
      if (!depot) return;
      const kind = categorize(depot, p[2]);
      if (kind === 'never' || kind === 'boundary' || kind === 'terrain') { notBuilding++; return; }
      const x = +p[5], y = +p[6], z = +p[7];
      if (exposure && !KEEP_HIDDEN) {
        const v = exposure.get(`${x.toFixed(1)},${y.toFixed(1)},${z.toFixed(1)}`);
        if (v === 2) { hiddenDropped++; return; }
      }
      placements.push({
        depot, x, y, z,
        q: [+p[8] || 0, +p[9] || 0, +p[10] || 0, +p[11] || 1],
        s: [+p[12] || 1, +p[13] || 1, +p[14] || 1],
        kind,
      });
    });
    rl.on('close', resolve);
  });

  if (!placements.length) {
    console.error(`no placements for ${sector}|${prefab}`);
    process.exit(1);
  }
  console.log(`placements ${placements.length.toLocaleString()} kept ` +
              `(${hiddenDropped.toLocaleString()} never visible, ${notBuilding.toLocaleString()} not geometry)`);

  // ── Load the unique meshes once ─────────────────────────────────────────
  const meshes = new Map();   // depot -> { index, tris }
  let missing = 0;
  for (const pl of placements) {
    if (meshes.has(pl.depot)) continue;
    const file = glbPathFor(RAW_ROOT, pl.depot);
    let tris = null;
    if (fs.existsSync(file)) {
      try { tris = meshTriangles(file); if (!tris.length) tris = null; } catch { tris = null; }
    }
    if (!tris) { missing++; meshes.set(pl.depot, null); continue; }
    meshes.set(pl.depot, { index: -1, tris });
  }
  const live = placements.filter(p => meshes.get(p.depot));
  const meshList = [];
  for (const [depot, m] of meshes) {
    if (!m) continue;
    m.index = meshList.length;
    meshList.push({ depot, tris: m.tris });
  }
  const uniqueTris = meshList.reduce((n, m) => n + m.tris.length / 9, 0);
  console.log(`meshes     ${meshList.length} unique (${missing} without a GLB), ${uniqueTris.toLocaleString()} triangles`);

  // ── Pack ────────────────────────────────────────────────────────────────
  // Kit: every unique mesh's triangles back to back, then one transform per
  // placement (position, quaternion, scale, mesh index).
  const kitFloats = meshList.reduce((n, m) => n + m.tris.length, 0);
  const kitGeo = new Float32Array(kitFloats);
  const meshIndex = [];
  let off = 0;
  for (const m of meshList) {
    kitGeo.set(m.tris, off);
    meshIndex.push({ depot: m.depot, floatOffset: off, triangles: m.tris.length / 9 });
    off += m.tris.length;
  }

  const inst = new Float32Array(live.length * 11);
  live.forEach((p, i) => {
    const o = i * 11;
    inst[o] = p.x; inst[o + 1] = p.y; inst[o + 2] = p.z;
    inst[o + 3] = p.q[0]; inst[o + 4] = p.q[1]; inst[o + 5] = p.q[2]; inst[o + 6] = p.q[3];
    inst[o + 7] = p.s[0]; inst[o + 8] = p.s[1]; inst[o + 9] = p.s[2];
    inst[o + 10] = meshes.get(p.depot).index;
  });

  // Merged: the same triangles, transformed into world space once.
  const mergedTriCount = live.reduce((n, p) => n + meshes.get(p.depot).tris.length / 9, 0);
  const merged = new Float32Array(mergedTriCount * 9);
  let mo = 0;
  let bx0 = Infinity, by0 = Infinity, bz0 = Infinity, bx1 = -Infinity, by1 = -Infinity, bz1 = -Infinity;
  for (const p of live) {
    const t = meshes.get(p.depot).tris;
    const [qx, qy, qz, qw] = p.q;
    const m00 = 1 - 2 * (qy * qy + qz * qz), m01 = 2 * (qx * qy - qz * qw), m02 = 2 * (qx * qz + qy * qw);
    const m10 = 2 * (qx * qy + qz * qw), m11 = 1 - 2 * (qx * qx + qz * qz), m12 = 2 * (qy * qz - qx * qw);
    const m20 = 2 * (qx * qz - qy * qw), m21 = 2 * (qy * qz + qx * qw), m22 = 1 - 2 * (qx * qx + qy * qy);
    for (let k = 0; k < t.length; k += 3) {
      const lx = t[k] * p.s[0], ly = t[k + 1] * p.s[1], lz = t[k + 2] * p.s[2];
      const wx = p.x + m00 * lx + m01 * ly + m02 * lz;
      const wy = p.y + m10 * lx + m11 * ly + m12 * lz;
      const wz = p.z + m20 * lx + m21 * ly + m22 * lz;
      merged[mo++] = wx; merged[mo++] = wy; merged[mo++] = wz;
      if (wx < bx0) bx0 = wx; if (wx > bx1) bx1 = wx;
      if (wy < by0) by0 = wy; if (wy > by1) by1 = wy;
      if (wz < bz0) bz0 = wz; if (wz > bz1) bz1 = wz;
    }
  }

  // ── Boxes: what the current pipeline ships for the same volume ──────────
  const hullFile = path.join(__dirname, '..', 'data', `district-hull-${district}.bin`);
  const boxes = [];
  if (fs.existsSync(hullFile)) {
    const hraw = fs.readFileSync(hullFile);
    const hf = new Float32Array(hraw.buffer, hraw.byteOffset, hraw.length / 4);
    const pad = 4;
    for (let i = 0; i < hf.length / 10; i++) {
      const o = i * 10;
      if (hf[o] < bx0 - pad || hf[o] > bx1 + pad) continue;
      if (hf[o + 1] < by0 - pad || hf[o + 1] > by1 + pad) continue;
      if (hf[o + 2] < bz0 - pad || hf[o + 2] > bz1 + pad) continue;
      for (let k = 0; k < 10; k++) boxes.push(hf[o + k]);
    }
  }
  const boxArr = Float32Array.from(boxes);

  const parts = [
    Buffer.from(kitGeo.buffer, 0, kitGeo.byteLength),
    Buffer.from(inst.buffer, 0, inst.byteLength),
    Buffer.from(merged.buffer, 0, merged.byteLength),
    Buffer.from(boxArr.buffer, 0, boxArr.byteLength),
  ];
  const bin = Buffer.concat(parts);
  const base = `spike-${sector}-${prefab}`;
  const outDir = path.join(__dirname, '..', 'data');
  fs.writeFileSync(path.join(outDir, `${base}.bin`), bin);

  let cursor = 0;
  const range = (bytes) => { const r = { byteOffset: cursor, byteLength: bytes }; cursor += bytes; return r; };
  fs.writeFileSync(path.join(outDir, `${base}.json`), JSON.stringify({
    district, sector, prefab,
    placements: live.length, droppedNeverVisible: hiddenDropped, droppedNotGeometry: notBuilding,
    uniqueMeshes: meshList.length, uniqueTriangles: uniqueTris,
    drawnTriangles: mergedTriCount, hullBoxes: boxArr.length / 10,
    bounds: { min: [bx0, by0, bz0], max: [bx1, by1, bz1] },
    layout: {
      kit: { ...range(kitGeo.byteLength), format: 'float32 xyz per vertex, 3 vertices per triangle, CET space' },
      instances: { ...range(inst.byteLength), stride: 11, format: 'pos xyz, quat xyzw, scale xyz, meshIndex' },
      merged: { ...range(merged.byteLength), format: 'float32 xyz per vertex, world CET space' },
      boxes: { ...range(boxArr.byteLength), stride: 10, format: 'centre xyz, halfExtent xyz, quat xyzw' },
    },
    meshes: meshIndex,
    generated: new Date().toISOString(),
  }, null, 2));

  console.log(`kit        ${(kitGeo.byteLength / 1e6).toFixed(2)} MB unique geometry + ${live.length} transforms`);
  console.log(`merged     ${mergedTriCount.toLocaleString()} triangles (${(merged.byteLength / 1e6).toFixed(2)} MB)`);
  console.log(`boxes      ${(boxArr.length / 10).toLocaleString()} hull boxes in the same volume`);
  console.log(`bounds     ${(bx1 - bx0).toFixed(0)} x ${(by1 - by0).toFixed(0)} x ${(bz1 - bz0).toFixed(0)} m`);
  console.log(`-> data/${base}.bin  ${(bin.length / 1e6).toFixed(1)} MB`);
})();
