// =============================================================================
//  dump_night_raw.wscript
//  ---------------------------------------------------------------------------
//  RAW EXPORT for the NC Zoning Board night-lighting rebuild.
//  NO AGGREGATION. NO CLASSIFYING. NO JUDGEMENT CALLS IN HERE.
//  Dump the facts; work out the patterns offline, where iterating is free.
//
//
//  WORK BACKWARDS FROM THE SHADERS — WINDOWS *AND* SIGNS
//  -----------------------------------------------------
//  Anything that lights up IS, by definition, something whose material chain roots at an
//  emitting shader, or which sets an emissive parameter. So RESOLVE THE CHAIN instead of
//  pattern-matching names. The chain is real, and was being guessed at:
//
//      cct_cpz_building_a_f_6m.mesh                     (a Corpo Plaza tower panel)
//        -> cct_cpz_building_a_a_1x1_h400_w300_mlt.mi   (district override)
//          -> prlx_mlt_office_01_1x1_h400_w300_a.mi     (style x use base)
//            -> window_parallax_interior.mt             (the shader)  <-- ROOT
//
//  WINDOWS root at:  window_parallax_interior.mt, window_interior_uv.mt (+ _proxy variants)
//  SIGNS  root at:   diode_sign.mt, emissive_control.mt, decal_emissive_*.mt,
//                    mesh_decal_emissive*.mt ... OR they use an ordinary shader and simply
//                    SET an emissive parameter (a neon sign's `neon_green_v1` is very likely
//                    multilayered.mt with an emissive layer).
//
//  This dissolves every signage problem the folder-based taxonomy could not solve:
//    * blank panels — backlit shopfront or painted board? The MATERIAL knows; the mesh
//      name never will. (The maintainer's Pierogi World sign is a NON-emissive one.)
//    * posters / streamers / frames are inert because their materials do not emit — not
//      because I put them in a list.
//    * signs built on generic meshes are caught regardless of what the mesh is called.
//    * sign COLOUR is an emissive parameter, not an inference from a material's name.
//
//  Every previous attempt guessed instead, and every guess was wrong:
//    * "a window is a mesh named *_window_*"  -> Corpo Plaza's bespoke glass towers read
//                                                as 4% glass. It is the MATERIAL, not the name.
//    * "the mesh's district prefix = its district" -> 59% of all architecture comes from
//                                                architecture\common\, placed EVERYWHERE.
//                                                Asset origin is not location.
//    * "the prefab path gives the district"   -> 65% of signs have no usable ref.
//    * "sign density = sign count"            -> a billboard is ~30 m2, a shopfront neon
//                                                ~2 m2. Weight by AREA.
//  Each cost a full re-scan. Hence: raw out, decide later.
//
//
//  OUTPUT — five files, joined on integer ids
//  ------------------------------------------
//   ncz_materials.csv  EVERY .mi in the game (9,472), resolved to its ROOT .mt, with EVERY
//                      night parameters it sets. This is the spine. A material is a window
//                      iff its root is a window .mt — no name-matching anywhere.
//                      Also carries: AmountTurnOffAtNight (the game's lit fraction — 0.5
//                      for every archetype), TintColorAtNight, LightsTempVariationAtNight,
//                      EmissiveEV, roomWidth/roomHeight (the real 3x4 m window cell).
//
//   ncz_assets.csv     every unique mesh placed in a sector -> the materials it references
//                      (chunk names + external .mi paths + local-buffer base materials).
//                      Join to ncz_materials to learn if it is glass, and in what style.
//
//   ncz_nodes.csv      ONE ROW PER PLACED NODE (~2-3M). CET world coords (the location pins
//                      already line up, so the transform is trusted), orientation, scale,
//                      BOUNDS (= size, which is how a billboard outweighs a shopfront neon),
//                      instance count, mesh appearance (`default_windows_off` = dark), and
//                      the prefab ref that groups parts into one sign / one building.
//
//   ncz_prefabs.csv    prefab-ref dictionary.  ncz_appearances.csv  appearance dictionary.
//   ncz_skipped.csv    sectors WolvenKit could not parse. Explicit — a skipped sector must
//                      never masquerade as an empty district.
//
//  LOD0 ONLY (LOD1+ is proxies: at LOD1 Kabuki appears to have zero ad nodes; at LOD0 it
//  has 16 in one cell). Sector paths DEDUPED — GetArchiveFiles() returns every archive copy,
//  which inflated an earlier run 2.4x, unevenly.
//
//  SET MAX_SECTORS = 50 FOR A SMOKE TEST FIRST.
// =============================================================================

import * as Logger from 'Logger.wscript';

// ===================== CONFIG =====================
const LOD         = 0;
const MAX_SECTORS = 0;      // 0 = all (~7,159). Set 50 to smoke-test.
const LOG_EVERY   = 250;
// ==================================================
//
// NO PARAMETER ALLOW-LIST. Capture EVERY scalar/colour a material sets, and decide what
// matters offline. An earlier version listed the window params it "knew" it wanted — which
// is the same mistake as name-matching, one level up. What makes a sign emissive is not one
// known field: it is EITHER its root shader (diode_sign.mt, *_emissive.mt, emissive_control.mt)
// OR an emissive parameter set on an ordinary shader (a neon sign's `neon_green_v1` is very
// likely multilayered.mt with an emissive layer). Capturing everything costs ~5 MB and
// removes the need to guess which.
//   Texture references are skipped — they are paths, not values, and would bloat the file.

const f2 = (v) => (typeof v === 'number' ? v.toFixed(2) : '');
const f3 = (v) => (typeof v === 'number' ? v.toFixed(3) : '');
const csv = (s) => '"' + String(s).replace(/"/g, "'") + '"';

// ---- PASS A: resolve EVERY material to its root .mt --------------------------
// 9,472 .mi files, 364 .mt. Small files, so this is cheap — and it is the only way to
// know what a material actually IS. Chains are short (mesh -> district .mi -> style .mi
// -> .mt) but we follow them properly, with a visited guard.
const matCache = {};   // path -> { root, chain, vals }

function readMaterial(path) {
    if (matCache[path]) return matCache[path];
    const out = { root: '', chain: [], vals: {} };
    try {
        const j = wkit.GetFileFromArchive(path, OpenAs.Json);
        if (j) {
            const rc = JSON.parse(j).Data.RootChunk;
            const base = rc.baseMaterial && rc.baseMaterial.DepotPath && rc.baseMaterial.DepotPath.$value;
            for (const v of (rc.values || [])) {
                for (const k in v) {
                    if (k === '$type') continue;
                    const val = v[k];
                    if (val === null || val === undefined) continue;
                    if (typeof val === 'number') out.vals[k] = val;
                    else if (typeof val === 'object') {
                        if (val.Red !== undefined) out.vals[k] = val.Red + ' ' + val.Green + ' ' + val.Blue + ' ' + val.Alpha;   // Color
                        else if (val.X !== undefined && val.DepotPath === undefined) out.vals[k] = val.X + ' ' + val.Y + ' ' + val.Z + (val.W !== undefined ? ' ' + val.W : '');  // Vector
                        // DepotPath (texture refs) deliberately skipped — paths, not values.
                    }
                }
            }
            if (base) {
                out.chain.push(base);
                if (base.toLowerCase().endsWith('.mt') || base.toLowerCase().endsWith('.remt')) {
                    out.root = base;
                } else {
                    const parent = readMaterial(base);              // recurse up the chain
                    out.root = parent.root || base;
                    out.chain = out.chain.concat(parent.chain);
                    // A child's own values OVERRIDE the parent's — so fill only what is unset.
                    for (const k in parent.vals) if (out.vals[k] === undefined) out.vals[k] = parent.vals[k];
                }
            }
        }
    } catch { /* unreadable — leave root blank; the row still records that it exists */ }
    matCache[path] = out;
    return out;
}

// `params` is every scalar/colour the material sets (its own values merged over its
// inherited ones), as key=value pairs. Everything downstream reads from here:
//   root_mt = window_parallax_interior.mt          -> the piece is a WINDOW
//   root_mt = diode_sign.mt / *_emissive.mt        -> the piece is a SIGN
//   params contains EmissiveEV / EmissiveColor > 0 -> it GLOWS, whatever its shader
//   params AmountTurnOffAtNight                    -> the game's lit fraction
//   params TintColorAtNight / LightColor           -> the colour it glows
const matRows = ['path,root_mt,chain,params'];
{
    const mis = [];
    const seenMi = {};
    for (const f of wkit.GetArchiveFiles()) {
        const name = (typeof f === 'string') ? f : (f.FileName ?? f.Name);
        if (!name || !name.toLowerCase().endsWith('.mi')) continue;
        const k = name.toLowerCase();
        if (seenMi[k]) continue;                 // archives carry duplicate copies
        seenMi[k] = 1;
        mis.push(name);
    }
    Logger.Info(`[ncz] PASS A: resolving ${mis.length} material instances to their root shader`);
    let a = 0;
    for (const p of mis) {
        const m = readMaterial(p);
        const kv = [];
        for (const k in m.vals) kv.push(k + '=' + m.vals[k]);
        matRows.push([csv(p), csv(m.root), csv(m.chain.join('|')), csv(kv.join('|'))].join(','));
        if (++a % 1000 === 0) Logger.Info(`[ncz] PASS A: ${a}/${mis.length}`);
    }
    Logger.Success(`[ncz] PASS A done — ${mis.length} materials resolved to root shaders`);
}

// ---- Dictionaries ------------------------------------------------------------
const assetId  = {};  let nextAsset  = 0;
const prefabId = {};  let nextPrefab = 0;
const appId    = {};  const appList  = [];

function prefabRef(o) {
    for (const k in o) {
        const v = o[k];
        if (v && typeof v === 'object' && v.$type === 'NodeRef'
            && typeof v.$value === 'string' && v.$value.length > 3) return v.$value;
    }
    return null;
}

// ---- Sector list (deduped; Z is part of the identity — the city stacks) -------
const seenPath = {};
const sectors = [];
for (const f of wkit.GetArchiveFiles()) {
    const name = (typeof f === 'string') ? f : (f.FileName ?? f.Name);
    if (!name || !name.endsWith('.streamingsector')) continue;
    if (name.indexOf('03_night_city') === -1) continue;
    const m = name.match(/exterior_(-?\d+)_(-?\d+)_(-?\d+)_(\d+)\.streamingsector$/);
    if (!m || parseInt(m[4], 10) !== LOD) continue;
    const key = name.toLowerCase();
    if (seenPath[key]) continue;
    seenPath[key] = 1;
    sectors.push({ path: name, tag: m[1] + '_' + m[2] + '_' + m[3] });
}
const limit = MAX_SECTORS > 0 ? Math.min(MAX_SECTORS, sectors.length) : sectors.length;
Logger.Info(`[ncz] ${sectors.length} LOD${LOD} sectors (deduped); dumping ${limit}`);

// ---- PASS B: every placed node, raw -------------------------------------------
const nodeRows = ['sector,type,asset,prefab,x,y,z,qi,qj,qk,qr,sx,sy,sz,bw,bh,bd,inst,app'];
const skipped = [];
let done = 0, emitted = 0;

for (let i = 0; i < limit; i++) {
    const s = sectors[i];
    if (++done % LOG_EVERY === 0) Logger.Info(`[ncz] PASS B: ${done}/${limit} sectors — ${emitted} nodes`);

    let raw;
    try { raw = wkit.GetFileFromArchive(s.path, OpenAs.Json); }
    catch { skipped.push(s.path); continue; }
    if (!raw) { skipped.push(s.path); continue; }
    let rc;
    try { rc = JSON.parse(raw).Data.RootChunk; }
    catch { skipped.push(s.path); continue; }

    const nodes = rc.nodes || [];
    const nd = (rc.nodeData && (rc.nodeData.Data || rc.nodeData)) || [];
    const byIndex = {};
    for (const o of nd) if (o && typeof o.NodeIndex === 'number') byIndex[o.NodeIndex] = o;

    for (let n = 0; n < nodes.length; n++) {
        const d = nodes[n].Data;
        if (!d) continue;
        const dp = (d.mesh && d.mesh.DepotPath && d.mesh.DepotPath.$value)
                || (d.material && d.material.DepotPath && d.material.DepotPath.$value) || '';
        const isLight = d.$type === 'worldStaticLightNode';
        if (!dp && !isLight) continue;   // collision / AI / audio nodes carry nothing we need

        const o = byIndex[n];
        const p = o && o.Position, q = o && o.Orientation, sc = o && o.Scale, bb = o && o.Bounds;
        const tb = d.worldTransformsBuffer;
        const inst = (tb && typeof tb.numElements === 'number' && tb.numElements > 0) ? tb.numElements : 1;

        let bw = '', bh = '', bd = '';
        if (bb && bb.Min && bb.Max) {
            bw = f2(bb.Max.X - bb.Min.X); bh = f2(bb.Max.Y - bb.Min.Y); bd = f2(bb.Max.Z - bb.Min.Z);
        }
        if (dp && assetId[dp] === undefined) assetId[dp] = nextAsset++;
        const ref = o ? prefabRef(o) : null;
        if (ref && prefabId[ref] === undefined) prefabId[ref] = nextPrefab++;
        const app = (d.meshAppearance && d.meshAppearance.$value) || '';
        if (app && appId[app] === undefined) { appId[app] = appList.length; appList.push(app); }

        nodeRows.push([
            s.tag,
            d.$type.replace('world', '').replace('Node', ''),
            dp ? assetId[dp] : '',
            ref ? prefabId[ref] : '',
            p ? f2(p.X) : '', p ? f2(p.Y) : '', p ? f2(p.Z) : '',
            q ? f3(q.i) : '', q ? f3(q.j) : '', q ? f3(q.k) : '', q ? f3(q.r) : '',
            sc ? f2(sc.X) : '', sc ? f2(sc.Y) : '', sc ? f2(sc.Z) : '',
            bw, bh, bd, inst,
            app ? appId[app] : '',
        ].join(','));
        emitted++;
    }
}
Logger.Info(`[ncz] PASS B done — ${emitted} nodes, ${nextAsset} unique assets, ${nextPrefab} unique prefabs`);

// ---- PASS C: unique meshes -> the materials they reference ---------------------
// Chunk-material NAMES, external .mi PATHS, and local-buffer BASE materials. Join these
// to ncz_materials.csv (PASS A) to learn whether a mesh carries glass — definitionally,
// by root shader, not by its name.
const assetRows = ['id,path,chunks,mat_names,mat_paths'];
{
    const paths = Object.keys(assetId);
    Logger.Info(`[ncz] PASS C: reading materials for ${paths.length} unique meshes`);
    let a = 0;
    for (const path of paths) {
        const names = [], refs = [];
        let chunks = 0;
        if (path.toLowerCase().endsWith('.mesh')) {
            try {
                const j = wkit.GetFileFromArchive(path, OpenAs.Json);
                if (j) {
                    const mrc = JSON.parse(j).Data.RootChunk;
                    for (const e of (mrc.materialEntries || [])) {
                        const nm = e.name && e.name.$value;
                        chunks++;
                        if (nm && names.indexOf(nm) === -1) names.push(nm);
                    }
                    for (const e of (mrc.externalMaterials || [])) {
                        const p = e && e.DepotPath && e.DepotPath.$value;
                        if (p && refs.indexOf(p) === -1) refs.push(p);
                    }
                    // Local materials name their OWN base (…_off.mi, multilayered.mt, …).
                    const lmb = mrc.localMaterialBuffer && mrc.localMaterialBuffer.materials;
                    for (const m of (lmb || [])) {
                        const dd = m.Data || m;
                        const b = dd.baseMaterial && dd.baseMaterial.DepotPath && dd.baseMaterial.DepotPath.$value;
                        if (b && refs.indexOf(b) === -1) refs.push(b);
                    }
                }
            } catch { /* leave blank — the node rows still stand */ }
        }
        assetRows.push([assetId[path], csv(path), chunks, csv(names.join('|')), csv(refs.join('|'))].join(','));
        if (++a % 500 === 0) Logger.Info(`[ncz] PASS C: ${a}/${paths.length}`);
    }
}

const prefabRows = ['id,ref'];
for (const ref in prefabId) prefabRows.push(`${prefabId[ref]},${csv(ref)}`);
const appRows = ['id,appearance'];
appList.forEach((a, i) => appRows.push(`${i},${csv(a)}`));

wkit.SaveToRaw('ncz_materials.csv',   matRows.join('\n'));
wkit.SaveToRaw('ncz_assets.csv',      assetRows.join('\n'));
wkit.SaveToRaw('ncz_nodes.csv',       nodeRows.join('\n'));
wkit.SaveToRaw('ncz_prefabs.csv',     prefabRows.join('\n'));
wkit.SaveToRaw('ncz_appearances.csv', appRows.join('\n'));
wkit.SaveToRaw('ncz_skipped.csv',     ['sector'].concat(skipped).join('\n'));

Logger.Success(`[ncz] ${done} sectors — ${emitted} nodes, ${nextAsset} meshes, ${nextPrefab} prefabs`);
if (skipped.length) Logger.Warning(`[ncz] ${skipped.length} sectors could NOT be parsed — see ncz_skipped.csv`);
Logger.Info('[ncz] wrote ncz_materials / ncz_assets / ncz_nodes / ncz_prefabs / ncz_appearances / ncz_skipped .csv');
