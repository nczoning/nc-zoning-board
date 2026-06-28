/**
 * strip_glb_attributes.js
 * Removes unused vertex attributes from a GLB.
 * Usage: node scripts/strip_glb_attributes.js <input.glb> <output.glb> [ATTR1,ATTR2,...]
 *
 * Default keep list: POSITION
 * Examples:
 *   node scripts/strip_glb_attributes.js mesh.glb out.glb              # POSITION only
 *   node scripts/strip_glb_attributes.js mesh.glb out.glb POSITION,NORMAL  # keep normals
 *   node scripts/strip_glb_attributes.js mesh.glb out.glb POSITION,COLOR_0 # keep vertex colors
 */
'use strict';
const fs = require('fs');

const [,, inputPath, outputPath, keepArg] = process.argv;
if (!inputPath || !outputPath) {
  console.error('Usage: node strip_glb_attributes.js <input.glb> <output.glb> [ATTR1,ATTR2,...]');
  process.exit(1);
}
const KEEP = new Set((keepArg || 'POSITION').split(',').map(s => s.trim()));

const buf = fs.readFileSync(inputPath);
if (buf.readUInt32LE(0) !== 0x46546C67) throw new Error('Not a GLB file');

const jsonChunkLen = buf.readUInt32LE(12);
const json = JSON.parse(buf.slice(20, 20 + jsonChunkLen).toString('utf8'));
const binStart = 20 + jsonChunkLen + 8;
const bin = buf.slice(binStart);

// Collect which bufferViews are needed (only attributes in KEEP set)
const neededViews = new Set();
const neededAccessors = new Set();

for (const mesh of json.meshes || []) {
  for (const prim of mesh.primitives || []) {
    const keptAttribs = {};
    for (const [attr, accIdx] of Object.entries(prim.attributes || {})) {
      if (KEEP.has(attr)) {
        keptAttribs[attr] = accIdx;
        neededAccessors.add(accIdx);
        const bv = json.accessors[accIdx].bufferView;
        if (bv !== undefined) neededViews.add(bv);
      }
    }
    // Keep indices
    if (prim.indices !== undefined) {
      neededAccessors.add(prim.indices);
      const bv = json.accessors[prim.indices].bufferView;
      if (bv !== undefined) neededViews.add(bv);
    }
    prim.attributes = keptAttribs;
  }
}

// Rebuild binary: only include needed bufferViews, remapped
const viewList = [...neededViews].sort((a, b) => a - b);
const viewRemap = new Map(viewList.map((v, i) => [v, i]));

const parts = [];
let offset = 0;
const newViews = viewList.map(vi => {
  const bv = json.bufferViews[vi];
  const start = bv.byteOffset || 0;
  const data = bin.slice(start, start + bv.byteLength);
  const pad = (4 - data.length % 4) % 4;
  const padded = pad ? Buffer.concat([data, Buffer.alloc(pad)]) : data;
  parts.push(padded);
  const newView = { buffer: 0, byteOffset: offset, byteLength: bv.byteLength };
  if (bv.target) newView.target = bv.target;
  offset += padded.length;
  return newView;
});

// Remap accessor bufferViews
const accList = [...neededAccessors].sort((a, b) => a - b);
const accRemap = new Map(accList.map((a, i) => [a, i]));
const newAccs = accList.map(ai => {
  const acc = { ...json.accessors[ai] };
  if (acc.bufferView !== undefined) acc.bufferView = viewRemap.get(acc.bufferView);
  return acc;
});

// Remap mesh primitive accessor indices
for (const mesh of json.meshes || []) {
  for (const prim of mesh.primitives || []) {
    for (const k of Object.keys(prim.attributes)) {
      prim.attributes[k] = accRemap.get(prim.attributes[k]);
    }
    if (prim.indices !== undefined) prim.indices = accRemap.get(prim.indices);
    delete prim.material; // strip material reference (we apply our own)
  }
}

const newBin = Buffer.concat(parts);
const newJson = {
  asset: { version: '2.0', generator: 'strip_glb_attributes' },
  scene: 0,
  scenes: [{ nodes: (json.meshes || []).map((_, i) => i) }],
  nodes: (json.meshes || []).map((m, i) => ({ mesh: i, name: m.name })),
  meshes: json.meshes,
  accessors: newAccs,
  bufferViews: newViews,
  buffers: [{ byteLength: newBin.length }],
};

const jsonStr = JSON.stringify(newJson);
const jsonPad = (4 - jsonStr.length % 4) % 4;
const jsonBuf = Buffer.concat([Buffer.from(jsonStr), Buffer.alloc(jsonPad, 0x20)]);

const total = 12 + 8 + jsonBuf.length + 8 + newBin.length;
const out = Buffer.alloc(total);
out.writeUInt32LE(0x46546C67, 0);
out.writeUInt32LE(2, 4);
out.writeUInt32LE(total, 8);
out.writeUInt32LE(jsonBuf.length, 12);
out.writeUInt32LE(0x4E4F534A, 16);
jsonBuf.copy(out, 20);
const b2 = 20 + jsonBuf.length;
out.writeUInt32LE(newBin.length, b2);
out.writeUInt32LE(0x004E4942, b2 + 4);
newBin.copy(out, b2 + 8);

fs.writeFileSync(outputPath, out);
console.log(`Input:  ${(buf.length / 1024 / 1024).toFixed(1)} MB`);
console.log(`Output: ${(out.length / 1024 / 1024).toFixed(1)} MB`);
console.log(`Saved:  ${((1 - out.length / buf.length) * 100).toFixed(0)}%`);
