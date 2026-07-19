-- ============================================================================
-- 126_esign_v2.sql — DocuSign eSignature v2 schema
--
-- Grows the db/037 `esign_envelopes` STUB into the production shape the DocuSign
-- integration needs. Implements the send-EXACTLY-once model, the envelope→doc→
-- condition correlation map, and the idempotent inbound-event inbox, per:
--   * docs/DOCUSIGN-ERROR-HANDLING-AND-HARDENING.md  §1 (send-once), §3 (webhook)
--   * docs/DOCUSIGN-BUG-REGISTER.md                  H-4 / H-5 / M-12 resolutions
--   * docs/DOCUSIGN-SECURITY-AND-COMPLIANCE.md        Part 3 (out-of-scope boundary)
--
-- Design notes baked into this schema:
--   * H-5: the send-once claim rides `send_claimed_at`, NEVER a fake status.
--          db/037's status CHECK enum (not_sent|sent|delivered|completed|
--          declined|voided|error) is left UNTOUCHED — no 'draft'/'sending'.
--   * H-4: a PARTIAL unique index constrains only IN-FLIGHT envelopes, so a
--          terminal (completed/declined/voided/error) envelope frees the pair
--          for a legitimate re-issue. A plain UNIQUE would block re-issue forever.
--   * M-12: `idempotency_key` is persisted so a crash-then-reclaim replays the
--          SAME deterministic key — DocuSign returns the original envelope or
--          creates the first, never a duplicate.
--
-- Everything here is ADDITIVE and nullable; no existing behavior changes and the
-- send path is not wired yet. Idempotent — safe to re-run on every boot.
-- ============================================================================

-- ---- esign_envelopes: send-once + correlation + lifecycle columns ----------
ALTER TABLE esign_envelopes ADD COLUMN IF NOT EXISTS purpose          text;
ALTER TABLE esign_envelopes ADD COLUMN IF NOT EXISTS send_claimed_at  timestamptz;   -- §1 layer 1: the atomic send-once claim rides THIS, not status
ALTER TABLE esign_envelopes ADD COLUMN IF NOT EXISTS sent_at          timestamptz;   -- when DocuSign accepted the create (envelope_id written)
ALTER TABLE esign_envelopes ADD COLUMN IF NOT EXISTS delivered_at     timestamptz;
ALTER TABLE esign_envelopes ADD COLUMN IF NOT EXISTS completed_at     timestamptz;
ALTER TABLE esign_envelopes ADD COLUMN IF NOT EXISTS declined_at      timestamptz;
ALTER TABLE esign_envelopes ADD COLUMN IF NOT EXISTS voided_at        timestamptz;
ALTER TABLE esign_envelopes ADD COLUMN IF NOT EXISTS void_reason      text;
ALTER TABLE esign_envelopes ADD COLUMN IF NOT EXISTS idempotency_key  text;          -- §1 layer 2: deterministic; replayed on reclaim (M-12)
ALTER TABLE esign_envelopes ADD COLUMN IF NOT EXISTS embedded         boolean NOT NULL DEFAULT false;  -- in-portal (clientUserId) signing vs email
ALTER TABLE esign_envelopes ADD COLUMN IF NOT EXISTS recipients       jsonb;         -- our-side snapshot of signers [{role,name,email,routingOrder,clientUserId?}] — no PII beyond name/email
ALTER TABLE esign_envelopes ADD COLUMN IF NOT EXISTS product_version  integer;       -- the economics/registration version the envelope was built from (idempotency key input + stale detection)
ALTER TABLE esign_envelopes ADD COLUMN IF NOT EXISTS last_event_at    timestamptz;   -- newest Connect event applied (out-of-order guard)
ALTER TABLE esign_envelopes ADD COLUMN IF NOT EXISTS created_by       uuid REFERENCES staff_users(id) ON DELETE SET NULL;

-- purpose whitelist — the ONLY document packages this flow may ever send.
-- A promissory note / mortgage / deed of trust / recordable / notarized document
-- is intentionally NOT here: those require wet-ink or eNote/eVault/MERS + RON and
-- must never be plain e-signed (SECURITY-AND-COMPLIANCE Part 3).
--   * term_sheet_package = term sheet + application export + business-purpose disclosure (ONE envelope)
--   * heter_iska         = standalone Heter Iska (never in TPR export, never in SharePoint)
DO $$ BEGIN
  ALTER TABLE esign_envelopes
    ADD CONSTRAINT chk_esign_purpose CHECK (purpose IS NULL OR purpose IN
      ('term_sheet_package','heter_iska'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- H-4: PARTIAL unique index — at most ONE in-flight envelope per (application,
-- purpose). Terminal states are excluded, so a completed/declined/voided/error
-- envelope frees the pair for re-issue (appraisal-stale reissue, void-then-resend).
CREATE UNIQUE INDEX IF NOT EXISTS uq_esign_inflight
  ON esign_envelopes(application_id, purpose)
  WHERE purpose IS NOT NULL AND status IN ('not_sent','sent','delivered');

-- One business action = one row (belt-and-suspenders on the DocuSign idempotency key).
CREATE UNIQUE INDEX IF NOT EXISTS uq_esign_idem
  ON esign_envelopes(idempotency_key)
  WHERE idempotency_key IS NOT NULL;

-- Reclaim scan: stale claims with no envelope_id yet (M-12).
CREATE INDEX IF NOT EXISTS idx_esign_reclaim
  ON esign_envelopes(send_claimed_at)
  WHERE envelope_id IS NULL AND send_claimed_at IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_esign_status ON esign_envelopes(status);

-- ---- esign_envelope_docs: documentId -> doc_kind -> condition map -----------
-- One row per document inside an envelope. On completion the webhook downloads
-- each signed document by its NUMERIC DocuSign documentId (never by name —
-- DOCUSIGN-DOCUMENT-BUILD-SPEC §5.4), stores it under `doc_kind`, and (if the
-- rules pass) clears `checklist_item_id`. Some docs are record-only (no condition).
CREATE TABLE IF NOT EXISTS esign_envelope_docs (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  envelope_row_id        uuid NOT NULL REFERENCES esign_envelopes(id) ON DELETE CASCADE,
  document_id            integer NOT NULL,       -- DocuSign documentId within the envelope (1,2,3…)
  doc_kind               text NOT NULL,          -- docKind for the stored signed PDF (term_sheet_signed, application_signed, business_purpose_signed, heter_iska_signed)
  checklist_item_id      uuid REFERENCES checklist_items(id) ON DELETE SET NULL,   -- the condition this signed doc clears (nullable = record-only)
  completed_document_id  uuid REFERENCES documents(id) ON DELETE SET NULL,          -- the stored signed PDF once downloaded
  cleared_at             timestamptz,            -- when the condition was auto-cleared (audit)
  created_at             timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_esign_env_doc
  ON esign_envelope_docs(envelope_row_id, document_id);
CREATE INDEX IF NOT EXISTS idx_esign_env_doc_item
  ON esign_envelope_docs(checklist_item_id) WHERE checklist_item_id IS NOT NULL;

-- ---- docusign_event_inbox: idempotent inbound Connect events ----------------
-- Every inbound Connect POST is stored by sha256(raw body) with ON CONFLICT DO
-- NOTHING, so a duplicate/replayed/out-of-order delivery is a no-op. The row
-- records the outcome so a stuck/failed event is never silently lost (mirrors
-- the existing ClickUp webhook inbox pattern). The event payload is a TRIGGER to
-- go read the truth from DocuSign — it is never itself trusted as the state.
CREATE TABLE IF NOT EXISTS docusign_event_inbox (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  body_sha256    text NOT NULL UNIQUE,           -- dedupe key = sha256 of the raw request body
  envelope_id    text,                           -- DocuSign envelopeId parsed from the event (nullable if unparseable)
  event_type     text,                           -- envelope-completed / envelope-declined / envelope-voided / recipient-completed …
  received_at    timestamptz NOT NULL DEFAULT now(),
  processed_at   timestamptz,                    -- set once acted upon
  process_error  text,                           -- last processing error (retry / inspect)
  attempts       integer NOT NULL DEFAULT 0,
  raw            jsonb                            -- parsed event (correlation + status only — no PII)
);
CREATE INDEX IF NOT EXISTS idx_ds_inbox_envelope
  ON docusign_event_inbox(envelope_id) WHERE envelope_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_ds_inbox_unprocessed
  ON docusign_event_inbox(received_at) WHERE processed_at IS NULL;
