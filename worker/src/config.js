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
