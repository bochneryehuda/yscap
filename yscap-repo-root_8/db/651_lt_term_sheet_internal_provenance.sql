-- ============================================================================
-- db/651 — the internal provenance behind a long-term term sheet
--
-- WHAT THIS CHANGES, AND WHY (owner-reported 2026-08-31: *"there is no place
-- where loan officers can go in and see the data when they put in the ID … see
-- exactly what the input was and what exactly they priced in the real program
-- and the real investors behind everything."*).
--
-- Half of that was already true and half was structurally impossible. The
-- SCENARIO — every figure the officer typed — has always been stored on the
-- member (`scenario`), so "what was the input" replays exactly. The INVESTOR
-- never has been: `snapshot.buildMember` names, in a comment, the four keys it
-- refuses to carry — `lender`, `investor`, `lenderId`, `rateSheetName` — because
-- the snapshot IS the client's document and CLAUDE.md rule 10 is that an
-- investor's name never reaches a client, in any form. That refusal is correct
-- and is not being reopened.
--
-- So the answer is a SECOND, INTERNAL record beside it, never inside it. This
-- column carries the vendor's own identity for one priced option — who funds it,
-- whose programme it really is, which rate sheet it came off, and the raw price
-- before our compensation — on the STAFF-side member row.
--
-- ⛔ WHY THIS COLUMN AND NOT A KEY ON `snapshot`. The snapshot is rendered by
-- `pdf.js`, replayed to whoever holds the code, and hashed as the proof of what
-- was sent. A key on it would be one careless projection away from a borrower's
-- document. `lt_term_sheet_scenario` is named in exactly one module
-- (`termsheet/store.js`) and read by two staff-gated doors, so the separation is
-- structural rather than a convention somebody has to remember.
--
-- BACKFILL: NONE, deliberately. Every sheet issued before today was built from a
-- board whose investor identity was never sent to the server, so there is
-- nothing to back-fill FROM — and inventing one would be worse than the blank:
-- the lookup screen says plainly that a sheet issued before this was recorded
-- carries no investor, which is the truth. Sheets are write-once (see
-- `store.js`), so nothing rewrites an old one either.
--
-- PRODUCT SEPARATION: Long-Term only — one `lt_*` table, no RTL table named.
-- ============================================================================

ALTER TABLE lt_term_sheet_scenario
  ADD COLUMN IF NOT EXISTS internal jsonb NOT NULL DEFAULT '{}'::jsonb;

COMMENT ON COLUMN lt_term_sheet_scenario.internal IS
  'STAFF-ONLY. The vendor''s own identity behind this priced option — investor, '
  'lender, their programme name, the rate sheet and the raw price. Never rendered '
  'on a document, never in the snapshot, never sent to a borrower or a TPO '
  '(CLAUDE.md rule 10). Empty on every sheet issued before db/651.';


-- ── after this lands ────────────────────────────────────────────────────────
-- The schema map (docs/schema/) describes the database these migrations build,
-- so this file makes it stale. CI refreshes it on this pull request by itself;
-- if you would rather do it by hand, with DATABASE_URL pointing at a database
-- built from these migrations:
--
--   npm run schema:snapshot     # refresh the inventory from the database
--   npm run schema:restamp      # re-stamp the map header (no database needed)
