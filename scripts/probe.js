#!/usr/bin/env node
/**
 * probe.js: what stands at a CET point, in stage 1 AND in the final hull,
 * side by side. The zone-to-asset diagnosis route as one command.
 *
 * Usage:
 *   node scripts/probe.js <x> <y> [--zmin a] [--zmax b] [--span n]
 *   node scripts/probe.js --zones <export.json>     # zone-tool Export file
 *
 * The district is auto-detected from the point via the subdistrict polygons;
 * stage-1 output names the placements (mesh, type, level), the hull output
 * shows what the cloud actually built there. A placement present in stage 1
 * but absent from the hull was cut or merged away; present in neither means
 * the dump does not have it (the compose:true class).
 */
'use strict';

const fs = require('fs');
const path = require('path');

const dataDir = path.join(__dirname, '..', 'data');
const sd = require(path.join(dataDir, 'subdistricts.json'));
const { polygonBounds, inPolygon } = require('./district_meta');

const argv = process.argv.slice(2);
const opt = (k, d) => { const i = argv.indexOf(`--${k}`); return i >= 0 ? argv[i + 1] : d; };
const SPAN = Number(opt('span', 10));

function districtOf(x, y) {
  for (const d of sd.districts) {
    if (!d.polygon) continue;
    const [x0, y0, x1, y1] = polygonBounds(d.polygon);
    if (x < x0 || x > x1 || y < y0 || y > y1) continue;
    if (inPolygon(d.polygon, x, y)) return d.id;
  }
  return null;
}

function probePoint(x, y, zmin, zmax) {
  const district = districtOf(x, y);
  if (!district) { console.log(`(${x}, ${y}): outside every district polygon`); return; }
  console.log(`\n=== (${x}, ${y}) z ${zmin}..${zmax} [${district}] ===`);

  const metaFile = path.join(dataDir, `district-boxes-${district}.json`);
  if (!fs.existsSync(metaFile)) { console.log(`  no stage-1 data for ${district}`); return; }
  const meta = JSON.parse(fs.readFileSync(metaFile, 'utf8'));
  const raw = fs.readFileSync(path.join(dataDir, `district-boxes-${district}.bin`));
  const box = new Float32Array(raw.buffer, raw.byteOffset, raw.length / 4);
  const S = meta.stride, TYPE = meta.types || {}, PATHS = meta.assetPaths || {};

  const aabb = (o, f) => {
    const qx = f[o + 6], qy = f[o + 7], qz = f[o + 8], qw = f[o + 9];
    const m00 = 1 - 2 * (qy * qy + qz * qz), m01 = 2 * (qx * qy - qz * qw);
    const m10 = 2 * (qx * qy + qz * qw), m11 = 1 - 2 * (qx * qx + qz * qz);
    return [Math.abs(m00) * f[o + 3] + Math.abs(m01) * f[o + 4], Math.abs(m10) * f[o + 3] + Math.abs(m11) * f[o + 4]];
  };

  const s1 = [];
  for (let i = 0; i < meta.boxes; i++) {
    const o = i * S;
    const [ex, ey] = aabb(o, box);
    if (Math.abs(x - box[o]) > ex || Math.abs(y - box[o + 1]) > ey) continue;
    if (box[o + 2] + box[o + 5] < zmin || box[o + 2] - box[o + 5] > zmax) continue;
    const span = Math.max(box[o + 3], box[o + 4]) * 2;
    if (span < SPAN) continue;
    s1.push({
      span, dims: `${(box[o + 3] * 2).toFixed(0)}x${(box[o + 4] * 2).toFixed(0)}x${(box[o + 5] * 2).toFixed(0)}`,
      z: `${(box[o + 2] - box[o + 5]).toFixed(0)}..${(box[o + 2] + box[o + 5]).toFixed(0)}`,
      type: TYPE[box[o + 11]] || '?', level: box[o + 12],
      tail: (PATHS[box[o + 10]] || '?').split('\\').pop(),
    });
  }
  s1.sort((a, b) => b.span - a.span);
  console.log(`  stage 1: ${s1.length} placements >= ${SPAN} m span`);
  for (const h of s1.slice(0, 12)) {
    console.log(`  ${String(h.span.toFixed(0)).padStart(6)} m  ${h.dims.padStart(13)}  z ${h.z.padStart(9)}  L${h.level}  ${h.type}  ${h.tail}`);
  }

  const hullFile = path.join(dataDir, `district-hull-${district}.bin`);
  if (!fs.existsSync(hullFile)) { console.log(`  no hull for ${district}`); return; }
  const hraw = fs.readFileSync(hullFile);
  const hf = new Float32Array(hraw.buffer, hraw.byteOffset, hraw.length / 4);
  const hull = [];
  for (let i = 0; i < hf.length / 10; i++) {
    const o = i * 10;
    const [ex, ey] = aabb(o, hf);
    if (Math.abs(x - hf[o]) > ex || Math.abs(y - hf[o + 1]) > ey) continue;
    if (hf[o + 2] + hf[o + 5] < zmin || hf[o + 2] - hf[o + 5] > zmax) continue;
    hull.push({
      span: Math.max(hf[o + 3], hf[o + 4]) * 2,
      dims: `${(hf[o + 3] * 2).toFixed(0)}x${(hf[o + 4] * 2).toFixed(0)}x${(hf[o + 5] * 2).toFixed(0)}`,
      z: `${(hf[o + 2] - hf[o + 5]).toFixed(0)}..${(hf[o + 2] + hf[o + 5]).toFixed(0)}`,
      oriented: Math.abs(hf[o + 8]) > 1e-3 || Math.abs(hf[o + 6]) > 1e-3 ? 'oriented' : 'axis',
    });
  }
  hull.sort((a, b) => b.span - a.span);
  console.log(`  hull: ${hull.length} boxes`);
  for (const h of hull.slice(0, 12)) {
    console.log(`  ${String(h.span.toFixed(0)).padStart(6)} m  ${h.dims.padStart(13)}  z ${h.z.padStart(9)}  ${h.oriented}`);
  }
}

const zonesFile = opt('zones', null);
if (zonesFile) {
  const j = JSON.parse(fs.readFileSync(zonesFile, 'utf8'));
  for (const z of j.zones || []) {
    const cx = z.footprint.reduce((s, p) => s + p[0], 0) / z.footprint.length;
    const cy = z.footprint.reduce((s, p) => s + p[1], 0) / z.footprint.length;
    console.log(`\n### zone "${z.name}" centroid (${cx.toFixed(0)}, ${cy.toFixed(0)})`);
    probePoint(cx, cy, z.minZ ?? -100, z.maxZ ?? 1000);
  }
} else {
  const [x, y] = argv.filter(a => !a.startsWith('--') && a !== opt('span', null) && a !== opt('zmin', null) && a !== opt('zmax', null)).map(Number);
  if (!Number.isFinite(x) || !Number.isFinite(y)) {
    console.error('usage: node scripts/probe.js <x> <y> [--zmin a] [--zmax b] [--span n] | --zones export.json');
    process.exit(1);
  }
  probePoint(x, y, Number(opt('zmin', -100)), Number(opt('zmax', 1000)));
}
