-- 343 — A borrower's name is THREE fields, and the middle name finally has a home
--       (owner-directed 2026-07-27).
--
-- WHY. `borrowers` stored a person as first_name + last_name only. Every one-line
-- name arriving from ClickUp's single "Borrower Name" field was cut with
-- `lastIndexOf(' ')`, so:
--   * a middle name silently became part of the FIRST name
--       "Issac Michael Grunzweig"  ->  first_name 'Issac Michael' / last_name 'Grunzweig'
--   * a generational suffix became the LAST name
--       "John Michael Smith Jr"    ->  first_name 'John Michael Smith' / last_name 'Jr'
--
-- Encompass models the SAME person as three separate fields
-- (applications[].{party}.firstName / .middleName / .lastName, + suffixToName),
-- which is also the shape MISMO and every closing document want. Because we had
-- nowhere to put a middle name, `lib/integrations/encompass-field-map.js` had to
-- record the middle name as "(no column) — finding only", and the per-file
-- Encompass identity comparison joined first+last on both sides — so a file whose
-- Encompass copy is CORRECTLY split read as a NAME MISMATCH against our merged
-- first name, and that mismatch is BLOCK-gated (it holds the term sheet).
--
-- WHAT THIS ADDS (columns only — no data is moved here). The previous-files
-- repair is deliberately NOT written in SQL: the splitter has to understand
-- suffixes, courtesy titles, surname particles ("van", "de la") and middle
-- initials, and a PL/pgSQL twin of that logic would drift from the JavaScript one
-- the live sync uses. It runs at boot instead, in ONE language, from
-- `src/lib/name-heal.js` (the same pattern as the address repair in
-- `src/lib/address-heal.js`), which is why `name_split_checked_at` exists here.
--
--   middle_name            — optional, exactly as the owner asked. NULL = none.
--   name_suffix            — 'Jr.', 'III', 'MD' … pulled out of the last name.
--   name_review_needed     — TRUE when PILOT had to make a judgement call about
--                            where the name splits and wants a human to confirm.
--                            It is a PROMPT, never a gate: nothing blocks on it.
--   name_review_reason     — the machine key behind that prompt (see
--                            person-name.REASON_TEXT for the plain-language copy).
--   name_split_checked_at  — when the boot repair last looked at this row, so the
--                            pass is resumable and idempotent and never re-walks
--                            a row it has already settled.
--
-- Fully idempotent (IF NOT EXISTS everywhere) — safe on every boot.

ALTER TABLE borrowers ADD COLUMN IF NOT EXISTS middle_name           text;
ALTER TABLE borrowers ADD COLUMN IF NOT EXISTS name_suffix           text;
ALTER TABLE borrowers ADD COLUMN IF NOT EXISTS name_review_needed    boolean NOT NULL DEFAULT false;
ALTER TABLE borrowers ADD COLUMN IF NOT EXISTS name_review_reason    text;
ALTER TABLE borrowers ADD COLUMN IF NOT EXISTS name_split_checked_at timestamptz;

-- The staff "names to confirm" list reads exactly these rows, so it stays a
-- partial index — it must never grow to one entry per borrower.
CREATE INDEX IF NOT EXISTS idx_borrowers_name_review
  ON borrowers (updated_at DESC) WHERE name_review_needed = true;

-- The boot repair claims rows with this predicate; without the index it would
-- sequential-scan the whole borrower book on every deploy.
CREATE INDEX IF NOT EXISTS idx_borrowers_name_unchecked
  ON borrowers (created_at) WHERE name_split_checked_at IS NULL;

COMMENT ON COLUMN borrowers.middle_name IS
  'Optional middle name. Filled from a split one-line name (ClickUp), from Encompass''s own middleName field, or typed by a human. NULL = this person has none on file.';
COMMENT ON COLUMN borrowers.name_suffix IS
  'Generational/professional suffix (Jr., III, MD). Kept OUT of last_name so the surname compares cleanly against Encompass and prints correctly on closing documents.';
COMMENT ON COLUMN borrowers.name_review_needed IS
  'PILOT had to make a judgement call splitting this name and is asking a human to confirm it. A prompt only — it never blocks a condition, a term sheet, clear-to-close or funding.';
