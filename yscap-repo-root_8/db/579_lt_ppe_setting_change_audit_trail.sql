-- ============================================================================
-- db/579 — LT PPE setting change AUDIT TRAIL.
--
-- WHAT THIS CHANGES, AND WHY. Every knob that moves a price lived in
-- `lt_ppe_setting_value` (db/558) with nothing but `updated_by` / `updated_at`
-- on the row — a LAST-writer stamp, not a history. It answered "who touched
-- this most recently"; it could not answer "what was this number before, who
-- changed it, and when", and a CLEAR (the row is DELETEd so the setting falls
-- back to the coded default) erased even that. Measured before this file
-- landed: nothing in `src/` called `store.setSetting` or `store.clearSetting`
-- at all and the router published no write route, so the only way these numbers
-- had ever moved was a hand-written UPDATE against the database, which leaves
-- no record anywhere. Opening a write door without a trail would have made that
-- worse, not better: the numbers here are the parity tolerances, the rounding,
-- the price floor and the per-investor margin/holdback. A number that moves a
-- price must never change without a record.
--
-- APPEND-ONLY, AND ONE ROW PER CHANGE. There is no updated_at and nothing here
-- is ever UPDATEd or DELETEd; a mistaken change is answered by another recorded
-- change, never by rewriting the record of the first one. The store performs
-- INSERT only. Same posture as db/566 (the cutover decision ledger), for the
-- same reason: a trail that can be edited is not a trail.
--
-- FROM-WHAT AND TO-WHAT ARE TWO FACTS EACH, and both halves are recorded,
-- because "the value" and "where the value came from" are different facts and
-- confusing them is how a settings screen lies. `from_value` / `to_value` hold
-- the value; `from_source` / `to_source` hold whether that value was a HUMAN's
-- stored override ('stored') or the shipped coded default ('product_default').
-- A clear is `action='clear'`, `to_source='product_default'`, and `to_value` =
-- the default the setting fell back TO — recorded, not derived, because the
-- coded default can itself change in a later release and the record must still
-- say what the number actually became on the day.
--
-- SCOPE IS THE SLOT, VERBATIM: 'company' for the global slot, 'investor:<code>'
-- for a per-investor override (the same scope string `lt_ppe_setting_value`
-- uses, produced by `store.investorScope` and never hand-built by a caller).
-- Keeping the literal scope means a row here can always be lined up against the
-- row it changed.
--
-- actor_id is the staff UUID (nullable: a change made by a script or a
-- migration genuinely has no person behind it, and a fake id would be worse
-- than an honest NULL); actor_label is the human-readable name or email
-- captured AT THE TIME, so the trail still reads years later after a person is
-- renamed or removed.
--
-- BACKFILL: NONE, and deliberately. There is no history to backfill — the
-- changes that predate this table left no record anywhere to recover, and
-- inventing rows for them would put fiction in an audit trail.
--
-- IDEMPOTENT: CREATE TABLE / CREATE INDEX IF NOT EXISTS only; replays clean on
-- every boot.
--
-- PRODUCT SEPARATION: lt_ppe_* only. No RTL table is read or written, no
-- trigger or function is defined.
--
-- SOURCE OF TRUTH FOR THE SHAPE: src/longterm/prisma/schema.prisma
-- (LtPpeSettingAudit) + docs/schema/beyond-prisma.json.
-- ============================================================================

CREATE TABLE IF NOT EXISTS lt_ppe_setting_audit (
    id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    scope        TEXT NOT NULL,                  -- 'company' | 'investor:<code>' — the slot, verbatim
    key          TEXT NOT NULL,                  -- a declared key from src/longterm/ppe/settings.js
    action       TEXT NOT NULL,                  -- set | clear
    from_value   JSONB,                          -- the value in force before (NULL is a real JSON null too — read from_source)
    from_source  TEXT NOT NULL,                  -- stored | product_default
    to_value     JSONB,                          -- the value in force after
    to_source    TEXT NOT NULL,                  -- stored | product_default
    actor_id     UUID,                           -- the staff member, when there was one
    actor_label  TEXT,                           -- their name/email as it read at the time
    changed_at   timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT lt_ppe_setting_audit_action_chk CHECK (action IN ('set','clear')),
    CONSTRAINT lt_ppe_setting_audit_from_source_chk CHECK (from_source IN ('stored','product_default')),
    CONSTRAINT lt_ppe_setting_audit_to_source_chk   CHECK (to_source   IN ('stored','product_default'))
);

-- The two reads this table serves: the whole trail newest-first, and one
-- setting's history.
CREATE INDEX IF NOT EXISTS lt_ppe_setting_audit_scope_time_idx
    ON lt_ppe_setting_audit (scope, changed_at DESC);
CREATE INDEX IF NOT EXISTS lt_ppe_setting_audit_key_time_idx
    ON lt_ppe_setting_audit (scope, key, changed_at DESC);
