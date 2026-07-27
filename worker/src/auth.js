/**
 * GitHub OAuth + the collaborator gate. Phase 3: login only, no writes to
 * anything but the `users` verdict cache.
 *
 * Flow:
 *   GET /auth/login     -> 302 to GitHub, one-shot signed `state` cookie set
 *   GET /auth/callback  -> verify state, exchange code, identify the user,
 *                          check collaborator status server-side, set session
 *   GET /auth/me        -> who am I, and am I allowed
 *   POST /auth/logout   -> clear the session
 *
 * The user's own OAuth token is used for exactly one thing — reading their
 * login — and is never stored. Collaborator status is checked with the App's
 * installation token, so admins never grant `repo` scope to see whether they
 * are admins.
 */

import {
  SESSION_COOKIE, SESSION_TTL_S, signSession, verifySession,
  readCookie, cookieHeader, clearCookie,
} from './session.js';
import { exchangeOAuthCode, fetchViewer, checkCollaborator } from './github-app.js';
import { readCachedVerdict, recordUser } from './d1.js';

const STATE_COOKIE = 'ncz_oauth_state';
const STATE_TTL_S = 10 * 60;

/**
 * Origins allowed to call the auth/admin routes with credentials.
 *
 * `Access-Control-Allow-Origin: *` is illegal alongside
 * `Allow-Credentials: true`, so these routes cannot reuse the public wildcard
 * CORS that /v1/* serves. The origin must be echoed back exactly, and only for
 * origins on this list.
 */
export const ADMIN_ORIGINS = [
  'https://nczoning.net',
  'https://www.nczoning.net',
  'https://dev.nczoning.net',
  'http://127.0.0.1:3000',
  'http://localhost:3000',
];

export function adminCors(request) {
  const origin = request.headers.get('Origin');
  if (!origin || !ADMIN_ORIGINS.includes(origin)) return {};
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Credentials': 'true',
    // Echoing the origin means caches must key on it, or one visitor's
    // permitted origin is served to another's.
    Vary: 'Origin',
  };
}

const jsonResponse = (request, body, { status = 200, headers = {} } = {}) => new Response(
  JSON.stringify(body),
  {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      ...adminCors(request),
      ...headers,
    },
  },
);

/**
 * Where to send the browser after a successful login. Only paths on an allowed
 * origin are honoured — an attacker-supplied absolute URL here would turn the
 * login endpoint into an open redirect that launders GitHub's credibility.
 */
function safeReturnTo(raw) {
  if (!raw) return '/admin/';
  if (!raw.startsWith('/') || raw.startsWith('//')) return '/admin/';
  return raw;
}

function siteOrigin(env) {
  return env.ADMIN_ORIGIN || 'https://nczoning.net';
}

/** GET /auth/login */
export async function login(request, env) {
  const url = new URL(request.url);
  const returnTo = safeReturnTo(url.searchParams.get('return_to'));

  // CSRF: a random nonce, signed into a short-lived cookie and echoed through
  // GitHub as `state`. The callback accepts only a state matching the cookie,
  // so a forged callback with an attacker's code cannot log a victim in.
  const nonce = crypto.randomUUID();
  const stateToken = await signSession(env.SESSION_SECRET, { nonce, returnTo }, STATE_TTL_S);

  const authorize = new URL('https://github.com/login/oauth/authorize');
  authorize.searchParams.set('client_id', env.GITHUB_OAUTH_CLIENT_ID);
  authorize.searchParams.set('redirect_uri', `${new URL(request.url).origin}/auth/callback`);
  authorize.searchParams.set('state', nonce);

  return new Response(null, {
    status: 302,
    headers: {
      Location: authorize.toString(),
      'Set-Cookie': cookieHeader(STATE_COOKIE, stateToken, { maxAge: STATE_TTL_S, path: '/auth' }),
      'Cache-Control': 'no-store',
    },
  });
}

/** Bounce back to the dashboard with a machine-readable reason. */
function failRedirect(env, reason) {
  const to = new URL('/admin/', siteOrigin(env));
  to.searchParams.set('error', reason);
  return new Response(null, {
    status: 302,
    headers: {
      Location: to.toString(),
      'Set-Cookie': clearCookie(STATE_COOKIE, '/auth'),
      'Cache-Control': 'no-store',
    },
  });
}

/** GET /auth/callback */
export async function callback(request, env) {
  const url = new URL(request.url);
  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');

  const stateToken = readCookie(request, STATE_COOKIE);
  const stateClaims = stateToken ? await verifySession(env.SESSION_SECRET, stateToken) : null;
  if (!code || !state || !stateClaims || stateClaims.nonce !== state) {
    return failRedirect(env, 'bad_state');
  }

  let viewer;
  try {
    const userToken = await exchangeOAuthCode(env, code);
    viewer = await fetchViewer(userToken);
    // The user token is intentionally not stored, and goes out of scope here.
  } catch (err) {
    console.error('oauth callback:', String(err).slice(0, 200));
    return failRedirect(env, 'oauth_failed');
  }

  const verdict = await checkCollaborator(env, viewer.login);

  // Indeterminate is not "no". Fail closed, but do NOT cache it and do not
  // tell the user they lack access — a transient GitHub blip would otherwise
  // lock a real admin out for the whole cache TTL.
  if (verdict === 'error') return failRedirect(env, 'check_unavailable');

  const isCollaborator = verdict === 'yes';
  await recordUser(env, { id: viewer.id, login: viewer.login, isCollaborator });

  if (!isCollaborator) return failRedirect(env, 'not_authorised');

  const session = await signSession(env.SESSION_SECRET, {
    sub: viewer.id, login: viewer.login, collaborator: true,
  });

  const to = new URL(safeReturnTo(stateClaims.returnTo), siteOrigin(env));
  const headers = new Headers({ Location: to.toString(), 'Cache-Control': 'no-store' });
  headers.append('Set-Cookie', cookieHeader(SESSION_COOKIE, session));
  headers.append('Set-Cookie', clearCookie(STATE_COOKIE, '/auth'));
  return new Response(null, { status: 302, headers });
}

/**
 * Resolve the caller's session, re-checking collaborator status when the
 * cached verdict has aged out. Returns null when unauthenticated.
 *
 * This is the function every future /admin/* route gates on, which is why it
 * re-checks rather than trusting the session cookie's own `collaborator: true`:
 * the cookie lives 8 hours, and removing someone from the repo has to take
 * effect sooner than that.
 */
export async function resolveSession(request, env) {
  const token = readCookie(request, SESSION_COOKIE);
  if (!token) return null;
  const claims = await verifySession(env.SESSION_SECRET, token);
  if (!claims) return null;

  const cached = await readCachedVerdict(env, claims.sub);
  if (cached) return { ...claims, collaborator: cached.isCollaborator };

  const verdict = await checkCollaborator(env, claims.login);
  if (verdict === 'error') {
    // Cannot answer. Fail closed for this request without recording anything.
    return { ...claims, collaborator: false, indeterminate: true };
  }
  const isCollaborator = verdict === 'yes';
  await recordUser(env, { id: claims.sub, login: claims.login, isCollaborator });
  return { ...claims, collaborator: isCollaborator };
}

/** GET /auth/me */
export async function me(request, env) {
  const session = await resolveSession(request, env);
  if (!session) {
    return jsonResponse(request, { authenticated: false }, { status: 401 });
  }
  if (session.indeterminate) {
    // 503, not 403: the answer is unknown, not negative. A dashboard that
    // rendered "you are not authorised" here would be lying.
    return jsonResponse(request, {
      authenticated: true,
      login: session.login,
      collaborator: false,
      error: 'check_unavailable',
    }, { status: 503 });
  }
  return jsonResponse(request, {
    authenticated: true,
    login: session.login,
    collaborator: session.collaborator,
  }, { status: session.collaborator ? 200 : 403 });
}

/** POST /auth/logout */
export function logout(request) {
  return jsonResponse(request, { authenticated: false }, {
    headers: { 'Set-Cookie': clearCookie(SESSION_COOKIE) },
  });
}
