-- ============================================================================
-- 505_draw_release_party.sql — WHO releases a draw's money, and what the money
-- ledger records when it isn't us (owner-directed 2026-08-09).
--
-- THE PROBLEM. `draw_disbursements` only ever gets a row when a human records a
-- wire WE sent (`POST /api/sitewire/disbursements`). But the default is now that
-- the INVESTOR releases the money directly — the owner: "everything is now
-- released by the investor" — and on those draws nobody types anything, so the
-- draw leaves NO financial record at all. That is not just a missing report:
-- `src/lib/tapes/assemble.js` reads released draws (kind='draw',
-- funded_status='released') to compute a SOLD loan's current balance and current
-- rehab for the capital provider's data tape, so an investor-released draw makes
-- every tape understate what has actually been drawn.
--
-- WHAT THIS ADDS (four things, all additive — no existing column changes meaning):
--
--   1. draw_disbursements.release_party — 'us' | 'investor'. Which side actually
--      sent the money. DEFAULT 'us' so every existing insert path (the manual
--      release route, the retainage release) keeps its exact current behaviour
--      without being touched.
--
--   2. The FEE RECEIVABLE. When the investor releases, they wire us our draw fee
--      afterwards — the owner: "the money ledger should just save our fee and this
--      date related to this property, how much money we're supposed to make from
--      the investor directly". `fee_receivable_cents` / `fee_status` /
--      `fee_received_date` / the note buyer are that receivable. The row still
--      carries the FULL record (approved / fee / retainage / net / release date)
--      because the data tape reads it; the receivable sits alongside.
--
--   3. sitewire_inspection_rules.investor_funding_mode — the MISSING third level.
--      The funding mode already resolves per draw and per file; this adds "by
--      capital provider", keyed exactly like the fee and inspection columns
--      already on that table. NULL = fall through to the company default.
--
--   4. applications.purchase_advice_date — the SOLD signal. Read-only from
--      Encompass (the PA date). Present = the loan has been sold; blank = not sold
--      yet, which is what drives the "this loan isn't sold yet — do you want to
--      release it yourself?" warning. It NEVER flips the release party by itself.
--
-- Plus the company-level settings keys the admin Draw Settings screen needs.
--
-- BACKFILL. Every existing ledger row is stamped with what it actually WAS, never
-- re-classified into something new:
--   * source='trustpoint' → 'investor'. Those rows are poll-observed disbursements
--     the draw administrator (Blue Lake) sent themselves — documented in
--     docs/TRUSTPOINT-PHYSICAL-DRAW-WORKFLOW-BLUEPRINT.md D2. Their fee is
--     deliberately 'n_a': per D9 the $250 on a Blue Lake draw is not YS revenue
--     and carries no receivable.
--   * everything else → 'us'. That is what every hand-recorded release was.
-- No row's money moves. Idempotent — safe to re-run on every boot.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1 + 2. The money ledger learns who released, and what we are owed.
-- ---------------------------------------------------------------------------
ALTER TABLE draw_disbursements ADD COLUMN IF NOT EXISTS release_party        text NOT NULL DEFAULT 'us';
ALTER TABLE draw_disbursements ADD COLUMN IF NOT EXISTS fee_receivable_cents bigint NOT NULL DEFAULT 0;
ALTER TABLE draw_disbursements ADD COLUMN IF NOT EXISTS fee_status           text NOT NULL DEFAULT 'n_a';
ALTER TABLE draw_disbursements ADD COLUMN IF NOT EXISTS fee_received_date    date;
ALTER TABLE draw_disbursements ADD COLUMN IF NOT EXISTS note_buyer_label     text;
ALTER TABLE draw_disbursements ADD COLUMN IF NOT EXISTS note_buyer_key       text;

-- The CHECKs are added separately + conditionally (the db/300 pattern): ADD
-- CONSTRAINT has no IF NOT EXISTS, so a bare ALTER would throw on the second boot.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'chk_dd_release_party' AND conrelid = 'draw_disbursements'::regclass) THEN
    ALTER TABLE draw_disbursements ADD CONSTRAINT chk_dd_release_party
      CHECK (release_party IN ('us','investor'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'chk_dd_fee_status' AND conrelid = 'draw_disbursements'::regclass) THEN
    ALTER TABLE draw_disbursements ADD CONSTRAINT chk_dd_fee_status
      CHECK (fee_status IN ('n_a','owed','received'));
  END IF;
END $$;

-- The fees-owed desk reads this: every draw whose fee the investor still owes us,
-- oldest first. Partial, so it never constrains the ordinary ledger.
CREATE INDEX IF NOT EXISTS idx_disb_fee_owed
  ON draw_disbursements (created_at)
  WHERE fee_status = 'owed';

-- BACKFILL — stamp each existing row with what it already was. Guarded on the
-- default so a boot after the first one rewrites nothing (and a human's later
-- correction is never clobbered): only rows still carrying the untouched default
-- 'us' are considered, and only the TrustPoint-sourced ones move.
UPDATE draw_disbursements
   SET release_party = 'investor'
 WHERE release_party = 'us'
   AND COALESCE(source, 'pilot') = 'trustpoint';

-- ---------------------------------------------------------------------------
-- 3. Who releases the draws, BY CAPITAL PROVIDER — the missing third level.
--
-- NULL means "no answer at this level", which falls through to the company
-- default. It deliberately has NO default value: a rule row that has never been
-- given an answer must not silently start deciding where money goes.
-- ---------------------------------------------------------------------------
ALTER TABLE sitewire_inspection_rules ADD COLUMN IF NOT EXISTS investor_funding_mode text;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'chk_swrule_funding_mode' AND conrelid = 'sitewire_inspection_rules'::regclass) THEN
    ALTER TABLE sitewire_inspection_rules ADD CONSTRAINT chk_swrule_funding_mode
      CHECK (investor_funding_mode IS NULL
             OR investor_funding_mode IN ('reimbursement','investor_direct','manual'));
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- 4. The SOLD signal — the Purchase Advice date, read-only from Encompass.
--
-- Present = the loan has been sold to the investor. Blank = not sold yet, which
-- is what the "it isn't sold yet — release it yourself?" warning keys on. It is a
-- plain reference field: it gates nothing, prices nothing, and never flips the
-- release party on its own.
-- ---------------------------------------------------------------------------
ALTER TABLE applications ADD COLUMN IF NOT EXISTS purchase_advice_date date;

-- ---------------------------------------------------------------------------
-- 5. Company-level draw settings (the top of the three-level ladder).
--
-- Every one is INERT at its seeded value: the three advisory limits are 0 = off,
-- and the SLA days only drive display + a self-gated reminder, never a refusal.
-- ON CONFLICT DO NOTHING so an admin's later edit always wins over the seed.
-- ---------------------------------------------------------------------------
INSERT INTO sitewire_settings (key, value) VALUES
  ('investor_funding_mode_default', '"investor_direct"'::jsonb),  -- the company default: the investor releases
  ('inspection_sla_days',           '5'::jsonb),   -- ordered → report expected
  ('decision_sla_days',             '2'::jsonb),   -- report in → findings delivered
  ('investor_funding_sla_days',     '3'::jsonb),   -- sent to the investor → funded
  ('fee_owed_chase_days',           '14'::jsonb),  -- fee owed this long → chase the investor
  ('min_draw_cents',                '0'::jsonb),   -- 0 = no minimum
  ('min_days_between_draws',        '0'::jsonb),   -- 0 = no spacing rule
  ('max_draws',                     '0'::jsonb)    -- 0 = no cap
ON CONFLICT (key) DO NOTHING;
