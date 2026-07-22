-- 226_sitewire_retainage_release_snapshot.sql — Snapshot the retainage pool at each release
-- (audit finding 2026-07-21). Prior behavior: /files/:id/retainage-release computed
-- `to_release = SUM(retainage_held_cents WHERE kind='draw') - SUM(net_release_cents WHERE
-- kind='retainage_release')` on every call. A retro-edit of an OLD draw's retainage_held_cents
-- (say, correcting a mistyped hold) shifted the pool AFTER PILOT had already wired money — the
-- ledger no longer showed what was held at the moment of the release, only the current
-- (edited) sum. Failure mode: on-the-fly totals disagree with the physical wire history, and
-- there's no audit trail of what the pool WAS when the release happened.
--
-- Adding `held_at_release_cents` (nullable) captures the sum-of-holds at the moment of the
-- release for every future kind='retainage_release' row. Reads that want the "held at that
-- time" number pull the snapshot; reads that want live current-hold still sum draws — but now
-- a discrepancy is VISIBLE and diffable, and the coordinator can see what was released against
-- what was held on the release date.
--
-- Idempotent (safe to re-run every boot). No backfill: pre-migration retainage_release rows
-- keep the column NULL, which reads correctly as "release predates the snapshot column".

ALTER TABLE draw_disbursements ADD COLUMN IF NOT EXISTS held_at_release_cents bigint;

-- Discoverability aid for the reconciliation report (uses no index today, but keep it cheap for
-- future joins that might filter releases by their held-at-release amount).
CREATE INDEX IF NOT EXISTS idx_disb_retrel_snapshot ON draw_disbursements (application_id, kind) WHERE kind='retainage_release';
