'use strict';
/**
 * "FREE AND CLEAR" IS OFFERED ON THE PAYOFF CONDITION, AND ONE LIST DECIDES WHAT IT ANSWERS.
 *
 * Owner-directed 2026-08-24: *"There are a few conditions: asking for a payoff, asking to verify
 * the payoff, asking maybe for a VOM. Those payoff conditions are about the old mortgage. If you
 * mark over there in that condition, there is already logic to mark the property free and clear.
 * In that condition, you should be able to attach that logic and mark over there that the property
 * is free and clear, and that should waive the payoff condition, the verified payoff condition,
 * and the VOM condition."*
 *
 * WHAT ALREADY WORKED, AND IS NOT RE-PROVEN HERE. The confirmation, the waiver of both payoff
 * conditions, the $0 payoff of record and the reversal have worked since db/575 and are covered
 * end-to-end by `test-payoff-free-and-clear-db.js` (29 checks). This suite covers the two things
 * that changed: the list is now DERIVABLE rather than hand-typed three times, and the control is
 * offered on the condition a person is actually looking at.
 *
 * THE CENTRAL ASSERTION IS SECTION A, and it is a DERIVED guard rather than a restated list.
 * A condition belongs in `FREE_AND_CLEAR_WAIVES` for exactly one reason: its own rule says it
 * should not be on a free-and-clear file. So the list is checked against THE DATABASE'S OWN RULES
 * instead of against a copy of itself — retyping the two codes here would prove only that this
 * file agrees with itself. That is what makes a VOM condition added later safe: give it the
 * ordinary free-and-clear exclusion and this suite fails until it is in the list.
 *
 * THE VOM IS SETTLED, AND THE ANSWER IS "THERE ISN'T ONE" (owner-directed 2026-08-25). The owner
 * hedged on the third condition when they asked for this ("asking MAYBE for a VOM"), and short-term
 * has never carried a verification-of-mortgage condition in any form. Asked directly, the owner
 * chose to leave it that way: RTL asks for no VOM. So section D no longer records an OPEN question
 * — it records a DECISION, and it is written as the owner's rule rather than as a snapshot of the
 * table: IF a VOM condition ever exists here, free and clear must waive it. Do NOT re-open this by
 * copying the Long-Term Encompass library's VOM across; that is a different product and would need
 * fresh written authorisation recorded in docs/LONG-TERM-AUTHORIZED-COPIES.md.
 *
 * Skips cleanly when DATABASE_URL is unset.
 */

if (!process.env.DATABASE_URL) { console.log('test-free-and-clear-condition-db: SKIPPED (no DATABASE_URL)'); process.exit(0); }

const fs = require('fs');
const path = require('path');
const db = require('../src/db');
const { ensureSchema } = require('../src/migrate-boot');
const payoff = require('../src/lib/payoff');

let n = 0, failed = 0;
const ok = (cond, label) => { n++; if (cond) return; failed++; console.error('  ✘ ' + label); };
const eq = (a, b, label) => ok(a === b, `${label} (got ${JSON.stringify(a)}, expected ${JSON.stringify(b)})`);
const src = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');
/* Comments are stripped before every "must not appear" assertion: the code that removed the
   hand-typed lists necessarily QUOTES one in its explanation, and a guard that read comments would
   fail on its own reasoning and then get "fixed" by deleting it. */
const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');

(async () => {
  await ensureSchema();

  // ── A. the list IS the engine's own free-and-clear rule set ───────────────────────────────
  {
    /* Every ACTIVE template whose rule says "not on a free-and-clear file". That predicate is the
       DEFINITION of a condition free-and-clear answers, so it is also the definition of what the
       flip must waive — and a condition the engine retracts when untouched but that nothing waives
       when a human HAS worked it would sit open forever on a file with no mortgage. */
    const ruled = (await db.query(
      `SELECT code FROM checklist_templates
        WHERE is_active
          AND rule_logic::text LIKE '%property_free_and_clear%'
          AND rule_logic::text LIKE '%is_false%'
        ORDER BY code`)).rows.map((r) => r.code);
    ok(ruled.length >= 2, `A1 the database carries free-and-clear-gated conditions (${ruled.length})`);

    const listed = payoff.FREE_AND_CLEAR_WAIVES.slice().sort();
    const missing = ruled.filter((c) => !listed.includes(c));
    const extra = listed.filter((c) => !ruled.includes(c));
    ok(missing.length === 0,
      'A2 every free-and-clear-gated condition is in FREE_AND_CLEAR_WAIVES — otherwise a WORKED one '
      + `stays open forever on a file with no mortgage: ${missing.join(', ')}`);
    ok(extra.length === 0,
      'A3 …and the list names nothing the rules do not gate — a stray code would waive a condition '
      + `that is genuinely still needed: ${extra.join(', ')}`);
  }

  // ── B. the route reads that one list, three times over ────────────────────────────────────
  {
    /* The route names this set three times — waive, un-waive, and strip the stale note — and the
       failure of a fourth hand-typed copy is silent and ASYMMETRIC: a code added to the waive list
       but not the un-waive list can never be reopened, so turning free-and-clear back off would
       leave it waived on a file that really does have a mortgage to pay off. */
    const whole = stripComments(src('src/routes/staff.js'));
    /* SCOPED TO THIS ROUTE, not the whole file. staff.js is 15,000 lines and legitimately matches
       template codes against an array in other places; counting those would make the numbers below
       drift for reasons that have nothing to do with the payoff. */
    const start = whole.indexOf("router.post('/applications/:id/payoff/free-and-clear'");
    ok(start > 0, 'B0 the free-and-clear route is where this expects it');
    const end = whole.indexOf("router.", start + 40);
    const route = whole.slice(start, end > start ? end : undefined);

    const hand = whole.match(/t\.code IN \([^)]*cond_payoff[^)]*\)/g) || [];
    eq(hand.length, 0, `B1 no hand-typed payoff-code list survives anywhere in the route file (${hand.join(' | ')})`);
    const bound = (route.match(/payoffLib\.FREE_AND_CLEAR_WAIVES/g) || []).length;
    eq(bound, 3, 'B2 all THREE statements bind the shared list (waive, un-waive, strip the note)');
    const anyCode = (route.match(/AND t\.code = ANY\(\$\d+::text\[\]\)/g) || []).length;
    eq(anyCode, 3, 'B3 …and all three match on it, inside this route');
  }

  // ── C. the control is offered ON the payoff condition, and there is one of it ─────────────
  {
    const screen = src('app-v2/src/screens/StaffApplication.jsx');
    ok(/case 'cond_payoff_external':\s*box = <FreeAndClearControl/.test(screen),
      'C1 the BORROWER-facing payoff condition offers free and clear — the row a processor is '
      + 'looking at when they find out there is no mortgage');
    ok(/case 'cond_payoff_internal':\s*box = <PayoffCard/.test(screen),
      'C2 …and the staff verify-payoff condition still carries the whole payoff section (2026-08-18)');

    const card = src('app-v2/src/components/PayoffCard.jsx');
    ok(!/setFreeAndClear/.test(card), 'C3 PayoffCard no longer carries its own copy of the action');
    ok(/<FreeAndClearControl/.test(card), 'C4 …it mounts the shared control');

    /* ONE definition of the question a person is asked. Two copies of a confirm dialog is how one
       surface ends up promising something the other does not do. */
    const control = src('app-v2/src/components/FreeAndClearControl.jsx');
    const wordingElsewhere = [screen, card]
      .filter((f) => /owned FREE AND CLEAR/.test(stripComments(f)));
    eq(wordingElsewhere.length, 0, 'C5 the confirmation wording exists in exactly one file');
    ok(/CONFIRM_ON/.test(control) && /CONFIRM_OFF/.test(control),
      'C6 …and it is named, so both directions are stated in one place');
    /* An --ink* token is a LIGHT paper colour in this palette and renders white-on-white. */
    ok(!/color:\s*['"`]?var\(--ink/.test(control), 'C7 no --ink* token is used as a text colour');
  }

  // ── D. the VOM ── a DECISION, not an open question ───────────────────────────────────
  {
    /* The owner hedged when they asked ("asking MAYBE for a VOM"); asked directly on 2026-08-25
       they chose to leave short-term with none. So this is not "we have not checked" — it is the
       recorded answer.

       IT IS WRITTEN AS THE RULE, NOT AS A SNAPSHOT. An `expect zero` assertion would record
       today's table and then FAIL, confusingly, on the day somebody adds a VOM with fresh owner
       sign-off — reading as "you broke something" when the truth is "you added one, now register
       it". What the owner actually asked for is that free and clear WAIVES the VOM, so that is
       what is asserted: if a VOM condition exists here at all, it must carry the ordinary
       free-and-clear exclusion, which is what puts it in the waive list via section A. With none
       present the fact is recorded and the guard is dormant. Either way nothing is invented.

       SCOPED TO SHORT-TERM, because since db/653 this table also holds the LONG-TERM library
       under `scope='lt_loan'` — including `lt_vom_subject`, the Long-Term product's OWN VOM.
       That is not a short-term VOM appearing; it is the other product's condition living in the
       shared table, governed by the Long-Term Condition Center's own rules. Reading it here
       would report the owner's recorded decision as broken and invite somebody to "fix" it by
       putting a Long-Term condition into an RTL waive list — the exact copying across products
       the note above forbids. The exclusion is a NEGATIVE so the guard still FAILS CLOSED: a
       fifth scope added later stays checked until somebody deliberately decides otherwise. */
    const vom = (await db.query(
      `SELECT code, (rule_logic::text LIKE '%property_free_and_clear%'
                 AND rule_logic::text LIKE '%is_false%') AS fc_gated
         FROM checklist_templates
        WHERE is_active AND scope <> 'lt_loan'
          AND (code ~* 'vom' OR label ~* '(verification of mortgage|\\mVOM\\M)')
        ORDER BY code`)).rows;

    if (!vom.length) {
      ok(true, 'D1 short-term carries no VOM condition — the owner\u2019s decision, recorded (2026-08-25); the Long-Term library\u2019s own VOM is that product\u2019s and is not read here');
    } else {
      /* Somebody added one. The owner's instruction was that free and clear waives it, so the
         only acceptable shape is the free-and-clear exclusion on its own rule. */
      for (const v of vom) {
        ok(v.fc_gated,
          `D1 the VOM condition ${v.code} carries the free-and-clear exclusion, so the flip waives `
          + 'it (add `property_free_and_clear is_false` to its rule_logic — section A then requires '
          + 'it in payoff.FREE_AND_CLEAR_WAIVES)');
      }
    }

    /* Hand-typed conditions carry no rule, so nothing can waive one automatically — a VOM typed
       onto a file by hand would sit open on a property with no mortgage. Recorded as a fact; if
       this ever stops being zero it is a prompt to make it a real template, not to widen the list. */
    const typed = (await db.query(
      `SELECT count(*)::int AS c FROM conditions
        WHERE (COALESCE(title,'') || ' ' || COALESCE(detail,'')) ~* '(verification of mortgage|\\mVOM\\M)'`)).rows[0].c;
    eq(typed, 0, 'D2 …and none has been hand-typed onto a file either');

    /* The cash-out letter is refinance-gated and deliberately NOT waived: it asks why the borrower
       is taking cash out, which is a question about THIS loan, not about an old mortgage. */
    ok(!payoff.FREE_AND_CLEAR_WAIVES.includes('cond_cashout_letter'),
      'D3 the cash-out letter is NOT waived — it is not a question about the old mortgage');
  }

  console.log(`${failed ? '✗' : '✓'} test-free-and-clear-condition-db: ${n - failed}/${n} checks passed`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error('test-free-and-clear-condition-db FAILED:', e); process.exit(1); });
