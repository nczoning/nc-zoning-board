# Mod Submission Reviewer Guide

Welcome! If you're here, you've been asked to help review and approve new mod locations for the map. This guide covers the essential steps to ensure the map stays accurate and secure.

## 🚀 The Review Process

Reviewers are coordinated through the **[Locations Hub Discord](https://discord.gg/sc4yEx2fNf)**.

1. **Role & Channel:** Ensure you have the **Cartographer** role. You will find all notifications in the **#nc-zoning-board-submissions** channel.
2. **Notification:** When a mod is submitted, a bot sends an "Awaiting Review" embed. You can click the **[Review PRs]** link in the embed to go straight to the PR on GitHub.
3. **PR Creation:** The bot simultaneously parses the issue and creates the PR.
4. **Validation:** Wait for the automated GitHub Actions to complete their validation checks.
5. **Merge:** After a manual check (see below), you merge the PR.

### Discord Notification Statuses

The notification in Discord will update its colour and status automatically:

- ⏳ **Awaiting review** (Yellow): Initial submission, needs a human eye.
- ✅ **Approved: pin is now live!** (Green): PR merged successfully.
- ❌ **Closed without merging** (Red): PR was closed or rejected.

---

## 🔍 What to Check

Before merging any PR, please verify these three things:

### 1. Nexus Mods Link

- Click the link provided in the PR or Issue.
- Does the mod actually exist?
- Is it a "Location" or "Doms/Housing" mod? (If it's just a weapon/clothing mod, it doesn't belong on this map).

### 2. Coordinates

- Does the mod description on Nexus mention coordinates? If so, do they match (roughly) what was submitted?
- If you're in-game, you can use `Game.Teleport(X, Y, Z)` in CET to verify the location yourself (optional but helpful).
- **Red Flag:** If the X/Y values are exactly `0.0`, the submitter likely forgot to copy them.

### 3. Tags & Category

- Does the category (`location-overhaul`, `new-location`, or `other`) make sense for the mod?
- Are the selected tags reasonable? The automated validation will reject any tags not in the [registry](../data/tags.json), but a tag being valid doesn't mean it's accurate.

---

## ✅ Merging

If everything looks good:

1. Go to the **Pull Request** tab on GitHub.
2. Ensure the "Checks" (Validation) have passed.
3. Click **Merge pull request** → **Confirm merge**.

### What happens now?

- The Original Issue will close automatically.
- The Discord notification will update to "Approved".
- The new pin will appear on the live map within minutes.

---

## 🛑 Handling Issues

- **Incomplete Data:** Comment on the Issue asking the user for the missing info. Do not merge until fixed.
- **Spam/Malicious:** Close the Issue and PR immediately without merging. Notify the lead maintainer.
- **Duplicate:** Check if a pin already exists for that mod. If so, close the new submission as a duplicate.

*Thanks for keeping Night City mapped!* 🌃
