/**
 * The append-only audit log. This is what replaces `git log` for data changes:
 * once locations are edited through the API rather than through pull requests,
 * the commit history stops recording who changed what, and nothing else does.
 *
 * Never updated, never deleted. A correction is another row.
 *
 * `before`/`after` are stored verbatim, INCLUDING `admin_notes`. That is right
 * for the live table and wrong for the export: Part C mirrors the audit log to
 * a public branch, and must redact those fields there rather than here. Storing
 * a redacted copy would lose the actual history for the sake of a future export.
 */

/**
 * @param {object} env
 * @param {object} entry
 * @param {string} entry.actor   github login, or 'system' for the cron
 * @param {string} entry.action  e.g. location.create | location.update | location.delete
 * @param {string} [entry.target]
 * @param {object|null} [entry.before]
 * @param {object|null} [entry.after]
 */
export async function writeAudit(env, { actor, action, target = null, before = null, after = null }, nowMs = Date.now()) {
  await env.DB.prepare(
    'INSERT INTO audit_log (at, actor, action, target, before, after) VALUES (?, ?, ?, ?, ?, ?)',
  ).bind(
    new Date(nowMs).toISOString(),
    actor,
    action,
    target,
    before === null ? null : JSON.stringify(before),
    after === null ? null : JSON.stringify(after),
  ).run();
}

/** Most recent entries first. */
export async function readAudit(env, limit = 100) {
  const capped = Math.min(Math.max(Number(limit) || 100, 1), 500);
  const { results } = await env.DB.prepare(
    'SELECT id, at, actor, action, target, before, after FROM audit_log ORDER BY id DESC LIMIT ?',
  ).bind(capped).all();
  return (results ?? []).map((r) => ({
    ...r,
    before: r.before ? JSON.parse(r.before) : null,
    after: r.after ? JSON.parse(r.after) : null,
  }));
}
