-- 020_notification_prefs.sql — per-borrower notification preferences so a
-- borrower can quiet the updates that make them anxious. Critical categories
-- (document rejections, conditions, security) stay in-app regardless. Idempotent.
CREATE TABLE IF NOT EXISTS notification_prefs (
  borrower_id uuid NOT NULL REFERENCES borrowers(id) ON DELETE CASCADE,
  category    text NOT NULL,
  in_app      boolean NOT NULL DEFAULT true,
  email       boolean NOT NULL DEFAULT true,
  PRIMARY KEY (borrower_id, category)
);
