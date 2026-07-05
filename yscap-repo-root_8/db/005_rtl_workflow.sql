-- =====================================================================
-- 005_rtl_workflow.sql
-- Internal RTL (Fix & Flip) file-processing workflow, seeded from the
-- YS Capital "RTL / Fix & Flip Loan Processing Guide".
--
-- Adds phase / role-scope / sign-off / per-item assignment to checklists,
-- seeds the full 5-phase loan-officer + processor checklist, and marks the
-- subset that must come FROM the borrower as audience='both' so it also
-- surfaces on the borrower portal.
-- Idempotent: safe to re-run.
-- =====================================================================

-- ---- Workflow columns on TEMPLATES ---------------------------------
ALTER TABLE checklist_templates
  ADD COLUMN IF NOT EXISTS phase         text,
  ADD COLUMN IF NOT EXISTS role_scope    text NOT NULL DEFAULT 'any'
      CHECK (role_scope IN ('loan_officer','processor','underwriter','any')),
  ADD COLUMN IF NOT EXISTS hint          text,
  ADD COLUMN IF NOT EXISTS is_gate       boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS is_milestone  boolean NOT NULL DEFAULT false;

-- ---- Workflow + sign-off columns on ITEMS --------------------------
ALTER TABLE checklist_items
  ADD COLUMN IF NOT EXISTS phase          text,
  ADD COLUMN IF NOT EXISTS role_scope     text NOT NULL DEFAULT 'any'
      CHECK (role_scope IN ('loan_officer','processor','underwriter','any')),
  ADD COLUMN IF NOT EXISTS hint           text,
  ADD COLUMN IF NOT EXISTS is_gate        boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS is_milestone   boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS sort_order     integer NOT NULL DEFAULT 100,
  ADD COLUMN IF NOT EXISTS assignee_staff_id uuid REFERENCES staff_users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS signed_off_by  uuid REFERENCES staff_users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS signed_off_at  timestamptz;

CREATE INDEX IF NOT EXISTS idx_checklist_app_order ON checklist_items(application_id, sort_order);
CREATE INDEX IF NOT EXISTS idx_checklist_assignee  ON checklist_items(assignee_staff_id);

-- ---- Route the existing generic seed to the DSCR (rental) track -----
-- so an RTL file gets ONLY the RTL set below and never double-lists.
UPDATE checklist_templates
   SET applies_loan_type = 'dscr'
 WHERE applies_loan_type IS NULL
   AND code IN ('gov_id','purchase_contract','scope_of_work','insurance_binder',
                'title_commitment','bank_statements','llc_docs','operating_agmt','voided_check');

-- Retire the two coarse LLC templates in favour of the 3 discrete ones below.
UPDATE checklist_templates SET is_active=false WHERE code IN ('llc_docs','operating_agmt');

-- =====================================================================
-- RTL APPLICATION CHECKLIST  (applies_loan_type='rtl')
-- audience: 'both' = also shown to the borrower; 'staff' = internal only.
-- role_scope: suggested owner (loan_officer runs intake/setup/numbers/attorney,
--             processor runs verifications & orders). Actual owner is the
--             application's loan_officer_id / processor_id or a per-item assignee.
-- =====================================================================
INSERT INTO checklist_templates
  (code, label, scope, audience, item_kind, applies_loan_type, role_scope, phase, sort_order, hint, is_gate, is_milestone) VALUES
-- Phase 1 — Borrower Intake
('rtl_p1_contract','Executed purchase contract','application','both','document','rtl','loan_officer','1',110,NULL,false,false),
('rtl_p1_id','Borrower photo ID (government-issued)','application','both','document','rtl','loan_officer','1',120,'Clear picture of a government ID',false,false),
('rtl_p1_llc','LLC documents received','application','both','document','rtl','loan_officer','1',130,'Certificate of Formation + IRS EIN letter + Operating Agreement — requested per LLC when linked',false,false),
('rtl_p1_ssn','SSN collected & saved to borrower profile','application','staff','task','rtl','loan_officer','1',140,'Collected once, reused across the borrower''s files',false,false),
('rtl_p1_addr','Primary address + occupancy & years captured','application','staff','task','rtl','loan_officer','1',150,'Rent / mortgage / own free & clear? How many years there?',false,false),
('rtl_p1_contact','Borrower phone + email on file','application','staff','task','rtl','loan_officer','1',160,NULL,false,false),
('rtl_p1_budget','Construction / rehab budget received','application','both','document','rtl','loan_officer','1',170,'Use the Rehab Budget tool on the Investor Suite',false,false),
('rtl_p1_arv','Borrower''s expected ARV received','application','both','condition','rtl','loan_officer','1',180,'The appraisal confirms the real ARV later',false,false),
('rtl_p1_titlec','Title contact email received','application','both','task','rtl','loan_officer','1',190,NULL,false,false),
('rtl_p1_insc','Insurance contact email received','application','both','task','rtl','loan_officer','1',200,NULL,false,false),
('rtl_p1_suite','Investor Suite link sent for Scope of Work','application','staff','task','rtl','loan_officer','1',210,'yscapgroup.com/suite — the appraiser must have the SOW',false,false),
('rtl_p1_pay','Appraisal payment method confirmed','application','staff','task','rtl','loan_officer','1',220,'Borrower''s card on hand, or a payment link is sent',false,false),
-- Phase 2 — File Setup
('rtl_p2_sp','SharePoint folders built first','application','staff','task','rtl','loan_officer','2',230,'LO folder → Borrower → Address → all doc subfolders',false,false),
('rtl_p2_cu','ClickUp task created — every starred* field filled','application','staff','task','rtl','loan_officer','2',240,'Address, borrower, DOB, SSN, phone, email, price, budget, ARV…',false,false),
('rtl_p2_enc','Encompass loan opened as Fix & Flip','application','staff','task','rtl','loan_officer','2',250,'Make sure the loan TYPE is right',false,false),
('rtl_p2_loprep','LO Prep shows nothing missing in Encompass','application','staff','task','rtl','loan_officer','2',260,NULL,false,false),
-- Phase 3 — Verifications & Orders
('rtl_p3_usps','USPS address verification completed','application','staff','task','rtl','processor','3',310,'Encompass → Services → Additional Services',false,false),
('rtl_p3_appr','Appraisal ordered through NAN','application','staff','task','rtl','processor','3',320,'SFR → 1004 · 2–4 family → 1025 · always "complete as-is"',false,true),
('rtl_p3_apprpay','Appraisal PAID','application','staff','task','rtl','processor','3',330,'Borrower''s card, or payment link sent and paid',false,false),
('rtl_p3_sow1','Completed Scope of Work received from borrower','application','both','document','rtl','processor','3',340,NULL,false,false),
('rtl_p3_sow2','SOW uploaded to appraiser + saved to SharePoint','application','staff','task','rtl','processor','3',350,'It MUST be in the appraisal report',false,false),
('rtl_p3_credit','Soft credit pull run in Xactus','application','staff','task','rtl','processor','3',360,'Full name + SSN + primary address — does not affect score',false,false),
('rtl_p3_credit2','Scores entered in Encompass + report saved','application','staff','task','rtl','processor','3',370,NULL,false,false),
('rtl_p3_titleord','Title order email sent — borrower NOT looped in','application','staff','task','rtl','processor','3',380,'Encompass → Print → Custom Forms → Order Services',false,true),
('rtl_p3_insord','Insurance order email sent — borrower CC''d','application','staff','task','rtl','processor','3',390,'Borrower must see the numbers',false,false),
('rtl_p3_fraud','Fraud / background report ordered','application','staff','task','rtl','processor','3',400,NULL,false,false),
('rtl_p3_fraud2','Variances cleared + report saved to SharePoint','application','staff','task','rtl','processor','3',410,NULL,false,false),
('rtl_p3_liq','Required liquidity pulled from the Fix & Flip sheet','application','staff','task','rtl','processor','3',420,NULL,false,false),
('rtl_p3_assets','Bank statements received & meet required liquidity','application','both','document','rtl','processor','3',430,'BlueLake file → TWO months of statements',false,false),
('rtl_p3_reo','REO / experience sheet completed & verified','application','both','document','rtl','processor','3',440,'LLC name, address, price, date per deal — use the Track Record tool; confirm owner of record',false,false),
-- Phase 4 — Appraisal Back, Check the Numbers
('rtl_p4_save','Appraisal saved to SharePoint','application','staff','task','rtl','loan_officer','4',450,NULL,false,true),
('rtl_p4_ltc','LTC checked against program guidelines','application','staff','condition','rtl','loan_officer','4',460,NULL,false,false),
('rtl_p4_ltv','LTV checked against program guidelines','application','staff','condition','rtl','loan_officer','4',470,NULL,false,false),
('rtl_p4_arv','ARV checked against program guidelines','application','staff','condition','rtl','loan_officer','4',480,NULL,false,false),
('rtl_p4_ir','Interest reserves checked / added if numbers allow','application','staff','condition','rtl','loan_officer','4',490,NULL,false,false),
('rtl_p4_ts','Term sheet generated — only after every number checks out','application','staff','condition','rtl','loan_officer','4',500,'Do not generate until LTC/LTV/ARV all pass',true,true),
-- Phase 5 — Attorney & Final Review
('rtl_p5_assign','Assignment letter (if the contract is assigned)','application','both','document','rtl','loan_officer','5',505,'Only required when the purchase is an assignment',false,false),
('rtl_p5_atty','Attorney email sent: "File ready for closing prep"','application','staff','task','rtl','loan_officer','5',510,'TeamAG@privatelenderlaw.com — attach term sheet, contract (+assignment), LLC docs, insurance invoice, ID',false,true),
('rtl_p5_titleinfo','Title contact GIVEN to attorney — not CC''d','application','staff','task','rtl','loan_officer','5',520,'Attorney opens their own chain with title',false,false),
('rtl_f_review','Final review requested','application','staff','condition','rtl','any','5',590,'Last approval step before CTC',true,true),
('rtl_f_ctc','CTC — Clear to Close received','application','staff','condition','rtl','any','5',600,NULL,true,true)
ON CONFLICT (code) DO NOTHING;

-- =====================================================================
-- RTL LLC DOCUMENT CHECKLIST (llc scope) — generated when an LLC is linked
-- to an application; uploads save against the LLC and are reused thereafter.
-- =====================================================================
INSERT INTO checklist_templates
  (code, label, scope, audience, item_kind, role_scope, sort_order, hint) VALUES
('rtl_llc_formation','LLC Certificate of Formation (formation state)','llc','both','document','loan_officer',10,'State formation documents'),
('rtl_llc_ein','LLC EIN letter (IRS)','llc','both','document','loan_officer',20,'IRS SS-4 / EIN confirmation letter'),
('rtl_llc_opagmt','LLC Operating Agreement','llc','both','document','loan_officer',30,NULL)
ON CONFLICT (code) DO NOTHING;
