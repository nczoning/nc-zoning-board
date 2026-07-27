# Privacy

What NC Zoning Board stores about people, why, and for how long.

Until submissions moved onto the site, this page had nothing to describe: mods
arrived as GitHub issues and pull requests, so everything about a submitter was
already public on GitHub and none of it was ours. `POST /submissions` is the
first personal data the site collects itself.

## Submitting a location

Submitting through the map stores one submission record, holding:

| What | Why | Kept for |
| --- | --- | --- |
| The location data you filled in | It is the submission. Once approved it becomes a public map record. | Indefinitely |
| Your note to the reviewer, if you wrote one | Context for the person reviewing it. | Indefinitely |
| Your contact, if you gave one | So a reviewer can ask a question about your submission. **Optional**, and used for nothing else. | Indefinitely |
| A one-way hash of your IP address | Rate limiting, and tracing abuse if the queue is flooded. | 90 days |

**The IP address itself is never stored.** What is stored is a SHA-256 hash of
your address combined with a secret salt held by the server. The salt is what
makes this meaningful: without one, a hash of an IPv4 address can be reversed by
trying all four billion of them, so an unsalted hash would be a stored address
wearing a disguise. If the salt is missing the API refuses submissions rather
than storing anything weaker.

The hash is cleared 90 days after the submission arrives, whether or not it has
been reviewed by then. The submission itself is kept; only the hash is removed.

## Bot protection

The submit form uses [Cloudflare Turnstile](https://www.cloudflare.com/products/turnstile/),
which checks that a submission comes from a browser rather than a script.
Cloudflare receives the token from that widget and your IP address as part of
verifying it. Turnstile is used instead of a CAPTCHA because it does not track
you across sites and usually asks you to do nothing.

## Browsing the map

The map is a static site. It sets no cookies of its own, has no analytics, and
there is no visitor account to sign in to.

What it keeps is held **in your own browser** and never sent anywhere: your
theme, which 3D asset set you chose, the width you dragged the cluster panel to,
your flyover options, a short-lived cache of the map data so a revisit does not
refetch it, and a flag marking that you have seen the welcome panel this
session. Clearing your site data removes all of it.

Requests to `nczoning.net` and `api.nczoning.net` pass through Cloudflare, which
processes IP addresses to serve and protect the site and may set its own cookies
for that purpose. That is ordinary CDN behaviour and applies to any site behind
Cloudflare.

## Admins

Signing in at `/admin/` is GitHub OAuth, requesting `read:user` only. The site
stores your GitHub user id, your login, and whether you are a collaborator on
the repository, so the permission check does not have to be repeated on every
request. Every change an admin makes is recorded in an append-only audit log
with their GitHub login: with edits no longer arriving as pull requests, that
log is what replaces the commit history.

## Asking for your data, or its removal

Open an issue, or use the contact route in the Discord. A submission that has
not been approved can be withdrawn on request. An approved one is a public map
record describing a published mod, and is handled like any other correction to
the registry.
