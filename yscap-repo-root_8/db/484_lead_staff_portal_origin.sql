-- A LEAD BORN FROM A STAFF LOGIN BELONGS TO THAT STAFF MEMBER — never the queue
-- (owner-reported 2026-08-07; owner-directed: "if somebody is doing something from
-- his login, it should always stay with his information, his name. It should come in
-- as a lead in his system").
--
-- WHAT HAPPENED. A staff member opened the Term Sheet Studio from their own portal
-- (Investor Suite → Term Sheet Studio), generated a term sheet and delivered it to a
-- lead by email. The lead arrived in PILOT carrying a DIFFERENT officer's name.
--
-- WHY. The studio is the same static tool the marketing site serves, and it reads the
-- officer it is working for from `window.YSBRAND`, which `web/v2/brand.js` fills from
-- the `?lo=` link parameter. The portal mounted it as `/tools/term-sheet.html?embed=1`
-- with no officer at all, so YSBRAND was null, the lead POST carried no
-- `officerCode`, and `POST /api/leads` did what it is designed to do for an UNOWNED
-- marketing lead — handed it to the next loan officer in the round-robin rotation
-- (db/468). Nothing errored; the lead simply belonged to someone else.
--
-- `assigned_via` is the column that records HOW a lead got its officer, and it had no
-- value for "the person was signed in and it is theirs". That missing value is why
-- the round-robin could not tell the two situations apart. Adding it:
--
--   lo_link      — a branded ?lo= marketing link
--   round_robin  — nobody was named, so the rotation gave it an owner
--   manual       — a human assigned it later
--   staff_portal — it was created from a signed-in staff member's own portal (NEW)
--
-- The rule the application now enforces on top of this value: a `staff_portal` lead
-- is NEVER round-robined. If its officer somehow cannot be resolved it falls through
-- to the sales desk — which a human works — rather than being handed to an officer
-- who had nothing to do with it. Silently reassigning a STATED owner is the exact
-- failure this fixes, and it is worse than an unassigned lead.
--
-- Additive + idempotent. GO-FORWARD ONLY: existing rows keep whatever `assigned_via`
-- they carry. There is deliberately no back-fill — we cannot know after the fact
-- which past `round_robin` leads were really born in someone's portal, and guessing
-- would rewrite the ownership record on live leads in someone's book.

ALTER TABLE leads DROP CONSTRAINT IF EXISTS chk_leads_assigned_via;
ALTER TABLE leads ADD CONSTRAINT chk_leads_assigned_via
  CHECK (assigned_via IS NULL OR assigned_via IN ('lo_link', 'round_robin', 'manual', 'staff_portal'));
