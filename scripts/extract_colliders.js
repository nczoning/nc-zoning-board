#!/usr/bin/env node
/**
 * scripts/extract_colliders.js
 * ─────────────────────────────────────────────────────────────────────────
 * Extract the game's own 3D-map building COLLISION boxes into
 * data/3dmap-colliders.json, for the `?colldebug` view.
 *
 * Where they come from
 * ───────────────────
 * `base\entities\cameras\3dmap\3dmap_coll_buildings{,2,3}.mesh`. Their RENDER
 * buffers are 6-vertex stubs; the payload is
 * `parameters[0].physicsData.bodies[0].collisionShapes`, an array of
 * `physicsColliderBox` — position + quaternion + halfExtents, i.e. the SAME
 * encoding as a `_data.dds` instance, ~26× coarser.
 *
 * They are a coarse COLLISION SURFACE, not an object partition. No decompiled
 * script references `3dmap` at all, and they sit beside 3dmap_cursor.ent and
 * 3dmap_coll_roads — almost certainly what the custom-waypoint cursor lands on.
 * They overlap heavily (43% of render boxes sit in 2+ colliders). Useful because
 * they are structure-scale, not because they carry identity.
 *
 * IMPORTANT — which files
 * ──────────────────────
 * ONLY the three listed in `3dmap_view.ent`. A fourth file, `3dmap_coll_santo`
 * (3,092 shapes), exists on disk but is NOT referenced by the entity — it is an
 * orphan/superseded asset that spatially overlaps the others. Including it adds
 * 0.2% coverage and a lot of confusion. Don't.
 *
 * Coordinates are CET world (Z up), exactly as the shapes store them.
 * Output rows: [px, py, pz, qi, qj, qk, qr, hx, hy, hz]
 *
 * Run: node scripts/extract_colliders.js
 */
'use strict';

const fs = require('fs');
const path = require('path');

const SRC_DIR = 'd:/Modding/CP2077 Mods/MyMods/map_data_export/source/raw/base/entities/cameras/3dmap';
// Exactly the meshes 3dmap_view.ent references. See the header note re: coll_santo.
const FILES = ['3dmap_coll_buildings.mesh.json', '3dmap_coll_buildings2.mesh.json', '3dmap_coll_buildings3.mesh.json'];
const OUT = path.join(__dirname, '..', 'data', '3dmap-colliders.json');

const r = (v, n) => Number(v.toFixed(n));
const rows = [];

for (const f of FILES) {
  const p = path.join(SRC_DIR, f);
  if (!fs.existsSync(p)) {
    console.error(`[colliders] MISSING ${p}\n  Export it from WolvenKit (Convert to JSON) first.`);
    process.exit(1);
  }
  const j = JSON.parse(fs.readFileSync(p, 'utf8'));
  const bodies = j.Data?.RootChunk?.parameters?.[0]?.Data?.physicsData?.Data?.bodies || [];
  let n = 0;
  for (const b of bodies) {
    let boxes = 0;
    for (const s of b.Data.collisionShapes) {
      const d = s.Data;
      if (d.$type !== 'physicsColliderBox') continue;
      const p3 = d.localToBody.position, q = d.localToBody.orientation, h = d.halfExtents;
      rows.push([r(p3.X, 2), r(p3.Y, 2), r(p3.Z, 2), r(q.i, 5), r(q.j, 5), r(q.k, 5), r(q.r, 5), r(h.X, 2), r(h.Y, 2), r(h.Z, 2)]);
      boxes++;
    }
    const skipped = b.Data.collisionShapes.length - boxes;
    if (skipped > 0) console.warn(`[colliders] ${f}: skipped ${skipped} non-box shapes (only physicsColliderBox is handled)`);
    n += boxes;
  }
  console.log(`[colliders] ${f}: ${n} boxes`);
}

const out = {
  _note: 'Game 3D-map building collision boxes (physicsColliderBox). CET world, Z up. Row = [px,py,pz, qi,qj,qk,qr, hx,hy,hz]. Source: 3dmap_coll_buildings{,2,3}.mesh — the three referenced by 3dmap_view.ent. Regenerate: node scripts/extract_colliders.js',
  count: rows.length,
  colliders: rows,
};
fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, JSON.stringify(out));
console.log(`[colliders] wrote ${rows.length} boxes → ${path.relative(process.cwd(), OUT)} (${(fs.statSync(OUT).size / 1024).toFixed(0)} KB)`);
