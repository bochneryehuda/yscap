-- ============================================================================
-- 541_draw_treat_as_sold.sql — "this file was not sold yet", and the draw
-- coordinator's way past it (owner-directed 2026-08-13).
--
-- THE RULE THIS SERVES, in the owner's words: *"If Encompass has a PA date
-- already, then it should always proceed with the setting of the file — if the
-- investor releases directly, or if we release and we get reimbursed. If it's
-- not yet sold, then it should always be set up that we release the net amount
-- … every file that is not sold yet should have a badge: 'this file was not
-- sold yet' — but the draw coordinator can click Change Setting and process the
-- draw as if it was sold already. In case anything goes wrong she should have
-- this ability, which should give her a double warning when she's changing it."*
--
-- So the sold signal stops being advisory and starts deciding two things:
--   · WHO RELEASES — an unsold loan is released by US, out of our own money, so
--     the money ledger can never record an investor wiring a borrower on a loan
--     that investor does not own yet;
--   · THE INVESTOR'S FEE — an unsold loan carries none. They are not releasing
--     and not reimbursing, so they are not charging: they buy the loan later
--     with the draw already released. (db/540 added the fee itself.)
--
-- AND THE COORDINATOR CAN STILL SAY OTHERWISE. Encompass is read-only and its PA
-- date lands on its own schedule, so a loan really can be sold before PILOT can
-- see it. `treat_as_sold_at` is that override, recorded WITH WHO AND WHEN so it
-- is never anonymous, and reversible. It is deliberately NOT a second sold
-- column: `applications.purchase_advice_date` stays the only place the FACT
-- lives, and this says "a human decided to proceed as if". The desk shows which
-- of the two it is reading.
--
-- Additive and idempotent — NULL (no override) is every existing file, and every
-- existing behaviour on a SOLD file is unchanged.
-- ============================================================================

ALTER TABLE sitewire_property_links ADD COLUMN IF NOT EXISTS treat_as_sold_at   timestamptz;
ALTER TABLE sitewire_property_links ADD COLUMN IF NOT EXISTS treat_as_sold_by   uuid REFERENCES staff_users(id) ON DELETE SET NULL;
ALTER TABLE sitewire_property_links ADD COLUMN IF NOT EXISTS treat_as_sold_note text;
