-- 387 — a NEGATIVE cash-out is not an answer; clear the ones already stored
-- (audit round 4, 2026-07-31).
--
-- `estimated_cash_out` (db/267) gained its first writers this week, and for one
-- round both of them accepted a negative: the details door only checked
-- `isFinite`, and the register door only checked that the value was a number.
-- Nobody receives a negative cheque — a shortfall is cash the borrower BRINGS,
-- which cash-to-close already reports — so a stored negative is meaningless, and
-- the payoff model treats ANY typed value as the figure of record, which means a
-- stored negative would print on a term sheet.
--
-- It is also a DEAD END for the file it sits on, which is what makes this a
-- migration rather than a note. The Term Sheet Studio prefills its cash-out box
-- from the file and sends it on every register; the register door now refuses a
-- negative; and on anything but a cash-out refinance that box is HIDDEN, so
-- there is no screen an officer can use to clear it. Such a file could not be
-- re-registered at all, refused over a field it could not see.
--
-- Idempotent (a second run matches no rows) and narrow: only genuinely negative
-- values are touched. NULL is the right destination, not 0 — it means "no figure
-- of record", which is exactly true, and it restores the structure's own derived
-- figure on every surface.

UPDATE applications
   SET estimated_cash_out = NULL, updated_at = now()
 WHERE estimated_cash_out IS NOT NULL
   AND estimated_cash_out < 0;
