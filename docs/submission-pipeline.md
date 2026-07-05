# Automated Mod Submission Pipeline

To make it as easy as possible for modders to add their locations to the map, we allow submissions via a simple GitHub Issue form.

This document explains what happens under the hood when a user submits that form.

---

## 🏗️ High-Level Flow

1. **User Submission:** Mod author fills out the "Submit a New Mod Location" Issue form.
2. **Issue Parsing (Bot):** GitHub Actions extracts the data from the issue and creates a new `.json` file in `data/locations/`.
3. **PR Creation (Bot):** The bot creates a pull request on behalf of the user containing only the new mod file.
4. **Discord Notification (Bot):** A webhook sends an "Awaiting Review" embed to the Discord server.
5. **Validation (CI):** The PR is automatically validated against `mods.schema.json` and `data/tags.json`.
6. **Maintainer Review:** A human reviews the data (using the [Reviewer Guide](reviewer-guide.md)), ensures it isn't malicious, and clicks Merge.
7. **Resolution (Bot):** The issue automatically closes, and the Discord embed updates to ✅ Approved.

---

## 🔍 Stage 1: The Issue Form

[**.github/ISSUE_TEMPLATE/mod_submission.yml**](../.github/ISSUE_TEMPLATE/mod_submission.yml)

This is a YAML-defined GitHub Issue form. It guarantees that users submit data in a strict layout with Markdown headers (e.g., `### Mod Name` or `### Category`). This structured format is critical for the bot to parse the data reliably.

## ⚙️ Stage 2: `auto-pr-submission.yml`

[**.github/workflows/auto-pr-submission.yml**](../.github/workflows/auto-pr-submission.yml)

This workflow triggers whenever the `mod-submission` label is applied to an issue. It runs a custom JavaScript script using `actions/github-script`.

**Step-by-step logic:**

1. **Regex Extraction:** The script reads the raw Markdown body of the issue and uses Regex to locate the `###` headers and extract the values for Name, Authors, Coordinates, Link, Category, Tags, and Description.
2. **Data Type Casting:** Validates that X and Y coordinates are floats (numbers). Authors are split from a comma-separated string. Tags are parsed from the checkbox list (`- [x] tagname`) in the form.
3. **Append Data:** Generates a random completely unique `UUID v4` for the mod's ID and builds a JSON object with the user's data.
4. **Create File:** Writes the data to a new file: `data/locations/<UUID>.json`. This design prevents merge conflicts when multiple submissions occur simultaneously.
5. **Create PR:** Uses a Personal Access Token (`ACTIONS_PAT`) to open a Pull Request.
6. **Comment:** The bot replies to the issue confirming it has created the PR.

## 💬 Stage 3: Discord Webhook Integration

Within the same `auto-pr-submission.yml` workflow, the bot reaches out to a Discord channel (using the `DISCORD_WEBHOOK_URL` secret) with an embedded message noting that a PR is awaiting review.

> `DISCORD_WEBHOOK_URL` is the **submissions** channel. Operational alerts (health/monitoring) go to a separate channel via `NCZ_ALERTS_DISCORD_WEBHOOK_URL` — see [architecture.md](architecture.md#discord-notifications).

**The Clever Part:**
To allow the bot to update this exact discord message later on, the webhook returns a unique `message_id`. The bot saves this ID as a hidden HTML comment at the bottom of the original GitHub Issue `<!-- discord_message_id: XXXXX -->`.

## 🛡️ Stage 4: `validate-mods.yml`

[**.github/workflows/validate-mods.yml**](../.github/workflows/validate-mods.yml)

When a PR is opened, GitHub Actions launches this workflow. It **always runs** on every PR (so the required status check is always reported), but skips the validation steps if no data files changed.

1. **Change Detection**: Diffs the PR branch against its base — if no `data/locations/`, `data/tags.json`, or `mods.schema.json` files changed, the remaining steps are skipped and the check passes immediately.
2. **Schema Validation**: Uses `ajv-cli` to compare the compiled `mods.json` (after a test build) against `mods.schema.json`.
3. **Tag Validation**: Runs `node scripts/validate_tags.js` to ensure all tags used in the PR exist in the `data/tags.json` registry.

## 🎉 Stage 5: Finalization & Merge

When a maintainer reviews the PR and hits Merge, the newly added mod goes live on the `main` branch.

Because the PR body contains the text `Closes #XXX` (referencing the original issue), merging the PR automatically closes the user's opened Issue.

This Issue closure triggers [**`notify-discord-pr-status.yml`**](../.github/workflows/notify-discord-pr-status.yml), which reads the hidden `discord_message_id`, makes a `PATCH` request to the Discord API, and switches the embed to a green checkmark indicating the mod is now live!

---

## 📝 Stage 6: The Modification / Edit Pipeline

If a user wants to update their mod's coordinates, tags, or authors (or request removal), they use the **Suggest Edit** feature.

1. **Issue Form**: They click "Suggest Edit" on the map popup, which pre-fills the [**`modify_location.yml`**](../.github/ISSUE_TEMPLATE/modify_location.yml) GitHub Issue template with the mod's UUID.
2. **Bot Processing**: The [**`modify-location-submission.yml`**](../.github/workflows/modify-location-submission.yml) workflow fires when the `mod-modification` label is applied. It parses the new values, merging them with the existing file (blank fields keep their current value).
3. **Discord Notification**: Follows the same stored-ID pattern as submissions — the initial "Awaiting Review" message ID is saved as a hidden comment on the issue so it can be edited (not reposted) on merge/close.
4. **PR Creation**: The bot modifies the existing `data/locations/<UUID>.json` file and creates a Pull Request reflecting the diff.
5. **Validation & Merge**: Functions identically to the standard submission pipeline. Once merged, the map updates.
