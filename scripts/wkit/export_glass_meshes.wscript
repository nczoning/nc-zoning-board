// export_glass_meshes.wscript — WolvenKit
// ─────────────────────────────────────────────────────────────────────────────
// EXTRACT, THEN EXPORT, THEN CHECK THE FILE. Every possibly-glass architecture mesh -> GLB.
//
// WHY GLB. A window is not an object and it is not a whole panel — it is a SUBMESH.
// `cct_cpz_building_a_b_6m_window` is one 6 x 8 m facade piece holding TWO submeshes:
//
//     submesh_00   194 verts   6.00 x 8.00 x 0.24 m   the CONCRETE  (thick)
//     submesh_01    16 verts   5.16 x 6.81 x 0.00 m   the GLASS     (flat — 4 window strips)
//
// The GLB carries each submesh's exact geometry; `<mesh>.Material.json` -> `Appearances` maps
// chunk -> material name; and `submesh_NN` indexes `chunkMaterials[N]` (verified on 3 meshes
// from 3 kits — world-asset-reference §5). Lighting the WHOLE panel is 3-4x too much glass,
// and it is why the night city reads wrong.
//
// ─── OVER-INCLUDE, DELIBERATELY ───────────────────────────────────────────────
// A mesh with no glass submesh simply contributes no windows downstream — a false positive
// costs one GLB on disk. A false NEGATIVE costs a building its windows and is invisible.
//
// So the test is deliberately GENEROUS, and it is applied three ways because each one alone
// has already been caught missing meshes:
//
//   1. any material NAME containing "window" or "glass"        (broad on purpose)
//   2. the resolved root .mt of any LOCAL material instance    (localMaterialBuffer AND
//      localMaterialInstances — the first version only read one of them)
//   3. the resolved root .mt of any EXTERNAL .mi
//
// History: a name-only regex found 721. Adding the .mi -> .mt chain found 798. The CSV's own
// resolved chain finds 1,232 — so BOTH were still missing meshes. Names are not a classifier
// (world-asset-reference §4); `glass_windows` matches no window pattern and only its root
// template gives it away.
//
// ─── AND CHECK THE FILE ───────────────────────────────────────────────────────
// `wkit.ExportFiles()` works on PROJECT files. Handed an archive path it logs
// "…doesn't exists in the project. Skipping" — and a skip is not a throw, so a try/catch sees
// nothing. The first run "exported" 721 meshes in 74 ms and wrote ZERO files, reporting
// "none failed". `wkit.FileExistsInRaw` was on the API the whole time. Use it. The artefact is
// the evidence; the return value is not.
import * as Logger from 'Logger.wscript';

// ARCHITECTURE **AND PROXIES**.
//
// A proxy is the low-detail, whole-building stand-in the game streams from a distance. It lives at
// `worlds\03_night_city\sectors\_external\proxy\<hash>\<name>.mesh` — no `architecture` in the
// path — so the old regex threw every one of them away.
//
// That is not a corner case. Arasaka Waterfront has TWELVE identical towers: nine are built from
// ~2,400 kit pieces, and THREE ship as a single GenericProxyMesh, because you cannot get close
// enough to them for the difference to show. They are real buildings and they render DARK on our
// map. City-wide, 22,984 placed proxy copies carry window materials and 7,016 are over 20 m tall
// — Corpo Plaza towers, Japantown, Arasaka Waterfront.
//
// The proxy for `wat_nid_building_a_v38` declares materials `Windows_0/1/4/5` and a
// 20 x 53 x 164 m bounding box. It IS the tower, windows and all.
//
// NOTE for the consumer, not for this script: most buildings ship with BOTH a detailed version
// and a proxy, and the sector data contains both. Exporting a proxy's GLB is free; COUNTING it on
// top of the detailed geometry would double every glazed building in Night City. The
// proxy-vs-detail choice is a PLACEMENT-level, spatial decision and it is made downstream.
// Exporting over-includes on purpose — same as the glass filter below.
//
// AND `\proxy\` ON ITS OWN IS TOO BROAD — IT MATCHES CARS. Measured 2026-07-14: a bare
// `\\proxy\\` alternation also matches `vehicles\appearances\standard\proxy\<car>\<car>.mesh`.
// A windscreen is glass, so every vehicle proxy in the game sails through the glass test below
// and gets exported — and its glass is then waiting to be counted as building windows.
//
// The building proxies live at exactly ONE place. Anchor to it, and say so:
//     worlds\<world>\sectors\_external\proxy\<hash>\<name>.mesh
// Same failure as every other one on this project: a regex on a PATH that quietly over-matches
// and returns a plausible number. (world-asset-reference §12)
const ARCH = /\\architecture\\|\\megabuilding\\|\\sectors\\_external\\proxy\\/i;
// Belt and braces: whatever ARCH lets through, a vehicle is never a building.
const NOT_A_BUILDING = /\\vehicles\\/i;
// Don't re-export a mesh whose .glb is already on disk. The previous run left 2,257 valid GLBs
// and re-exporting them is ~42% of this run's work for zero new data — and it is NOT free: a
// mesh export uncooks its whole material stack (~5.5 mask-layer PNGs each) into the Depot.
// Set false to force a full re-export (e.g. after a game patch).
const SKIP_EXISTING = true;
// Root .mt templates that ARE glass. Applied to the RESOLVED template, never to a name.
const GLASS_MT = /window_parallax_interior|window_interior_uv|glass_onesided|(^|\\)glass\.mt/i;
// Material NAMES. Deliberately broad — a false positive is one wasted GLB; a false negative is
// a dark building nobody notices.
const GLASS_NAME = /window|glass/i;

const api = [];
for (const k in wkit) if (typeof wkit[k] === 'function') api.push(k);
Logger.Info(`[ncz] wkit API (${api.length} members)`);

// ---- resolve a material path to its ROOT .mt (an .mi chains to an .mi chains to an .mt) ----
const rootCache = {};
function rootTemplate(path, depth) {
    if (!path) return '';
    if (rootCache[path] !== undefined) return rootCache[path];
    if (depth > 8 || /\.mt$/i.test(path)) return (rootCache[path] = path);
    let rc;
    try { rc = JSON.parse(wkit.GetFileFromArchive(path, OpenAs.Json)).Data.RootChunk; }
    catch { return (rootCache[path] = path); }
    const base = rc && rc.baseMaterial && rc.baseMaterial.DepotPath && rc.baseMaterial.DepotPath.$value;
    return (rootCache[path] = base ? rootTemplate(base, depth + 1) : path);
}

function isGlassMesh(rc) {
    // 1. NAMES — broad.
    for (const m of (rc.materialEntries || [])) {
        const d = m.Data || m;
        const n = d.name && d.name.$value;
        if (n && GLASS_NAME.test(n)) return true;
    }
    // 2. LOCAL material instances. BOTH containers — a CMesh may use either, and reading only
    //    one is what lost ~434 meshes on the previous run.
    const locals = []
        .concat(rc.localMaterialInstances || [])
        .concat((rc.localMaterialBuffer && rc.localMaterialBuffer.materials) || []);
    for (const li of locals) {
        const d = li.Data || li;
        const bm = d.baseMaterial && d.baseMaterial.DepotPath && d.baseMaterial.DepotPath.$value;
        if (bm && GLASS_MT.test(rootTemplate(bm, 0))) return true;
    }
    // 3. EXTERNAL .mi materials.
    for (const em of (rc.externalMaterials || [])) {
        const p = em.DepotPath && em.DepotPath.$value;
        if (p && GLASS_MT.test(rootTemplate(p, 0))) return true;
    }
    return false;
}

// ---- which meshes? -----------------------------------------------------------
const meshes = [];
let rejectedNotBuilding = 0;
for (const f of wkit.GetArchiveFiles()) {
    const name = (typeof f === 'string') ? f : (f.FileName ?? f.Name);
    if (!name || !name.endsWith('.mesh')) continue;
    if (!ARCH.test(name)) continue;
    // COUNT what you throw away. A bare `continue` is how 2,356 quest sectors and 803 cars both
    // hid — the filter that drops them silently is indistinguishable from one that finds nothing.
    if (NOT_A_BUILDING.test(name)) { rejectedNotBuilding++; continue; }
    meshes.push(name);
}
Logger.Info(`[ncz] ${meshes.length} architecture + building-proxy meshes`
    + (rejectedNotBuilding ? `  (rejected ${rejectedNotBuilding} vehicle/3dmap meshes)` : '')
    + '; resolving material chains…');

const glass = [];
let checked = 0;
for (const path of meshes) {
    if (++checked % 2000 === 0) Logger.Info(`[ncz] checked ${checked}/${meshes.length} — ${glass.length} glass so far`);
    let rc;
    try { rc = JSON.parse(wkit.GetFileFromArchive(path, OpenAs.Json)).Data.RootChunk; } catch { continue; }
    if (rc && isGlassMesh(rc)) glass.push(path);
}
Logger.Success(`[ncz] ${glass.length} POSSIBLY-GLASS architecture meshes (name OR resolved .mt chain)`);
if (glass.length < 1200) {
    Logger.Warning(`[ncz] ${glass.length} is LOW — ncz_assets.csv's resolved chain finds 1,232. Something is still missing. Do NOT assume the export is complete.`);
}

// ---- what actually needs exporting? -------------------------------------------
// An export is NOT cheap: each mesh uncooks its whole material stack into the Depot (~5.5
// mask-layer PNGs), and that — not the mesh — is where the time goes. Measured 2026-07-14:
// 114 GLBs came with 624 PNGs, and the run was moving at 9 meshes/min against the ~100/min
// this API manages when the materials are already in the Depot.
//
// So skip the ones already on disk. The GLB library is CUMULATIVE across runs.
const todo = [];
let already = 0;
for (const p of glass) {
    if (SKIP_EXISTING) {
        let have = false;
        try { have = wkit.FileExistsInRaw(p.replace(/\.mesh$/i, '.glb')); } catch { have = false; }
        if (have) { already++; continue; }
    }
    todo.push(p);
}
Logger.Info(`[ncz] ${already} already exported (skipping); ${todo.length} to export`);
if (!todo.length) {
    Logger.Success('[ncz] nothing to do — the GLB library is already complete.');
} else {

// ---- extract into the project, then export ------------------------------------
let added = 0, addFail = 0;
for (let i = 0; i < todo.length; i++) {
    if (i % 200 === 0) Logger.Info(`[ncz] extracting to project ${i}/${todo.length}…`);
    try { wkit.Extract(todo[i]); added++; }
    catch (e) { addFail++; if (addFail <= 3) Logger.Error(`[ncz] Extract failed: ${todo[i]} — ${e}`); }
}
Logger.Info(`[ncz] extracted ${added}/${todo.length} into the project` + (addFail ? `, ${addFail} FAILED` : ''));

Logger.Info(`[ncz] exporting ${todo.length} meshes to GLB…`);
try { wkit.ExportFiles(todo); }
catch (e) { Logger.Error(`[ncz] ExportFiles threw: ${e}`); }
}

// ---- THIS SCRIPT CANNOT VERIFY ITS OWN EXPORT. SAY SO. -------------------------
// `ExportFiles` is ASYNC. It returns before it has written anything, and a wscript cannot sleep.
// The previous version ran `FileExistsInRaw` here and reported
//     ONLY 798/2257 .glb FILES EXIST — 1459 MISSING
// 0.9 seconds in. Nothing was wrong; the count settled at 2,268 twenty-five minutes later. Then
// it did it AGAIN tonight (2257/5429). A check that fires before the thing it checks has happened
// is not a check — it is a second bug wearing the first one's clothes.
//
// "Look at the artefact, not the return value" is necessary and NOT sufficient. An artefact
// written asynchronously is a moving target, and a partial read of one is indistinguishable from
// a failure. So: print the TARGET, and verify from OUTSIDE once the count has stopped moving.
Logger.Success(`[ncz] EXPORT DISPATCHED: ${todo.length} meshes  (${already} already on disk; ${glass.length} in the glass set)`);
Logger.Warning('[ncz] ExportFiles is ASYNCHRONOUS — it has almost certainly written NOTHING yet.');
Logger.Warning('[ncz] Do NOT trust any file count until it has STOPPED CHANGING. Verify from outside:');
Logger.Info('[ncz]   node scripts/wkit/check_export.js        <- polls until settled, then reports');
Logger.Info(`[ncz]   expect ${glass.length} .glb under source\\raw when it is done`);
Logger.Info('[ncz] then: node scripts/rebuild_night_data.js');
