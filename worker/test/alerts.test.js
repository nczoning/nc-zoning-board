/**
 * The alert fan-out.
 *
 * The load-bearing claim is the ORDERING: an alert is recorded before it is
 * forwarded, so a Discord outage costs the notification and not the history.
 * That is the whole reason the `alerts` table exists, and it is not observable
 * from a passing happy path, so most of what is here is failure cases.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  raiseAlert, recordAlert, readAlerts, countUnacknowledged, acknowledgeAlert,
  alertedSinceUtcMidnight, validateAlertInput,
} from '../src/alerts.js';
import { handleInternal } from '../src/internal.js';
import { sqliteD1 } from '../test-support/d1-sqlite.mjs';

const WEBHOOK = 'https://discord/webhook';

/** Collects what would have been posted to Discord. */
function fakeDiscord({ fail = false, throws = false } = {}) {
  const sent = [];
  const impl = async (url, init) => {
    if (throws) throw new Error('network down');
    sent.push({ url, body: JSON.parse(init.body) });
    return { ok: !fail, status: fail ? 500 : 204, text: async () => 'x' };
  };
  impl.sent = sent;
  return impl;
}

const newEnv = (over = {}) => ({
  DB: sqliteD1(), NCZ_ALERTS_DISCORD_WEBHOOK_URL: WEBHOOK, ...over,
});

const ALERT = { source: 'refresh', severity: 'warn', title: 'Something happened', body: 'detail' };

// ---------------------------------------------------------------- ordering --

test('the row exists BEFORE Discord is called', async () => {
  // The ordering is the design, and none of the surrounding tests can see it:
  // they pass whether the code records first or forwards first, because a
  // failed forward is swallowed either way. What the ordering actually buys is
  // survival of the gap between the two steps, so the only way to observe it is
  // to look at the database from inside the forward.
  //
  // Reversing the two statements in raiseAlert turns this red and nothing else.
  const env = newEnv();
  let rowsAtForwardTime = null;
  const inspectingDiscord = async () => {
    rowsAtForwardTime = (await readAlerts(env)).length;
    return { ok: true, status: 204, text: async () => '' };
  };

  await raiseAlert(env, ALERT, { fetchImpl: inspectingDiscord });

  assert.equal(rowsAtForwardTime, 1, 'Discord was called before the alert was recorded');
});

test('the alert is recorded even when Discord refuses it', async () => {
  const env = newEnv();
  const discord = fakeDiscord({ fail: true });

  const result = await raiseAlert(env, ALERT, { fetchImpl: discord });

  assert.equal(result.recorded, true, 'the row must be written');
  assert.equal(result.forwarded, false, 'Discord said no');
  const rows = await readAlerts(env);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].title, 'Something happened');
});

test('the alert is recorded even when Discord is unreachable', async () => {
  const env = newEnv();
  const result = await raiseAlert(env, ALERT, { fetchImpl: fakeDiscord({ throws: true }) });

  assert.equal(result.recorded, true);
  assert.equal(result.forwarded, false);
  assert.equal((await readAlerts(env)).length, 1);
});

test('a D1 failure still lets the notification through', async () => {
  // The inverse case. Losing the history is a degradation; losing the
  // notification is the failure the whole issue exists to fix, so a broken
  // database must not silence Discord.
  const env = newEnv({
    DB: { prepare() { throw new Error('D1 unavailable'); } },
  });
  const discord = fakeDiscord();

  const result = await raiseAlert(env, ALERT, { fetchImpl: discord });

  assert.equal(result.recorded, false);
  assert.equal(result.forwarded, true);
  assert.equal(discord.sent.length, 1);
});

test('raiseAlert never throws, whatever fails', async () => {
  const env = { DB: { prepare() { throw new Error('nope'); } }, NCZ_ALERTS_DISCORD_WEBHOOK_URL: WEBHOOK };
  const result = await raiseAlert(env, ALERT, { fetchImpl: fakeDiscord({ throws: true }) });
  assert.deepEqual(result, { id: null, recorded: false, forwarded: false });
});

test('with no webhook configured the alert is still recorded', async () => {
  const env = newEnv({ NCZ_ALERTS_DISCORD_WEBHOOK_URL: undefined });
  const result = await raiseAlert(env, ALERT, { fetchImpl: fakeDiscord() });
  assert.equal(result.recorded, true);
  assert.equal(result.forwarded, false);
});

test('the legacy submissions webhook is the fallback, not a second post', async () => {
  const env = newEnv({ NCZ_ALERTS_DISCORD_WEBHOOK_URL: undefined, DISCORD_WEBHOOK_URL: 'https://legacy' });
  const discord = fakeDiscord();
  await raiseAlert(env, ALERT, { fetchImpl: discord });
  assert.equal(discord.sent.length, 1);
  assert.equal(discord.sent[0].url, 'https://legacy');
});

// ------------------------------------------------------------------ embeds --

test('severity drives the embed colour and icon', async () => {
  const env = newEnv();
  const discord = fakeDiscord();
  await raiseAlert(env, { ...ALERT, severity: 'recovery', title: 'Back up' }, { fetchImpl: discord });
  const embed = discord.sent[0].body.embeds[0];
  assert.equal(embed.title, '✅ Back up');
  assert.equal(embed.color, 0x2ecc71);
  assert.equal(embed.footer.text, 'NC Zoning Board • refresh');
});

// -------------------------------------------------------------------- dedup --

test('alertedSinceUtcMidnight is per UTC day, not per rolling 24 hours', async () => {
  const env = newEnv();
  // 23:50 UTC: recorded yesterday by the time the 00:10 tick runs.
  const lateYesterday = Date.parse('2026-07-30T23:50:00Z');
  const earlyToday = Date.parse('2026-07-31T00:10:00Z');

  await raiseAlert(env, { ...ALERT, source: 'quota', title: 'Quota 80%: KV writes' },
    { fetchImpl: fakeDiscord(), nowMs: lateYesterday });

  // 20 minutes later in wall-clock terms, but a different quota day: the caps
  // have reset, so the alert is allowed to fire again.
  assert.equal(
    await alertedSinceUtcMidnight(env, { source: 'quota', title: 'Quota 80%: KV writes' }, earlyToday),
    false,
  );
  // Same day as the write: suppressed.
  assert.equal(
    await alertedSinceUtcMidnight(env, { source: 'quota', title: 'Quota 80%: KV writes' }, lateYesterday + 60_000),
    true,
  );
});

test('dedup is per title, so a different cap still alerts', async () => {
  const env = newEnv();
  const now = Date.parse('2026-07-31T09:00:00Z');
  await raiseAlert(env, { source: 'quota', severity: 'warn', title: 'Quota 80%: KV writes' },
    { fetchImpl: fakeDiscord(), nowMs: now });
  assert.equal(await alertedSinceUtcMidnight(env, { source: 'quota', title: 'Quota 80%: D1 rows written' }, now), false);
});

// ------------------------------------------------------------ acknowledging --

test('acknowledging records who and when, and clears the unacknowledged count', async () => {
  const env = newEnv();
  const id = await recordAlert(env, ALERT);
  assert.equal(await countUnacknowledged(env), 1);

  const row = await acknowledgeAlert(env, id, 'spuddeh');
  assert.equal(row.acknowledged_by, 'spuddeh');
  assert.ok(row.acknowledged_at);
  assert.equal(await countUnacknowledged(env), 0);
});

test('the first acknowledgement wins, and the second is not an error', async () => {
  // Two admins clearing the same backlog is expected. The one who actually
  // dealt with it is the one who got there first, so a second press must not
  // overwrite the name.
  const env = newEnv();
  const id = await recordAlert(env, ALERT);
  await acknowledgeAlert(env, id, 'kaoziun');
  const row = await acknowledgeAlert(env, id, 'akiway');
  assert.equal(row.acknowledged_by, 'kaoziun');
});

test('acknowledging an id that does not exist is null, not a crash', async () => {
  const env = newEnv();
  assert.equal(await acknowledgeAlert(env, 9999, 'spuddeh'), null);
  assert.equal(await acknowledgeAlert(env, 'not-a-number', 'spuddeh'), null);
});

test('unacknowledged filter returns only what still needs a human', async () => {
  const env = newEnv();
  const first = await recordAlert(env, ALERT);
  await recordAlert(env, { ...ALERT, title: 'Second' });
  await acknowledgeAlert(env, first, 'spuddeh');

  const open = await readAlerts(env, { unacknowledged: true });
  assert.equal(open.length, 1);
  assert.equal(open[0].title, 'Second');
  assert.equal((await readAlerts(env)).length, 2, 'the full list still has both');
});

// -------------------------------------------------------------- validation --

test('an unknown source or severity is refused, not stored', () => {
  assert.equal(validateAlertInput({ ...ALERT, source: 'made-up' }).ok, false);
  assert.equal(validateAlertInput({ ...ALERT, severity: 'catastrophic' }).ok, false);
  assert.equal(validateAlertInput({ ...ALERT, title: '   ' }).ok, false);
  assert.equal(validateAlertInput(ALERT).ok, true);
});

// ----------------------------------------------------------- /internal/alerts --

const post = (body, { secret = 'right-secret', headers } = {}) => new Request(
  'https://api.test/internal/alerts',
  {
    method: 'POST',
    headers: headers ?? (secret === null
      ? { 'Content-Type': 'application/json' }
      : { 'Content-Type': 'application/json', Authorization: `Bearer ${secret}` }),
    body: typeof body === 'string' ? body : JSON.stringify(body),
  },
);

const ingestEnv = (over = {}) => newEnv({ ALERTS_INGEST_SECRET: 'right-secret', ...over });

test('a correct secret records and forwards', async () => {
  const env = ingestEnv();
  const res = await handleInternal(post(ALERT), env);
  assert.equal(res.status, 202);
  const body = await res.json();
  assert.equal(body.recorded, true);
  assert.equal((await readAlerts(env)).length, 1);
});

test('a wrong secret is refused and writes nothing', async () => {
  const env = ingestEnv();
  const res = await handleInternal(post(ALERT, { secret: 'wrong' }), env);
  assert.equal(res.status, 401);
  assert.equal((await readAlerts(env)).length, 0, 'a refused call must not record');
});

test('a missing Authorization header is refused', async () => {
  const env = ingestEnv();
  const res = await handleInternal(post(ALERT, { secret: null }), env);
  assert.equal(res.status, 401);
});

test('an unset server secret is 503, and an unset header cannot satisfy it', async () => {
  // The dangerous shape: "" === "" would authorise anyone the moment the secret
  // goes missing from the Worker.
  const env = newEnv({ ALERTS_INGEST_SECRET: undefined });
  const res = await handleInternal(post(ALERT, { secret: null }), env);
  assert.equal(res.status, 503);
  assert.equal((await readAlerts(env)).length, 0);
});

test('a bad payload is refused after authentication, and records nothing', async () => {
  const env = ingestEnv();
  const res = await handleInternal(post({ ...ALERT, source: 'nope' }), env);
  assert.equal(res.status, 400);
  assert.equal((await readAlerts(env)).length, 0);
});

test('invalid JSON is a 400, not a crash', async () => {
  const env = ingestEnv();
  const res = await handleInternal(post('{not json', {}), env);
  assert.equal(res.status, 400);
});

test('GET is refused: the ingest is write-only', async () => {
  const env = ingestEnv();
  const req = new Request('https://api.test/internal/alerts', { method: 'GET' });
  assert.equal((await handleInternal(req, env)).status, 405);
});

test('the ingest emits no CORS headers, so a browser cannot read it', async () => {
  const env = ingestEnv();
  const res = await handleInternal(post(ALERT), env);
  assert.equal(res.headers.get('Access-Control-Allow-Origin'), null);
});

test('a non-internal path is not claimed by this handler', async () => {
  const env = ingestEnv();
  const req = new Request('https://api.test/v1/locations', { method: 'GET' });
  assert.equal(await handleInternal(req, env), null);
});
