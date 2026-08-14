/**
 * asset_category.js: what a placement IS, by path and node type.
 *
 * The box-cloud rebuild started as the night-lighting project: windows and
 * signage are the two emitter classes that light the city after dark. One
 * output (the building cloud) forced everything else into "dropped", which
 * conflated "not a building" with "not needed". Signage is not a building AND
 * is needed, as a light source. So identity is decided here, once, and each
 * consumer picks the categories it wants:
 *
 *   building        the box cloud (real geometry; building proxies join via
 *                   the hull's redundancy probe)
 *   proxy           a stand-in for buildings; the hull decides redundancy
 *   signage         signs, billboards, ad screens: the night scene's second
 *                   emitter class (extract_signage.js)
 *   infrastructure  road decks, plaza plates, pools, sidewalk aprons: the
 *                   roads overlay draws this level, preserved not discarded
 *   boundary        district/subdistrict trigger volumes: never rendered
 *   backdrop        the painted distant-city planes and the ocean sheet:
 *                   scenery for the horizon, not geometry any cloud should
 *                   represent (downtown.mesh is 161,821 m2 on nine triangles)
 *   terrain         the terrain and its proxies: the hull clips against the
 *                   real surface instead
 *   never           occluders, lights, water, foliage, mirrors: helper
 *                   volumes with no visual body
 *
 * FOUR FAMILIES OF NOT-BUILDINGS SHIP TYPED GenericProxyMesh (subdistrict
 * volumes, half the road decks, plaza furniture, signage frames), so node
 * type alone cannot classify; the filename is the gate that held. See
 * wiki learning not-buildings-hide-behind-generic-proxy-type.
 */
'use strict';

const NEVER_TYPES = new Set([
  'StaticOccluderMesh', 'StaticLight', 'WaterPatch', 'Foliage', 'Mirror',
]);

// Proxies live in three places, not one. Matching only the first lets a
// subdistrict proxy through as if it were real geometry.
const isProxy = p =>
  p.includes('\\_external\\proxy\\') || p.includes('\\_proxyhelper\\') || p.endsWith('_mproxy.mesh');
const isTerrain = p => p.includes('\\_global\\terrain\\');
// A subdistrict shell is the trigger volume's geometry: an extruded boundary
// polygon. 269 exist, 216 under any workable size gate, down to 102 m.
const isSubdistrictShell = p => /_subdistrict[^\\]*\.mesh$/i.test(p);
// Anonymous road decks (prxN, typed Road AND Generic), plaza pools, sidewalk
// aprons: surfaces, not buildings.
const isDeckProxy = p => /\\(prx\d*|pool)\.mesh$/i.test(p) || (/_sidewalk/i.test(p) && isProxy(p));
// Signage does not always say Advertisement: the 217x39x258 m
// signage_city_center_glassframe_c is typed GenericProxyMesh.
const isSignage = p => /\\(signage|billboard)_[^\\]*\.mesh$/i.test(p);
// Horizon scenery: between them, backdrops and ocean patches were 93% of the
// area the coverage metric first called holes (211,821 m2 of 228,655).
const isBackdrop = p => p.includes('\\backdrops\\') || /global_ocean_patch/i.test(p);
// Gameplay items are never architecture. The q110 blackout sheets alone stand
// 329x664 m across Coastview (base\items\quest\q110__misc\q110_black_box.mesh,
// z -661..2): quest scenery that reads as a black wall slicing the district.
const isQuestItem = p => p.startsWith('base\\items\\');

/** Identity category for one placement. Size and level policy stay with the consumer. */
function categorize(path, nodeType) {
  const p = path || '';
  if (nodeType === 'Advertisement' || isSignage(p)) return 'signage';
  if (nodeType === 'TerrainProxyMesh' || isTerrain(p)) return 'terrain';
  if (NEVER_TYPES.has(nodeType)) return 'never';
  if (nodeType === 'RoadProxyMesh' || isDeckProxy(p)) return 'infrastructure';
  if (isBackdrop(p)) return 'backdrop';
  if (isQuestItem(p)) return 'never';
  if (isSubdistrictShell(p)) return 'boundary';
  if (isProxy(p)) return 'proxy';
  return 'building';
}

module.exports = { categorize, isProxy, isTerrain, isSubdistrictShell, isDeckProxy, isSignage, isBackdrop, NEVER_TYPES };
