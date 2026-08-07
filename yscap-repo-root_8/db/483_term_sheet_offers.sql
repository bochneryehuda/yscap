-- A TERM SHEET AN OFFICER EMAILS TO A BORROWER, WHICH STARTS A FILE ALREADY
-- CARRYING ITS TERMS (owner-directed 2026-08-07).
--
-- The owner: "We need to enhance our term sheet generator from the staff's log-in.
-- Any term sheet generator from the staff's log-in, whenever he finishes building up
-- the term sheet, should have an option to deliver to a borrower via email, with the
-- loan officer's branding, all the terms nicely together with an attached initial term
-- sheet. He should have a button right away on the email to click 'Accept Terms and
-- Start Loan Application', which is right away taken to create his account and
-- continue the application from there. That product should already be registered with
-- the terms the loan officer put into his term sheet generator … same loan amount,
-- same program, same product, same figures, same out-of-pocket rehab, same
-- everything … Anything from the term sheet generator, which is starting a file,
-- should be born with the terms of the term sheet generator."
--
-- ── WHAT A ROW IS ───────────────────────────────────────────────────────────────
-- One offer = one term sheet an officer sent to one borrower. It holds the SCENARIO
-- (`draft` — the deal: price, values, budget, experience, payoff) and, separately,
-- the pricing ELECTION (`program` / `overrides` / `term_options` — which card was
-- chosen, the manual LTV/LTC/ARV basis, the markup and fee changes, the
-- out-of-pocket exception). Those two halves are exactly what the Investor Suite's
-- existing "Create loan file →" already carries into a new file, so the accepted
-- offer registers through the identical guarded path.
--
-- ── WHAT IT DELIBERATELY DOES *NOT* HOLD: THE LOAN AMOUNT ───────────────────────
-- The loan amount is not an input — the frozen engine computes it from the figures
-- above. Storing it could only ever let a stale number disagree with the engine on
-- the day the offer is accepted, and the owner's "same loan amount" is delivered by
-- storing the same INPUTS and re-running the same engine, not by copying its output.
-- `quote_snapshot` keeps what the officer was SHOWN, for the record and for the email
-- body, and is never an input to anything.
--
-- ── THE TOKEN IS NEVER STORED ───────────────────────────────────────────────────
-- Only `token_hash` (sha256), exactly like `invite_tokens` — a database read must
-- never yield a working link. The SAME token is also written to `invite_tokens`
-- (kind 'borrower', created_by = the officer), so creating the password runs through
-- the EXISTING, audited `/auth/accept`: no new credential path, no new account-
-- takeover surface, and the officer-branding binding comes along for free.
--
-- ── ONE OFFER CAN ONLY EVER PRODUCE ONE FILE ────────────────────────────────────
-- `application_id` is written when it is accepted, and `accepted_at` is the claim: a
-- second accept (a double click, a forwarded link, a retry) finds the row already
-- claimed and returns the SAME file instead of minting a competing one.

CREATE TABLE IF NOT EXISTS term_sheet_offers (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- sha256 of the emailed token. UNIQUE so a token names at most one offer.
  token_hash      text NOT NULL UNIQUE,
  -- The officer whose terms these are and whose branding the email carries. Kept even
  -- if they later leave (ON DELETE SET NULL) — the offer still happened.
  officer_id      uuid REFERENCES staff_users(id) ON DELETE SET NULL,
  created_by      uuid REFERENCES staff_users(id) ON DELETE SET NULL,
  -- Who it went to. The email is the identity: it is what `invite_tokens` is keyed on.
  borrower_email  text NOT NULL,
  borrower_name   text,
  borrower_phone  text,
  -- THE DEAL (scenarioToDraft) and THE PRICING ELECTION, kept apart on purpose.
  draft           jsonb NOT NULL DEFAULT '{}'::jsonb,
  program         text,
  overrides       jsonb,
  term_options    jsonb,
  is_manual       boolean NOT NULL DEFAULT false,
  -- What the officer was shown. Display / record only, never an input.
  quote_snapshot  jsonb,
  property_address jsonb,
  -- The initial term sheet PDF, held in object storage until there is a file to
  -- attach it to. Filed as a real `documents` row on acceptance.
  pdf_ref         text,
  pdf_filename    text,
  pdf_bytes       integer,
  pdf_sha256      text,
  -- Lifecycle.
  expires_at      timestamptz NOT NULL,
  sent_at         timestamptz,
  send_error      text,
  opened_at       timestamptz,
  accepted_at     timestamptz,
  application_id  uuid REFERENCES applications(id) ON DELETE SET NULL,
  borrower_id     uuid REFERENCES borrowers(id) ON DELETE SET NULL,
  -- Why the registration did not happen, when it did not. A file is created either
  -- way (a lead is worth more than an automatic registration), so this is the only
  -- record of the difference.
  register_result jsonb,
  revoked_at      timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

-- "What has this officer sent, and what is still outstanding?" — the two questions
-- the staff screen asks.
CREATE INDEX IF NOT EXISTS idx_tso_officer ON term_sheet_offers (officer_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_tso_open ON term_sheet_offers (expires_at)
  WHERE accepted_at IS NULL AND revoked_at IS NULL;
-- The borrower's own history, for "did we already send this person terms?".
CREATE INDEX IF NOT EXISTS idx_tso_email ON term_sheet_offers (lower(borrower_email), created_at DESC);
