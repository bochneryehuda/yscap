-- ============================================================================
-- LONG-TERM (LT) — db/547 — the Encompass milestone / status catalog.
--
-- The FIRST Long-Term migration. Creates one lt_* table and seeds it with the
-- Encompass milestone catalog (the "memory of the long-term side of Encompass").
-- It touches only lt_* tables — no RTL table, no foreign key across the line, no
-- function — so it is fully compliant with the two-product separation gate.
--
-- Source of truth for the shape: src/longterm/prisma/schema.prisma
--   (model LtEncompassMilestone). Keep the two in step.
-- Source of the seed data: the Encompass "Active Milestones" export (2026-08-14).
--
-- Idempotent (re-run safe on every boot): CREATE TABLE / INDEX IF NOT EXISTS, and
-- the seed upserts on the milestone_id primary key, only writing when a value
-- actually changed (so a boot re-run is a true no-op and updated_at never churns).
-- ============================================================================

CREATE TABLE IF NOT EXISTS lt_encompass_milestones (
  milestone_id        text        PRIMARY KEY,             -- Encompass's own id ("old ID"): integer-like or UUID, verbatim
  sequence            integer     NOT NULL,                -- pipeline order (1 = first)
  milestone_name      text        NOT NULL,                -- internal, staff-facing name
  role                text,                                -- assigned role, or NULL
  role_id             text,                                -- Encompass role id, verbatim, or NULL
  assignment_required boolean     NOT NULL,                -- must be assigned to that role to complete
  expected_days       integer     NOT NULL,                -- expected days at this milestone
  tpo_status          text        NOT NULL,                -- status shown to the TPO (broker)
  consumer_status     text        NOT NULL,                -- status shown to the borrower (consumer)
  is_archived         boolean     NOT NULL DEFAULT false,  -- Encompass archived flag
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS lt_encompass_milestones_sequence_idx
  ON lt_encompass_milestones (sequence);

INSERT INTO lt_encompass_milestones
  (milestone_id, sequence, milestone_name, role, role_id, assignment_required, expected_days, tpo_status, consumer_status, is_archived)
VALUES
  ('1',                                    1,  'Started',               NULL,               NULL, false, 0,  'Collecting Information', 'Collecting Information',                     false),
  ('99b6eeca-ab28-48ca-bcd4-9ed7ab18ab1c', 2,  'LO Prep',               'Loan Coordinator', '1',  true,  1,  'Application Received',   'Application Received',                       false),
  ('2',                                    3,  'Loan Setup',            'Loan Coordinator', '1',  true,  0,  'Loan Setup',             'Processing',                                 false),
  ('3',                                    4,  'Submittal',             'Loan Processor',   '5',  true,  2,  'Submitted',              'Submitted for Approval',                     false),
  ('3c34f220-44ec-412c-80a8-5f4dcf4b18d5', 5,  'Cond. Approval',        'Loan Processor',   '5',  false, 3,  'Cond. Approved',         'Submitted for Approval',                     false),
  ('af5ebaf4-7648-44d5-9475-8410d2da7819', 6,  'Processing',            'Loan Processor',   '5',  false, 2,  'Cond. Approved',         'Conditionally Approved',                     false),
  ('c5fcb17c-3ab1-4be7-8fc6-5533aee14249', 7,  'Waiting for Docs',      'Loan Processor',   '5',  false, 2,  'Cond. Approved',         'Conditionally Approved - Waiting for Docs',  false),
  ('80dcf250-3c95-4673-a726-160eec345f49', 8,  'Resubmittal',           'Loan Processor',   '5',  false, 2,  'In Underwriting',        'Condition Review',                           false),
  ('4',                                    9,  'Clear To Close',        'Loan Processor',   '5',  true,  2,  'Clear To Close',         'Final Approval',                             false),
  ('4c757816-3e85-460e-8d02-be747dd6e021', 10, 'Schedule Closing',      'Loan Coordinator', '1',  true,  1,  'Closing Scheduled',      'Closing Scheduled',                          false),
  ('e6896d81-2cf3-4b1d-8f4e-47e94d89f897', 11, 'Ready for Docs',        'Closer',           '7',  false, 2,  'Closing Scheduled',      'Closing Preparation',                        false),
  ('850dd7ea-6d0e-41fa-b979-d598aa9bac13', 12, 'Docs Out',              'Closer',           '7',  false, 1,  'Active Closing',         'Active Closing',                             false),
  ('1fa5ea4f-b5ce-4878-a2a5-3c4f892afb80', 13, 'Wire Order',            'Funder',           '8',  false, 0,  'Active Closing',         'Active Closing',                             false),
  ('6',                                    14, 'Funding',               'Funder',           '8',  true,  1,  'Funded',                 'Funded',                                     false),
  ('70367ac9-ec21-4be4-a548-8d5710eb6cee', 15, 'Investor Delivery',     'Post Closer',      '9',  false, 1,  'Funded',                 'Funded',                                     false),
  ('c6cf77b0-2156-42ef-91aa-2d5def0af3c3', 16, 'Purchasing Conditions', 'Post Closer',      '9',  false, 2,  'Funded',                 'Funded',                                     false),
  ('21a666b4-1868-44d8-a3d8-4beef4e22a4c', 17, 'Final Docs',            'Post Closer',      '9',  false, 0,  'Funded',                 'Funded',                                     false),
  ('6115d8b8-dae7-4924-a4c6-c94b22170391', 18, 'Closed',                'Post Closer',      '9',  false, 1,  'Funded',                 'Funded',                                     false),
  ('7',                                    19, 'Completion',            'Post Closer',      '9',  false, 30, 'Funded',                 'Funded',                                     false)
ON CONFLICT (milestone_id) DO UPDATE SET
  sequence            = EXCLUDED.sequence,
  milestone_name      = EXCLUDED.milestone_name,
  role                = EXCLUDED.role,
  role_id             = EXCLUDED.role_id,
  assignment_required = EXCLUDED.assignment_required,
  expected_days       = EXCLUDED.expected_days,
  tpo_status          = EXCLUDED.tpo_status,
  consumer_status     = EXCLUDED.consumer_status,
  is_archived         = EXCLUDED.is_archived,
  updated_at          = now()
WHERE (
  lt_encompass_milestones.sequence, lt_encompass_milestones.milestone_name, lt_encompass_milestones.role,
  lt_encompass_milestones.role_id, lt_encompass_milestones.assignment_required, lt_encompass_milestones.expected_days,
  lt_encompass_milestones.tpo_status, lt_encompass_milestones.consumer_status, lt_encompass_milestones.is_archived
) IS DISTINCT FROM (
  EXCLUDED.sequence, EXCLUDED.milestone_name, EXCLUDED.role,
  EXCLUDED.role_id, EXCLUDED.assignment_required, EXCLUDED.expected_days,
  EXCLUDED.tpo_status, EXCLUDED.consumer_status, EXCLUDED.is_archived
);
