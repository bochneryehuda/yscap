'use strict';
/* =====================================================================
   STAFF SAVED SCENARIOS — the rules, in one pure place (owner-directed 2026-07-30).

   The owner's words: "they can save themselves scenarios … Give a name for the
   scenario and then we should have a scenario with all the scenarios that they
   price and they can pick up from every any scenario … it comes up in the save
   like the name of the tool and the name that he gave."

   A scenario is a STAFFER'S PRIVATE SCRATCHPAD for one Investor Suite tool. It is
   deliberately not attached to an application, and nothing here can register,
   price a real file, or touch any enforcement path.

   PURE — no DB, no network — so the whole rule set unit-tests without a server.
   ===================================================================== */

/* The tools the Investor Suite offers, and therefore the only slugs a scenario may
   be saved against. MUST stay in step with the GROUPS list in
   app-v2/src/screens/StaffInvestorSuite.jsx — a slug in one and not the other means
   either a tool whose scenarios can never be saved (silently, the save just 400s) or
   a stored row nothing can ever reopen. scripts/test-suite-scenarios-pure.js reads
   the screen and asserts the two agree, so the drift is caught rather than
   discovered by a staffer losing work. */
const TOOL_SLUGS = Object.freeze([
  'term-sheet', 'rehab-budget', 'track-record', 'loan-application',
  'deal-analyzer', 'flip-analyzer', 'qualifier-pro', 'portfolio-tracker',
  'equity-compare', 'ratesaver', 'refi-breakpoint',
]);
const TOOL_SET = new Set(TOOL_SLUGS);

/* WHICH ACCESSOR PRODUCED THE BLOB.
   'suite' — YS.collectState()/applyState() in web/v2/suite.js, which every tool page
             loads: every id'd input, checkbox, radio, plus repeatable rows through
             window.YS_getRows/YS_setRows.
   'own'   — the tool's OWN richer accessor, for the two tools whose data is
             structured rather than a flat set of inputs: Rehab Budget
             (window.RB.getState/setState — line items, contingency, GC fee) and
             Track Record (window.TR). The generic collector would silently drop
             those rows, and the staffer would reopen a scenario missing its work.
   The kind is STORED so a reopen can never feed a suite-shaped blob into a tool that
   wants its own shape (or the reverse) — that restores a blank tool, which reads as
   data loss rather than as the mismatch it is. */
const STATE_KINDS = Object.freeze(['suite', 'own']);
const KIND_SET = new Set(STATE_KINDS);

/* The tools that carry their own accessor. Advisory: the CLIENT decides at save
   time by feature-detecting the tool's window, because that is the only place the
   truth lives. This list exists so the server can sanity-check a mismatch and so the
   test can prove the two tools still expose what we think they do. */
const OWN_STATE_TOOLS = Object.freeze(['rehab-budget', 'track-record']);

const NAME_MAX = 80;
/* A scenario name is a label in a list, not prose. Long enough for "12 Oak St —
   85% LTC, 18mo", short enough that the list stays scannable. */
function cleanName(raw) {
  if (raw == null) return '';
  return String(raw).replace(/\s+/g, ' ').trim().slice(0, NAME_MAX);
}

function isToolSlug(v) { return TOOL_SET.has(String(v || '').trim()); }
function isStateKind(v) { return KIND_SET.has(String(v || '').trim()); }

/* A stored state must be a plain JSON OBJECT. An array, a string or a number is
   never what either accessor returns, and storing one would fail on the way back
   out — better to refuse at the door with a reason. */
function isStateObject(v) {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

/* Roughly how big the blob is, so a runaway tool state cannot fill the table. The
   biggest real state is Portfolio Tracker with many rows; 256 KB is far above it and
   far below anything that would hurt. */
const STATE_MAX_BYTES = 256 * 1024;
function stateTooBig(v) {
  try { return Buffer.byteLength(JSON.stringify(v), 'utf8') > STATE_MAX_BYTES; }
  catch (_) { return true; }        // unserializable → refuse (fail closed)
}

/**
 * Validate a save. Returns `{ ok:true, value:{toolSlug,name,state,stateKind} }`
 * or `{ ok:false, error, detail }` with a reason a human can act on.
 */
function validateSave(body) {
  const b = (body && typeof body === 'object') ? body : {};
  const toolSlug = String(b.toolSlug || b.tool || '').trim();
  if (!isToolSlug(toolSlug)) return { ok: false, error: 'unknown_tool', detail: 'That is not an Investor Suite tool.' };

  const name = cleanName(b.name);
  if (!name) return { ok: false, error: 'name_required', detail: 'Give the scenario a name so you can find it again.' };

  if (!isStateObject(b.state)) return { ok: false, error: 'state_required', detail: 'The tool did not hand back anything to save.' };
  if (stateTooBig(b.state)) return { ok: false, error: 'state_too_large', detail: 'This scenario is too large to save.' };

  const stateKind = b.stateKind ? String(b.stateKind).trim() : 'suite';
  if (!isStateKind(stateKind)) return { ok: false, error: 'bad_state_kind', detail: 'Unrecognized scenario format.' };

  return { ok: true, value: { toolSlug, name, state: b.state, stateKind } };
}

/** The row shape the client reads. `state` is deliberately omitted from LIST
 *  responses — a list of eleven tools' full states is a lot of bytes nobody is
 *  looking at yet; it is fetched when a scenario is actually opened. */
function shapeRow(row, opts) {
  if (!row) return null;
  const out = {
    id: row.id,
    toolSlug: row.tool_slug,
    name: row.name,
    stateKind: row.state_kind,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
  if (opts && opts.withState) out.state = row.state;
  return out;
}

module.exports = {
  TOOL_SLUGS, STATE_KINDS, OWN_STATE_TOOLS, NAME_MAX, STATE_MAX_BYTES,
  isToolSlug, isStateKind, isStateObject, stateTooBig, cleanName,
  validateSave, shapeRow,
};
