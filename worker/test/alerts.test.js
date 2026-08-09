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
  alertedSinceUtcMidnight, validateAlertInput, alertStreak, ALERT_SOURCES,
  resolveAlertsByRef, escapeDiscord,
} from '../src/alerts.js';
import { handleInternal } from '../src/internal.js';
import { sqliteD1 } from '../test-support/d1-sqlite.mjs';

const WEBHOOK = 'https://discord/webhook';

/**
 * Collects what would have been posted to Discord.
 *
 * Answers a POST with a message object, because that is what `?wait=true` gets
 * and the id in it is what every edit later depends on. `noId` is the other real
 * case: a webhook that 204s, which every alert raised before the edit existed
 * did.
 */
function fakeDiscord({ fail = false, throws = false, noId = false } = {}) {
  const sent = [];
  const impl = async (url, init) => {
    if (throws) throw new Error('network down');
    sent.push({ url, method: init.method, body: JSON.parse(init.body) });
    return {
      ok: !fail,
      status: fail ? 500 : 200,
      text: async () => 'x',
      json: async () => (noId ? {} : { id: `msg-${sent.length}` }),
    };
  };
  impl.sent = sent;
  impl.edits = () => sent.filter((s) => s.method === 'PATCH');
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
  assert.deepEqual(result, {
    id: null, recorded: false, notified: true, forwarded: false, messageId: null,
  });
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
  // `?wait=true` on whichever webhook is in play: the message id is what makes
  // the alert closable later, and losing it on the fallback would mean the
  // legacy secret quietly gives you a channel that never goes green.
  assert.equal(discord.sent[0].url, 'https://legacy/?wait=true');
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

// ------------------------------------------------------------------ routing --

test('a log-only alert is recorded and never reaches Discord', async () => {
  const env = newEnv();
  const discord = fakeDiscord();

  const result = await raiseAlert(env, { ...ALERT, notify: false }, { fetchImpl: discord });

  assert.equal(result.recorded, true);
  assert.equal(result.notified, false);
  assert.equal(result.forwarded, false);
  assert.equal(discord.sent.length, 0, 'the webhook must not be called at all');
  const rows = await readAlerts(env);
  assert.equal(rows.length, 1, 'the history is the point: quieter, not lost');
  assert.equal(rows[0].notify, 0);
});

test('omitting notify means notify, so an unconsidered producer is noisy not silent', async () => {
  // The default is the safety property. A producer added later that never
  // thought about routing gets the old behaviour, and every row written before
  // the column existed reads as what actually happened to it.
  const env = newEnv();
  const discord = fakeDiscord();
  await raiseAlert(env, ALERT, { fetchImpl: discord });
  assert.equal(discord.sent.length, 1);
  assert.equal((await readAlerts(env))[0].notify, 1);
});

test('notified and forwarded are distinguishable, so a broken webhook still shows', async () => {
  // The failure this separation prevents: a Discord outage reading as "we chose
  // not to send it". They need different responses, so they need different
  // fields.
  const env = newEnv();
  const result = await raiseAlert(env, ALERT, { fetchImpl: fakeDiscord({ fail: true }) });
  assert.equal(result.notified, true, 'this alert WAS meant for a human');
  assert.equal(result.forwarded, false, 'Discord refused it');
});

test('a log-only alert is not waiting on anyone, so it stays out of the badge', async () => {
  // Counting one would put a number on the dashboard badge that nothing can
  // clear: there is no Acknowledge button on a log-only alert.
  const env = newEnv();
  await recordAlert(env, { ...ALERT, notify: false });
  assert.equal(await countUnacknowledged(env), 0);
  assert.equal((await readAlerts(env, { unacknowledged: true })).length, 0);
  assert.equal((await readAlerts(env)).length, 1, 'the full list still shows it');

  await recordAlert(env, { ...ALERT, title: 'Needs a person' });
  assert.equal(await countUnacknowledged(env), 1);
});

test('notify must be a boolean, because a truthy string would route backwards', async () => {
  // "false" is truthy. Coercing it would forward an alert the caller asked to
  // keep quiet, and routing bugs are silent by nature.
  assert.equal(validateAlertInput({ ...ALERT, notify: 'false' }).ok, false);
  assert.equal(validateAlertInput({ ...ALERT, notify: 0 }).ok, false);
  assert.equal(validateAlertInput({ ...ALERT, notify: false }).alert.notify, false);
  assert.equal(validateAlertInput({ ...ALERT, notify: true }).alert.notify, true);
  assert.equal(validateAlertInput(ALERT).alert.notify, true, 'omitted means notify');
});

// ------------------------------------------------------------------ streaks --

test('alertStreak counts since the last reset, not since the beginning of time', async () => {
  const env = newEnv();
  const failed = { source: 'refresh', severity: 'warn', title: 'Data API refresh failed' };
  const recovered = { source: 'refresh', severity: 'recovery', title: 'Data API refresh recovered' };
  const streak = () => alertStreak(env, {
    source: 'refresh', title: failed.title, resetTitle: recovered.title,
  });

  await recordAlert(env, failed);
  await recordAlert(env, failed);
  assert.equal(await streak(), 2);

  await recordAlert(env, recovered);
  assert.equal(await streak(), 0, 'the recovery is the reset');

  await recordAlert(env, failed);
  assert.equal(await streak(), 1);
});

test('alertStreak ignores other sources and other titles', async () => {
  const env = newEnv();
  await recordAlert(env, { source: 'api-health', severity: 'warn', title: 'Data API refresh failed' });
  await recordAlert(env, { source: 'refresh', severity: 'warn', title: 'Something else' });
  assert.equal(
    await alertStreak(env, {
      source: 'refresh', title: 'Data API refresh failed', resetTitle: 'Data API refresh recovered',
    }),
    0,
  );
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

// ------------------------------------------------- closing it in both places --

test('the posted message id is stored, so the message can be edited later', async () => {
  const env = newEnv();
  const discord = fakeDiscord();
  const result = await raiseAlert(env, ALERT, { fetchImpl: discord });

  assert.equal(result.messageId, 'msg-1');
  assert.match(discord.sent[0].url, /wait=true/, 'without ?wait=true Discord returns no id');
  const row = await env.DB.prepare('SELECT discord_message_id FROM alerts WHERE id = ?')
    .bind(result.id).first();
  assert.equal(row.discord_message_id, 'msg-1');
});

test('acknowledging edits the original message green rather than posting again', async () => {
  const env = newEnv();
  const discord = fakeDiscord();
  const { id } = await raiseAlert(env, ALERT, { fetchImpl: discord });

  await acknowledgeAlert(env, id, 'spuddeh', { fetchImpl: discord });

  const edits = discord.edits();
  assert.equal(edits.length, 1, 'exactly one edit, and no second post');
  assert.equal(discord.sent.length, 2, 'a second POST would double the channel volume');
  assert.match(edits[0].url, /\/messages\/msg-1$/);
  const embed = edits[0].body.embeds[0];
  assert.equal(embed.color, 0x2ecc71, 'green');
  assert.match(embed.title, /^✅/);
  assert.match(embed.footer.text, /acknowledged by spuddeh/);
  assert.equal(embed.description, 'detail', 'the body has to survive, or the message says nothing');
});

test('the second acknowledgement does not rewrite the first name into the channel', async () => {
  // Same rule as the D1 row: the reviewer who got there first is the one who
  // dealt with it. Editing on a no-op UPDATE would put the later name on the
  // message and disagree with the dashboard.
  const env = newEnv();
  const discord = fakeDiscord();
  const { id } = await raiseAlert(env, ALERT, { fetchImpl: discord });
  await acknowledgeAlert(env, id, 'kaoziun', { fetchImpl: discord });
  await acknowledgeAlert(env, id, 'akiway', { fetchImpl: discord });

  assert.equal(discord.edits().length, 1);
  assert.match(discord.edits()[0].body.embeds[0].footer.text, /kaoziun/);
});

test('an alert Discord never carried is still acknowledgeable', async () => {
  // Every row written before this feature, and every alert Discord refused, has
  // no message id. Acknowledgement is a dashboard action; it cannot depend on
  // Discord having worked.
  const env = newEnv();
  const discord = fakeDiscord({ noId: true });
  const { id } = await raiseAlert(env, ALERT, { fetchImpl: discord });

  const row = await acknowledgeAlert(env, id, 'spuddeh', { fetchImpl: discord });

  assert.equal(row.acknowledged_by, 'spuddeh');
  assert.equal(discord.edits().length, 0);
});

test('a failing Discord edit does not fail the acknowledgement', async () => {
  const env = newEnv();
  const { id } = await raiseAlert(env, ALERT, { fetchImpl: fakeDiscord() });

  const row = await acknowledgeAlert(env, id, 'spuddeh', {
    fetchImpl: fakeDiscord({ throws: true }),
  });

  assert.equal(row.acknowledged_by, 'spuddeh');
  assert.equal(await countUnacknowledged(env), 0);
});

test('discord_message_id never leaves the module', async () => {
  // The admin API hands these rows to a browser, and the id is the address of a
  // message an authenticated webhook can rewrite. It is plumbing, not data.
  const env = newEnv();
  const { id } = await raiseAlert(env, ALERT, { fetchImpl: fakeDiscord() });
  const acked = await acknowledgeAlert(env, id, 'spuddeh', { fetchImpl: fakeDiscord() });

  assert.equal('discord_message_id' in acked, false);
  assert.equal('discord_message_id' in (await readAlerts(env))[0], false);
});

test('resolving by ref closes every open alert about one submission', async () => {
  const env = newEnv();
  const discord = fakeDiscord();
  const ref = 'submission:42';
  await raiseAlert(env, { ...ALERT, source: 'submissions', ref }, { fetchImpl: discord });
  await raiseAlert(env, { ...ALERT, source: 'submissions', title: 'Reminder', ref },
    { fetchImpl: discord });
  await raiseAlert(env, { ...ALERT, source: 'submissions', ref: 'submission:43' },
    { fetchImpl: discord });

  const closed = await resolveAlertsByRef(env, ref, 'spuddeh', {
    verb: 'Approved', fetchImpl: discord,
  });

  assert.equal(closed, 2);
  assert.equal(await countUnacknowledged(env), 1, 'the other submission is untouched');
  assert.equal(discord.edits().length, 2);
  assert.match(discord.edits()[0].body.embeds[0].footer.text, /approved by spuddeh/);
});

test('resolving a ref nothing matches is zero, not a crash', async () => {
  const env = newEnv();
  assert.equal(await resolveAlertsByRef(env, 'submission:999', 'spuddeh'), 0);
  assert.equal(await resolveAlertsByRef(env, null, 'spuddeh'), 0);
});

test('the link is one composed body, in D1 and in the embed alike', async () => {
  // The resolved embed is rebuilt from the ROW, so if the row's body were
  // missing the link the message would lose it the moment it went green.
  const env = newEnv();
  const discord = fakeDiscord();
  const link = 'https://nczoning.net/admin/?submission=42';
  const { id } = await raiseAlert(env, { ...ALERT, link }, { fetchImpl: discord });

  const posted = discord.sent[0].body.embeds[0];
  assert.equal(posted.url, link, 'the embed title is the link');
  assert.ok(posted.description.includes(link));
  assert.ok((await readAlerts(env))[0].body.includes(link));

  await acknowledgeAlert(env, id, 'spuddeh', { fetchImpl: discord });
  assert.equal(discord.edits()[0].body.embeds[0].url, link, 'the link survives resolution');
});

test('submitter text cannot become Discord formatting', () => {
  const out = escapeDiscord('**@everyone** look\nat `this`');
  assert.equal(out.includes('\n'), false, 'a newline re-enables line-start formatting');
  assert.equal(out.includes('@everyone'), false, 'the mention has to be defused');
  assert.match(out, /\\\*\\\*/);
  assert.match(out, /\\`/);
});

// -------------------------------------------------------------- validation --

test('an unknown source or severity is refused, not stored', () => {
  assert.equal(validateAlertInput({ ...ALERT, source: 'made-up' }).ok, false);
  assert.equal(validateAlertInput({ ...ALERT, severity: 'catastrophic' }).ok, false);
  assert.equal(validateAlertInput({ ...ALERT, title: '   ' }).ok, false);
  assert.equal(validateAlertInput(ALERT).ok, true);
});

test('every declared source is accepted, so no producer is rejected at the door', () => {
  for (const source of ALERT_SOURCES) {
    assert.equal(validateAlertInput({ ...ALERT, source }).ok, true, `${source} was refused`);
  }
});

test('the nightly snapshot export can raise an alert under its own source', () => {
  // The workflow posts source:'export' to /internal/alerts. A source missing
  // from the allow-list is a 400, which turns a failed backup into a silent one.
  assert.equal(ALERT_SOURCES.includes('export'), true);
  assert.equal(validateAlertInput({ ...ALERT, source: 'export' }).ok, true);
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

test('the health monitor can post a log-only alert through the ingest', async () => {
  // The remote producer needs the same routing as the in-Worker ones, or the
  // wedged-cron alert (which self-heal already handles) keeps paging.
  const env = ingestEnv();
  const res = await handleInternal(post({ ...ALERT, source: 'api-health', notify: false }), env);
  assert.equal(res.status, 202);
  const body = await res.json();
  assert.equal(body.notified, false);
  assert.equal(body.forwarded, false);
  assert.equal((await readAlerts(env))[0].notify, 0, 'recorded regardless');
});

test('a non-boolean notify is a 400, not a silently-routed alert', async () => {
  const env = ingestEnv();
  const res = await handleInternal(post({ ...ALERT, notify: 'no' }), env);
  assert.equal(res.status, 400);
  assert.equal((await readAlerts(env)).length, 0);
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
