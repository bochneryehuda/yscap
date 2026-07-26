-- Fire-once guard for the "borrower signed — awaiting the lender's counter-signature"
-- milestone notification (task #41). The 60-second reconcile poller re-reads every
-- in-flight envelope, so without a stamp the loan officer + processor would be alerted
-- on EVERY tick while the package sits waiting for the admin counter-signature. The
-- webhook stamps this exactly once (UPDATE ... WHERE countersign_notified_at IS NULL
-- RETURNING) so exactly one reconcile pass wins and notifies.
ALTER TABLE esign_envelopes ADD COLUMN IF NOT EXISTS countersign_notified_at timestamptz;
