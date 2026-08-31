-- ============================================================================
-- db/656 - lt term sheet deliveries
--
-- WHAT THIS CHANGES, AND WHY (owner-directed 2026-08-31): *"we should be able to
-- put in an email address from a borrower, which should deliver them the PDF and
-- the nice email ... It should deliver it from the loan officer's email address
-- and from the loan officer's name, and, of course, with the branding, same style
-- emails that we have on the short-term side."*
--
-- Until now a long-term term sheet could only be DOWNLOADED. An officer pulled
-- the PDF out of the browser and attached it to their own mail client by hand, so
-- nothing in PILOT recorded that a borrower had ever been sent one, at what price,
-- or to which address - the question "what did we actually send this person?" had
-- no answer here at all. This table is that answer.
--
-- WHY ITS OWN TABLE rather than a column on `lt_term_sheet`. A sheet is sent MORE
-- THAN ONCE in the ordinary course - a re-send to a corrected address, a copy to a
-- second borrower - and a single `emailed_at` column would record only the last of
-- them and silently lose the rest. One row per send is also what makes a duplicate
-- visible: two rows a minute apart is a story a person can read.
--
-- IT RECORDS THE DOCUMENT'S HASH, NOT THE DOCUMENT. The sheet's own snapshot is
-- immutable and is what the paper is drawn from, so the CONTENT of a re-render is
-- the same document; storing the bytes again would be a second copy of something
-- already settled.
--
-- HONEST NOTE, MEASURED rather than assumed: the bytes themselves are NOT
-- deterministic. Two renders of one sheet come out the same length with different
-- bytes deep inside a compressed stream, so `doc_sha256` says WHICH BYTES WENT OUT
-- and nothing more. Do NOT build anything on re-rendering a sheet and expecting its
-- hash back - "is this the copy we sent?" is answerable by hashing a copy somebody
-- forwards to us, and is NOT answerable by drawing a fresh one.
--
-- NO INVESTOR NAME REACHES IT, by construction: the only free text stored is the
-- officer's own note, which the sending path has already put through
-- `audience.scrubInvestorNames` before it reaches the borrower's inbox - so what
-- is recorded here is what was SENT, which is the only version worth keeping.
--
-- BACKFILL: NONE, and deliberately. Every sheet issued before today was handed to
-- its borrower outside PILOT, by a person, through a mail client we cannot see.
-- Inventing rows for those would be a fabricated record of sends we never made.
--
-- PRODUCT SEPARATION: Long-Term only. `lt_*` table, referencing `lt_term_sheet`
-- and nothing else. It reaches into no RTL table and no RTL trigger fires on it.
-- ============================================================================

CREATE TABLE IF NOT EXISTS lt_term_sheet_delivery (
    id              uuid NOT NULL DEFAULT gen_random_uuid(),

    -- The sheet that was sent. CASCADE because a delivery is a fact ABOUT a sheet
    -- and means nothing without it; a sheet is never deleted in the ordinary
    -- course, so this is a tidy-up rule rather than a live path.
    sheet_id        uuid NOT NULL,

    -- Denormalised so a screen can find every send of TS-4K7P2M without a join,
    -- and so a lookup by the code a person reads down a telephone stays one query.
    code            text NOT NULL,

    -- Who it went to, exactly as it was addressed. Lower-cased at the door so two
    -- spellings of one mailbox read as one address in this record.
    to_email        text NOT NULL,
    to_name         text,

    -- The officer's own note, AS SENT (already scrubbed). NULL when they sent the
    -- document with the letter's own wording and typed nothing.
    note            text,

    -- WHAT WAS SENT: the kind in its own words ("term sheet" / "comparison sheet"
    -- / "scenario comparison"), the filename the borrower received, and the
    -- sha256 of the exact bytes attached.
    doc_kind        text,
    filename        text,
    doc_sha256      text,

    -- WHO SENT IT, and how it was addressed on the wire. `sent_as_mode` is
    -- `send-as.js`'s own verdict - whether the From line really carried the
    -- officer's address, or the company's under their name - because "it came
    -- from me" is a claim this record should be able to settle.
    sent_by_staff   uuid,
    from_email      text,
    sent_as_mode    text,

    -- The provider's own message id, so an outcome traced in the provider's
    -- dashboard can be tied back to this row.
    message_id      text,

    created_at      timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT lt_term_sheet_delivery_pkey PRIMARY KEY (id)
);

-- The FK is added separately so the table creation above stays idempotent on a
-- database where it already exists with the constraint.
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'lt_term_sheet_delivery_sheet_fk'
    ) THEN
        ALTER TABLE lt_term_sheet_delivery
            ADD CONSTRAINT lt_term_sheet_delivery_sheet_fk
            FOREIGN KEY (sheet_id) REFERENCES lt_term_sheet (id) ON DELETE CASCADE;
    END IF;
END $$;

-- Every send of one sheet, newest first - the shape every reader wants.
CREATE INDEX IF NOT EXISTS lt_term_sheet_delivery_sheet_idx
    ON lt_term_sheet_delivery (sheet_id, created_at DESC);

-- "Has this borrower ever been sent anything?" without scanning.
CREATE INDEX IF NOT EXISTS lt_term_sheet_delivery_to_idx
    ON lt_term_sheet_delivery (to_email, created_at DESC);

-- ── after this lands ────────────────────────────────────────────────────────
-- The schema map (docs/schema/) describes the database these migrations build,
-- so this file makes it stale. CI refreshes it on this pull request by itself.
