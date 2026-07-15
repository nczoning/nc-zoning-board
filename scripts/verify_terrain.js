// IS OUR TERRAIN MESH ACCURATE?
//
// Method: things that REST ON THE GROUND carry an exact Z. Road and pavement kit lies flat on the
// surface with its origin at ground level. Sample our terrain mesh at each one's (x,y) and measure
//     residual = terrainHeight(x, y) - placement.z
// A tight distribution around 0 means the terrain is honest. A constant offset means it is shifted
// and fixable with a number. A fat tail names the places it is wrong.
//
// Coordinates: the terrain GLB is in THREE space, and CET (x,y,z) -> THREE (x, z, -y). So to
// sample terrain under a CET point (cx, cy) I look up THREE (cx, -cy); the surface Y there is the
// CET z of the ground. (learnings/box-frame-is-cet-shader-frame-is-three, coordinate-system-3d)
'use strict';
const fs = require('fs');
const path = require('path');
const readline = require('readline');

const RAW = 'd:/Modding/CP2077 Mods/MyMods/map_data_export/source/raw';
const GLB = 'd:/Modding/cp2077-location-mods-map/assets/glb-source/3dmap_terrain.glb';

// ── load the terrain GLB: all submeshes -> one triangle soup in THREE space ──
function loadTerrain() {
  const buf = fs.readFileSync(GLB);
  const jlen = buf.readUInt32LE(12);
  const json = JSON.parse(buf.slice(20, 20 + jlen).toString('utf8'));
  const binChunkOffset = 20 + jlen + 8;                 // skip JSON chunk + BIN chunk header
  const bin = buf.slice(binChunkOffset);
  const CT = { 5126: Float32Array, 5123: Uint16Array, 5125: Uint32Array };
  const read = (ai) => {
    const acc = json.accessors[ai];
    const bv = json.bufferViews[acc.bufferView];
    const off = (bv.byteOffset || 0) + (acc.byteOffset || 0);
    const comp = { SCALAR: 1, VEC2: 2, VEC3: 3 }[acc.type];
    const Ctor = CT[acc.componentType];
    return new Ctor(bin.buffer, bin.byteOffset + off, acc.count * comp);
  };
  const tris = [];       // each: [ax,az,ay, bx,bz,by, cx,cz,cy] (THREE)
  for (const m of json.meshes) {
    for (const p of m.primitives) {
      const pos = read(p.attributes.POSITION);
      const idx = read(p.indices);
      for (let i = 0; i < idx.length; i += 3) {
        const t = [];
        for (const k of [idx[i], idx[i + 1], idx[i + 2]]) { t.push(pos[k * 3], pos[k * 3 + 1], pos[k * 3 + 2]); }
        tris.push(t);
      }
    }
  }
  return tris;
}

// ── spatial hash over (x,z) so a point query is O(1) ──
const GRID = 64;   // m
const gkey = (x, z) => `${Math.floor(x / GRID)},${Math.floor(z / GRID)}`;
function indexTris(tris) {
  const buckets = new Map();
  for (const t of tris) {
    const minx = Math.min(t[0], t[3], t[6]), maxx = Math.max(t[0], t[3], t[6]);
    const minz = Math.min(t[2], t[5], t[8]), maxz = Math.max(t[2], t[5], t[8]);
    for (let gx = Math.floor(minx / GRID); gx <= Math.floor(maxx / GRID); gx++) {
      for (let gz = Math.floor(minz / GRID); gz <= Math.floor(maxz / GRID); gz++) {
        const k = `${gx},${gz}`;
        let b = buckets.get(k); if (!b) buckets.set(k, b = []);
        b.push(t);
      }
    }
  }
  return buckets;
}

// height of the terrain at THREE (x,z): find the triangle containing it, barycentric-interpolate Y
function heightAt(buckets, x, z) {
  const b = buckets.get(gkey(x, z));
  if (!b) return null;
  for (const t of b) {
    const [ax, ay, az, bx, by, bz, cx, cy, cz] = t;
    // barycentric in the (x,z) plane
    const d = (bz - cz) * (ax - cx) + (cx - bx) * (az - cz);
    if (Math.abs(d) < 1e-9) continue;
    const wa = ((bz - cz) * (x - cx) + (cx - bx) * (z - cz)) / d;
    const wb = ((cz - az) * (x - cx) + (ax - cx) * (z - cz)) / d;
    const wc = 1 - wa - wb;
    if (wa >= -0.01 && wb >= -0.01 && wc >= -0.01) return wa * ay + wb * by + wc * cy;
  }
  return null;
}

function readCsv(file) {
  const lines = fs.readFileSync(path.join(RAW, file), 'utf8').split(/\r?\n/);
  const head = lines[0].split(',');
  const out = [];
  for (let i = 1; i < lines.length; i++) {
    const L = lines[i]; if (!L) continue;
    const f = []; let cur = '', q = false;
    for (const ch of L) {
      if (ch === '"') q = !q;
      else if (ch === ',' && !q) { f.push(cur); cur = ''; }
      else cur += ch;
    }
    f.push(cur);
    const o = {}; head.forEach((h, k) => { o[h] = f[k]; });
    out.push(o);
  }
  return out;
}

// Ground-resting categories, split by how tightly they lock to the natural terrain.
// ROADS are the trap: Night City's network is heavily ELEVATED (freeways, overpasses, Pacifica
// stilts), so a road mesh is often 10-50 m above the ground and is NOT a terrain sample. The
// terrain-edge kit (riverbank, retaining wall) is the honest one — it is literally the lip of the
// terrain. Report each separately; if they disagree, the roads were the contamination.
const CATS = [
  ['riverbank', /riverbank/i],
  ['retaining_wall', /retaining_wall/i],
  ['sidewalk/curb', /sidewalk|curb|pavement|crosswalk/i],
  ['road', /(^|[\\/])road|asphalt|highway|freeway/i],
];
const GROUND = /road|sidewalk|pavement|curb|crosswalk|riverbank|retaining_wall|street_kit|asphalt|ground_|highway|freeway/i;
const catOf = (p) => { for (const [n, re] of CATS) if (re.test(p)) return n; return 'other'; };

(async () => {
  console.log('\nloading terrain…');
  const tris = loadTerrain();
  const buckets = indexTris(tris);
  console.log(`  ${tris.length.toLocaleString()} triangles, ${buckets.size.toLocaleString()} grid cells`);

  const aPath = {};
  for (const a of readCsv('ncz_assets.csv')) aPath[a.id] = a.path || '';

  const resid = [];
  const byCat = new Map();
  const byElev = new Map();
  let sampled = 0, offMesh = 0;

  // coordinate sanity check: sample the terrain at a few CET points and print the height, so a
  // wrong mapping shows up as nonsense here rather than hiding inside the residual.
  console.log('\ncoordinate sanity — terrain height at CET points:');
  for (const [name, cx, cy] of [['map centre', 0, 0], ['Arasaka Wf', -2200, 2200], ['Badlands E', 4500, -1400]]) {
    const h = heightAt(buckets, cx, -cy);
    console.log(`  ${name.padEnd(12)} CET(${cx},${cy})  ->  terrain ${h === null ? 'OFF MESH' : h.toFixed(1) + ' m'}`);
  }

  const stream = async (file, hasInst) => {
    const rl = readline.createInterface({ input: fs.createReadStream(path.join(RAW, file)), crlfDelay: Infinity });
    let COL = null;
    for await (const line of rl) {
      if (!line) continue;
      if (!COL) { COL = {}; line.split(',').forEach((h, i) => { COL[h] = i; }); continue; }
      const f = line.split(',');
      if (hasInst && Math.max(1, +f[COL.inst] || 1) > 1) continue;
      const p = aPath[f[COL.asset]] || '';
      if (!GROUND.test(p)) continue;
      const cx = +f[COL.x], cy = +f[COL.y], cz = +f[COL.z];
      if (!Number.isFinite(cx) || !Number.isFinite(cy) || !Number.isFinite(cz)) continue;
      const h = heightAt(buckets, cx, -cy);       // THREE (cx, -cy)
      if (h === null) { offMesh++; continue; }
      const r = h - cz;
      resid.push(r);
      const c = catOf(p);
      let cc = byCat.get(c); if (!cc) byCat.set(c, cc = []);
      cc.push(r);
      // bin the terrain-locked kit by elevation, to tell a constant offset from a shape error
      if (c === 'riverbank' || c === 'retaining_wall') {
        const band = Math.floor(h / 25) * 25;
        let eb = byElev.get(band); if (!eb) byElev.set(band, eb = []);
        eb.push(r);
      }
      sampled++;
    }
  };
  await stream('ncz_instances.csv', true);
  await stream('ncz_nodes.csv', false);

  resid.sort((a, b) => a - b);
  const q = (p) => resid[Math.floor(resid.length * p)] || 0;
  const mean = resid.reduce((s, r) => s + r, 0) / (resid.length || 1);
  const within = (m) => (100 * resid.filter((r) => Math.abs(r) <= m).length / resid.length).toFixed(1);

  console.log(`\n=== TERRAIN RESIDUAL: terrainHeight(x,y) - groundObject.z   (metres)\n`);
  console.log(`  ground-resting samples : ${sampled.toLocaleString()}`);
  console.log(`  off the terrain mesh   : ${offMesh.toLocaleString()}\n`);
  console.log(`  mean   ${mean.toFixed(2)} m`);
  console.log(`  median ${q(0.5).toFixed(2)} m`);
  console.log(`  p05 ${q(0.05).toFixed(2)}   p25 ${q(0.25).toFixed(2)}   p75 ${q(0.75).toFixed(2)}   p95 ${q(0.95).toFixed(2)}`);
  console.log('');
  console.log(`  within 0.5 m : ${within(0.5)}%`);
  console.log(`  within 1 m   : ${within(1)}%`);
  console.log(`  within 2 m   : ${within(2)}%`);
  console.log(`  within 5 m   : ${within(5)}%`);
  console.log('\n=== BY CATEGORY — riverbank/retaining are terrain-locked; road is often ELEVATED\n');
  console.log('  category         n         median    p25      p75    within1m');
  console.log('  ' + '-'.repeat(58));
  for (const [c, arr] of [...byCat].sort((a, b) => b[1].length - a[1].length)) {
    arr.sort((a, b) => a - b);
    const m = arr[Math.floor(arr.length * 0.5)];
    const lo = arr[Math.floor(arr.length * 0.25)];
    const hi = arr[Math.floor(arr.length * 0.75)];
    const w1 = (100 * arr.filter((r) => Math.abs(r) <= 1).length / arr.length).toFixed(0);
    console.log(`  ${c.padEnd(15)} ${String(arr.length).padStart(7)}  ${m.toFixed(1).padStart(7)}  ${lo.toFixed(1).padStart(6)}  ${hi.toFixed(1).padStart(6)}   ${w1.padStart(4)}%`);
  }
  console.log('');
  console.log('  if riverbank/retaining are TIGHT and road is not => terrain is fine, roads elevated');
  console.log('  if EVERYTHING is off  => the terrain itself is offset from the world dump');

  console.log('\n=== CONSTANT OFFSET, OR SHAPE ERROR?  (terrain-locked kit, binned by elevation)\n');
  console.log('  terrain height   n        median residual');
  console.log('  ' + '-'.repeat(44));
  for (const [band, arr] of [...byElev].sort((a, b) => a[0] - b[0])) {
    if (arr.length < 50) continue;
    arr.sort((a, b) => a - b);
    const m = arr[Math.floor(arr.length * 0.5)];
    const bar = (m < 0 ? '<' : '>').repeat(Math.min(40, Math.round(Math.abs(m))));
    console.log(`  ${String(band).padStart(5)}..${String(band + 25).padStart(4)} m  ${String(arr.length).padStart(7)}   ${m.toFixed(1).padStart(6)}  ${bar}`);
  }
  console.log('');
  console.log('  FLAT line across elevations => constant offset, one number fixes it');
  console.log('  GROWS with elevation        => shape error, the terrain is decimated/smoothed');
})();
