-- ============================================================================
-- 585 — ELEMENTIX FOR THE CRM: per-officer connections, skip-trace capture,
--       and the cached "mega profile" every lead and borrower can carry.
--
-- ── WHAT CHANGED, AND WHY IT NEEDED A SECOND ELEMENTIX SHAPE ────────────────
-- Elementix arrived in PILOT as an UNDERWRITING tool: prove a borrower's track
-- record from recorded deeds and mortgages. That plane is deliberately walled
-- off from contact details — `docs/research/elementix/04-connector-verification.md`
-- states it plainly ("a contact detail may not appear in an underwriting
-- decision"), and that separation is not a style choice, it is the FCRA line.
--
-- The owner has now asked for the OTHER plane (2026-08-18): Elementix as a CRM
-- source — officers skip trace a person, call them, and work them as a lead.
-- That is marketing, not adverse action, and it is a legitimate second use of
-- the same seat. THE TWO PLANES MUST NOT MERGE. Nothing in this migration is
-- readable from the underwriting path: no table here is referenced by
-- track_record_*, checks.js, or any verification query, and the contact tables
-- below carry a comment saying so. If an underwriting query is ever seen
-- joining `elementix_contacts`, that is a bug, not a feature.
--
-- ── THE ATTRIBUTION PROBLEM, AND HOW IT IS ACTUALLY SOLVED ──────────────────
-- The owner wants each officer's skip traces to land in THAT officer's CRM.
-- Elementix's MCP surface has 40 tools and NOT ONE of them lists the account's
-- users, or lists which contacts were unlocked, or by whom. So attribution
-- cannot be pulled from the vendor. It is established from OUR side instead:
-- every officer connects their OWN Elementix login once (the `staff_id` scope
-- that `elementix_oauth` has supported since db/489 but that no route ever
-- offered), and from then on a skip trace made through PILOT is signed by the
-- officer whose token carried it. We do not ask the vendor who did it; we know,
-- because that officer authenticated as themselves.
--
-- That is also why the BACKFILL of already-unlocked contacts is an IMPORT here
-- rather than a sync: there is no tool to read the history from. The rows carry
-- a `source` so an imported unlock is never mistaken for one PILOT witnessed.
--
-- Idempotent; applied on every boot.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. THE OFFICER'S OWN ELEMENTIX IDENTITY
--
-- db/489 already carries `staff_id` on elementix_oauth (NULL = the company-wide
-- connection, a staff id = that officer's own). These columns record WHO that
-- token belongs to on the Elementix side, learned from the `welcome` tool, so
-- an admin screen can show "PILOT: Yehuda B  ↔  Elementix: yehuda" instead of
-- an opaque row. Recorded, never guessed: all four stay NULL until `welcome`
-- actually answers.
-- ---------------------------------------------------------------------------
ALTER TABLE elementix_oauth ADD COLUMN IF NOT EXISTS elx_user_label  text;
ALTER TABLE elementix_oauth ADD COLUMN IF NOT EXISTS elx_user_email  citext;
ALTER TABLE elementix_oauth ADD COLUMN IF NOT EXISTS elx_org_label   text;
ALTER TABLE elementix_oauth ADD COLUMN IF NOT EXISTS identity_at     timestamptz;
ALTER TABLE elementix_oauth ADD COLUMN IF NOT EXISTS identity_raw    jsonb;

-- ---------------------------------------------------------------------------
-- 2. THE PERSON — one row per Elementix person UUID.
--
-- The HEADER of the mega profile: who they are, which states they turn up in,
-- and the roll-up counts the profile page leads with. The per-tab detail lives
-- in elementix_person_sections below, so a refresh of one tab never rewrites
-- the whole profile and a huge deed list never sits in the same row as the
-- name.
--
-- `states` is an ARRAY because the owner's requirement is explicitly
-- cross-state ("You should pull the information of him from all the states
-- together and build everything in one profile"). Elementix keys a person by
-- (name, state), so one human is several person rows over there; `primary_person_id`
-- on the sibling rows points at the one we treat as canonical.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS elementix_persons (
  person_id         text PRIMARY KEY,            -- Elementix uuid, as given
  display_name      text,
  primary_state     text,
  states            text[] NOT NULL DEFAULT '{}',
  -- The roll-up the Overview tab shows: counts per section, mortgage exposure,
  -- negative remarks. A jsonb because the vendor's own overview is a loose
  -- shape and pinning it to columns would drop whatever they add next.
  summary           jsonb,
  -- Cross-state siblings: another elementix_persons.person_id we believe is the
  -- same human. NULL on the canonical row. Never set automatically from a name
  -- match alone — see elementix_person_aliases.
  primary_person_id text REFERENCES elementix_persons(person_id) ON DELETE SET NULL,
  first_seen_at     timestamptz NOT NULL DEFAULT now(),
  refreshed_at      timestamptz,
  refreshed_by      uuid REFERENCES staff_users(id) ON DELETE SET NULL,
  -- The last failure in plain words, so a stale profile can say why instead of
  -- silently showing old data.
  last_error        text,
  last_error_at     timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_elx_persons_name ON elementix_persons (lower(display_name));
CREATE INDEX IF NOT EXISTS idx_elx_persons_primary ON elementix_persons (primary_person_id)
  WHERE primary_person_id IS NOT NULL;

-- ---------------------------------------------------------------------------
-- 3. THE PROFILE SECTIONS — one row per (person, section, state).
--
-- Sections mirror the tabs on Elementix's own person page, which is what the
-- owner asked us to reproduce: Overview / Entities / Properties / Mortgages /
-- Deeds / Foreclosures, plus the three side panels (associated people, lender
-- network, cross-state) that feed the Overview.
--
-- `state` is part of the key so a section could one day be held per state.
-- IT IS WRITTEN AS '' TODAY, deliberately: the live schemas showed that a
-- person id already IS the state-scoped record, and that get_person_properties
-- has no state parameter at all — so "all the states together" is a merge over
-- person IDS (see elementix_person_aliases), not a state filter on one id. The
-- state therefore lives on elementix_persons; putting it in this key would let
-- one source grow a SECOND row for the same section the day its state became
-- known, leaving a stale copy behind to be merged in twice.
--
-- `payload` holds ROWS AS THE VENDOR GAVE THEM, normalised through shapes.js
-- where a shape exists. `row_count` is stored rather than derived so a count
-- tile does not have to unpack a large jsonb.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS elementix_person_sections (
  person_id   text NOT NULL REFERENCES elementix_persons(person_id) ON DELETE CASCADE,
  section     text NOT NULL CHECK (section IN (
                'overview','entities','properties','mortgages','deeds','foreclosures',
                'associated_people','lender_network','cross_state','transactions')),
  -- NULL means "not state-scoped" (a tool that takes only an id).
  state       text NOT NULL DEFAULT '',
  payload     jsonb,
  row_count   integer,
  -- TRUE when the vendor said there is more than we fetched, so the screen can
  -- say "showing the first N" instead of implying it has everything.
  truncated   boolean NOT NULL DEFAULT false,
  fetched_at  timestamptz NOT NULL DEFAULT now(),
  calls_spent integer NOT NULL DEFAULT 0,
  PRIMARY KEY (person_id, section, state)
);
CREATE INDEX IF NOT EXISTS idx_elx_sections_person ON elementix_person_sections (person_id, fetched_at DESC);
-- A section that FAILED is not a section that is EMPTY, and the difference has
-- to survive a page reload — otherwise a screen re-reading the cache renders
-- "0 mortgages" for a person whose mortgage tab the vendor refused to answer.
-- So a failed fetch writes a row too: payload NULL, row_count NULL, and the
-- reason in plain words. `unverified` carries crm-tools' own verdict (a tool
-- whose response shape we have never observed), so a screen can hedge an empty
-- section it cannot vouch for instead of asserting a confident zero.
ALTER TABLE elementix_person_sections ADD COLUMN IF NOT EXISTS last_error text;
ALTER TABLE elementix_person_sections ADD COLUMN IF NOT EXISTS unverified boolean NOT NULL DEFAULT false;


-- ---------------------------------------------------------------------------
-- 4. THE CONTACT — what a skip trace bought.
--
-- ONE ROW PER PERSON, holding every phone and every email with the vendor's own
-- labels, because the owner asked for "all the phone numbers available and
-- their names".
--
-- ** THIS TABLE IS CRM-ONLY. It must never be read by an underwriting query. **
-- Contact detail is the FCRA plane the verification blueprint walls off; it
-- exists here so an officer can telephone somebody, and for no other purpose.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS elementix_contacts (
  person_id     text PRIMARY KEY REFERENCES elementix_persons(person_id) ON DELETE CASCADE,
  -- [{value, label, type, status, carrier, ...}] exactly as the vendor labels
  -- them; the screen renders the labels rather than inventing its own.
  phones        jsonb NOT NULL DEFAULT '[]'::jsonb,
  emails        jsonb NOT NULL DEFAULT '[]'::jsonb,
  addresses     jsonb NOT NULL DEFAULT '[]'::jsonb,
  raw           jsonb,
  -- WHO bought it and WHEN. `unlocked_by` is NULL only for a row imported from
  -- a vendor export where the officer could not be resolved — never for one
  -- PILOT witnessed.
  unlocked_by   uuid REFERENCES staff_users(id) ON DELETE SET NULL,
  unlocked_at   timestamptz,
  -- pilot_skip_trace = PILOT spent the credit and watched it happen.
  -- already_unlocked = the person was already unlocked on the account when we
  --                    first looked, so nobody was charged and we cannot know who did it.
  -- imported        = loaded from a vendor export of past unlocks (db has no
  --                    other way to learn the history — see the header).
  source        text NOT NULL DEFAULT 'pilot_skip_trace'
                CHECK (source IN ('pilot_skip_trace','already_unlocked','imported')),
  refreshed_at  timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_elx_contacts_by ON elementix_contacts (unlocked_by, unlocked_at DESC);
COMMENT ON TABLE elementix_contacts IS
  'CRM-only contact detail from Elementix skip tracing. FCRA: never read this from an underwriting or track-record verification path.';

-- ---------------------------------------------------------------------------
-- 5. THE SKIP-TRACE EVENT — the thing that creates a CRM lead.
--
-- Separate from `elementix_calls` on purpose. That table is the MONEY LEDGER
-- and the monthly cap is counted from it; giving it a second writer and a
-- second meaning is how a cap stops being trustworthy. This records the
-- OUTCOME — which person, which officer, and which lead it became.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS elementix_skip_traces (
  id           bigserial PRIMARY KEY,
  person_id    text NOT NULL,
  staff_id     uuid REFERENCES staff_users(id) ON DELETE SET NULL,
  lead_id      uuid REFERENCES leads(id) ON DELETE SET NULL,
  borrower_id  uuid REFERENCES borrowers(id) ON DELETE SET NULL,
  person_name  text,
  state        text,
  source       text NOT NULL DEFAULT 'pilot_skip_trace'
               CHECK (source IN ('pilot_skip_trace','already_unlocked','imported')),
  -- What the officer typed as their reason. The paid route already demands one;
  -- keeping it here means "why did we spend this credit" survives next to the
  -- lead it produced.
  reason       text,
  charged      boolean NOT NULL DEFAULT false,
  -- The vendor's own catalogue calls submit_contact_enrichment a "contact lookup
  -- JOB", so an unlock is not necessarily finished when the call returns. A row
  -- therefore starts 'pending' and is settled by whoever sees it complete —
  -- either the few polls the click itself does, or the sweep. Without this the
  -- lead would be created holding an empty contact and nothing would ever go
  -- back for the answer we already paid for.
  status       text NOT NULL DEFAULT 'complete'
               CHECK (status IN ('pending','complete','failed')),
  detail       text,
  completed_at timestamptz,
  occurred_at  timestamptz NOT NULL DEFAULT now()
);
-- The sweep's work list: oldest first, and only rows still waiting.
CREATE INDEX IF NOT EXISTS idx_elx_skip_pending ON elementix_skip_traces (occurred_at)
  WHERE status = 'pending';
-- One row per (person, officer): re-opening somebody you already traced is not
-- a second skip trace and must not create a second lead.
CREATE UNIQUE INDEX IF NOT EXISTS uq_elx_skip_person_staff
  ON elementix_skip_traces (person_id, staff_id) WHERE staff_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_elx_skip_staff ON elementix_skip_traces (staff_id, occurred_at DESC);

-- ---------------------------------------------------------------------------
-- 6. LINKING A PERSON TO WHAT WE ALREADY HOLD
--
-- A CRM lead and a borrower profile each carry at most one Elementix person, so
-- this is a column on each rather than a link table. FILL-ONLY by every writer:
-- a link a human confirmed is never replaced by a later automatic guess.
-- ---------------------------------------------------------------------------
ALTER TABLE leads     ADD COLUMN IF NOT EXISTS elementix_person_id text;
ALTER TABLE borrowers ADD COLUMN IF NOT EXISTS elementix_person_id text;
CREATE INDEX IF NOT EXISTS idx_leads_elx_person     ON leads (elementix_person_id)     WHERE elementix_person_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_borrowers_elx_person ON borrowers (elementix_person_id) WHERE elementix_person_id IS NOT NULL;

-- A lead born from a skip trace is a real lead source, so the CRM's own filters
-- can see it. `leads.lead_source` is free text (db/101), so nothing to widen —
-- but the pipeline STATUS enum is constrained, and 'new' is already valid, so a
-- skip-traced lead starts there like any other.

-- ---------------------------------------------------------------------------
-- 7. CROSS-STATE ALIASES — the same human, filed under several person ids.
--
-- Elementix keys a person by (name, state). The owner wants one merged profile,
-- so we have to say which ids are the same person.
--
-- A LINK IS ONLY EVER WRITTEN BY A HUMAN. `get_person_cross_state` matches on
-- the EXACT NAME AND NOTHING ELSE — the vendor's own schema says so — which
-- means "the names match exactly" is not extra evidence on top of the vendor's
-- suggestion, it IS the vendor's suggestion restated. Auto-adopting on it would
-- merge a stranger's 829 properties into a borrower's profile, which is the
-- most expensive mistake this feature could make. Proven live 2026-08-18: MOTY
-- BRISK is three separate records (NJ, FL, PA), and the vendor also reports a
-- `nameCommonnessScore` precisely because a shared name is weak evidence.
-- `confirmed_by` NULL = suggested, not adopted.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS elementix_person_aliases (
  person_id       text NOT NULL,
  alias_person_id text NOT NULL,
  alias_state     text,
  alias_name      text,
  -- vendor_cross_state = get_person_cross_state offered it; manual = a human added it.
  origin          text NOT NULL DEFAULT 'vendor_cross_state'
                  CHECK (origin IN ('vendor_cross_state','manual')),
  confirmed_by    uuid REFERENCES staff_users(id) ON DELETE SET NULL,
  confirmed_at    timestamptz,
  rejected_by     uuid REFERENCES staff_users(id) ON DELETE SET NULL,
  rejected_at     timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (person_id, alias_person_id)
);
CREATE INDEX IF NOT EXISTS idx_elx_alias_open ON elementix_person_aliases (person_id)
  WHERE confirmed_at IS NULL AND rejected_at IS NULL;
