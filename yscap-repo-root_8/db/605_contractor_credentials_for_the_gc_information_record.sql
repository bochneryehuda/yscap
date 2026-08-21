-- ============================================================================
-- db/605 — a general contractor's CREDENTIALS, beside their contact record
--
-- WHAT THIS CHANGES, AND WHY. Owner-reported 2026-08-21: "The GC information
-- condition now only has an upload document slot. Keep that slot as an optional
-- slot … You need to add that condition to be informational, to put in: the name
-- / the phone number / the email address / license information … And then, in
-- the TPR export and in the SharePoint sync, you need to take this information
-- and lay it out on a PDF GC contractor information nicely."
--
-- The IDENTITY half already exists and is not duplicated here: `service_contacts`
-- has carried a `contractor` type — company, contact name, email, phone, address,
-- notes — since it shipped, and `application_service_contacts` links one to a
-- file. Adding a second place a contractor's name and phone can live is exactly
-- how two records of one company drift, so the GC record READS that one.
--
-- What has nowhere to live is the part that is specific to a CONTRACTOR: the
-- licence, the two insurance policies a lender verifies before releasing a draw,
-- and the tax id on their W-9. Those would be meaningless columns on a title
-- company or a realtor, so they get their own row keyed 1:1 on the contact —
-- keyed on the CONTACT and not on the file, because a licence belongs to the
-- company and the same builder works several of our loans.
--
-- EVERY FIELD IS OPTIONAL, deliberately and by owner direction ("Don't make all
-- the fields required. Maybe business name is optional"). Some trades and some
-- states do not license at all, and a builder often produces the insurance
-- certificate later than the phone number. A blank field simply does not print.
--
-- IDEMPOTENT — one CREATE TABLE IF NOT EXISTS and one index.
--
-- BACKFILL: NONE. There is nothing to migrate — no contractor credential has
-- ever been recorded anywhere in this system, so every row starts absent and
-- reads as absent.
--
-- PRODUCT SEPARATION: RTL only. `service_contacts` is an RTL table; the
-- Long-Term side has no contractor record and is untouched.
-- ============================================================================

CREATE TABLE IF NOT EXISTS contractor_credentials (
  service_contact_id   uuid PRIMARY KEY REFERENCES service_contacts(id) ON DELETE CASCADE,

  -- The licence. A contractor licence is issued by a STATE (and in some trades
  -- by a county), so the number alone does not identify it — the state is what
  -- makes it checkable against a public register.
  license_number       text,
  license_state        text,
  license_expires_on   date,

  -- General liability. What a lender confirms before a draw is released, and
  -- what an investor's file review asks for by name.
  gl_carrier           text,
  gl_policy_number     text,
  gl_expires_on        date,

  -- Workers' compensation. Separate from general liability on purpose: they are
  -- two different policies, from two different carriers more often than not, and
  -- a file that has one and not the other is a real state a reviewer must see.
  wc_carrier           text,
  wc_policy_number     text,
  wc_expires_on        date,

  -- The tax id from their W-9. A BUSINESS identifier that already appears on
  -- every W-9 in the file and on the investor package — never a personal Social,
  -- which has its own encrypted home and must never be typed here.
  ein                  text,

  website              text,
  notes                text,

  updated_by           uuid REFERENCES staff_users(id) ON DELETE SET NULL,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now()
);

-- "Whose licence is about to lapse?" is the question this table exists to be
-- able to answer, and it is asked across the book rather than per contact.
CREATE INDEX IF NOT EXISTS idx_contractor_credentials_expiry
  ON contractor_credentials (license_expires_on)
  WHERE license_expires_on IS NOT NULL;
