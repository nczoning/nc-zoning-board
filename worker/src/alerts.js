/**
 * The alert fan-out. One place records an alert and one place forwards it, so
 * the dashboard's history is complete by construction rather than by every
 * producer remembering to double-write.
 *
 * Alerts originate from three places: this Worker (refresh failures, quota
 * thresholds, new submissions), and GitHub Actions (`monitor_api_health.js`).
 * In-Worker producers call `raiseAlert()` directly. The Actions monitor cannot,
 * so it POSTs `/internal/alerts`, which is the same function behind a shared
 * secret. There is deliberately no second implementation for the remote path.
 *
 * ## Record before forwarding
 *
 * The table exists precisely so alert history survives Discord burying or
 * dropping a message. Forwarding first and recording second would mean a
 * Discord outage loses the record as well as the notification, which defeats
 * the point of having the table at all.
 *
 * The two steps fail independently and neither blocks the other:
 *
 * - D1 write fails, Discord succeeds: degraded to exactly the old behaviour, a
 *   notification with no history. Still better than silence.
 * - D1 write succeeds, Discord fails: the alert is in the dashboard, which is
 *   the surface that is supposed to outlive Discord.
 *
 * So `raiseAlert()` never throws. An alert about a failure must not become a
 * second failure, and it must never mask the one it is reporting.
 */

/**
 * Recognised sources, matching the `source` column comment in migration 0001.
 *
 * `export` is the nightly D1 snapshot (`.github/workflows/export-d1-snapshot.yml`),
 * which posts through `/internal/alerts` like the health monitor does. It is its
 * own source rather than folded into `refresh`: the 5-minute dataset cron and the
 * nightly git mirror fail for unrelated reasons and are fixed in different places,
 * and the dashboard's source filter is how they are told apart.
 */
export const ALERT_SOURCES = ['api-health', 'refresh', 'submissions', 'quota', 'export'];

/** Recognised severities, matching the `severity` column comment. */
export const ALERT_SEVERITIES = ['info', 'warn', 'error', 'recovery'];

/**
 * Discord embed colours. Amber is the brand warning colour already used by
 * `refresh.js`; green matches its recovery embed. Keeping them here means the
 * channel looks the same whichever producer raised the alert, which is the
 * visible half of "one place fans out".
 */
const SEVERITY_COLOR = {
  info: 0x00f0ff,
  warn: 0xffb300,
  error: 0xe74c3c,
  recovery: 0x2ecc71,
};

const SEVERITY_ICON = {
  info: 'ℹ️',
  warn: '⚠️',
  error: '🚨',
  recovery: '✅',
};

/** Discord rejects an embed description over 4096; stay well clear. */
const BODY_MAX = 1500;

/**
 * Normalise and validate an alert. Returns `{ ok, alert }` or `{ ok, error }`.
 *
 * Exported because `/internal/alerts` validates an untrusted body with it, and
 * the endpoint must reject a bad payload rather than write a row that renders
 * as `undefined` in the dashboard forever.
 */
export function validateAlertInput(input) {
  const errors = [];
  const source = typeof input?.source === 'string' ? input.source.trim() : '';
  const severity = typeof input?.severity === 'string' ? input.severity.trim() : '';
  const title = typeof input?.title === 'string' ? input.title.trim() : '';
  const body = input?.body == null ? null : String(input.body).slice(0, BODY_MAX);

  if (!ALERT_SOURCES.includes(source)) {
    errors.push(`source must be one of: ${ALERT_SOURCES.join(', ')}`);
  }
  if (!ALERT_SEVERITIES.includes(severity)) {
    errors.push(`severity must be one of: ${ALERT_SEVERITIES.join(', ')}`);
  }
  if (!title) errors.push('title is required');
  if (title.length > 200) errors.push('title must be 200 characters or fewer');

  if (errors.length) return { ok: false, errors };
  return { ok: true, alert: { source, severity, title, body } };
}

/**
 * Insert the alert and return its id. Throws on a D1 failure; the caller
 * decides whether that is fatal (it is not, for `raiseAlert`).
 */
export async function recordAlert(env, { source, severity, title, body = null }, nowMs = Date.now()) {
  const { meta } = await env.DB.prepare(
    'INSERT INTO alerts (at, source, severity, title, body) VALUES (?, ?, ?, ?, ?)',
  ).bind(new Date(nowMs).toISOString(), source, severity, title, body).run();
  return meta?.last_row_id ?? null;
}

/**
 * Post the alert to the map-alerts channel.
 *
 * Prefers the dedicated webhook and falls back to the legacy submissions one,
 * matching what `refresh.js` did before this module existed. Both secrets are
 * Cloudflare Worker secrets here; the same names also exist as GitHub Actions
 * secrets and are a SEPARATE store. See `learnings/discord-webhook-two-secret-stores`.
 *
 * Returns true if Discord accepted it, false in every other case including
 * "no webhook configured". Never throws.
 */
export async function forwardToDiscord(env, alert, fetchImpl = fetch) {
  const webhook = env.NCZ_ALERTS_DISCORD_WEBHOOK_URL || env.DISCORD_WEBHOOK_URL;
  if (!webhook) return false;
  try {
    const res = await fetchImpl(webhook, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ embeds: [toEmbed(alert)] }),
    });
    return Boolean(res?.ok);
  } catch {
    return false;
  }
}

/** The embed one alert renders as, in the map-alerts channel. */
function toEmbed({ source, severity, title, body }) {
  return {
    title: `${SEVERITY_ICON[severity] ?? ''} ${title}`.trim(),
    description: body ? String(body).slice(0, BODY_MAX) : undefined,
    color: SEVERITY_COLOR[severity] ?? SEVERITY_COLOR.info,
    footer: { text: `NC Zoning Board • ${source}` },
  };
}

/**
 * Record an alert, then forward it. The one entry point every producer uses.
 *
 * Never throws: see the module comment. The return value reports what actually
 * happened, so a caller that cares (the tests, and `/internal/alerts`) can tell
 * a fully successful fan-out from a half-successful one.
 *
 * @returns {Promise<{id: number|null, recorded: boolean, forwarded: boolean}>}
 */
export async function raiseAlert(env, alert, { fetchImpl = fetch, nowMs = Date.now() } = {}) {
  let id = null;
  let recorded = false;

  if (env.DB) {
    try {
      id = await recordAlert(env, alert, nowMs);
      recorded = true;
    } catch {
      // Fall through and still notify. A missing history row is a degradation;
      // a missing notification is the failure this whole issue exists to fix.
    }
  }

  const forwarded = await forwardToDiscord(env, alert, fetchImpl);
  return { id, recorded, forwarded };
}

/**
 * Has this exact alert already gone out today (UTC)?
 *
 * Used by the quota threshold, which is evaluated on a 5-minute cron: without
 * this it would re-post every tick for the rest of the day once a cap crossed
 * 80%. The alerts table is the dedup store, which only works because recording
 * happens BEFORE forwarding. An ordering chosen so history survives a Discord
 * outage turns out to be what makes "have I already said this" answerable.
 *
 * Day boundary is UTC to match the caps themselves, which reset at UTC
 * midnight (see `quota.js`). A local-midnight window would reopen the alert
 * partway through a quota day and post a duplicate.
 */
export async function alertedSinceUtcMidnight(env, { source, title }, nowMs = Date.now()) {
  if (!env.DB) return false;
  const midnight = new Date(nowMs);
  midnight.setUTCHours(0, 0, 0, 0);
  const row = await env.DB.prepare(
    'SELECT 1 AS hit FROM alerts WHERE source = ? AND title = ? AND at >= ? LIMIT 1',
  ).bind(source, title, midnight.toISOString()).first();
  return Boolean(row);
}

/**
 * Most recent first, matching `readAudit`. `unacknowledged` filters to the ones
 * still needing a human, which is what the dashboard badge counts.
 */
export async function readAlerts(env, { limit = 100, unacknowledged = false } = {}) {
  const capped = Math.min(Math.max(Number(limit) || 100, 1), 500);
  const where = unacknowledged ? 'WHERE acknowledged_at IS NULL' : '';
  const { results } = await env.DB.prepare(
    `SELECT id, at, source, severity, title, body, acknowledged_by, acknowledged_at
       FROM alerts ${where} ORDER BY id DESC LIMIT ?`,
  ).bind(capped).all();
  return results ?? [];
}

/** How many alerts are still waiting on a human. Drives the tab's badge. */
export async function countUnacknowledged(env) {
  const row = await env.DB.prepare(
    'SELECT COUNT(*) AS n FROM alerts WHERE acknowledged_at IS NULL',
  ).first();
  return Number(row?.n ?? 0);
}

/**
 * Acknowledge one alert. Returns the updated row, or null if the id does not
 * exist.
 *
 * Acknowledging an already-acknowledged alert is a no-op that returns the row
 * unchanged rather than an error: two admins clearing the same backlog is
 * expected, and the first one to arrive is the one who dealt with it.
 */
export async function acknowledgeAlert(env, id, actor, nowMs = Date.now()) {
  const numeric = Number(id);
  if (!Number.isInteger(numeric)) return null;
  await env.DB.prepare(
    `UPDATE alerts SET acknowledged_by = ?, acknowledged_at = ?
      WHERE id = ? AND acknowledged_at IS NULL`,
  ).bind(actor, new Date(nowMs).toISOString(), numeric).run();
  return env.DB.prepare(
    `SELECT id, at, source, severity, title, body, acknowledged_by, acknowledged_at
       FROM alerts WHERE id = ?`,
  ).bind(numeric).first();
}
