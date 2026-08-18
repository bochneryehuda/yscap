-- ============================================================================
-- db/580 — lt ppe price-limit audit
--
-- WHAT THIS CHANGES, AND WHY. `lt_ppe_price_limit` holds the MONEY RULES of a rate
-- sheet: the minimum price a loan may be sold at, the rounding increment and mode
-- every price is snapped to, the loan-size ceilings, and what happens when a price
-- exceeds one. Every quote on that sheet is bounded by those five values.
--
-- The row was an UPSERT with nothing behind it. `ON CONFLICT DO UPDATE` overwrote
-- the previous floor in place, so a sheet whose floor moved from 98.000 to 95.000
-- was indistinguishable from a sheet that had always said 95.000 — no before, no
-- who, no when, no why. A price floor is the difference between selling a loan at a
-- loss and refusing it, and it could be moved by anybody with the admin cookie and
-- reconstructed by nobody afterwards.
--
-- ONE ROW PER CHANGE, APPEND-ONLY. `before` is the limits as they stood (NULL the
-- first time, which is a real and different fact from "the floor was null"), `after`
-- is what they became, and `changed_fields` names which of the five actually moved
-- so a reader is not left diffing two JSON blobs to find out that only the rounding
-- mode changed. Nothing here is ever updated or deleted: a later change is a second
-- fact about the sheet, not a correction of the first.
--
-- THE REASON IS THE POINT. The human door (`PUT /rate-sheets/:id/price-limit`)
-- refuses a change that does not say why, in the author's own words, exactly as the
-- publish override does. `reason` is nullable here rather than NOT NULL because the
-- ingestion path writes limits straight off a vendor sheet and its honest answer is
-- "loaded from the sheet, nobody typed a reason" — a placeholder string forced into
-- the column would be worse than a null a reader can see for what it is.
--
-- WRITTEN IN THE SAME TRANSACTION AS THE CHANGE. `store.setPriceLimit` opens one
-- transaction, reads the before, writes the limit and writes this row; if this row
-- cannot be written the limit does not change. An audit that can be skipped when it
-- is inconvenient is not an audit, and a money rule that moved with no record of it
-- moving is the exact failure this table exists to make impossible.
--
-- BACKFILL: NONE, and none is honest. The previous values of every existing limit
-- row were overwritten in place and are gone; writing a synthetic "as of today it
-- was this" row would manufacture a change nobody made, at a time nobody chose.
--
-- PRODUCT SEPARATION: Long-Term only (`lt_ppe_*`). Touches no RTL table.
-- ============================================================================

CREATE TABLE IF NOT EXISTS lt_ppe_price_limit_audit (
    id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    scope          TEXT NOT NULL DEFAULT 'company',
    version_id     UUID NOT NULL REFERENCES lt_ppe_rate_sheet_version(id) ON DELETE CASCADE,

    -- The limits as they stood BEFORE. NULL means this version had no price-limit
    -- row at all, which is a different fact from a row whose floor was null.
    before_limit   JSONB,
    -- The limits as they stand AFTER. Never null: a change always has an outcome.
    after_limit    JSONB NOT NULL,
    -- Which of the five values actually moved, named. Empty means somebody pressed
    -- save on unchanged values, and that is worth being able to see too.
    changed_fields TEXT[] NOT NULL DEFAULT '{}',

    -- Why, in the author's own words. Never a code. NULL only for programmatic
    -- writers (ingestion); the human door requires it.
    reason         TEXT,
    changed_by     TEXT,
    changed_at     BIGINT NOT NULL,          -- injected clock (epoch ms), matching the PPE convention
    created_at     timestamptz NOT NULL DEFAULT now()
);

-- The only read this table has: the history of one sheet version, latest first.
CREATE INDEX IF NOT EXISTS lt_ppe_price_limit_audit_version_idx
    ON lt_ppe_price_limit_audit (scope, version_id, changed_at DESC);
