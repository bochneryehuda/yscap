-- ============================================================================
-- db/647 — the long-term cash-out letter moves to prior-to-clear-to-close, the
--          vesting entity gains its optional certificate of good standing, and
--          the two conditions that are a CHOICE stop describing themselves as
--          an upload.
--
-- WHAT THIS CHANGES, AND WHY. Four corrections the owner made on 2026-08-30
-- after reading the shipped condition list:
--
--   1. "Cash-out letter … This one is not prior to submittal. This one is prior
--      to clear to close." The letter says what the borrower will DO with the
--      money, which is a question for the investor reading the file before it
--      closes. Holding a file out of underwriting for it delayed every cash-out
--      refinance for a document that changes nothing about whether the loan can
--      be underwritten.
--
--   2. "You're missing the optional certificate of good standing." The
--      short-term entity has had that slot for a long time, with a 30-day expiry
--      rule; the long-term copy of the condition did not.
--
--   3+4. The mortgages condition and the subject-property mortgage are each a
--      CHOICE — a statement, OR a few figures typed in, OR a selection that
--      needs neither. Both were carrying a config that RESTATED the ways, which
--      is a second copy of a rule; `src/longterm/conditions-center/answers.js`
--      is now the one definition, read by the sign-off gate and by the door that
--      records an answer, and the config points at it instead of repeating it.
--
-- WHY THE SEED CANNOT DO THIS. `library.js` seeds with `ON CONFLICT (code) DO
-- NOTHING`, so a template already in the database is never updated by it — by
-- design, so a buyer's own edits are never overwritten. A library change
-- therefore reaches a live database only through a migration, and
-- `lt_file_conditions` copies the template's wording, slots and config AT
-- CREATION, so both tables have to move or a file opened yesterday keeps the old
-- shape for ever.
--
-- WHAT IS DELIBERATELY NOT TOUCHED. A cash-out letter somebody has already
-- WORKED — satisfied, waived, or carrying a document — keeps its bucket. The
-- bucket is where a condition is asked for, and moving a finished one would make
-- a closed file's history read as though the work happened at a different step.
-- Only an untouched, still-outstanding row moves.
--
-- IDEMPOTENT. Every statement is guarded on the value it is changing
-- (`IS DISTINCT FROM`), so the second boot is a no-op rather than a rewrite of
-- rows nobody changed.
-- ============================================================================

-- ── 1. The template: the cash-out letter belongs to prior-to-clear-to-close ──
UPDATE lt_condition_templates
   SET bucket_key = 'prior_to_ctc'
 WHERE code = 'lt_cash_out_letter'
   AND bucket_key IS DISTINCT FROM 'prior_to_ctc';

-- ── 2. The files that already carry it, where nobody has worked it yet ──────
UPDATE lt_file_conditions
   SET bucket_key = 'prior_to_ctc'
 WHERE code = 'lt_cash_out_letter'
   AND bucket_key IS DISTINCT FROM 'prior_to_ctc'
   AND status = 'outstanding'
   AND satisfied_at IS NULL
   AND waived_at IS NULL
   AND NOT EXISTS (
     SELECT 1 FROM lt_condition_files f
      WHERE f.condition_id = lt_file_conditions.id AND f.is_current
   );

-- ── 3. The vesting entity gains the optional certificate of good standing ────
-- Appended, never replacing the slot list: a slot somebody added in settings
-- must survive this. OPTIONAL (`required: false`) is the whole point — a
-- certificate of good standing expires, so requiring one would make every entity
-- go stale on a date nobody is watching.
DO $$
DECLARE
  gs jsonb := '{"key":"good_standing","label":"Certificate of good standing (optional)","required":false}'::jsonb;
BEGIN
  UPDATE lt_condition_templates
     SET slots = slots || jsonb_build_array(gs)
   WHERE code = 'lt_vesting_entity'
     AND NOT (slots @> jsonb_build_array(jsonb_build_object('key', 'good_standing')));

  UPDATE lt_file_conditions
     SET slots = slots || jsonb_build_array(gs)
   WHERE code = 'lt_vesting_entity'
     AND NOT (slots @> jsonb_build_array(jsonb_build_object('key', 'good_standing')));
END $$;

-- ── 4. The entity reads the borrower's profile ──────────────────────────────
UPDATE lt_condition_templates
   SET config = config || '{"readsFromBorrowerProfile":true,"prefillFromEntity":true}'::jsonb
 WHERE code = 'lt_vesting_entity'
   AND config->>'prefillFromEntity' IS DISTINCT FROM 'true';

UPDATE lt_file_conditions
   SET config = config || '{"readsFromBorrowerProfile":true,"prefillFromEntity":true}'::jsonb
 WHERE code = 'lt_vesting_entity'
   AND config->>'prefillFromEntity' IS DISTINCT FROM 'true';

-- ── 5. The two CHOICE conditions point at the one definition ────────────────
-- `answeredBy: 'answers'` is what tells a screen to draw the ways rather than a
-- single upload box. The restated lists (`answers`, `typedFields`,
-- `typedRequiresAll`, `waiver`) are REMOVED, because a second copy of a rule
-- drifts from the one that decides — and the one that decides is the gate.
UPDATE lt_condition_templates
   SET config = (config - 'answers' - 'typedFields' - 'typedRequiresAll' - 'waiver')
                || '{"answeredBy":"answers"}'::jsonb
 WHERE code IN ('lt_reo_liabilities', 'lt_subject_mortgage_statement')
   AND config->>'answeredBy' IS DISTINCT FROM 'answers';

UPDATE lt_file_conditions
   SET config = (config - 'answers' - 'typedFields' - 'typedRequiresAll' - 'waiver')
                || '{"answeredBy":"answers"}'::jsonb
 WHERE code IN ('lt_reo_liabilities', 'lt_subject_mortgage_statement')
   AND config->>'answeredBy' IS DISTINCT FROM 'answers';

-- The mortgages condition was filed as a 'form', which read on the condition
-- list as "fill this in" when it is really a statement OR a selection OR an
-- address, one per mortgage. 'document' is the honest fallback: `answers.js`
-- intercepts the gate while it governs the condition, and if that ever stops
-- being true the gate asks for the statement — chasing a document that was not
-- needed, rather than signing the condition off on nothing.
UPDATE lt_condition_templates
   SET kind = 'document'
 WHERE code = 'lt_reo_liabilities' AND kind IS DISTINCT FROM 'document';

UPDATE lt_file_conditions
   SET kind = 'document'
 WHERE code = 'lt_reo_liabilities' AND kind IS DISTINCT FROM 'document';
