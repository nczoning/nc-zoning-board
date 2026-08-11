# Infrastructure map

**What each moving part is, and which one to look at when something breaks.**

This page is orientation, not reference. It answers "which of these six things is
the problem?" [`architecture.md`](architecture.md) covers how the code works,
[`dev-environment.md`](dev-environment.md) covers the dev branch and Pages setup,
and [`api-reference.md`](api-reference.md) covers the API surface.

## The six pieces

| Piece | What it is | Serves | Deployed by |
| --- | --- | --- | --- |
| **Pages: `nc-zoning-board`** | the website, built from `main` | nczoning.net | Cloudflare's own Git integration |
| **Pages: `nc-zoning-board-dev`** | the same website, built from `dev` | dev.nczoning.net | Cloudflare's own Git integration |
| **Worker: `nczoning-api`** | the Data API, from `main` | api.nczoning.net | `deploy-api.yml` |
| **Worker: `nczoning-api-staging`** | the Data API, from `dev` | api-dev.nczoning.net | `deploy-api.yml` |
| **D1: `nczoning-data`** | the location registry, the source of truth | read by the Worker | migrations, run by hand |
| **KV: dataset store** | the built dataset the site actually reads | read by the Worker | the Worker's 5-minute cron |

Plus one branch that is not a website: **`data-snapshots`**, the nightly backup of
D1. It shares no history with `main` or `dev`, is never merged, and holds only
data files and a README.

### Two things that catch people out

**The site and the API deploy independently, by different mechanisms.** Pages is
wired straight to GitHub by Cloudflare and runs no GitHub Action. The Worker is
deployed by an Action. So "I merged, is it live?" has two answers, and they can be
minutes apart. Poll until the thing you care about is actually true rather than
checking once.

**D1 is the truth; KV is a copy.** Losing KV costs nothing, because the cron
rebuilds it within five minutes. Losing D1 loses the registry. That asymmetry is
the whole reason `data-snapshots` exists.

## When X is broken, look at Y

| Symptom | Look at |
| --- | --- |
| Map is empty, or pins are missing | the Worker and KV, not Pages. Check `/v1/health` first: `status`, and `refresh_age_seconds` under ~45 min |
| Site looks stale but pins are fine | Pages. Did the build run? Cloudflare dashboard → the project → Deployments |
| dev.nczoning.net differs from nczoning.net | usually just `dev` being behind `main`. Both read the **production** API by design |
| A submission vanished | D1 `submissions`, via the admin dashboard queue. It is not in git and never was |
| An alert fired but Discord is silent | the alert is still recorded. Dashboard → Alerts tab. Discord forwarding fails independently and on purpose |
| A scheduled job stopped running | see "the workflow registry" below |
| The nightly backup failed | an `export` alert in the dashboard, and a red run on `export-d1-snapshot.yml` |

## The workflow registry, which is the confusing one

**GitHub builds its list of workflows from the default branch (`main`) only.** A
`.yml` file on a feature branch is just a text file as far as GitHub is concerned.

Three consequences, all of which have bitten:

1. A **new** workflow cannot be run, scheduled, or manually dispatched until the
   file reaches `main`. `gh workflow run` returns `404: not found on the default
   branch`, which reads like the wrong branch was named but actually means "no
   such workflow exists".
2. Once it *is* on `main`, `--ref <branch>` works and runs that branch's copy of
   the file. So testing from a branch is possible, just not before the first merge.
3. **Deleting** a workflow on a branch does not stop it. `main`'s copy keeps
   firing until the deletion merges, while every PR-level check reports green. To
   stop one immediately use `gh workflow disable`, which acts on the registry.
   The wiki records this as `learnings/retiring-a-scheduled-workflow-needs-the-registry-not-a-pr`.

## Where credentials live

Three separate stores. Setting one does not set another.

| Store | Holds | Set with |
| --- | --- | --- |
| GitHub Actions secrets | what workflows use: `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_D1_READ_TOKEN`, `ALERTS_INGEST_SECRET` | repo Settings → Secrets and variables → Actions |
| Cloudflare Worker secrets | what the Worker uses: `SESSION_SECRET`, the GitHub App key, `NCZ_ALERTS_DISCORD_WEBHOOK_URL`, `ALERTS_INGEST_SECRET` | `npx wrangler secret put`, from inside `worker/` |
| Cloudflare API tokens | the tokens themselves | Manage Account → API Tokens |

`ALERTS_INGEST_SECRET` appears in two rows deliberately: it is a shared secret,
compared between the two sides, so both copies must match.

Cloudflare API tokens are **account-owned**, under *Manage Account*, not under a
person's *My Profile*. A user-owned token is invisible to every other admin and
dies with that user's access. A token's value can never be read back after
creation, so test it while the value is still on screen. The reasoning is in the
wiki as `decisions/account-owned-cloudflare-api-tokens`.

## Branches

| Branch | What it is |
| --- | --- |
| `main` | production. Protected: PR + green `validate-json` + merge commits only. Nobody pushes to it directly |
| `dev` | integration. Feature branches squash-merge here |
| `feat/*` | one per change, PR'd into `dev` |
| `data-snapshots` | the D1 backup. Orphan, never merged, machine-written |

`main` and `dev` should have **byte-identical trees**; `main` being some commits
ahead is normal, because merge commits live only there by construction. If the
*trees* differ, something drifted.

## Running things locally

```powershell
npx serve .                    # the site (file:// breaks fetch())
cd worker; npm test            # the API's tests
npm test                       # the site's tests, from the repo root
```

Every `wrangler` command runs from inside `worker/` through `npx`, from
**PowerShell**, with the account id exported:

```powershell
cd worker
$env:CLOUDFLARE_ACCOUNT_ID='b9937d8d595fad7de8d1549b22390281'
npx wrangler d1 execute nczoning-data --remote --command "SELECT COUNT(*) FROM locations"
```

Two traps worth knowing: `--json` on `wrangler d1 execute --remote` returns 7403
(drop it, the output is JSON anyway), and staging needs `--env staging`.
