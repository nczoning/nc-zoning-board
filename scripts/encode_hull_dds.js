#!/usr/bin/env node
/**
 * encode_hull_dds.js: stage 3 of the box-cloud rebuild.
 *
 * Writes the rebuilt boxes into the game's own _data.dds layout, so nothing
 * downstream has to change to look at them: the renderer, the culling, the
 * facemask and the shaders all decode a texture, and this is that texture.
 *
 * Layout, per the decode in loadBuildings() and the game's own vertex shader:
 * a 3W x H texture of R16G16B16A16_UNORM holding W*H building slots in three
 * side-by-side blocks.
 *
 *   block 0  position, normalised inside the district's transMin..transMax.
 *            Alpha marks the slot as occupied.
 *   block 1  rotation quaternion, each channel encoded as (v + 1) / 2.
 *   block 2  half-extent as a fraction of cubeSize.
 *
 * cubeSize is the format's ceiling on a half-extent, and a greedy-merged box
 * can run longer than it, so anything over is SPLIT along the offending axis
 * rather than clamped. Clamping would shrink a building silently; splitting
 * costs a few slots and keeps the geometry exact. Measured: 2.3% of
 * city_center's boxes and 0.14% of Watson's need it.
 *
 * Usage:
 *   node scripts/encode_hull_dds.js city_center
 *   node scripts/encode_hull_dds.js city_center watson
 *
 * Output: assets/dds/rebuilt/<district>_data.dds  (view with ?assets=rebuilt)
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { DISTRICTS, worldBounds } = require('./district_meta');

const U16 = 65535;
const dataDir = path.join(__dirname, '..', 'data');
const outDir = path.join(__dirname, '..', 'assets', 'dds', 'rebuilt');
fs.mkdirSync(outDir, { recursive: true });

/** 128-byte DDS header plus the 20-byte DX10 extension, uncompressed RGBA16. */
function ddsHeader(width, height) {
  const h = Buffer.alloc(148);
  const u = new Uint32Array(h.buffer, 0, 37);
  h.write('DDS ', 0, 'ascii');
  u[1] = 124;                       // dwSize
  u[2] = 0x1 | 0x2 | 0x4 | 0x1000;  // CAPS | HEIGHT | WIDTH | PIXELFORMAT
  u[3] = height;
  u[4] = width;
  u[5] = width * 8;                 // pitch: 8 bytes per pixel
  u[7] = 1;                         // mip count
  u[19] = 32;                       // ddspf.dwSize
  u[20] = 0x4;                      // DDPF_FOURCC
  h.write('DX10', 84, 'ascii');     // ddspf.dwFourCC
  u[27] = 0x1000;                   // DDSCAPS_TEXTURE
  u[32] = 11;                       // DXGI_FORMAT_R16G16B16A16_UNORM
  u[33] = 3;                        // D3D10_RESOURCE_DIMENSION_TEXTURE2D
  u[35] = 1;                        // arraySize
  return h;
}

for (const name of process.argv.slice(2)) {
  const meta = DISTRICTS[name];
  if (!meta) { console.error(`unknown district ${name}`); continue; }
  const bounds = worldBounds(meta);
  const cube = meta.cubeSize;

  const raw = fs.readFileSync(path.join(dataDir, `district-hull-${name}.bin`));
  const f = new Float32Array(raw.buffer, raw.byteOffset, raw.length / 4);

  // Split anything the scale block cannot express, then collect the slots.
  const slots = [];
  let split = 0;
  for (let i = 0; i < f.length / 10; i++) {
    const o = i * 10;
    const c = [f[o], f[o + 1], f[o + 2]];
    const h = [f[o + 3], f[o + 4], f[o + 5]];
    const q = [f[o + 6], f[o + 7], f[o + 8], f[o + 9]];
    const parts = [0, 1, 2].map(a => Math.max(1, Math.ceil(h[a] / cube)));
    if (parts[0] * parts[1] * parts[2] > 1) split++;
    for (let a = 0; a < parts[0]; a++) {
      for (let b = 0; b < parts[1]; b++) {
        for (let d = 0; d < parts[2]; d++) {
          const nh = [h[0] / parts[0], h[1] / parts[1], h[2] / parts[2]];
          slots.push({
            c: [
              c[0] - h[0] + nh[0] * (2 * a + 1),
              c[1] - h[1] + nh[1] * (2 * b + 1),
              c[2] - h[2] + nh[2] * (2 * d + 1),
            ], h: nh, q,
          });
        }
      }
    }
  }

  const W = Math.ceil(Math.sqrt(slots.length));
  const H = Math.ceil(slots.length / W);
  const texW = W * 3;
  const px = new Uint16Array(texW * H * 4); // zeroed: alpha 0 marks a slot empty

  const span = [
    meta.transMax[0] - meta.transMin[0],
    meta.transMax[1] - meta.transMin[1],
    meta.transMax[2] - meta.transMin[2],
  ];
  const enc = v => Math.max(0, Math.min(U16, Math.round(v * U16)));

  slots.forEach((s, i) => {
    const x = i % W, y = (i / W) | 0;
    const pi = (y * texW + x) * 4;
    const ri = (y * texW + x + W) * 4;
    const si = (y * texW + x + 2 * W) * 4;

    px[pi]     = enc((s.c[0] - bounds.min[0]) / span[0]);
    px[pi + 1] = enc((s.c[1] - bounds.min[1]) / span[1]);
    px[pi + 2] = enc((s.c[2] - bounds.min[2]) / span[2]);
    px[pi + 3] = U16;                       // occupied

    px[ri]     = enc((s.q[0] + 1) / 2);
    px[ri + 1] = enc((s.q[1] + 1) / 2);
    px[ri + 2] = enc((s.q[2] + 1) / 2);
    px[ri + 3] = enc((s.q[3] + 1) / 2);

    px[si]     = enc(s.h[0] / cube);
    px[si + 1] = enc(s.h[1] / cube);
    px[si + 2] = enc(s.h[2] / cube);
    px[si + 3] = U16;
  });

  const file = path.join(outDir, meta.dds);
  fs.writeFileSync(file, Buffer.concat([ddsHeader(texW, H), Buffer.from(px.buffer)]));
  console.log(`${name.padEnd(14)} ${slots.length.toLocaleString().padStart(9)} slots ` +
              `(${split.toLocaleString()} boxes split to fit cubeSize ${cube.toFixed(1)})  ` +
              `${texW} x ${H}  ${(fs.statSync(file).size / 1e6).toFixed(1)} MB  -> ${path.relative(process.cwd(), file)}`);
}
