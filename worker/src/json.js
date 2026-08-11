/**
 * Parsing a response body as JSON, with an error that says what actually
 * arrived.
 *
 * ## Why this exists
 *
 * `res.ok && await res.json()` is the obvious shape and it fails uselessly. An
 * upstream that answers **200 with an HTML body** passes the `ok` check and
 * dies in the parser, and the thrown error is:
 *
 *     SyntaxError: Unexpected token '<', "<!DOCTYPE "... is not valid JSON
 *
 * No URL, no status, no content-type. On 2026-08-02 that alert fired on four
 * consecutive production cron ticks and could not be attributed to either of
 * the two fetches capable of producing it, because both produce exactly the
 * same string. A cron whose failure path serves last-known-good is quiet by
 * design, so the alert text is the only diagnostic anyone gets.
 *
 * The 200-with-HTML case is not exotic. A Cloudflare challenge, a WAF
 * interstitial, an origin error page and a Pages SPA fallback all do it.
 *
 * ## Why the body is read from a clone
 *
 * `res.json()` consumes the body, so the text is unavailable afterwards to
 * describe what went wrong. Cloning first costs nothing on the success path and
 * is the only way to quote the body on the failure path.
 *
 * A response without `clone()` still gets the URL, the status and the
 * content-type: the injected fakes throughout `worker/test/` are plain objects,
 * and this must not force every one of them to grow a method to keep working.
 */

/** Enough of the body to recognise what it is, on one line. */
const SNIPPET = 100;

/**
 * @param {Response} res  an already-checked response (call sites test `res.ok`)
 * @param {string} url    what was requested, for the error message
 * @returns {Promise<any>} the parsed body
 * @throws {Error} naming the URL, status, content-type and the body's opening
 */
export async function jsonOrThrow(res, url) {
  const copy = typeof res?.clone === 'function' ? res.clone() : null;
  try {
    return await res.json();
  } catch (err) {
    const type = res?.headers?.get?.('content-type') || 'no content-type';
    let head = '';
    if (copy) {
      try {
        head = (await copy.text()).trim().replace(/\s+/g, ' ').slice(0, SNIPPET);
      } catch {
        // The clone is a convenience. Losing it costs the snippet, not the error.
      }
    }
    throw new Error(
      `GET ${url} -> HTTP ${res?.status ?? '?'} ${type}, not JSON`
      + `${head ? `: "${head}"` : ` (${String(err).slice(0, 80)})`}`,
    );
  }
}
