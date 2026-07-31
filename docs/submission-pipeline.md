# Mod Submission Pipeline

How a location gets onto the map. Submissions arrive from the map itself, land in
a review queue, and reach the map only when an admin approves them.

> **This replaced a GitHub Actions pipeline at the D1 cutover (2026-07-31).** An
> issue form used to become a bot-authored PR adding a `data/locations/*.json`
> file, and merging it published the pin. The registry no longer lives in git, so
> that path could no longer reach the map, and the templates and workflows were
> deleted rather than left as a road to nowhere. Nothing errored while they were
> still there, which is exactly the problem: the form accepted, the PR opened, CI
> passed, the merge went green, and no pin appeared.

---

## 🏗️ High-Level Flow

```text
map (+ Submit, or a pin's "Suggest a fix")
   │  Turnstile + rate limit
   ▼
POST /submissions ──► D1 `submissions` (status: pending)
   │
   ▼
admin dashboard, Queue tab ──► approve / reject / hold
   │  approve
   ▼
D1 `locations` ──► write-through materialize ──► KV ──► /v1/locations ──► the map
```

---

## 🔍 Stage 1: The Submitter

Everything happens on [nczoning.net](https://nczoning.net). No GitHub account and
no Git knowledge.

- **New location:** the **[+] Submit** button. The first step picks the mod,
  either from the tagged list or by pasting a Nexus link. Tagging a mod
  **NCZoning** on Nexus is what puts it in that picker, prefilled with its name,
  description and uploader. The tag does not publish anything on its own.
- **Fixing an existing pin:** **Suggest a fix** in the pin's own popup, prefilled
  from the record. It sends only the fields that changed, so a reviewer sees "yaw
  changed" rather than a restatement of the whole record. One choice inside the
  same form switches to requesting removal, which asks for a reason instead.

Coordinates are checked as you type, against the limits the server enforces.

---

## ⚙️ Stage 2: `POST /submissions`

`worker/src/submissions.js`. Anonymous, and guarded by:

- **Turnstile.** A missing or failed token is refused. It also refuses automated
  browsers, which is why this round trip cannot be driven by tooling.
- **A rate limit** of 5 per address per hour.
- **A salted one-way hash of the submitter's address**, never the address itself,
  cleared automatically after 90 days. See [privacy.md](privacy.md).

Three kinds: `create`, `edit` and `remove`. Nothing at this stage touches
`locations`.

---

## 💬 Stage 3: Review

The dashboard's **Queue** tab, gated on repository collaborator status.

Each submission renders a field-level diff of what it would change and a mini-map
of the proposed pin. A new pin for a mod already on the map lists the records it
would sit beside and how far away they are, since one mod can legitimately supply
several locations.

Actions are approve, reject with a reason, or hold. **A review note is an
internal record; nothing is sent to the submitter**, and the queue says so.

---

## 🎉 Stage 4: Publication

Approving writes the location to D1 and materializes write-through, so the pin
appears within seconds rather than waiting for the next cron tick.

Every mutation writes an `audit_log` row recording who did it and the record
before and after. That log is what replaced `git log` for data changes.

An approved removal keeps the record and sets `status = 'hidden'`, which pulls
the pin while preserving the history. Deleting a record outright is a separate,
deliberate action.

---

## 🛡️ What still runs in CI

`validate-mods.yml` validates `mods.json` against `mods.schema.json` on any PR
touching `data/`. `mods.json` is still built and **nothing reads it**; it exists
so the cutover stays revertible. Both retire at Phase 6.
