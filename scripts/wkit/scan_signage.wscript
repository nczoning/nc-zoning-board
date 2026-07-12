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
// The sectors contain the signs THEMSELVES: named assets, with world positions.
// Kabuki 7.5% sign-like assets vs Northside 0.3% — a 25x separation that ranks
// exactly as the human-verified reference says it should.
//
// WHAT IT WRITES
// ──────────────
// Two CSVs into the WolvenKit RAW folder:
//   ncz_signage_nodes.csv    one row per sign-like asset: x, y, z, class, asset
//   ncz_sector_totals.csv    one row per sector: counts, for density-per-area
//
// The map project bins these into subdistrict polygons (data/subdistricts.json)
// and divides by polygon area to get a true per-subdistrict density.
//
// RUN
// ───
// WolvenKit → Script Manager → run this. Expect a long run (thousands of sectors);
// progress is logged every 200. Set LOD_LEVELS / MAX_SECTORS to test on a subset
// first.

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

// Sign-like asset classes, checked in order — first match wins, so the specific
// patterns must precede the generic ones. These map onto the renderer's signage
// layers: `neon` and `signage` are facade/street level, `screen`/`billboard` are
// the big emitters, `advert_frame` is the mounting furniture.
// Validated at LOD0 against the human-verified reference:
//   Kabuki    (rated 1.0)  279 signs, 10.5% of assets  — neon 105, signage 92, billboard 39,
//                                                         advertising 34, screen 8
//   Arroyo    (rated 0.3)    2 signs,  0.5%
//   Northside (rated 0.0)    0 signs,  0.0%
const CLASSES = [
  ['billboard',  /billboard/],
  ['screen',     /screen_\d|_screen|digital_screen|led_screen/],
  ['neon',       /neon/],
  ['signage',    /signage|_sign_/],
  ['advertising',/advertis|advert/],
  ['hologram',   /hologram|holo_/],
];

function classify(p) {
  for (const [name, re] of CLASSES) if (re.test(p)) return name;
  return null;
}

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
const sectorRows = ['sector,gx,gy,nodes,assets,signs,ads,lights,decals'];
let done = 0, totalSigns = 0, failed = 0;

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

  let assets = 0, signs = 0, ads = 0, lights = 0, decals = 0;

  for (let n = 0; n < nodes.length; n++) {
    const d = nodes[n].Data;
    if (!d) continue;
    const t = d.$type;

    if (t === 'worldAdvertisementNode') ads++;
    else if (t === 'worldStaticLightNode') lights++;
    else if (t === 'worldStaticDecalNode') decals++;

    const dp = (d.mesh && d.mesh.DepotPath && d.mesh.DepotPath.$value)
            || (d.material && d.material.DepotPath && d.material.DepotPath.$value)
            || '';
    if (!dp) continue;
    assets++;

    const lower = dp.toLowerCase();
    const cls = t === 'worldAdvertisementNode' ? 'billboard' : classify(lower);
    if (!cls) continue;
    signs++;

    const p = posByIndex[n];
    const x = p ? p.X.toFixed(2) : '';
    const y = p ? p.Y.toFixed(2) : '';
    const z = p ? p.Z.toFixed(2) : '';
    // Quote the asset path — it contains backslashes, never commas.
    nodeRows.push(`${x},${y},${z},${cls},${t},"${dp}",${s.gx}_${s.gy}`);
  }

  sectorRows.push(`${s.gx}_${s.gy},${s.gx},${s.gy},${nodes.length},${assets},${signs},${ads},${lights},${decals}`);
  totalSigns += signs;
  done++;

  if (done % LOG_EVERY === 0) {
    Logger.Info(`[ncz] ${done}/${limit} sectors — ${totalSigns} sign assets so far`);
  }
}

wkit.SaveToRaw('ncz_signage_nodes.csv', nodeRows.join('\n'));
wkit.SaveToRaw('ncz_sector_totals.csv', sectorRows.join('\n'));

Logger.Success(`[ncz] done — ${done} sectors scanned, ${failed} failed, ${totalSigns} sign assets`);
Logger.Info('[ncz] wrote ncz_signage_nodes.csv + ncz_sector_totals.csv to the RAW folder');
