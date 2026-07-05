/**
 * Interactive API docs served from the Worker root. The OpenAPI spec
 * (worker/openapi.json) is the source of truth; the root page renders it
 * with Scalar (loaded from a CDN — this is a human docs page, not a
 * CSP-restricted context). Modders browsing to api.nczoning.net land here.
 */

import openapi from '../openapi.json' with { type: 'json' };

export const spec = openapi;

const PAGE = `<!doctype html>
<html>
<head>
  <title>NC Zoning Data API</title>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
</head>
<body>
  <script id="api-reference" data-url="/openapi.json"></script>
  <script src="https://cdn.jsdelivr.net/npm/@scalar/api-reference"></script>
</body>
</html>`;

export function docsPage() {
  return new Response(PAGE, {
    headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'public, max-age=300' },
  });
}
