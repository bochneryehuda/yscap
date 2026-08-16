-- ============================================================================
-- LONG-TERM (LT) — db/555 — Lender Price ineligible (disqualify) search store.
--
-- DURABLE state for the Lender Price disqualify (ineligible) workflow. The
-- workflow is: a normal /price is ALSO the async KICKOFF — it stores the exact
-- searchRaw body under a stable searchKey; a later POLL re-posts the byte-
-- identical body (only cachedDisqualified flipped) so it reads the SAME upstream
-- computation, and the ~large result is materialized once and served from cache.
--
-- WHY A TABLE (audit — the A-to-Z Lender Price parity report): that state lived
-- ONLY in a process-memory Map, so a reboot / deploy / crash / move to another
-- Render instance wiped every kickoff key, upstream requestId, and cached result
-- — a client mid-poll then got "unknown search key" and had to re-run the whole
-- search. A recent production reboot is exactly the event that exposed this. The
-- in-memory Map stays as an L1 cache; this table is the durable L2 that survives
-- a restart and is shared across instances.
--
-- BEST-EFFORT: the client writes here fire-and-forget and reads here only on an
-- L1 miss, every access wrapped so a database hiccup degrades to the exact
-- in-memory-only behavior it had before — the pricing path never hard-depends on
-- this table.
--
-- SEPARATION: lt_lp_* name; LT's OWN pool (src/longterm/db.js); no RTL table is
-- read or written; no trigger/function; no FK to another product.
--
-- SOURCE OF TRUTH FOR THE SHAPE: src/longterm/prisma/schema.prisma
-- (LtLpDisqualifySearch) + docs/schema/beyond-prisma.json. Model, migration and
-- snapshot land in the same commit.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS lt_lp_disqualify_search (
    search_key   TEXT PRIMARY KEY,               -- sha256 of the canonical body (cachedDisqualified removed)
    url          TEXT NOT NULL,                  -- the upstream searchRaw URL the kickoff used
    body         JSONB NOT NULL,                 -- the EXACT kickoff body (poll re-posts it byte-identical)
    request_id   TEXT,                           -- the upstream requestId the poll must echo
    result       JSONB,                          -- the materialized parsed disqualify result (once ready)
    raw_summary  JSONB,                          -- a small structural summary kept for debug on cached hits
    ready_at     timestamptz,                    -- when the result was materialized
    created_at   timestamptz NOT NULL DEFAULT now(),
    updated_at   timestamptz NOT NULL DEFAULT now(),
    expires_at   timestamptz NOT NULL            -- TTL; a poll ignores an expired row, prune deletes it
);
CREATE INDEX IF NOT EXISTS lt_lp_disqualify_search_expires_idx ON lt_lp_disqualify_search (expires_at);
