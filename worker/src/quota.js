/**
 * Quota burn-down: how much of each free-tier cap today has already spent.
 *
 * This is the panel that would have surfaced the KV write overage before
 * Cloudflare emailed about it. The caps are per-ACCOUNT and the failure mode is
 * silent: nothing degrades until the cap is hit, and then the cron simply
 * stops writing.
 *
 * The token never leaves the Worker. `CF_ANALYTICS_TOKEN` is an
 * Account Analytics:Read credential; the dashboard reads THIS route instead of
 * talking to Cloudflare, so a browser never holds a token that can read the
 * whole account's analytics.
 *
 * Dataset names are CONFIRMED BY INTROSPECTION, not guessed. The endpoint
 * supports it, and the `*AdaptiveGroups` naming is close enough between
 * datasets that a guess looks plausible and returns an empty result rather than
 * an error. An empty result is indistinguishable from "no usage today", which
 * is exactly the reading that would make this panel lie.
 */

import { raiseAlert, alertedSinceUtcMidnight } from './alerts.js';

const GRAPHQL_ENDPOINT = 'https://api.cloudflare.com/client/v4/graphql';

/**
 * One GraphQL call. Returns `{ ok, data, errors }` rather than throwing, so the
 * caller can report "could not read" distinctly from "read zero".
 */
export async function cfGraphQL(env, query, variables = {}, fetchImpl = fetch) {
  if (!env.CF_ANALYTICS_TOKEN) {
    return { ok: false, errors: ['CF_ANALYTICS_TOKEN is not set'] };
  }
  if (!env.CF_ACCOUNT_ID) {
    return { ok: false, errors: ['CF_ACCOUNT_ID is not set'] };
  }

  let res;
  try {
    res = await fetchImpl(GRAPHQL_ENDPOINT, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${env.CF_ANALYTICS_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ query, variables }),
    });
  } catch (err) {
    return { ok: false, errors: [`network: ${String(err).slice(0, 200)}`] };
  }

  if (!res.ok) return { ok: false, errors: [`HTTP ${res.status}`] };

  const body = await res.json().catch(() => null);
  if (!body) return { ok: false, errors: ['response was not JSON'] };

  // GraphQL answers 200 with an `errors` array on failure. Reading only the
  // status here would treat a permissions failure as a successful empty result.
  if (Array.isArray(body.errors) && body.errors.length) {
    return { ok: false, errors: body.errors.map((e) => e.message ?? String(e)) };
  }
  return { ok: true, data: body.data };
}

/**
 * The datasets this token can actually see, straight from the schema.
 *
 * Temporary, and deliberately so: it exists to confirm the field names for the
 * real query rather than to be a permanent route. Collaborator-gated like
 * everything else under /admin.
 */
/**
 * Free-tier caps, per ACCOUNT per UTC day.
 *
 * The caps reset at UTC midnight, not local midnight, so the panel
 * says UTC on the date: a burn-down measured against the wrong day boundary
 * reads as "plenty left" for the ~10 hours AEST runs ahead of UTC.
 *
 * `metric` names come from introspection (AccountKvOperationsAdaptiveGroupsSum
 * etc.), not from documentation or memory.
 */
export const CAPS = {
  kv_writes: { label: 'KV writes', cap: 1000 },
  kv_reads: { label: 'KV reads', cap: 100000 },
  worker_requests: { label: 'Worker requests', cap: 100000 },
  d1_rows_written: { label: 'D1 rows written', cap: 100000 },
  d1_rows_read: { label: 'D1 rows read', cap: 5000000 },
};

/**
 * Usage so far today, against the caps above.
 *
 * One query for all three datasets: three round trips would let one succeed and
 * another fail, and a panel showing two of three numbers with no note is worse
 * than one that says it could not read.
 */
export async function readQuota(env, { nowMs = Date.now(), fetchImpl = fetch } = {}) {
  // Cloudflare's `date` dimension is a UTC calendar day.
  const date = new Date(nowMs).toISOString().slice(0, 10);

  const query = `query Quota($accountTag: String!, $date: Date!) {
    viewer {
      accounts(filter: { accountTag: $accountTag }) {
        kv: kvOperationsAdaptiveGroups(filter: { date_geq: $date }, limit: 100) {
          dimensions { actionType }
          sum { requests }
        }
        workers: workersInvocationsAdaptive(filter: { date_geq: $date }, limit: 100) {
          sum { requests errors subrequests }
        }
        d1: d1AnalyticsAdaptiveGroups(filter: { date_geq: $date }, limit: 100) {
          sum { rowsWritten rowsRead }
        }
      }
    }
  }`;

  const result = await cfGraphQL(
    env, query, { accountTag: env.CF_ACCOUNT_ID, date }, fetchImpl,
  );
  if (!result.ok) return result;

  const account = result.data?.viewer?.accounts?.[0];
  if (!account) {
    // The token is valid but sees no such account: a scope problem, not zero
    // usage. Reported as a failure so the panel says "unknown", not "0%".
    return { ok: false, errors: [`no analytics for account ${env.CF_ACCOUNT_ID}`] };
  }

  const kvBy = (action) => (account.kv ?? [])
    .filter((r) => r.dimensions?.actionType === action)
    .reduce((n, r) => n + (r.sum?.requests ?? 0), 0);

  const workers = (account.workers ?? []).reduce((acc, r) => ({
    requests: acc.requests + (r.sum?.requests ?? 0),
    errors: acc.errors + (r.sum?.errors ?? 0),
    subrequests: acc.subrequests + (r.sum?.subrequests ?? 0),
  }), { requests: 0, errors: 0, subrequests: 0 });

  const d1 = (account.d1 ?? []).reduce((acc, r) => ({
    rowsWritten: acc.rowsWritten + (r.sum?.rowsWritten ?? 0),
    rowsRead: acc.rowsRead + (r.sum?.rowsRead ?? 0),
  }), { rowsWritten: 0, rowsRead: 0 });

  const used = {
    kv_writes: kvBy('write'),
    kv_reads: kvBy('read'),
    worker_requests: workers.requests,
    d1_rows_written: d1.rowsWritten,
    d1_rows_read: d1.rowsRead,
  };

  // How far into the UTC day the reading is. Without it "1 of 1,000 KV writes" reads
  // as enormous headroom when the day is twenty minutes old, and AEST runs ~10
  // hours ahead of the reset, so for most of the working day the local reading
  // is the misleading one. The panel projects against this rather than letting
  // the raw fraction speak.
  const utcMs = nowMs - Date.UTC(
    new Date(nowMs).getUTCFullYear(),
    new Date(nowMs).getUTCMonth(),
    new Date(nowMs).getUTCDate(),
  );
  const hoursElapsed = Math.round((utcMs / 3600000) * 10) / 10;

  return {
    ok: true,
    data: {
      date,
      utc_hours_elapsed: hoursElapsed,
      // The caps travel with the numbers so the dashboard does not keep its own
      // copy that can drift from this one.
      usage: Object.entries(CAPS).map(([key, { label, cap }]) => ({
        key,
        label,
        cap,
        used: used[key],
        pct: cap ? Math.round((used[key] / cap) * 1000) / 10 : null,
        // Straight-line projection to UTC midnight. Crude on purpose: it is a
        // "will this run out today" signal, not a forecast, and it is null for
        // the first half hour where dividing by a tiny elapsed fraction
        // produces a number that is confident and meaningless.
        projected: hoursElapsed >= 0.5
          ? Math.round(used[key] * (24 / hoursElapsed))
          : null,
      })),
      worker_errors: workers.errors,
      // The actionTypes actually seen, so an unexpected one (a rename upstream)
      // is visible rather than silently summing to zero under a stale name.
      kv_action_types: [...new Set((account.kv ?? []).map((r) => r.dimensions?.actionType))],
    },
  };
}

/** Fraction of a cap at which the burn-down stops being informational. */
export const QUOTA_ALERT_PCT = 80;

/**
 * Alert when any cap passes 80% of its daily allowance.
 *
 * The plan calls this "the alert that would have pre-empted this entire
 * thread": the KV write limit was discovered from a Cloudflare email, after the
 * fact, with the numbers already on the dashboard and nobody looking at them.
 *
 * ## Once an hour, not every tick
 *
 * The refresh cron runs every 5 minutes. Querying Cloudflare's analytics API on
 * all 288 ticks to police quota would be a quota-watching feature that is
 * itself one of the heavier things running, so the check is gated to the tick
 * whose UTC minute is under 5. That is exactly one tick an hour, it needs no
 * stored "last checked" state (which on a 1,000/day cap would itself be a KV
 * write worth avoiding), and it is derived from the clock rather than from a
 * counter that a redeploy resets.
 *
 * ## Once a day per cap, not once an hour
 *
 * `alertedSinceUtcMidnight` suppresses the repeat. The window is UTC because
 * the caps reset at UTC midnight; a local-midnight window would reopen partway
 * through a quota day and post a duplicate for a cap already reported.
 *
 * Never throws: quota alerting must not be able to fail a refresh that
 * otherwise succeeded.
 */
export async function checkQuotaThresholds(env, fetchImpl = fetch, nowMs = Date.now()) {
  try {
    if (new Date(nowMs).getUTCMinutes() >= 5) return { checked: false, raised: [] };
    if (!env.CF_ANALYTICS_TOKEN) return { checked: false, raised: [] };

    const quota = await readQuota(env, { nowMs, fetchImpl });
    if (!quota.ok) return { checked: false, raised: [] };

    const raised = [];
    for (const row of quota.data.usage) {
      if (row.pct == null || row.pct < QUOTA_ALERT_PCT) continue;
      // The title is the dedup key, so it names the cap and nothing that varies
      // within a day. Putting the percentage in it would defeat the suppression
      // the moment usage ticked from 81% to 82%.
      const title = `Quota ${QUOTA_ALERT_PCT}%: ${row.label}`;
      if (await alertedSinceUtcMidnight(env, { source: 'quota', title }, nowMs)) continue;
      await raiseAlert(env, {
        source: 'quota',
        severity: row.pct >= 100 ? 'error' : 'warn',
        title,
        body: `${row.label} is at ${row.pct}% of the daily free-tier cap `
          + `(${row.used} of ${row.cap}) after ${quota.data.utc_hours_elapsed} UTC hours`
          + `${row.projected == null ? '' : `, projecting ${row.projected} by UTC midnight`}.`
          + `\n\nCaps are per ACCOUNT and reset at UTC midnight. Nothing degrades `
          + `until the cap is hit, at which point the cron simply stops.`,
        // Notifies. Nothing automatic can bring usage back down, and the window
        // to act is the rest of the UTC day; the once-a-day dedup above is
        // already what keeps this from being noise.
        notify: true,
      }, { fetchImpl, nowMs });
      raised.push(title);
    }
    return { checked: true, raised };
  } catch {
    return { checked: false, raised: [] };
  }
}

/**
 * Fields of one named type. Used to confirm a dataset's dimensions and metrics
 * before writing a query against it. The sums are named differently per
 * dataset (`requests`, `count`, `readQueries`…), and a wrong name is a GraphQL
 * error rather than a wrong number, but only if you never wrote it in the first
 * place.
 */
export async function introspectType(env, typeName, fetchImpl = fetch) {
  const result = await cfGraphQL(env, `{
    __type(name: "${typeName}") {
      name
      fields { name type { name kind ofType { name kind ofType { name } } } }
      inputFields { name }
    }
  }`, {}, fetchImpl);
  if (!result.ok) return result;
  const t = result.data?.__type;
  if (!t) return { ok: false, errors: [`no such type: ${typeName}`] };
  return {
    ok: true,
    data: {
      name: t.name,
      fields: (t.fields ?? []).map((f) => f.name),
      inputFields: (t.inputFields ?? []).map((f) => f.name),
    },
  };
}

export async function introspectDatasets(env, fetchImpl = fetch) {
  // Walk the schema instead of assuming a type name. `__type(name: "Account")`
  // does not exist here (the type is `account`, reached through `viewer`), and
  // GraphQL answers a missing type with 200 and `__type: null`. Reading that as
  // "no datasets" is the same mistake as reading an empty result as "no usage",
  // so the type is discovered and a null at any step is reported as null.
  const query = `{
    __schema {
      queryType {
        fields {
          name
          type { name kind ofType { name kind ofType { name kind ofType { name } } } }
        }
      }
    }
  }`;

  const result = await cfGraphQL(env, query, {}, fetchImpl);
  if (!result.ok) return result;

  const rootFields = result.data?.__schema?.queryType?.fields;
  if (!Array.isArray(rootFields)) {
    return { ok: false, errors: ['introspection returned no root fields'] };
  }

  const peel = (t, depth = 6) => {
    let cur = t;
    for (let i = 0; i < depth && cur; i += 1) {
      if (cur.name) return cur.name;
      cur = cur.ofType;
    }
    return null;
  };
  const viewer = rootFields.find((f) => f.name === 'viewer');
  const viewerType = peel(viewer?.type);
  if (!viewerType) {
    return { ok: false, errors: [`no 'viewer' on the root type; saw: ${rootFields.map((f) => f.name).join(', ')}`] };
  }

  // Second hop: the accounts field on the viewer type, and the type of ITS
  // elements, which is what carries the dataset fields.
  // Five levels of `ofType`, because the wrappers nest: `accounts` is
  // `[account!]!`, meaning NonNull(List(NonNull(account))), and unwrapping only three
  // deep reported "no accounts field" for a field that was plainly there.
  const second = await cfGraphQL(env, `{
    __type(name: "${viewerType}") {
      name
      fields {
        name
        type { name kind ofType { name kind ofType { name kind ofType { name kind ofType { name } } } } }
      }
    }
  }`, {}, fetchImpl);
  if (!second.ok) return second;

  const viewerFields = second.data?.__type?.fields;
  if (!Array.isArray(viewerFields)) {
    return { ok: false, errors: [`type ${viewerType} exposed no fields`] };
  }

  /** Peel NonNull/List wrappers until a named type falls out. */
  const namedType = (t, depth = 6) => {
    let cur = t;
    for (let i = 0; i < depth && cur; i += 1) {
      if (cur.name) return cur.name;
      cur = cur.ofType;
    }
    return null;
  };

  const accounts = viewerFields.find((f) => f.name === 'accounts');
  const accountType = namedType(accounts?.type);
  if (!accountType) {
    return {
      ok: false,
      errors: [
        `could not resolve the type of 'accounts' on ${viewerType}`,
        // The raw shape, because two guesses at why have already been wrong.
        `raw: ${JSON.stringify(accounts ?? null).slice(0, 400)}`,
      ],
    };
  }

  const third = await cfGraphQL(env, `{
    __type(name: "${accountType}") { name fields { name } }
  }`, {}, fetchImpl);
  if (!third.ok) return third;

  const datasetFields = third.data?.__type?.fields;
  if (!Array.isArray(datasetFields)) {
    return { ok: false, errors: [`type ${accountType} exposed no fields`] };
  }

  return {
    ok: true,
    data: {
      viewerType,
      accountType,
      total: datasetFields.length,
      // Everything, so a name that does not match the expected pattern is still
      // visible. Filtering to *AdaptiveGroups here would hide the very dataset
      // this is being run to find.
      fields: datasetFields.map((f) => f.name),
    },
  };
}
