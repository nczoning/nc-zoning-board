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
// The sectors contain the signs and windows THEMSELVES: named assets, with world
// positions. Validated on one 64 m cell each, ranked exactly as the human-verified
// reference says they should be:
//
//   district    rated   emissive signs   windows / walls   window share
//   Kabuki       1.0        237            91 / 143           38.9%
//   Arroyo       0.3          1             2 /  17           10.5%
//   Northside    0.0          0             0 /  19            0.0%
//
// WHAT IT WRITES
// ──────────────
// Two CSVs into the WolvenKit RAW folder:
//   ncz_signage_nodes.csv   one row per EMISSIVE sign: x, y, z, class, asset
//   ncz_sector_totals.csv   one row per sector: signs, inert_ad, windows, walls, …
//
// The map project bins these into subdistrict polygons (data/subdistricts.json):
//   SIGN density   = emissive signs / polygon area
//   WINDOW density = windows / (windows + walls)   — area-free, no camera in the loop
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

// ── Windows: buildings are KIT-BASHED from modular facade pieces ─────────────
// …\wat_kab_building_d_window_w300_h400_ac.mesh   (a window panel)
// …\wat_kab_building_f_wall_cornice_w300_aa.mesh  (a blank wall panel)
// So WINDOW SHARE = windows / (windows + walls) is a direct, area-free measure of
// how glassy a district's facades are — exactly what the renderer's window density
// means. Validated: Kabuki 38.9%, Arroyo 10.5%, Northside 0.0% (a genuinely
// windowless industrial district).
const WINDOW = /_window_|_window\.|^window_/;
const WALL   = /_wall_|_wall\./;

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
const sectorRows = ['sector,gx,gy,nodes,assets,signs,inert_ad,windows,walls,ads,lights'];
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

  let assets = 0, signs = 0, inertAd = 0, windows = 0, walls = 0, ads = 0, lights = 0;

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

    // Facade pieces → window share.
    if (WINDOW.test(base)) windows++;
    else if (WALL.test(base)) walls++;

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

  sectorRows.push(`${s.gx}_${s.gy},${s.gx},${s.gy},${nodes.length},${assets},${signs},${inertAd},${windows},${walls},${ads},${lights}`);
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
