// uncook_lods.wscript — wolvenkit-mcp run_wscript, NOT the WolvenKit GUI
// ─────────────────────────────────────────────────────────────────────────────
// Re-export meshes with EVERY LOD in the glb, not just the highest.
//
// uncook_meshes.wscript calls `wkit.UncookMesh(p, RAW, false)` and stops there.
// The full signature is
//
//     UncookMesh(path[, outputDir, withMaterials, lodFilter, gltfBinary])
//
// and lodFilter defaults to LOD0 only, so every GLB on disk holds the game's
// highest detail and none of the levels beneath it. Measured over one
// building's 51-mesh kit: 26,143 triangles at LOD0, 8,819 at LOD1, 1,526 at
// LOD2. The map's camera never gets closer than 800 units, so LOD0 is detail
// nobody can see, paid for on every frame.
//
// Output goes to a SEPARATE root. The single-LOD export is what the current
// pipeline reads, and overwriting it mid-experiment would change the box cloud
// under a comparison that is meant to isolate one variable.
//
// The list comes from scripts/wkit/export_lods.js, which runs outside: the V8
// host cannot read the filesystem, so anything depending on what is on disk
// stays out there.
import { LOD_MESHES } from 'ncz_lod_meshes.wscript';

const OUT = 'd:\\Modding\\CP2077 Mods\\MyMods\\map_data_export\\source\\raw_alllod';
const BUDGET_MS = 1500 * 1000;   // inside the 1800 s hard timeout
const LOG_EVERY = 250;

const t0 = Date.now();
let ok = 0, failed = 0, taken = 0;
const firstErrors = [];

console.log(`[ncz] ${LOD_MESHES.length} meshes to re-uncook with every LOD -> ${OUT}`);

for (const p of LOD_MESHES) {
  if (Date.now() - t0 > BUDGET_MS) break;
  taken++;
  let r;
  // withMaterials false, lodFilter FALSE: the fourth argument is the point.
  try { r = JSON.parse(wkit.UncookMesh(p, OUT, false, false)); }
  catch (e) { r = { error: String(e) }; }
  if (r && r.files && r.files.length) ok++;
  else {
    failed++;
    if (firstErrors.length < 10) firstErrors.push(`${p} :: ${r && (r.error || JSON.stringify(r))}`);
  }
  if (taken % LOG_EVERY === 0) {
    const rate = taken / ((Date.now() - t0) / 60000);
    console.log(`[ncz] ${taken}/${LOD_MESHES.length}  ok ${ok}  failed ${failed}  ${rate.toFixed(0)}/min`);
  }
}

const mins = (Date.now() - t0) / 60000;
console.log(`[ncz] DONE: ${ok} written, ${failed} failed, ${taken} attempted of ${LOD_MESHES.length} in ${mins.toFixed(1)} min`);
for (const e of firstErrors) console.warn(`[ncz] fail: ${e}`);
