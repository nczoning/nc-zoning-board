#!/usr/bin/env node
/**
 * validate_3dmap_assets.js — sanity-check the 3D-map building DDS textures.
 *
 * Run after dropping in new/updated assets (e.g. a malgalad "3D World Map Fixed"
 * release — see docs/3dmap-fixed-assets.md). Read-only; no encoding.
 *
 * Checks, per _data.dds:
 *   - DX10 header present, format R16G16B16A16_UNORM (the point-cloud format)
 *   - width % 3 === 0 (three stacked blocks: position | rotation | scale)
 *   - file size == 148-byte header + width*height*8 (16-bit RGBA, 1 mip)
 * Then cross-checks that every DDS path referenced by DISTRICT_META exists.
 *
 * Usage: node scripts/validate_3dmap_assets.js
 * Exit code 1 if any check fails.
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const DDS_DIR = path.join(ROOT, 'assets', 'dds');
const HEADER_BYTES = 148;            // 4 magic + 124 DDS_HEADER + 20 DX10
const DXGI_R16G16B16A16_UNORM = 11;

let failures = 0;
const fail = (msg) => { console.error(`  ✗ ${msg}`); failures++; };
const ok = (msg) => console.log(`  ✓ ${msg}`);

function validateDataDds(file) {
  const rel = path.relative(ROOT, file);
  const b = fs.readFileSync(file);
  if (b.toString('ascii', 0, 4) !== 'DDS ') return fail(`${rel}: not a DDS file`);

  const height = b.readUInt32LE(12);
  const width = b.readUInt32LE(16);
  const dxgi = b.readUInt32LE(128);  // DX10 header dxgiFormat

  if (dxgi !== DXGI_R16G16B16A16_UNORM)
    return fail(`${rel}: DXGI format ${dxgi}, expected ${DXGI_R16G16B16A16_UNORM} (R16G16B16A16_UNORM)`);
  if (width % 3 !== 0)
    return fail(`${rel}: width ${width} not divisible by 3 (needs 3 stacked blocks)`);

  const blockW = width / 3;
  const blockH = Math.min(height, blockW);
  const expected = HEADER_BYTES + width * height * 8;   // 8 bytes/pixel
  if (b.length !== expected)
    return fail(`${rel}: size ${b.length}, expected ${expected} for ${width}×${height} R16G16B16A16`);

  ok(`${rel}: ${width}×${height} → block ${blockW}×${blockH}`);
}

// 1. Validate every _data.dds under assets/dds (and assets/dds/fixed)
console.log('Validating _data.dds textures:');
const dataFiles = [];
for (const dir of [DDS_DIR, path.join(DDS_DIR, 'fixed')]) {
  if (!fs.existsSync(dir)) continue;
  for (const f of fs.readdirSync(dir)) {
    if (f.endsWith('_data.dds')) dataFiles.push(path.join(dir, f));
  }
}
dataFiles.sort().forEach(validateDataDds);

// 2. Cross-check DISTRICT_META references resolve to real files
console.log('\nChecking DISTRICT_META asset references exist:');
const src = fs.readFileSync(path.join(ROOT, 'assets', 'js', 'three-scene.js'), 'utf8');
const refs = new Set();
for (const m of src.matchAll(/['"]assets\/dds\/[^'"]+\.dds['"]/g)) {
  refs.add(m[0].slice(1, -1));
}
[...refs].sort().forEach((ref) => {
  fs.existsSync(path.join(ROOT, ref)) ? ok(ref) : fail(`${ref}: referenced in three-scene.js but missing on disk`);
});

console.log('');
if (failures) { console.error(`FAILED: ${failures} problem(s).`); process.exit(1); }
console.log('All 3D-map building assets valid.');
