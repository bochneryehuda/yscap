-- ============================================================================
-- LONG-TERM (LT) — db/574 — the Condition Center's mirror: conditions + eFolder.
--
-- WHAT THIS CHANGES, AND WHY. The long-term plan's phase 5 (docs/longterm/
-- LOS-MASTER-PLAN.md §5) has been designed and held since 2026-08-14. Its READ
-- side is the half that is not blocked: reading conditions and the eFolder is a
-- READ, covered by the existing read-only Encompass integration, while UPLOADING
-- a document into the eFolder is a WRITE whose request shape is recorded as
-- UNVERIFIED on docs/ENCOMPASS-WRITE-AUTHORIZATIONS.md and stays blocked. These
-- five tables are the mirror the read side fills.
--
-- WHAT WAS MEASURED, because it decides the shape (§5.0, a read-only sweep of 400
-- of ~696 loans on 2026-08-14, zero read errors):
--   * conditions EXIST — 337 across 10 loans, six of seven status buckets
--     matching the census exactly;
--   * and every one of them sits on a loan that is already CLOSED AND SOLD. Not
--     one active long-term loan in this tenant carries a single condition.
-- So an Encompass condition here is a POST-PURCHASE artifact — the trailing
-- documents an investor raises after buying the loan — and the day-to-day work
-- happens in the eFolder instead (101 documents on a mature loan, in groups
-- including "Needs List - Initial"). That is why this migration mirrors BOTH and
-- lets the file decide which face it shows, rather than building a condition
-- centre that would be empty on every file an officer is working.
--
-- THE FOUR THINGS THE MODEL HAS TO GET RIGHT (§5.2), each visible below:
--   1. Encompass is the source of truth and this is a MIRROR. Every row is keyed
--      on Encompass's own id and carries `encompass_synced_at`.
--   2. A DOCUMENT IS NOT A FILE. The eFolder document is the SLOT ("Appraisal");
--      the attachment is the paper. One document holds many attachments — two
--      tables, never one.
--   3. THE LINK RUNS DOCUMENT -> CONDITION, AND ONLY THAT WAY. The document
--      carries `conditions[]`; Encompass exposes no condition->documents
--      endpoint. "Which documents satisfy this condition" is built by INVERTING
--      that mapping, which is why it is its own many-to-many table and not a
--      column on either side.
--   4. `status_open` IS MIRRORED, NEVER DERIVED. Encompass computes whether a
--      condition is still outstanding. Deriving our own from the status word is
--      how our screen ends up disagreeing with theirs.
--
-- NOTHING IS DELETED, EVER. Everything in the eFolder is soft-deleted upstream,
-- so `is_removed` is mirrored and filtered on READ. The record of what was once
-- asked for has to survive — a condition that was raised and withdrawn is part of
-- the story of the loan.
--
-- ENCOMPASS STAYS ONE-WAY. Every column here is filled by READING. Nothing in
-- this file implies a write, and no upload path exists in src/longterm/**.
--
-- SEPARATION. Every table is lt_*; no RTL table is read, written or referenced;
-- no trigger and no function is defined. The only cross-product reference is
-- `sql-ref staff_users`, authorized in writing 2026-08-03 and recorded in
-- docs/LONG-TERM-AUTHORIZED-COPIES.md — and it is ON DELETE SET NULL, because
-- deactivating a person must empty a pointer and never delete a loan's history.
--
-- BACKFILL: none, and that is the whole point of a mirror. These tables are
-- filled by the read-only sync on its own cadence; there is nothing in PILOT to
-- copy across, because until now nothing here was ever stored.
--
-- IDEMPOTENT: every CREATE is guarded, every index is IF NOT EXISTS, every
-- column add is IF NOT EXISTS, and every foreign key is added only when absent.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- lt_conditions — an Encompass ENHANCED condition, mirrored.
--
-- READ FROM: GET /encompass/v3/loans/{loanId}/conditions
--
-- NOT from the four v1 condition routes. They answer 200 with an EMPTY ARRAY on
-- every loan in this tenant — they answer for a legacy system it does not use —
-- and a sweep of all 772 loans through them found ZERO conditions while the v3
-- resource returned 348 on the same loans. An empty 200 is not proof of absence;
-- src/longterm/encompass/conditions.js records the whole trap.
--
-- EVERY DESCRIPTIVE FIELD IS TEXT, NOT AN ENUM. `condition_type`, `category`,
-- `prior_to`, `status`, `source` and `owner_role` are all TENANT configuration
-- (197 condition templates and 19 condition sets were counted here) — the same
-- reasoning that keeps lt_loan_contacts.role text: an enum would be a migration
-- every time a buyer of this system spells their own workflow differently.
--
-- `raw` keeps the whole condition as Encompass sent it. A mirror that stores only
-- the fields today's screen reads cannot answer tomorrow's question without
-- re-reading the whole tenant, and this is the cheapest insurance there is.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS lt_conditions (
    id                      UUID NOT NULL,
    loan_id                 UUID NOT NULL,
    encompass_condition_id  TEXT NOT NULL,

    condition_type          TEXT,
    title                   TEXT,
    internal_description    TEXT,
    external_description    TEXT,
    category                TEXT,
    prior_to                TEXT,

    -- Encompass's own answer to "is this still outstanding?" — mirrored, never
    -- derived from `status` (§5.2 rule 4).
    status                  TEXT,
    status_open             BOOLEAN,
    status_date             timestamptz,

    source                  TEXT,
    source_of_condition     TEXT,
    print_definitions       JSONB,
    application_ref         TEXT,
    owner_role              TEXT,
    assigned_to             TEXT,
    recipient               TEXT,
    days_to_receive         INTEGER,
    comments_count          INTEGER,
    internal_id             TEXT,

    -- Soft-deleted upstream. Mirrored and filtered on READ; never a DELETE here.
    is_removed              BOOLEAN NOT NULL DEFAULT false,

    encompass_created_by    TEXT,
    encompass_created_at    timestamptz,
    encompass_modified_by   TEXT,
    encompass_modified_at   timestamptz,

    raw                     JSONB,
    encompass_synced_at     timestamptz,
    created_at              timestamptz NOT NULL DEFAULT now(),
    updated_at              timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT lt_conditions_pkey PRIMARY KEY (id)
);

CREATE UNIQUE INDEX IF NOT EXISTS lt_conditions_loan_enc_uk
    ON lt_conditions (loan_id, encompass_condition_id);
CREATE INDEX IF NOT EXISTS lt_conditions_loan_idx ON lt_conditions (loan_id);
-- The one question every screen asks: what is still outstanding on this loan.
CREATE INDEX IF NOT EXISTS lt_conditions_open_idx
    ON lt_conditions (loan_id) WHERE status_open AND NOT is_removed;

-- ---------------------------------------------------------------------------
-- lt_condition_comments — the thread on one condition.
--
-- READ FROM: GET /encompass/v3/loans/{id}/conditions/{conditionId}/comments
--
-- Its own table rather than a jsonb column on the condition, because a comment is
-- the unit a person reads and answers, and burying a thread inside a blob makes
-- "what was said and when" unqueryable the first time anyone asks.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS lt_condition_comments (
    id                    UUID NOT NULL,
    condition_id          UUID NOT NULL,
    encompass_comment_id  TEXT,

    body                  TEXT,
    author_name           TEXT,
    author_id             TEXT,
    commented_at          timestamptz,

    raw                   JSONB,
    encompass_synced_at   timestamptz,
    created_at            timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT lt_condition_comments_pkey PRIMARY KEY (id)
);

-- PARTIAL, because a comment id is not guaranteed on every vendor payload and a
-- blanket unique index over a nullable column would collapse two real comments
-- that both happen to arrive without one.
CREATE UNIQUE INDEX IF NOT EXISTS lt_condition_comments_enc_uk
    ON lt_condition_comments (condition_id, encompass_comment_id)
    WHERE encompass_comment_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS lt_condition_comments_cond_idx
    ON lt_condition_comments (condition_id, commented_at);

-- ---------------------------------------------------------------------------
-- lt_documents — an eFolder DOCUMENT: the SLOT, not the paper.
--
-- READ FROM: GET /encompass/v3/loans/{loanId}/documents
--
-- A document is a placeholder with a title, a status and the milestone it is
-- expected at; the files under it are attachments (next table). The measured
-- population is 20,569 documents across 673 loans holding 28,822 attachments, so
-- the one-to-many is the ordinary case rather than an edge one.
--
-- `status` is the eFolder's own vocabulary — needed / received / ordered /
-- reordered / expected / expected! / expired! / ready to ship / ready for UW /
-- reviewed. Text, mirrored verbatim, never re-spelled into ours: the moment we
-- translate it, our screen and theirs can disagree about the same document.
--
-- The three visibility flags are mirrored because they are the only record of who
-- Encompass believes may see this document. They are NOT an authorization here —
-- long-term access is decided by src/longterm/access.js — but a document Encompass
-- marks borrower-visible is a fact worth holding when the client side is built.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS lt_documents (
    id                     UUID NOT NULL,
    loan_id                UUID NOT NULL,
    encompass_document_id  TEXT NOT NULL,

    title                  TEXT,
    title_with_index       TEXT,
    application_ref        TEXT,
    application_name       TEXT,
    milestone_id           TEXT,
    milestone_name         TEXT,
    status                 TEXT,
    roles                  JSONB,

    web_center_allowed     BOOLEAN,
    tpo_allowed            BOOLEAN,
    third_party_allowed    BOOLEAN,
    is_protected           BOOLEAN,

    days_due               INTEGER,
    days_till_expire       INTEGER,
    attachment_count       INTEGER,

    is_removed             BOOLEAN NOT NULL DEFAULT false,

    encompass_created_by   TEXT,
    encompass_created_at   timestamptz,

    raw                    JSONB,
    encompass_synced_at    timestamptz,
    created_at             timestamptz NOT NULL DEFAULT now(),
    updated_at             timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT lt_documents_pkey PRIMARY KEY (id)
);

CREATE UNIQUE INDEX IF NOT EXISTS lt_documents_loan_enc_uk
    ON lt_documents (loan_id, encompass_document_id);
CREATE INDEX IF NOT EXISTS lt_documents_loan_idx ON lt_documents (loan_id);
CREATE INDEX IF NOT EXISTS lt_documents_status_idx ON lt_documents (loan_id, status)
    WHERE NOT is_removed;

-- ---------------------------------------------------------------------------
-- lt_document_attachments — METADATA ONLY. The paper stays in Encompass.
--
-- READ FROM: GET /encompass/v3/loans/{loanId}/attachments
--
-- WE KEEP THE URI, NEVER THE BYTES (§5.3). Three reasons, and none of them is
-- storage cost: Encompass is the system of record for the document itself, a
-- copied file starts drifting the moment somebody replaces the original there,
-- and pulling borrower paper into a second store is a decision about where PII
-- lives that nobody has asked for. `encompass_uri` is a POINTER — reading it
-- later is a fresh authenticated GET, exactly as it is today.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS lt_document_attachments (
    id                       UUID NOT NULL,
    document_id              UUID NOT NULL,
    encompass_attachment_id  TEXT NOT NULL,

    title                    TEXT,
    file_name                TEXT,
    content_type             TEXT,
    file_size                BIGINT,
    page_count               INTEGER,

    -- The pointer, never the paper.
    encompass_uri            TEXT,

    is_removed               BOOLEAN NOT NULL DEFAULT false,

    encompass_created_by     TEXT,
    encompass_created_at     timestamptz,

    raw                      JSONB,
    encompass_synced_at      timestamptz,
    created_at               timestamptz NOT NULL DEFAULT now(),
    updated_at               timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT lt_document_attachments_pkey PRIMARY KEY (id)
);

CREATE UNIQUE INDEX IF NOT EXISTS lt_document_attachments_enc_uk
    ON lt_document_attachments (document_id, encompass_attachment_id);
CREATE INDEX IF NOT EXISTS lt_document_attachments_doc_idx
    ON lt_document_attachments (document_id) WHERE NOT is_removed;

-- ---------------------------------------------------------------------------
-- lt_document_conditions — the INVERTED link (§5.2 rule 3).
--
-- The link lives on the DOCUMENT: `document.conditions[]` holds one entry per
-- linked condition, each with entityType "EnhancedCondition" and an entityUri of
-- /v3/loans/{loanId}/conditions/{conditionId}. There is no condition->documents
-- endpoint, so "show me the documents that satisfy this condition" is built by
-- reading the documents and inverting — which is a many-to-many, and therefore a
-- table rather than a column on either side. 179 such links were counted.
--
-- `encompass_condition_id` IS THE LINK, AND `condition_id` IS ONLY ITS
-- RESOLUTION. Encompass can name a condition we have not mirrored yet — the two
-- reads are separate calls, they can land in either order, and a removed
-- condition is still referenced by the documents that answered it. Keying the row
-- on the Encompass id means the fact "Encompass says this document answers that
-- condition" is recorded WHATEVER we happen to hold, and the uuid is filled in
-- when the condition row exists. A foreign key alone would have silently dropped
-- exactly the links most worth having.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS lt_document_conditions (
    id                      UUID NOT NULL,
    document_id             UUID NOT NULL,
    encompass_condition_id  TEXT NOT NULL,
    condition_id            UUID,

    entity_type             TEXT,
    entity_name             TEXT,
    entity_uri              TEXT,

    encompass_synced_at     timestamptz,
    created_at              timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT lt_document_conditions_pkey PRIMARY KEY (id)
);

CREATE UNIQUE INDEX IF NOT EXISTS lt_document_conditions_uk
    ON lt_document_conditions (document_id, encompass_condition_id);
CREATE INDEX IF NOT EXISTS lt_document_conditions_cond_idx
    ON lt_document_conditions (condition_id) WHERE condition_id IS NOT NULL;
-- The unresolved links, so a sync can fill them in without scanning the table.
CREATE INDEX IF NOT EXISTS lt_document_conditions_unresolved_idx
    ON lt_document_conditions (encompass_condition_id) WHERE condition_id IS NULL;

-- ---------------------------------------------------------------------------
-- The per-loan sync stamps, on lt_loans.
--
-- Same shape as `encompass_synced_at` / `encompass_sync_error` already there: a
-- failure is RECORDED ON THE LOAN rather than swallowed, because one unreadable
-- file must never stop the other 699, and a sync that fails silently is worse
-- than one that fails loudly. These columns are what make "why is this file's
-- condition list stale?" answerable.
-- ---------------------------------------------------------------------------

ALTER TABLE lt_loans ADD COLUMN IF NOT EXISTS conditions_synced_at  timestamptz;
ALTER TABLE lt_loans ADD COLUMN IF NOT EXISTS conditions_sync_error TEXT;
ALTER TABLE lt_loans ADD COLUMN IF NOT EXISTS documents_synced_at   timestamptz;
ALTER TABLE lt_loans ADD COLUMN IF NOT EXISTS documents_sync_error  TEXT;

-- Oldest-first is how the sweep picks its next loan; NULLS FIRST puts a loan
-- nobody has read yet at the front.
CREATE INDEX IF NOT EXISTS lt_loans_cond_synced_idx
    ON lt_loans (conditions_synced_at NULLS FIRST);

-- ---------------------------------------------------------------------------
-- Foreign keys, added only when absent.
--
-- Every one of them CASCADES from the row it hangs off (a condition's comments
-- are meaningless without the condition), and the ONE identity-zone reference
-- pattern — SET NULL — does not appear here because none of these tables points
-- at a person. `lt_document_conditions.condition_id` is SET NULL rather than
-- CASCADE for the reason given above: the LINK is the Encompass id, and losing
-- the resolution must never lose the fact.
-- ---------------------------------------------------------------------------

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'lt_conditions_loan_fkey') THEN
    ALTER TABLE lt_conditions ADD CONSTRAINT lt_conditions_loan_fkey
      FOREIGN KEY (loan_id) REFERENCES lt_loans(id) ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'lt_condition_comments_cond_fkey') THEN
    ALTER TABLE lt_condition_comments ADD CONSTRAINT lt_condition_comments_cond_fkey
      FOREIGN KEY (condition_id) REFERENCES lt_conditions(id) ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'lt_documents_loan_fkey') THEN
    ALTER TABLE lt_documents ADD CONSTRAINT lt_documents_loan_fkey
      FOREIGN KEY (loan_id) REFERENCES lt_loans(id) ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'lt_document_attachments_doc_fkey') THEN
    ALTER TABLE lt_document_attachments ADD CONSTRAINT lt_document_attachments_doc_fkey
      FOREIGN KEY (document_id) REFERENCES lt_documents(id) ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'lt_document_conditions_doc_fkey') THEN
    ALTER TABLE lt_document_conditions ADD CONSTRAINT lt_document_conditions_doc_fkey
      FOREIGN KEY (document_id) REFERENCES lt_documents(id) ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'lt_document_conditions_cond_fkey') THEN
    ALTER TABLE lt_document_conditions ADD CONSTRAINT lt_document_conditions_cond_fkey
      FOREIGN KEY (condition_id) REFERENCES lt_conditions(id) ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;

-- ── after this lands ────────────────────────────────────────────────────────
-- The schema map (docs/schema/) describes the database these migrations build,
-- so this file makes it stale. CI refreshes it on this pull request by itself;
-- if you would rather do it by hand, with DATABASE_URL pointing at a database
-- built from these migrations:
--
--   npm run schema:snapshot     # refresh the inventory from the database
--   npm run schema:restamp      # re-stamp the map header (no database needed)
