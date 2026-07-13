#!/usr/bin/env node
/**
 * scripts/merge_dump_parts.js
 * ─────────────────────────────────────────────────────────────────────────
 * Assemble ncz_nodes.csv and ncz_instances.csv from the part files that
 * dump_night_raw.wscript writes as it goes.
 *
 * WHY PARTS AT ALL. The wscript used to hold every row in memory and join at the end. At
 * 7,159 level-0 sectors that was a 274 MB nodes file; reading all 16,208 sectors (every
 * streaming level — where the megabuildings actually live) roughly doubles it and adds a
 * ~2.2M-row placements table. WolvenKit ran out of memory and lost a 20-minute run. It now
 * flushes every 2,000 sectors and drops the rows, so memory stays flat.
 *
 * THIS SCRIPT IS ALSO THE INTEGRITY CHECK. A crash mid-run leaves a PARTIAL set of parts,
 * and a partial set concatenates into a perfectly well-formed CSV that is quietly missing a
 * third of Night City — which is precisely the failure mode this whole extractor keeps
 * having. So: the parts must be CONSECUTIVE from 0, every part must carry the same header,
 * and the totals are printed. A gap is a hard error, not a warning.
 */
'use strict';
const fs = require('fs');
const path = require('path');

const RAW = process.argv.includes('--raw')
  ? process.argv[process.argv.indexOf('--raw') + 1]
  : 'd:/Modding/CP2077 Mods/MyMods/map_data_export/source/raw';

function merge(base) {
  const re = new RegExp(`^${base}_p(\\d+)\\.csv$`);
  const parts = [];
  for (const f of fs.readdirSync(RAW)) {
    const m = re.exec(f);
    if (m) parts.push({ n: +m[1], file: f });
  }
  if (!parts.length) {
    console.error(`!! no ${base}_p*.csv parts found in ${RAW}`);
    process.exit(1);
  }
  parts.sort((a, b) => a.n - b.n);

  // CONSECUTIVE FROM ZERO, or we are silently dropping sectors.
  for (let i = 0; i < parts.length; i++) {
    if (parts[i].n !== i) {
      console.error(`!! ${base}: parts are not consecutive — expected p${i}, found p${parts[i].n}.`);
      console.error('   A missing part means the run died partway. Do NOT use this data; re-run the dump.');
      process.exit(2);
    }
  }

  const out = path.join(RAW, `${base}.csv`);
  const fd = fs.openSync(out, 'w');
  let header = null, rows = 0;
  for (const p of parts) {
    const txt = fs.readFileSync(path.join(RAW, p.file), 'utf8');
    const nl = txt.indexOf('\n');
    const h = (nl < 0 ? txt : txt.slice(0, nl)).replace(/\r$/, '');
    if (header === null) {
      header = h;
      fs.writeSync(fd, header + '\n');
    } else if (h !== header) {
      console.error(`!! ${p.file} has a different header than p0 — the parts are from different runs.`);
      console.error(`   p0: ${header}`);
      console.error(`   ${p.file}: ${h}`);
      process.exit(3);
    }
    if (nl < 0) continue;                       // header-only part (an empty tail chunk)
    let body = txt.slice(nl + 1);
    if (body.length && !body.endsWith('\n')) body += '\n';
    if (body.length) {
      fs.writeSync(fd, body);
      rows += body.split('\n').length - 1;
    }
  }
  fs.closeSync(fd);
  const mb = fs.statSync(out).size / 1048576;
  console.log(`${base}.csv  <-  ${parts.length} parts   ${rows.toLocaleString()} rows   ${mb.toFixed(0)} MB`);
  return { parts: parts.length, rows };
}

const nodes = merge('ncz_nodes');
const inst = merge('ncz_instances');

if (nodes.parts !== inst.parts) {
  console.error(`\n!! ${nodes.parts} node parts but ${inst.parts} instance parts — they are flushed together, so this cannot happen in a clean run.`);
  process.exit(4);
}

console.log('\nDelete the parts once you are happy:');
console.log(`  rm "${RAW}"/ncz_nodes_p*.csv "${RAW}"/ncz_instances_p*.csv`);
