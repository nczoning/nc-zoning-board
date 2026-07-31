# Mod Submission Reviewer Guide

If you're here, you've been asked to help review new mod locations for the map.
Reviewing happens in the **admin dashboard** at
[nczoning.net/admin/](https://nczoning.net/admin/), signed in with GitHub.

Access is your **collaborator status on the repository**. There is no separate
list to be added to: if you can push to `nczoning/nc-zoning-board`, you can
review.

---

## 🚀 The Review Process

1. Open the dashboard and go to the **Queue** tab. The tab carries a count when
   anything is pending.
2. Each submission renders a **field-level diff** of what it would change, and a
   mini-map of the proposed pin.
3. Check the three things below.
4. **Approve**, **reject with a reason**, or **hold**.

Approving writes the location and rebuilds the map's data, so an approved pin
appears within seconds. Rejecting keeps the record of the decision.

> **Nothing is sent to the submitter.** A review note is an internal record only,
> and the queue says so where you type it. Submissions are anonymous by design;
> there is no address to reply to.

### Three kinds of submission

- **Create**: a new pin. If the mod already has one, the queue lists the
  existing records it would sit beside and how far away they are. That is
  context, not a warning: one mod can legitimately supply several locations.
- **Edit**: a correction sent from a pin's popup. Only the changed fields are
  sent, so the diff is the whole story.
- **Remove**: a takedown request with a reason. Approving sets the record to
  `hidden`, which pulls the pin and keeps the history. It does not delete it.

---

## 🔍 What to Check

### 1. The Nexus link

- Does the mod actually exist?
- Is it a location or housing mod? A weapon or clothing mod does not belong on
  this map.

### 2. Coordinates

- The mini-map is the fastest check: is the pin somewhere plausible?
- Does the mod's Nexus description mention coordinates? Do they roughly match?
- In-game you can verify with `Game.Teleport(X, Y, Z)` in CET.
- **Red flag:** X/Y of exactly `0.0` usually means the submitter forgot to copy
  them.

### 3. Tags and category

- Does the category (`location-overhaul`, `new-location`, `other`) fit the mod?
- Are the tags reasonable? A tag outside the registry is refused on write, but a
  valid tag is not necessarily an accurate one.

---

## 🛑 Handling Problems

- **Incomplete data:** reject with a reason saying what was missing, or approve
  and fix it yourself in the editor. There is no submitter to ask.
- **Spam or malicious:** reject. If it is a tagged Nexus mod you never want
  offered again, dismiss it in the **Candidates** tab, which is reversible.
- **Duplicate:** the queue already shows nearby records for the same mod. If it
  is a genuine duplicate rather than a second location, reject it.

## ✋ When a save is refused

If someone else changed a location while you had it open, your save is refused
and **nothing is written**. The current version loads so you can see what moved,
then reapply your change and save again.

That is deliberate. Three of us share one registry, and without it the second
save silently replaces the first: no error, and the person who saved first only
finds out when their change is gone.

### One case it does not cover: approving a stale submission

A submission is written against the record as the **submitter** saw it, and
approving applies it however long it has been sitting in the queue.

So if you fixed something on a record while a submission for it was pending,
approving that submission puts the submitter's older values back over your fix.
This needs no second person: you editing a record and then approving a
submission for it is enough.

**Read the diff before you approve.** It shows exactly what the submission would
write, which is the check that catches this.

## 📋 The audit log

Every change records who made it and the record before and after. It replaced
`git log` for data changes, so it answers "who changed this pin, and when".

---

> **Retired at 2.0.0:** reviewing used to mean merging a bot-authored pull
> request, with a Discord bot editing its own message in place to show the
> outcome. Discord was acting as the queue's UI. The dashboard holds that state
> now, and the submission issue forms and their workflows are gone.

*Thanks for keeping Night City mapped!* 🌃
