-- 551_document_share_links.sql — A PILOT LINK INSTEAD OF AN ATTACHMENT
-- (owner-directed 2026-08-14: "we should always have also an option to save that PDF into a pilot
-- URL and put that URL instead of the document. Just give a double warning that the person may not
-- be able to open it, and we should rather try compressing it.").
--
-- WHY THIS IS THE SECOND CHOICE AND NOT THE FIRST, recorded here because the ordering is the whole
-- point. The owner's own reasoning: an outside recipient — a capital partner especially — may not
-- open a link that arrived from a system they have never heard of, and their mail security may
-- strip or rewrite it. So compression is tried first and a link is offered only when a document
-- genuinely cannot be made to fit. On the BORROWER side the calculus is different (they already
-- live in PILOT and the link takes them somewhere they recognise), which is why the owner asked for
-- it there in particular — but the double warning is shown on every side.
--
-- WHAT A LINK IS. A capability: a 128-bit random token, and nothing else. It is deliberately NOT
-- derived from a document id, so it publishes no internal identifier and cannot be walked. Every
-- link therefore has three limits that a plain document download does not need:
--   · it EXPIRES (default 30 days — long enough for an investor to fund a draw, short enough that a
--     forwarded email is not a permanent hole),
--   · it can be REVOKED at any moment, and
--   · every single open is COUNTED and TIMESTAMPED on the row, so "did they ever open it?" is
--     answerable — which is exactly the question the double warning raises.
--
-- IT CAN CARRY BYTES THAT ARE NOT A `documents` ROW. The delivery email builds a compressed copy of
-- our draw report at send time that is deliberately never filed (see draw-report.buildReportBytes —
-- filing it would supersede the full-quality report on the file). A link to that copy therefore
-- points at its own stored blob rather than at a document, which is why storage_ref/filename/
-- content_type live here instead of being read through a join.
--
-- Idempotent.

CREATE TABLE IF NOT EXISTS document_share_links (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- The capability itself. UNIQUE so a collision is a database error, never a silent overwrite.
  token             text NOT NULL UNIQUE,
  -- The file this belongs to, so a link is revoked with the file and shows on the file's own audit.
  application_id    uuid REFERENCES applications(id) ON DELETE CASCADE,
  -- The document, WHEN there is one. NULL = a generated copy that was never filed (above).
  document_id       uuid REFERENCES documents(id) ON DELETE SET NULL,
  -- Where the bytes actually are. Always set, even when document_id is: a document can be
  -- superseded and re-pointed, and a link that silently starts serving different bytes than the
  -- recipient was told about is worse than a dead link.
  storage_provider  text,
  storage_ref       text NOT NULL,
  filename          text NOT NULL,
  content_type      text,
  size_bytes        bigint,
  -- What this link was made for ('investor_delivery' / 'borrower_findings' / 'closing_prep' / …) —
  -- so the audit can answer "how often are we falling back to links, and on which surface?".
  purpose           text,
  label             text,                 -- the human name shown in the email ("Inspection report")
  created_by        uuid REFERENCES staff_users(id) ON DELETE SET NULL,
  created_at        timestamptz NOT NULL DEFAULT now(),
  expires_at        timestamptz,
  revoked_at        timestamptz,
  revoked_by        uuid REFERENCES staff_users(id) ON DELETE SET NULL,
  -- Access record. The counters answer the double warning's own question.
  opened_count      integer NOT NULL DEFAULT 0,
  first_opened_at   timestamptz,
  last_opened_at    timestamptz,
  last_opened_ip    text
);

-- The lookup the public route does on every open — by token, and only tokens that are still good.
CREATE INDEX IF NOT EXISTS idx_doc_share_links_token
  ON document_share_links (token);

-- The file's own list ("what have we shared out of this loan, and did anyone open it?").
CREATE INDEX IF NOT EXISTS idx_doc_share_links_app
  ON document_share_links (application_id, created_at DESC)
  WHERE application_id IS NOT NULL;

-- Live links only, for the expiry sweep and the admin view.
CREATE INDEX IF NOT EXISTS idx_doc_share_links_live
  ON document_share_links (expires_at)
  WHERE revoked_at IS NULL;
