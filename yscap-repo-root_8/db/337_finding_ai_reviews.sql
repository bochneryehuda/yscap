-- 337_finding_ai_reviews.sql
-- The AI FINDING-REVIEW GATE's durable memory (owner-directed 2026-07-27: "before you post a
-- finding as real, pass it through the AI with the whole loan file + the source document, ask if
-- it's a real concern or a misunderstanding, SAVE and REMEMBER the answer, and don't post it unless
-- the AI confirmed it — and also ask the AI for the suggested resolution / document to request").
--
-- Every finding PILOT raises is passed (best-effort, grounded on the whole loan file + its source
-- document) to the AI, which returns a verdict (confirmed / rejected / uncertain) + its reasoning +
-- a suggested resolution + a suggested document. That verdict is REMEMBERED here so (a) a re-read of
-- the same finding is not re-billed, and (b) a finding the AI confidently called a false alarm stays
-- suppressed on every later view instead of popping back — the same "a decision must stick" problem
-- the human ledger (db/333) solved, now for the AI's own verdict.
--
-- ADVISORY ONLY: this only ever SUPPRESSES a false-alarm finding from the shown list or ENRICHES a
-- real one with the AI's suggestion. It never creates a blocking finding, never clears a condition,
-- and touches no frozen number. Idempotent; keyed per (file, finding fingerprint).
CREATE TABLE IF NOT EXISTS finding_ai_reviews (
    id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    application_id        uuid REFERENCES applications(id) ON DELETE CASCADE,
    -- Stable identity of the finding this verdict is about (code + field + the compared values +
    -- source document). A finding whose values change gets a new fingerprint → a fresh review.
    fingerprint           text NOT NULL,
    claim_key             text,           -- finding-claims.claimOf, for grouping related findings
    code                  text,
    -- The verdict: 'confirmed' (real, concerning — post it), 'rejected' (false alarm /
    -- misunderstanding — suppress it), 'uncertain' (the AI couldn't tell — kept visible, flagged).
    verdict               text NOT NULL,
    is_real_concern       boolean,
    confidence            real,
    reasoning             text,           -- WHY — the AI's explanation, saved and shown to the human
    suggested_resolution  text,           -- what the AI suggests doing about it
    suggested_document    text,           -- the document the AI suggests requesting (or null)
    suggested_severity    text,           -- fatal | warning | info | unchanged (advisory opinion only)
    model                 text,
    grounding_hash        text,           -- fingerprint of the file state judged against (freshness)
    created_at            timestamptz NOT NULL DEFAULT now(),
    updated_at            timestamptz NOT NULL DEFAULT now()
);
-- One live verdict per (file, finding). Re-review upserts in place (never a second row).
CREATE UNIQUE INDEX IF NOT EXISTS uq_finding_ai_review ON finding_ai_reviews(application_id, fingerprint);
CREATE INDEX IF NOT EXISTS idx_finding_ai_review_app ON finding_ai_reviews(application_id);

COMMENT ON TABLE finding_ai_reviews IS
  'AI verdict on each PILOT finding (confirmed/rejected/uncertain) + reasoning + suggested resolution/document, grounded on the whole loan file. Advisory: suppresses a false alarm or enriches a real finding; never blocks. Keyed per (application_id, fingerprint).';
