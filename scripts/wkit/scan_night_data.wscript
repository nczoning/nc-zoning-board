// =============================================================================
//  scan_night_data.wscript
//  ---------------------------------------------------------------------------
//  GROUND-TRUTH data pull for the NC Zoning Board night-lighting rebuild.
//  Run once; four CSVs into the project RAW folder. A 6,500-sector scan is not
//  something you want to repeat, so this is deliberately complete.
//
//  API conventions here follow find_pierogi_signs.wscript (a script known to run):
//  Logger.wscript import, f.FileName ?? f.Name, GetFileFromArchive → JSON *string*,
//  try/catch around sectors WolvenKit rejects, SaveToRaw at the end.
//
//
//  THE FOUR THINGS THAT MADE PREVIOUS ATTEMPTS WRONG
//  -------------------------------------------------
//  1. LOD0 ONLY. LOD0 (64 m cells) holds real geometry; LOD1+ holds PROXIES.
//     Scanned at LOD1, Kabuki appears to have ZERO advertisement nodes; at LOD0 it
//     has 16 in one cell. The proxy tier gives a plausible, wrong answer.
//
//  2. A SIGN IS NOT A NODE. Compiled sectors flatten prefabs into individual mesh
//     nodes -- panel, letters, frame -- so one shopfront sign is ~10 nodes. Kabuki's
//     275 sign NODES in one cell are only 26 actual SIGNS. Counting nodes overcounts
//     by ~10x, and unevenly: a district of small multi-part neon signs inflates
//     against one of single-node billboards. So signs are grouped by PREFAB REF.
//
//  3. A NODE IS NOT AN INSTANCE. worldInstancedMeshNode is N placed copies;
//     `worldTransformsBuffer.numElements` is N. Facade counts are instance-weighted
//     (Kabuki's glass share moved 38.6% -> 29.2% once corrected).
//
//  4. WINDOWS ARE TWO NUMBERS. base\materials\window_parallax_interior.mt sets
//     AmountTurnOffAtNight = 0.5 for EVERY archetype -- CDPR does not vary the lit
//     fraction by district. But a window panel is only part of a facade; the rest is
//     solid wall. So:   effective lit = glass_share(district) x 0.5
//     The district variable is the GLASS SHARE. That is what this measures.
//     (Same material: roomWidth 3 x roomHeight 4 m = the real window cell;
//      TintColorAtNight; LightsTempVariationAtNight = 1.0; EmissiveEV = 4.)
//
//
//  BONUS: THE PREFAB REF CARRIES THE DISTRICT
//  ------------------------------------------
//    $/03_night_city/c_watson/kabuki/wk_04/.../digital_billboard_33_10_021_prefab...
//                    ^district ^subdistrict
//  So we do not have to bin by polygon -- the game already knows. Recorded per sign.
//
//
//  OUTPUT
//  ------
//    ncz_signs.csv        one row per SIGN PLACEMENT (grouped by prefabRef):
//                         pivot position, part count, class, district, asset
//    ncz_sectors.csv      per sector: glass vs wall panels (instance-weighted),
//                         glass_off, dominant style x use, sign placements, lights
//    ncz_sign_assets.csv  each unique sign mesh -> its chunk material NAMES.
//                         Sign COLOUR lives here: neon_kiroshi_optics_logo.mesh has
//                         materials `neon_green_v1`, `neon_pink_v2`. (Material VALUES
//                         sit in a raw buffer WolvenKit won't expand; names suffice.)
//    ncz_lights.csv       worldStaticLightNode: colour, intensity, radius, position
//    ncz_skipped.csv      sectors WolvenKit could not parse -- NOT scanned. Explicit,
//                         so a silent miss can't masquerade as a zero.
//
//  SET MAX_SECTORS = 50 FOR A SMOKE TEST FIRST.
// =============================================================================

import * as Logger from 'Logger.wscript';

// ===================== CONFIG =====================
const LOD          = 0;      // see note 1. Do not change.
const MAX_SECTORS  = 0;      // 0 = all (~6,500). Set 50 to smoke-test.
const LOG_EVERY    = 250;
const ASSET_COLOURS = true;  // PASS 2: open each unique sign mesh for its materials
// ==================================================

// ---- Signage taxonomy: the game's own folders, not keyword guessing ----------
// advertising\{signage,digital,holograms}\ EMIT LIGHT.
// advertising\{posters,streamers,frames,ground}\ are paper, cloth and bare mounts —
// they emit nothing. A naive /advert/ match adds 38 pieces of cardboard to Kabuki.
const AD_EMISSIVE = /[\\/]advertising[\\/](signage|digital|holograms)[\\/]/;
const AD_INERT    = /[\\/]advertising[\\/](posters|streamers|frames|ground)[\\/]/;
const SIGN_NAME   = /signage_|signboard|neon_|billboard|screen_\d|hologram/;

// BLANK PANELS ARE AMBIGUOUS — classed separately, never merged into the emissive
// count. advertising\signage\blank_panels\ is a GENERIC carrier: the same
// signage_blank_panel_*.mesh is reused by thousands of signs and dressed with a
// texture. Some are backlit shopfronts (emissive); some are painted boards that are
// merely lit from outside — the maintainer's Pierogi World sign is one of the latter.
// The mesh cannot tell us which. So they get their own class and their own column;
// decide what to do with them once we can see how many there are and where.
const BLANK_PANEL = /[\\/]blank_panels[\\/]|blank_panel/;

const SUBCLASS = [
    ['blank',     BLANK_PANEL],          // FIRST — must win over the generic 'signage'
    ['billboard', /billboard/],
    ['screen',    /screen_\d|_screen|digital[\\/]/],
    ['hologram',  /hologram|holo_/],
    ['neon',      /neon/],
    ['signage',   /signage|signboard/],
];
function subclass(p) {
    for (const [name, re] of SUBCLASS) if (re.test(p)) return name;
    return 'advertising';
}

// ---- Facade pieces -----------------------------------------------------------
const WINDOW = /_window_|_window\./;
const WALL   = /_wall_|_wall\./;
const APPEARANCE_OFF = /windows_off|_off$/;   // this instance's windows are DARK
const STYLE  = /_(ent|mlt|nkt|kts)_(apt|off|ind|apartment|office|industrial)/;
// Any building-facade mesh — the PASS 3 population. Bespoke towers included, which is
// the whole point: they are exactly what the name-based WINDOW/WALL test misses.
const ARCH   = /[\\/]architecture[\\/]|[\\/]megabuilding[\\/]/;

// ---- Helpers -----------------------------------------------------------------
// A node is N placed copies, not one (note 3).
function instances(d) {
    const b = d.worldTransformsBuffer;
    return (b && typeof b.numElements === 'number' && b.numElements > 0) ? b.numElements : 1;
}
// The readable prefab path on a worldNodeData entry (QuestPrefabRefHash / UkHash1).
function prefabRef(o) {
    for (const k in o) {
        const v = o[k];
        if (v && typeof v === 'object' && v.$type === 'NodeRef' && typeof v.$value === 'string' && v.$value.length > 3) {
            return v.$value;
        }
    }
    return null;
}
// The game's own district/subdistrict, straight from the prefab path:
//     $/03_night_city/c_watson/kabuki/wk_04/...
//
// DO NOT NORMALISE THIS, AND DO NOT MAP IT HERE. The game's names do NOT match our
// subdistrict ids one-for-one, and the drift is not uniform:
//     c_watson / kabuki          (plain)
//     #c_santo_domingo / arroyo  (leading '#')
// An earlier regex required a `c_` prefix and would have SILENTLY DROPPED every
// '#c_' district — the same class of bug as japantown-vs-japan_town, which nearly
// unjoined one of the three loudest districts with no error anywhere.
//
// We have also hand-adjusted our own subdistricts (Biotechnica Flats split out, the
// Araska/Arasaka spelling) to match what the game actually renders — things the game
// files never had to care about. So the mapping is a real, human decision.
//
// Therefore: emit the RAW string, verbatim. Every distinct value also goes to
// ncz_districts.csv with its count, so the mapping is built from what is actually
// there, and anything unmapped is LOUD rather than absent.
function districtOf(ref) {
    const m = ref && ref.match(/^\$\/[^/]+\/([^/]+)\/([^/]+)\//);
    return m ? (m[1] + '/' + m[2]) : '';
}
const f2 = (v) => (typeof v === 'number' ? v.toFixed(2) : '');
const nz = (p) => p && !(p.X === 0 && p.Y === 0 && p.Z === 0);

// ---- Sector list -------------------------------------------------------------
// DEDUPE THE PATHS. GetArchiveFiles() returns EVERY COPY of a file — a sector that
// exists in the base archive plus a patch plus an EP1 override comes back 2, 4, even
// 80 times, and each copy gets scanned, emitting its signs again. The first run
// produced 80,702 sign rows of which only 33,202 were distinct: a 2.4x inflation,
// and an UNEVEN one (it scales with however many archives happen to carry a sector),
// so it would have skewed the district ranking, not just the totals.
//
// (find_pierogi_signs.wscript is immune to this by accident: it groups by prefabRef
//  GLOBALLY, across all sectors, so re-scans collapse into the same group.)
//
// The Z coordinate is also part of the sector identity — exterior_X_Y_Z_LOD. The city
// stacks vertically (underground / ground / elevated), so gx_gy alone is ambiguous.
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
    sectors.push({
        path: name,
        gx: parseInt(m[1], 10), gy: parseInt(m[2], 10), gz: parseInt(m[3], 10),
    });
}
const limit = MAX_SECTORS > 0 ? Math.min(MAX_SECTORS, sectors.length) : sectors.length;
Logger.Info(`[ncz] ${sectors.length} LOD${LOD} sectors in Night City; scanning ${limit}`);

// ---- PASS 1 ------------------------------------------------------------------
// SIZE IS NOT OPTIONAL. A billboard is ~30 m2; a neon shopfront sign is ~2 m2.
// Counting them equally makes Kabuki (many SMALL neon signs) rank 3x above Little
// China (fewer, HUGE signs) — when the footage shows Little China reading just as
// loud. Sign density must be weighted by EMISSIVE AREA, so the group's world bounds
// are carried through: bw/bh/bd, and `face` = the largest of the three cross-sections,
// a decent stand-in for the emitting face.
const signRows   = ['x,y,z,bw,bh,bd,face,parts,class,district,coordSource,asset,sector'];
const sectorRows = ['sector,gx,gy,gz,nodes,glass,glass_off,wall,glass_share,style_use,sign_placements,sign_parts,inert_ad,lights'];
const lightRows  = ['x,y,z,r,g,b,intensity,radius,temperature,type,name,sector'];
const skipped    = [];
const signAssets = {};    // depot path -> placements (PASS 2 input)
const archAssets = {};    // depot path -> instances  (PASS 3 input — see below)
const districts  = {};    // RAW game district string -> sign placements (see districtOf)

let done = 0, totalSigns = 0, totalGlass = 0;

for (let i = 0; i < limit; i++) {
    const s = sectors[i];
    if (++done % LOG_EVERY === 0) Logger.Info(`[ncz] ${done}/${limit} — ${totalSigns} signs, ${totalGlass} glass panels`);

    // WolvenKit rejects some device-heavy sectors ("not a CR2W file"). Record the
    // miss explicitly — a skipped sector must never look like a district with no signs.
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

    const tag = s.gx + '_' + s.gy + '_' + s.gz;   // Z is part of the identity — the city stacks
    let glass = 0, glassOff = 0, wall = 0, inertAd = 0, lights = 0, signParts = 0;
    const styles = {};
    const groups = {};   // prefabRef -> one SIGN PLACEMENT (note 2)

    for (let n = 0; n < nodes.length; n++) {
        const d = nodes[n].Data;
        if (!d) continue;
        const t = d.$type;
        const N = instances(d);
        const o = byIndex[n];

        if (t === 'worldStaticLightNode') {
            lights += N;
            const c = d.color || {};
            const p = o && o.Position;
            lightRows.push([
                p ? f2(p.X) : '', p ? f2(p.Y) : '', p ? f2(p.Z) : '',
                c.Red || 0, c.Green || 0, c.Blue || 0,
                d.intensity || 0, d.radius || 0, d.temperature || 0, d.type || '',
                '"' + ((d.debugName && d.debugName.$value) || '') + '"', tag,
            ].join(','));
            continue;
        }

        const dp = (d.mesh && d.mesh.DepotPath && d.mesh.DepotPath.$value)
                || (d.material && d.material.DepotPath && d.material.DepotPath.$value) || '';
        if (!dp) continue;
        const lower = dp.toLowerCase();
        const base  = lower.split('\\').pop();
        const app   = ((d.meshAppearance && d.meshAppearance.$value) || '').toLowerCase();

        // -- Facade: glass vs wall. GLASS SHARE is the district variable (note 4). --
        //
        // THE MESH NAME IS NOT ENOUGH — this is why PASS 3 exists.
        // Kabuki/Japantown/Heywood are kit-bashed from `*_window_*` / `*_wall_*` pieces,
        // so a name match works there. Corpo Plaza is NOT: its towers are bespoke
        // (cct_cpz_building_a_f_6m, ..._shield_c_12m_right, ..._a_6m_slope), almost none
        // of which say "window" or "wall". Name-matching read a district of GLASS
        // SKYSCRAPERS as 4% glass, and called its style `ent_ind` (Entropism industrial)
        // when it is Militarism office. It was measuring the wrong population entirely.
        //
        // The truth is in the MATERIAL: a facade piece is glass iff one of its
        // chunkMaterials resolves to window_parallax_interior. So every architecture mesh
        // is collected here and resolved in PASS 3 — same trick PASS 2 uses for signs.
        // The name-based counters below are kept as a CROSS-CHECK, not as the answer.
        if (ARCH.test(lower)) archAssets[dp] = (archAssets[dp] || 0) + N;

        if (WINDOW.test(base)) {
            if (APPEARANCE_OFF.test(app)) glassOff += N; else glass += N;
            const st = lower.match(STYLE);
            if (st) {
                const key = st[1] + '_' + st[2].substring(0, 3);
                styles[key] = (styles[key] || 0) + N;
            }
        } else if (WALL.test(base)) {
            wall += N;
        }

        // -- Signage --
        const named = SIGN_NAME.test(base);
        if (AD_INERT.test(lower) && !named) { inertAd += N; continue; }
        if (!(AD_EMISSIVE.test(lower) || t === 'worldAdvertisementNode' || named)) continue;

        signParts += N;
        signAssets[dp] = (signAssets[dp] || 0) + N;

        // Group parts into one placement by prefab ref. No ref (rare) => its own group.
        const ref = o ? prefabRef(o) : null;
        const key = ref || ('node#' + n);
        const g = groups[key] || (groups[key] = {
            ref, parts: 0, sumX: 0, sumY: 0, sumZ: 0, pivot: null,
            cls: subclass(lower), asset: dp,
            // Union of the parts' world bounds = the whole sign's extent → its AREA.
            bmin: null, bmax: null,
        });
        g.parts += N;
        if (o && o.Position) { g.sumX += o.Position.X; g.sumY += o.Position.Y; g.sumZ += o.Position.Z; }
        // The pivot is the sign's AUTHORED anchor — exact. Prefer it over a centroid.
        if (!g.pivot && o && nz(o.Pivot)) g.pivot = o.Pivot;
        // Grow the sign's bounds by this part's. Size is what separates a 30 m2
        // billboard from a 2 m2 shopfront neon — see the note above signRows.
        if (o && o.Bounds && o.Bounds.Min && o.Bounds.Max) {
            const lo = o.Bounds.Min, hi = o.Bounds.Max;
            if (!g.bmin) { g.bmin = { X: lo.X, Y: lo.Y, Z: lo.Z }; g.bmax = { X: hi.X, Y: hi.Y, Z: hi.Z }; }
            else {
                if (lo.X < g.bmin.X) g.bmin.X = lo.X;
                if (lo.Y < g.bmin.Y) g.bmin.Y = lo.Y;
                if (lo.Z < g.bmin.Z) g.bmin.Z = lo.Z;
                if (hi.X > g.bmax.X) g.bmax.X = hi.X;
                if (hi.Y > g.bmax.Y) g.bmax.Y = hi.Y;
                if (hi.Z > g.bmax.Z) g.bmax.Z = hi.Z;
            }
        }
        // Prefer the most specific class seen among the parts.
        if (g.cls === 'advertising') g.cls = subclass(lower);
    }

    let placements = 0;
    for (const key in groups) {
        const g = groups[key];
        placements++;
        const c = g.pivot || { X: g.sumX / g.parts, Y: g.sumY / g.parts, Z: g.sumZ / g.parts };
        const dist = districtOf(g.ref);
        districts[dist] = (districts[dist] || 0) + 1;
        let bw = '', bh = '', bd = '', face = '';
        if (g.bmin) {
            const w = g.bmax.X - g.bmin.X, h = g.bmax.Y - g.bmin.Y, dz = g.bmax.Z - g.bmin.Z;
            bw = f2(w); bh = f2(h); bd = f2(dz);
            // A sign is a flat panel: its emitting face is the biggest cross-section.
            face = f2(Math.max(w * h, w * dz, h * dz));
        }
        signRows.push([
            f2(c.X), f2(c.Y), f2(c.Z), bw, bh, bd, face, g.parts, g.cls,
            '"' + dist + '"', g.pivot ? 'pivot' : 'centroid',
            '"' + g.asset + '"', tag,
        ].join(','));
    }

    const share = (glass + wall) ? (glass / (glass + wall)).toFixed(4) : '0';
    let topStyle = '', topN = 0;
    for (const k in styles) if (styles[k] > topN) { topN = styles[k]; topStyle = k; }

    sectorRows.push([tag, s.gx, s.gy, s.gz, nodes.length, glass, glassOff, wall, share,
        topStyle, placements, signParts, inertAd, lights].join(','));

    totalSigns += placements;
    totalGlass += glass;
}

// ---- PASS 2: unique sign assets -> material names (= COLOUR) ------------------
const assetRows = ['asset,placements,materials'];
if (ASSET_COLOURS) {
    const keys = Object.keys(signAssets);
    Logger.Info(`[ncz] PASS 2: ${keys.length} unique sign assets`);
    let a = 0;
    for (const path of keys) {
        let mats = '';
        if (path.toLowerCase().endsWith('.mesh')) {
            try {
                const j = wkit.GetFileFromArchive(path, OpenAs.Json);
                if (j) {
                    const mrc = JSON.parse(j).Data.RootChunk;
                    const names = [];
                    for (const e of (mrc.materialEntries || [])) {
                        const nm = e.name && e.name.$value;
                        if (nm && names.indexOf(nm) === -1) names.push(nm);
                    }
                    mats = names.join('|');
                }
            } catch { /* leave blank */ }
        }
        assetRows.push(`"${path}",${signAssets[path]},"${mats}"`);
        if (++a % 250 === 0) Logger.Info(`[ncz] PASS 2: ${a}/${keys.length}`);
    }
}

// Every distinct RAW district string the game used, with its sign count. This is the
// input to the mapping decision (game names vs our subdistrict ids) — build it from
// what is actually there, never from a guess. Anything that fails to map will be
// visible here rather than silently missing from a district's profile.
const districtRows = ['game_district,sign_placements'];
for (const k in districts) districtRows.push(`"${k}",${districts[k]}`);

// ---- PASS 3: architecture meshes -> DO THEY CARRY A WINDOW MATERIAL? ---------
// The whole point. A facade piece is GLASS iff one of its chunk materials resolves to
// window_parallax_interior (or window_interior_uv) — never mind what the mesh is called.
// This is what rescues bespoke architecture: Corpo Plaza's towers are
// cct_cpz_building_a_f_6m / _shield_c_12m_right / _a_6m_slope, which a name test reads
// as "not a window" and therefore as a 4%-glass district of glass skyscrapers.
//
// Emitted per mesh:
//   instances     how many placed copies exist city-wide (instance-weighted)
//   glass         1 if any chunk material is a window material
//   win_mats      the window material names (they encode style + use:
//                 wat_kab_building_d_..._ent_apt -> Entropism / apartment)
//   n_chunks      total chunk materials, and how many are window ones -> a per-MESH
//                 glass fraction, which is far better than counting whole panels
//                 (one "window panel" mesh holds dozens of actual windows)
const WINDOW_MAT = /window_parallax_interior|window_interior_uv|windows[\\/]|_window/i;
const archRows = ['asset,instances,glass,win_chunks,n_chunks,win_mats'];
{
    const keys = Object.keys(archAssets);
    Logger.Info(`[ncz] PASS 3: ${keys.length} unique architecture meshes`);
    let a = 0, glassMeshes = 0;
    for (const path of keys) {
        let isGlass = 0, nChunks = 0, winChunks = 0;
        const winMats = [];
        if (path.toLowerCase().endsWith('.mesh')) {
            try {
                const j = wkit.GetFileFromArchive(path, OpenAs.Json);
                if (j) {
                    const mrc = JSON.parse(j).Data.RootChunk;
                    // materialEntries names + the external material paths they resolve to.
                    const ext = [];
                    for (const e of (mrc.externalMaterials || [])) {
                        const p = e && e.DepotPath && e.DepotPath.$value;
                        if (p) ext.push(p);
                    }
                    for (const e of (mrc.materialEntries || [])) {
                        const nm = (e.name && e.name.$value) || '';
                        nChunks++;
                        const hit = WINDOW_MAT.test(nm) || ext.some((p) => WINDOW_MAT.test(p));
                        if (hit) {
                            winChunks++;
                            isGlass = 1;
                            if (winMats.indexOf(nm) === -1) winMats.push(nm);
                        }
                    }
                    // The external .mi paths carry style/use (…_ent_apt.mi), so keep them.
                    for (const p of ext) {
                        if (WINDOW_MAT.test(p)) {
                            const leaf = p.split('\\').pop();
                            if (winMats.indexOf(leaf) === -1) winMats.push(leaf);
                        }
                    }
                }
            } catch { /* leave as not-glass; the row still records the instance count */ }
        }
        if (isGlass) glassMeshes++;
        archRows.push(`"${path}",${archAssets[path]},${isGlass},${winChunks},${nChunks},"${winMats.join('|')}"`);
        if (++a % 250 === 0) Logger.Info(`[ncz] PASS 3: ${a}/${keys.length} (${glassMeshes} carry glass)`);
    }
    Logger.Success(`[ncz] PASS 3: ${glassMeshes} of ${keys.length} architecture meshes carry a window material`);
}

wkit.SaveToRaw('ncz_arch_assets.csv', archRows.join('\n'));
wkit.SaveToRaw('ncz_signs.csv',       signRows.join('\n'));
wkit.SaveToRaw('ncz_sectors.csv',     sectorRows.join('\n'));
wkit.SaveToRaw('ncz_sign_assets.csv', assetRows.join('\n'));
wkit.SaveToRaw('ncz_lights.csv',      lightRows.join('\n'));
wkit.SaveToRaw('ncz_districts.csv',   districtRows.join('\n'));
wkit.SaveToRaw('ncz_skipped.csv',     ['sector'].concat(skipped).join('\n'));

Logger.Success(`[ncz] ${done} sectors — ${totalSigns} sign placements, ${totalGlass} glass panels, ` +
    `${Object.keys(signAssets).length} unique sign assets`);
if (skipped.length) Logger.Warning(`[ncz] ${skipped.length} sectors could NOT be parsed and were NOT scanned — see ncz_skipped.csv`);
Logger.Warning(`[ncz] ${Object.keys(districts).length} distinct game-district strings — see ncz_districts.csv. ` +
    `CROSS-CHECK these against data/subdistricts.json before joining: the names do NOT match ours ` +
    `one-for-one ('#c_santo_domingo' vs 'c_watson'), and we have hand-adjusted our own ids.`);
Logger.Info('[ncz] wrote ncz_signs / ncz_sectors / ncz_sign_assets / ncz_lights / ncz_districts / ncz_skipped .csv');
