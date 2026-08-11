# Dev Environment

Documentation for the staging environment used during the Three.js 3D map migration.

---

## Overview

The project has two deployment environments:

| Environment | Branch | URL | Purpose |
|-------------|--------|-----|---------|
| Production | `main` | [nczoning.net](https://nczoning.net) | Live site, always fully functional |
| Staging | `dev` | [dev.nczoning.net](https://dev.nczoning.net) | In-progress Three.js work, may be incomplete |

Both environments deploy via Cloudflare Pages Git integration: production on
every push to `main`, staging on every push to `dev` (separate Pages projects on
the same repo).

**Both read the same location data.** dev.nczoning.net loads from the production
Data API (`api.nczoning.net`), exactly like the live site — so what differs
between the two is *code*, never the mods on the map. There has never been a
deliberate dev dataset: `dev` only ever differed from `main` by being behind on
merged locations, and pointing the dev site at the staging API just served that
drift as though it were data. The staging API (`api-dev.nczoning.net`) still
exists for testing API changes, has no cron, and is opt-in per page load with
`?api=dev` (see [`url-parameters.md`](url-parameters.md)).

---

## Branch Strategy

```
main ──────────────────────────────────────────────────► (live site)
  └── dev ──────────────────────────────────────────────► (staging)
        ├── feat/three-js-phase-1 ──► PR → dev
        ├── feat/three-js-phase-2 ──► PR → dev
        └── ...
              (all phases complete)
                    └── dev ──► PR → main
```

- **Phase feature branches** (e.g. `feat/three-js-phase-1`) branch off `dev` and PR back into `dev`
- `main` is only touched when a complete, fully-tested feature is ready to ship
- `dev` may be broken or incomplete at any point; that's expected

---

## Cloudflare Pages Setup

The staging deployment is hosted on Cloudflare Pages under the project `nc-zoning-board-dev`.

| Setting | Value |
|---------|-------|
| Platform | Cloudflare Pages |
| Project name | `nc-zoning-board-dev` |
| Connected repository | `nczoning/nc-zoning-board` |
| Production branch | `dev` |
| Build command | *(empty)*: the site is static, nothing is compiled at deploy |
| Build output directory | `/` |
| Custom domain | `dev.nczoning.net` |

No GitHub Actions secrets or API tokens are required. Cloudflare's native Git integration authenticates directly with GitHub and triggers builds automatically on every push to `dev`.

### What happens on push to `dev`

1. Cloudflare detects the push via GitHub webhook
2. Clones the repository at the pushed commit
3. Runs `npm clean-install` (installs dependencies from `package.json`)
4. Uploads the files as they are in the repo to Cloudflare's global network
5. Site is live at `dev.nczoning.net` within ~60 seconds of pushing

### Cloudflare Pages dashboard

**Build > Compute > Workers & Pages → nc-zoning-board-dev**

This is where you can:
- View build logs for each deployment
- Manually trigger a deployment
- Manage the custom domain
- Roll back to a previous deployment if needed

---

## Development Workflow

### Starting a new phase

```bash
git checkout dev
git pull
git checkout -b feat/three-js-phase-N
```

### Finishing a phase

1. Push the feature branch to GitHub
2. Open a PR targeting `dev` (not `main`)
3. Verify the preview looks correct locally with `npx serve .`
4. Merge the PR into `dev`
5. Cloudflare automatically deploys: verify at `dev.nczoning.net`

### Keeping dev in sync with main

When bugfixes or data updates land on `main`, merge them into `dev` to stay current:

```bash
git checkout dev
git merge main
git push
```

Do this periodically, especially after any data backfill PRs merge to `main`.

### Shipping to production

Once all phases of the Three.js migration are complete and verified on `dev.nczoning.net`:

1. Open a PR from `dev` → `main`
2. Merge: GitHub Actions deploys to `nczoning.net` automatically

---

## Local Development

```bash
npx serve .
```

That is all you need. **The map reads `/v1/locations` from the production API**
from every origin, localhost included, so locations are always live and there is
nothing to rebuild. Use `?api=dev` to point at staging when testing an API
change.

There is nothing to build. `mods.json`, `build_mods.js` and `data/locations/`
went at Phase 6, and the Pages build command is empty. A deploy uploads the
repo as it stands.

---

## Relationship to the Three.js Migration

The `dev` branch exists specifically to support the Three.js 3D map migration. Each phase ships as a PR into `dev`. The full feature will not touch `main` until all phases are complete and verified.

Current phase-by-phase work is tracked in the [GitHub Project](https://github.com/orgs/nczoning/projects/1): see the **3D Scene** stream. For the current implementation reference see [`three-js-scene.md`](three-js-scene.md).
