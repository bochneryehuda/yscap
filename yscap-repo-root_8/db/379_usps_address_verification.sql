-- 379 — official USPS address verification and enforced import condition.
-- Additive and idempotent. A lookup stages the USPS result; only the explicit
-- staff import action changes property_address and completes the condition.

CREATE TABLE IF NOT EXISTS usps_address_verifications (
  address_hash text PRIMARY KEY,
  input jsonb NOT NULL,
  standardized jsonb,
  dpv jsonb,
  status text NOT NULL,
  verified_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS usps_address_verifications_verified_at_idx
  ON usps_address_verifications (verified_at);

ALTER TABLE applications ADD COLUMN IF NOT EXISTS usps_address jsonb;
ALTER TABLE applications ADD COLUMN IF NOT EXISTS usps_match text;
-- Deliverability detail (DPVConfirmation Y/D/S/N + vacant/CMRA/business flags) of
-- the last check, so the verification screen can explain a result after a reload
-- without spending another USPS lookup against the hourly quota.
ALTER TABLE applications ADD COLUMN IF NOT EXISTS usps_dpv jsonb;
ALTER TABLE applications ADD COLUMN IF NOT EXISTS usps_verified_at timestamptz;
ALTER TABLE applications ADD COLUMN IF NOT EXISTS usps_imported_at timestamptz;
CREATE INDEX IF NOT EXISTS applications_usps_verified_at_idx
  ON applications (usps_verified_at);

INSERT INTO checklist_templates
  (code, label, borrower_label, scope, audience, item_kind, role_scope, phase,
   sort_order, category, hint, borrower_hint, is_gate, is_milestone, tool_key,
   auto_apply, is_active, is_required, tpr_exclude)
VALUES
  ('usps_address_verification', 'USPS Address Verification', NULL,
   'application', 'staff', 'condition', 'processor', '1', 145, 'prior_to_docs',
   'Verify the subject property against the official USPS Addresses API and import the verified address. The condition stays open until the USPS address is imported.',
   NULL, true, false, 'usps_address_verification', 'always', true, true, false)
ON CONFLICT (code) DO UPDATE SET
  label=EXCLUDED.label, audience='staff', item_kind='condition',
  role_scope='processor', hint=EXCLUDED.hint, tool_key=EXCLUDED.tool_key,
  auto_apply='always', is_active=true, is_required=true, is_gate=true;

INSERT INTO checklist_items
  (template_id, scope, label, borrower_label, audience, item_kind, role_scope,
   phase, hint, borrower_hint, is_gate, is_milestone, sort_order, tool_key,
   clickup_field_id, tpr_exclude, created_by_kind, is_required, application_id)
SELECT t.id, t.scope, t.label, t.borrower_label, t.audience, t.item_kind,
       COALESCE(t.role_scope,'processor'), t.phase, t.hint, t.borrower_hint,
       true, false, COALESCE(t.sort_order,145), t.tool_key, t.clickup_field_id,
       COALESCE(t.tpr_exclude,false), 'system', true, a.id
  FROM applications a
 CROSS JOIN checklist_templates t
 WHERE t.code='usps_address_verification'
   AND a.deleted_at IS NULL
   AND a.status NOT IN ('withdrawn','cancelled')
   AND EXISTS (SELECT 1 FROM checklist_items x WHERE x.application_id=a.id)
   AND NOT EXISTS (SELECT 1 FROM checklist_items x
                    WHERE x.application_id=a.id AND x.template_id=t.id);

UPDATE checklist_items ci
   SET is_required=true, updated_at=now()
  FROM checklist_templates t
 WHERE ci.template_id=t.id AND t.code='usps_address_verification'
   AND ci.is_required IS DISTINCT FROM true;

-- Any ordinary change to the working property address invalidates the old USPS
-- stamp and reopens the condition. The import route changes usps_imported_at in
-- the same UPDATE, which identifies the intentional verified-address adoption.
CREATE OR REPLACE FUNCTION reopen_usps_verification_on_address_change()
RETURNS trigger AS $$
BEGIN
  IF NEW.property_address IS DISTINCT FROM OLD.property_address
     AND NEW.usps_imported_at IS NOT DISTINCT FROM OLD.usps_imported_at THEN
    NEW.usps_address := NULL;
    NEW.usps_match := NULL;
    NEW.usps_dpv := NULL;
    NEW.usps_verified_at := NULL;
    NEW.usps_imported_at := NULL;
    UPDATE checklist_items ci
       SET status='outstanding', signed_off_at=NULL, signed_off_by=NULL,
           reviewed_at=NULL, reviewed_by=NULL, waived_at=NULL, waived_by=NULL,
           override_at=NULL, override_by=NULL, override_reason=NULL,
           override_blocked_reason=NULL, updated_at=now()
      FROM checklist_templates t
     WHERE ci.application_id=NEW.id AND ci.template_id=t.id
       AND t.code='usps_address_verification';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_reopen_usps_verification_on_address_change ON applications;
CREATE TRIGGER trg_reopen_usps_verification_on_address_change
  BEFORE UPDATE OF property_address ON applications
  FOR EACH ROW EXECUTE FUNCTION reopen_usps_verification_on_address_change();
