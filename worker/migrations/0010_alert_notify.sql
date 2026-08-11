-- Alert routing: record everything, notify a human only when there is something
-- for them to do.
--
-- `notify` is the ROUTING DECISION, not the outcome. It answers "was this meant
-- for a human", which is a property of the alert; whether Discord actually
-- accepted the post is a property of that hop, is already reported by
-- `raiseAlert`'s return value, and must NOT feed back into this column. If it
-- did, a Discord outage would quietly drop real alerts out of the dashboard's
-- unacknowledged count -- the exact failure the alerts table was built to
-- survive.
--
-- Backfilled to 1 because every row that predates this column was written under
-- the old always-forward rule, so 1 is what actually happened to it.
ALTER TABLE alerts ADD COLUMN notify INTEGER NOT NULL DEFAULT 1;

-- The dashboard badge counts open alerts that were meant for a human, and the
-- Alerts tab reads the same rows. Both are `notify = 1 AND acknowledged_at IS
-- NULL`, which is now the most-run query against this table.
CREATE INDEX idx_alerts_open ON alerts (notify, acknowledged_at);
