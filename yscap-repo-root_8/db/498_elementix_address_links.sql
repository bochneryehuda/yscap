-- ============================================================================
-- 498 — THE VENDOR'S VIEW OF A PROPERTY, KEPT BESIDE THE CLAIM, PLUS THE CACHE.
--
-- Owner-directed 2026-08-09: a "search on public records" button that pulls the
-- borrower's properties. This is where the vendor's answer is recorded.
--
-- ── WHY A LINK TABLE AND NOT A COLUMN ON track_records ──────────────────────
-- The obvious shape is `track_records.elementix_address_id`. It is wrong twice:
--
--   1. ONE PROPERTY LEGITIMATELY MAPS TO MANY ROWS. A borrower who bought,
--      flipped, and later re-acquired the same house has two honest lines for it.
--      A single column on the claim row cannot hold that, and forcing it makes
--      the two lines fight over one id.
--   2. A VENDOR ID ON THE CLAIM ROW MAKES THE CLAIM LOOK CORROBORATED. The whole
--      point of this build is that the machine OBSERVES and a person DECIDES; a
--      column named `elementix_address_id` sitting next to `is_verified` reads,
--      to every future query and every future screen, as evidence. It is not
--      evidence — it is a pointer to a record that may describe someone else's
--      house.
--
-- The repo's established shape for exactly this is a link table with its own
-- confidence and its own human-confirmation state: `sitewire_property_links`
-- (db/131) and `llc_external_links` (db/495). Same pattern here.
--
-- ── match_evidence IS THE REASON, NOT A SCORE ───────────────────────────────
-- A bare confidence word ('near') tells a reviewer nothing they can act on. The
-- evidence carries BOTH address keys, BOTH parsed component sets, and WHICH RULE
-- fired, so the person deciding can see that the match turned on (say) a ZIP
-- agreeing while the unit was absent on one side. `key_snapshot` records the key
-- as it stood when the link was made: the address normalizers in this repo have
-- changed several times, and without a snapshot there is no way to tell a link
-- that is stale from one that was always wrong.
--
-- ── THE CACHE MAY ONLY EVER RECORD A DEFINITIVE ANSWER ──────────────────────
-- `address_canon_cache` (db/124) taught this the hard way, twice: a cached
-- non-answer is PERMANENT, so a provider outage or a rate-limit — which arrive as
-- an HTTP 200 body, not a thrown error — got written as "there is no such place"
-- and marked a real property unresolvable forever. Here the trap has an extra
-- mouth: `status='none'` from this vendor also means "several candidates were
-- equally good", which is not an absence of data at all.
--
-- So `status` is deliberately FOUR values, and only two of them are cacheable
-- facts about the property:
--   'found'      — one confident match. Cacheable.
--   'no_match'   — the vendor answered, about this address, and has nothing.
--                  Cacheable, but re-checked after `stale_after` (new
--                  construction does get added to public records).
--   'ambiguous'  — several equally good candidates. NOT an absence; a human
--                  question. Cached only so the same question is not re-bought.
--   'error'      — the vendor did not answer about this address at all
--                  (outage, rate limit, auth). MUST NOT be treated as knowledge.
--
-- `cacheable` is a GENERATED column rather than a rule in application code,
-- because the rule that must never be got wrong is better enforced where it
-- cannot be forgotten: a reader filters on it, and 'error' can never satisfy a
-- lookup no matter which module is asking.
--
-- Idempotent, additive. Reads nothing, writes nothing, deletes nothing.
-- ============================================================================

CREATE TABLE IF NOT EXISTS elementix_address_links (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  track_record_id      uuid NOT NULL REFERENCES track_records(id) ON DELETE CASCADE,
  source               text NOT NULL DEFAULT 'elementix',
  -- VERBATIM, exactly as the vendor returned it. Never parsed, never split,
  -- never used to construct another id.
  elementix_address_id text NOT NULL,

  -- What the vendor says this address IS, kept for display without a second call.
  external_address     jsonb,

  -- WHY we think these are the same property: both keys, both parsed component
  -- sets, and which rule fired. A reviewer can act on this; a score alone is
  -- not reviewable.
  match_evidence       jsonb,
  -- Our key AS IT STOOD when the link was made. The address normalizers here
  -- have changed several times; without this there is no way to tell a link
  -- that went stale from one that was always wrong.
  key_snapshot         text,
  confidence           text NOT NULL CHECK (confidence IN ('exact','near','rejected')),

  -- Born 'proposed'. Only a human moves it to 'confirmed' — the same rule
  -- llc_external_links and sitewire_partner_links apply, for the same reason:
  -- an over-match here attaches another person's property to this borrower.
  state                text NOT NULL DEFAULT 'proposed'
                       CHECK (state IN ('proposed','confirmed','rejected')),
  confirmed_by         uuid REFERENCES staff_users(id),
  confirmed_at         timestamptz,
  fetched_at           timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_elx_addr_link
  ON elementix_address_links(track_record_id, source, elementix_address_id);
CREATE INDEX IF NOT EXISTS idx_elx_addr_proposed
  ON elementix_address_links(track_record_id) WHERE state = 'proposed';
-- "Which of our lines did the vendor point at this property?" — the reverse
-- direction, needed to notice one vendor record claimed by two track-record rows.
CREATE INDEX IF NOT EXISTS idx_elx_addr_external
  ON elementix_address_links(source, elementix_address_id);

COMMENT ON TABLE elementix_address_links IS
  'db/498. A data vendor''s view of one track-record property, kept BESIDE the claim rather than '
  'as a column on it — one property legitimately maps to many rows, and a vendor id sitting next to '
  'is_verified reads as corroboration to every future query. Born ''proposed''; only a human confirms.';

COMMENT ON COLUMN elementix_address_links.match_evidence IS
  'Both address keys, both parsed component sets, and which rule fired. A reviewer acts on this; '
  'a bare confidence word is not reviewable.';

-- ── THE LOOKUP CACHE ────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS elementix_lookup_cache (
  query_key    text PRIMARY KEY,
  status       text NOT NULL CHECK (status IN ('found','no_match','ambiguous','error')),
  payload      jsonb,
  -- WHY the four statuses are not collapsed: see the header. 'error' is the
  -- vendor failing to answer; 'no_match' is the vendor answering "nothing here";
  -- 'ambiguous' is several equally good candidates, which is a human question
  -- rather than an absence of data.
  --
  -- GENERATED, not a rule in a module: the one thing that must never be got
  -- wrong is that an 'error' can never be read as knowledge, and enforcing it in
  -- the column means no reader can forget it.
  cacheable    boolean GENERATED ALWAYS AS (status IN ('found','no_match','ambiguous')) STORED,
  -- A negative is re-checked eventually — new construction does get added to
  -- public records. NULL = never goes stale (a confident match).
  stale_after  timestamptz,
  api_calls    int NOT NULL DEFAULT 1,
  fetched_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_elx_cache_usable
  ON elementix_lookup_cache(query_key) WHERE cacheable;

COMMENT ON TABLE elementix_lookup_cache IS
  'db/498. Cache only a DEFINITIVE answer. address_canon_cache (db/124) learned twice that a cached '
  'non-answer is permanent, and that a provider outage arrives as an HTTP 200 body rather than a '
  'thrown error — so it got stored as "there is no such place" and marked real properties '
  'unresolvable forever. Here ''error'' means the vendor never answered about this address and '
  '''ambiguous'' means several candidates tied; neither is an absence of data.';

COMMENT ON COLUMN elementix_lookup_cache.cacheable IS
  'GENERATED. False only for ''error''. A reader filters on this, so a vendor outage can never be '
  'read as knowledge no matter which module is asking.';
