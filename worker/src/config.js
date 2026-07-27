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

// Submission bounds: the extent of the 3D map terrain mesh, which is the outer
// envelope of anything this site can render in either view.
//
// Measured from assets/glb-meshopt/3dmap_terrain.glb on 2026-07-27, applying the
// node transform to the quantised POSITION accessors: X [-7999.3, 7999.4] and
// world Y [-8000.1, 8000.9], a symmetric 16km square. The water sheet sits
// inside it at X [-7998, 7439], world Y [-7329, 5958].
//
// NOT the same as NCZ.WORLD_MIN_X/MAX_X/MIN_Y/MAX_Y in assets/js/constants.js,
// which are X [-6298, 5815] and Y [-7684, 4427]. Those describe the satellite
// TILE projection, so they are the right numbers for the CET-to-Leaflet
// transform and the wrong ones for a submission gate: they are tighter than the
// terrain in every direction, and a location on rendered ground outside them
// would be refused for being outside a picture rather than outside the world.
//
// The website enforced +/-5000 on X/Y and +/-1000 on Z instead. Those appear to
// be stale leftovers. Measured against the 297 live records, that rule rejects
// four of them: Sea Wall Towers Detailed at x=-5782, two canyon locations at
// x=5321, and Crystal Palace Resort at z=1525. All four arrived through the git
// PR path, which never ran the browser check, so the rule has been wrong in the
// browser without ever being able to reject anything. Do not port those numbers.
export const WORLD_MIN_X = -8000;
export const WORLD_MAX_X = 8000;
export const WORLD_MIN_Y = -8000;
export const WORLD_MAX_Y = 8000;

// Z has no mesh to measure against: it is elevation, and nothing projects from
// it. An explicit sanity range for catching garbage, not a geometry rule.
// Observed across the 297 live records: -10.1 to 1524.6, the maximum being
// Crystal Palace Resort, which is in orbit and is expected to stay the ceiling.
export const COORD_Z_MIN = -1000;
export const COORD_Z_MAX = 2000;
