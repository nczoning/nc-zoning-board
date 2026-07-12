// scan_signage.wscript — WolvenKit Script Manager
// ─────────────────────────────────────────────────────────────────────────────
// Extract GROUND-TRUTH signage + light density for Night City, straight from the
// streaming sectors, for the NC Zoning Board 3D map's night lighting.
//
// WHY
// ───
// Sign density was first measured from in-game night footage. That failed: a
// pixel count is a fraction of the CAMERA FRAME, so it measures how much sky the
// camera happened to see, not how much neon the district has. (Japantown read 2.6x
// Kabuki purely because the roof pass flew lower.) Normalising by total light does
// not rescue it either — saturation cannot tell commercial neon from an industrial
// floodlight, so Northside Industrial scored highest in the city.
//
// The sectors contain the signs and facade pieces THEMSELVES: named assets, with
// world positions. Validated on one 64 m cell each, ranked exactly as the
// human-verified reference says they should be:
//
//   district    rated   emissive signs   window panels / walls
//   Kabuki       1.0        237                91 / 143
//   Arroyo       0.3          1                 2 /  17
//   Northside    0.0          0                 0 /  19   (a windowless factory district)
//
// WHAT IT WRITES
// ──────────────
// Two CSVs into the WolvenKit RAW folder:
//   ncz_signage_nodes.csv   one row per EMISSIVE sign: x, y, z, class, asset
//   ncz_sector_totals.csv   one row per sector: signs, inert_ad, windows, windows_off,
//                           walls, dominant style_use, ads, lights
//
// Bin into subdistrict polygons (data/subdistricts.json):
//   SIGN density  = emissive signs / polygon area          <- direct, trustworthy
//   WINDOW density: window PANELS are kit pieces holding dozens of windows each, so
//                   panel counts are a PROXY for facade glassiness, not a window count.
//                   The lit fraction itself is a GLOBAL 0.5 (see the Windows section);
//                   district variation lives in panel count + `windows_off` usage.
//
// RUN
// ───
// WolvenKit → Script Manager → run this. ~6,500 sectors; progress logged every 200.
// SET MAX_SECTORS = 50 FOR A SMOKE TEST FIRST — this script has not been executed in
// WolvenKit's engine, only written against the API docs, so the first run may need a
// fix (most likely `f.Name`, the property holding a file's game path).

import * as Logger from 'Logger';

// ── Config ───────────────────────────────────────────────────────────────────
const WORLD = 'worlds\\03_night_city\\_compiled\\default\\';

// LOD0 ONLY, and this is not a detail — it is the whole result.
//   LOD0 (64 m cells) holds the REAL geometry: worldStaticMeshNode, worldInstancedMeshNode,
//        worldAdvertisementNode. The actual signs.
//   LOD1+ (128 m and up) holds PROXIES: worldGenericProxyMeshNode, worldEntityProxyMeshNode.
//        Impostors for distance rendering.
// Scanned at LOD1, Kabuki appears to have ZERO worldAdvertisementNodes. At LOD0 it has 16 in a
// single cell. Reading the proxy tier gives a plausible, wrong answer — the failure mode to avoid.
// Do not add other levels here: LOD0 and LOD1 do not share a single sign position, so mixing
// them would double-count an impostor against its own original.
const LOD_LEVELS = [0];
const MAX_SECTORS = 0;         // 0 = all (~6,517). Set e.g. 50 for a smoke test first.
const LOG_EVERY = 200;

// ── Signage: use the GAME'S OWN taxonomy, not keyword guessing ───────────────
// base\environment\decoration\advertising\<kind>\... splits cleanly into:
//   EMISSIVE : signage (neon shop signs), digital (screens/billboards), holograms
//   INERT    : posters (paper), streamers (cloth banners), frames (bare mounts),
//              ground (stands). These EMIT NO LIGHT.
// A naive /advert/ on the path counts all of them — it would have added 38 paper
// posters and cloth banners to Kabuki's neon count. Count the inert ones separately
// so the mistake stays visible rather than silently inflating the density.
const AD_EMISSIVE = /[\\/]advertising[\\/](signage|digital|holograms)[\\/]/;
const AD_INERT    = /[\\/]advertising[\\/](posters|streamers|frames|ground)[\\/]/;
// Sector-local proxy copies live OUTSIDE the advertising tree (…\sectors\_external\
// proxy\…\signage_city_diner_zuru_zuru.mesh), so also match on the asset name.
const SIGN_NAME   = /signage_|signboard|neon_|billboard|screen_\d|hologram/;

// Sub-class an emissive sign. Maps onto the renderer's signage layers:
//   digital/screen/billboard → the big roof + facade emitters
//   neon/signage             → street-level shopfront neon
const SUBCLASS = [
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

// ── Windows ─────────────────────────────────────────────────────────────────
// A "window" mesh is a KIT PIECE — a facade module holding dozens of individual
// windows (wat_kab_building_d_window_corner_w300_aa_merged.mesh is a corner with
// 4 rows x 9 windows on two faces). So counting meshes counts PANELS, not windows,
// and says nothing about which light up.
//
// WHAT ACTUALLY LIGHTS UP is a material: base\materials\window_parallax_interior.mt
// (a parallax shader faking a lit room behind the glass). Its night parameters:
//   AmountTurnOffAtNight  = 0.5   <- half the windows go dark. IDENTICAL for every
//                                    archetype (ent apartment/office/industrial,
//                                    mlt office, nkt apartment). NOT per-district.
//   TintColorAtNight, LightsTempVariationAtNight (1.0), EmissiveEV (4)
//   roomWidth 3 x roomHeight 4 m  <- the real window cell size
// The "off" counterpart is engine\materials\metal_base.remt — plain dark glass,
// no interior, no emission.
//
// So per-district variation is STRUCTURAL, from three things, and this is what we
// count here:
//   1. how many window PANELS the district's buildings carry     (windows)
//   2. how many placed instances choose the `windows_off` mesh
//      appearance, killing their windows entirely                (windows_off)
//   3. which style x use-type the district uses — the whole city
//      is served by just 12 base materials:
//        entropy{apartment,industrial,office} x militarism{office} x neokitsch{apartment}
//                                                                  (style/use tally)
const WINDOW = /_window_|_window\.|^window_/;
const WALL   = /_wall_|_wall\./;
// meshAppearance values that mean "this building's windows are DARK".
const APPEARANCE_OFF = /windows_off|_off$/;
// Style x use-type, from the window material naming convention:
//   wat_kab_building_d_2x1_h400_w600_ent_apt.mi  ->  ent / apt
const STYLE = /_(ent|mlt|nkt|kts)_(apt|off|ind|apartment|office|industrial)/;

// Validated at LOD0 against the human-verified reference (one 64 m cell each):
//   Kabuki    (1.0)  237 emissive signs (+38 inert)   91 windows / 143 walls = 38.9%
//   Arroyo    (0.3)    1                               2 /  17 = 10.5%
//   Northside (0.0)    0                               0 /  19 =  0.0%

// ── Gather the sector list ───────────────────────────────────────────────────
const all = wkit.GetArchiveFiles();
const sectors = [];
for (const f of all) {
  const p = f.Name;                       // full game path
  if (!p || p.indexOf(WORLD) === -1) continue;
  if (!p.endsWith('.streamingsector')) continue;
  const m = p.match(/exterior_(-?\d+)_(-?\d+)_(-?\d+)_(\d+)\.streamingsector$/);
  if (!m) continue;                       // skip interior_/quest_ sectors
  const lod = parseInt(m[4], 10);
  if (LOD_LEVELS.indexOf(lod) === -1) continue;
  sectors.push({ path: p, gx: parseInt(m[1], 10), gy: parseInt(m[2], 10), lod: lod });
}
Logger.Info(`[ncz] ${sectors.length} sector(s) at LOD ${LOD_LEVELS.join(',')}`);

const limit = MAX_SECTORS > 0 ? Math.min(MAX_SECTORS, sectors.length) : sectors.length;

// ── Scan ─────────────────────────────────────────────────────────────────────
const nodeRows = ['x,y,z,class,type,asset,sector'];
const sectorRows = ['sector,gx,gy,nodes,assets,signs,inert_ad,windows,windows_off,walls,style_use,ads,lights'];
let done = 0, totalSigns = 0, totalWin = 0, failed = 0;

for (let i = 0; i < limit; i++) {
  const s = sectors[i];
  let json;
  try {
    json = wkit.GetFileFromArchive(s.path, OpenAs.Json);
  } catch (e) {
    failed++; continue;
  }
  if (!json) { failed++; continue; }

  let rc;
  try {
    rc = JSON.parse(json).Data.RootChunk;
  } catch (e) {
    failed++; continue;
  }

  const nodes = rc.nodes || [];
  const nd = (rc.nodeData && (rc.nodeData.Data || rc.nodeData)) || [];

  // nodeData carries the WORLD TRANSFORM; nodes carry the asset. Link by NodeIndex.
  const posByIndex = {};
  for (let k = 0; k < nd.length; k++) {
    const d = nd[k];
    if (d && d.Position && typeof d.NodeIndex === 'number') posByIndex[d.NodeIndex] = d.Position;
  }

  let assets = 0, signs = 0, inertAd = 0, windows = 0, windowsOff = 0, walls = 0, ads = 0, lights = 0;
  const styles = {};

  for (let n = 0; n < nodes.length; n++) {
    const d = nodes[n].Data;
    if (!d) continue;
    const t = d.$type;

    if (t === 'worldAdvertisementNode') ads++;
    else if (t === 'worldStaticLightNode') lights++;

    const dp = (d.mesh && d.mesh.DepotPath && d.mesh.DepotPath.$value)
            || (d.material && d.material.DepotPath && d.material.DepotPath.$value)
            || '';
    if (!dp) continue;
    assets++;

    const lower = dp.toLowerCase();
    const base = lower.split('\\').pop();

    // Facade pieces. A window PANEL whose instance chose a `windows_off` appearance
    // is dark no matter how many windows it contains — count it separately.
    if (WINDOW.test(base)) {
      const app = (d.meshAppearance && d.meshAppearance.$value) || '';
      if (APPEARANCE_OFF.test(app.toLowerCase())) windowsOff++;
      else windows++;
      const st = lower.match(STYLE);
      if (st) {
        const key = st[1] + '_' + st[2].slice(0, 3);
        styles[key] = (styles[key] || 0) + 1;
      }
    } else if (WALL.test(base)) walls++;

    // Signage. Inert ad furniture is counted but NOT treated as a light source.
    const named = SIGN_NAME.test(base);
    if (AD_INERT.test(lower) && !named) { inertAd++; continue; }
    const isSign = AD_EMISSIVE.test(lower) || t === 'worldAdvertisementNode' || named;
    if (!isSign) continue;

    signs++;
    const cls = t === 'worldAdvertisementNode' ? 'billboard' : subclass(lower);
    const p = posByIndex[n];
    const x = p ? p.X.toFixed(2) : '';
    const y = p ? p.Y.toFixed(2) : '';
    const z = p ? p.Z.toFixed(2) : '';
    // Quote the asset path — it contains backslashes, never commas.
    nodeRows.push(`${x},${y},${z},${cls},${t},"${dp}",${s.gx}_${s.gy}`);
  }

  // Dominant style_use for the sector (e.g. ent_apt, mlt_off) — '' if no windows.
  let topStyle = '', topN = 0;
  for (const k in styles) if (styles[k] > topN) { topN = styles[k]; topStyle = k; }

  sectorRows.push(`${s.gx}_${s.gy},${s.gx},${s.gy},${nodes.length},${assets},${signs},${inertAd},${windows},${windowsOff},${walls},${topStyle},${ads},${lights}`);
  totalSigns += signs;
  totalWin += windows;
  done++;

  if (done % LOG_EVERY === 0) {
    Logger.Info(`[ncz] ${done}/${limit} sectors — ${totalSigns} signs, ${totalWin} window panels`);
  }
}

wkit.SaveToRaw('ncz_signage_nodes.csv', nodeRows.join('\n'));
wkit.SaveToRaw('ncz_sector_totals.csv', sectorRows.join('\n'));

Logger.Success(`[ncz] done — ${done} sectors, ${failed} failed, ${totalSigns} signs, ${totalWin} window panels`);
Logger.Info('[ncz] wrote ncz_signage_nodes.csv + ncz_sector_totals.csv to the RAW folder');
