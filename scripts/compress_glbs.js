#!/usr/bin/env node
/**
 * Draco-compress every GLB in assets/glb/ → assets/glb-draco/.
 *
 * The KHR_draco_mesh_compression extension keeps the glTF container intact —
 * only the vertex/index buffers are replaced. three.js GLTFLoader handles both
 * forms transparently as long as DRACOLoader is attached. Toggle which folder
 * the runtime reads from via NCZ.GLB_DIR in assets/js/constants.js.
 *
 * Per-asset quantization is intentional: terrain/cliffs need higher position
 * precision to avoid faceting on long slopes; thin road/metro strips are
 * tolerant of lower precision; landmarks fall in between.
 */

const fs   = require('fs');
const path = require('path');
const gltfPipeline = require('gltf-pipeline');

const SRC = path.join(__dirname, '..', 'assets', 'glb');
const DST = path.join(__dirname, '..', 'assets', 'glb-draco');

// All meshes share CET world coordinates (~12 km extent), so bit-count is
// world-scale precision: positionBits=16 → ~0.18 m/step, 15 → ~0.37 m, 14 → ~0.73 m.
// Anything below 16 produces visible gaps at primitive seams. Landmarks live in
// local mesh space so they tolerate fewer bits.
const DEFAULT = { positionBits: 16, normalBits: 10, texcoordBits: 12, colorBits: 8, genericBits: 12 };
const PRESETS = {
  '3dmap_terrain.glb':       { ...DEFAULT, positionBits: 16 },
  '3dmap_cliffs.glb':        { ...DEFAULT, positionBits: 16 },
  '3dmap_water.glb':         { ...DEFAULT, positionBits: 16 },
  '3dmap_roads.glb':         { ...DEFAULT, positionBits: 16 },
  '3dmap_roads_borders.glb': { ...DEFAULT, positionBits: 16 },
  '3dmap_metro.glb':         { ...DEFAULT, positionBits: 16 },
};
const LANDMARK_DEFAULT = { ...DEFAULT, positionBits: 14 };

const COMPRESSION_LEVEL = 7;

async function compress(file) {
  const inPath  = path.join(SRC, file);
  const outPath = path.join(DST, file);
  const q = PRESETS[file] || LANDMARK_DEFAULT;

  const buf = fs.readFileSync(inPath);
  const inputSize = buf.length;

  const result = await gltfPipeline.processGlb(buf, {
    dracoOptions: {
      compressionLevel:        COMPRESSION_LEVEL,
      quantizePositionBits:    q.positionBits,
      quantizeNormalBits:      q.normalBits,
      quantizeTexcoordBits:    q.texcoordBits,
      quantizeColorBits:       q.colorBits,
      quantizeGenericBits:     q.genericBits,
      uncompressedFallback:    false,
      unifiedQuantization:     true,
    },
  });

  fs.writeFileSync(outPath, result.glb);
  const outputSize = result.glb.length;
  const pct = ((1 - outputSize / inputSize) * 100).toFixed(1);
  return { file, inputSize, outputSize, pct, q: q.positionBits };
}

(async () => {
  if (!fs.existsSync(DST)) fs.mkdirSync(DST, { recursive: true });

  const files = fs.readdirSync(SRC).filter(f => f.endsWith('.glb'));
  console.log(`Compressing ${files.length} GLBs from ${SRC}\n`);

  let totalIn = 0, totalOut = 0;
  for (const f of files) {
    try {
      const r = await compress(f);
      totalIn  += r.inputSize;
      totalOut += r.outputSize;
      console.log(`  ${(r.inputSize/1024).toFixed(0).padStart(6)} KB → ${(r.outputSize/1024).toFixed(0).padStart(5)} KB  (-${r.pct}%, posBits=${r.q})  ${r.file}`);
    } catch (err) {
      console.error(`  FAILED  ${f}:  ${err.message}`);
    }
  }

  const totalPct = ((1 - totalOut / totalIn) * 100).toFixed(1);
  console.log(`\nTotal: ${(totalIn/1024/1024).toFixed(2)} MB → ${(totalOut/1024/1024).toFixed(2)} MB  (-${totalPct}%)`);
})();
