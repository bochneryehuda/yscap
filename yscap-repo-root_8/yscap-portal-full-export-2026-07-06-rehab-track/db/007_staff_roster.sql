-- =====================================================================
-- 007_staff_roster.sql — make staff_users the single source of truth for
-- the team roster shown everywhere (site officer dropdown, ?lo branding,
-- portal assignment lists). Adds display/contact columns and seeds the
-- real YS Capital team so nothing is lost when the static lists are retired.
--
-- Idempotent: ADD COLUMN IF NOT EXISTS + INSERT ... ON CONFLICT DO UPDATE.
-- The upsert deliberately does NOT touch role / password_hash / full_name of
-- an existing row, so the bootstrapped super-admin (and anyone who has set a
-- password) keeps their identity and login.
-- =====================================================================

ALTER TABLE staff_users
  ADD COLUMN IF NOT EXISTS title       text,                 -- display title ("Loan Coordinator")
  ADD COLUMN IF NOT EXISTS department  text,                 -- 'sales' | 'operations'
  ADD COLUMN IF NOT EXISTS phone       text,                 -- direct line
  ADD COLUMN IF NOT EXISTS cell        text,
  ADD COLUMN IF NOT EXISTS ext         text,
  ADD COLUMN IF NOT EXISTS nmls        text,
  ADD COLUMN IF NOT EXISTS sort_order  integer NOT NULL DEFAULT 100;

CREATE INDEX IF NOT EXISTS idx_staff_roster
  ON staff_users (department, sort_order) WHERE is_active AND site_selectable;

-- ---- Seed the real team --------------------------------------------------
-- department 'sales' = borrower-facing loan officers/coordinators (shown in the
-- site's "select your loan officer"); 'operations' = back office (not shown to
-- borrowers, site_selectable=false, but assignable inside the portal).
INSERT INTO staff_users
  (email, full_name, role, title, department, phone, cell, ext, is_active, site_selectable, sort_order)
VALUES
  -- Sales & Loan Coordinators (site_selectable = true) -----------------------
  ('Yehuda@yscapgroup.com',   'Yehuda Bochner',       'super_admin',  'President',        'sales', NULL,           NULL,           NULL,  true, true, 10),
  ('Mendelb@yscapgroup.com',  'Mendel Bochner',       'loan_officer', 'Sales Manager',    'sales', NULL,           '929-454-2924', NULL,  true, true, 20),
  ('Solomon@yscapgroup.com',  'Solomon Katz',         'loan_officer', 'Loan Coordinator', 'sales', '718-247-8703', '845-324-3818', '103', true, true, 30),
  ('Yosef@yscapgroup.com',    'Yosef Cohen',          'loan_officer', 'Loan Coordinator', 'sales', '718-247-8704', '347-461-8924', '104', true, true, 40),
  ('Moshe@yscapgroup.com',    'Moshe Mermelstein',    'loan_officer', 'Loan Coordinator', 'sales', '718-247-8706', '929-214-7102', '106', true, true, 50),
  ('Shia@yscapgroup.com',     'Shia Kaff',            'loan_officer', 'Loan Coordinator', 'sales', '718-247-8707', '718-501-5654', '107', true, true, 60),
  ('Joshua@yscapgroup.com',   'Joshua Friedlander',   'loan_officer', 'Loan Coordinator', 'sales', '718-247-8708', '347-768-4596', '108', true, true, 70),
  ('Abraham@yscapgroup.com',  'Abraham Eisen',        'loan_officer', 'Loan Coordinator', 'sales', '718-307-4316', '347-324-7762', '116', true, true, 80),
  ('Mendel@yscapgroup.com',   'Mendel Schwimmer',     'loan_officer', 'Loan Coordinator', 'sales', '718-247-8759', '845-745-5595', '113', true, true, 90),
  ('Sol@yscapgroup.com',      'Solomon Weiss',        'loan_officer', 'Loan Coordinator', 'sales', '718-307-4314', '929-486-3939', '114', true, true, 100),
  ('Isaac@yscapgroup.com',    'Isaac Zadmehr',        'loan_officer', 'Loan Coordinator', 'sales', NULL,           '818-941-1437', NULL,  true, true, 110),
  ('Josef@yscapgroup.com',    'Josef Schnitzler',     'loan_officer', 'Loan Coordinator', 'sales', NULL,           '347-957-0738', NULL,  true, true, 120),
  ('Chaim@yscapgroup.com',    'Chaim Lebowitz',       'loan_officer', 'Loan Coordinator', 'sales', NULL,           '845-717-1641', NULL,  true, true, 130),
  ('Pinchus@yscapgroup.com',  'Pinchus Wieder',       'loan_officer', 'Loan Coordinator', 'sales', NULL,           '347-782-3357', NULL,  true, true, 140),
  ('Yisroel@yscapgroup.com',  'Yisroel Weinstock',    'loan_officer', 'Loan Coordinator', 'sales', NULL,           '929-475-3015', NULL,  true, true, 150),
  ('Simcha@yscapgroup.com',   'Simcha Shedrowitzky',  'loan_officer', 'Loan Coordinator', 'sales', NULL,           '929-276-5925', NULL,  true, true, 160),
  -- Operations & Back Office (site_selectable = false) -----------------------
  ('Esther@yscapgroup.com',   'Esther Bochner',       'admin',        'MLO & Operations Manager', 'operations', NULL, NULL, NULL, true, false, 210),
  ('Malky@yscapgroup.com',    'Malky Katz',           'processor',    'Closer & Funder Manager',  'operations', NULL, NULL, NULL, true, false, 220),
  ('Yonah@yscapgroup.com',    'Yonah Rapapaort',      'processor',    'Processing Manager',       'operations', NULL, NULL, NULL, true, false, 230),
  ('Goldy@yscapgroup.com',    'Goldy Rosenberg',      'processor',    'Senior Loan Processor',    'operations', NULL, NULL, NULL, true, false, 240),
  ('Ezra@yscapgroup.com',     'Ezra Green',           'processor',    'RTL Loan Processor',       'operations', NULL, NULL, NULL, true, false, 250),
  ('Sarah@yscapgroup.com',    'Sarah Amsel',          'processor',    'Loan Processor',           'operations', NULL, NULL, NULL, true, false, 260),
  ('Chaya@yscapgroup.com',    'Chaya Gruber',         'processor',    'Loan Setup',               'operations', NULL, NULL, NULL, true, false, 270),
  ('Lisa@yscapgroup.com',     'Lisa Katz',            'processor',    'Draw Coordinator',         'operations', NULL, NULL, NULL, true, false, 280)
ON CONFLICT (email) DO UPDATE SET
  title          = EXCLUDED.title,
  department     = EXCLUDED.department,
  phone          = EXCLUDED.phone,
  cell           = EXCLUDED.cell,
  ext            = EXCLUDED.ext,
  site_selectable= EXCLUDED.site_selectable,
  sort_order     = EXCLUDED.sort_order,
  updated_at     = now();
  -- NOTE: role, full_name, password_hash intentionally preserved on conflict.
