/**
 * Signed session tokens (HS256 JWT) and the cookie they ride in.
 *
 * Deliberately not a JWT library: this issues and verifies its OWN tokens with
 * one algorithm and one key, so the whole "alg" negotiation surface that makes
 * JWT libraries dangerous simply does not exist here. `alg` is checked against
 * the literal "HS256" and anything else is rejected before a signature is even
 * computed — `alg: "none"` is not a code path.
 *
 * The cookie is host-only (no Domain attribute) so it is scoped to
 * api.nczoning.net alone. SameSite=Lax is correct even though the dashboard is
 * served from nczoning.net: SameSite is judged on the registrable domain, and
 * nczoning.net and api.nczoning.net are the same *site* despite being different
 * *origins*. The cross-origin part is handled by CORS, not by the cookie.
 */

export const SESSION_COOKIE = 'ncz_session';
export const SESSION_TTL_S = 8 * 60 * 60; // 8h: a working session, not a trust anchor

const enc = new TextEncoder();

const b64urlEncode = (bytes) => btoa(String.fromCharCode(...new Uint8Array(bytes)))
  .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

const b64urlDecode = (str) => {
  const padded = str.replace(/-/g, '+').replace(/_/g, '/')
    + '='.repeat((4 - (str.length % 4)) % 4);
  return Uint8Array.from(atob(padded), (c) => c.charCodeAt(0));
};

async function hmacKey(secret) {
  return crypto.subtle.importKey(
    'raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify'],
  );
}

/**
 * Mint a token. `payload` is merged with iat/exp; callers must not set those.
 * @param {string} secret
 * @param {object} payload
 * @param {number} [ttlSeconds]
 * @param {number} [nowMs] injectable clock, so tests can assert expiry
 */
export async function signSession(secret, payload, ttlSeconds = SESSION_TTL_S, nowMs = Date.now()) {
  const iat = Math.floor(nowMs / 1000);
  const body = { ...payload, iat, exp: iat + ttlSeconds };
  const head = b64urlEncode(enc.encode(JSON.stringify({ alg: 'HS256', typ: 'JWT' })));
  const claims = b64urlEncode(enc.encode(JSON.stringify(body)));
  const signingInput = `${head}.${claims}`;
  const sig = await crypto.subtle.sign('HMAC', await hmacKey(secret), enc.encode(signingInput));
  return `${signingInput}.${b64urlEncode(sig)}`;
}

/**
 * Verify and decode. Returns the payload, or null for ANY failure — bad shape,
 * wrong algorithm, bad signature, expired. Callers get one answer to one
 * question, so there is no way to accidentally treat "malformed" as "valid".
 *
 * crypto.subtle.verify is constant-time, which is why the comparison is done
 * there rather than by re-signing and string-comparing.
 */
export async function verifySession(secret, token, nowMs = Date.now()) {
  if (typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [head, claims, sig] = parts;

  try {
    const header = JSON.parse(new TextDecoder().decode(b64urlDecode(head)));
    // Pin the algorithm. "none" and any asymmetric confusion die here.
    if (header.alg !== 'HS256' || header.typ !== 'JWT') return null;

    const ok = await crypto.subtle.verify(
      'HMAC', await hmacKey(secret), b64urlDecode(sig), enc.encode(`${head}.${claims}`),
    );
    if (!ok) return null;

    const payload = JSON.parse(new TextDecoder().decode(b64urlDecode(claims)));
    if (typeof payload.exp !== 'number' || payload.exp * 1000 <= nowMs) return null;
    return payload;
  } catch {
    return null; // malformed base64/JSON is just an invalid token
  }
}

/** Read one cookie from a request. */
export function readCookie(request, name) {
  const header = request.headers.get('Cookie');
  if (!header) return null;
  for (const part of header.split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return v.join('=');
  }
  return null;
}

/**
 * Build a Set-Cookie value. `Secure` is unconditional: these cookies only ever
 * travel over the custom domains, which are HTTPS-only.
 */
export function cookieHeader(name, value, { maxAge = SESSION_TTL_S, path = '/' } = {}) {
  return `${name}=${value}; HttpOnly; Secure; SameSite=Lax; Path=${path}; Max-Age=${maxAge}`;
}

/** Expire a cookie immediately (logout, or clearing the one-shot state cookie). */
export function clearCookie(name, path = '/') {
  return `${name}=; HttpOnly; Secure; SameSite=Lax; Path=${path}; Max-Age=0`;
}
