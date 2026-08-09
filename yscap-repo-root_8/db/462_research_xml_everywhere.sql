-- 462 — EVERY appraisal XML that enters PILOT also lands in the research warehouse.
--
-- Owner-directed 2026-08-04: "anybody that is importing a XML into any file in the
-- system or saving an XML into the appraisal condition — that XML should be imported
-- also into the property resource at the same time, and bringing in all the
-- comparables into the system."
--
-- The warehouse was fed by exactly TWO doors: an appraisal that imported cleanly onto
-- a loan file, and the hand-upload screen. Every other way an XML arrives — a borrower
-- attaching it, a staffer filing it on any condition other than the appraisal one, a
-- document whose slot was named later, an appraisal import that failed for its own
-- reasons — filed the bytes and threw the market data away. This migration is the
-- record-keeping half of closing that; the catching itself is
-- `src/lib/research/xml-catch.js`, called from every document door.
--
-- TWO COLUMNS, EACH ANSWERING A QUESTION SOMEBODY ACTUALLY ASKS.

-- 1. WHERE DID THIS REPORT COME FROM? The import list previously showed a filename and
--    nothing else, so "did the ones on our loan files actually come in?" — the owner's
--    question — could not be answered from the screen. Free text on purpose: it is a
--    label for a human, never a key anything branches on, so a new door needs no
--    migration and an unrecognised value can never change behaviour.
ALTER TABLE research_imports
  ADD COLUMN IF NOT EXISTS source text;

-- 2. HAS THIS DOCUMENT BEEN LOOKED AT YET? The back-book sweep needs to know which
--    stored documents it has already considered, or it re-reads every XML in storage
--    on every boot forever. Stamped whether or not the file turned out to be an
--    appraisal — "we looked, it was a rent roll" is an answer and must drain.
--
--    DELIBERATELY NOT STAMPED when the READ ITSELF failed (storage unreachable): the
--    same rule the appraisal desk's `as_is_read_at` follows, because one outage that
--    stamps a real report drains it out of the sweep permanently.
ALTER TABLE documents
  ADD COLUMN IF NOT EXISTS research_xml_checked_at timestamptz;

-- The sweep's work queue. The predicate is NARROW on purpose — an unqualified
-- "checked_at IS NULL" index would cover every document ever stored (nearly all of
-- which are PDFs that will never be checked), which is a large index earning nothing.
-- `lower()`, `coalesce()` and a constant LIKE are all immutable, so they are legal in
-- a partial-index predicate.
CREATE INDEX IF NOT EXISTS ix_documents_research_xml_todo
  ON documents (created_at)
  WHERE research_xml_checked_at IS NULL
    AND (lower(coalesce(filename, '')) LIKE '%.xml'
         OR lower(coalesce(content_type, '')) LIKE '%xml%');

-- Reading the ledger by source ("show me everything the loan files brought in").
CREATE INDEX IF NOT EXISTS ix_research_imports_source
  ON research_imports (source, created_at DESC);
