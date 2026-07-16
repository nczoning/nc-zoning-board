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
