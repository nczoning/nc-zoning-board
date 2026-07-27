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

// World extent in CET units, from the Realistic Map 8k terrain quad UV mapping.
// Same four numbers as NCZ.WORLD_MIN_X/MAX_X/MIN_Y/MAX_Y in
// assets/js/constants.js; derivation and why the TweakDB bounds differ are in
// docs/coordinate-system.md.
//
// These are a RENDERABILITY limit, not a guess at a typical range: the whole
// CET-to-Leaflet transform is derived from them, so a pin outside cannot be
// projected onto the map at all.
//
// The website enforced +/-5000 on X/Y and +/-1000 on Z instead. Measured against
// the 297 live records on 2026-07-27, that rule rejects four of them: Sea Wall
// Towers Detailed at x=-5782, two canyon locations at x=5321, and Crystal Palace
// Resort at z=1525. All four arrived through the git PR path, which never ran
// the browser check, so the rule has been wrong in the browser without ever
// being able to reject anything. Do not port those numbers here.
export const WORLD_MIN_X = -6298;
export const WORLD_MAX_X = 5815;
export const WORLD_MIN_Y = -7684;
export const WORLD_MAX_Y = 4427;

// Z has no authoritative bound: it is elevation, and nothing projects from it.
// This is an explicit sanity range for catching garbage, not a geometry rule.
// Observed across the 297 live records: -10.1 to 1524.6, the maximum being
// Crystal Palace Resort, which is in orbit. The ceiling is set well clear of
// that so nothing legitimate is refused.
export const COORD_Z_MIN = -1000;
export const COORD_Z_MAX = 3000;
