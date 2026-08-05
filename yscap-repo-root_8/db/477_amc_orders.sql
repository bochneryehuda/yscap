-- ============================================================================
-- 477 — AMC appraisal ordering (AppraisalScope / CoreLogic Digital Gateway).
--
-- The first OUTBOUND appraisal-ordering integration. Today PILOT only INGESTS a
-- completed appraisal XML (src/lib/appraisal/desk.js runAppraisalImport); ordering
-- is a manual checklist task (rtl_p3_appr) + a stored payment card the back office
-- charges by hand. This adds the machinery to place the order directly with the AMC,
-- track its whole lifecycle, message the AMC back and forth, request revisions /
-- ROV reconsiderations, push and pull documents, and pull the finished report back
-- into the file automatically.
--
-- The vendor side is CoreLogic's Digital Gateway (CDG) "pull" integration in front
-- of AppraisalScope: everything is HTTPS POST that WE initiate, and CDG never pushes
-- to us — so status, comments, revisions and completed documents are all POLLED.
--
-- Modeled on the Sitewire draw integration (the read-write exemplar) and the
-- Encompass flood-order (db/377): isolated in src/amc/**, staged behind
-- AMC_ENABLED / AMC_OUTBOUND_ENABLED / AMC_DRYRUN (all default OFF), every write
-- journaled, nothing touches an existing table's behavior. RTL only.
--
-- These tables are ADDITIVE and idempotent; they auto-apply on boot and change no
-- existing behavior until the feature is wired and switched on.
-- ============================================================================

-- One row per appraisal order placed with the AMC (one loan can have several —
-- a primary CreateAppraisal plus AddForm children for extra forms).
CREATE TABLE IF NOT EXISTS amc_orders (
  id                    bigserial PRIMARY KEY,
  application_id        uuid NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
  -- The appraisal condition this order fulfils (rtl_p3_appr / rtl_cond_appraisaldocs),
  -- so placing / completing the order can nudge the condition. NULL until linked.
  checklist_item_id     uuid REFERENCES checklist_items(id) ON DELETE SET NULL,

  -- ---- our identifiers ----
  client_order_number   text,   -- ClientOrderNumber we send (our order #)
  client_reference_number text, -- ClientReferenceNumber (secondary ref)

  -- ---- AppraisalScope / CDG identifiers (from the ACK / lookups) ----
  cdg_order_number      text,   -- DigitalGatewayOrderNumber (e.g. CLGGL100417) — used as ?orderId= on updates
  sp_order_number       text,   -- ServiceProviderOrderNumber = AppraisalScope appraisal_id (used on order-specific actions)
  appraisal_file_number text,   -- deals[].properties[].appraisalIdentifier (AppraisalScope File Number)
  sp_subdomain          text,   -- ServiceProviderSubDomain the order was placed under

  -- ---- what was ordered ----
  request_action        text NOT NULL DEFAULT 'CreateAppraisal',  -- CreateAppraisal | AddForm
  parent_order_id       bigint REFERENCES amc_orders(id) ON DELETE SET NULL,  -- set on an AddForm child
  product_code          text,          -- the jobType / form id ordered (products[].productCode)
  subproduct_codes      text[],         -- add-on form ids (subproducts[].identifier)
  amc_identifier        text,          -- preferred AMC id (appraisers[partyRoleType="AMC"].identifier)
  form_description      text,          -- human product description returned by the AMC

  -- ---- lifecycle ----
  -- draft            = built in PILOT, not yet sent
  -- placing          = the CreateAppraisal call is in flight
  -- ordered          = accepted by the AMC (ACK), waiting to be worked
  -- in_process       = the AMC is working it (received / activated / in process)
  -- assigned         = assigned to an appraiser
  -- inspected        = inspection complete
  -- in_review        = under review at the AMC
  -- product_available= the report PDF is ready to pull (CDG 1990)
  -- completed        = we pulled the documents and ingested the appraisal
  -- on_hold          = the AMC placed it on hold
  -- cancelled        = the AMC cancelled it
  -- rejected         = the AMC rejected the order
  -- error            = a call failed (last_error explains); a human can retry
  status                text NOT NULL DEFAULT 'draft',
  status_code           text,          -- last CDG statusCode (e.g. 1990)
  status_name           text,          -- last CDG statusName (e.g. Vendor-ProductAvailable)
  status_description    text,          -- last CDG statusDescription (free-form vendor text)

  rush                  boolean NOT NULL DEFAULT false,   -- serviceExpediteType
  need_by_date          date,          -- serviceNeedByDate
  job_fee               numeric(12,2),
  management_fee        numeric(12,2),
  client_fee            numeric(12,2),

  -- ---- audit payloads ----
  request_payload       jsonb,         -- the exact CreateAppraisal/AddForm message we sent
  ack_response          jsonb,         -- the ACK the AMC returned
  last_status_response  jsonb,         -- the newest GetAppraisalStatus / GetAppraisalDetail response
  last_error            text,
  dryrun                boolean NOT NULL DEFAULT false,   -- placed while AMC_DRYRUN was on (nothing really sent)

  ordered_by            uuid REFERENCES staff_users(id) ON DELETE SET NULL,
  created_at            timestamptz NOT NULL DEFAULT now(),
  ordered_at            timestamptz,
  completed_at          timestamptz,
  last_polled_at        timestamptz,
  updated_at            timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_amc_orders_app
  ON amc_orders(application_id, created_at DESC);
-- The poll worker drains orders that are live at the AMC (anything not terminal).
CREATE INDEX IF NOT EXISTS idx_amc_orders_open
  ON amc_orders(status)
  WHERE status IN ('ordered','in_process','assigned','inspected','in_review','product_available','on_hold');
-- One PILOT order row per AppraisalScope appraisal_id.
CREATE UNIQUE INDEX IF NOT EXISTS uq_amc_orders_sp_order
  ON amc_orders(sp_order_number) WHERE sp_order_number IS NOT NULL;


-- The two-way message thread between PILOT and the AMC on an order.
-- Outbound = we sent it (AddComment). Inbound = the AMC's, pulled by GetComments.
CREATE TABLE IF NOT EXISTS amc_order_comments (
  id             bigserial PRIMARY KEY,
  order_id       bigint NOT NULL REFERENCES amc_orders(id) ON DELETE CASCADE,
  direction      text NOT NULL,          -- 'outbound' | 'inbound'
  amc_comment_id text,                   -- CDG commentId (dedupe key for inbound)
  body           text NOT NULL,          -- requestCommentText
  author_name    text,                   -- requestCommentContactFullName (inbound) / staff name (outbound)
  staff_id       uuid REFERENCES staff_users(id) ON DELETE SET NULL,  -- outbound author
  amc_datetime   text,                   -- requestCommentTextDatetime as the AMC stated it
  read_at        timestamptz,            -- when a staffer marked an inbound message read
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_amc_comments_order
  ON amc_order_comments(order_id, created_at);
-- Dedupe pulled AMC comments so re-polling never double-inserts.
CREATE UNIQUE INDEX IF NOT EXISTS uq_amc_comments_amc_id
  ON amc_order_comments(order_id, amc_comment_id) WHERE amc_comment_id IS NOT NULL;


-- Revisions: general revision requests, ROV (reconsideration of value) disputes,
-- and scope-of-work-change requests. All ride the AMC's AddRevision primitive; the
-- KIND + structured detail live here so PILOT owns the ROV workflow and audit trail.
CREATE TABLE IF NOT EXISTS amc_order_revisions (
  id              bigserial PRIMARY KEY,
  order_id        bigint NOT NULL REFERENCES amc_orders(id) ON DELETE CASCADE,
  kind            text NOT NULL DEFAULT 'revision',  -- 'rov' | 'revision' | 'sow_change' | 'other'
  amc_revision_id text,                              -- CDG revisionId from the AddRevision ACK
  body            text NOT NULL,                     -- revisedRequestCommentText we sent (the narrative)
  -- draft | submitted | acknowledged | in_review | resolved | denied | withdrawn
  status          text NOT NULL DEFAULT 'draft',
  -- Structured ROV detail: the disputed values + the supporting comps pulled from
  -- the Property Research Center, so the reconsideration is reproducible + auditable.
  rov_detail      jsonb,
  created_by      uuid REFERENCES staff_users(id) ON DELETE SET NULL,
  submitted_at    timestamptz,
  resolved_at     timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_amc_revisions_order
  ON amc_order_revisions(order_id, created_at);


-- Documents pushed to / pulled from an order. Outbound = we uploaded it
-- (UploadDocument / UploadDocumentMulti / UploadContract / on CreateAppraisal).
-- Inbound = the AMC returned it (RetriveAppraisalDocuments) and we filed it in the
-- Document Center (documents.id).
CREATE TABLE IF NOT EXISTS amc_order_documents (
  id              bigserial PRIMARY KEY,
  order_id        bigint NOT NULL REFERENCES amc_orders(id) ON DELETE CASCADE,
  direction       text NOT NULL,          -- 'outbound' | 'inbound'
  document_id      uuid REFERENCES documents(id) ON DELETE SET NULL,  -- our Document Center row
  amc_document_id text,                   -- CDG documentId (dedupe key for inbound)
  document_type   text,                   -- embeddedFiles.documentType (e.g. 'Appraisal Document','Sales Contract')
  object_name     text,                   -- filename
  object_description text,
  action          text,                   -- the requestActionType this doc rode (UploadDocument / RetriveAppraisalDocuments / …)
  retrieval_url   text,                   -- the CDG getdocument URL / objectURL
  object_size     text,
  is_additional   boolean,                -- isAdditionalDocument
  status          text NOT NULL DEFAULT 'pending',  -- pending | uploaded | retrieved | error
  last_error      text,
  raw             jsonb,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_amc_documents_order
  ON amc_order_documents(order_id, created_at);
-- Dedupe pulled AMC documents so re-polling never double-files.
CREATE UNIQUE INDEX IF NOT EXISTS uq_amc_documents_amc_id
  ON amc_order_documents(order_id, direction, amc_document_id) WHERE amc_document_id IS NOT NULL;


-- The polled status timeline for an order (GetAppraisalStatus history + vendor
-- notes-to-client). One row per distinct status event; dedupe_key keeps re-polling
-- from re-inserting the same event.
CREATE TABLE IF NOT EXISTS amc_status_events (
  id                 bigserial PRIMARY KEY,
  order_id           bigint NOT NULL REFERENCES amc_orders(id) ON DELETE CASCADE,
  status_code        text,
  status_name        text,
  status_condition   text,
  status_description text,
  event_datetime     text,               -- as stated by the AMC, when present
  dedupe_key         text NOT NULL,      -- hash of code+name+description+datetime
  raw                jsonb,
  created_at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_amc_status_events_order
  ON amc_status_events(order_id, created_at);
CREATE UNIQUE INDEX IF NOT EXISTS uq_amc_status_events_dedupe
  ON amc_status_events(order_id, dedupe_key);


-- Cached lookups (GetJobType / Get_JobTypes_By_LoanType forms, GetLoanType,
-- GetPropertyType, GetAMCPreference, GetLoanOfficer, …). One row per (lookup, env);
-- refreshed periodically so the order form dropdowns and form-selection run offline.
CREATE TABLE IF NOT EXISTS amc_lookup_cache (
  id          bigserial PRIMARY KEY,
  lookup_type text NOT NULL,             -- the requestActionType (e.g. 'GetJobType')
  subdomain   text NOT NULL DEFAULT '',  -- per-environment (ServiceProviderSubDomain)
  payload     jsonb NOT NULL,            -- the parsed responseData rows
  fetched_at  timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_amc_lookup_cache
  ON amc_lookup_cache(lookup_type, subdomain);


-- The form-selection mapping: which AppraisalScope form (productCode) + add-ons +
-- preferred AMC to use for a given RTL deal shape. Admin-editable; the most specific
-- ACTIVE row (lowest priority number) that matches wins, with a default fallback row.
CREATE TABLE IF NOT EXISTS amc_form_map (
  id               bigserial PRIMARY KEY,
  program          text,                 -- RTL program (bridge / ground_up / fix_and_flip / …) or NULL = any
  property_category text,                -- SFR / Multi 2-4 / Condo / … or NULL = any
  loan_purpose     text,                 -- purchase / refinance / … or NULL = any
  product_code     text NOT NULL,        -- the AppraisalScope jobType id to order
  subproduct_codes text[],               -- add-on form ids
  amc_identifier   text,                 -- preferred AMC id
  priority         int NOT NULL DEFAULT 100,   -- lower wins when several rows match
  active           boolean NOT NULL DEFAULT true,
  note             text,
  updated_by       uuid REFERENCES staff_users(id) ON DELETE SET NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_amc_form_map_match
  ON amc_form_map(active, priority);


-- The outbound write journal (mirrors clickup_write_log / sitewire_write_log):
-- every action we send to the AMC, masked, with the response and outcome — the
-- durable record of what PILOT did at the AMC.
CREATE TABLE IF NOT EXISTS amc_write_log (
  id               bigserial PRIMARY KEY,
  order_id         bigint REFERENCES amc_orders(id) ON DELETE SET NULL,
  application_id   uuid,
  action           text,                 -- the requestActionType
  request_summary  jsonb,                -- masked request (no api key / card / pii)
  response_summary jsonb,                -- masked response
  ok               boolean,
  error            text,
  staff_id         uuid REFERENCES staff_users(id) ON DELETE SET NULL,
  created_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_amc_write_log_order
  ON amc_write_log(order_id, created_at DESC);
