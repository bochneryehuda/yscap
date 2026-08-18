-- ============================================================================
-- db/574 — asset ledger and max cash to close
--
-- WHAT THIS CHANGES, AND WHY (owner-directed 2026-08-18). The team could see
-- the VERIFIED liquidity the bank statements prove and the REQUIRED liquidity
-- the registration demands, but nobody could (a) correct what the reader got
-- wrong ("overwrite exactly how much money is in each and every account
-- verified") or (b) read the one number the desk actually asks before a
-- closing: the MAXIMUM cash to close this borrower can support — total
-- verified assets minus the reserve requirement (and the 1% closing-cost
-- buffer when it is not waived). This table is the staff-editable layer that
-- sits ON TOP of the read-only bank-statement assessment: an `override` row
-- corrects one system-read account (amount and/or whether it counts), a
-- `manual` row adds an account the reader never saw. The assessment itself
-- (src/lib/underwriting/bank-liquidity.js) is never modified — the merge
-- happens at read time in src/lib/underwriting/asset-ledger.js, so removing a
-- row always returns the account to exactly what the documents say.
--
-- BACKFILL: none needed — with no rows, every file reads byte-for-byte as it
-- did before (the merge is the identity function on an empty ledger).
--
-- RTL only. No lt_* table is touched.
-- ============================================================================

CREATE TABLE IF NOT EXISTS asset_ledger_entries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  application_id uuid NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
  -- 'override' corrects a system-read account (identified by account_key);
  -- 'manual' is an account a staffer added by hand.
  kind text NOT NULL,
  -- The stable identity of the system-read account an override corrects —
  -- built by asset-ledger.accountKeyOf() from (bank, masked number, holder).
  account_key text,
  institution text,
  account_number text,          -- display only — masked/last-4, never a full number
  holder text,
  amount numeric(14,2),         -- the verified amount; NULL on an override means
                                -- "keep the read balance, only the include flag moved"
  include boolean,              -- NULL on an override means "keep the system verdict"
  note text,
  created_by uuid REFERENCES staff_users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE asset_ledger_entries DROP CONSTRAINT IF EXISTS asset_ledger_entries_kind_chk;
ALTER TABLE asset_ledger_entries ADD CONSTRAINT asset_ledger_entries_kind_chk
  CHECK (kind IN ('override','manual'));

-- An override must name the account it corrects; amounts can never be negative.
ALTER TABLE asset_ledger_entries DROP CONSTRAINT IF EXISTS asset_ledger_entries_override_key_chk;
ALTER TABLE asset_ledger_entries ADD CONSTRAINT asset_ledger_entries_override_key_chk
  CHECK (kind <> 'override' OR account_key IS NOT NULL);
ALTER TABLE asset_ledger_entries DROP CONSTRAINT IF EXISTS asset_ledger_entries_amount_chk;
ALTER TABLE asset_ledger_entries ADD CONSTRAINT asset_ledger_entries_amount_chk
  CHECK (amount IS NULL OR amount >= 0);

-- One override per (file, account) — a second correction of the same account
-- replaces the first through the upsert, never a duplicate row.
CREATE UNIQUE INDEX IF NOT EXISTS uq_asset_ledger_override
  ON asset_ledger_entries(application_id, account_key) WHERE kind = 'override';
CREATE INDEX IF NOT EXISTS idx_asset_ledger_app ON asset_ledger_entries(application_id);

-- ── after this lands ────────────────────────────────────────────────────────
-- The schema map (docs/schema/) describes the database these migrations build,
-- so this file makes it stale. CI refreshes it on this pull request by itself.
