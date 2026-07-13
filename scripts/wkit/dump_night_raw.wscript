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
//  INSTANCED COPIES HAVE EXACT POSITIONS — see ncz_instances.csv.
//  The old "an InstancedMesh node's transforms live in a buffer WolvenKit will not expand"
//  is FALSE. It was inherited, never tested, and it cost us the position of 2,172,830
//  placed instances (54% of the city, incl. 139,613 window panes), which were being binned
//  at their sector's centre (+-32 m) instead. WolvenKit expands the buffer fully — but it
//  takes TWO reads, and missing either one looks like "the data isn't there":
//
//      worldTransformsBuffer.startIndex     <- where this node's slice begins
//                           .numElements    <- how long it is
//                           .sharedDataBuffer
//                                { HandleId: "491", Data: {...} }   <- the OWNER node
//                                { HandleRefId: "491" }             <- EVERY OTHER NODE
//
//  A handle's payload is serialised EXACTLY ONCE, on the first node that references it.
//  Read `sharedDataBuffer.Data` per-node and you find a pool on ~1% of nodes and conclude
//  the rest are empty (measured: 21,127 found, 2,149,687 "missing"). So resolve the
//  sector's HandleId -> pool table first, then let HandleRefId nodes index into it.
//  The pool is SECTOR-SHARED and the slices are contiguous, so without startIndex every
//  node also appears to own the same few thousand transforms. Both reads, or nothing.
//  Verified against exterior_0_-34_0_0 on 2026-07-13.
//
//  OBJECT SIZE COMES FROM ncz_assets.csv (bbx0..bbz1), NOT from the node's Bounds.
//  The node `Bounds` field is populated on only 1.9% of placed nodes (0.0% of
//  InstancedMesh, 4.7% of StaticMesh) and is NEGATIVE on another 15%. It is kept
//  because it costs nothing and is correct where present, but anything that needs an
//  object's size must join to the ASSET's bounding box, which is exact and universal.
//  Measured 2026-07-13, after a 2%-sample size estimate silently swung the district
//  glass shares by 2x.
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
// -1 = EVERY streaming level (the correct setting — a tower lives in level 4 or 6, a prop in
// level 0; filtering to one level reads only objects of one SIZE). Set 0..6 to isolate one.
const LOD         = -1;
const MAX_SECTORS = 0;      // 0 = all (~15,119 across all levels). Set 50 to smoke-test.
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

// ---- Sector list — EVERY STREAMING LEVEL, NOT JUST LEVEL 0 --------------------
//
// THE FILTER THAT COST US THE CITY'S BUILDINGS.
//
// `exterior_X_Y_Z_L.streamingsector` — the trailing L is NOT a level of detail. It is the
// STREAMING LEVEL, and it sets the sector's CELL SIZE. Cyberpunk files each object into the
// level whose cell is big enough to contain it:
//
//     level 0   64 m cells   ->  props, street kit, small facade panels
//     level 1-2              ->  houses, mid-rise
//     level 3-6              ->  MEGABUILDINGS AND TOWERS
//
// Read it off the grid indices and it is obvious in hindsight: a level-0 sector is
// `exterior_-62_39_0_0` (small cells, big indices); a Corpo Plaza tower lives in
// `exterior_-1_-1_0_6` (huge cells, tiny indices). Verified in-game with World Inspector —
// every tall building sampled sits in level 2, 3, 4 or 6. NOT ONE was in level 0.
//
// This extractor filtered to `L === 0` and therefore read Night City's SMALL OBJECTS and
// none of its LARGE BUILDINGS. It is why Corpo Plaza's window panels stopped dead at 153 m
// while the towers are 300 m+, why the whole city measured a scarcely-credible 996k m2 of
// glass, and why every tall building rendered dark.
//
// 6,517 level-0 sectors were read. There are 15,119.
//
// The Z index stays part of the sector tag (the city stacks), but the tag is now only a
// label — positions come from the node transforms, which are exact at every level.
const seenPath = {};
const sectors = [];
const byLevel = {};
for (const f of wkit.GetArchiveFiles()) {
    const name = (typeof f === 'string') ? f : (f.FileName ?? f.Name);
    if (!name || !name.endsWith('.streamingsector')) continue;
    if (name.indexOf('03_night_city') === -1) continue;
    const m = name.match(/exterior_(-?\d+)_(-?\d+)_(-?\d+)_(\d+)\.streamingsector$/);
    if (!m) continue;
    const lvl = parseInt(m[4], 10);
    if (LOD >= 0 && lvl !== LOD) continue;   // LOD = -1 (the default now) means ALL LEVELS
    const key = name.toLowerCase();
    if (seenPath[key]) continue;
    seenPath[key] = 1;
    byLevel[lvl] = (byLevel[lvl] || 0) + 1;
    sectors.push({ path: name, tag: m[1] + '_' + m[2] + '_' + m[3] + '_L' + lvl });
}
const limit = MAX_SECTORS > 0 ? Math.min(MAX_SECTORS, sectors.length) : sectors.length;
Logger.Info(`[ncz] ${sectors.length} exterior sectors (deduped); dumping ${limit}`);
Logger.Info('[ncz] by streaming level: ' + Object.keys(byLevel).sort((a, b) => a - b)
    .map((l) => `L${l}=${byLevel[l]}`).join('  '));

// ---- PASS B: every placed node, raw -------------------------------------------
const nodeRows = ['sector,type,asset,prefab,x,y,z,qi,qj,qk,qr,sx,sy,sz,bw,bh,bd,inst,app'];

// EVERY INSTANCED COPY, WITH ITS REAL TRANSFORM.
//
// The long-standing "known limitation" — that an InstancedMesh node has no position and
// its per-copy transforms live in a buffer WolvenKit will not expand — IS FALSE. It was
// inherited, never tested, and it shaped the whole night model: 2,172,830 placed instances
// (54% of everything in Night City, and 139,613 of its window panes) were being binned at
// their sector's CENTRE, +-32 m, because of it.
//
// WolvenKit expands the buffer completely. The transforms were two properties deeper:
//
//   node.worldTransformsBuffer
//     .startIndex        <- WHERE this node's slice begins   (the part nobody read)
//     .numElements       <- how long it is                   (the part we did read)
//     .sharedDataBuffer  <- a HANDLE into the SECTOR's shared pool
//         { translation:{X,Y,Z}, rotation:{i,j,k,r}, scale:{X,Y,Z} }
//
// The pool is shared across the sector and the slices are contiguous — node A at
// startIndex 717 x96, node B at 813 x3, node C at 816 x24. Read it as
// Transforms[startIndex .. startIndex + numElements - 1].
//
// AND THE HANDLE IS THE SECOND HALF OF THE TRICK. `sharedDataBuffer` carries its `Data`
// on exactly ONE node — the handle's owner ({HandleId, Data}). Every other node that
// shares the pool holds only {HandleRefId}, a pointer with no payload. Chasing
// `sharedDataBuffer.Data` node-by-node therefore recovers ~1% of copies and makes the
// other 99% look absent, which is a very convincing way to re-derive a limitation that
// does not exist. Resolve HandleId -> pool for the sector, then index by startIndex.
//
// ONE ROW PER PLACED COPY — *EVERY* COPY, INSTANCED OR NOT.
//
// This file is the answer to "where is everything", and it is deliberately COMPLETE, so
// that answering that question can never again require a union of two files. An earlier
// draft emitted only instanced copies, which made the contract:
//
//     "instanced copies are in ncz_instances.csv; the ones that were never instanced are
//      in ncz_nodes.csv with inst==1 and their transform on the node — and if you forget
//      the second half you silently lose 17,849 window panes (11% of the city's glass)"
//
// That is a rule that lives in somebody's head, and the entire history of this extractor is
// data quietly going missing because a rule like that was forgotten. So: single node or
// instanced copy, it gets a row, and `src` says which it was. Read ONE file, get the city.
//
//     src = i   a copy out of the sector's shared transform pool  (was: inst > 1)
//     src = n   a node placed once, transform on the node itself  (was: inst == 1)
//
// Not "what fraction of this district is glass" but "this pane of glass is at exactly
// (x, y, z), facing that way, and it belongs to that building".
const instRows = ['sector,src,type,asset,prefab,x,y,z,qi,qj,qk,qr,sx,sy,sz,app'];

const skipped = [];
let done = 0, emitted = 0, instEmitted = 0, instMissing = 0, singleEmitted = 0, noPlace = 0, poolNodes = 0;

// ---- CHUNKED FLUSH — or the process dies before it writes anything ------------
//
// This script used to hold EVERY output row in memory as a string and join it at the end.
// At 7,159 level-0 sectors that was already a 274 MB ncz_nodes.csv. Reading all 16,208
// sectors (every streaming level — see the sector list above) roughly doubles it, and adds a
// ~2.2M-row instances table on top. WolvenKit ran out of memory and took the whole 20-minute
// run with it.
//
// So write PART FILES as we go and drop the rows. Memory stays flat regardless of how many
// sectors there are, and a crash costs you one chunk instead of the entire run.
//
// Merge them afterwards with:  node scripts/merge_dump_parts.js
const FLUSH_EVERY = 2000;   // sectors
let partNo = 0;
function flushChunk() {
    // Row 0 of each array is its header; keep it, drop everything else.
    wkit.SaveToRaw(`ncz_nodes_p${partNo}.csv`,     nodeRows.join('\n'));
    wkit.SaveToRaw(`ncz_instances_p${partNo}.csv`, instRows.join('\n'));
    Logger.Info(`[ncz] flushed part ${partNo} — ${nodeRows.length - 1} nodes, ${instRows.length - 1} placements`);
    nodeRows.length = 1;
    instRows.length = 1;
    partNo++;
}

for (let i = 0; i < limit; i++) {
    const s = sectors[i];
    if (++done % LOG_EVERY === 0) Logger.Info(`[ncz] PASS B: ${done}/${limit} sectors — ${emitted} nodes`);
    if (done % FLUSH_EVERY === 0) flushChunk();   // keep memory flat; see FLUSH_EVERY above

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

    // ── THE SECTOR'S SHARED TRANSFORM POOLS ───────────────────────────────────
    // `sharedDataBuffer` is a HANDLE, and WolvenKit serialises a handle's payload EXACTLY
    // ONCE — on the first node that references it. That node gets
    //
    //     sharedDataBuffer: { HandleId: "491", Data: { ...202 Transforms... } }
    //
    // and every other node referencing the same buffer gets a bare POINTER:
    //
    //     sharedDataBuffer: { HandleRefId: "491" }        <- no Data. None.
    //
    // Reading the pool off each node in isolation therefore finds it on the ~1% of nodes
    // that happen to OWN their handle, and reports the other 99% as "missing their slice".
    // (Measured: 21,127 copies recovered, 2,149,687 missing. The shape is not subtle once
    // you look — one node with `Data+HandleId`, fifty-four with `HandleRefId`.)
    //
    // So resolve the handles for the whole sector FIRST, then let every node index into
    // the pool it points at. `startIndex` was never the problem — it was right all along.
    const pools = {};
    for (let n = 0; n < nodes.length; n++) {
        const dd = nodes[n].Data;
        const sdb = dd && dd.worldTransformsBuffer && dd.worldTransformsBuffer.sharedDataBuffer;
        if (!sdb || !sdb.HandleId) continue;
        const T = sdb.Data && sdb.Data.buffer && sdb.Data.buffer.Data
               && sdb.Data.buffer.Data.Transforms;
        if (T) pools[sdb.HandleId] = T;
    }

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

        // ── THE INSTANCED COPIES ──────────────────────────────────────────────
        // Walk the shared pool and emit one row per real copy. `startIndex` is the field
        // the old code never touched; without it the pool looks like the same 2,086
        // transforms repeated on every node, and with it each node takes its own slice.
        const nType = d.$type.replace('world', '').replace('Node', '');

        // A node's transform is in the POOL if it has a transforms buffer at all — and that
        // includes buffers holding a SINGLE element. The old guard was `inst > 1`, which
        // dropped exactly 2,016 nodes whose buffer has numElements == 1: excluded from this
        // file for not being "instanced", and useless in ncz_nodes.csv because an instanced
        // node's own Position is (0,0,0). Placed, real, and invisible in both files. `tb`
        // is the question — "is it instanced" never was.
        if (tb) {
            poolNodes++;
            // Follow the handle. The node either OWNS the pool (HandleId) or POINTS at
            // one (HandleRefId) — both resolve through the sector table built above.
            const sdb = tb.sharedDataBuffer;
            const hid = sdb && (sdb.HandleId || sdb.HandleRefId);
            const pool = hid ? pools[hid] : null;
            const start = (typeof tb.startIndex === 'number') ? tb.startIndex : 0;
            if (pool && pool.length >= start + inst) {
                for (let k = 0; k < inst; k++) {
                    const t = pool[start + k];
                    // A null slot is a copy we cannot place. COUNT it — do not `continue`
                    // past it. Every hole in this extractor's history was a quiet `continue`.
                    if (!t) { instMissing++; continue; }
                    const tp = t.translation, tq = t.rotation, ts = t.scale;
                    instRows.push([
                        s.tag, 'i', nType,
                        dp ? assetId[dp] : '',
                        ref ? prefabId[ref] : '',
                        tp ? f2(tp.X) : '', tp ? f2(tp.Y) : '', tp ? f2(tp.Z) : '',
                        tq ? f3(tq.i) : '', tq ? f3(tq.j) : '', tq ? f3(tq.k) : '', tq ? f3(tq.r) : '',
                        ts ? f3(ts.X) : '', ts ? f3(ts.Y) : '', ts ? f3(ts.Z) : '',
                        app ? appId[app] : '',
                    ].join(','));
                    instEmitted++;
                }
            } else {
                // Say it out loud. A silently-missing slice is how the last hole survived.
                instMissing += inst;
            }
        } else if (p && (p.X !== 0 || p.Y !== 0 || p.Z !== 0)) {
            // NOT instanced: placed once, transform on the node itself. It belongs in this
            // file too. Emitting only pool-backed copies is what forced every consumer to
            // union two files and remember which half held what — and forgetting the second
            // half silently costs 17,849 window panes, 11% of the city's glass.
            instRows.push([
                s.tag, 'n', nType,
                dp ? assetId[dp] : '',
                ref ? prefabId[ref] : '',
                f2(p.X), f2(p.Y), f2(p.Z),
                q ? f3(q.i) : '', q ? f3(q.j) : '', q ? f3(q.k) : '', q ? f3(q.r) : '',
                sc ? f3(sc.X) : '', sc ? f3(sc.Y) : '', sc ? f3(sc.Z) : '',
                app ? appId[app] : '',
            ].join(','));
            singleEmitted++;
        } else {
            // No buffer AND no position. Not placeable. Counted, never dropped.
            noPlace++;
        }

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
// THE PLACEMENT LEDGER, and it balances at NODE level — not copy level, because one
// pool-backed node emits many copies and the two counts are not the same currency.
// Every node this pass accepted is in exactly one of three buckets. If they stop adding
// up to `emitted`, data is going quietly missing, which is the one failure this extractor
// is not allowed to have.
const ledger = poolNodes + singleEmitted + noPlace;
Logger.Info(`[ncz] PASS B: ${instEmitted} POOL COPIES from ${poolNodes} nodes, + ${singleEmitted} single placements = ${instEmitted + singleEmitted} PLACED COPIES`);
Logger.Info(`[ncz] PASS B: ${noPlace} nodes with no transform at all` + (instMissing ? `, ${instMissing} COPIES MISSING their slice` : ', no copies missing'));
Logger.Info(`[ncz] PASS B: LEDGER ${poolNodes} + ${singleEmitted} + ${noPlace} = ${ledger} vs ${emitted} nodes — ` + (ledger === emitted ? 'BALANCED' : `OFF BY ${emitted - ledger}, INVESTIGATE`));

// ---- PASS C: unique meshes -> the materials they reference ---------------------
// Chunk-material NAMES, external .mi PATHS, and local-buffer BASE materials. Join these
// to ncz_materials.csv (PASS A) to learn whether a mesh carries glass — definitionally,
// by root shader, not by its name.
// THE MESH'S OWN BOUNDING BOX — and this is the fix for the whole size story.
//
// PASS B writes each NODE's `Bounds`, and that field is a lie of omission: it is
// populated on 1.9% of placed nodes and ZERO on 82.7% of them (InstancedMesh: 0.0%,
// StaticMesh: 4.7%). Everything downstream that needed an object's SIZE — the
// area-weighted glass share, the panel/roof orientation split, the .dds alignment test
// — was therefore learned from a 2% sample that nobody had checked was a sample. It
// swung the measured glass shares by 2x when a single filter changed, which is what
// finally gave it away.
//
// A mesh knows its own size. `boundingBox` is on the CMesh itself — exact, LOCAL, and
// present for every asset — and PASS C is ALREADY opening every mesh file to read its
// materials, so this costs no extra I/O at all. Six columns, one re-scan, and the
// object-size problem is simply gone: area from the box, orientation from its thin
// axis, world footprint from box x node scale x node quaternion.
//
// Keep the node Bounds columns in PASS B (they cost nothing and are right when present),
// but the ASSET box is the source of truth. Prefer it.
const assetRows = ['id,path,chunks,bbx0,bby0,bbz0,bbx1,bby1,bbz1,mat_names,mat_paths'];
{
    const paths = Object.keys(assetId);
    Logger.Info(`[ncz] PASS C: reading materials + bounding boxes for ${paths.length} unique meshes`);
    let a = 0, boxed = 0;
    for (const path of paths) {
        const names = [], refs = [];
        let chunks = 0;
        let bb = ['', '', '', '', '', ''];
        if (path.toLowerCase().endsWith('.mesh')) {
            try {
                const j = wkit.GetFileFromArchive(path, OpenAs.Json);
                if (j) {
                    const mrc = JSON.parse(j).Data.RootChunk;
                    const box = mrc.boundingBox;
                    if (box && box.Min && box.Max) {
                        bb = [f2(box.Min.X), f2(box.Min.Y), f2(box.Min.Z),
                              f2(box.Max.X), f2(box.Max.Y), f2(box.Max.Z)];
                        boxed++;
                    }
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
        assetRows.push([assetId[path], csv(path), chunks, bb.join(','), csv(names.join('|')), csv(refs.join('|'))].join(','));
        if (++a % 500 === 0) Logger.Info(`[ncz] PASS C: ${a}/${paths.length}`);
    }
    // Say the coverage OUT LOUD. The whole reason the node-Bounds hole went unnoticed for
    // so long is that nothing ever printed how much of it was actually there.
    Logger.Info(`[ncz] PASS C done — ${boxed}/${paths.length} meshes have a bounding box (${(100 * boxed / paths.length).toFixed(1)}%)`);
}

const prefabRows = ['id,ref'];
for (const ref in prefabId) prefabRows.push(`${prefabId[ref]},${csv(ref)}`);
const appRows = ['id,appearance'];
appList.forEach((a, i) => appRows.push(`${i},${csv(a)}`));

wkit.SaveToRaw('ncz_materials.csv',   matRows.join('\n'));
wkit.SaveToRaw('ncz_assets.csv',      assetRows.join('\n'));
wkit.SaveToRaw('ncz_prefabs.csv',     prefabRows.join('\n'));
wkit.SaveToRaw('ncz_appearances.csv', appRows.join('\n'));
wkit.SaveToRaw('ncz_skipped.csv',     ['sector'].concat(skipped).join('\n'));

// The last, partial chunk. ncz_nodes.csv / ncz_instances.csv are NOT written here — they are
// assembled from the part files, because holding them whole is what killed the process.
flushChunk();
Logger.Info(`[ncz] wrote ${partNo} part files. NOW RUN:  node scripts/merge_dump_parts.js`);

Logger.Success(`[ncz] ${done} sectors — ${emitted} nodes, ${nextAsset} meshes, ${nextPrefab} prefabs`);
if (skipped.length) Logger.Warning(`[ncz] ${skipped.length} sectors could NOT be parsed — see ncz_skipped.csv`);
Logger.Info('[ncz] wrote ncz_materials / ncz_assets / ncz_nodes / ncz_prefabs / ncz_appearances / ncz_skipped .csv');
