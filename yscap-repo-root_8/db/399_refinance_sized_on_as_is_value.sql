-- 399 — A REFINANCE IS SIZED ON THE AS-IS VALUE, AND CARRIES NO PURCHASE PRICE
--       (owner-directed 2026-08-02).
--
-- The owner, after a cash-out refinance turned up carrying purchase-style
-- economics: "Once a file is refinance then instead of asking for the purchase
-- price just ask him right away for the as is value because that's what it
-- counts for, it doesn't count for the purchase price … as is value is the one
-- that sets how much initial he can get instead of looking on the purchase
-- price."
--
-- The FROZEN engines always agreed — `standard-program.js` sizes the acquisition
-- advance off `acqDenom = purchase ? min(pp, aiv) : aiv` and the cost basis off
-- `(purchase ? pp : aiv) + rehab`. What was wrong sat above them: the forms asked
-- a refinancing borrower for a purchase price, the row stored one, and
-- `src/lib/pricing.js` quietly passed that price to the engine AS the as-is value
-- whenever the as-is box was blank. The code now refuses to do that. This file
-- brings the rows already on disk to the same place — previous AND future.
--
-- THREE STATEMENTS, IN THIS ORDER, AND THE ORDER IS LOAD-BEARING.
--
--   §B  A refinance with NO as-is value but a purchase price gets the purchase
--       price written into `as_is_value`. This changes NO loan and no number:
--       it is byte-for-byte the value `buildInputs` was ALREADY handing the
--       engine for those files (`num(app.as_is_value) || totalPrice`, and on a
--       refinance `totalPrice` is just `purchase_price` — an assignment is a
--       purchase concept and can never reach here). All it does is make the
--       figure VISIBLE in the box a human can correct, instead of leaving it an
--       invisible fallback. Without it, removing the fallback would leave those
--       files unable to price at all — a dead end, which is not an acceptable
--       way to treat the back book.
--
--   §C  Every refinance's `purchase_price` is then cleared. It is a leftover —
--       from a file that began life as a purchase, or from a studio hand-off —
--       and it is what the owner actually saw on screen. It is NOT moved into
--       `original_purchase_price`: nobody can know whether that number is what
--       the borrower paid years ago, a mis-entered value, or a stale draft, and
--       writing a guess into a field the team will read as fact (it feeds
--       seasoning) is worse than leaving it blank. The refinance screens now ASK
--       for the original purchase price and the date acquired, which is exactly
--       what the owner asked for. Nothing is lost either way: §A records the
--       prior value on the file's own audit trail before it goes.
--
--   §A  runs FIRST and writes that audit row, so the Activity feed can answer
--       "where did the purchase price on my refinance go?" and the value is
--       recoverable by hand if a file genuinely needs it.
--
-- NO CONDITION IS REOPENED AND NOTHING RE-PRICES. Nine triggers on
-- `applications` watch these columns (db/072, 074, 096, 126, 145, 190, 255, 280,
-- 292 …) and would flag every touched registration stale, un-sign live term
-- sheets and reopen cleared conditions across the whole back book — for a change
-- that moves no number the engine ever read. So user triggers are disabled for
-- the duration. The whole file is executed as ONE implicit transaction by
-- `migrate-boot.js` (`db.query(sql)` on a multi-statement string), so the
-- re-enable cannot be skipped: any failure rolls the DISABLE back with it, and
-- other sessions block on the lock rather than seeing a trigger-less table.
--
-- IDEMPOTENT: after this runs no refinance has a purchase price, so §A/§B/§C all
-- match zero rows on every later boot.
--
-- "Refinance" is spelled here exactly as `pricing.js loanTypeOf` and
-- `lib/deal-basis.sizesOnAsIsValue` spell it — the substring "refi", case
-- insensitive. Every value the system stores ('Refinance — Cash-Out', ClickUp's
-- 'Refi Rate & Term', the legacy bare 'Refinance') matches, and "Delayed Purchase
-- Financing" correctly does not: it carries purchase leverage.

ALTER TABLE applications DISABLE TRIGGER USER;

-- §A — record what is about to be cleared, on the file's own trail.
INSERT INTO audit_log (actor_kind, actor_id, action, entity_type, entity_id, detail)
SELECT 'system', NULL, 'refi_purchase_price_cleared', 'application', a.id,
       jsonb_build_object(
         'loan_type',            a.loan_type,
         'purchase_price',       a.purchase_price,
         'as_is_value_before',   a.as_is_value,
         'adopted_as_as_is',     (a.as_is_value IS NULL),
         'why', 'A refinance is sized on the as-is value; a purchase price is not part of one. '
             || 'If this figure was what the borrower originally paid, re-enter it as the '
             || 'original purchase price on the file.')
  FROM applications a
 WHERE a.loan_type ILIKE '%refi%'
   AND a.purchase_price IS NOT NULL;

-- §B — make the implicit as-is value explicit. Same number the engine already
-- used for these files, so not one loan changes size.
UPDATE applications
   SET as_is_value = purchase_price
 WHERE loan_type ILIKE '%refi%'
   AND as_is_value IS NULL
   AND purchase_price IS NOT NULL
   AND purchase_price > 0;

-- §C — a refinance carries no purchase price.
UPDATE applications
   SET purchase_price = NULL
 WHERE loan_type ILIKE '%refi%'
   AND purchase_price IS NOT NULL;

ALTER TABLE applications ENABLE TRIGGER USER;

COMMENT ON COLUMN applications.original_purchase_price IS
  'What the borrower paid when they ACQUIRED the property (refinance only) — never the price of this transaction, which a refinance does not have. With acquisition_date it is what ownership seasoning is counted from (lib/deal-basis.seasoningMonths).';
COMMENT ON COLUMN applications.acquisition_date IS
  'When the borrower acquired the property (refinance only). Drives ownership seasoning.';
