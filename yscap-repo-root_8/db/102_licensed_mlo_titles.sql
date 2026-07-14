-- Two sales-team members became licensed Mortgage Loan Originators
-- (owner-directed 2026-07-14): add the MLO designation to their display title
-- and record their individual NMLS number. This runs AFTER db/007 — which
-- re-seeds `title` on every boot via ON CONFLICT DO UPDATE but never touches
-- `nmls` — so this override wins for the title and durably sets the NMLS.
-- Idempotent: a plain UPDATE keyed on the roster email (case-insensitive).
UPDATE staff_users
   SET title = 'MLO & Loan Coordinator', nmls = '2723073', updated_at = now()
 WHERE lower(email) = 'shia@yscapgroup.com';

UPDATE staff_users
   SET title = 'MLO & Loan Coordinator', nmls = '2762861', updated_at = now()
 WHERE lower(email) = 'joshua@yscapgroup.com';
