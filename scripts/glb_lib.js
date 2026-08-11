/**
 * glb_lib.js: read triangles out of a WolvenKit GLB export.
 *
 * The reader is the one window_geom.js proved against the export: uncompressed
 * float32 with indices, no Draco, no meshopt. It THROWS on an unexpected
 * extension rather than reading garbage silently.
 *
 * COORDINATE SPACE. WolvenKit exports glTF, which is Y-up, while every
 * placement in the world dump is CET, which is Z-up. CET (x, y, z) maps to
 * glTF (x, z, -y), so a glTF vertex (X, Y, Z) is CET (X, -Z, Y). Verified
 * against ncz_assets.csv bounds by scripts/check_glb_axes.js rather than
 * assumed: a wrong mapping here produces a cloud that is wrong everywhere and
 * looks plausible nowhere.
 */
'use strict';

const fs = require('fs');
const path = require('path');

/** Depot path (base\a\b.mesh) to the exported GLB on disk. */
function glbPathFor(rawRoot, depotPath) {
  return path.join(rawRoot, depotPath.replace(/\.mesh$/i, '.glb'));
}

function readGlb(file) {
  const b = fs.readFileSync(file);
  if (b.readUInt32LE(0) !== 0x46546c67) throw new Error(`not a GLB: ${file}`);
  const jsonLen = b.readUInt32LE(12);
  const json = JSON.parse(b.slice(20, 20 + jsonLen).toString('utf8'));
  if (json.extensionsUsed && json.extensionsUsed.length) {
    throw new Error(`${path.basename(file)} uses ${json.extensionsUsed}: this reader assumes raw float32`);
  }
  return { json, b, bin: 20 + jsonLen + 8 };
}

function accessorOffset({ json, bin }, i) {
  const a = json.accessors[i];
  const v = json.bufferViews[a.bufferView];
  return { a, off: bin + (v.byteOffset || 0) + (a.byteOffset || 0) };
}

/**
 * Every triangle of every submesh, as CET-local vertices.
 *
 * @returns {Float32Array} 9 floats per triangle: ax ay az bx by bz cx cy cz.
 *          Empty when the file holds no indexed triangles.
 */
function meshTriangles(file) {
  const glb = readGlb(file);
  const { json } = glb;
  const out = [];

  for (const m of json.meshes || []) {
    for (const p of m.primitives || []) {
      if (p.mode !== undefined && p.mode !== 4) continue;   // triangles only
      if (p.indices === undefined || p.attributes.POSITION === undefined) continue;

      const pa = accessorOffset(glb, p.attributes.POSITION);
      if (pa.a.componentType !== 5126) continue;            // POSITION must be float32
      const ia = accessorOffset(glb, p.indices);

      const idx = (k) => ia.a.componentType === 5125 ? glb.b.readUInt32LE(ia.off + k * 4)
        : ia.a.componentType === 5123 ? glb.b.readUInt16LE(ia.off + k * 2)
          : glb.b.readUInt8(ia.off + k);

      // glTF (X, Y, Z) -> CET (X, -Z, Y)
      const vx = (k) => glb.b.readFloatLE(pa.off + k * 12);
      const vy = (k) => -glb.b.readFloatLE(pa.off + k * 12 + 8);
      const vz = (k) => glb.b.readFloatLE(pa.off + k * 12 + 4);

      for (let k = 0; k + 2 < ia.a.count; k += 3) {
        const a = idx(k), b = idx(k + 1), c = idx(k + 2);
        out.push(vx(a), vy(a), vz(a), vx(b), vy(b), vz(b), vx(c), vy(c), vz(c));
      }
    }
  }
  return Float32Array.from(out);
}

/** CET-local bounds of a mesh, as [minX, minY, minZ, maxX, maxY, maxZ]. */
function meshBounds(tris) {
  const b = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];
  for (let i = 0; i < tris.length; i += 3) {
    for (let a = 0; a < 3; a++) {
      if (tris[i + a] < b[a]) b[a] = tris[i + a];
      if (tris[i + a] > b[a + 3]) b[a + 3] = tris[i + a];
    }
  }
  return b;
}

module.exports = { glbPathFor, readGlb, meshTriangles, meshBounds };
