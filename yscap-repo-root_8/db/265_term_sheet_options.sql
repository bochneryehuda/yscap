-- Term-sheet options (owner-directed 2026-07-22).
--
-- DISPLAY / record-only attributes that sit ON TOP of the frozen pricing engines
-- — none of them change any sized number, rate, cap, fee, cash-to-close or
-- liquidity. They are persisted so the term sheet PDF / borrower email populate
-- them, the super-admin escalation can state the min-interest choice, and they're
-- available for future export.
--
--   • accrual_type          — 'non_dutch' (default, As-Drawn) | 'dutch' (Full-Boat)
--   • min_interest_enabled  — NULL = program default (manual ON, Standard/Gold OFF);
--                             an explicit true/false is an admin choice
--   • deferred_orig_pct     — % paid at EXIT (payoff); 0 = none. Never in cash-to-close.
--   • est_closing_date      — the estimated closing date the borrower/officer entered
--   • first_payment_date    — DERIVED: 1st of the 2nd month after closing
--   • maturity_date         — DERIVED: first payment + (term - 1) months
--
-- Additive + idempotent. Every existing file gets the safe defaults on the next
-- boot: accrual defaults to Non-Dutch, min-interest to NULL (= program default),
-- deferred fee to 0. Dates stay NULL until a closing date is entered.

ALTER TABLE applications ADD COLUMN IF NOT EXISTS accrual_type        text    DEFAULT 'non_dutch';
ALTER TABLE applications ADD COLUMN IF NOT EXISTS min_interest_enabled boolean;
ALTER TABLE applications ADD COLUMN IF NOT EXISTS deferred_orig_pct   numeric(6,3) DEFAULT 0;
ALTER TABLE applications ADD COLUMN IF NOT EXISTS est_closing_date    date;
ALTER TABLE applications ADD COLUMN IF NOT EXISTS first_payment_date  date;
ALTER TABLE applications ADD COLUMN IF NOT EXISTS maturity_date       date;

-- Backfill the non-null defaults on any pre-existing row where they came in NULL
-- (columns added to a populated table are NULL, not the DEFAULT).
UPDATE applications SET accrual_type = 'non_dutch' WHERE accrual_type IS NULL;
UPDATE applications SET deferred_orig_pct = 0 WHERE deferred_orig_pct IS NULL;

-- Per-registration snapshot of the term-sheet options that were in effect when
-- the product was registered, so the history panel + a re-open show exactly what
-- was chosen (min-interest on/off, accrual, deferred fee, the key dates).
ALTER TABLE product_registrations ADD COLUMN IF NOT EXISTS term_options jsonb;
