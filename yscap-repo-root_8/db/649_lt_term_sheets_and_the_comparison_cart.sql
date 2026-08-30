-- ============================================================================
-- db/649 — lt term sheets and the comparison cart
--
-- WHAT THIS CHANGES, AND WHY. The DSCR Pricing Engine could price a scenario and
-- draw a board, and there it stopped: nothing an officer could hand a borrower
-- came out of it. Every quote lived in one browser tab, so "send me that 7.125
-- again" meant re-running the search and hoping the market had not moved, and
-- comparing an option from one search against an option from another meant a
-- screenshot. Owner-directed 2026-08-30: *"they should be able to export
-- themselves term sheets … every term sheet that you export should have a term
-- sheet ID, and every loan officer can go to pull up a term sheet, put in the
-- term sheet ID, and pull up the exact scenario that was searched and all the
-- results that were displayed in real time."*
--
-- Three tables, and the split between them is the feature:
--
--   lt_term_sheet          — an ISSUED sheet. Written once, never updated: it is
--                            a promise about a moment, and a snapshot that can be
--                            edited afterwards makes the ID meaningless. A
--                            correction is a NEW row pointing at the old one
--                            through `supersedes`. Same append-never-mutate
--                            discipline as ppe/lock.js's frozen price build,
--                            and `snapshot_hash` is what lets a replay say out
--                            loud that the stored bytes still match.
--
--   lt_term_sheet_cart     — one OPEN cart per person. The comparison spans
--                            SEPARATE searches ("you go back into another search,
--                            you check another program of the other search"), so
--                            it cannot live in React state: a reload, a phone
--                            call or a second search would lose the officer's
--                            work. `anchor_position` is the one member every
--                            comparative figure is stated against ("you need to
--                            compare stuff to one thing").
--
--   lt_term_sheet_scenario — the MEMBERS, of a cart or of an issued sheet. Each
--                            member carries its OWN scenario, its own priced
--                            program and its own charges, because the whole point
--                            is that they came from different searches with
--                            different loan amounts, LTVs and prepay terms.
--                            `cart_id` points at either parent — the row moves
--                            from cart to sheet by re-pointing, so an issued
--                            sheet holds the exact members that were compared.
--
-- WHAT IS DELIBERATELY NOT STORED: the vendor's lender / investor / rate-sheet
-- strings. A term sheet is read back by a door a CLIENT may reach, and the hard
-- rule (CLAUDE.md rule 10) is that an investor name never reaches a borrower.
-- The projection in src/longterm/termsheet/snapshot.js drops them BEFORE the row
-- is written, so this table cannot leak what it was never given — the same
-- "build the payload FOR the client" defence routes/my-loans.js documents. The
-- staff-only fact ("which real investor was Diamond that day") is re-derived at
-- replay time from the program name, for a staff caller only.
--
-- IDEMPOTENT. CREATE TABLE / CREATE INDEX IF NOT EXISTS throughout, and every
-- foreign key is added inside a guarded DO block, exactly as db/634 does.
--
-- BACKFILL: none. Brand-new feature; there are no prior term sheets to migrate,
-- and nothing outside these three tables changes.
--
-- PRODUCT SEPARATION. lt_* only. Two cross-product references, both the
-- shared-identity crossing authorized in writing 2026-08-03 and recorded in
-- docs/LONG-TERM-AUTHORIZED-COPIES.md: `staff_users` (who issued it) and
-- `borrowers` (who it is for, read-only — Long-Term never writes that record).
-- Both are ON DELETE SET NULL, like EVERY identity link on the long-term side:
-- losing a person must never delete a document somebody was handed.
-- ============================================================================

-- ── the issued sheet ────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS lt_term_sheet (
    id                 UUID NOT NULL,
    -- 'TS-4K7P2M' — Crockford base32, no I/L/O/U, because this is read over the
    -- phone. Unique and case-folded by the index below.
    code               TEXT NOT NULL,
    -- Who it is for. Nullable on purpose: an officer prices for a prospect who
    -- has no borrower record yet, and refusing to issue a sheet until somebody
    -- creates one would make the feature useless on exactly the deals it is for.
    borrower_id        UUID,
    borrower_name      TEXT,
    created_by_staff   UUID,
    -- 'officer' | 'borrower'. Phase 1 only ever writes 'officer'; the column
    -- exists now so the borrower-facing build cannot need a migration to say
    -- who pressed the button.
    created_by         TEXT NOT NULL DEFAULT 'officer',
    -- 'borrowerPaid' | 'lenderPaid'. NEVER 'raw' — the CHECK is the last of the
    -- three defences (the route 422s it and the screen does not render the
    -- control), and it is the one that survives somebody writing a new caller.
    mode               TEXT NOT NULL,
    waive_lender_fees  BOOLEAN NOT NULL DEFAULT FALSE,
    kind               TEXT NOT NULL DEFAULT 'single',
    -- The five compensation figures as they RESOLVED for the issuing officer,
    -- with their provenance. Frozen because the officer's own settings can move
    -- tomorrow and this sheet must still explain its own arithmetic.
    comp_plan          JSONB NOT NULL DEFAULT '{}'::jsonb,
    -- The consumer-safe board, already projected. This is what a replay draws.
    snapshot           JSONB NOT NULL DEFAULT '{}'::jsonb,
    snapshot_hash      TEXT NOT NULL,
    -- A correction is a new sheet that points at the one it replaces.
    supersedes         UUID,
    -- When the VENDOR answered, not when the row was written: a sheet issued
    -- from a board somebody left open for an hour is an hour-old price, and the
    -- replay has to be able to say so.
    priced_at          timestamptz NOT NULL DEFAULT now(),
    expires_at         timestamptz NOT NULL,
    created_at         timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT lt_term_sheet_pkey PRIMARY KEY (id)
);

-- One code, ever. Case-insensitive because it is read aloud and typed back.
CREATE UNIQUE INDEX IF NOT EXISTS lt_term_sheet_code_uk
    ON lt_term_sheet (upper(code));

CREATE INDEX IF NOT EXISTS lt_term_sheet_staff_idx
    ON lt_term_sheet (created_by_staff, created_at DESC);

CREATE INDEX IF NOT EXISTS lt_term_sheet_borrower_idx
    ON lt_term_sheet (borrower_id, created_at DESC);

-- RAW CAN NEVER BE ISSUED. Dropped first and re-added, per the hygiene rule, so
-- replaying this file on a database that already has it is a no-op.
ALTER TABLE lt_term_sheet DROP CONSTRAINT IF EXISTS lt_term_sheet_mode_chk;
ALTER TABLE lt_term_sheet ADD CONSTRAINT lt_term_sheet_mode_chk
    CHECK (mode IN ('borrowerPaid', 'lenderPaid'));

ALTER TABLE lt_term_sheet DROP CONSTRAINT IF EXISTS lt_term_sheet_kind_chk;
ALTER TABLE lt_term_sheet ADD CONSTRAINT lt_term_sheet_kind_chk
    CHECK (kind IN ('single', 'comparison'));

ALTER TABLE lt_term_sheet DROP CONSTRAINT IF EXISTS lt_term_sheet_created_by_chk;
ALTER TABLE lt_term_sheet ADD CONSTRAINT lt_term_sheet_created_by_chk
    CHECK (created_by IN ('officer', 'borrower'));

-- ── the open cart ───────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS lt_term_sheet_cart (
    id               UUID NOT NULL,
    staff_id         UUID,
    -- Which member every comparative figure is stated against. Stored as the
    -- POSITION rather than a member id so that clearing and rebuilding the cart
    -- cannot leave the anchor pointing at a row that no longer exists.
    anchor_position  INTEGER NOT NULL DEFAULT 0,
    created_at       timestamptz NOT NULL DEFAULT now(),
    updated_at       timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT lt_term_sheet_cart_pkey PRIMARY KEY (id)
);

-- One open cart per person: "start comparison" twice is one cart, not two a
-- person cannot tell apart. NOT partial, deliberately: Postgres treats NULLs as
-- DISTINCT in a unique index, so the ownerless carts left behind by the SET NULL
-- below can pile up harmlessly — they are unreachable by every read, which are
-- all scoped `staff_id = <me>`.
CREATE UNIQUE INDEX IF NOT EXISTS lt_term_sheet_cart_staff_uk
    ON lt_term_sheet_cart (staff_id);

-- ── the members ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS lt_term_sheet_scenario (
    id          UUID NOT NULL,
    -- Either an lt_term_sheet_cart.id (still being assembled) or an
    -- lt_term_sheet.id (issued). No FK: the row legitimately points at two
    -- different tables across its life, and a constraint that can only name one
    -- of them would have to be dropped to let the member move — which is worse
    -- than none. `parent_kind` says which, and the two delete paths are the one
    -- writer's job (src/longterm/termsheet/store.js).
    cart_id     UUID NOT NULL,
    parent_kind TEXT NOT NULL DEFAULT 'cart',
    position    INTEGER NOT NULL,
    label       TEXT,
    -- THE FRAMING IS PER MEMBER, NOT PER SHEET (owner-directed 2026-08-30, on
    -- being shown that the two compensation positions cost the borrower the
    -- same money): *"let's say I want to give someone 3 offers: borrower-paid 2
    -- points and a par rate … lender paid and you're waiving him the two points
    -- so it's a higher rate and he doesn't pay the points … lender paid plus a
    -- point credit back … it's technically the same, but it's the way you
    -- phrase it and the way you lay it out."* So the compensation position and
    -- the fee waive are the OFFICER'S PRESENTATION CHOICE for that one option,
    -- and three offers on one sheet can legitimately be three framings of one
    -- economic deal. A sheet-level column alone could not express that.
    mode              TEXT NOT NULL DEFAULT 'lenderPaid',
    waive_lender_fees BOOLEAN NOT NULL DEFAULT FALSE,
    -- This member's OWN scenario and its own priced program + charges. The
    -- reason the comparison can span separate searches at all.
    scenario    JSONB NOT NULL DEFAULT '{}'::jsonb,
    program     JSONB NOT NULL DEFAULT '{}'::jsonb,
    charges     JSONB NOT NULL DEFAULT '{}'::jsonb,
    closing     JSONB NOT NULL DEFAULT '{}'::jsonb,
    -- When THIS member was priced. Members priced far apart are a legitimate
    -- comparison; pretending they were simultaneous is not, so the sheet says so.
    priced_at   timestamptz NOT NULL DEFAULT now(),
    created_at  timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT lt_term_sheet_scenario_pkey PRIMARY KEY (id)
);

CREATE UNIQUE INDEX IF NOT EXISTS lt_term_sheet_scenario_pos_uk
    ON lt_term_sheet_scenario (cart_id, position);

CREATE INDEX IF NOT EXISTS lt_term_sheet_scenario_parent_idx
    ON lt_term_sheet_scenario (cart_id, parent_kind, position);

ALTER TABLE lt_term_sheet_scenario DROP CONSTRAINT IF EXISTS lt_term_sheet_scenario_parent_chk;
ALTER TABLE lt_term_sheet_scenario ADD CONSTRAINT lt_term_sheet_scenario_parent_chk
    CHECK (parent_kind IN ('cart', 'sheet'));

-- RAW CAN NEVER BE ISSUED, ON A MEMBER EITHER. The sheet-level CHECK above
-- would not have covered this column, and a comparison member is exactly where
-- a second framing arrives.
ALTER TABLE lt_term_sheet_scenario DROP CONSTRAINT IF EXISTS lt_term_sheet_scenario_mode_chk;
ALTER TABLE lt_term_sheet_scenario ADD CONSTRAINT lt_term_sheet_scenario_mode_chk
    CHECK (mode IN ('borrowerPaid', 'lenderPaid'));

-- ── the two identity links (authorized 2026-08-03) ──────────────────────────
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'lt_term_sheet_staff_fkey') THEN
    ALTER TABLE lt_term_sheet ADD CONSTRAINT lt_term_sheet_staff_fkey
      FOREIGN KEY (created_by_staff) REFERENCES staff_users(id) ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'lt_term_sheet_borrower_fkey') THEN
    ALTER TABLE lt_term_sheet ADD CONSTRAINT lt_term_sheet_borrower_fkey
      FOREIGN KEY (borrower_id) REFERENCES borrowers(id) ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'lt_term_sheet_supersedes_fkey') THEN
    ALTER TABLE lt_term_sheet ADD CONSTRAINT lt_term_sheet_supersedes_fkey
      FOREIGN KEY (supersedes) REFERENCES lt_term_sheet(id) ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
  -- ⛔ ON DELETE SET NULL, LIKE EVERY IDENTITY LINK ON THE LONG-TERM SIDE.
  --
  -- The first cut of this file used CASCADE, with what reads like a good reason:
  -- a comparison cart is scratch, and one whose owner is gone is unreachable by
  -- every read anyway, since they are all scoped `staff_id = <me>`. db/634's
  -- header records the SAME argument being made about the investor groups, and
  -- `test-lt-loan-schema-db` correctly refusing it: the long-term side holds
  -- "losing a person never deletes a row" as ONE UNIFORM INVARIANT, and an
  -- invariant with a convenience exception is how invariants stop being
  -- believed. It caught this one too.
  --
  -- The unique index tolerates the orphans: `UNIQUE (staff_id)` treats NULLs as
  -- distinct, so any number of ownerless carts can sit there, invisible to every
  -- read, rather than one blocking the next.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'lt_term_sheet_cart_staff_fkey') THEN
    ALTER TABLE lt_term_sheet_cart ADD CONSTRAINT lt_term_sheet_cart_staff_fkey
      FOREIGN KEY (staff_id) REFERENCES staff_users(id) ON DELETE SET NULL ON UPDATE CASCADE;
  -- AND IT CONVERGES on a database that already applied the first cut. Every
  -- migration replays on every boot, but the guard above means a constraint that
  -- EXISTS is never revisited — so a database built while this said CASCADE
  -- would keep it for ever, and only the machine that ran the fix would be
  -- right. Keyed on the delete rule itself (`c` is CASCADE, `n` is SET NULL), so
  -- it is a no-op from the second boot; the NAME is kept, which is what makes it
  -- a repair rather than a second constraint (db/617's rule).
  ELSIF EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'lt_term_sheet_cart_staff_fkey' AND confdeltype <> 'n'
  ) THEN
    ALTER TABLE lt_term_sheet_cart DROP CONSTRAINT lt_term_sheet_cart_staff_fkey;
    ALTER TABLE lt_term_sheet_cart ADD CONSTRAINT lt_term_sheet_cart_staff_fkey
      FOREIGN KEY (staff_id) REFERENCES staff_users(id) ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;

-- ── after this lands ────────────────────────────────────────────────────────
-- The schema map (docs/schema/) describes the database these migrations build,
-- so this file makes it stale. CI refreshes it on this pull request by itself;
-- if you would rather do it by hand, with DATABASE_URL pointing at a database
-- built from these migrations:
--
--   npm run schema:snapshot     # refresh the inventory from the database
--   npm run schema:restamp      # re-stamp the map header (no database needed)
