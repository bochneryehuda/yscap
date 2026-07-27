-- 346 — THE ONE BIG NAME FIELD stays (owner-directed 2026-07-27, follow-up to db/345).
--
-- The owner's direction, verbatim in intent: "leave the field where it has one big
-- field for the borrower's name — when somebody types it separately it should go
-- over there, the full name. All the places where you were using the name should
-- still use the existing full name field. We should just ADD fields to be able to
-- enter first, middle and last name, so the big field is still used everywhere it
-- was used until now and nothing breaks."
--
-- db/345 split a person into first / middle / last / suffix. That is what
-- Encompass, MISMO and the closing documents need — but every screen, email,
-- term sheet, SharePoint folder, DocuSign envelope and ClickUp card in PILOT
-- reads THE WHOLE NAME. If those keep joining first + last only, a middle name
-- would silently DISAPPEAR from all of them the moment it was split out.
--
-- So the whole name is a real, always-present column: `full_name`.
--
-- It is a POSTGRES GENERATED COLUMN, not a trigger and not application code, so
-- it CANNOT drift from the parts — there is no write path anywhere that could
-- leave the big field disagreeing with the pieces, present or future. Writing a
-- full name means writing the parts (the app splits it first); reading the whole
-- name is always this one column.
--
-- The expression uses `||` rather than concat_ws because concat_ws is only STABLE
-- (it does type-to-text conversion), and a generated column requires an IMMUTABLE
-- expression. `btrim`, `coalesce`, `||` and `regexp_replace` are all immutable, and
-- the regexp collapses the gaps left by absent parts, so:
--     'Issac' + 'Michael' + 'Grunzweig'        -> 'Issac Michael Grunzweig'
--     'Dov'   + (none)    + 'Steiner'          -> 'Dov Steiner'
--     'John'  + 'Michael' + 'Smith'  + 'Jr.'   -> 'John Michael Smith Jr.'
--     (nothing at all)                          -> '' (never NULL, so a join never
--                                                  swallows a row)
--
-- Idempotent: the column is added only when missing, and STORED means every
-- existing row is filled by the ALTER itself — previous files and future ones,
-- with no backfill pass to run.

ALTER TABLE borrowers ADD COLUMN IF NOT EXISTS full_name text
  GENERATED ALWAYS AS (
    btrim(regexp_replace(
      coalesce(btrim(first_name), '') || ' ' ||
      coalesce(btrim(middle_name), '') || ' ' ||
      coalesce(btrim(last_name), '') || ' ' ||
      coalesce(btrim(name_suffix), ''),
      '\s+', ' ', 'g'))
  ) STORED;

-- Name search (the staff typeahead, the pipeline filter) can now hit ONE column
-- instead of concatenating two on every row.
CREATE INDEX IF NOT EXISTS idx_borrowers_full_name_lower ON borrowers (lower(full_name));

COMMENT ON COLUMN borrowers.full_name IS
  'THE borrower''s whole name, as one line — what every screen, email, term sheet, SharePoint folder, e-sign envelope and ClickUp card displays. Maintained by Postgres from first_name + middle_name + last_name + name_suffix, so it can never disagree with them. Read-only: to change the name, write the parts (the API splits a typed full name for you).';
