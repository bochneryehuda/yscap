'use strict';
/**
 * LT PPE — THE GENERIC OVERLAY-CUT INTERPRETER (the scalable middle of D36; PPE tasks #47/#48).
 *
 * WHAT THIS IS. `deephaven-overlay-rules.js` first hand-wrote, in imperative code, the unambiguous
 * Advanced-overlay cuts published in the Deephaven DSCR matrix (Short-Term Rental, First-Time Investor,
 * Rural, Declining-market, Foreign National) and stamped each divergence via `overlay.overlayDecline`.
 * That was correct but INVESTOR-SPECIFIC: adding the second investor's overlay cuts would mean a second
 * copy of the same branch logic. This module is the reusable half — a PURE interpreter of a DECLARATIVE
 * cut TABLE — so a new investor's overlay cuts become DATA (rows), never code (the PPE "universal rule
 * shape" made mechanical: CLAUDE.md build-rule #4 "generate, don't hand-maintain"; PPE-MEGA-PLAN §6.1).
 * Deephaven's own cut table (the seed) lives in `deephaven-overlay-rules.js` and is proven BYTE-IDENTICAL
 * to the pre-refactor hand-written behavior (`test-lt-ppe-overlay-cut-engine.js`, equivalence battery).
 *
 * THE TABLE SHAPE. An ordered list of GROUPS, each keyed on ONE overlay fact:
 *   {
 *     when: 'short_term_rental',   // the overlay fact that ARMS this group (default trigger: === true)
 *     whenEquals: 'vacant',        // …or an explicit value the `when` fact must equal (e.g. occupancy)
 *     name: 'short_term_rental',   // the overlay fact stamped on each decline (default: `when`); MUST be
 *                                  //   a real overlay fact — overlayDecline THROWS otherwise (HARD RULE)
 *     enforce: true,               // this group emits real declines (a flag-only group omits it)
 *     cuts: [ <cut>, … ],          // ordered; each may fire ONE decline
 *     flags: [ {overlay, needs}, … ] // ALWAYS reported in `stillFlagged` while the group is armed
 *   }
 * A CUT is `{ code, fact, cmp, value?, base?, delta?, reason, label, unresolvedFlag? }`:
 *   • cmp 'lt' | 'gt' | 'gte'  — a NUMERIC compare of `fact` against `value`. An ABSENT / non-finite
 *       fact NEVER fires (fail-safe: we never disqualify on data we do not have).
 *   • cmp 'isTrue'             — fires when `fact === true` (a cross-overlay incompatibility, e.g. STR on
 *       a first-time investor). An absent fact is not true → never fires.
 *   • cmp 'gtRelative'         — fires when `fact > opts[base] - delta`. Needs BOTH `opts[base]` and the
 *       fact numeric; if either is missing the cut is UNRESOLVABLE → its `unresolvedFlag` is reported and
 *       the group is NOT recorded as enforced (it never invents the missing cap). `reason`/`label` may be
 *       functions receiving `{ eff, facts, opts }`.
 *   `reason` and `label` are a string OR a `(ctx) => string`.
 *
 * SAFETY (inherited by every table). Every group is armed only by its own overlay fact, which defaults
 * OFF — so an ordinary scenario arms nothing and the interpreter returns empty. A decline can only make
 * the engine STRICTER; a cut never fires on an absent fact. The interpreter reads only `facts` + `opts`.
 *
 * PURE: no DB, no network, no clock. LT-only. No RTL imports.
 */

const { overlayDecline } = require('./overlay');

const isNum = (x) => typeof x === 'number' && Number.isFinite(x);
const render = (v, ctx) => (typeof v === 'function' ? v(ctx) : v);

// A group is ARMED when its `when` fact holds the trigger value (default true, or an explicit whenEquals).
function groupArmed(group, f) {
  if (Object.prototype.hasOwnProperty.call(group, 'whenEquals')) return f[group.when] === group.whenEquals;
  return f[group.when] === true;
}

// Evaluate ONE cut. Returns one of:
//   { fired:true, reason, label }  — this cut declines
//   { unresolved:true }            — a relative cut whose base/fact is missing (→ flag, never invent)
//   null                           — armed but did not fire (incl. the fail-safe absent-fact case)
function evalCut(cut, f, opts) {
  const cmp = cut.cmp;
  if (cmp === 'isTrue') {
    return f[cut.fact] === true ? { fired: true, reason: render(cut.reason), label: render(cut.label) } : null;
  }
  if (cmp === 'gtRelative') {
    const base = opts[cut.base];
    const v = f[cut.fact];
    if (!isNum(base) || !isNum(v)) return { unresolved: true };
    const eff = base - cut.delta;
    if (v > eff) {
      const ctx = { eff, facts: f, opts };
      return { fired: true, reason: render(cut.reason, ctx), label: render(cut.label, ctx) };
    }
    return null;
  }
  const v = f[cut.fact];
  if (!isNum(v)) return null; // fail-safe: absent numeric fact never declines
  let fired = false;
  if (cmp === 'lt') fired = v < cut.value;
  else if (cmp === 'gt') fired = v > cut.value;
  else if (cmp === 'gte') fired = v >= cut.value;
  else throw new Error(`overlay-cut-engine:unknown_cmp:${cmp}`);
  return fired ? { fired: true, reason: render(cut.reason), label: render(cut.label) } : null;
}

/**
 * Interpret a declarative overlay-cut table for a scenario's engine facts. PURE.
 *   facts — engine facts (incl. the boolean/enum overlay facts).
 *   table — the ordered group list described above.
 *   opts  — `{ citation, <base keys…> }`. `citation` is stamped on every decline (a table is one
 *           investor/effective-date, so one citation); `gtRelative` cuts read their `base` key from here
 *           (e.g. `gridMaxLtvMilli`). Missing base → that cut is flagged, never invented.
 * Returns { declines:[<overlayDecline>…], enforced:[{overlay, cuts[]}], stillFlagged:[{overlay, needs}] }
 * — the SAME shape the hand-written Deephaven module returned, so it is a drop-in.
 */
function evaluateCutTable(facts, table, opts = {}) {
  const f = facts || {};
  const citation = opts.citation;
  const declines = [];
  const enforced = [];
  const stillFlagged = [];

  for (const group of table || []) {
    if (!groupArmed(group, f)) continue;
    const name = group.name || group.when;

    if (group.enforce) {
      const cuts = [];
      let unresolvedFlag = null;
      for (const cut of group.cuts || []) {
        const r = evalCut(cut, f, opts);
        if (r && r.unresolved) { unresolvedFlag = cut.unresolvedFlag; continue; }
        if (r && r.fired) {
          declines.push(overlayDecline(name, r.reason, { code: cut.code, citation }));
          cuts.push(r.label);
        }
      }
      // A relative group that could not resolve its cap is FLAGGED and NOT recorded as enforced (it never
      // invents the missing cap); an ordinary armed group is recorded as enforced even if no cut fired.
      if (unresolvedFlag) stillFlagged.push({ overlay: unresolvedFlag.overlay, needs: unresolvedFlag.needs });
      else enforced.push({ overlay: name, cuts });
    }

    for (const fl of group.flags || []) stillFlagged.push({ overlay: fl.overlay, needs: fl.needs });
  }

  return { declines, enforced, stillFlagged };
}

module.exports = { evaluateCutTable, _internals: { evalCut, groupArmed, isNum } };
