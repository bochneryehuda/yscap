-- ============================================================================
-- db/600 — clear seeded per-file markup that only restated the company default
--
-- WHAT THIS CHANGES, AND WHY. The owner set the Standard and Silver markup to
-- 0.5 in the Pricing Admin Center and reported that every file still priced at
-- the old 0.4, and that "every single registration goes for an exception
-- because 0.4 and not 0.5".
--
-- Both symptoms are one root cause, reproduced before this was written. The
-- Term Sheet Studio's `seedAdminDefaults()` PAINTED the company default of the
-- day into the admin markup box, and a value in that box is — by every
-- downstream contract — an EXPLICIT PER-FILE OVERRIDE: the register path stores
-- it on `applications.file_markup_*_pct` (db/109). So every registration
-- silently FROZE that day's company default onto that file. Afterwards:
--   · `pricing.js buildInputs` re-applies the frozen number and `quoteProgram`
--     prefers it over the company default, so the file keeps pricing at 0.4
--     (measured on a real quote: 10.300% against 10.400%); and
--   · re-opening the studio restores 0.4 into the box, so the next register
--     sends 0.4 against a 0.5 company default and `pricingOverridesEngaged`
--     reads a DISCOUNT — an admin approval on every registration.
-- The studio no longer paints those values, and `pricing-overrides.js`
-- normalizes a restatement to the blank contract at the server as well. That
-- fixes every registration from now on. THIS FILE is the other half: the files
-- already carrying a frozen copy of an old default.
--
-- WHAT IS CLEARED, AND HOW IT IS PROVEN. Only a per-file markup that is EXACTLY
-- the company default that was in force at the moment the file's CURRENT
-- registration was created — a fact, read from the append-only
-- `company_pricing_settings` history (db/099), not a guess. That is precisely
-- the value the studio would have seeded, and clearing it means "follow the
-- company default", which is what it always meant. A markup a human genuinely
-- typed differs from the default of that day and is LEFT ALONE, so no
-- deliberate exception is lost. A registration older than every settings row
-- falls back to the seeded system literals (0.5 / 0.5 / 0.5) — the numbers the
-- studio's own `CO` constants carried before the Pricing Admin Center existed.
--
-- `file_markup_gold_t1_pct` is deliberately NOT touched: the studio never
-- seeded `tsYspGoldT1` (it documents itself as blank-by-default), so any value
-- there was typed by a human on purpose.
--
-- SCOPE — ONLY FILES WHOSE ECONOMICS ARE STILL OPEN. A file that is clear to
-- close, funded, declined, withdrawn, or has a LIVE Term Sheet package out for
-- signature keeps its frozen markup: those terms are settled or signed, and
-- re-pricing them is exactly what `file-lock.js` exists to prevent. Same
-- predicate as `structuralLockReason` (status list + a sent/delivered/completed
-- `term_sheet_package` envelope), inlined here because a migration cannot call
-- JavaScript.
--
-- TRIGGERS ARE LEFT ON, DELIBERATELY. Writing these columns fires the db/126 /
-- db/486 reopen trigger, which reopens Products & Pricing and marks the
-- registration stale. That is the CORRECT outcome and the reason the trigger
-- exists: the file's note rate genuinely moves (0.4 → 0.5 markup is +10 bps),
-- so its stored registration no longer matches what it would price at, and a
-- human must re-register it. Suppressing the reopen would leave a file
-- registered at one rate whose live quote is another — the one thing a term
-- sheet may never do. This is the opposite call to db/399, which disabled
-- triggers precisely BECAUSE that change moved no number the engine reads.
--
-- IDEMPOTENT, AND STABLE ON REPLAY. `migrate-boot` replays this on every boot.
-- A row already cleared no longer matches (the columns are NULL). A row written
-- AFTER this deploy can only match if a human typed a value that is exactly the
-- company default in force at that moment — which `pricingOverridesEngaged` has
-- always treated as "typed the default back, not a change", so clearing it is
-- the same rule stated once more. The comparison is against a historical fact
-- (the registration's own timestamp), so it never changes answer on a later
-- run. `IS DISTINCT FROM` guards keep an unchanged row from being written at
-- all, so a replay touches nothing and fires no trigger.
--
-- BACKFILL. This file IS the backfill. No schema changes.
--
-- PRODUCT SEPARATION. RTL only — `applications`, `product_registrations` and
-- `company_pricing_settings` are all RTL tables. Nothing here names `lt_*`.
-- ============================================================================

DO $$
DECLARE
  healed int := 0;
BEGIN
  -- Nothing to do on a database that has never carried a per-file markup.
  IF NOT EXISTS (
    SELECT 1 FROM applications
     WHERE file_markup_std_pct IS NOT NULL
        OR file_markup_gold_pct IS NOT NULL
        OR file_markup_silver_pct IS NOT NULL
  ) THEN
    RETURN;
  END IF;

  WITH open_files AS (
    -- Files whose economics are still editable: not status-frozen, and no live
    -- Term Sheet package out for signature.
    SELECT a.id,
           a.file_markup_std_pct    AS std,
           a.file_markup_gold_pct   AS gold,
           a.file_markup_silver_pct AS silver
      FROM applications a
     WHERE (a.file_markup_std_pct IS NOT NULL
            OR a.file_markup_gold_pct IS NOT NULL
            OR a.file_markup_silver_pct IS NOT NULL)
       AND COALESCE(a.status,'') NOT IN ('clear_to_close','funded','declined','withdrawn')
       AND NOT EXISTS (
             SELECT 1 FROM esign_envelopes e
              WHERE e.application_id = a.id
                AND e.purpose = 'term_sheet_package'
                AND e.status IN ('sent','delivered','completed'))
  ),
  with_defaults AS (
    -- The company default that was in force when this file's CURRENT
    -- registration was created. No registration and no settings row both fall
    -- back to the seeded system literals.
    SELECT f.id, f.std, f.gold, f.silver,
           COALESCE(d.markup_std_pct,    0.5) AS def_std,
           COALESCE(d.markup_gold_pct,   0.5) AS def_gold,
           COALESCE(d.markup_silver_pct, 0.5) AS def_silver
      FROM open_files f
      LEFT JOIN LATERAL (
             SELECT pr.created_at
               FROM product_registrations pr
              WHERE pr.application_id = f.id AND pr.is_current
              LIMIT 1) r ON true
      LEFT JOIN LATERAL (
             SELECT cps.markup_std_pct, cps.markup_gold_pct, cps.markup_silver_pct
               FROM company_pricing_settings cps
              WHERE cps.created_at <= COALESCE(r.created_at, now())
              ORDER BY cps.created_at DESC
              LIMIT 1) d ON true
  ),
  targets AS (
    -- Keep only the rows where at least one column is a provable restatement.
    SELECT id,
           (std    IS NOT NULL AND std    = def_std)    AS clear_std,
           (gold   IS NOT NULL AND gold   = def_gold)   AS clear_gold,
           (silver IS NOT NULL AND silver = def_silver) AS clear_silver,
           std, gold, silver, def_std, def_gold, def_silver
      FROM with_defaults
     WHERE (std    IS NOT NULL AND std    = def_std)
        OR (gold   IS NOT NULL AND gold   = def_gold)
        OR (silver IS NOT NULL AND silver = def_silver)
  ),
  cleared AS (
    UPDATE applications a
       SET file_markup_std_pct    = CASE WHEN t.clear_std    THEN NULL ELSE a.file_markup_std_pct    END,
           file_markup_gold_pct   = CASE WHEN t.clear_gold   THEN NULL ELSE a.file_markup_gold_pct   END,
           file_markup_silver_pct = CASE WHEN t.clear_silver THEN NULL ELSE a.file_markup_silver_pct END
      FROM targets t
     WHERE a.id = t.id
       AND (a.file_markup_std_pct    IS DISTINCT FROM (CASE WHEN t.clear_std    THEN NULL ELSE a.file_markup_std_pct    END)
         OR a.file_markup_gold_pct   IS DISTINCT FROM (CASE WHEN t.clear_gold   THEN NULL ELSE a.file_markup_gold_pct   END)
         OR a.file_markup_silver_pct IS DISTINCT FROM (CASE WHEN t.clear_silver THEN NULL ELSE a.file_markup_silver_pct END))
    RETURNING a.id, t.clear_std, t.clear_gold, t.clear_silver,
              t.std, t.gold, t.silver, t.def_std, t.def_gold, t.def_silver
  )
  -- The value is gone from the row, so this audit line is the only lasting
  -- record that it was ever there and why it was removed.
  INSERT INTO audit_log (actor_kind, actor_id, action, entity_type, entity_id, detail)
  SELECT 'system', NULL, 'file_markup_seeded_default_cleared', 'application', c.id,
         jsonb_strip_nulls(jsonb_build_object(
           'migration', 'db/600',
           'why', 'the per-file markup only restated the company default in force when the file was registered; it now follows the live company default',
           'standard', CASE WHEN c.clear_std    THEN jsonb_build_object('was', c.std,    'company_default_then', c.def_std)    END,
           'gold',     CASE WHEN c.clear_gold   THEN jsonb_build_object('was', c.gold,   'company_default_then', c.def_gold)   END,
           'silver',   CASE WHEN c.clear_silver THEN jsonb_build_object('was', c.silver, 'company_default_then', c.def_silver) END))
    FROM cleared c;

  GET DIAGNOSTICS healed = ROW_COUNT;
  IF healed > 0 THEN
    RAISE NOTICE 'db/600: released % file(s) from a frozen copy of an old company markup', healed;
  END IF;
END $$;


-- ── after this lands ────────────────────────────────────────────────────────
-- The schema map (docs/schema/) describes the database these migrations build,
-- so this file makes it stale. CI refreshes it on this pull request by itself;
-- if you would rather do it by hand, with DATABASE_URL pointing at a database
-- built from these migrations:
--
--   npm run schema:snapshot     # refresh the inventory from the database
--   npm run schema:restamp      # re-stamp the map header (no database needed)
