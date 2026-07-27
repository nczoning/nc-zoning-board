/**
 * Shared dataset config. Single source of truth for values that must agree
 * across the merge (which computes the recency bool) and the request handler
 * (which publishes the window on the envelope).
 */

// "Recently updated" window, in days. A location's recently_updated bool is
// computed against this in merge.js; the value is published on every response
// envelope as recently_updated_days so clock-having consumers (and humans)
// read the rule rather than hardcoding it. The website's own constant is only
// a fallback for when the API is unavailable.
export const RECENTLY_UPDATED_DAYS = 7;

// Minimum gap between liveness-heartbeat writes on an UNCHANGED cron tick.
//
// The cron rebuilds every 5 min but writes KV only when the content hash moves
// (see refresh.js). The #849 heartbeat deliberately bypassed that gate to prove
// scheduled() is still running — which reintroduced exactly the per-tick write
// cost the hash gate existed to remove: 288 writes/day/env against a free-tier
// cap of 1,000 per ACCOUNT. Rate-limiting the heartbeat keeps the liveness
// signal while cutting idle writes to ~96/day.
//
// PAIRED CONSTANT: scripts/monitor_api_health.js MAX_REFRESH_AGE_S must stay
// comfortably above this (currently 45 min = 3x). If the alarm ever drops below
// the write interval, a healthy idle cron pages the alerts channel AND triggers
// a self-heal redeploy. Never change one without the other.
export const HEARTBEAT_MIN_INTERVAL_MS = 15 * 60 * 1000;

// Coordinate bounds for the write path: the extent of the 3D map terrain mesh,
// which is the outer envelope of anything renderable in either view.
//
// Measured from assets/glb-meshopt/3dmap_terrain.glb, applying the node
// transform to the quantised POSITION accessors: a symmetric 16km square, X
// [-7999.3, 7999.4] and world Y [-8000.1, 8000.9]. The water sheet sits inside
// it.
//
// DELIBERATELY NOT NCZ.WORLD_MIN_X and friends (assets/js/constants.js), which
// are X [-6298, 5815], Y [-7684, 4427]. Those describe the satellite TILE
// projection: correct for the CET-to-Leaflet transform, wrong as a gate. They
// are tighter than the terrain in every direction, so they would refuse a
// location standing on rendered ground for being outside a picture. Named
// TERRAIN_* rather than WORLD_* so the two are not synced by mistake.
//
// Do NOT adopt the browser form's +/-5000 on X/Y and +/-1000 on Z. That rule
// rejects four records live on the map today (x=-5782, two at x=5321, and
// z=1525), and never rejected anything because every one of them arrived
// through the PR path rather than the form.
export const TERRAIN_MIN_X = -8000;
export const TERRAIN_MAX_X = 8000;
export const TERRAIN_MIN_Y = -8000;
export const TERRAIN_MAX_Y = 8000;

// Z has no mesh to measure against: it is elevation, and nothing projects from
// it. An explicit sanity range for catching garbage, not a geometry rule.
// Observed across the 297 live records: -10.1 to 1524.6, the maximum being
// Crystal Palace Resort, which is in orbit and is expected to stay the ceiling.
export const COORD_Z_MIN = -1000;
export const COORD_Z_MAX = 2000;
