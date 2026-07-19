-- 147_sitewire_rule_partner_label.sql
-- Idempotent. Inspection/fee rules are now keyed by the NOTE-BUYER LABEL (applications.lender),
-- not only by the Sitewire directory id. This lets a rule exist for a capital partner that isn't
-- in the Sitewire directory, and lets a rule be marked "handled externally" — meaning that partner
-- runs its draws in its OWN system and PILOT must never push those files to Sitewire.
-- The Sitewire capital_partner_id stays as the PUSH TARGET, resolved from the label when it matches
-- the directory. (owner-directed 2026-07-19)

ALTER TABLE sitewire_inspection_rules ADD COLUMN IF NOT EXISTS partner_label      text;
ALTER TABLE sitewire_inspection_rules ADD COLUMN IF NOT EXISTS handled_externally boolean NOT NULL DEFAULT false;

-- Backfill the label from the Sitewire directory name for existing rules keyed by capital_partner_id,
-- so they keep matching (resolveRule matches by normalized label first, then falls back to the id).
UPDATE sitewire_inspection_rules r
   SET partner_label = cp.name
  FROM sitewire_capital_partners cp
 WHERE r.capital_partner_id = cp.sitewire_id
   AND (r.partner_label IS NULL OR btrim(r.partner_label) = '');

-- A rule that carries a capital_partner_id we can't name from the directory still needs a DISTINCT
-- label so it doesn't collapse onto the global default under the new key.
UPDATE sitewire_inspection_rules
   SET partner_label = '#' || capital_partner_id
 WHERE capital_partner_id IS NOT NULL
   AND (partner_label IS NULL OR btrim(partner_label) = '');

-- Re-key: a rule is identified by its normalized note-buyer label + program (a NULL label = the global
-- default). Keying by label lets multiple external partners (all with a NULL capital_partner_id) coexist —
-- the old key on COALESCE(capital_partner_id,-1) collapsed every id-less rule onto -1, so only one could
-- exist.
--
-- We REUSE the index NAME `uq_swrule` for the new label-based definition. db/131 runs BEFORE this file on
-- every boot and does `CREATE UNIQUE INDEX IF NOT EXISTS uq_swrule (…capital_partner_id…)`; because an
-- index named uq_swrule already exists (the label-based one this migration leaves behind), 131 simply
-- SKIPS — no duplicate-key error, no rolled-back migration, no per-boot churn. The DO block converts the
-- OLD cp-based index to the label-based one ONCE (only while it still references capital_partner_id).
DROP INDEX IF EXISTS uq_swrule_label;  -- transitional cleanup: an earlier draft of this migration used this name
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_indexes WHERE indexname = 'uq_swrule' AND indexdef LIKE '%capital_partner_id%') THEN
    DROP INDEX uq_swrule;
  END IF;
END $$;
CREATE UNIQUE INDEX IF NOT EXISTS uq_swrule
  ON sitewire_inspection_rules (regexp_replace(lower(COALESCE(partner_label, '')), '[^a-z0-9]+', '', 'g'), COALESCE(program, ''));
