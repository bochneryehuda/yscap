-- ============================================================================
-- 044_borrower_history_backfill.sql — borrower identity graph + history ingest
--
-- Supports docs/BORROWER-HISTORY-BACKFILL.md: SSN-hash identity matching,
-- multi email/phone, LLC library + track-record provenance, a fast task index
-- for re-sync, and a weak-match confirmation queue. Additive + idempotent.
-- ============================================================================

-- ---- borrowers: identity + origin -----------------------------------------
ALTER TABLE borrowers ADD COLUMN IF NOT EXISTS ssn_hash text;                 -- HMAC-SHA256(ssn, SSN_MATCH_KEY)
ALTER TABLE borrowers ADD COLUMN IF NOT EXISTS origin   text NOT NULL DEFAULT 'portal';  -- portal | clickup_backfill
CREATE INDEX IF NOT EXISTS idx_borrowers_ssn_hash ON borrowers(ssn_hash) WHERE ssn_hash IS NOT NULL;

-- ---- every email / phone we've ever seen for a borrower --------------------
CREATE TABLE IF NOT EXISTS borrower_contacts (
    id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    borrower_id  uuid NOT NULL REFERENCES borrowers(id) ON DELETE CASCADE,
    kind         text NOT NULL CHECK (kind IN ('email','phone')),
    value        text NOT NULL,
    source       text,                                 -- 'clickup:<task_id>' etc.
    is_primary   boolean NOT NULL DEFAULT false,
    created_at   timestamptz NOT NULL DEFAULT now(),
    UNIQUE (borrower_id, kind, value)
);
CREATE INDEX IF NOT EXISTS idx_borrower_contacts_borrower ON borrower_contacts(borrower_id);
CREATE INDEX IF NOT EXISTS idx_borrower_contacts_value ON borrower_contacts(kind, value);

-- ---- provenance on the LLC library & track record -------------------------
ALTER TABLE llcs ADD COLUMN IF NOT EXISTS origin         text NOT NULL DEFAULT 'portal';  -- portal | clickup_backfill
ALTER TABLE llcs ADD COLUMN IF NOT EXISTS source_task_id text;

ALTER TABLE track_records ADD COLUMN IF NOT EXISTS origin         text NOT NULL DEFAULT 'portal';
ALTER TABLE track_records ADD COLUMN IF NOT EXISTS source_task_id text;
ALTER TABLE track_records ADD COLUMN IF NOT EXISTS inferred       boolean NOT NULL DEFAULT false;  -- deal_type guessed
ALTER TABLE track_records ADD COLUMN IF NOT EXISTS address_key    text;                            -- normalized addr for dedup / purchase+refi detection
CREATE INDEX IF NOT EXISTS idx_track_records_addr_key ON track_records(borrower_id, address_key);

-- ---- fast task index for re-sync & SSN linkage (O(1) lookups) --------------
CREATE TABLE IF NOT EXISTS clickup_task_index (
    task_id        text PRIMARY KEY,
    parent_task_id text,                               -- set for co-borrower subtasks
    kind           text CHECK (kind IN ('rtl_file','data_only','subtask')),
    program        text,
    ssn_hash       text,
    borrower_id    uuid REFERENCES borrowers(id) ON DELETE SET NULL,
    application_id uuid REFERENCES applications(id) ON DELETE SET NULL,
    llc_id         uuid REFERENCES llcs(id) ON DELETE SET NULL,
    last_seen      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_clickup_task_index_ssn ON clickup_task_index(ssn_hash) WHERE ssn_hash IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_clickup_task_index_borrower ON clickup_task_index(borrower_id);

-- ---- weak-match confirmation queue (auto-link only on strong SSN match) ----
CREATE TABLE IF NOT EXISTS borrower_link_candidates (
    id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    borrower_id          uuid NOT NULL REFERENCES borrowers(id) ON DELETE CASCADE,   -- the registering/active profile
    candidate_borrower_id uuid NOT NULL REFERENCES borrowers(id) ON DELETE CASCADE,  -- a possible past match
    match_fields         jsonb,                         -- which fields agreed
    score                integer NOT NULL DEFAULT 0,
    status               text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','confirmed','rejected')),
    resolved_by_kind     text,
    resolved_by_id       uuid,
    created_at           timestamptz NOT NULL DEFAULT now(),
    resolved_at          timestamptz,
    UNIQUE (borrower_id, candidate_borrower_id)
);
CREATE INDEX IF NOT EXISTS idx_link_candidates_status ON borrower_link_candidates(status, borrower_id);
