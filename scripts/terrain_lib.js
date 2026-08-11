/**
 * terrain_lib.js: sample the terrain surface height under a world point.
 *
 * Extracted verbatim from scripts/verify_terrain.js, which measured this
 * terrain as correct in shape with a near-constant ~4 m bias. Shared so the
 * box-cloud rebuild clips against the same surface the verifier trusted,
 * rather than a second copy that can drift from it.
 *
 * Coordinates: the terrain GLB is in THREE space and CET (x,y,z) maps to
 * THREE (x, z, -y), so sampling under a CET point (cx, cy) means looking up
 * THREE (cx, -cy). The surface Y that comes back IS the CET z.
 */
'use strict';

const fs = require('fs');

const GLB = require('path').join(__dirname, '..', 'assets', 'glb-source', '3dmap_terrain.glb');
const GRID = 64; // spatial hash cell, metres

/** Load every submesh of the terrain GLB into one triangle soup in THREE space. */
function loadTerrain(glbPath = GLB) {
  const buf = fs.readFileSync(glbPath);
  const jlen = buf.readUInt32LE(12);
  const json = JSON.parse(buf.slice(20, 20 + jlen).toString('utf8'));
  const binChunkOffset = 20 + jlen + 8; // skip the JSON chunk and the BIN chunk header
  const bin = buf.slice(binChunkOffset);
  const CT = { 5126: Float32Array, 5123: Uint16Array, 5125: Uint32Array };
  const read = (ai) => {
    const acc = json.accessors[ai];
    const bv = json.bufferViews[acc.bufferView];
    const off = (bv.byteOffset || 0) + (acc.byteOffset || 0);
    const comp = { SCALAR: 1, VEC2: 2, VEC3: 3 }[acc.type];
    const Ctor = CT[acc.componentType];
    return new Ctor(bin.buffer, bin.byteOffset + off, acc.count * comp);
  };
  const tris = [];
  for (const m of json.meshes) {
    for (const p of m.primitives) {
      const pos = read(p.attributes.POSITION);
      const idx = read(p.indices);
      for (let i = 0; i < idx.length; i += 3) {
        const t = [];
        for (const k of [idx[i], idx[i + 1], idx[i + 2]]) t.push(pos[k * 3], pos[k * 3 + 1], pos[k * 3 + 2]);
        tris.push(t);
      }
    }
  }
  return tris;
}

const gkey = (x, z) => `${Math.floor(x / GRID)},${Math.floor(z / GRID)}`;

/** Spatial hash over (x,z) so a point query is O(1). */
function indexTris(tris) {
  const buckets = new Map();
  for (const t of tris) {
    const minx = Math.min(t[0], t[3], t[6]), maxx = Math.max(t[0], t[3], t[6]);
    const minz = Math.min(t[2], t[5], t[8]), maxz = Math.max(t[2], t[5], t[8]);
    for (let gx = Math.floor(minx / GRID); gx <= Math.floor(maxx / GRID); gx++) {
      for (let gz = Math.floor(minz / GRID); gz <= Math.floor(maxz / GRID); gz++) {
        const k = `${gx},${gz}`;
        let b = buckets.get(k); if (!b) buckets.set(k, b = []);
        b.push(t);
      }
    }
  }
  return buckets;
}

/** Terrain height at THREE (x,z), barycentric-interpolated. null when off-mesh. */
function heightAt(buckets, x, z) {
  const b = buckets.get(gkey(x, z));
  if (!b) return null;
  for (const t of b) {
    const [ax, ay, az, bx, by, bz, cx, cy, cz] = t;
    const d = (bz - cz) * (ax - cx) + (cx - bx) * (az - cz);
    if (Math.abs(d) < 1e-9) continue;
    const wa = ((bz - cz) * (x - cx) + (cx - bx) * (z - cz)) / d;
    const wb = ((cz - az) * (x - cx) + (ax - cx) * (z - cz)) / d;
    const wc = 1 - wa - wb;
    if (wa >= -0.01 && wb >= -0.01 && wc >= -0.01) return wa * ay + wb * by + wc * cy;
  }
  return null;
}

/** Terrain height under a CET (x, y) point, in CET z. null when off-mesh. */
function heightAtCet(buckets, cetX, cetY) {
  return heightAt(buckets, cetX, -cetY);
}

module.exports = { loadTerrain, indexTris, heightAt, heightAtCet, GLB, GRID };
