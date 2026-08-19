-- ============================================================================
-- db/591 — elementix address profiles: the property behind a row
--
-- WHAT THIS CHANGES, AND WHY. The Elementix profile could show a person's
-- properties, loans and deeds, but a PROPERTY was a dead end: the owner asked
-- that "when you go into the property and open up that property, it should pull
-- from Elementix the details about that property — which moment it was taken
-- on, from which lender it was taken, where it was taken."
--
-- Most of that answer is already in the rows we hold and is joined locally at
-- no cost (see `recordDetail` in app-v2/src/lib/elementixRows.js). What is NOT
-- is the property's own record: who owns it TODAY, everyone who owned it
-- before, and every instrument ever recorded against it — including the
-- assignments, satisfactions, preforeclosures and mechanics liens that never
-- appear on a person's own tabs. Three tools answer that
-- (`get_address`, `get_address_ownership`, `get_address_transactions`); all
-- three have been on the CRM allowlist since it was written, under the comment
-- "Drill-ins from a profile row", and had no caller.
--
-- This is where their answers are kept. It mirrors `elementix_person_sections`
-- deliberately rather than inventing a second shape: one row per (address,
-- section), a jsonb payload, and the same honesty columns — a section that
-- FAILED writes a row saying so, so a screen re-reading the cache can never
-- turn "the vendor refused" into "this property has no owner".
--
-- WHY ITS OWN TABLE AND NOT `elementix_person_sections`. That table's key is a
-- PERSON id. An address uuid is also text, so the two would fit in one table
-- and a profile read would then be one bad WHERE away from picking up address
-- rows as if they were a person's. Two subjects, two tables.
--
-- IDEMPOTENT: every statement is IF NOT EXISTS and re-runs cleanly on boot.
--
-- BACKFILL: NONE, deliberately. Every row here costs a slot out of the
-- organisation's shared 1,000 requests an hour, so a property is read when
-- somebody asks for it and never on a sweep. An address nobody has opened
-- simply has no row, which reads as "not looked up yet" — not as "nothing
-- there".
--
-- PRODUCT SEPARATION: RTL. The Elementix CRM plane hangs off `leads` and
-- `borrowers`, both RTL. Nothing here is named `lt_*` or references one.
-- ============================================================================

-- One property, as Elementix knows it. `address_id` is the vendor's own uuid,
-- which is what every profile row already carries.
CREATE TABLE IF NOT EXISTS elementix_addresses (
  address_id    text PRIMARY KEY,
  address_full  text,
  city          text,
  county_name   text,
  state         text,
  zip_code      text,
  latitude      numeric(12,7),
  longitude     numeric(12,7),
  refreshed_at  timestamptz,
  refreshed_by  uuid REFERENCES staff_users(id) ON DELETE SET NULL,
  last_error    text,
  last_error_at timestamptz,
  first_seen_at timestamptz NOT NULL DEFAULT now()
);

-- One row per (address, section). `payload` holds the vendor's own rows; the
-- columns beside it are how a screen tells "we did not ask" from "we asked and
-- it refused" from "we asked and there are none" — three different answers that
-- must never render as the same empty table.
CREATE TABLE IF NOT EXISTS elementix_address_sections (
  address_id  text NOT NULL REFERENCES elementix_addresses(address_id) ON DELETE CASCADE,
  section     text NOT NULL,
  payload     jsonb,
  row_count   integer,
  truncated   boolean NOT NULL DEFAULT false,
  fetched_at  timestamptz NOT NULL DEFAULT now(),
  calls_spent integer NOT NULL DEFAULT 0,
  last_error  text,
  unverified  boolean NOT NULL DEFAULT false,
  PRIMARY KEY (address_id, section)
);

CREATE INDEX IF NOT EXISTS idx_elx_addr_sections_fetched
  ON elementix_address_sections (fetched_at);
