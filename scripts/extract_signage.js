#!/usr/bin/env node
/**
 * extract_signage.js: the night scene's SECOND emitter class, as data.
 *
 * The box-cloud rebuild exists to light the city at night, and windows are
 * only half of that light: signs, billboards and ad screens carry the rest.
 * The cloud excludes them (they are not buildings); this collects them.
 *
 * Reads the world dump's CSVs directly rather than the stage-1 bin, because
 * stage 1 drops Advertisement-typed placements before the bin is written and
 * signage needs BOTH halves: the Advertisement nodes and the signage_* meshes
 * that ship typed GenericProxyMesh (see scripts/asset_category.js).
 *
 * Two phases, because emissive colour lives in game materials only the MCP
 * can resolve:
 *
 *   node scripts/extract_signage.js city_center watson
 *     placements + distinct mesh list -> data/signage-<district>.json
 *     and the mesh list as a wscript module beside the emissive collector.
 *
 *   (then run scripts/wkit/signage_emissive.wscript via the MCP, which
 *    writes per-mesh emissive data under the MCP dump dir)
 *
 *   node scripts/extract_signage.js city_center watson --merge <emissive.json>
 *     folds the per-mesh emissive into each district's JSON.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { categorize } = require('./asset_category');
const { polygonBounds, inPolygon } = require('./district_meta');

const DUMP = 'd:/Modding/CP2077 Mods/MyMods/map_data_export/source/raw';
const args = process.argv.slice(2);
const mergeIdx = args.indexOf('--merge');
const mergeFile = mergeIdx >= 0 ? args[mergeIdx + 1] : null;
const districts = args.filter((a, i) => !a.startsWith('--') && args[i - 1] !== '--merge');

const dataDir = path.join(__dirname, '..', 'data');
const sd = require(path.join(dataDir, 'subdistricts.json'));

if (!districts.length) {
  console.error('usage: node scripts/extract_signage.js <district> [...] [--merge emissive.json]');
  process.exit(1);
}

if (mergeFile) {
  const emissive = JSON.parse(fs.readFileSync(mergeFile, 'utf8'));
  for (const name of districts) {
    const file = path.join(dataDir, `signage-${name}.json`);
    const j = JSON.parse(fs.readFileSync(file, 'utf8'));
    let hit = 0;
    for (const p of j.placements) {
      const e = emissive[p.mesh];
      if (e) { p.emissive = e; hit++; }
    }
    j.emissiveMerged = new Date().toISOString();
    fs.writeFileSync(file, JSON.stringify(j));
    console.log(`${name}: emissive on ${hit.toLocaleString()}/${j.placements.length.toLocaleString()} placements -> ${path.relative(process.cwd(), file)}`);
  }
  process.exit(0);
}

const regions = districts.map(name => {
  const d = sd.districts.find(x => x.id === name);
  if (!d || !d.polygon) { console.error(`no polygon for ${name}`); process.exit(1); }
  const [x0, y0, x1, y1] = polygonBounds(d.polygon);
  return { name, poly: d.polygon, x0, y0, x1, y1, placements: [] };
});

async function loadAssets() {
  const byId = new Map();
  const rl = readline.createInterface({ input: fs.createReadStream(path.join(DUMP, 'ncz_assets.csv')), crlfDelay: Infinity });
  let header = null;
  for await (const line of rl) {
    if (header === null) { header = line; continue; }
    const m = line.match(/^(\d+),"([^"]*)"/);
    if (m) byId.set(Number(m[1]), m[2]);
  }
  return byId;
}

async function main() {
  const assetPath = await loadAssets();
  const meshes = new Set();
  let scanned = 0, signage = 0;

  const rl = readline.createInterface({ input: fs.createReadStream(path.join(DUMP, 'ncz_instances.csv')), crlfDelay: Infinity });
  let header = null;
  for await (const line of rl) {
    if (header === null) { header = line; continue; }
    if (!line) continue;
    scanned++;
    const p = line.split(',');
    const x = +p[5], y = +p[6];
    let region = null;
    for (const r of regions) {
      if (x < r.x0 || x > r.x1 || y < r.y0 || y > r.y1) continue;
      if (inPolygon(r.poly, x, y)) { region = r; break; }
    }
    if (!region) continue;
    const mesh = assetPath.get(+p[3]) || '';
    if (categorize(mesh, p[2]) !== 'signage') continue;
    signage++;
    if (mesh) meshes.add(mesh);
    region.placements.push({
      mesh,
      type: p[2],
      pos: [+p[5], +p[6], +p[7]],
      quat: [+p[8], +p[9], +p[10], +p[11]],
      scale: [+p[12] || 1, +p[13] || 1, +p[14] || 1],
      // Which appearance this placement selects: signage meshes are shared
      // shells whose appearance picks the actual sign face (12 different
      // storefronts share signage_city_generic_4x1).
      app: p[15] !== undefined ? +p[15] : 0,
    });
  }

  for (const r of regions) {
    const file = path.join(dataDir, `signage-${r.name}.json`);
    fs.writeFileSync(file, JSON.stringify({
      district: r.name, placements: r.placements,
      layout: 'pos xyz CET, quat xyzw, scale xyz',
      generated: new Date().toISOString(),
    }));
    console.log(`${r.name}: ${r.placements.length.toLocaleString()} signage placements -> ${path.relative(process.cwd(), file)}`);
  }

  const list = [...meshes].sort();
  fs.writeFileSync(path.join(__dirname, 'wkit', 'ncz_signage_meshes.wscript'),
    '// GENERATED by scripts/extract_signage.js. Do not hand-edit.\n' +
    `// ${list.length} distinct signage meshes.\n` +
    'export const SIGNAGE_MESHES = [\n' +
    list.map(m => `  ${JSON.stringify(m)},`).join('\n') +
    '\n];\n');
  console.log(`scanned ${scanned.toLocaleString()} placements, ${signage.toLocaleString()} signage, ` +
              `${list.length} distinct meshes -> scripts/wkit/ncz_signage_meshes.wscript`);
  console.log('next: run scripts/wkit/signage_emissive.wscript through the MCP, then --merge');
}

main();
