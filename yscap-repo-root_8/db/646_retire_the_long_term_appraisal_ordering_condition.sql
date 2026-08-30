-- ============================================================================
-- db/646 — retire the long-term appraisal-ordering condition
--
-- WHAT THIS CHANGES, AND WHY. The owner, mid-build: *"Skip the appraisal ordering.
-- We're not going to do the appraisal ordering. We're removing the appraisal order
-- NAN from the task list."* So `lt_order_appraisal` comes out of the condition
-- library and the `appraisal` order kind comes off the desk. This is the half the
-- code change cannot do on its own: `library.seed` is `ON CONFLICT (code) DO
-- NOTHING`, so removing the entry stops a NEW database ever getting the row and
-- leaves an existing one holding it — and because that template is `auto_apply =
-- 'always'`, it is already sitting on every long-term loan in the book.
--
-- RETIRED, NOT DELETED, and the distinction is load-bearing:
--   · `lt_file_conditions.template_id` points at this row on every file that has it.
--     A DELETE would either cascade those conditions away or be refused outright,
--     depending on the constraint — and neither is what "we are not doing this" means.
--   · The condition engine RETRACTS what it created and nobody has touched, on the
--     next evaluation of each file, so an untouched row leaves on its own, quietly,
--     file by file. A row somebody HAS worked stays where it is with its history
--     intact, which is the only honest outcome for work a person actually did.
--   · `is_active = false` is exactly the state the library screen already calls "not
--     in the library", so nothing new has to learn what this means.
--
-- The disabled reason is rewritten because the old one PROMISED the wrong thing —
-- "turning it on is a settings change, not a new release" — and a person reading a
-- retired row should not be told to go and switch it on.
--
-- IDEMPOTENT: one guarded UPDATE, a no-op from the second boot.
-- SEPARATION: lt_* only.
-- ============================================================================

UPDATE lt_condition_templates
   SET is_active = false,
       is_enabled = false,
       disabled_reason = 'Appraisal ordering was taken out of the long-term build (owner-directed 2026-08-30). '
                      || 'It is not switched off waiting to be switched on — it is retired.',
       updated_at = now()
 WHERE code = 'lt_order_appraisal'
   AND (is_active IS DISTINCT FROM false OR is_enabled IS DISTINCT FROM false);

-- ---------------------------------------------------------------------------
-- The order VOCABULARY follows the registry.
--
-- `scripts/test-lt-orders-pure.js` asserts db/644's `kind` CHECK and the registry in
-- `src/longterm/orders/kinds.js` name exactly the same set, and it is right to: a
-- vocabulary that offers a value the product no longer has is the silent drift that
-- test exists to catch. So `appraisal` comes out of the CHECK too.
--
-- UNDER db/644'S OWN CONSTRAINT NAME, never a new one. Every file in db/ replays on
-- every boot in filename order, so db/644 re-adds the WIDE list first and this
-- narrows it again immediately after — which converges. Re-adding under a NEW name
-- would leave db/644's name free, so its own statement would succeed and the two
-- constraints would both stand, the wider one making this one pointless (db/529).
--
-- GUARDED ON THE DATA. A CHECK that no existing row can satisfy fails the ALTER and
-- takes the rest of this file with it — silently, because migrate-boot logs and
-- continues. There can be no such row (the kind shipped switched off on a table
-- created in db/644), but that is a claim about today rather than a property, so it
-- is CHECKED: an appraisal order somewhere means somebody placed one, and that is a
-- person's decision to unwind, not a migration's. The suite then fails loudly on
-- that database, which is the correct outcome.
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM lt_file_orders WHERE kind = 'appraisal') THEN
    ALTER TABLE lt_file_orders DROP CONSTRAINT IF EXISTS lt_file_orders_kind_chk;
    ALTER TABLE lt_file_orders ADD CONSTRAINT lt_file_orders_kind_chk
      CHECK (kind IN ('title', 'insurance', 'flood_insurance', 'ny_settlement_agent',
                      'payoff', 'condo_questionnaire', 'vor'));
  ELSE
    RAISE NOTICE 'db/646: lt_file_orders still holds appraisal order(s) — leaving the CHECK alone for a human to unwind.';
  END IF;
END $$;

-- `lt_loan_vendors.kind` is DELIBERATELY LEFT ALONE. It is a CONTACT TYPE, not an
-- order: an appraisal management company can perfectly well be a contact on a
-- long-term file even though PILOT no longer places the order. The registry's
-- VENDOR_KINDS still carries it, so the two still agree.
