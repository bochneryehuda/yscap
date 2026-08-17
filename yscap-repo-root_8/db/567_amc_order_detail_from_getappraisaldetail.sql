-- ============================================================================
-- db/567 — the AppraisalScope order's DETAIL: who is doing it, when they are
--          going out, and what it costs.
--
-- WHAT THIS CHANGES, AND WHY. `GetAppraisalStatus` — the only lookup the poll
-- has ever run — answers one question: what STAGE is the order at (a code and a
-- name). Every question a person actually asks while an appraisal is pending is
-- answered by `GetAppraisalDetail`, which nothing has ever called: `cdg.buildGetDetail`
-- has been exported since this integration shipped with ZERO callers. So the
-- appraiser's name and phone number, the inspection date, the vendor's own due
-- date, and four separate fees the vendor states on every order were all being
-- thrown away, and the desk answered "no appraiser yet / no per-order fee" on an
-- order whose vendor record named both.
--
-- THE DATETIMES ARE TEXT, ON PURPOSE — do not "fix" them to timestamptz. The
-- vendor sends `"2021-05-07 16:58:19"` with NO timezone anywhere in the payload
-- or in their guide, and `lastUpdateDatetime` arrives in a third format again
-- (`"05/07/2021 04:58:19 pm"`). Storing them as an instant means picking a zone,
-- which is a guess printed as a fact. They are kept exactly as the vendor stated
-- them and shown that way. Only the DATE-ONLY fields (`YYYY-MM-DD`, unambiguous
-- in every zone) are real dates.
--
-- `vendor_due_date` IS NOT `need_by_date`. `need_by_date` is the date WE asked
-- for when placing the order; `vendor_due_date` is the vendor's own
-- `serviceNeedByDate` on their record of it — the ETA somebody is really asking
-- for, and it can differ from ours. Two columns because they are two facts.
--
-- The three fee columns db/480 already carries (job_fee, management_fee,
-- client_fee) are reused rather than duplicated; only the four this response
-- adds are new.
--
-- IDEMPOTENT: every statement is ADD COLUMN IF NOT EXISTS.
--
-- BACKFILL: NONE, deliberately. Every one of these columns is filled by the
-- next poll of a live order (the detail lookup runs beside the status lookup),
-- so an open order fills itself within one poll cycle. A CLOSED order is not
-- polled and stays blank — back-filling it would mean calling the vendor once
-- per historical order to populate a screen nobody is waiting on.
--
-- PRODUCT SEPARATION: RTL only. `amc_orders` is an RTL table and nothing here
-- touches `lt_*`.
-- ============================================================================

-- ---- WHO ------------------------------------------------------------------
-- The APPRAISER, never the AMC. Both ride in the same `deals[].appraisers[]`
-- array under different `partyRoleType`s, and telling a loan officer that the
-- management company is inspecting their property is worse than telling them
-- nothing — so the two roles get their own columns.
ALTER TABLE amc_orders ADD COLUMN IF NOT EXISTS appraiser_name        text;
ALTER TABLE amc_orders ADD COLUMN IF NOT EXISTS appraiser_company     text;
ALTER TABLE amc_orders ADD COLUMN IF NOT EXISTS appraiser_email       text;
ALTER TABLE amc_orders ADD COLUMN IF NOT EXISTS appraiser_phone       text;
ALTER TABLE amc_orders ADD COLUMN IF NOT EXISTS appraiser_city        text;
ALTER TABLE amc_orders ADD COLUMN IF NOT EXISTS appraiser_state       text;
ALTER TABLE amc_orders ADD COLUMN IF NOT EXISTS appraiser_license     text;
ALTER TABLE amc_orders ADD COLUMN IF NOT EXISTS amc_company           text;
ALTER TABLE amc_orders ADD COLUMN IF NOT EXISTS amc_license           text;
ALTER TABLE amc_orders ADD COLUMN IF NOT EXISTS amc_file_number       text;

-- ---- WHEN -----------------------------------------------------------------
-- Date-only (unambiguous in any zone) → real dates.
ALTER TABLE amc_orders ADD COLUMN IF NOT EXISTS vendor_due_date       date;
ALTER TABLE amc_orders ADD COLUMN IF NOT EXISTS inspection_date       date;
ALTER TABLE amc_orders ADD COLUMN IF NOT EXISTS vendor_completed_date date;
-- Datetimes with no timezone → stored verbatim as the vendor stated them.
ALTER TABLE amc_orders ADD COLUMN IF NOT EXISTS assigned_at_text            text;
ALTER TABLE amc_orders ADD COLUMN IF NOT EXISTS accepted_at_text            text;
ALTER TABLE amc_orders ADD COLUMN IF NOT EXISTS inspection_scheduled_at_text text;
ALTER TABLE amc_orders ADD COLUMN IF NOT EXISTS inspection_completed_at_text text;
ALTER TABLE amc_orders ADD COLUMN IF NOT EXISTS report_uploaded_at_text     text;
ALTER TABLE amc_orders ADD COLUMN IF NOT EXISTS vendor_updated_at_text      text;

-- ---- WHAT IT COSTS --------------------------------------------------------
-- job_fee / management_fee / client_fee already exist (db/480). `"0.00"` is a
-- real figure here, NOT an absence: `paid_amount = 0.00` beside
-- `due_amount = 450.00` is what "nothing has been paid yet" looks like.
ALTER TABLE amc_orders ADD COLUMN IF NOT EXISTS form_fee              numeric(12,2);
ALTER TABLE amc_orders ADD COLUMN IF NOT EXISTS due_amount            numeric(12,2);
ALTER TABLE amc_orders ADD COLUMN IF NOT EXISTS paid_amount           numeric(12,2);
ALTER TABLE amc_orders ADD COLUMN IF NOT EXISTS invoiced_amount       numeric(12,2);

-- ---- the audit trail ------------------------------------------------------
-- The exact response the figures above were read out of, and when it was read,
-- so "where did this appraiser's phone number come from?" is answerable.
ALTER TABLE amc_orders ADD COLUMN IF NOT EXISTS last_detail_response  jsonb;
ALTER TABLE amc_orders ADD COLUMN IF NOT EXISTS detail_polled_at      timestamptz;


-- ── after this lands ────────────────────────────────────────────────────────
-- The schema map (docs/schema/) describes the database these migrations build,
-- so this file makes it stale. CI refreshes it on this pull request by itself;
-- if you would rather do it by hand, with DATABASE_URL pointing at a database
-- built from these migrations:
--
--   npm run schema:snapshot     # refresh the inventory from the database
--   npm run schema:restamp      # re-stamp the map header (no database needed)
