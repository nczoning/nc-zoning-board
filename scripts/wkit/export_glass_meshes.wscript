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
const ARCH = /\\architecture\\|\\megabuilding\\|\\proxy\\/i;
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
for (const f of wkit.GetArchiveFiles()) {
    const name = (typeof f === 'string') ? f : (f.FileName ?? f.Name);
    if (name && name.endsWith('.mesh') && ARCH.test(name)) meshes.push(name);
}
Logger.Info(`[ncz] ${meshes.length} architecture meshes; resolving material chains…`);

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

// ---- extract into the project, then export ------------------------------------
let added = 0, addFail = 0;
for (let i = 0; i < glass.length; i++) {
    if (i % 200 === 0) Logger.Info(`[ncz] extracting to project ${i}/${glass.length}…`);
    try { wkit.Extract(glass[i]); added++; }
    catch (e) { addFail++; if (addFail <= 3) Logger.Error(`[ncz] Extract failed: ${glass[i]} — ${e}`); }
}
Logger.Info(`[ncz] extracted ${added}/${glass.length} into the project` + (addFail ? `, ${addFail} FAILED` : ''));

Logger.Info('[ncz] exporting to GLB…');
try { wkit.ExportFiles(glass); }
catch (e) { Logger.Error(`[ncz] ExportFiles threw: ${e}`); }

// ---- THE ONLY HONEST CHECK: DID THE FILE APPEAR? ------------------------------
// Not the return value. Not "none failed". The log has lied about this twice.
let wrote = 0;
const missing = [];
for (const p of glass) {
    const glb = p.replace(/\.mesh$/i, '.glb');
    let ok = false;
    try { ok = wkit.FileExistsInRaw(glb); } catch { ok = false; }
    if (ok) wrote++; else if (missing.length < 5) missing.push(glb);
}
if (wrote === glass.length) {
    Logger.Success(`[ncz] VERIFIED ON DISK: ${wrote}/${glass.length} .glb files exist.`);
} else {
    Logger.Error(`[ncz] ONLY ${wrote}/${glass.length} .glb FILES EXIST — ${glass.length - wrote} MISSING.`);
    for (const m of missing) Logger.Error(`[ncz]   missing: ${m}`);
}
Logger.Info('[ncz] then: node scripts/window_geom.js --bake');
