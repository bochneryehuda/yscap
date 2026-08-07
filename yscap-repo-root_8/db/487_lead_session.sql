-- 487 — ONE BROWSER SESSION, ONE LOAN OFFICER (owner-directed 2026-08-07)
--
-- The owner, on two "Term sheet generated" leads that were the SAME term sheet — one with an
-- address and one with "TBD" — landing on two different officers' desks:
--
--   "This is technically the same term sheet without an address, and it was on the same browser
--    session and went to a different loan officer. It's making our entire team crazy about the
--    same thing. We also need to set that on a single session. It should go to one loan officer
--    if it's on one browser session."
--
-- ROOT CAUSE: `lead-assignment.pickRoundRobinOfficer` is a fair rotation over the officer roster,
-- evaluated INDEPENDENTLY on every submission. The Term Sheet Studio can legitimately fire several
-- submissions while one visitor sits on one page (each export is its own generation), so the
-- rotation quite correctly handed each one to the next officer in line — and the team saw one
-- deal arrive three times from three directions.
--
-- `session_id` is an OPAQUE, CLIENT-GENERATED id held in the browser's sessionStorage. It carries
-- no personal data and identifies nothing but "these submissions came from one visit", which is
-- exactly the grain the owner asked for. It is nullable and unconstrained on purpose: every
-- existing lead has none, an older page that does not send one still works, and a junk value can
-- only ever fail to match.
ALTER TABLE leads ADD COLUMN IF NOT EXISTS session_id text;

-- The lookup is "the most recent lead from this session that already has an officer", so the index
-- is on the session with the officer as a partial predicate — a session that never got an officer
-- is not worth indexing.
CREATE INDEX IF NOT EXISTS idx_leads_session_officer
  ON leads (session_id, created_at DESC)
  WHERE session_id IS NOT NULL AND officer_id IS NOT NULL;
