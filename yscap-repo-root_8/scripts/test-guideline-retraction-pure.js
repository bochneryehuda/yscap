'use strict';
/**
 * The guideline desk must RETRACT what it no longer says (owner-reported 2026-07-26).
 *
 * The sync was append-only. Nothing closed a coverage gap when the rule stopped raising it, so
 * every notice written before a rule was corrected stayed open on that file forever. The owner
 * reviewed a file on 7/26 and saw blank "Blue Lake requires X" notices whose rules had been given
 * their correct dispositions on 7/24 — the fix was real and completely invisible, because the
 * screen was showing history instead of the system's current judgement.
 *
 * The DANGEROUS half of this fix is over-reach: a retraction that also withdrew a finding a human
 * had escalated, dismissed, converted to a condition or marked important would destroy a record of
 * a judgement someone made. That is far worse than the noise it fixes, so most of these assertions
 * are about what retraction must NOT touch.
 *
 * Pure: the pg client is a stub that records the SQL + params. No DB.
 */
const R = require('path').resolve(__dirname, '..');
const sync = require(R + '/src/lib/underwriting/investor-guidelines/desk-sync');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; } else { fail++; console.log('  FAIL:', m); } };

function stubClient(rowCount = 0) {
  const calls = [];
  return {
    calls,
    async query(text, params) { calls.push({ text, params }); return { rowCount, rows: [] }; },
  };
}

(async function main() {
  // ---------- the retraction itself ----------
  const c = stubClient(3);
  const n = await sync.retractStale(c, 'app-1', ['isg-gap:rtl_p1_llc', 'isg-conflict:123']);
  ok(n === 3, `returns how many rows it closed (got ${n})`);
  ok(c.calls.length === 1, 'one statement, not a row-by-row loop');

  const sql = c.calls[0].text.replace(/\s+/g, ' ');
  const params = c.calls[0].params;

  // The guard that matters most.
  ok(/status\s*=\s*'open'/.test(sql),
    'ONLY untouched rows — a human decision (escalated / dismissed / converted / important / asked) is never withdrawn');
  ok(!/status\s*<>\s*/.test(sql), 'not a negated status test that could sweep up decided rows');

  // Scope.
  ok(/application_id\s*=\s*\$1/.test(sql), 'scoped to ONE file');
  ok(/source\s*=\s*\$2/.test(sql), 'scoped to this desk only — never another producer\'s findings');
  ok(params[1] === 'investor_guideline_desk', `scoped to the guideline desk source (got ${params[1]})`);

  // The set logic.
  ok(/NOT\s*\(\s*dedupe_key\s*=\s*ANY/.test(sql), 'closes exactly what is NOT in the current set');
  ok(Array.isArray(params[2]) && params[2].length === 2, 'the current keys are passed as an array parameter');

  // It must be auditable, not a silent vanish.
  ok(/status_reason/.test(sql), 'records WHY it closed, so the trail explains the disappearance');
  ok(/dismissed/.test(sql), 'lands in an existing valid status (no schema/enum change needed)');
  ok(/updated_at/.test(sql), 'stamps updated_at');

  // ---------- the empty-set case: the whole point of the fix ----------
  // A file whose rules ALL went silent (exactly the owner's case) must still be swept. If an empty
  // key list short-circuited, the stale rows the owner is looking at would never clear.
  const c2 = stubClient(5);
  const n2 = await sync.retractStale(c2, 'app-2', []);
  ok(c2.calls.length === 1 && n2 === 5,
    'a desk that now says NOTHING still retracts everything it previously said (the owner\'s exact case)');
  ok(Array.isArray(c2.calls[0].params[2]) && c2.calls[0].params[2].length === 0,
    'an empty current-set is passed as an empty array, not skipped');

  // ---------- never throws ----------
  const boom = { async query() { throw new Error('db down'); } };
  ok(await sync.retractStale(boom, 'app-3', []) === 0,
    'a failed retraction returns 0 rather than throwing — it must never break the file view');
  ok(await sync.retractStale(null, 'app-4', []) === 0, 'no client → 0, no throw');
  ok(await sync.retractStale(stubClient(0), 'app-5', null) === 0, 'null keys → no throw');

  // ---------- keys come from the desk's own payloads ----------
  // The retraction is only correct if the keys it preserves are the SAME strings the recorder
  // writes. Drift between the two would retract live findings on every single run.
  const payloads = sync.deskToSuggestions({
    noteBuyer: { name: 'Blue Lake Capital' },
    unhappy: [
      { cond_no: 200, name: 'FEASIBILITY', flag: 'coverage_gap', severity: 'fatal', gapKey: 'rtl_cond_feasibility', pilot_template_code: 'rtl_cond_feasibility' },
      { cond_no: 123, name: 'NY LOAN', flag: 'conflict', severity: 'fatal' },
      { cond_no: 3333, name: 'NON ARMS LENGTH', flag: 'concern', severity: 'warning' },
    ],
  });
  ok(payloads.length === 3, `the desk produced ${payloads.length} payloads`);
  const keys = payloads.map((p) => p.dedupeKey);
  ok(keys.every((k) => typeof k === 'string' && k.startsWith('isg-')),
    `every payload carries a dedupeKey the retraction can preserve (${JSON.stringify(keys)})`);
  ok(new Set(keys).size === keys.length, 'the keys are distinct, so none masks another');

  // ---------- THE DESTRUCTIVE CASE: the desk FAILED, it did not "say nothing" ----------
  // runInvestorGuidelineDesk returns a well-formed EMPTY result on ANY internal failure (a require
  // error, a loadRuleContext throw, a null load) — identical in shape to a genuine "nothing
  // applies". If retraction ran on that, a transient database blip during one file view would
  // silently CLOSE EVERY open guideline finding on the file. Wiping real findings on a hiccup is
  // far worse than leaving a stale one up for one more cycle, so retraction demands positive
  // evidence the desk actually evaluated rules.
  const failedDesk = {
    noteBuyer: { key: null, name: null }, verdicts: [], unhappy: [],
    summary: { applicable: 0 }, empty: true,          // exactly what the desk returns on failure
  };
  const c3 = stubClient(9);
  const r3 = await sync.syncInvestorGuidelineFindings(c3, 'app-6', { desk: failedDesk });
  ok(r3.retracted === 0,
    `a desk that FAILED (empty result) retracts NOTHING (got ${r3.retracted}) — a transient error must never wipe a file's findings`);
  ok(r3.assessed === false, 'the failed/empty desk is reported as not assessed');
  ok(!c3.calls.some((k) => /UPDATE ai_suggestions/.test(k.text)),
    'no UPDATE is even issued when the desk did not assess');

  // ...but a desk that genuinely ASSESSED and found nothing unhappy DOES converge.
  const cleanDesk = {
    noteBuyer: { key: 'bluelake', name: 'Blue Lake Capital' },
    verdicts: [{ cond_no: 1, verdict: 'satisfied' }],   // it really evaluated a rule
    unhappy: [],
  };
  const c4 = stubClient(4);
  const r4 = await sync.syncInvestorGuidelineFindings(c4, 'app-7', { desk: cleanDesk });
  ok(r4.assessed === true && r4.retracted === 4,
    `a desk that assessed and is now HAPPY retracts its stale rows (assessed=${r4.assessed}, retracted=${r4.retracted})`);

  // ---------- A DEGRADED READ IS NOT A JUDGEMENT (audit 2026-07-26) ----------
  // `verdicts` comes from the applicable RULES, computed before and independently of the signal
  // loaders — and every loader swallows its own error. So a file whose appraisal query failed still
  // returns a healthy-looking desk with all its appraisal items silently missing. The `assessed`
  // guard alone would happily retract those live findings and stamp them "the rule was corrected",
  // which is false; worse, the next good run RE-INSERTS them, and a fresh insert re-fires the
  // fatal-notify email — so a flapping query would email the loan officer on every cycle.
  const degradedDesk = {
    noteBuyer: { key: 'bluelake', name: 'Blue Lake Capital' },
    verdicts: [{ cond_no: 1, verdict: 'satisfied' }],   // rules DID evaluate...
    unhappy: [],
    degraded: ['appraisal'],                            // ...but the appraisal read failed
  };
  const c5 = stubClient(7);
  const r5 = await sync.syncInvestorGuidelineFindings(c5, 'app-8', { desk: degradedDesk });
  ok(r5.retracted === 0,
    `a desk whose appraisal read FAILED retracts nothing (got ${r5.retracted}) — its appraisal items are missing, not withdrawn`);
  ok(r5.degraded === true, 'the degraded read is reported, so the caller can see why nothing converged');
  ok(!c5.calls.some((k) => /UPDATE ai_suggestions/.test(k.text)),
    'no UPDATE is issued at all on a degraded read');

  // An explicitly EMPTY degraded list is a clean read and still converges.
  const c6 = stubClient(2);
  const r6 = await sync.syncInvestorGuidelineFindings(c6, 'app-9', {
    desk: { noteBuyer: { key: 'bluelake' }, verdicts: [{ cond_no: 1 }], unhappy: [], degraded: [] } });
  ok(r6.retracted === 2 && r6.degraded === false,
    `a clean read (degraded: []) still converges (retracted=${r6.retracted}, degraded=${r6.degraded})`);

  // ---------- A HUMAN'S DECISION IS NOT RE-OPENED (audit 2026-07-27) ----------
  // `aiSug.record` refreshes a row only while it is still `status='open'`; against a CLOSED row it
  // finds nothing and INSERTS a fresh open one. The desk is a pure function of the file, so it
  // re-raises the same item every view — which undid a staffer's Dismiss on the next page load,
  // forever. Now load-bearing: the file view DROPS a guideline finding whose suggestion is closed,
  // so a resurrection would reverse the drop within one render.
  //
  // The discriminator is `decided_by_staff_id`: `decide()` stamps the person who acted, and
  // `retractStale`'s automatic withdrawal is a raw UPDATE that never touches it.
  const unhappyDesk = {
    noteBuyer: { key: 'bluelake', name: 'Blue Lake Capital' },
    verdicts: [{ cond_no: 2193, verdict: 'outstanding' }],
    unhappy: [{ cond_no: 2193, flag: 'coverage_gap', severity: 'fatal', name: 'Feasibility report',
      pilot_template_code: 'rtl_cond_feasibility' }],
  };
  // A client whose "which keys did a human decide?" SELECT returns the gap's key.
  // `rows` are [dedupe_key, severity-the-human-decided-on] pairs.
  const decidedClient = (rows) => {
    const keys = rows.map((r) => (Array.isArray(r) ? r : [r, 'fatal']));
    const calls = [];
    return { calls,
      async query(text, params) {
        calls.push({ text, params });
        if (/decided_by_staff_id\s+IS\s+NOT\s+NULL/i.test(text)) {
          return { rowCount: keys.length, rows: keys.map(([k, sev]) => ({ dedupe_key: k, severity: sev })) };
        }
        // `record()` reads its RETURNING id off rows[0] — hand it a row so the insert path
        // completes instead of throwing into the per-row catch and reporting a misleading 0.
        if (/INSERT INTO ai_suggestions/i.test(text)) return { rowCount: 1, rows: [{ id: 'sug-1' }] };
        return { rowCount: 0, rows: [] };
      } };
  };
  const c7 = decidedClient(['isg-gap:rtl_cond_feasibility']);
  const r7 = await sync.syncInvestorGuidelineFindings(c7, 'app-10', { desk: unhappyDesk });
  ok(r7.raised === 0 && r7.heldByHuman === 1,
    `an item a human already decided is NOT re-raised (raised=${r7.raised}, heldByHuman=${r7.heldByHuman})`);
  ok(!c7.calls.some((k) => /INSERT INTO ai_suggestions/i.test(k.text)),
    'no fresh row is inserted for a human-decided item — the dismissal actually sticks');

  // ...and a rule the DESK retracted (decided_by_staff_id NULL, so absent from that SELECT) comes
  // straight back when it legitimately applies again. Automatic withdrawal must not be permanent.
  const c8 = decidedClient([]);
  const r8 = await sync.syncInvestorGuidelineFindings(c8, 'app-11', { desk: unhappyDesk });
  ok(r8.raised === 1 && r8.heldByHuman === 0,
    `a desk-retracted rule is raised again once it applies (raised=${r8.raised}, heldByHuman=${r8.heldByHuman})`);

  // A failed read of that SELECT must suppress NOTHING — silence is not a decision.
  // ...but a decision made about a WARNING does not silence the same rule once it turns FATAL.
  // The dedupe key encodes neither severity nor the state of the file, so a dismissal on a
  // light-rehab file would otherwise keep the rule quiet after the deal converts to ground-up and
  // the same requirement becomes a dealbreaker. Silencing a dealbreaker with a judgement made about
  // something milder is a false clear.
  const c8b = decidedClient([['isg-gap:rtl_cond_feasibility', 'warning']]);
  const r8b = await sync.syncInvestorGuidelineFindings(c8b, 'app-11b', { desk: unhappyDesk });
  ok(r8b.raised === 1 && r8b.heldByHuman === 0,
    `a warning-level dismissal does NOT suppress the same rule once it is FATAL (raised=${r8b.raised})`);

  const c9 = {
    async query(text) {
      if (/decided_by_staff_id\s+IS\s+NOT\s+NULL/i.test(text)) throw new Error('db blip');
      if (/INSERT INTO ai_suggestions/i.test(text)) return { rowCount: 1, rows: [{ id: 'sug-2' }] };
      return { rowCount: 0, rows: [] };
    } };
  const r9 = await sync.syncInvestorGuidelineFindings(c9, 'app-12', { desk: unhappyDesk });
  ok(r9.raised === 1, `a failed decided-keys read suppresses nothing (raised=${r9.raised})`);

  console.log(`test-guideline-retraction-pure: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
