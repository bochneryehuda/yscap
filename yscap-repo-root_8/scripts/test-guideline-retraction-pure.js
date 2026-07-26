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

  console.log(`test-guideline-retraction-pure: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
