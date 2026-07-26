-- 317 — clear the AI-finding trace links that can never resolve (owner-reported 2026-07-26).
--
-- The owner: "the 'AI reasoning trace →' link 404s — trace not found. Either point it at a real
-- trace or remove the link. A dead link on every finding erodes trust in all of them."
--
-- Root cause (fixed in src/lib/ai/langfuse.js): the link was built out of LANGFUSE_PROJECT, a
-- human-readable LABEL ("pilot-underwriting"), while Langfuse addresses a trace by an opaque
-- project IDENTIFIER. Going forward no link is written unless the real identifier is known. This
-- clears the ones already written, so old findings show no link instead of a broken one.
--
-- SCOPED TO WHAT IS PROVABLY DEAD: a Langfuse project identifier is a long, lowercase alphanumeric
-- token. Any stored link whose project segment is anything else (a label with a hyphen, a short
-- word) cannot resolve, so only those are cleared -- a link that MIGHT work is left alone.
-- Idempotent: re-running matches nothing. Only an observability link is touched; no loan data,
-- no finding, no condition, no status.

UPDATE ai_suggestions
   SET trace_url = NULL
 WHERE trace_url IS NOT NULL
   AND substring(trace_url from '/project/([^/]+)/traces/') IS NOT NULL
   AND substring(trace_url from '/project/([^/]+)/traces/') !~ '^[a-z0-9]{20,}$';
