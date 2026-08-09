-- 508_entity_subtype.sql — A PARTNERSHIP AND A TRUST ARE NOT ONE THING EACH
-- (owner-directed 2026-08-09: "do research what else DocLab needs for
-- partnership and trust, let's set up that tables as well").
--
-- WHAT THE RESEARCH ACTUALLY FOUND, because it changes what this file is for.
-- DocLab's published dictionary (103 variables, docs/doclab/reference/) contains
-- NO partnership-specific and NO trust-specific field. Every entity, whatever it
-- is, goes out through the same six:
--
--     type_of_organization              acknowledgement_corporate_status
--     bylaws_operating_agreement        operating_agreement_or_bylaws
--     membership_interest_percentage  |  number_of_shares + certificate_number
--     signatory_title
--
-- and db/506 already wired all of them. So nothing new is needed to SEND a
-- partnership or a trust to DocLab.
--
-- THE REAL GAP IS ON OUR SIDE, AND IT IS A DEAD END. `llc.missingForVerification`
-- requires an EIN, a formation STATE and a formation DATE from every entity
-- before it can be marked verified — and a verified entity is what satisfies the
-- vesting-entity condition, which gates clear to close. But:
--
--   · a REVOCABLE living trust has NO EIN — it uses the grantor's own Social
--     Security number while the grantor is alive — and is not filed with any
--     state; it is created by a signed declaration;
--   · a GENERAL partnership is created by its agreement and is generally not
--     filed with any state either (it does have an EIN — it files Form 1065).
--
-- So a perfectly ordinary family trust could never be verified, the condition
-- could never clear, and the file could never reach clear to close. Nobody could
-- resolve it, because the missing documents do not exist. That is what the
-- sub-kind fixes: it is the ONE answer that says what this entity can actually
-- produce, and src/lib/entity-type.js `requirements()` reads it.
--
-- IT ALSO NAMES THE ENTITY CORRECTLY ON THE DOCUMENT. "general partnership" and
-- "limited partnership" are different legal entities with different liability,
-- and DocLab prints `type_of_organization` verbatim onto a recorded instrument.
-- A trust's sub-kind deliberately does NOT change that word — "trust" is never
-- wrong and the trust's own name carries the rest ("The Smith Family Trust,
-- dated March 3, 2019").
--
-- NOTHING ON THE BACK BOOK MOVES. The column is NULL everywhere, which reads as
-- "nobody has said", and the requirements RELAX rather than tighten on an
-- unstated sub-kind — so no entity that could be verified yesterday becomes
-- unverifiable today. Only a partnership or a trust can carry a value at all,
-- and db/506 stamped the whole back book `llc`.

ALTER TABLE llcs ADD COLUMN IF NOT EXISTS entity_subtype text;

-- The CHECK is written per TYPE on purpose: it is the one place that can refuse
-- "revocable" on a partnership or "limited" on a trust, and a value stored
-- against the wrong type would silently relax the wrong requirement. NULL is
-- always allowed — it is the honest state of every entity until somebody says.
DO $$
BEGIN
  ALTER TABLE llcs DROP CONSTRAINT IF EXISTS llcs_entity_subtype_check;
  ALTER TABLE llcs ADD CONSTRAINT llcs_entity_subtype_check
    CHECK (
      entity_subtype IS NULL
      OR (entity_type = 'partnership' AND entity_subtype IN ('general','limited','llp'))
      OR (entity_type = 'trust'       AND entity_subtype IN ('revocable','irrevocable'))
    );
END $$;

-- A partnership or a trust whose sub-kind is not yet stated is what the closing
-- desk is nudged about, and what the entity screens ask for. Tiny by definition
-- (db/506 made the whole back book an LLC), so a plain partial index is enough.
CREATE INDEX IF NOT EXISTS idx_llcs_entity_subtype ON llcs (entity_type, entity_subtype)
  WHERE entity_type IN ('partnership','trust');
