/**
 * GitHub App credentials: mint an app JWT, exchange it for an installation
 * token, and answer "is this login a collaborator on the repo?".
 *
 * A GitHub App rather than a PAT because a fine-grained PAT expires within a
 * year and is tied to one person's account — so admin access would break on a
 * date nobody remembers, in a way that looks like "everyone is suddenly not a
 * collaborator". The installation token expires hourly and is renewed here, so
 * there is no calendar landmine.
 */

const GITHUB_API = 'https://api.github.com';
const UA = 'nczoning-api';

// Installation token cache. Workers reuses an isolate across requests, so this
// usually avoids the two-call handshake; a cold isolate just pays it again.
// Correctness never depends on the cache surviving.
let tokenCache = { token: null, expiresAtMs: 0, installationId: null };

/** Reset the module-level cache. Tests only. */
export function _resetTokenCache() {
  tokenCache = { token: null, expiresAtMs: 0, installationId: null };
}

const enc = new TextEncoder();
const b64url = (bytes) => btoa(String.fromCharCode(...new Uint8Array(bytes)))
  .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

/**
 * Import a PEM private key for RS256.
 *
 * GitHub hands out **PKCS#1** keys ("BEGIN RSA PRIVATE KEY"). WebCrypto only
 * imports **PKCS#8** ("BEGIN PRIVATE KEY"), so the key must be converted once
 * at setup:
 *
 *   openssl pkcs8 -topk8 -inform PEM -outform PEM -nocrypt \
 *     -in downloaded.pem -out pkcs8.pem
 *
 * Detected explicitly, because the raw DER-parse failure is an opaque
 * "DataError" that gives no hint what is wrong.
 */
async function importPrivateKey(pem) {
  if (!pem || typeof pem !== 'string') throw new Error('GITHUB_APP_PRIVATE_KEY is not set');
  if (pem.includes('BEGIN RSA PRIVATE KEY')) {
    throw new Error(
      'GITHUB_APP_PRIVATE_KEY is PKCS#1; WebCrypto needs PKCS#8. Convert it with: '
      + 'openssl pkcs8 -topk8 -inform PEM -outform PEM -nocrypt -in downloaded.pem -out pkcs8.pem',
    );
  }
  const body = pem.replace(/-----(BEGIN|END) PRIVATE KEY-----/g, '').replace(/\s+/g, '');
  const der = Uint8Array.from(atob(body), (c) => c.charCodeAt(0));
  return crypto.subtle.importKey(
    'pkcs8', der, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign'],
  );
}

/**
 * App JWT, used only to obtain an installation token. GitHub rejects an `exp`
 * more than 10 minutes out and is strict about clock skew, hence the backdated
 * `iat`.
 */
async function appJwt(env, nowMs = Date.now()) {
  const now = Math.floor(nowMs / 1000);
  const header = b64url(enc.encode(JSON.stringify({ alg: 'RS256', typ: 'JWT' })));
  const claims = b64url(enc.encode(JSON.stringify({
    iat: now - 60,        // tolerate GitHub's clock running behind the Worker's
    exp: now + 9 * 60,    // under GitHub's 10-minute ceiling
    iss: env.GITHUB_APP_ID,
  })));
  const input = `${header}.${claims}`;
  const key = await importPrivateKey(env.GITHUB_APP_PRIVATE_KEY);
  const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, enc.encode(input));
  return `${input}.${b64url(sig)}`;
}

const ghHeaders = (auth) => ({
  Authorization: `Bearer ${auth}`,
  Accept: 'application/vnd.github+json',
  'X-GitHub-Api-Version': '2022-11-28',
  'User-Agent': UA,
});

/**
 * The App's installation id on the repo, discovered rather than configured —
 * one less secret to set, and one less thing to be quietly wrong after a
 * reinstall.
 */
async function installationId(env, fetchImpl, jwt) {
  if (tokenCache.installationId) return tokenCache.installationId;
  const res = await fetchImpl(`${GITHUB_API}/repos/${env.GITHUB_REPO}/installation`, {
    headers: ghHeaders(jwt),
  });
  if (!res.ok) {
    throw new Error(`installation lookup failed: HTTP ${res.status} (is the App installed on ${env.GITHUB_REPO}?)`);
  }
  const body = await res.json();
  tokenCache.installationId = body.id;
  return body.id;
}

/** A valid installation token, from cache when possible. */
export async function getInstallationToken(env, fetchImpl = fetch, nowMs = Date.now()) {
  // 60s of headroom so a token cannot expire mid-flight.
  if (tokenCache.token && tokenCache.expiresAtMs - 60_000 > nowMs) return tokenCache.token;

  const jwt = await appJwt(env, nowMs);
  const id = await installationId(env, fetchImpl, jwt);
  const res = await fetchImpl(`${GITHUB_API}/app/installations/${id}/access_tokens`, {
    method: 'POST',
    headers: ghHeaders(jwt),
  });
  if (!res.ok) throw new Error(`installation token failed: HTTP ${res.status}`);
  const body = await res.json();
  tokenCache.token = body.token;
  tokenCache.expiresAtMs = Date.parse(body.expires_at);
  return body.token;
}

/**
 * Is `login` a collaborator on the repo?
 *
 * THREE OUTCOMES, NOT TWO. The endpoint answers 204 for yes and 404 for no,
 * and a broken or unauthorised credential answers 401/403. Folding that third
 * case into either of the first two is a security bug in both directions:
 *
 *   "not 404 -> allow"  => a dead credential grants everyone admin
 *   "not 204 -> deny"   => a dead credential locks everyone out, silently
 *
 * So it is returned as its own value. Callers must fail closed AND surface it —
 * never treat 'error' as a normal no.
 *
 * @returns {Promise<'yes'|'no'|'error'>}
 */
export async function checkCollaborator(env, login, fetchImpl = fetch) {
  let token;
  try {
    token = await getInstallationToken(env, fetchImpl);
  } catch (err) {
    console.error('collaborator check: cannot obtain installation token:', String(err).slice(0, 200));
    return 'error';
  }

  const res = await fetchImpl(
    `${GITHUB_API}/repos/${env.GITHUB_REPO}/collaborators/${encodeURIComponent(login)}`,
    { headers: ghHeaders(token) },
  );

  if (res.status === 204) return 'yes';
  if (res.status === 404) return 'no';

  // 401/403/5xx: the question was not answered. Say so.
  console.error(`collaborator check for ${login}: unexpected HTTP ${res.status}`);
  // A 401 means the cached token is bad; drop it so the next attempt re-mints.
  if (res.status === 401) _resetTokenCache();
  return 'error';
}

/** Exchange an OAuth code for a user access token. */
export async function exchangeOAuthCode(env, code, fetchImpl = fetch) {
  const res = await fetchImpl('https://github.com/login/oauth/access_token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'User-Agent': UA },
    body: JSON.stringify({
      client_id: env.GITHUB_OAUTH_CLIENT_ID,
      client_secret: env.GITHUB_OAUTH_CLIENT_SECRET,
      code,
    }),
  });
  if (!res.ok) throw new Error(`oauth exchange failed: HTTP ${res.status}`);
  const body = await res.json();
  // GitHub returns 200 with an `error` field on a bad/expired code.
  if (body.error || !body.access_token) {
    throw new Error(`oauth exchange rejected: ${body.error || 'no access_token'}`);
  }
  return body.access_token;
}

/** The authenticated user's identity, from their own token. */
export async function fetchViewer(userToken, fetchImpl = fetch) {
  const res = await fetchImpl(`${GITHUB_API}/user`, { headers: ghHeaders(userToken) });
  if (!res.ok) throw new Error(`viewer lookup failed: HTTP ${res.status}`);
  const body = await res.json();
  if (!body.login || !body.id) throw new Error('viewer lookup returned no login/id');
  return { login: body.login, id: body.id };
}
