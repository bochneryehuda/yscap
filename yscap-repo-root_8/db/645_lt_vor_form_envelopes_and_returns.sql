-- ============================================================================
-- db/645 — the long-term verification of rent: the form, its envelopes, its return
--
-- WHAT THIS CHANGES, AND WHY. The long-term condition `lt_vor_sent` has described
-- this step since the condition library shipped ("the form is filled in from what we
-- already know … every part the landlord has to answer is left blank and required …
-- a form that comes back filled in by hand voids the envelope") and there was
-- nowhere to KEEP any of it. Without these tables the form's edited data lives
-- nowhere, so a second preview loses whatever a processor corrected; the DocuSign
-- envelope is untracked, so the shared Connect webhook cannot tell a long-term
-- envelope from a short-term one and silently drops the landlord's signature; and
-- "a manual return voids the envelope" has no envelope to void.
--
-- THREE TABLES, AND THE SPLIT IS THE POINT.
--
--   lt_vor_forms      ONE per loan. The form's own DATA — our half, edited by a
--                     person, re-rendered into the PDF on every preview and again at
--                     the moment of sending. The PDF is deliberately NOT stored as
--                     the source of truth: a hand-edited PDF cannot be re-anchored,
--                     and every reader downstream reads the data anyway.
--   lt_vor_envelopes  ONE per DocuSign envelope. A re-send after a void is a NEW
--                     envelope and a new row, because the landlord genuinely
--                     received two — collapsing them would lose which one they
--                     signed. This is also the table the inbound Connect claim
--                     looks a long-term envelope up in.
--   lt_vor_returns    What came BACK, however it came back: DocuSign's completed
--                     copy, or a form somebody filled in by hand and emailed. Both
--                     are answers to the same question and both belong on one
--                     timeline, which is what makes "the manual one voids the
--                     envelope" expressible at all.
--
-- WHY THERE IS NO FOREIGN KEY ONTO staff_users. Every other lt_* table here follows
-- the same reading: the staff roster is the shared IDENTITY zone, a person leaves
-- the company, and none of CASCADE (erases who sent it), RESTRICT (refuses to
-- deactivate them) or SET NULL (quietly forgets) is the right answer for a record
-- whose whole job is to say who did this. The id is kept and resolved on read.
--
-- IDEMPOTENT: every statement is IF NOT EXISTS / drop-then-add, so replaying this
-- file on every boot is a no-op from the second run.
-- SEPARATION: lt_* only. No lt_ table references an RTL table; no RTL trigger fires
-- on any of these.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- The form
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS lt_vor_forms (
    id           uuid NOT NULL DEFAULT gen_random_uuid(),
    loan_id      uuid NOT NULL,

    -- OUR half of the form, keyed by the field keys in src/longterm/vor/fields.js.
    -- The landlord's half is deliberately NOT here: it arrives in lt_vor_returns,
    -- and a column that could hold both would be a column somebody eventually fills
    -- in on the landlord's behalf.
    data         jsonb NOT NULL DEFAULT '{}'::jsonb,

    -- Whether a person has looked at the prefill. A form nobody has opened is still
    -- sendable (the prefill is the whole point), but the desk says which it is.
    reviewed_by  uuid,
    reviewed_at  timestamptz,

    created_at   timestamptz NOT NULL DEFAULT now(),
    updated_at   timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT lt_vor_forms_pkey PRIMARY KEY (id),
    CONSTRAINT lt_vor_forms_loan_fk FOREIGN KEY (loan_id)
      REFERENCES lt_loans (id) ON DELETE CASCADE
);

-- One form per loan. The unique index IS the guarantee, not a read-then-insert in
-- the application: two processors opening the desk at the same moment both read
-- "no form yet" and both insert, and the loser of that race is the edit that
-- disappears (db/401's lesson, applied before it can happen).
CREATE UNIQUE INDEX IF NOT EXISTS lt_vor_forms_loan_uk ON lt_vor_forms (loan_id);

-- ---------------------------------------------------------------------------
-- The envelopes
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS lt_vor_envelopes (
    id            uuid NOT NULL DEFAULT gen_random_uuid(),
    loan_id       uuid NOT NULL,
    form_id       uuid,

    -- DocuSign's own id. NULL for the brief moment between claiming the row and the
    -- provider answering — which is what makes a lost response recoverable rather
    -- than a second envelope to the same landlord.
    envelope_id   text,

    -- created | sent | delivered | completed | declined | voided | failed
    -- The lifecycle DocuSign reports, plus 'failed' for a send that never left.
    status        text NOT NULL DEFAULT 'created',

    -- Who it went to, recorded at send time. Kept even when the file's landlord
    -- contact changes afterwards: the question a year later is who we asked.
    recipient_name  text,
    recipient_email text,

    -- 'docusign' or 'both' — the method this envelope was part of. An email-only
    -- send creates no envelope at all, which is why 'email' never appears here.
    send_method   text NOT NULL DEFAULT 'docusign',

    sent_by       uuid,
    sent_at       timestamptz,
    completed_at  timestamptz,

    -- Why it was voided, in words. Written when a manual return arrives, and it is
    -- the only record afterwards of why an envelope in flight was stopped.
    void_reason   text,
    voided_at     timestamptz,

    last_error    text,
    created_at    timestamptz NOT NULL DEFAULT now(),
    updated_at    timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT lt_vor_envelopes_pkey PRIMARY KEY (id),
    CONSTRAINT lt_vor_envelopes_loan_fk FOREIGN KEY (loan_id)
      REFERENCES lt_loans (id) ON DELETE CASCADE,
    CONSTRAINT lt_vor_envelopes_form_fk FOREIGN KEY (form_id)
      REFERENCES lt_vor_forms (id) ON DELETE SET NULL
);

-- The inbound Connect claim looks an envelope up by this id, so it is unique where
-- it is present. PARTIAL, because a row is created BEFORE the provider answers and
-- several such rows would collide on a NULL under a plain unique index.
CREATE UNIQUE INDEX IF NOT EXISTS lt_vor_envelopes_envelope_uk
  ON lt_vor_envelopes (envelope_id) WHERE envelope_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS lt_vor_envelopes_loan_idx ON lt_vor_envelopes (loan_id, created_at DESC);

-- ---------------------------------------------------------------------------
-- What came back
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS lt_vor_returns (
    id            uuid NOT NULL DEFAULT gen_random_uuid(),
    loan_id       uuid NOT NULL,
    envelope_id   uuid,

    -- 'docusign' — the landlord signed the envelope.
    -- 'manual'   — a filled-in form reached us some other way (emailed, faxed,
    --              handed over). This is the one that voids an envelope in flight.
    source        text NOT NULL,

    -- The landlord's answers, where we have them. DocuSign returns them as tab
    -- values; a manual return usually has none until somebody types them in, and an
    -- empty object is the honest record of that.
    answers       jsonb NOT NULL DEFAULT '{}'::jsonb,

    -- Where the returned document itself was filed. It is a storage ref rather than
    -- bytes: the same storage every other long-term document goes to.
    storage_ref   text,
    filename      text,

    recorded_by   uuid,
    note          text,
    created_at    timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT lt_vor_returns_pkey PRIMARY KEY (id),
    CONSTRAINT lt_vor_returns_loan_fk FOREIGN KEY (loan_id)
      REFERENCES lt_loans (id) ON DELETE CASCADE,
    CONSTRAINT lt_vor_returns_env_fk FOREIGN KEY (envelope_id)
      REFERENCES lt_vor_envelopes (id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS lt_vor_returns_loan_idx ON lt_vor_returns (loan_id, created_at DESC);

-- A DocuSign return is recorded once per envelope however many times the webhook is
-- redelivered — Connect retries freely, and two "the landlord signed" rows on one
-- envelope would read as two landlords answering.
CREATE UNIQUE INDEX IF NOT EXISTS lt_vor_returns_env_docusign_uk
  ON lt_vor_returns (envelope_id) WHERE source = 'docusign' AND envelope_id IS NOT NULL;

-- ---------------------------------------------------------------------------
-- The vocabularies. Dropped then re-added so a later file may widen them without
-- this one failing on replay and silently skipping everything after it (db/529).
-- ---------------------------------------------------------------------------
ALTER TABLE lt_vor_envelopes DROP CONSTRAINT IF EXISTS lt_vor_envelopes_status_chk;
ALTER TABLE lt_vor_envelopes ADD CONSTRAINT lt_vor_envelopes_status_chk
  CHECK (status IN ('created','sent','delivered','completed','declined','voided','failed'));

ALTER TABLE lt_vor_envelopes DROP CONSTRAINT IF EXISTS lt_vor_envelopes_method_chk;
ALTER TABLE lt_vor_envelopes ADD CONSTRAINT lt_vor_envelopes_method_chk
  CHECK (send_method IN ('docusign','both'));

ALTER TABLE lt_vor_returns DROP CONSTRAINT IF EXISTS lt_vor_returns_source_chk;
ALTER TABLE lt_vor_returns ADD CONSTRAINT lt_vor_returns_source_chk
  CHECK (source IN ('docusign','manual'));

-- updated_at, on the two tables a person edits.
CREATE OR REPLACE FUNCTION lt_vor_touch_updated_at() RETURNS trigger AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_lt_vor_forms_touch ON lt_vor_forms;
CREATE TRIGGER trg_lt_vor_forms_touch BEFORE UPDATE ON lt_vor_forms
  FOR EACH ROW EXECUTE FUNCTION lt_vor_touch_updated_at();

DROP TRIGGER IF EXISTS trg_lt_vor_envelopes_touch ON lt_vor_envelopes;
CREATE TRIGGER trg_lt_vor_envelopes_touch BEFORE UPDATE ON lt_vor_envelopes
  FOR EACH ROW EXECUTE FUNCTION lt_vor_touch_updated_at();
