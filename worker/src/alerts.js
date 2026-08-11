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
 *
 * ## Record everything, notify selectively
 *
 * Every alert is recorded. Only the ones a person can act on are forwarded, via
 * the `notify` flag each producer sets. The channel had drifted into carrying
 * both halves of every automatic recovery loop -- "the cron wedged", "the cron
 * recovered", five minutes apart, with the self-heal doing the work in between
 * -- and a channel that mostly reports things already handled stops being read,
 * which costs the alerts that do need someone.
 *
 * Two rules make this safe to have:
 *
 * - **The producer decides, not this module.** Routing on severity or on a
 *   title match would put the decision somewhere that cannot see the context it
 *   depends on: a `recovery` is silent unless a record was hidden by hand, and a
 *   wedged cron is silent only because a redeploy was actually dispatched. Only
 *   the code raising the alert knows which case it is in.
 * - **The default is to notify.** `notify` omitted means true, so a new producer
 *   that has not thought about routing is noisy rather than silent, and every
 *   row written before this existed reads correctly. Silence is the expensive
 *   failure here; noise is the cheap one.
 *
 * ## Closing an alert closes it in both places
 *
 * An alert is posted once and then EDITED when it is resolved: cyan "!" becomes
 * green "✅", in place, on the original message. The alternative -- a second
 * post saying the first one is handled -- doubles the channel's volume to say
 * nothing new, and the message a reader scrolls back to is still the stale one.
 *
 * This needs the message id, which Discord returns only for a webhook called
 * with `?wait=true`, so that is how every alert is posted. It is stored on the
 * row (`discord_message_id`) because the resolver runs minutes or days later, in
 * a different request, in a different isolate.
 *
 * Editing is strictly best-effort and never gates the acknowledgement. The
 * dashboard is the surface that outlives Discord; a failed edit costs a stale
 * "!" in a channel, which is exactly the cost of not having built this.
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
 * Neutralise Discord formatting in a value this Worker did not author.
 *
 * Everything passing through here is either submitter free text or a GitHub
 * login, and an embed description renders markdown, masked links and mentions.
 * Escaping rather than stripping, so a mod genuinely called `*NCPD*` still
 * reads as its own name.
 *
 * Newlines collapse to spaces because `#` and `>` are formatting only at the
 * start of a line, and a one-line fact cannot have one. `@` gets a zero-width
 * space so `@everyone` in a submitted name pings nobody.
 */
export function escapeDiscord(text, max = 120) {
  return String(text ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max)
    .replace(/[\\*_~`|]/g, (c) => `\\${c}`)
    .replace(/@/g, '@\u200b');
}

/** Plain text for a place that renders no markdown, such as an embed title. */
const plain = (text, max = 120) => String(text ?? '').replace(/\s+/g, ' ').trim().slice(0, max);

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
  // Strict, and only when present. A truthy string ("false", "0", "no") coerced
  // by JavaScript's rules would silently route the opposite way to what the
  // caller wrote, and a routing bug is invisible: the alert simply does not
  // arrive. Omitting it is fine and means "notify" (see the module comment).
  if (input?.notify != null && typeof input.notify !== 'boolean') {
    errors.push('notify must be a boolean when present');
  }
  // The embed's title becomes this link, so it is the one field of an alert
  // that can send a reader somewhere. Restricted to https and to this site's
  // own origins, because `/internal/alerts` is reachable with a shared secret
  // and a clickable off-site link in the alerts channel is a phishing primitive
  // rather than a feature.
  const link = input?.link == null ? null : String(input.link);
  if (link !== null && !/^https:\/\/[^\s]+$/.test(link)) {
    errors.push('link must be an https URL when present');
  }
  // `type:id`, and nothing that would need escaping. This is a lookup key, not
  // anything a person reads.
  const ref = input?.ref == null ? null : String(input.ref);
  if (ref !== null && !/^[a-z]+:[A-Za-z0-9_-]+$/.test(ref)) {
    errors.push('ref must look like "submission:123" when present');
  }

  if (errors.length) return { ok: false, errors };
  return {
    ok: true,
    alert: { source, severity, title, body, link, ref, notify: input?.notify !== false },
  };
}

/**
 * Insert the alert and return its id. Throws on a D1 failure; the caller
 * decides whether that is fatal (it is not, for `raiseAlert`).
 */
export async function recordAlert(
  env, { source, severity, title, body = null, link = null, ref = null, notify = true },
  nowMs = Date.now(),
) {
  const { meta } = await env.DB.prepare(
    `INSERT INTO alerts (at, source, severity, title, body, notify, ref)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).bind(
    new Date(nowMs).toISOString(), source, severity, title, composeBody(body, link),
    notify === false ? 0 : 1, ref,
  ).run();
  return meta?.last_row_id ?? null;
}

/**
 * The body a reader sees, link included.
 *
 * The link lives IN the body rather than in a column of its own, and this one
 * function composes it for both consumers: the stored row and the embed. Two
 * compositions would let the dashboard and Discord show different text for the
 * same alert, and the resolved embed is rebuilt from the row -- so the row's
 * body has to already be the message.
 */
const composeBody = (body, link) => (link ? `${body ? `${body}\n\n` : ''}${link}` : body ?? null);

/** The dedicated alerts webhook, or the legacy submissions one it replaced. */
const webhookUrl = (env) => env.NCZ_ALERTS_DISCORD_WEBHOOK_URL || env.DISCORD_WEBHOOK_URL;

/**
 * Post the alert to the map-alerts channel.
 *
 * Prefers the dedicated webhook and falls back to the legacy submissions one,
 * matching what `refresh.js` did before this module existed. Both secrets are
 * Cloudflare Worker secrets here; the same names also exist as GitHub Actions
 * secrets and are a SEPARATE store. See `learnings/discord-webhook-two-secret-stores`.
 *
 * `?wait=true` makes Discord respond with the created message instead of a bare
 * 204, which is the only way to learn the id needed to edit it later. It costs a
 * slower call and it makes the webhook's own rate limit visible as a failure
 * rather than swallowing it, both of which are worth an alert that can be closed.
 *
 * Returns `{ forwarded, messageId }`. `forwarded` is false in every failure case
 * including "no webhook configured"; `messageId` is null whenever the response
 * did not carry one, which a caller must treat as ordinary. Never throws.
 */
export async function forwardToDiscord(env, alert, fetchImpl = fetch) {
  const webhook = webhookUrl(env);
  if (!webhook) return { forwarded: false, messageId: null };
  try {
    const res = await fetchImpl(withWait(webhook), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ embeds: [toEmbed(alert)] }),
    });
    if (!res?.ok) return { forwarded: false, messageId: null };
    return { forwarded: true, messageId: await readMessageId(res) };
  } catch {
    return { forwarded: false, messageId: null };
  }
}

/** `?wait=true` on the webhook, without disturbing anything already in the URL. */
function withWait(webhook) {
  try {
    const url = new URL(webhook);
    url.searchParams.set('wait', 'true');
    return url.toString();
  } catch {
    return `${webhook}${webhook.includes('?') ? '&' : '?'}wait=true`;
  }
}

/**
 * The message id out of a webhook response, or null.
 *
 * Tolerant on purpose: a 204 with no body, a response object without `.json`,
 * and a body that is not the message are all "no id", not errors. The id is an
 * optimisation on top of a notification that has already been delivered.
 */
async function readMessageId(res) {
  if (typeof res.json !== 'function') return null;
  try {
    const body = await res.json();
    return typeof body?.id === 'string' && body.id ? body.id : null;
  } catch {
    return null;
  }
}

/**
 * Edit the message an alert already posted, so a resolved alert stops reading
 * as open in the channel.
 *
 * Returns false and does nothing if there is no id, which is the state of every
 * alert raised before this existed and of every one Discord refused. Never
 * throws: this runs inside acknowledgement, and a Discord failure must not turn
 * a successful acknowledgement into a 500.
 */
export async function editDiscordMessage(env, messageId, embed, fetchImpl = fetch) {
  const webhook = webhookUrl(env);
  if (!webhook || !messageId) return false;
  // The message route hangs off the webhook path; a `?wait=true` left on the end
  // would land inside the path segment.
  const base = String(webhook).split('?')[0].replace(/\/+$/, '');
  try {
    const res = await fetchImpl(`${base}/messages/${encodeURIComponent(messageId)}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ embeds: [embed] }),
    });
    return Boolean(res?.ok);
  } catch {
    return false;
  }
}

/** The embed one alert renders as, in the map-alerts channel. */
function toEmbed({ source, severity, title, body, link }) {
  return {
    title: `${SEVERITY_ICON[severity] ?? ''} ${plain(title, 200)}`.trim(),
    // Discord makes an embed title with a `url` clickable, which is one tap from
    // the channel to the thing the alert is about. A separate line saying "open
    // the dashboard" is still in the body for the clients that render titles
    // plainly.
    url: link ?? undefined,
    description: composeBody(body, link)?.slice(0, BODY_MAX) || undefined,
    color: SEVERITY_COLOR[severity] ?? SEVERITY_COLOR.info,
    footer: { text: `NC Zoning Board • ${source}` },
  };
}

/**
 * The same embed, resolved: green, ticked, and signed.
 *
 * Built from the stored ROW rather than from the alert object, because the only
 * caller is acknowledgement, which runs in a later request that has the row and
 * not the original. Body and source are carried through unchanged so scrolling
 * back to the message still tells the reader what happened, not just that
 * somebody dealt with it.
 */
export function toResolvedEmbed(row, { verb = 'Acknowledged' } = {}) {
  const link = firstLink(row.body);
  return {
    title: `${SEVERITY_ICON.recovery} ${plain(row.title, 200)}`.trim(),
    url: link ?? undefined,
    description: row.body ? String(row.body).slice(0, BODY_MAX) : undefined,
    color: SEVERITY_COLOR.recovery,
    footer: {
      text: `NC Zoning Board • ${row.source} • ${verb.toLowerCase()} by `
        + `${plain(row.acknowledged_by, 60) || 'a reviewer'}`,
    },
  };
}

/** The dashboard URL recordAlert appended, so the resolved embed keeps it. */
function firstLink(body) {
  const match = String(body ?? '').match(/https:\/\/\S+/);
  return match ? match[0] : null;
}

/**
 * Record an alert, then forward it. The one entry point every producer uses.
 *
 * Never throws: see the module comment. The return value reports what actually
 * happened, so a caller that cares (the tests, and `/internal/alerts`) can tell
 * a fully successful fan-out from a half-successful one.
 *
 * `notified` is reported separately from `forwarded` so those two cases stay
 * distinguishable: `notified:false` is this alert being log-only by design,
 * `notified:true, forwarded:false` is Discord having refused a real one.
 *
 * @returns {Promise<{id: number|null, recorded: boolean, notified: boolean,
 *                    forwarded: boolean, messageId: string|null}>}
 */
export async function raiseAlert(env, alert, { fetchImpl = fetch, nowMs = Date.now() } = {}) {
  let id = null;
  let recorded = false;
  const notified = alert?.notify !== false;

  if (env.DB) {
    try {
      id = await recordAlert(env, alert, nowMs);
      recorded = true;
    } catch {
      // Fall through and still notify. A missing history row is a degradation;
      // a missing notification is the failure this whole issue exists to fix.
    }
  }

  // Recording happens either way; only the Discord hop is conditional. A
  // log-only alert is in the dashboard and in `wrangler tail`, which is the
  // whole claim being made about it -- it is quieter, not lost.
  const posted = notified
    ? await forwardToDiscord(env, alert, fetchImpl)
    : { forwarded: false, messageId: null };

  // A third write, after both steps, rather than folding the id into the INSERT:
  // the id does not exist until Discord has answered, and waiting for that
  // before recording would put the notification back in front of the history.
  // The ordering in the module comment is the point; this is the price of it.
  if (id !== null && posted.messageId) {
    try {
      await env.DB.prepare('UPDATE alerts SET discord_message_id = ? WHERE id = ?')
        .bind(posted.messageId, id).run();
    } catch {
      // The alert is recorded and the channel has it. All that is lost is the
      // ability to tick this one message off later, which is a nicety.
    }
  }

  return { id, recorded, notified, forwarded: posted.forwarded, messageId: posted.messageId };
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
 * How many times `title` has been raised since the last `resetTitle` for the
 * same source -- a down-edge count since the last up-edge.
 *
 * Exists so a repeating alert can be routed on how long it has been repeating
 * rather than on the single occurrence, which is the difference between "a
 * refresh blipped" and "the refresh has been failing all afternoon". The
 * `alerts` table is the only durable counter available: KV meta holds
 * `last_error_at` but not a count, and a Worker isolate holds nothing across
 * cron ticks.
 *
 * Excludes the row for the alert being raised, because it is called before that
 * row is written -- so a caller wanting "counting this one" adds 1 itself.
 *
 * Throws on a D1 failure. Callers routing on this MUST treat a throw as
 * "notify": an unanswerable question about whether to speak up is answered by
 * speaking up.
 */
export async function alertStreak(env, { source, title, resetTitle }) {
  const row = await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM alerts
      WHERE source = ? AND title = ?
        AND id > COALESCE(
          (SELECT MAX(id) FROM alerts WHERE source = ? AND title = ?), 0)`,
  ).bind(source, title, source, resetTitle).first();
  return Number(row?.n ?? 0);
}

/**
 * What every reader of this table gets. `discord_message_id` is deliberately
 * NOT here: it is plumbing for the edit, it means nothing to a dashboard, and
 * the admin API returns these rows to a browser.
 *
 * `ref` IS here, because it is what lets the dashboard link an alert to the
 * submission it is about.
 */
const ALERT_COLUMNS = `id, at, source, severity, title, body, notify, ref,
  acknowledged_by, acknowledged_at`;

/**
 * Most recent first, matching `readAudit`. `unacknowledged` filters to the ones
 * still needing a human, which is what the dashboard badge counts.
 *
 * "Still needing a human" is `notify = 1` as well as unacknowledged: a log-only
 * alert is never waiting on anybody, so counting one would put a number on the
 * badge that nothing can clear. The unfiltered list still returns every row --
 * the dashboard is where the log-only ones are supposed to be readable.
 */
export async function readAlerts(env, { limit = 100, unacknowledged = false } = {}) {
  const capped = Math.min(Math.max(Number(limit) || 100, 1), 500);
  const where = unacknowledged ? 'WHERE acknowledged_at IS NULL AND notify = 1' : '';
  const { results } = await env.DB.prepare(
    `SELECT ${ALERT_COLUMNS} FROM alerts ${where} ORDER BY id DESC LIMIT ?`,
  ).bind(capped).all();
  return results ?? [];
}

/** How many alerts are still waiting on a human. Drives the tab's badge. */
export async function countUnacknowledged(env) {
  const row = await env.DB.prepare(
    'SELECT COUNT(*) AS n FROM alerts WHERE acknowledged_at IS NULL AND notify = 1',
  ).first();
  return Number(row?.n ?? 0);
}

/**
 * Acknowledge one alert. Returns the updated row, or null if the id does not
 * exist.
 *
 * Acknowledging an already-acknowledged alert is a no-op that returns the row
 * unchanged rather than an error: two admins clearing the same backlog is
 * expected, and the first one to arrive is the one who dealt with it. The
 * Discord edit is skipped in that case too -- the message already says green,
 * and re-editing it would rewrite the first reviewer's name out of the footer.
 *
 * `verb` is what the channel says happened: "Acknowledged" from the dashboard
 * button, "Approved" or "Rejected" when a review resolved it. Same state in D1
 * either way; the distinction only exists for the person reading the channel,
 * which is the whole surface this edit serves.
 */
export async function acknowledgeAlert(
  env, id, actor, { nowMs = Date.now(), verb = 'Acknowledged', fetchImpl = fetch } = {},
) {
  const numeric = Number(id);
  if (!Number.isInteger(numeric)) return null;
  const { meta } = await env.DB.prepare(
    `UPDATE alerts SET acknowledged_by = ?, acknowledged_at = ?
      WHERE id = ? AND acknowledged_at IS NULL`,
  ).bind(actor, new Date(nowMs).toISOString(), numeric).run();

  const row = await env.DB.prepare(
    `SELECT ${ALERT_COLUMNS}, discord_message_id FROM alerts WHERE id = ?`,
  ).bind(numeric).first();
  if (!row) return null;

  // Only on the transition. `changes` is 0 when the row was already
  // acknowledged, and 0 rows changed is the same answer as "somebody else got
  // here first".
  if (meta?.changes && row.discord_message_id) {
    await editDiscordMessage(env, row.discord_message_id, toResolvedEmbed(row, { verb }), fetchImpl);
  }

  // `discord_message_id` is plumbing and does not leave this module.
  const { discord_message_id: _omit, ...visible } = row;
  return visible;
}

/**
 * Acknowledge every open alert about one thing -- today, a submission that has
 * just been approved or rejected.
 *
 * This is what keeps the two surfaces in step without a reviewer clearing the
 * same item twice. An alert that says "a submission is waiting" is answered by
 * the submission no longer waiting; leaving it open would make the dashboard
 * badge and the channel both count work that is done, and a count that is
 * routinely wrong is a count nobody reads.
 *
 * Every open row, not the newest: a re-raised alert about the same submission
 * would otherwise leave older duplicates standing forever.
 *
 * Never throws. It runs after the registry write and after the submission is
 * resolved, so a failure here must not turn a completed review into an error
 * the reviewer will retry.
 */
export async function resolveAlertsByRef(
  env, ref, actor, { verb = 'Acknowledged', nowMs = Date.now(), fetchImpl = fetch } = {},
) {
  if (!env.DB || !ref) return 0;
  try {
    const { results } = await env.DB.prepare(
      'SELECT id FROM alerts WHERE ref = ? AND acknowledged_at IS NULL',
    ).bind(ref).all();
    const open = results ?? [];
    for (const { id } of open) {
      await acknowledgeAlert(env, id, actor, { nowMs, verb, fetchImpl });
    }
    return open.length;
  } catch {
    return 0;
  }
}
