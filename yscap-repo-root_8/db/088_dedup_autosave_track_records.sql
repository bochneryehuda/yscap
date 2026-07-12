-- Reconcile the duplicate track_records the autosave-per-keystroke bug already
-- wrote (owner-directed, 2026-07-12 — "fix what else this issue caused").
--
-- Before the create-once (tool) + client_row_id idempotency (db/087) fixes,
-- typing an address saved a separate row for each fragment — "1305", "1305
-- Barbara", "1305 Barbara Avenue", "1305 Barbara Avenue Union". Those fragments
-- inflate the borrower's deal counts and, if a complete exit had already been
-- entered, can even auto-satisfy the experience condition. This collapses each
-- typing burst down to its final (longest) row.
--
-- SAFE BY CONSTRUCTION. The distinguishing signature of the bug is a CHAIN: one
-- final address with SEVERAL progressively-shorter prefixes of it, all written
-- seconds apart. A genuinely different deal whose address merely happens to
-- prefix another ("100 Oak Ave" vs "100 Oak Ave Unit 2") is only ONE prefix, not
-- a chain — so it is never touched. A row is deleted ONLY when every one of these
-- holds:
--   * unverified                 — a verified row is locked underwriting evidence
--   * portal-origin              — source_task_id IS NULL (ClickUp rows are
--                                  deduped by db/082; never touched here)
--   * its address is a STRICT PREFIX of a longer "keeper" on the same borrower
--   * created within 5 minutes of that keeper — one continuous typing burst
--   * every economic field is NULL or EQUAL to the keeper's (never contradicts it)
--   * that keeper absorbed >= 2 DISTINCT prefix-fragments — a real typing chain,
--     NOT a mere prefix pair (this is what makes an all-NULL, not-yet-priced real
--     deal that prefixes one other deal impossible to delete: a false delete
--     would require two or more real deals whose addresses strictly nest inside a
--     third, entered together — which does not happen)
--   * it has NO attached documents — a fragment holding evidence is never deleted
-- The final (longest) row in each chain is a prefix of nothing longer, so it
-- always survives and absorbs the chain. Idempotent: once collapsed there is
-- nothing left to match. Wrapped so an unexpected shape only WARNs — it can never
-- fail a boot migration.
DO $$
DECLARE n int;
BEGIN
  WITH tr AS (
    SELECT id, borrower_id, created_at,
      btrim(lower(coalesce(property_address->>'oneLine',
                           property_address->>'street',
                           property_address->>'line1', ''))) AS addr,
      purchase_price, sale_price, purchase_date, sale_date,
      rent_amount, rent_date, refi_amount, refi_date, rehab_amount
    FROM track_records
    WHERE COALESCE(is_verified, false) = false
      AND source_task_id IS NULL
  ),
  -- every (keeper, fragment) pair: fragment.addr is a strict prefix of keeper.addr,
  -- same borrower, same burst, fragment economics never contradict the keeper's.
  pairs AS (
    SELECT keep.id AS keep_id, dup.id AS dup_id
    FROM tr keep
    JOIN tr dup
      ON dup.borrower_id = keep.borrower_id
     AND dup.id <> keep.id
     AND dup.addr <> '' AND keep.addr <> ''
     AND length(dup.addr) < length(keep.addr)
     -- keep.addr starts with dup.addr; escape LIKE metachars in the fragment
     AND keep.addr LIKE replace(replace(replace(dup.addr, '\', '\\'), '%', '\%'), '_', '\_') || '%' ESCAPE '\'
     AND keep.created_at BETWEEN dup.created_at - interval '5 minutes'
                             AND dup.created_at + interval '5 minutes'
     AND (dup.purchase_price IS NULL OR dup.purchase_price = keep.purchase_price)
     AND (dup.sale_price     IS NULL OR dup.sale_price     = keep.sale_price)
     AND (dup.purchase_date  IS NULL OR dup.purchase_date  = keep.purchase_date)
     AND (dup.sale_date      IS NULL OR dup.sale_date      = keep.sale_date)
     AND (dup.rent_amount    IS NULL OR dup.rent_amount    = keep.rent_amount)
     AND (dup.rent_date      IS NULL OR dup.rent_date      = keep.rent_date)
     AND (dup.refi_amount    IS NULL OR dup.refi_amount    = keep.refi_amount)
     AND (dup.refi_date      IS NULL OR dup.refi_date      = keep.refi_date)
     AND (dup.rehab_amount   IS NULL OR dup.rehab_amount   = keep.rehab_amount)
  ),
  -- only a keeper that absorbed 2+ distinct fragments is a genuine typing chain
  chain_keepers AS (
    SELECT keep_id FROM pairs GROUP BY keep_id HAVING count(DISTINCT dup_id) >= 2
  ),
  losers AS (
    SELECT DISTINCT p.dup_id AS id
    FROM pairs p
    JOIN chain_keepers c ON c.keep_id = p.keep_id
  )
  DELETE FROM track_records t
   USING losers l
   WHERE t.id = l.id
     AND NOT EXISTS (SELECT 1 FROM documents d WHERE d.track_record_id = t.id);
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n > 0 THEN RAISE NOTICE 'db/088: collapsed % autosave-fragment track_records', n; END IF;
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'db/088 track_records dedup skipped (%): %', SQLSTATE, SQLERRM;
END $$;
