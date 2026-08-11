import test from 'node:test';
import assert from 'node:assert/strict';
import { jsonOrThrow } from '../src/json.js';

// A 200 carrying an HTML body is what a Cloudflare challenge, a WAF
// interstitial, an origin error page and a Pages fallback all look like. The
// bare `SyntaxError: Unexpected token '<'` it used to produce named neither the
// URL nor the body, and both JSON parses in the cron's fatal path produced the
// same string, so a real production failure could not be attributed to either.

const HTML = '<!DOCTYPE html>\n<html><head><title>Just a moment...</title></head>\n<body>checking</body></html>';

/** A real-ish Response: clonable, with headers and a body read once. */
function response(body, { status = 200, type = 'text/html' } = {}) {
  const make = () => ({
    status,
    ok: status >= 200 && status < 300,
    headers: { get: (k) => (k.toLowerCase() === 'content-type' ? type : null) },
    async json() { return JSON.parse(body); },
    async text() { return body; },
    clone: () => make(),
  });
  return make();
}

test('a JSON body parses and nothing is disturbed', async () => {
  const res = response('{"districts":[1,2]}', { type: 'application/json' });
  assert.deepEqual(await jsonOrThrow(res, 'https://x/data.json'), { districts: [1, 2] });
});

test('an HTML body names the URL, the status, the content-type and the body', async () => {
  const res = response(HTML);
  await assert.rejects(
    () => jsonOrThrow(res, 'https://nczoning.net/data/subdistricts.json'),
    (err) => {
      assert.match(err.message, /https:\/\/nczoning\.net\/data\/subdistricts\.json/, 'the URL');
      assert.match(err.message, /200/, 'the status');
      assert.match(err.message, /text\/html/, 'the content-type');
      assert.match(err.message, /<!DOCTYPE html>/, 'the body, so it can be recognised');
      return true;
    },
  );
});

test('the snippet is one line and bounded', async () => {
  const res = response(`${HTML}\n${'x'.repeat(5000)}`);
  await assert.rejects(() => jsonOrThrow(res, 'https://x/y.json'), (err) => {
    assert.ok(err.message.length < 300, `message was ${err.message.length} chars`);
    assert.doesNotMatch(err.message, /\n/, 'a Discord embed and a log line both want one line');
    return true;
  });
});

test('a response with no clone() still reports the URL and status', async () => {
  // Every injected fake in worker/test/ is a plain object. Requiring clone()
  // would break all of them to gain a body snippet in tests that do not need it.
  const bare = {
    status: 200,
    ok: true,
    async json() { throw new SyntaxError("Unexpected token '<'"); },
  };
  await assert.rejects(() => jsonOrThrow(bare, 'https://x/y.json'), (err) => {
    assert.match(err.message, /https:\/\/x\/y\.json/);
    assert.match(err.message, /200/);
    assert.match(err.message, /no content-type/);
    return true;
  });
});

test('a body that cannot be re-read still produces a named error', async () => {
  const res = {
    status: 502,
    ok: false,
    headers: { get: () => 'text/html' },
    async json() { throw new SyntaxError('bad'); },
    clone: () => ({ async text() { throw new Error('body already used'); } }),
  };
  await assert.rejects(() => jsonOrThrow(res, 'https://x/y.json'), (err) => {
    assert.match(err.message, /https:\/\/x\/y\.json/);
    assert.match(err.message, /502/);
    return true;
  });
});
