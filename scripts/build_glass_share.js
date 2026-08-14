#!/usr/bin/env node
/**
 * build_glass_share.js: per-asset glass share, from materials instead of
 * names. A skylight FRAME is metal that happens to be named like its
 * glazing; the material chain cannot be fooled the same way. The night dump
 * resolved every .mi to its root shader (ncz_materials.csv) and every mesh
 * to the materials it references (ncz_assets.csv); the join gives each mesh
 * the fraction of its material slots that are glass.
 *
 * Output: data/asset-glass-share.json  { "<depot path>": 0..1, ... }
 * (only assets with a nonzero share; everything else is implicitly 0).
 * asset_category.js consumes it when present.
 *
 * Usage: node scripts/build_glass_share.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const readline = require('readline');

const DUMP = 'd:/Modding/CP2077 Mods/MyMods/map_data_export/source/raw';
const OUT = path.join(__dirname, '..', 'data', 'asset-glass-share.json');

// A material is glass when its root shader is a glass or window family .mt.
// Window shaders carry lit interiors; glass shaders carry transparency.
const GLASS_ROOT = /(^|\\)(glass|window)[^\\]*\.(mt|remt)$/i;

function parseCsvLine(line) {
  const out = [];
  let cur = '', inQ = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQ) {
      if (ch === '"') inQ = false;
      else cur += ch;
    } else if (ch === '"') inQ = true;
    else if (ch === ',') { out.push(cur); cur = ''; }
    else cur += ch;
  }
  out.push(cur);
  return out;
}

async function main() {
  // Pass A: material path -> is its root glass?
  const glassMi = new Set();
  {
    const rl = readline.createInterface({ input: fs.createReadStream(path.join(DUMP, 'ncz_materials.csv')), crlfDelay: Infinity });
    let header = true, total = 0;
    for await (const line of rl) {
      if (header) { header = false; continue; }
      if (!line) continue;
      const [p, root] = parseCsvLine(line);
      total++;
      if (root && GLASS_ROOT.test(root)) glassMi.add(p.toLowerCase());
    }
    console.log(`materials: ${glassMi.size.toLocaleString()} glass-rooted of ${total.toLocaleString()}`);
  }

  // Pass B: per asset, share of material references that are glass. Both the
  // external .mi paths (joinable) and chunk NAMES (matched by word) count:
  // local-buffer materials never reach ncz_materials, and a chunk named
  // "glass" is glass.
  const share = {};
  {
    const rl = readline.createInterface({ input: fs.createReadStream(path.join(DUMP, 'ncz_assets.csv')), crlfDelay: Infinity });
    let header = true, assets = 0, withGlass = 0;
    for await (const line of rl) {
      if (header) { header = false; continue; }
      if (!line) continue;
      const cols = parseCsvLine(line);
      const p = cols[1];
      if (!p || p === '0') continue;
      const names = (cols[9] || '').split('|').filter(Boolean);
      const paths = (cols[10] || '').split('|').filter(Boolean);
      let glass = 0, total = 0;
      for (const n of names) { total++; if (/(^|_)glass|window_/i.test(n)) glass++; }
      for (const mp of paths) { total++; if (glassMi.has(mp.toLowerCase())) glass++; }
      assets++;
      if (total > 0 && glass > 0) {
        share[p] = +(glass / total).toFixed(3);
        withGlass++;
      }
    }
    console.log(`assets: ${withGlass.toLocaleString()} of ${assets.toLocaleString()} carry any glass`);
  }

  fs.writeFileSync(OUT, JSON.stringify(share));
  console.log(`wrote ${path.relative(process.cwd(), OUT)} (${Object.keys(share).length.toLocaleString()} entries)`);
}

main();
