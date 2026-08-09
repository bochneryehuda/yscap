-- ============================================================================
-- 492 — THE ENTITY SPINE: when the borrower held an entity, what proves it,
--       the vendor's view of that entity kept BESIDE ours, and old entities.
--
-- Owner-directed 2026-08-09: "We also need to focus very much on the structure
-- that should be connected to the LLC and on setting up the LLCs. Potentially,
-- it should be saved for each and every borrower." And, on carrying it:
-- "If we verify ownership of these two LLCs, then all the ownership of all the
-- properties is verified."
--
-- ── THE TWO CHECKS (owner's own correction, 2026-08-09) ─────────────────────
-- Ownership is NOT one question, it is two independent ones:
--   CHECK A — does the borrower CONTROL this entity?  Asked ONCE per entity.
--   CHECK B — did that entity own THIS property?      Asked once per line.
-- Ten properties across two LLCs is therefore two Check A's and ten small
-- Check B's, not ten full investigations. Check A's answer lives HERE (on
-- llc_borrowers, the borrower-to-entity link); Check B's lives on the ownership
-- pillar in db/491.
--
-- ── WHY held_from / held_to EXIST ───────────────────────────────────────────
-- Neither `llcs` nor `llc_borrowers` records WHEN the borrower held the entity.
-- Without it, a property held by an LLC the borrower joined AFTERWARDS is
-- indistinguishable from one they owned all along — so Check A would carry to a
-- deal that closed before they had anything to do with the company. Both are
-- NULL-able and NULL means "no dated limit known", which is the common case and
-- must never be read as "they did not hold it".
--
-- ── THE VENDOR'S VIEW IS KEPT BESIDE OURS, NEVER MERGED INTO IT ─────────────
-- `llc_external_links` holds what a data vendor says about an entity. It is a
-- LINK table, not columns on `llcs`, for the reason db/131 established for
-- Sitewire: merging a vendor's record into ours makes our record look
-- corroborated when all that happened is that somebody matched a name. The
-- vendor id is stored VERBATIM and is NEVER parsed or constructed.
--
-- `state = 'proposed'` until a HUMAN confirms it. A near-match is a suggestion,
-- never a binding — the same rule `sitewire_partner_links` (db/151) applies to
-- capital partners, and for the same reason: an over-match here would let one
-- company's public record vouch for a different company's property.
--
-- Idempotent: ADD COLUMN IF NOT EXISTS / CREATE TABLE IF NOT EXISTS throughout.
-- Purely additive — no data is read, rewritten or deleted by this file, and no
-- existing column changes type or nullability.
-- ============================================================================

-- ── (1) CHECK A lives on the borrower-to-entity link ────────────────────────
ALTER TABLE llc_borrowers
  ADD COLUMN IF NOT EXISTS held_from             date,
  ADD COLUMN IF NOT EXISTS held_to               date,
  ADD COLUMN IF NOT EXISTS ownership_verified    boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS ownership_verified_at timestamptz,
  ADD COLUMN IF NOT EXISTS ownership_verified_by uuid REFERENCES staff_users(id),
  ADD COLUMN IF NOT EXISTS ownership_evidence    jsonb;

COMMENT ON COLUMN llc_borrowers.ownership_verified IS
  'CHECK A — a human confirmed this borrower CONTROLS this entity. Asked once per entity and '
  'carried to every property that entity held. DEFAULT false: an existing link proves nothing '
  'until somebody looks, which is why this can be added to live rows with no backfill.';

COMMENT ON COLUMN llc_borrowers.ownership_evidence IS
  'What proved Check A: {kind:''operating_agreement''|''sos''|''signer''|''k1'', documentId, '
  'sosTitle, signerName, retrievedAt}. An operating agreement naming them managing member is the '
  'strong form; a Secretary-of-State officer listing is the fallback.';

COMMENT ON COLUMN llc_borrowers.held_from IS
  'When the borrower began holding this entity. NULL = no dated limit known, which must be read '
  'as "unknown", NEVER as "they did not hold it". Guards Check A from carrying to a property the '
  'entity owned before the borrower had anything to do with it.';

-- Check A carry: "every entity this borrower has verified control of."
CREATE INDEX IF NOT EXISTS idx_llcb_verified
  ON llc_borrowers(borrower_id)
  WHERE ownership_verified = true;

-- ── (2) THE VENDOR'S VIEW, BESIDE OURS ──────────────────────────────────────
CREATE TABLE IF NOT EXISTS llc_external_links (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  llc_id              uuid NOT NULL REFERENCES llcs(id) ON DELETE CASCADE,
  source              text NOT NULL DEFAULT 'elementix',
  -- VERBATIM. Never parsed, never constructed, never used to build another id.
  external_entity_id  text NOT NULL,
  external_name       text NOT NULL,
  -- Entities are keyed (name, state): the same name in two states is two
  -- companies, so the state is part of the identity and is NOT optional.
  external_state      text NOT NULL,
  principals          jsonb,
  -- What the matcher had to ignore to call these the same company. Recorded so a
  -- reviewer can see WHY it is only a near match, rather than a bare score.
  differs             jsonb,
  confidence          text NOT NULL CHECK (confidence IN ('exact','near','rejected')),
  -- 'proposed' until a HUMAN confirms. A match is a suggestion, never a binding.
  state               text NOT NULL DEFAULT 'proposed'
                      CHECK (state IN ('proposed','confirmed','rejected')),
  confirmed_by        uuid REFERENCES staff_users(id),
  confirmed_at        timestamptz,
  fetched_at          timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_llc_ext
  ON llc_external_links(llc_id, source, external_entity_id);
CREATE INDEX IF NOT EXISTS idx_llc_ext_proposed
  ON llc_external_links(llc_id) WHERE state = 'proposed';

COMMENT ON TABLE llc_external_links IS
  'db/492. A data vendor''s view of one of our entities, kept BESIDE ours and never merged into '
  'llcs — merging would make our record look corroborated when all that happened is a name match '
  '(the db/131 rule). Born ''proposed''; only a human moves it to ''confirmed''.';

-- ── (3) AN ENTITY THE BORROWER NO LONGER USES ───────────────────────────────
-- Owner: "we should have old LLCs potentially." A dissolved company still owned
-- the property when the deal happened, so it must stay on the profile and stay
-- able to carry Check A for that period — it simply must not be offered as the
-- vesting entity for a NEW loan.
ALTER TABLE llcs
  ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'active',
  ADD COLUMN IF NOT EXISTS first_seen_on text,
  ADD COLUMN IF NOT EXISTS internal_notes text;

-- Added as a separate guarded statement so a pre-existing row carrying an
-- unexpected value cannot fail the whole boot (the db/490 pattern).
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'llcs_status_check') THEN
    ALTER TABLE llcs
      ADD CONSTRAINT llcs_status_check CHECK (status IN ('active','former','dissolved')) NOT VALID;
  END IF;
END $$;

DO $$
DECLARE bad bigint;
BEGIN
  SELECT count(*) INTO bad FROM llcs WHERE status NOT IN ('active','former','dissolved');
  IF bad > 0 THEN
    RAISE NOTICE 'db/492: % llcs row(s) carry an unknown status; leaving llcs_status_check NOT VALID.', bad;
  ELSE
    ALTER TABLE llcs VALIDATE CONSTRAINT llcs_status_check;
  END IF;
END $$;

COMMENT ON COLUMN llcs.status IS
  'active | former | dissolved. A former/dissolved entity STAYS on the profile and can still '
  'carry Check A for the period it was held — it owned the property when the deal happened. '
  'It is simply not offered as the vesting entity for a new loan.';

COMMENT ON COLUMN llcs.first_seen_on IS
  'Where this entity entered PILOT: track_record | application | clickup | encompass | import | '
  'public_records. Provenance only — it grants nothing.';
