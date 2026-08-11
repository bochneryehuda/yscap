-- 535 — MERGE THE DUPLICATE NOTE-BUYER SPELLINGS (owner-directed 2026-08-11).
--
-- The owner: "EMCAP Financial and EMCAP are the same note buyer — combine them, and
-- the one we keep should be linked everywhere; the one available in ClickUp is
-- canonical." A note buyer with a short spelling ("EMCAP", "Fidelis", "Blue Lake",
-- "RCN") and a long production/ClickUp label ("EMCAP Financial", "Fidelis Investors
-- LLC", "Blue Lake Capital", "RCN Capital") normalizes to two DIFFERENT keys under the
-- exact normNoteBuyer, so the same buyer showed up as two picker options and read as
-- two buyers to the ClickUp bounce-back guard.
--
-- The code side is fixed (field-registry.canonicalNoteBuyer collapses every spelling to
-- ONE identity + the production label, used by the picker, the Silver→EMCAP auto-link
-- and the bounce-back guard). This is the PREVIOUS-AND-FUTURE half: every existing file
-- whose note buyer is a non-canonical spelling of one of the four known buyers is
-- rewritten to that buyer's canonical label, so the whole book reads "the one we keep."
--
-- SPELLING-ONLY, NEVER a buyer change. The prefix match mirrors field-registry's
-- isEmcapNoteBuyer / isFidelisNoteBuyer / isBlueLakeNoteBuyer / isRcnNoteBuyer (the same
-- `LIKE '<prefix>%'` form db/337 uses), so a row is only ever moved WITHIN one buyer —
-- "Fidelis" -> "Fidelis Investors LLC", never "Fidelis" -> anything else. The four
-- prefixes are disjoint, so a lender matches at most one. CorrFirst and any unknown
-- note buyer carry no differently-normalizing long form, so they match no prefix and are
-- left untouched.
--
-- IDEMPOTENT: after the first run every EMCAP/Fidelis/Blue Lake/RCN file already holds
-- its canonical label, so `a.lender <> c.label` matches nothing and the whole statement
-- is a no-op (including the audit insert, which selects from the empty `updated` set).
--
-- SAFE against the one trigger that watches `lender` (reopen_ssn_on_change, db/291/398):
-- it reopens an auto-cleared CorrFirst SSN condition on a lender change, but that
-- condition exists ONLY on a CorrFirst file, and this migration never touches a CorrFirst
-- file (its lender matches no prefix here) — so the trigger's UPDATE matches zero rows.
--
-- `lender` is NOT a pricing input (db/071/072 do not watch it), so no product-pricing
-- reopen fires; and the inbound bounce-back guard now compares the note buyer by
-- canonical identity, so the next ClickUp pull reads the rewritten label as the same
-- buyer ClickUp holds and never bounces it back.

WITH canon(prefix, label) AS (
  VALUES ('emcap%',    'EMCAP Financial'),
         ('fidelis%',  'Fidelis Investors LLC'),
         ('bluelake%', 'Blue Lake Capital'),
         ('rcn%',      'RCN Capital')
),
target AS (
  SELECT a.id, a.lender AS old_lender, c.label AS new_lender
    FROM applications a
    JOIN canon c
      ON regexp_replace(lower(a.lender), '[^a-z0-9]', '', 'g') LIKE c.prefix
   WHERE a.lender IS NOT NULL
     AND a.lender <> c.label
),
updated AS (
  -- Deliberately NOT bumping updated_at: this is a spelling normalization, not a
  -- meaningful file edit, so it must not reset "days since last touched" for the
  -- stale-file digests across the whole book. The audit_log row below is the record.
  UPDATE applications a
     SET lender = t.new_lender
    FROM target t
   WHERE a.id = t.id
  RETURNING a.id, t.old_lender, t.new_lender
)
INSERT INTO audit_log (actor_kind, actor_id, action, entity_type, entity_id, detail)
SELECT 'system', NULL, 'note_buyer_canonicalized', 'application', id,
       jsonb_build_object('from', old_lender, 'to', new_lender)
  FROM updated;
