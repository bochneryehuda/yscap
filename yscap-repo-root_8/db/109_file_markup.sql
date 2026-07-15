-- #101 — File-level markup override STICKS to the file.
--
-- Root cause: a per-file markup override lived only in the transient `overrides`
-- passed at quote/register time. It was captured inside the registration's inputs
-- jsonb but was never re-applied to future quotes, and the borrower's self-service
-- pricing never read it — so once a file was structured at a higher markup, a
-- borrower re-pricing fell back to the (lower) company default and could reprice
-- BELOW the markup the loan officer set. The fix persists the markup on the file
-- itself so `buildInputs` re-applies it to EVERY subsequent quote (staff live,
-- borrower live, borrower register). A live STAFF override still supersedes it;
-- the borrower path never sends a markup, so the sticky value fully governs it.
--
-- Values are stored as PERCENT (e.g. 2.5 for 2.5%), matching the `markupStdPct` /
-- `markupGoldPct` override contract (pricing.js divides by 100). NULL = no per-file
-- override → the file follows the live company default → engine, exactly as before.
ALTER TABLE applications
  ADD COLUMN IF NOT EXISTS file_markup_std_pct  numeric,
  ADD COLUMN IF NOT EXISTS file_markup_gold_pct numeric;

-- Previous AND future (owner-directed): a file already registered with a per-file
-- markup override carries that markup in its CURRENT registration's inputs jsonb.
-- Lift it onto the file so the sticky re-apply governs any future (re)pricing on
-- old files too. Only when a markup key was actually present — a plain
-- company-default registration has no such key, so the file stays NULL and keeps
-- following the live company default. Idempotent (COALESCE keeps any set value).
UPDATE applications a SET
  file_markup_std_pct  = COALESCE(a.file_markup_std_pct,  NULLIF(r.inputs->>'markupStdPct','')::numeric),
  file_markup_gold_pct = COALESCE(a.file_markup_gold_pct, NULLIF(r.inputs->>'markupGoldPct','')::numeric)
FROM product_registrations r
WHERE r.application_id = a.id
  AND r.is_current = true
  AND (r.inputs ? 'markupStdPct' OR r.inputs ? 'markupGoldPct')
  AND (a.file_markup_std_pct IS NULL OR a.file_markup_gold_pct IS NULL);
