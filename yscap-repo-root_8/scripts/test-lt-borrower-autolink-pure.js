'use strict';
/**
 * THE OBVIOUS BORROWER MATCHES CONFIRM THEMSELVES — AND ONLY THE OBVIOUS ONES.
 *
 * The expensive failure is not a crash; it is a WRONG link, which hands one
 * client another client's loan on their own login. So what this suite pins is
 * the boundary: email-matched AND name-agreeing confirms with the trail saying
 * 'auto'; the same email with a genuinely different name is HELD for a human;
 * a refusal from the confirm door's own guards is counted, never retried into;
 * and the switch stops the whole thing without a deploy.
 */
const assert = require('assert');
let checks = 0;
const ok = (c, w) => { assert.ok(c, w); console.log('  ok  ', w); checks += 1; };
const eq = (a, b, w) => { assert.strictEqual(a, b, `${w} (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`); console.log('  ok  ', w); checks += 1; };

const autolink = require('../src/longterm/borrower-autolink');

/** deps with a scripted matcher and a recording confirm door. */
function deps(suggestions, confirmBehaviour) {
  const confirms = [];
  return {
    confirms,
    db: { query: async (sql) => (/FROM lt_loans/.test(sql)
      ? { rows: [{ id: 'L1', borrower_email: 'a@b.c' }] } : { rows: [] }) },
    links: {
      loadLinks: async () => [],
      confirmLink: async (email, borrowerId, actorId, opts) => {
        confirms.push({ email, borrowerId, actorId, method: opts && opts.method });
        if (confirmBehaviour) return confirmBehaviour(email);
        return { ok: true };
      },
    },
    match: { matchBorrowers: () => ({ suggestions }) },
    loadSettings: async () => ({}),
  };
}

(async () => {
  console.log('A. the boundary: nameAgrees confirms, anything else is held');
  {
    const d = deps([
      { email: 'same@x.com', borrowerId: 'B1', nameAgrees: true },
      { email: 'other@x.com', borrowerId: 'B2', nameAgrees: false },   // same email, different person's name
    ]);
    const out = await autolink.autoLinkPass(d);
    eq(d.confirms.length, 1, 'exactly ONE confirmation went out');
    eq(d.confirms[0].email, 'same@x.com', 'the name-agreeing one');
    eq(out.read, 1, 'reported as one linked');
    eq(out.skipped, 1, 'and the different-name one is HELD for a human, said as skipped');
  }

  console.log('\nB. the confirmation is recognisably automatic, forever');
  {
    const d = deps([{ email: 'a@x.com', borrowerId: 'B1', nameAgrees: true }]);
    await autolink.autoLinkPass(d);
    eq(d.confirms[0].actorId, null, 'no human is named as the actor — nobody gets credit for a machine\'s call');
    eq(d.confirms[0].method, 'auto', 'and the method says auto, so it is distinguishable from a button press forever');
  }

  console.log('\nC. a refusal from the door\'s own guards is an answer, not a crash');
  {
    const d = deps(
      [{ email: 'a@x.com', borrowerId: 'B1', nameAgrees: true },
       { email: 'multi@x.com', borrowerId: 'B2', nameAgrees: true }],
      (email) => { if (email === 'multi@x.com') { const e = new Error('more than one borrower name on that email'); throw e; } return { ok: true }; },
    );
    const out = await autolink.autoLinkPass(d);
    eq(out.read, 1, 'the clean one linked');
    eq(out.failed, 1, 'the refused one is counted');
    ok(/more than one borrower name/.test(out.problems[0].reason), 'with the door\'s own reason carried for the log');
  }

  console.log('\nD. the switch');
  {
    process.env.LT_BORROWER_AUTOLINK_ENABLED = '0';
    const d = deps([{ email: 'a@x.com', borrowerId: 'B1', nameAgrees: true }]);
    const out = await autolink.autoLinkPass(d);
    eq(d.confirms.length, 0, 'off means not one write');
    ok(/switched off/.test(out.reason), 'and it says so');
    delete process.env.LT_BORROWER_AUTOLINK_ENABLED;
  }

  console.log(`\nall good — ${checks} checks`);
})().catch((e) => { console.error('\nFAILED:', e && e.message); process.exit(1); });
