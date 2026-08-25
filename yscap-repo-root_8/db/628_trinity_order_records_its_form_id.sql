-- db/628 — a Trinity order records WHICH FORM it was placed on
--
-- WHY THIS COMES BEFORE THE DEFAULT MOVES (owner-directed 2026-08-24: "Form 19 is only for the
-- test environment. We need to change it for the production environment ... by default, the
-- system, by physical inspection, should order the real form, not the 19 form").
--
-- Every read-back path asked `client.formId()` — the ONE configured default — for the form
-- segment of its URL:
--
--     GET /api/v1.1/forms/{form}/orders/{id}/budget
--     GET /api/v1.1/forms/{form}/grouped/orders/{id}/budget
--
-- so an order placed on form 19 is only readable at /forms/19/... . Move the default to 1079 with
-- no per-order record and every order already in flight becomes unreadable at the moment of the
-- deploy — the inspector's approved figures never come back, and nothing anywhere says why. The
-- same hazard is what makes "order a different form" unsafe: two forms in play and one global id
-- to read them both with. So the form becomes a property of THE ORDER.
--
-- THERE IS DELIBERATELY NO COLUMN DEFAULT, and that is the whole correctness of this file. A
-- default of 19 would stamp every BRAND-NEW record 19 at INSERT — on a production account that
-- does not carry form 19 at all — and the placement would then dutifully use it. NULL is the
-- honest value for a record nobody has placed yet: it means "no form chosen", and the placement
-- resolves the configured default at the moment it actually orders, recording what it used.
--
-- THE BACKFILL IS SCOPED TO ROWS THAT WERE ACTUALLY PLACED, and for those 19 is a FACT rather
-- than a guess: 19 was the hard-coded default from db/552 until today, so every Trinity order
-- this integration has ever placed is readable only at /forms/19/. A record with no
-- `trinity_order_id` has ordered nothing, so it has no form to record.
--
-- Idempotent; safe to replay on every boot.

ALTER TABLE trinity_inspection_orders
  ADD COLUMN IF NOT EXISTS trinity_form_id integer;

-- An earlier cut of this file set a column default of 19. Drop it unconditionally: a default is
-- exactly the thing that would stamp a new production record with the sandbox's form.
ALTER TABLE trinity_inspection_orders
  ALTER COLUMN trinity_form_id DROP DEFAULT;

-- Every order ALREADY PLACED went out on form 19 — the only form this integration had.
UPDATE trinity_inspection_orders
   SET trinity_form_id = 19
 WHERE trinity_form_id IS NULL
   AND trinity_order_id IS NOT NULL;

COMMENT ON COLUMN trinity_inspection_orders.trinity_form_id IS
  'The Trinity form this order was PLACED on (NULL = not placed yet, so no form chosen). '
  'Read-backs (budget, grouped budget) MUST use this, never the configured default — an order '
  'placed on 19 is only readable at /forms/19/. Backfilled to 19 for orders placed before db/628: '
  'the only form the integration ordered until then. No column default, on purpose.';
