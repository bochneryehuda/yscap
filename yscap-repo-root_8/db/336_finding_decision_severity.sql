-- A DECISION REMEMBERS THE SEVERITY IT WAS MADE AT (post-merge audit of #818, 2026-07-27).
--
-- THE FALSE CLEAR THIS CLOSES. `desk-sync` has a guard whose whole purpose is this rule:
-- "a decision on a warning does not silence a later fatal" — a dismissal made while an item
-- was mild must not hold once the deal converts and the SAME rule becomes a dealbreaker.
-- The durable ledger (db/333) never recorded severity, so `ai_suggestions.record()`'s ledger
-- consult ran BEFORE that guard could speak and suppressed the row anyway.
--
-- It was latent until #818: a note-buyer row carrying a `concern_field` has a structurally
-- NULL `evidence.code`, so it never reached the ledger at all. #818 taught `claimShapeOf` to
-- derive the code from the dedupe key — correct, and necessary for the ledger to work on
-- those rows — which handed them to a consult that could not see severity. A Blue Lake
-- light-rehab file whose feasibility notice was dismissed as a warning then converts to
-- ground-up, the desk correctly re-raises it as a DEALBREAKER, and nothing is written: no
-- card, no email, and the sync's own telemetry reports it as raised.
--
-- NULL means "decided before we recorded this" and keeps the old behaviour for the rows
-- already on file: they suppress regardless, exactly as they do today. Only decisions taken
-- from here on carry a rank, and only those can be out-ranked. That is the conservative
-- direction — the alternative (treating NULL as the lowest rank) would resurrect every
-- dismissed fatal already on file.
ALTER TABLE finding_decisions ADD COLUMN IF NOT EXISTS severity text;

COMMENT ON COLUMN finding_decisions.severity IS
  'The severity the finding carried WHEN the human decided it (fatal|warning|info). A later '
  'finding whose severity outranks this one is NOT suppressed — silencing a dealbreaker with '
  'a judgement made about something milder is a false clear. NULL = decided before db/336; '
  'those rows suppress regardless, as they always have.';
