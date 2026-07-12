// scan_night_data.wscript — WolvenKit Script Manager
// ═════════════════════════════════════════════════════════════════════════════
// GROUND-TRUTH data pull for the NC Zoning Board night-lighting rebuild.
// Replaces scan_signage.wscript (which counted nodes, not instances — see below).
//
// Run once. Writes four CSVs to the WolvenKit RAW folder. Everything the window
// and signage engines need should be in them; the point of doing this in one pass
// is that a 6,500-sector scan is not something you want to repeat.
//
//
// WHAT WE LEARNED THAT SHAPED THIS
// ────────────────────────────────
// • LOD0 ONLY. LOD0 (64 m cells) holds real geometry; LOD1+ holds PROXIES. Scanned
//   at LOD1, Kabuki appears to have ZERO advertisement nodes — at LOD0 it has 16 in
//   one cell. The proxy tier gives a plausible, wrong answer.
//
// • COUNT INSTANCES, NOT NODES. A worldInstancedMeshNode is N placed copies;
//   `worldTransformsBuffer.numElements` is N. Counting the node as 1 undercounts
//   badly — Kabuki's window-panel share moved 38.6% → 29.2% and its sign count
//   238 → 397 once weighted. EVERY count here is instance-weighted.
//
// • WINDOWS ARE TWO NUMBERS, NOT ONE.
//     base\materials\window_parallax_interior.mt → AmountTurnOffAtNight = 0.5,
//     identical for every archetype. CDPR does NOT vary the lit fraction by district.
//   But a window panel is only PART of a facade — the rest is solid wall. So:
//        effective lit  =  glass_share(district)  ×  0.5
//   The district variable is the GLASS SHARE, and that is what this measures.
//   Also from that material: roomWidth 3 × roomHeight 4 m (the real window cell),
//   TintColorAtNight, LightsTempVariationAtNight = 1.0, EmissiveEV = 4.
//   The "off" counterpart is engine\materials\metal_base.remt — plain dark glass.
//
// • EMISSIVE SIGNS ONLY. base\environment\decoration\advertising\ splits into
//   {signage, digital, holograms} (emit light) and {posters, streamers, frames,
//   ground} (paper, cloth, bare mounts — emit nothing). A naive /advert/ match adds
//   38 pieces of cardboard to Kabuki's neon count. Inert ones are counted separately
//   so the mistake stays visible.
//
// • SIGN COLOUR IS IN THE MATERIAL NAME. neon_kiroshi_optics_logo.mesh has chunk
//   materials `neon_green_v1`, `neon_pink_v2`, … The material VALUES are in a raw
//   buffer WolvenKit won't expand, but the NAMES are enough. Hence PASS 2.
//
//
// KNOWN LIMITATION — read before trusting sign PLACEMENT
// ─────────────────────────────────────────────────────
// Per-instance transforms for worldInstancedMeshNode live in a binary buffer that
// the JSON export does not expand. So:
//   • non-instanced signs (worldStaticMeshNode / worldAdvertisementNode) get EXACT
//     position + orientation + bounds — these are the big billboards and screens.
//   • instanced signs get their COUNT and the node's bounds, not individual copies.
// Roughly half of Kabuki's signs are instanced. For density that is fine (counts are
// exact). For exact placement, the instanced ones would need to be distributed within
// the node's bounds, or the buffer read via the CR2W object model (untried).
//
//
// OUTPUT
// ──────
//   ncz_signs.csv      one row per PLACED sign (exact where available)
//   ncz_sectors.csv    per-sector totals — glass share, signs, lights, style mix
//   ncz_sign_assets.csv one row per UNIQUE sign mesh + its material names (COLOUR)
//   ncz_lights.csv     worldStaticLightNode: colour, intensity, radius, position
//
//
// RUN
// ───
// SET MAX_SECTORS = 50 FIRST and check the output looks sane. This script has NOT
// been executed in WolvenKit's engine — it is written against the API docs, so the
// first run may need a fix. The likeliest breakage is `f.Name` (the property holding
// a file's game path on the objects GetArchiveFiles() returns).

import * as Logger from 'Logger';

// ── Config ───────────────────────────────────────────────────────────────────
const WORLD = 'worlds\\03_night_city\\_compiled\\default\\';
const LOD = 0;                 // LOD0 only. See above — this is not a preference.
const MAX_SECTORS = 0;         // 0 = all (~6,517). Set 50 for a smoke test.
const LOG_EVERY = 200;
const COLLECT_ASSETS = true;   // PASS 2: open each unique sign mesh for its colours

// ── Signage taxonomy (the game's own folders, not keyword guessing) ──────────
const AD_EMISSIVE = /[\\/]advertising[\\/](signage|digital|holograms)[\\/]/;
const AD_INERT    = /[\\/]advertising[\\/](posters|streamers|frames|ground)[\\/]/;
const SIGN_NAME   = /signage_|signboard|neon_|billboard|screen_\d|hologram/;
const SUBCLASS = [
  ['billboard', /billboard/],
  ['screen',    /screen_\d|_screen|digital[\\/]/],
  ['hologram',  /hologram|holo_/],
  ['neon',      /neon/],
  ['signage',   /signage|signboard/],
];
function subclass(p) {
  for (let i = 0; i < SUBCLASS.length; i++) if (SUBCLASS[i][1].test(p)) return SUBCLASS[i][0];
  return 'advertising';
}

// ── Facade pieces ────────────────────────────────────────────────────────────
const WINDOW = /_window_|_window\./;
const WALL   = /_wall_|_wall\./;
const APPEARANCE_OFF = /windows_off|_off$/;   // this instance's windows are DARK
// wat_kab_building_d_2x1_h400_w600_ent_apt → style `ent`, use `apt`
const STYLE = /_(ent|mlt|nkt|kts)_(apt|off|ind|apartment|office|industrial)/;

// A node is N placed copies, not one. THIS IS THE FIX — see the header.
function instances(d) {
  const b = d.worldTransformsBuffer;
  if (b && typeof b.numElements === 'number' && b.numElements > 0) return b.numElements;
  return 1;
}
const f2 = (v) => (typeof v === 'number' ? v.toFixed(2) : '');
const f4 = (v) => (typeof v === 'number' ? v.toFixed(4) : '');

// ── Sector list ──────────────────────────────────────────────────────────────
const sectors = [];
const all = wkit.GetArchiveFiles();
for (const f of all) {
  const p = f.Name;
  if (!p || p.indexOf(WORLD) === -1 || !p.endsWith('.streamingsector')) continue;
  const m = p.match(/exterior_(-?\d+)_(-?\d+)_(-?\d+)_(\d+)\.streamingsector$/);
  if (!m || parseInt(m[4], 10) !== LOD) continue;
  sectors.push({ path: p, gx: parseInt(m[1], 10), gy: parseInt(m[2], 10) });
}
const limit = MAX_SECTORS > 0 ? Math.min(MAX_SECTORS, sectors.length) : sectors.length;
Logger.Info(`[ncz] ${sectors.length} LOD${LOD} sectors; scanning ${limit}`);

// ── PASS 1: sectors ──────────────────────────────────────────────────────────
const signRows   = ['x,y,z,qi,qj,qk,qr,sx,sy,sz,bw,bh,bd,class,node,instances,asset,sector'];
const sectorRows = ['sector,gx,gy,nodes,assets,signs,inert_ad,glass,glass_off,wall,style_use,ads,lights'];
const lightRows  = ['x,y,z,r,g,b,intensity,radius,temperature,type,name,sector'];
const signAssets = {};   // depot path → count (PASS 2 input)

let done = 0, failed = 0, totSigns = 0, totGlass = 0;

for (let i = 0; i < limit; i++) {
  const s = sectors[i];
  let rc;
  try {
    const json = wkit.GetFileFromArchive(s.path, OpenAs.Json);
    if (!json) { failed++; continue; }
    rc = JSON.parse(json).Data.RootChunk;
  } catch (e) { failed++; continue; }

  const nodes = rc.nodes || [];
  const nd = (rc.nodeData && (rc.nodeData.Data || rc.nodeData)) || [];
  const xf = {};   // NodeIndex → full transform (position, orientation, scale, bounds)
  for (let k = 0; k < nd.length; k++) {
    const d = nd[k];
    if (d && typeof d.NodeIndex === 'number') xf[d.NodeIndex] = d;
  }

  let assets = 0, signs = 0, inertAd = 0, glass = 0, glassOff = 0, wall = 0, ads = 0, lights = 0;
  const styles = {};
  const tag = s.gx + '_' + s.gy;

  for (let n = 0; n < nodes.length; n++) {
    const d = nodes[n].Data;
    if (!d) continue;
    const t = d.$type;
    const N = instances(d);
    const tr = xf[n];

    // ── Light sources (for the city-glow term) ──
    if (t === 'worldStaticLightNode') {
      lights += N;
      const c = d.color || {};
      const p = tr && tr.Position;
      lightRows.push([
        p ? f2(p.X) : '', p ? f2(p.Y) : '', p ? f2(p.Z) : '',
        c.Red || 0, c.Green || 0, c.Blue || 0,
        d.intensity || 0, d.radius || 0, d.temperature || 0, d.type || '',
        '"' + ((d.debugName && d.debugName.$value) || '') + '"', tag,
      ].join(','));
      continue;
    }
    if (t === 'worldAdvertisementNode') ads += N;

    const dp = (d.mesh && d.mesh.DepotPath && d.mesh.DepotPath.$value)
            || (d.material && d.material.DepotPath && d.material.DepotPath.$value) || '';
    if (!dp) continue;
    assets += N;

    const lower = dp.toLowerCase();
    const base = lower.split('\\').pop();
    const app = ((d.meshAppearance && d.meshAppearance.$value) || '').toLowerCase();

    // ── Facade: glass panels vs solid wall. GLASS SHARE is the district variable. ──
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

    // ── Signage ──
    const named = SIGN_NAME.test(base);
    if (AD_INERT.test(lower) && !named) { inertAd += N; continue; }
    if (!(AD_EMISSIVE.test(lower) || t === 'worldAdvertisementNode' || named)) continue;

    signs += N;
    signAssets[dp] = (signAssets[dp] || 0) + N;

    const cls = t === 'worldAdvertisementNode' ? 'billboard' : subclass(lower);
    const p = tr && tr.Position, q = tr && tr.Orientation, sc = tr && tr.Scale, bb = tr && tr.Bounds;
    // Bounds → physical size. For an instanced node this covers ALL its copies (see
    // the header limitation), so trust it only when instances == 1.
    let bw = '', bh = '', bd = '';
    if (bb && bb.Max && bb.Min) {
      bw = f2(bb.Max.X - bb.Min.X); bh = f2(bb.Max.Y - bb.Min.Y); bd = f2(bb.Max.Z - bb.Min.Z);
    }
    signRows.push([
      p ? f2(p.X) : '', p ? f2(p.Y) : '', p ? f2(p.Z) : '',
      q ? f4(q.i) : '', q ? f4(q.j) : '', q ? f4(q.k) : '', q ? f4(q.r) : '',
      sc ? f2(sc.X) : '', sc ? f2(sc.Y) : '', sc ? f2(sc.Z) : '',
      bw, bh, bd,
      cls, t, N, '"' + dp + '"', tag,
    ].join(','));
  }

  let topStyle = '', topN = 0;
  for (const k in styles) if (styles[k] > topN) { topN = styles[k]; topStyle = k; }

  sectorRows.push([tag, s.gx, s.gy, nodes.length, assets, signs, inertAd,
    glass, glassOff, wall, topStyle, ads, lights].join(','));

  totSigns += signs; totGlass += glass; done++;
  if (done % LOG_EVERY === 0) Logger.Info(`[ncz] ${done}/${limit} — ${totSigns} signs, ${totGlass} glass panels`);
}

// ── PASS 2: unique sign assets → their material names (= COLOUR) ─────────────
// neon_kiroshi_optics_logo.mesh → chunk materials neon_green_v1, neon_pink_v2, …
const assetRows = ['asset,placements,materials'];
if (COLLECT_ASSETS) {
  const keys = Object.keys(signAssets);
  Logger.Info(`[ncz] PASS 2: ${keys.length} unique sign assets`);
  let a = 0;
  for (const path of keys) {
    let mats = '';
    if (path.endsWith('.mesh')) {
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
      } catch (e) { /* leave blank */ }
    }
    assetRows.push(`"${path}",${signAssets[path]},"${mats}"`);
    if (++a % 200 === 0) Logger.Info(`[ncz] PASS 2: ${a}/${keys.length}`);
  }
}

wkit.SaveToRaw('ncz_signs.csv', signRows.join('\n'));
wkit.SaveToRaw('ncz_sectors.csv', sectorRows.join('\n'));
wkit.SaveToRaw('ncz_sign_assets.csv', assetRows.join('\n'));
wkit.SaveToRaw('ncz_lights.csv', lightRows.join('\n'));

Logger.Success(`[ncz] done — ${done} sectors (${failed} failed), ${totSigns} signs, ` +
  `${totGlass} glass panels, ${Object.keys(signAssets).length} unique sign assets`);
Logger.Info('[ncz] wrote ncz_signs.csv, ncz_sectors.csv, ncz_sign_assets.csv, ncz_lights.csv');
