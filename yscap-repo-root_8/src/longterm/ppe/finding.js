'use strict';
/**
 * LT PPE — the findings LEDGER logic (§10.4, §10.6). PURE: no DB, no clock (nowMs injected). Turns a
 * parity disagreement into a durable finding record and reconciles a fresh shadow run against the
 * stored ledger so a fixed/dismissed finding NEVER re-opens itself (mirrors the RTL finding ledger).
 *
 * IDENTITY is the whole point: a finding is keyed by (investor, program, scenario, kind, coupon) so
 * the same disagreement on the next run merges onto the same row (recurrence++), a settled row is
 * carried forward WITHOUT reopening, and a fixed/verified row that reappears is flagged `regressed`
 * (the fix did not hold — surfaced, never silently reopened). A finding that stops appearing is
 * reported as `disappeared` so the caller can auto-close it (§10.6: a data-driven finding that is
 * gone is resolved, never left dangling).
 *
 * The DB store (a later, migration-backed layer) persists what this returns; sanitizing the payloads
 * (no credentials/PII, §10.4) is the caller's job — this module passes them through opaquely.
 *
 * LT-only. No RTL imports.
 */

const overlay = require('./overlay');
const provenance = require('./agreement-provenance');

const OPEN = new Set(['open', 'triaged']);
const SETTLED = new Set(['fixed', 'verified', 'wontfix']);
// Kinds carrying a COUPON in their identity (eligibility/engine_error do not, because they are facts
// about the whole scenario). The second row is the DEEP comparison's per-coupon categories
// (parity-detectors), which are per-coupon for exactly the same reason the first row is: our base
// price can agree at 7.000 and be off at 7.250, and two rows are two things to settle. Leave one out
// and every coupon's difference collapses onto ONE ledger row, so the first sighting hides the rest
// and settling it settles a disagreement nobody looked at.
const RATE_KINDS = new Set([
  'price_mismatch', 'rate_mismatch', 'rung_missing_ours', 'rung_missing_theirs',
  'base_price', 'final_price', 'margin', 'llpa_total', 'coupon_missing_ours', 'coupon_missing_lp',
]);

function norm(s) { return String(s == null ? '' : s).trim().toLowerCase(); }

/**
 * Stable identity for a finding. Same disagreement -> same key across runs.
 *   { investor, program, scenario, kind, rate }
 */
function findingKey(f = {}) {
  const parts = [norm(f.investor), norm(f.program), norm(f.scenario), norm(f.kind)];
  if (RATE_KINDS.has(f.kind) && f.rate != null) parts.push(String(f.rate));
  if (f.kind === 'engine_error' && f.side) parts.push(norm(f.side));
  return parts.join('|');
}

/**
 * Build persistable finding records from ONE scenario's parity comparison.
 *   cmp: { agree, findings } from parity.compareScenario / shadow.runOne.
 *   ctx: { scenario (label or object), investor, program, ourPayload?, theirPayload?, nowMs }
 * Returns [] when the scenario agreed. Each record is born `open`, recurrence 1 — EXCEPT a reasoned
 * overlay override, which is born settled (`wontfix`); see the note at the record itself.
 */
function recordsFromComparison(cmp = {}, ctx = {}) {
  const findings = Array.isArray(cmp.findings) ? cmp.findings : [];
  const now = typeof ctx.nowMs === 'number' ? ctx.nowMs : null;
  const scenarioLabel = typeof ctx.scenario === 'string' ? ctx.scenario : (ctx.scenarioLabel || '');
  return findings.map((f) => {
    const key = findingKey({ investor: ctx.investor, program: ctx.program, scenario: scenarioLabel, kind: f.kind, rate: f.rate, side: f.side });
    // A REASONED OVERRIDE IS BORN SETTLED, because there is nothing for anybody to do about it.
    //
    // Everything else here is a disagreement somebody has to work: born `open`, and
    // `cutover.eligibleForLive` refuses to promote an investor while ONE is open. An overlay decline is
    // the opposite — our engine declining a scenario Lender Price prices, on a fact LP cannot see, WITH
    // a stated reason (owner D29). It is the behaviour working. Born `open` it could never be closed
    // honestly (there is no fix), it re-appeared on every run, and it held the go-live gate shut for
    // good — the same dead end §2.72 records on the agreement rate.
    //
    // `wontfix` is exactly the existing meaning: settled, no work planned. `mergeOne` carries a wontfix
    // row forward untouched and — unlike `fixed`/`verified` — never flags it `regressed` when it
    // reappears, which is right: an override recurring is expected, not a fix coming undone. It stays a
    // real ledger row so the review queue still SHOWS every scenario we override and why (the reasons
    // ride in `diff.overlayReasons`); it simply stops counting as outstanding work.
    const isOverride = overlay.isOverlayFinding(f);
    return {
      key,
      investor: ctx.investor || null,
      program: ctx.program || null,
      scenario: scenarioLabel,
      scenarioFacts: (ctx.scenario && typeof ctx.scenario === 'object') ? ctx.scenario : null,
      kind: f.kind,
      diff: f, // the structured disagreement (axis, deltas) — see parity findings
      ourPayload: ctx.ourPayload == null ? null : ctx.ourPayload,
      theirPayload: ctx.theirPayload == null ? null : ctx.theirPayload,
      status: isOverride ? 'wontfix' : 'open',
      firstSeenMs: now,
      lastSeenMs: now,
      recurrence: 1,
      regressed: false,
      // WHICH ENGINE WIRING MEASURED THIS (§2.126). Not decoration: `mergeOne`/`reconcile` below make
      // three CONFIDENT statements about a stored row — it recurred, it is gone so we auto-close it, it
      // came back so the fix did not hold — and every one of them is a claim that this run and the
      // stored row measured the SAME thing. Before this field there was nothing on the row to check
      // that against, so a disagreement filed by a leg that has since been corrected was carried,
      // closed and accused exactly like a real one. Read from the constant, never from `ctx`: a stamp a
      // caller can forget to pass is a stamp that quietly reads as "recorded before the fix".
      legVersion: provenance.LEG_VERSION,
    };
  });
}

/**
 * Merge one incoming finding against its stored counterpart (same key).
 * Returns { record, action } where action ∈ new | recurred | carried_settled | carried_wontfix.
 * A settled finding (fixed/verified/wontfix) is CARRIED FORWARD, never reopened; a fixed/verified one
 * that reappears is marked `regressed` so a broken fix is visible.
 */
function measuredByCurrentLeg(rec) {
  return !!(rec && typeof rec === 'object' && rec.legVersion === provenance.LEG_VERSION);
}

/**
 * The plain-language reason a stored row cannot be read (§2.126), or null when it can.
 * ONE definition, because three surfaces say this sentence: the ledger, the go-live gate and the screen.
 */
function unreadableReason(rec) {
  if (measuredByCurrentLeg(rec)) return null;
  if (!rec || rec.legVersion == null) {
    return 'recorded before the engine wiring was stamped, so what measured it is unknown';
  }
  return `recorded by an engine wiring that has since changed (${rec.legVersion}), so it cannot be compared with today's`;
}

function mergeOne(existing, incoming) {
  if (!existing) return { record: incoming, action: 'new' };
  const lastSeenMs = incoming.lastSeenMs != null ? incoming.lastSeenMs : existing.lastSeenMs;
  const recurrence = (existing.recurrence || 0) + 1;
  if (SETTLED.has(existing.status)) {
    // ⛔ A SETTLED ROW MEASURED BY A WIRING THAT HAS SINCE CHANGED IS NOT ACCUSED OF REGRESSING (§2.126).
    // `regressed` means one specific thing — "somebody fixed this and it has come back" — and the gate
    // blocks promotion on it. That sentence needs the settlement and the sighting to be about the same
    // measurement. When the settlement was recorded by an older leg it is not, and the loudest possible
    // reading of the ledger would be asserted about a row nobody ever really measured.
    //
    // SUPPRESSING IT IS NOT ENOUGH, which is the §2.124 lesson: hiding a false disagreement without
    // saying so leaves a confident, wrong AGREEMENT in its place. So the row is carried AND marked —
    // `staleDecision` says the decision, not the finding, is what cannot be read. The remedy is one
    // action: deciding it again writes today's stamp (finding-store.decideFinding) and clears it.
    if (!measuredByCurrentLeg(existing)) {
      return {
        record: {
          ...existing, lastSeenMs, recurrence, diff: incoming.diff,
          staleDecision: true, staleDecisionReason: unreadableReason(existing),
        },
        action: 'carried_unreadable',
      };
    }
    const regressed = existing.status === 'fixed' || existing.status === 'verified';
    return {
      record: { ...existing, lastSeenMs, recurrence, regressed: regressed || !!existing.regressed, diff: incoming.diff },
      action: existing.status === 'wontfix' ? 'carried_wontfix' : 'carried_settled',
    };
  }
  // open / triaged: keep the human's status, refresh the sighting + latest diff.
  //
  // THE STAMP MOVES HERE, and only here. An OPEN row that reproduced under today's wiring has just been
  // re-measured by it: whatever produced the original sighting, the disagreement is real now, so the row
  // stops being unreadable. A SETTLED row above gets the opposite treatment for the opposite reason —
  // there the doubt is about the human decision, and no run can re-make that.
  return {
    record: { ...existing, lastSeenMs, recurrence, diff: incoming.diff, legVersion: incoming.legVersion },
    action: 'recurred',
  };
}

/**
 * Reconcile a whole run's incoming findings against the stored ledger.
 *   existing: [...] stored records (each with a .key).
 *   incoming: [...] fresh records from recordsFromComparison across the run.
 *   opts: { nowMs, closeDisappeared=true } — a stored OPEN finding not seen this run is reported as
 *          disappeared (caller auto-closes it); a settled one that disappears is simply not re-touched.
 * Returns { records, disappeared, unreadable, summary } — `records` is the full merged set to persist;
 * `disappeared` is returned separately for closing; `unreadable` is the set the caller must NOT close.
 *
 * ⛔ ABSENCE IS ONLY EVIDENCE WHEN THE SAME THING LOOKED (§2.126). Auto-closing a disappeared finding
 * writes the status `verified` with the reason "no longer reproduced" — a sentence claiming a run went
 * looking for this disagreement and did not find it. A run using a corrected leg did not look for the
 * old leg's disagreement at all, so its silence proves nothing about that row, and closing it stamps a
 * clean verdict on a question nobody asked. Those rows come back in `unreadable` instead: still open,
 * still blocking, and reported in language that says a human has to look.
 */
function reconcile(existing = [], incoming = [], opts = {}) {
  const byKey = new Map();
  for (const e of existing) if (e && e.key) byKey.set(e.key, e);
  const seen = new Set();
  const records = [];
  const summary = { new: 0, recurred: 0, carried: 0, regressed: 0, disappeared: 0, unreadable: 0, staleDecisions: 0 };
  const disappeared = [];
  const unreadable = [];

  for (const inc of incoming) {
    if (!inc || !inc.key) continue;
    seen.add(inc.key);
    const { record, action } = mergeOne(byKey.get(inc.key), inc);
    if (action === 'new') summary.new += 1;
    else if (action === 'recurred') summary.recurred += 1;
    else summary.carried += 1;
    if (action === 'carried_unreadable') summary.staleDecisions += 1;
    if (record.regressed) summary.regressed += 1;
    records.push(record);
  }

  for (const e of existing) {
    if (!e || !e.key || seen.has(e.key)) continue;
    if (!OPEN.has(e.status)) continue; // a settled finding that didn't recur is left untouched
    if (!measuredByCurrentLeg(e)) {
      unreadable.push({ ...e, unreadableReason: unreadableReason(e) });
      summary.unreadable += 1;
      continue;
    }
    disappeared.push(e); summary.disappeared += 1;
  }

  return { records, disappeared, unreadable, summary };
}

module.exports = {
  OPEN_STATUSES: OPEN, SETTLED_STATUSES: SETTLED, RATE_KINDS,
  findingKey, recordsFromComparison, mergeOne, reconcile,
  measuredByCurrentLeg, unreadableReason, LEG_VERSION: provenance.LEG_VERSION,
};
