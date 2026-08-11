/**
 * District/subdistrict assignment: server-side port of the client logic
 * (assets/js/utils.js pointInPolygon/polygonCentroid + the resolveArea
 * rule in assets/js/district-info.js). Polygons come from
 * data/subdistricts.json and are in CET world coordinates, the same space
 * as location `coordinates`; no transforms anywhere.
 */

/** Ray-casting point-in-polygon. `point` and `ring` vertices share a space. */
export function pointInPolygon(point, ring) {
  if (!ring || ring.length < 3) return false;
  const [px, py] = point;
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i][0], yi = ring[i][1];
    const xj = ring[j][0], yj = ring[j][1];
    const intersects = (yi > py) !== (yj > py) &&
      px < ((xj - xi) * (py - yi)) / (yj - yi) + xi;
    if (intersects) inside = !inside;
  }
  return inside;
}

/** Area-weighted (shoelace) centroid; vertex average for degenerate rings. */
export function polygonCentroid(ring) {
  if (!ring || ring.length === 0) return null;
  let a = 0, cx = 0, cy = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const cross = ring[j][0] * ring[i][1] - ring[i][0] * ring[j][1];
    a += cross;
    cx += (ring[j][0] + ring[i][0]) * cross;
    cy += (ring[j][1] + ring[i][1]) * cross;
  }
  a *= 0.5;
  if (Math.abs(a) < 1e-6) {
    let sx = 0, sy = 0;
    for (const p of ring) { sx += p[0]; sy += p[1]; }
    return [sx / ring.length, sy / ring.length];
  }
  return [cx / (6 * a), cy / (6 * a)];
}

/** Absolute shoelace area; smallest containing polygon wins. */
function polyArea(ring) {
  let a = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    a += (ring[j][0] + ring[i][0]) * (ring[j][1] - ring[i][1]);
  }
  return Math.abs(a) / 2;
}

/**
 * Resolve the most specific area for a CET [x, y] point: the smallest-area
 * subdistrict containing it (and that sub's parent district), else the
 * smallest containing district polygon. Mirrors district-info.js
 * resolveArea so the API and the map can never disagree.
 *
 * @param {number[]} pt CET [x, y]
 * @param {Array} districts subdistricts.json `districts[]`
 * @returns {{district: object, subdistrict: object|null}|null}
 */
export function resolveArea(pt, districts) {
  let sub = null, subArea = Infinity, dist = null;
  for (const d of districts) {
    for (const s of d.subdistricts || []) {
      if (s.polygon?.length && pointInPolygon(pt, s.polygon)) {
        const a = polyArea(s.polygon);
        if (a < subArea) { subArea = a; sub = s; dist = d; }
      }
    }
  }
  if (!sub) {
    let dArea = Infinity;
    for (const d of districts) {
      if (d.polygon?.length && pointInPolygon(pt, d.polygon)) {
        const a = polyArea(d.polygon);
        if (a < dArea) { dArea = a; dist = d; }
      }
    }
  }
  return dist ? { district: dist, subdistrict: sub } : null;
}

/**
 * The game's default district: anywhere outside every district polygon is
 * Badlands (so it has no polygon of its own: its subdistricts
 * are trigger areas transformed into polygons for the map, but the parent
 * is the catch-all). The API mirrors that rule so in-game consumers and
 * the game itself can never disagree.
 */
const DEFAULT_DISTRICT_ID = 'badlands';

/**
 * District/subdistrict names for a location's CET coordinates. Points
 * outside every polygon default to Badlands (game behaviour); nulls only
 * if the dataset has no default district at all (fixtures).
 */
export function assignDistrict(coordinates, districts) {
  const hit = resolveArea([coordinates[0], coordinates[1]], districts);
  if (hit) {
    return {
      district: hit.district.name,
      subdistrict: hit.subdistrict ? hit.subdistrict.name : null,
    };
  }
  const fallback = districts.find((d) => d.id === DEFAULT_DISTRICT_ID);
  return { district: fallback ? fallback.name : null, subdistrict: null };
}

/**
 * /v1/districts payload: hierarchy with names, centroids and FLATTENED
 * boundaries ([x1,y1,x2,y2,...]): the DTO contract forbids
 * arrays-of-arrays (RedData FromJson limit).
 */
export function districtsPayload(districts) {
  const flat = (ring) => ring.flat();
  return districts.map((d) => ({
    id: d.id ?? null,
    name: d.name,
    centroid: centroidObj(d.polygon),
    boundary: flat(d.polygon || []),
    subdistricts: (d.subdistricts || []).map((s) => ({
      id: s.id ?? null,
      name: s.name,
      canonical: s.canonical !== false,
      centroid: centroidObj(s.polygon),
      boundary: flat(s.polygon || []),
    })),
  }));
}

function centroidObj(ring) {
  const c = polygonCentroid(ring);
  return c ? { x: c[0], y: c[1] } : null;
}
