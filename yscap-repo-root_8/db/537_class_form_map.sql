-- 537 — Class Valuation product (form) auto-pick map.
--
-- The Class mirror of `amc_form_map` (db/480 + db/481). Class's "product" is what NAN
-- calls a "form", so the rule shape is identical — program / property category / loan
-- purpose / RTL strategy / property key -> the Class productId to order — and the
-- matcher (src/class/form-select.chooseProduct) is byte-for-byte the AMC one, so a rule
-- keyed the same way behaves the same on either desk.
--
-- SHIPS EMPTY, ON PURPOSE. `amc_form_map` shipped empty in db/480 and stayed inert until
-- db/481 seeded the 9 production form rows once the owner named the exact NAN products.
-- We have no Class product-id catalog from the owner yet, so this table has NO seed: with
-- no rows, chooseProduct() returns null and the order desk asks a human to pick from
-- Class's live product catalog — which is exactly today's behaviour, unchanged. When the
-- owner names the Class product ids, a later migration seeds the rows and the auto-pick
-- lights up with no code change.
--
-- Ids are environment-specific (the same audit rule the AMC map records: "never share
-- ids across UAT and production"), so every row carries an `environment` and the resolver
-- only ever reads rows matching the environment the Class service is pointed at.

CREATE TABLE IF NOT EXISTS class_form_map (
  id                bigserial PRIMARY KEY,
  program           text,                       -- RTL program (bridge / ground_up / fix_and_flip / …) or NULL = any
  property_category text,                       -- raw label (SFR / Multi 2-4 / Condo / …) or NULL = any
  loan_purpose      text,                       -- purchase / refinance / … or NULL = any
  loan_type         text,                       -- RTL STRATEGY (fix_and_flip / bridge / dscr / ground_up) or NULL = any
  property_key      text,                       -- canonical key from property-type.propertyTypeKey (sfr / condo / multi_2_4 / …) or NULL = any
  product_id        text NOT NULL,              -- the Class product id to order (their catalog id)
  product_name      text,                       -- their product label, for display
  priority          int NOT NULL DEFAULT 100,   -- lower wins when several rows match
  active            boolean NOT NULL DEFAULT true,
  environment       text NOT NULL DEFAULT 'production',
  note              text,
  updated_by        uuid REFERENCES staff_users(id) ON DELETE SET NULL,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_class_form_map_match
  ON class_form_map(active, priority);

-- One default per (environment, loan_type, property_key, program) so a second seeding
-- run — or an admin adding a row — cannot silently create two competing defaults, mirroring
-- uq_amc_form_map_default (db/481).
CREATE UNIQUE INDEX IF NOT EXISTS uq_class_form_map_default
  ON class_form_map(environment, COALESCE(loan_type,''), COALESCE(property_key,''), COALESCE(program,''))
  WHERE active AND priority = 10;
