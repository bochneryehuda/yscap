-- 324 — REPAIR the AI-finding trace links that could never resolve (owner-reported 2026-07-26).
--
-- The owner: "the 'AI reasoning trace →' link 404s — trace not found. Either point it at a real
-- trace or remove the link. A dead link on every finding erodes trust in all of them."
--
-- Root cause (fixed in src/lib/ai/langfuse.js): the link was built out of LANGFUSE_PROJECT, a
-- human-readable LABEL ("pilot-underwriting"), while Langfuse addresses a trace by an opaque
-- project IDENTIFIER. Every link ever written pointed at a project that does not exist.
--
-- ONLY THE PROJECT PART WAS EVER WRONG. The trace id at the end of each link is real, and the
-- traces themselves recorded fine — recording authenticates with the API keys and never touched
-- the label. So these links are repairable, and Langfuse provides the route that repairs them:
-- /trace/<trace id> looks the project up on its own side and forwards to the real page. Rewriting
-- is therefore strictly better than clearing, and it matters most for the regulator-facing AI
-- decision export (src/routes/admin-insights.js /ai-audit.csv), where nulling the column would
-- have destroyed an audit reference permanently and irreversibly.
--
-- SCOPE: only links whose project segment is provably NOT an identifier (an identifier is a long
-- lowercase-alphanumeric token) — so a link that might already work is left exactly as it is. An
-- empty segment (`/project//traces/`, from a blank label) is matched too. A false positive here is
-- harmless: it swaps one working form for another and keeps the trace id either way.
--
-- Idempotent: after rewriting, the URLs no longer match the pattern, so re-running changes nothing.
-- Only an observability link is touched — no loan data, no finding, no condition, no status.

UPDATE ai_suggestions
   SET trace_url = regexp_replace(trace_url, '/project/[^/]*/traces/', '/trace/')
 WHERE trace_url IS NOT NULL
   AND trace_url ~ '/project/[^/]*/traces/[^/?#]+$'
   AND COALESCE(substring(trace_url from '/project/([^/]*)/traces/'), '') !~ '^[a-z0-9]{20,}$';
