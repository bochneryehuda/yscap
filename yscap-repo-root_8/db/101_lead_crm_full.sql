-- 101_lead_crm_full.sql — Full-fledged Lead CRM (owner-directed 2026-07-14).
-- Turns the thin marketing-capture `leads` table into a real CRM: structured
-- contact + deal fields, a typed activity timeline (calls/emails/meetings/notes),
-- per-lead tasks with due dates, file attachments, and a wider pipeline.
-- Every statement is idempotent (IF NOT EXISTS / guarded DO blocks) so it is safe
-- to re-run on every boot, and it backfills EXISTING leads (previous + future).

-- ---- 1. Rich contact + deal columns on leads -----------------------------
ALTER TABLE leads ADD COLUMN IF NOT EXISTS first_name        text;
ALTER TABLE leads ADD COLUMN IF NOT EXISTS last_name         text;
ALTER TABLE leads ADD COLUMN IF NOT EXISTS company           text;         -- LLC / entity
ALTER TABLE leads ADD COLUMN IF NOT EXISTS phone_alt         text;
ALTER TABLE leads ADD COLUMN IF NOT EXISTS contact_address   jsonb;        -- the lead's own address
ALTER TABLE leads ADD COLUMN IF NOT EXISTS property_address  jsonb;        -- subject property, if any
ALTER TABLE leads ADD COLUMN IF NOT EXISTS property_type     text;
ALTER TABLE leads ADD COLUMN IF NOT EXISTS program           text;
ALTER TABLE leads ADD COLUMN IF NOT EXISTS loan_amount       numeric(14,2);
ALTER TABLE leads ADD COLUMN IF NOT EXISTS lead_source       text;         -- channel: manual/website/referral/call/social/...
ALTER TABLE leads ADD COLUMN IF NOT EXISTS referral_partner  text;
ALTER TABLE leads ADD COLUMN IF NOT EXISTS tags              text[] NOT NULL DEFAULT '{}';
ALTER TABLE leads ADD COLUMN IF NOT EXISTS estimated_close   date;
ALTER TABLE leads ADD COLUMN IF NOT EXISTS lost_reason       text;
ALTER TABLE leads ADD COLUMN IF NOT EXISTS lost_at           timestamptz;
ALTER TABLE leads ADD COLUMN IF NOT EXISTS last_activity_at  timestamptz;
ALTER TABLE leads ADD COLUMN IF NOT EXISTS created_by_staff_id uuid REFERENCES staff_users(id) ON DELETE SET NULL;

-- ---- 2. Wider pipeline (keep every legacy value valid) -------------------
-- Legacy stages new/contacted/working/converted/archived stay valid; add
-- qualified, quoted, nurturing, and lost so the board reflects a real funnel.
DO $$
BEGIN
  ALTER TABLE leads DROP CONSTRAINT IF EXISTS leads_status_check;
  ALTER TABLE leads ADD CONSTRAINT leads_status_check
    CHECK (status IN ('new','contacted','qualified','quoted','working','nurturing','converted','lost','archived'));
END $$;

-- ---- 3. Backfill structured names + activity timestamp on old rows -------
-- Split the flat `name` into first/last only where first_name is still blank,
-- so re-runs never clobber a staffer's later edit.
UPDATE leads
   SET first_name = NULLIF(split_part(btrim(name), ' ', 1), ''),
       last_name  = NULLIF(btrim(substring(btrim(name) from position(' ' in btrim(name)) + 1)), '')
 WHERE first_name IS NULL AND name IS NOT NULL AND btrim(name) <> '';
UPDATE leads SET last_activity_at = COALESCE(last_activity_at, updated_at, created_at)
 WHERE last_activity_at IS NULL;
UPDATE leads SET lead_source = COALESCE(lead_source, source) WHERE lead_source IS NULL;

-- ---- 4. Typed activity timeline -----------------------------------------
-- One append-only log of everything that happens on a lead. `activity_type`
-- covers manual entries (call/email/sms/meeting/note) and automatic ones
-- (status_change/task/file/assignment/system). Mirrors the borrower_notes /
-- lead_notes shape, plus type + direction + occurred_at + meta.
CREATE TABLE IF NOT EXISTS lead_activities (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  lead_id       uuid NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  staff_id      uuid REFERENCES staff_users(id) ON DELETE SET NULL,
  activity_type text NOT NULL DEFAULT 'note'
                CHECK (activity_type IN ('call','email','sms','meeting','note','status_change','task','file','assignment','system')),
  direction     text CHECK (direction IN ('inbound','outbound')),
  subject       text,
  body          text,
  occurred_at   timestamptz NOT NULL DEFAULT now(),
  meta          jsonb,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_lead_activities_lead ON lead_activities(lead_id, occurred_at DESC);

-- Migrate legacy lead_notes forward into the timeline as 'note' rows, once.
-- The source note id is stamped in meta so a re-run is a no-op (idempotent).
INSERT INTO lead_activities (lead_id, staff_id, activity_type, body, occurred_at, created_at, meta)
SELECT ln.lead_id, ln.staff_id, 'note', ln.body, ln.created_at, ln.created_at,
       jsonb_build_object('migrated_from_note', ln.id)
  FROM lead_notes ln
 WHERE NOT EXISTS (
   SELECT 1 FROM lead_activities la
    WHERE la.meta->>'migrated_from_note' = ln.id::text);

-- ---- 5. Per-lead tasks (with due dates + assignee) -----------------------
CREATE TABLE IF NOT EXISTS lead_tasks (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  lead_id             uuid NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  title               text NOT NULL,
  body                text,
  due_at              timestamptz,
  done                boolean NOT NULL DEFAULT false,
  done_at             timestamptz,
  assignee_staff_id   uuid REFERENCES staff_users(id) ON DELETE SET NULL,
  created_by_staff_id uuid REFERENCES staff_users(id) ON DELETE SET NULL,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_lead_tasks_lead ON lead_tasks(lead_id, done, due_at);
CREATE INDEX IF NOT EXISTS idx_lead_tasks_open ON lead_tasks(assignee_staff_id, due_at) WHERE done = false;

-- ---- 6. Lead file attachments -------------------------------------------
-- Reuse the one document contract; a nullable lead_id lets a document belong to
-- a lead the same way it can belong to an application/borrower/llc.
ALTER TABLE documents ADD COLUMN IF NOT EXISTS lead_id uuid REFERENCES leads(id) ON DELETE CASCADE;
CREATE INDEX IF NOT EXISTS idx_documents_lead ON documents(lead_id) WHERE lead_id IS NOT NULL;
