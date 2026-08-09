-- Lets an alert be closed in both places at once: the dashboard row and the
-- Discord message that announced it.
--
-- Until now the two halves of the fan-out were write-once and unlinked. A
-- reviewer acknowledged a row in the dashboard, or approved the submission it
-- was about, and the channel still showed a cyan "!" -- so the channel reported
-- a backlog that had already been cleared, which is the same failure mode the
-- alerts table was built to avoid, just pointing the other way.
--
-- Two columns, because closing the loop needs two different facts.

-- The Discord message this alert became, so it can be EDITED in place rather
-- than answered with a second post. Discord returns it only when the webhook is
-- called with `?wait=true`; without that the POST is fire-and-forget and 204s.
--
-- NULL is the ordinary state for a log-only alert (never forwarded), for every
-- row written before this column existed, and for any alert Discord refused.
-- Nothing downstream may treat NULL as an error: the dashboard is still the
-- surface that outlives Discord, and an un-editable message costs the tick, not
-- the acknowledgement.
ALTER TABLE alerts ADD COLUMN discord_message_id TEXT;

-- What the alert is ABOUT, as `type:id` -- today only `submission:123`.
--
-- A scoped string rather than a `submission_id` foreign key: alerts already
-- span five sources and the next thing worth linking (a location, a Nexus mod)
-- would need its own nullable column each time. One column that names its own
-- namespace stays one column.
--
-- It carries the auto-acknowledgement: approving or rejecting a submission
-- resolves the alert that asked for it, which is the only way the two can be
-- kept in step without a reviewer remembering to clear both.
ALTER TABLE alerts ADD COLUMN ref TEXT;

-- Resolving by ref is the write path on every approve and reject, and it always
-- filters to the still-open rows.
CREATE INDEX idx_alerts_ref ON alerts (ref, acknowledged_at);
