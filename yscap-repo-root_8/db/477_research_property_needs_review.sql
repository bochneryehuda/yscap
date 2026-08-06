-- KEEP A COMPARABLE SALE EVEN WHEN THE APPRAISER WROTE A THIN ADDRESS.
--
-- The research warehouse used to DROP any comparable whose address could not be
-- turned into a property key (no house number, no state, or no town/ZIP), and the
-- owner was right that too many were being lost — a report chose those sales as
-- comparables, so they are real transactions worth keeping. Two changes sit on
-- top of these columns (src/lib/research/ingest.js):
--
--   • a comp missing only its TOWN now borrows the subject's town (a comparable is
--     near its subject by definition) and files as a NORMAL property — no flag.
--   • a comp we still cannot identify (no house number) is filed as its OWN row,
--     flagged here, so nothing is lost. It is kept OUT of the ordinary comparable
--     search (src/lib/research/search.js) so an unverifiable address never pads a
--     result — but the sale is recorded, countable, and can be reviewed.
--
-- `needs_review` defaults FALSE, so every property already in the warehouse — and
-- every normally-keyed one from here on — is unchanged and fully searchable.
ALTER TABLE properties ADD COLUMN IF NOT EXISTS needs_review boolean NOT NULL DEFAULT false;
ALTER TABLE properties ADD COLUMN IF NOT EXISTS review_reason text;

-- The search excludes these by default, so an index on the flag keeps that clause
-- from touching the flagged rows at all.
CREATE INDEX IF NOT EXISTS idx_properties_needs_review ON properties(needs_review) WHERE needs_review;
