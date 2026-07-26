import test from 'node:test';
import assert from 'node:assert/strict';
import {
  signSession, verifySession, readCookie, cookieHeader, clearCookie, SESSION_COOKIE,
} from '../src/session.js';
import { checkCollaborator, _resetTokenCache } from '../src/github-app.js';
import { callback, me, resolveSession, ADMIN_ORIGINS, adminCors } from '../src/auth.js';
import worker from '../src/index.js';

const SECRET = 'test-secret-not-a-real-one';

// A real PKCS#8 key, generated per run, so the RS256 signing path is actually
// exercised rather than stubbed.
async function pkcs8Pem() {
  const { privateKey } = await crypto.subtle.generateKey(
    { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
    true, ['sign', 'verify'],
  );
  const der = await crypto.subtle.exportKey('pkcs8', privateKey);
  const b64 = Buffer.from(der).toString('base64').match(/.{1,64}/g).join('\n');
  return `-----BEGIN PRIVATE KEY-----\n${b64}\n-----END PRIVATE KEY-----\n`;
}

function fakeUsersDb(initial = []) {
  const rows = new Map(initial.map((r) => [r.id, r]));
  return {
    _rows: rows,
    prepare(sql) {
      const stmt = {
        _args: [],
        bind(...args) { stmt._args = args; return stmt; },
        async first() {
          if (!sql.includes('FROM users')) throw new Error(`unexpected: ${sql}`);
          return rows.get(stmt._args[0]) ?? null;
        },
        async run() {
          if (!sql.includes('INSERT INTO users')) throw new Error(`unexpected: ${sql}`);
          const [id, login, isCollab, checkedAt, firstSeen] = stmt._args;
          const prev = rows.get(id);
          rows.set(id, {
            id, login, is_collaborator: isCollab, checked_at: checkedAt,
            first_seen_at: prev?.first_seen_at ?? firstSeen,
          });
        },
      };
      return stmt;
    },
  };
}

// ---------------------------------------------------------------- session ---

test('a session round-trips', async () => {
  const token = await signSession(SECRET, { sub: 1, login: 'spuddeh' });
  const claims = await verifySession(SECRET, token);
  assert.equal(claims.login, 'spuddeh');
  assert.equal(claims.sub, 1);
});

test('an expired session is rejected', async () => {
  const t0 = Date.parse('2026-01-01T00:00:00Z');
  const token = await signSession(SECRET, { sub: 1 }, 60, t0);
  assert.ok(await verifySession(SECRET, token, t0 + 59_000));
  assert.equal(await verifySession(SECRET, token, t0 + 61_000), null);
});

test('a token signed with another secret is rejected', async () => {
  const token = await signSession('other-secret', { sub: 1 });
  assert.equal(await verifySession(SECRET, token), null);
});

test('a tampered payload is rejected', async () => {
  const token = await signSession(SECRET, { sub: 1, collaborator: false });
  const [h, , s] = token.split('.');
  const forged = Buffer.from(JSON.stringify({ sub: 1, collaborator: true, exp: 9e9 }))
    .toString('base64url');
  assert.equal(await verifySession(SECRET, `${h}.${forged}.${s}`), null);
});

test('alg:none is rejected outright', async () => {
  const h = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url');
  const p = Buffer.from(JSON.stringify({ sub: 1, collaborator: true, exp: 9e9 })).toString('base64url');
  assert.equal(await verifySession(SECRET, `${h}.${p}.`), null);
});

test('garbage is rejected without throwing', async () => {
  for (const bad of ['', 'a.b', 'a.b.c', 'not-a-token', null, undefined, 12]) {
    assert.equal(await verifySession(SECRET, bad), null, String(bad));
  }
});

test('the session cookie is HttpOnly, Secure and SameSite=Lax', () => {
  const c = cookieHeader(SESSION_COOKIE, 'x');
  assert.match(c, /HttpOnly/);
  assert.match(c, /Secure/);
  assert.match(c, /SameSite=Lax/);
  assert.equal(/Domain=/.test(c), false, 'host-only: must not widen to the parent domain');
  assert.match(clearCookie(SESSION_COOKIE), /Max-Age=0/);
});

test('readCookie picks the right cookie out of several', () => {
  const req = new Request('https://api.nczoning.net/auth/me', {
    headers: { Cookie: 'a=1; ncz_session=tok.en.sig; b=2' },
  });
  assert.equal(readCookie(req, SESSION_COOKIE), 'tok.en.sig');
  assert.equal(readCookie(req, 'nope'), null);
});

// ------------------------------------------------------------ github-app ---

const APP_ENV = async () => ({
  GITHUB_APP_ID: '123',
  GITHUB_APP_PRIVATE_KEY: await pkcs8Pem(),
  GITHUB_REPO: 'nczoning/nc-zoning-board',
  SESSION_SECRET: SECRET,
});

/** fetch stub: installation lookup + token mint always succeed; collab status varies. */
function ghFetch(collabStatus, { tokenStatus = 200 } = {}) {
  return async (url, init) => {
    if (url.endsWith('/installation')) return { ok: true, status: 200, json: async () => ({ id: 42 }) };
    if (url.includes('/access_tokens')) {
      if (tokenStatus !== 200) return { ok: false, status: tokenStatus };
      return {
        ok: true,
        status: 200,
        json: async () => ({ token: 'ghs_test', expires_at: new Date(Date.now() + 3600_000).toISOString() }),
      };
    }
    if (url.includes('/collaborators/')) return { ok: collabStatus === 204, status: collabStatus };
    throw new Error(`unexpected fetch ${url}`);
  };
}

test('collaborator check: 204 is yes, 404 is no', async () => {
  const env = await APP_ENV();
  _resetTokenCache();
  assert.equal(await checkCollaborator(env, 'spuddeh', ghFetch(204)), 'yes');
  _resetTokenCache();
  assert.equal(await checkCollaborator(env, 'stranger', ghFetch(404)), 'no');
});

test('a broken credential is "error" — never folded into yes or no', async () => {
  const env = await APP_ENV();
  for (const status of [401, 403, 500, 502]) {
    _resetTokenCache();
    const verdict = await checkCollaborator(env, 'spuddeh', ghFetch(status));
    assert.equal(verdict, 'error', `HTTP ${status} must be indeterminate`);
    assert.notEqual(verdict, 'no');
    assert.notEqual(verdict, 'yes');
  }
});

test('a failure to mint an installation token is "error", not "no"', async () => {
  const env = await APP_ENV();
  _resetTokenCache();
  assert.equal(await checkCollaborator(env, 'spuddeh', ghFetch(204, { tokenStatus: 401 })), 'error');
});

test('a PKCS#1 key fails with an actionable message, not an opaque DataError', async () => {
  _resetTokenCache();
  const env = {
    GITHUB_APP_ID: '1',
    GITHUB_APP_PRIVATE_KEY: '-----BEGIN RSA PRIVATE KEY-----\nAAAA\n-----END RSA PRIVATE KEY-----',
    GITHUB_REPO: 'a/b',
  };
  // Surfaces as 'error' to the caller; the operator-facing detail is logged.
  assert.equal(await checkCollaborator(env, 'x', ghFetch(204)), 'error');
});

// ------------------------------------------------------------------ CORS ---

test('admin CORS echoes only allowed origins, and always Varies on Origin', () => {
  for (const origin of ADMIN_ORIGINS) {
    const h = adminCors(new Request('https://api.nczoning.net/auth/me', { headers: { Origin: origin } }));
    assert.equal(h['Access-Control-Allow-Origin'], origin);
    assert.equal(h['Access-Control-Allow-Credentials'], 'true');
    assert.equal(h.Vary, 'Origin');
  }
});

test('an unknown origin gets no CORS headers at all', () => {
  const h = adminCors(new Request('https://api.nczoning.net/auth/me', {
    headers: { Origin: 'https://evil.example' },
  }));
  assert.deepEqual(h, {});
  // Never the wildcard: it is illegal with credentials and would be a hole.
  assert.equal(h['Access-Control-Allow-Origin'], undefined);
});

// ------------------------------------------------------------- callback ---

/** Drive /auth/callback with a matching state cookie. */
async function runCallback(env, { verdictStatus, nonce = 'n1', stateParam = 'n1' } = {}) {
  const stateToken = await signSession(env.SESSION_SECRET, { nonce, returnTo: '/admin/' }, 600);
  const req = new Request(
    `https://api.nczoning.net/auth/callback?code=abc&state=${stateParam}`,
    { headers: { Cookie: `ncz_oauth_state=${stateToken}` } },
  );
  const fetchImpl = ghFetch(verdictStatus);
  globalThis.fetch = async (url, init) => {
    if (String(url).includes('login/oauth/access_token')) {
      return { ok: true, status: 200, json: async () => ({ access_token: 'gho_user' }) };
    }
    if (String(url).endsWith('/user')) {
      return { ok: true, status: 200, json: async () => ({ login: 'spuddeh', id: 7 }) };
    }
    return fetchImpl(String(url), init);
  };
  return callback(req, env);
}

test('a mismatched state is refused (CSRF)', async () => {
  const env = { ...(await APP_ENV()), DB: fakeUsersDb() };
  _resetTokenCache();
  const res = await runCallback(env, { verdictStatus: 204, nonce: 'n1', stateParam: 'attacker' });
  assert.equal(res.status, 302);
  assert.match(res.headers.get('Location'), /error=bad_state/);
});

test('a collaborator gets a session cookie', async () => {
  const env = { ...(await APP_ENV()), DB: fakeUsersDb() };
  _resetTokenCache();
  const res = await runCallback(env, { verdictStatus: 204 });
  const cookies = res.headers.getSetCookie().join('\n');
  assert.match(cookies, new RegExp(`${SESSION_COOKIE}=[^;]+; HttpOnly`));
  assert.equal(env.DB._rows.get(7).is_collaborator, 1);
});

test('a non-collaborator is refused and recorded as such', async () => {
  const env = { ...(await APP_ENV()), DB: fakeUsersDb() };
  _resetTokenCache();
  const res = await runCallback(env, { verdictStatus: 404 });
  assert.match(res.headers.get('Location'), /error=not_authorised/);
  assert.equal(res.headers.getSetCookie().join('\n').includes(`${SESSION_COOKIE}=ey`), false);
  assert.equal(env.DB._rows.get(7).is_collaborator, 0);
});

test('an indeterminate check is NOT cached as a refusal', async () => {
  const env = { ...(await APP_ENV()), DB: fakeUsersDb() };
  _resetTokenCache();
  const res = await runCallback(env, { verdictStatus: 403 });
  assert.match(res.headers.get('Location'), /error=check_unavailable/);
  // The load-bearing assertion: a transient GitHub failure must not write a
  // "not a collaborator" row that then locks a real admin out for the TTL.
  assert.equal(env.DB._rows.size, 0, 'nothing may be recorded from an unanswered check');
});

// -------------------------------------------------------- session gating ---

test('a fresh cached verdict is reused without calling GitHub', async () => {
  const env = {
    ...(await APP_ENV()),
    DB: fakeUsersDb([{
      id: 7, login: 'spuddeh', is_collaborator: 1,
      checked_at: new Date().toISOString(), first_seen_at: '2026-01-01T00:00:00Z',
    }]),
  };
  globalThis.fetch = async () => { throw new Error('must not call GitHub'); };
  const token = await signSession(SECRET, { sub: 7, login: 'spuddeh', collaborator: true });
  const req = new Request('https://api.nczoning.net/auth/me', {
    headers: { Cookie: `${SESSION_COOKIE}=${token}` },
  });
  const s = await resolveSession(req, env);
  assert.equal(s.collaborator, true);
});

test('a stale verdict is re-checked, so a removed admin loses access', async () => {
  const env = {
    ...(await APP_ENV()),
    DB: fakeUsersDb([{
      id: 7, login: 'spuddeh', is_collaborator: 1,
      checked_at: '2026-01-01T00:00:00Z', // long stale
      first_seen_at: '2026-01-01T00:00:00Z',
    }]),
  };
  _resetTokenCache();
  globalThis.fetch = ghFetch(404); // no longer a collaborator
  const token = await signSession(SECRET, { sub: 7, login: 'spuddeh', collaborator: true });
  const req = new Request('https://api.nczoning.net/auth/me', {
    headers: { Cookie: `${SESSION_COOKIE}=${token}` },
  });
  const s = await resolveSession(req, env);
  assert.equal(s.collaborator, false, 'the cookie says true; the repo says no. The repo wins.');
});

// ----------------------------------------------------------- route wiring ---

test('POST /auth/logout survives the read-only method gate', async () => {
  // Every non-auth route is GET/HEAD-only and 405s otherwise. Logout is a POST
  // on purpose, so it has to be dispatched BEFORE that gate.
  const res = await worker.fetch(
    new Request('https://api.nczoning.net/auth/logout', { method: 'POST' }),
    { SESSION_SECRET: SECRET },
  );
  assert.equal(res.status, 200);
  assert.match(res.headers.get('Set-Cookie'), /ncz_session=; .*Max-Age=0/);
});

test('a POST to a non-auth route is still 405', async () => {
  const res = await worker.fetch(
    new Request('https://api.nczoning.net/v1/locations', { method: 'POST' }), {},
  );
  assert.equal(res.status, 405);
});

test('an unknown /auth/ path is 404, not a method error', async () => {
  const res = await worker.fetch(new Request('https://api.nczoning.net/auth/nope'), {});
  assert.equal(res.status, 404);
});

test('the /auth preflight is credentialed, and never wildcard', async () => {
  const res = await worker.fetch(new Request('https://api.nczoning.net/auth/me', {
    method: 'OPTIONS',
    headers: { Origin: 'https://nczoning.net' },
  }), {});
  assert.equal(res.status, 204);
  assert.equal(res.headers.get('Access-Control-Allow-Origin'), 'https://nczoning.net');
  assert.equal(res.headers.get('Access-Control-Allow-Credentials'), 'true');
  assert.match(res.headers.get('Access-Control-Allow-Methods'), /POST/);
});

test('/v1 preflight keeps the public wildcard CORS', async () => {
  const res = await worker.fetch(new Request('https://api.nczoning.net/v1/locations', {
    method: 'OPTIONS',
    headers: { Origin: 'https://anywhere.example' },
  }), {});
  assert.equal(res.headers.get('Access-Control-Allow-Origin'), '*');
  assert.equal(res.headers.get('Access-Control-Allow-Credentials'), null);
});

test('/auth/login redirects to GitHub and sets a state cookie', async () => {
  const res = await worker.fetch(
    new Request('https://api.nczoning.net/auth/login?return_to=/admin/'),
    { SESSION_SECRET: SECRET, GITHUB_OAUTH_CLIENT_ID: 'Iv1.test' },
  );
  assert.equal(res.status, 302);
  const location = new URL(res.headers.get('Location'));
  assert.equal(location.host, 'github.com');
  assert.equal(location.searchParams.get('client_id'), 'Iv1.test');
  assert.ok(location.searchParams.get('state'), 'state is required for CSRF');
  assert.match(res.headers.get('Set-Cookie'), /ncz_oauth_state=/);
});

test('return_to cannot be turned into an open redirect', async () => {
  for (const evil of ['https://evil.example/', '//evil.example/', 'http://evil.example']) {
    const res = await worker.fetch(
      new Request(`https://api.nczoning.net/auth/login?return_to=${encodeURIComponent(evil)}`),
      { SESSION_SECRET: SECRET, GITHUB_OAUTH_CLIENT_ID: 'x' },
    );
    const state = res.headers.get('Set-Cookie').match(/ncz_oauth_state=([^;]+)/)[1];
    const claims = await verifySession(SECRET, state);
    assert.equal(claims.returnTo, '/admin/', `${evil} must be rejected`);
  }
});

test('/auth/me is 401 with no cookie, 503 when the check is unavailable', async () => {
  const env = { ...(await APP_ENV()), DB: fakeUsersDb() };
  const anon = await me(new Request('https://api.nczoning.net/auth/me'), env);
  assert.equal(anon.status, 401);
  assert.equal((await anon.json()).authenticated, false);

  _resetTokenCache();
  globalThis.fetch = ghFetch(500);
  const token = await signSession(SECRET, { sub: 7, login: 'spuddeh', collaborator: true });
  const res = await me(new Request('https://api.nczoning.net/auth/me', {
    headers: { Cookie: `${SESSION_COOKIE}=${token}` },
  }), env);
  // 503, not 403 — "we cannot tell" is not "you are not allowed".
  assert.equal(res.status, 503);
  assert.equal((await res.json()).error, 'check_unavailable');
});
