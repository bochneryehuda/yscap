-- 481 — AMC (AppraisalScope / NAN) party mapping + the owner's form defaults.
--
-- THREE things this fixes, all owner-directed 2026-08-07 after the live-tenant audit:
--
-- 1. THE NOTE BUYER IS THEIR "LOAN OFFICER". NAN's tenant uses the AppraisalScope
--    Loan Officer slot for capital-partner routing — their list is literally
--    "Investor Blue Lake", "Investor Fidelis", "Investor CorrFirst". The owner:
--    "Our note buyer in our system needs to be mapped to the loan officer in their
--    system. They consider loan officers as note buyers."  So OUR employee loan
--    officer must NOT occupy that slot; it carries `applications.lender` instead.
--    The employee LO stays on our own order row for the audit trail.
--
-- 2. OUR PROCESSOR IS THEIR PROCESSOR. Same list, different slot — and their
--    processor list carries our real staff by name.
--
-- 3. THE FORM DEFAULTS. `amc_form_map` shipped EMPTY, so chooseForm() returned null
--    on every deal and nothing was ever auto-picked. The owner named the exact
--    products (see the seed below).
--
-- NEVER GUESS. Every row here is a value observed on the live tenant on 2026-08-07
-- and named by the owner. A note buyer with no row is REFUSED at order time, never
-- defaulted onto some other investor's routing — sending an appraisal to the wrong
-- capital partner is worse than not sending it. Same for a form: an unmapped deal
-- shows the full catalog and asks a human to pick.
--
-- THESE IDS ARE THE PRODUCTION TENANT'S. Ids are environment-specific (the audit's
-- rule: "never share IDs across UAT and production"), so every row carries an
-- `environment` and the resolver only ever reads rows matching the environment the
-- service is pointed at.

-- ---------------------------------------------------------------------------
-- 1. The form map gains the two dimensions the owner's rules actually key on.
--    `loan_purpose` collapses to Purchase/Refinance (that is the CDG field), so it
--    could never express "fix and flip" vs "bridge" — which is the whole basis of
--    the owner's choice between the "Completed Subject to (w/As Is Value)" forms
--    and the plain ones. `property_category` held a RAW label ("Condominium" vs
--    "Condo"), so it could not match reliably either; `property_key` holds the
--    repo's canonical key from property-type.propertyTypeKey().
-- ---------------------------------------------------------------------------
ALTER TABLE amc_form_map ADD COLUMN IF NOT EXISTS loan_type    text;
ALTER TABLE amc_form_map ADD COLUMN IF NOT EXISTS property_key text;
ALTER TABLE amc_form_map ADD COLUMN IF NOT EXISTS environment  text NOT NULL DEFAULT 'production';
ALTER TABLE amc_form_map ADD COLUMN IF NOT EXISTS product_name text;

COMMENT ON COLUMN amc_form_map.loan_type IS
  'RTL loan type (fix_and_flip / bridge / dscr / ground_up) or NULL = any. This is the dimension the owner''s form defaults key on.';
COMMENT ON COLUMN amc_form_map.property_key IS
  'Canonical property key from property-type.propertyTypeKey (sfr / condo / multi_2_4 / …) or NULL = any. Never a raw label.';

-- One default per (environment, loan_type, property_key) so a second seeding run,
-- or an admin adding a row, cannot silently create two competing defaults.
CREATE UNIQUE INDEX IF NOT EXISTS uq_amc_form_map_default
  ON amc_form_map(environment, COALESCE(loan_type,''), COALESCE(property_key,''), COALESCE(program,''))
  WHERE active AND priority = 10;

-- ---------------------------------------------------------------------------
-- 2. The owner's form defaults (live NAN tenant product ids, 2026-08-07).
--
--    "Completed Subject to (w/As Is Value)" = the deal needs an AS-IS value AND an
--    after-repair value — i.e. it has a scope of work. That is fix & flip.
--    The plain / "w/ 1007" forms = no scope of work, no ARV needed — bridge and DSCR
--    (the 1007 is the comparable rent schedule, which is what a rental exit wants).
--
--    GROUND UP IS DELIBERATELY NOT SEEDED. The owner named fix & flip, bridge and
--    DSCR; nobody said which form a ground-up build takes, and guessing it onto the
--    fix & flip form would order the wrong report. A ground-up deal gets no default
--    and the desk asks a human to pick from the full list.
-- ---------------------------------------------------------------------------
INSERT INTO amc_form_map (loan_type, property_key, product_code, product_name, priority, environment, note)
VALUES
  -- Needs As-Is + ARV (has a scope of work)
  ('fix_and_flip', 'sfr',       '56634', '1004 - Single Family Residence - Completed Subject to (w/As Is Value)', 10, 'production',
   'Owner-directed 2026-08-07: the default for any single-family RTL fix & flip.'),
  ('fix_and_flip', 'condo',     '56651', '1073 - Condo Interior - Completed Subject to (w/As Is Value)', 10, 'production',
   'Owner-directed 2026-08-07: condo fix & flip that needs As-Is plus ARV.'),
  ('fix_and_flip', 'multi_2_4', '56650', '1025 - Multifamily (2-4 units) - Completed Subject to (w/As Is Value)', 10, 'production',
   'Owner-directed 2026-08-07: 2-4 units that need As-Is plus ARV.'),
  -- No scope of work, no ARV
  ('bridge', 'sfr',       '55975', '1004 w/ 1007 - Single Family Residence', 10, 'production',
   'Owner-directed 2026-08-07: standard single-family bridge — no scope of work, no ARV.'),
  ('bridge', 'condo',     '56320', '1073 w/ 1007 - Condo', 10, 'production',
   'Owner-directed 2026-08-07: standard condo bridge — no ARV.'),
  ('bridge', 'multi_2_4', '55996', '1025 - Multi-Family (2-4 unit)', 10, 'production',
   'Owner-directed 2026-08-07: standard 2-4 unit.'),
  ('dscr',   'sfr',       '55975', '1004 w/ 1007 - Single Family Residence', 10, 'production',
   'Owner-directed 2026-08-07: single-family DSCR — same form as a standard bridge.'),
  ('dscr',   'condo',     '56320', '1073 w/ 1007 - Condo', 10, 'production',
   'Owner-directed 2026-08-07: condo DSCR.'),
  ('dscr',   'multi_2_4', '55996', '1025 - Multi-Family (2-4 unit)', 10, 'production',
   'Owner-directed 2026-08-07: 2-4 unit DSCR.')
ON CONFLICT DO NOTHING;

-- ---------------------------------------------------------------------------
-- 3. The party map: our note buyer -> their Loan Officer, our staff -> their
--    Processor. Modelled on sitewire_partner_links (the repo's existing
--    human-confirmed vendor-id map): a row here is a CONFIRMED binding, and the
--    absence of a row is a refusal, never a fallback.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS amc_party_map (
  id           bigserial PRIMARY KEY,
  kind         text NOT NULL CHECK (kind IN ('note_buyer', 'processor')),
  -- For 'note_buyer': normNoteBuyer(applications.lender) — lowercase, non-alphanumerics
  -- stripped. Several aliases may point at one amc_id (the vendor's real label is
  -- often longer than ours: "Fidelis" vs "Fidelis Investors LLC").
  -- For 'processor': the same normalization of the staff member's full name.
  pilot_key    text NOT NULL,
  staff_id     uuid REFERENCES staff_users(id) ON DELETE CASCADE,  -- processor rows may pin a person
  amc_id       text NOT NULL,                                      -- their GetLoanOfficer / GetProcessor id
  amc_name     text,                                               -- their label, for display + drift detection
  environment  text NOT NULL DEFAULT 'production',
  active       boolean NOT NULL DEFAULT true,
  confirmed_by uuid REFERENCES staff_users(id) ON DELETE SET NULL,
  note         text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);
-- One active binding per (kind, key, environment) — an ambiguous map must be
-- impossible, because the resolver refuses rather than picking one.
CREATE UNIQUE INDEX IF NOT EXISTS uq_amc_party_map_key
  ON amc_party_map(kind, pilot_key, environment) WHERE active;
CREATE INDEX IF NOT EXISTS idx_amc_party_map_staff
  ON amc_party_map(staff_id) WHERE staff_id IS NOT NULL;

-- Our note buyers -> their "Investor …" loan-officer rows (live tenant, 2026-08-07).
-- Aliases are enumerated, never fuzzy-matched: normNoteBuyer is EXACT by design
-- (a loose match here would route an appraisal to another capital partner).
INSERT INTO amc_party_map (kind, pilot_key, amc_id, amc_name, environment, note) VALUES
  ('note_buyer', 'bluelake',            '201564', 'Investor Blue Lake', 'production', 'Live tenant 2026-08-07.'),
  ('note_buyer', 'bluelakecapital',     '201564', 'Investor Blue Lake', 'production', 'Alias of Blue Lake.'),
  ('note_buyer', 'bluelakecapitalllc',  '201564', 'Investor Blue Lake', 'production', 'Alias of Blue Lake.'),
  ('note_buyer', 'corrfirst',           '199439', 'Investor CorrFirst', 'production', 'Live tenant 2026-08-07.'),
  ('note_buyer', 'fidelis',             '199451', 'Investor Fidelis',   'production', 'Live tenant 2026-08-07.'),
  ('note_buyer', 'fidelisinvestors',    '199451', 'Investor Fidelis',   'production', 'Alias — the owner''s ClickUp label.'),
  ('note_buyer', 'fidelisinvestorsllc', '199451', 'Investor Fidelis',   'production', 'Alias — the owner''s ClickUp label.'),
  ('note_buyer', 'fidelisinvestmentsllc','199451','Investor Fidelis',   'production', 'Alias — the db/151 Sitewire spelling.'),
  ('note_buyer', 'rcn',                 '199684', 'Investor Commercial Lender/ RCN', 'production', 'Live tenant 2026-08-07.'),
  ('note_buyer', 'rcncapital',          '199684', 'Investor Commercial Lender/ RCN', 'production', 'Alias of RCN.')
ON CONFLICT DO NOTHING;

-- NOTE — EMCAP, Temple View and Churchill are note buyers in PILOT and have NO row
-- on the live tenant's loan-officer list. That is deliberate, not an omission: an
-- order on one of those files is REFUSED with "no confirmed AppraisalScope routing
-- for this note buyer" until somebody adds the binding. Do not add a fallback.

-- Our processors -> their processor rows, bound by name where the two systems
-- already agree. `staff_id` is filled from staff_users so a later rename on either
-- side is visible rather than silently unbinding.
INSERT INTO amc_party_map (kind, pilot_key, amc_id, amc_name, environment, note) VALUES
  ('processor', 'lisakatz',         '201324', 'Lisa Katz',         'production', 'Live tenant 2026-08-07.'),
  ('processor', 'malkykatz',        '199617', 'Malky Katz',        'production', 'Live tenant 2026-08-07.'),
  ('processor', 'estherbochner',    '199620', 'Esther Bochner',    'production', 'Live tenant 2026-08-07.'),
  ('processor', 'yehudabochner',    '199616', 'Yehuda Bochner',    'production', 'Live tenant 2026-08-07.'),
  ('processor', 'chayagruber',      '199629', 'Chaya Gruber',      'production', 'Live tenant 2026-08-07.'),
  ('processor', 'ezragreen',        '199628', 'Ezra Green',        'production', 'Live tenant 2026-08-07.'),
  ('processor', 'goldyrosenberg',   '199627', 'Goldy Rosenberg',   'production', 'Live tenant 2026-08-07.'),
  ('processor', 'mendelschwimmer',  '199626', 'Mendel Schwimmer',  'production', 'Live tenant 2026-08-07.'),
  ('processor', 'brendafleischman', '203191', 'Brenda Fleischman', 'production', 'Live tenant 2026-08-07.'),
  ('processor', 'sarahamsel',       '202464', 'Sarah Amsel',       'production', 'Live tenant 2026-08-07.'),
  ('processor', 'yonahrapapaort',   '202465', 'Yonah Rapapaort',   'production', 'Live tenant 2026-08-07 (their spelling).'),
  ('processor', 'yonahrapaport',    '202465', 'Yonah Rapapaort',   'production', 'Alias — our spelling of the same person.'),
  ('processor', 'abrahameisen',     '199630', 'Abraham Eisen',     'production', 'Live tenant 2026-08-07.'),
  ('processor', 'josefschnitzler',  '199633', 'Josef Schnitzler',  'production', 'Live tenant 2026-08-07.'),
  ('processor', 'joshuafriedlander','199625', 'Joshua Friedlander','production', 'Live tenant 2026-08-07.'),
  ('processor', 'moshemermelstein', '199621', 'Moshe Mermelstein', 'production', 'Live tenant 2026-08-07.'),
  ('processor', 'shiakaff',         '199622', 'Shia Kaff',         'production', 'Live tenant 2026-08-07.'),
  ('processor', 'simchashedrowitzky','202406','Simcha Shedrowitzky','production','Live tenant 2026-08-07.'),
  ('processor', 'solomonweiss',     '199632', 'Solomon Weiss',     'production', 'Live tenant 2026-08-07.'),
  ('processor', 'solomonkatz',      '199618', 'Solomon Katz',      'production', 'Live tenant 2026-08-07.'),
  ('processor', 'yitzchakzadmehr',  '199631', 'Yitzchak Zadmehr',  'production', 'Live tenant 2026-08-07.'),
  ('processor', 'yosefcohen',       '199619', 'Yosef Cohen',       'production', 'Live tenant 2026-08-07.')
ON CONFLICT DO NOTHING;

-- Bind each processor row to the real staff member where the names already agree.
-- Fill-only: a row that is already bound is left alone.
UPDATE amc_party_map m
   SET staff_id = s.id, updated_at = now()
  FROM staff_users s
 WHERE m.kind = 'processor'
   AND m.staff_id IS NULL
   AND lower(regexp_replace(COALESCE(NULLIF(s.full_name,''), ''), '[^a-zA-Z0-9]', '', 'g')) = m.pilot_key;

-- ---------------------------------------------------------------------------
-- 4. Seed the live product catalog so the desk can offer the FULL form list today,
--    while OAuth is still failing at CoreLogic's gateway and no live GetJobType can
--    run. `amc_lookup_cache` is the same table the live lookups write to, so when
--    the credentials are fixed a real GetJobType simply REPLACES this snapshot —
--    there is no second source of truth and nothing to un-wire.
--    The owner: "You need to give a list of all the forms that are available at that
--    given time. Even if they add forms, it should be a list of all the forms."
-- ---------------------------------------------------------------------------
INSERT INTO amc_lookup_cache (lookup_type, subdomain, payload, fetched_at)
SELECT 'GetJobType', 'nan', $json$[
  {"id":"55974","name":"1004 - Single Family Residence"},
  {"id":"56634","name":"1004 - Single Family Residence - Completed Subject to (w/As Is Value)"},
  {"id":"55975","name":"1004 w/ 1007 - Single Family Residence"},
  {"id":"55996","name":"1025 - Multi-Family (2-4 unit)"},
  {"id":"56319","name":"1073 - Condo Interior/Exterior"},
  {"id":"56320","name":"1073 w/ 1007 - Condo"},
  {"id":"56065","name":"Commercial Income Property (71A)"},
  {"id":"55999","name":"Commercial Income Property (71B)"},
  {"id":"56012","name":"1004D - Appraisal Update"},
  {"id":"56013","name":"1004D - Completion Report / Final"},
  {"id":"56009","name":"1004D - Completion + Update"},
  {"id":"56649","name":"1004C - Manufactured - Completed Subject to (w/ As Is Value)"},
  {"id":"56669","name":"1007 - Comparable Rent Schedule"},
  {"id":"56650","name":"1025 - Multifamily (2-4 units) - Completed Subject to (w/As Is Value)"},
  {"id":"56651","name":"1073 - Condo Interior - Completed Subject to (w/As Is Value)"},
  {"id":"57393","name":"Short Term Rental Analysis Form ONLY"},
  {"id":"57790","name":"2000 - Field Review"},
  {"id":"57791","name":"2000A - Multi-Family Field Review"},
  {"id":"59341","name":"2006 - Standard Desk Review"}
]$json$::jsonb, now() - interval '100 years'
WHERE NOT EXISTS (SELECT 1 FROM amc_lookup_cache WHERE lookup_type='GetJobType' AND subdomain='nan');

-- The snapshot is stamped with an ANCIENT fetched_at on purpose: every freshness
-- check treats it as stale, so the first successful live GetJobType overwrites it
-- immediately and nobody mistakes a website scrape for an API answer.
