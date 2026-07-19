-- 153 — Trackable admin self-test envelopes.
--
-- The "Send myself a test" tool sends real DocuSign envelopes to the admin's own
-- email to confirm our generated documents render + sign. Previously those were
-- fire-and-forget (no tracking row), so they never appeared in the E-Signatures
-- cockpit and couldn't be watched move sent → signed → completed.
--
-- This lets a test envelope be a first-class TRACKED row that reconciles through
-- the same webhook/poller as a real send, WITHOUT a real loan file behind it:
--   * application_id becomes nullable (a test has no loan file),
--   * is_test flags the row (app-less by construction),
--   * test_label is the display name on the cockpit card (no real loan number),
--   * purpose='test' is added to the whitelist.
-- A CHECK enforces the invariant is_test ⇔ application_id IS NULL, so a REAL
-- envelope can never accidentally become app-less and a test can never attach to a
-- real file. Existing rows (app set, is_test=false default) satisfy it unchanged.
ALTER TABLE esign_envelopes ALTER COLUMN application_id DROP NOT NULL;
ALTER TABLE esign_envelopes ADD COLUMN IF NOT EXISTS is_test    boolean NOT NULL DEFAULT false;
ALTER TABLE esign_envelopes ADD COLUMN IF NOT EXISTS test_label text;

-- Widen the purpose whitelist to include 'test' (keep the real packages exactly).
ALTER TABLE esign_envelopes DROP CONSTRAINT IF EXISTS chk_esign_purpose;
ALTER TABLE esign_envelopes ADD CONSTRAINT chk_esign_purpose CHECK (
  purpose IS NULL OR purpose IN ('term_sheet_package', 'heter_iska', 'test'));

-- Integrity invariant: a test row is app-less; a real row has a loan file.
ALTER TABLE esign_envelopes DROP CONSTRAINT IF EXISTS chk_esign_test_appless;
ALTER TABLE esign_envelopes ADD CONSTRAINT chk_esign_test_appless CHECK (
  (is_test AND application_id IS NULL) OR (NOT is_test AND application_id IS NOT NULL));
