-- ============================================================================
-- db/576 — lt ppe ratesheet agreement gate
--
-- WHAT THIS CHANGES, AND WHY. The owner's HARD RULE for the pricing engine is that
-- a rate sheet is agreed with Lender Price — every LLPA, every eligibility AND
-- ineligibility, the max and the min price, to the penny, over at least ~200
-- scenarios — BEFORE it is trusted. `ratesheet-agreement.js` is that harness and it
-- computes exactly that verdict (`summary.gateMet`).
--
-- Nothing ever kept it. The verdict existed for as long as the function's return
-- value was on the stack and was then discarded, and `publishRateSheetVersion`
-- flipped a sheet to `published` — the moment it becomes the sheet every quote
-- prices from — without reference to any of it. So the rule was real, written down
-- in three places, and enforced nowhere: any sheet could be published, and priced
-- from, with not one scenario ever compared. This table is the missing memory.
--
-- ONE ROW PER RUN, APPEND-ONLY. A gate verdict is EVIDENCE, and evidence is not
-- edited: a later run that disagrees with an earlier one is a second fact about the
-- sheet, not a correction of the first. Readers take the LATEST run for a version;
-- the history stays because "it passed in the morning and failed after the reprice"
-- is exactly the sequence somebody will need to reconstruct.
--
-- IT RECORDS, IT DOES NOT DECIDE. `gate_met` is the harness's own verdict, stored
-- verbatim. What counts as enough scenarios, and whether a sheet may be published
-- without a passing run, are decisions that live in code the owner can read and in
-- the override below — never in a threshold buried in a table.
--
-- THE OVERRIDE IS PART OF THE DESIGN, NOT A HOLE IN IT. A gate whose only remedy
-- is a state nothing can produce is a dead end: on the day this lands, no sheet has
-- a recorded run and the harness needs live Lender Price credentials to produce
-- one. So a publish may proceed against an unproven sheet only when somebody asks
-- for it explicitly and says why, and that is recorded here as a row of its own
-- (`kind = 'override'`) with their name on it. The point is never to make refusal
-- impossible to get past; it is to make getting past it impossible to do silently.
--
-- BACKFILL: NONE, and none is possible. No agreement run has ever been recorded
-- anywhere, so there is nothing to import, and marking existing sheets as proven
-- would be inventing the exact evidence this table exists to require.
--
-- PRODUCT SEPARATION: Long-Term only (`lt_ppe_*`). Touches no RTL table.
-- ============================================================================

CREATE TABLE IF NOT EXISTS lt_ppe_ratesheet_agreement (
    id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    scope                 TEXT NOT NULL DEFAULT 'company',
    rate_sheet_version_id UUID NOT NULL REFERENCES lt_ppe_rate_sheet_version(id) ON DELETE CASCADE,

    -- 'run' = the harness measured this sheet against Lender Price.
    -- 'override' = a human published it without a passing run and said why.
    -- They are kept in ONE table on purpose: "what do we know about this sheet's
    -- agreement?" must be answerable from one place, and an override that lived
    -- somewhere else would be the half nobody reads.
    kind                  TEXT NOT NULL DEFAULT 'run',

    -- The harness's own verdict, verbatim. NULL on an override row — an override is
    -- not a measurement, and writing false there would say the sheet was measured
    -- and failed, which is a different (and more damning) claim than "unmeasured".
    gate_met              BOOLEAN,

    -- What the run actually covered. `comparable` is the number that matters: a run
    -- of 200 scenarios where 190 were incomparable proves almost nothing, and a
    -- reader must be able to see that rather than trust the total.
    scenarios             INTEGER NOT NULL DEFAULT 0,
    comparable            INTEGER NOT NULL DEFAULT 0,
    agreed                INTEGER NOT NULL DEFAULT 0,
    disagreed             INTEGER NOT NULL DEFAULT 0,
    errors                INTEGER NOT NULL DEFAULT 0,

    -- The whole `summary` the harness returned (per-dimension and per-status counts,
    -- the unencoded-family labels). Stored so a verdict can be re-read in detail
    -- years later without re-running a battery against a vendor that has repriced.
    summary               JSONB,

    -- An override's reason, in the author's own words. Never a code.
    reason                TEXT,
    recorded_by           TEXT,
    recorded_at           BIGINT NOT NULL,        -- injected clock (epoch ms), matching the PPE convention
    created_at            timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT lt_ppe_ratesheet_agreement_kind_chk CHECK (kind IN ('run','override'))
);

-- The only read this table has: the LATEST word on one sheet version.
CREATE INDEX IF NOT EXISTS lt_ppe_ratesheet_agreement_version_idx
    ON lt_ppe_ratesheet_agreement (scope, rate_sheet_version_id, recorded_at DESC);
