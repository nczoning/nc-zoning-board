#!/usr/bin/env node
/**
 * Encode source GLBs → assets/glb-meshopt/ via gltfpack.
 *
 * Source GLBs come from WolvenKit. The repo only commits the encoded output
 * (assets/glb-meshopt/); the uncompressed source files are gitignored at
 * assets/glb-source/. Drop fresh WolvenKit exports there before running.
 *
 *   Default input:  assets/glb-source/  (gitignored, populate manually)
 *   Override:       node scripts/encode_glbs_meshopt.js <path/to/source>
 *                   INPUT_GLB_DIR=<path> npm run encode-meshopt
 *
 * gltfpack uses EXT_meshopt_compression. Compared to Draco, meshopt prioritises
 * decode speed and preserves vertex/index ordering (so vertex cache + fetch
 * optimisations remain effective). Files end up smaller than Draco for our
 * sub-mesh-heavy GLBs, plus the decoder bundle is ~30 KB vs Draco's ~200 KB.
 * Three.js wires this up via gltfLoader.setMeshoptDecoder(MeshoptDecoder).
 *
 * Per-asset position quantization:
 *   - World-coord meshes (terrain, cliffs, water, roads, metro): -vp 16 (CET 12 km extent)
 *   - Local-space landmarks: -vp 14 (small bounding box, sub-cm precision)
 */

const { spawnSync } = require('child_process');
const fs   = require('fs');
const path = require('path');

const DEFAULT_SRC = path.join(__dirname, '..', 'assets', 'glb-source');
const SRC = path.resolve(process.argv[2] || process.env.INPUT_GLB_DIR || DEFAULT_SRC);
const DST = path.join(__dirname, '..', 'assets', 'glb-meshopt');

// Per-asset position quantization bits — same precision targets as Draco settings.
const PRESETS = {
  '3dmap_terrain.glb':       { vp: 16 },
  '3dmap_cliffs.glb':        { vp: 16 },
  '3dmap_water.glb':         { vp: 16 },
  '3dmap_roads.glb':         { vp: 16 },
  '3dmap_roads_borders.glb': { vp: 16 },
  '3dmap_metro.glb':         { vp: 16 },
};
const LANDMARK_DEFAULT = { vp: 14 };

// gltfpack flags shared across all assets:
//   -cc: aggressive EXT_meshopt_compression
//   -vn 10: normal quantization bits
//   -vt 12: texcoord quantization bits
//   -vc 8: vertex color quantization bits
//   -ke: keep extras (no-op for our GLBs but cheap insurance)
//
// Intentionally NOT using -kn (keep names): with -kn, gltfpack inserts named
// wrapper groups above the dequantization transform nodes. Three.js r170's
// GLTFLoader appears to lose the child transform when the hierarchy is two
// levels deep with quantization on the inner level — meshes render at int16
// scale (4–5× too large). Without -kn, gltfpack puts the dequant transform
// directly on the root nodes, which Three.js handles correctly. Trade-off:
// loses original mesh names like "submesh_00_LOD_1" — but our code doesn't
// reference them, so no functional impact.
const SHARED_FLAGS = ['-cc', '-vn', '10', '-vt', '12', '-vc', '8', '-ke'];

function runGltfpack(args) {
  // Use npx so the locally-installed gltfpack from devDependencies is found
  // regardless of platform (Windows resolves .cmd shims, Unix resolves bin scripts).
  const result = spawnSync('npx', ['--no-install', 'gltfpack', ...args], {
    encoding: 'utf8',
    shell: true,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`gltfpack exited ${result.status}: ${result.stderr || result.stdout}`);
  }
  return result.stdout;
}

(async () => {
  if (!fs.existsSync(SRC)) {
    console.error(`Source folder not found: ${SRC}`);
    console.error('Drop WolvenKit-exported GLBs into assets/glb-source/ (gitignored)');
    console.error('or pass an explicit path: node scripts/encode_glbs_meshopt.js <dir>');
    process.exit(1);
  }
  if (!fs.existsSync(DST)) fs.mkdirSync(DST, { recursive: true });

  const files = fs.readdirSync(SRC).filter(f => f.endsWith('.glb'));
  if (files.length === 0) {
    console.error(`No .glb files in ${SRC}`);
    process.exit(1);
  }
  console.log(`Encoding ${files.length} GLBs from ${SRC}\n`);

  let totalIn = 0, totalOut = 0;
  for (const f of files) {
    const inPath  = path.join(SRC, f);
    const outPath = path.join(DST, f);
    const q = PRESETS[f] || LANDMARK_DEFAULT;

    try {
      runGltfpack(['-i', inPath, '-o', outPath, '-vp', String(q.vp), ...SHARED_FLAGS]);
      const inputSize  = fs.statSync(inPath).size;
      const outputSize = fs.statSync(outPath).size;
      totalIn  += inputSize;
      totalOut += outputSize;
      const pct = ((1 - outputSize / inputSize) * 100).toFixed(1);
      console.log(`  ${(inputSize/1024).toFixed(0).padStart(6)} KB → ${(outputSize/1024).toFixed(0).padStart(5)} KB  (-${pct}%, vp=${q.vp})  ${f}`);
    } catch (err) {
      console.error(`  FAILED  ${f}:  ${err.message}`);
    }
  }

  const totalPct = ((1 - totalOut / totalIn) * 100).toFixed(1);
  console.log(`\nTotal: ${(totalIn/1024/1024).toFixed(2)} MB → ${(totalOut/1024/1024).toFixed(2)} MB  (-${totalPct}%)`);
})();
