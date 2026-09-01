-- ============================================================================
-- db/663 — the rent form is CONFIRMED before it can go out
--
-- WHAT THIS CHANGES, AND WHY. Owner-directed 2026-08-31:
--
--   *"The verification of rent form fill-out — while we fill in — needs to be
--   confirmed before you can order the VOR. Right now it sounds like it's two
--   different sections: the order, and the actual form we fill in. That needs to
--   be confirmed before."*
--
-- The two sections are real and both exist: the ORDER is the letter to the
-- landlord, and the FORM is the owner's own blank with items 1 to 9 drawn onto
-- it. Until now the second one was never a gate. db/645 says so in its own
-- words — *"a form nobody has opened is still sendable (the prefill is the whole
-- point), but the desk says which it is"* — which was the right call while the
-- prefill was the only thing on the paper, and is the wrong one now that the
-- landlord's block, the phone and the applicant's address are all drawn from
-- file data that a person is the last check on. A form that goes out wrong comes
-- back as evidence on a loan, and the landlord answered the version we sent.
--
-- A CONFIRMATION IS NOT A SAVE, WHICH IS WHY THESE ARE NEW COLUMNS AND NOT
-- `reviewed_at`. That pair is stamped by every save — including the autosave —
-- so treating it as the confirmation would mean a keystroke counted as a person
-- saying "this is right", which is exactly what the owner is asking to stop.
--
-- AND A CONFIRMATION IS ABOUT THE VERSION IT WAS GIVEN FOR. `saveForm` clears it
-- whenever the merged data actually CHANGES, so confirm-then-edit cannot send
-- content nobody confirmed; a save that changes nothing (the ordinary autosave
-- echo) leaves the confirmation standing, or the desk would un-confirm itself
-- while somebody was reading it.
--
-- NO BACKFILL, DELIBERATELY. Every existing form is unconfirmed, which is the
-- truth: nobody has confirmed one, because until this migration there was
-- nothing to press. Stamping the back book would be inventing a human decision.
--
-- PRODUCT SEPARATION. `lt_*` only.
-- ============================================================================

ALTER TABLE lt_vor_forms ADD COLUMN IF NOT EXISTS confirmed_by uuid;
ALTER TABLE lt_vor_forms ADD COLUMN IF NOT EXISTS confirmed_at timestamptz;

COMMENT ON COLUMN lt_vor_forms.confirmed_at IS
  'When a person confirmed THIS version of the form (owner-directed 2026-08-31). NULL = not confirmed, and nothing may be sent. Cleared by any save that changes the data — a confirmation is about the version it was given for. Never the same thing as reviewed_at, which every save stamps.';
COMMENT ON COLUMN lt_vor_forms.confirmed_by IS
  'Who confirmed it. Kept beside confirmed_at so the desk can name them rather than say "somebody".';
