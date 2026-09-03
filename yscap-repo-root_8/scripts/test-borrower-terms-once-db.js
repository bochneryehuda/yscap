'use strict';
/**
 * THE BORROWER IS TOLD THEIR TERMS ONCE PER CHANGE — against a real database,
 * through the real door (terms-notify.sendBorrowerTerms → notify.notifyAppBorrowers).
 * Owner-reported 2026-09-03: an experience edit re-registered a file and the
 * borrower got a "product registered" email although nothing they could see had
 * moved.
 *
 *   A. first send → one notification row, one memory row (db/692)
 *   B. the SAME borrower-visible numbers again (an experience-only re-register
 *      — different product label, same numbers) → NO second notification
 *   C. a rate change → a second notification, the memory updated
 *   D. force → a third, even though nothing changed ("re-send", a person's ask)
 *   E. the memory unreadable → the door FAILS OPEN and sends
 *
 * The email provider is 'noop' here, so the proof is the in-app notification
 * row `notify` always writes. Requires DATABASE_URL; skips otherwise.
 */
if (!process.env.DATABASE_URL) { console.log('SKIP test-borrower-terms-once-db (no DATABASE_URL)'); process.exit(0); }
process.env.SSN_ENCRYPTION_KEY = process.env.SSN_ENCRYPTION_KEY || '0'.repeat(64);
process.env.JWT_SECRET = process.env.JWT_SECRET || 'testsecrettestsecrettestsecret12';
process.env.EMAIL_PROVIDER = 'noop';

const db = require('../src/db');
const tn = require('../src/lib/terms-notify');

let failures = 0; let n = 0;
const assert = (c, m) => { n++; console.log(`${c ? 'PASS' : 'FAIL'} ${m}`); if (!c) failures++; };

const quote = (over = {}) => ({
  program: 'standard', productLabel: 'Experienced (4+)', noteRate: 10.99, cashToClose: 61234, origination: 3750,
  status: 'ELIGIBLE', programLabel: 'Standard Program',
  sizing: { totalLoan: 187500, rehabHoldback: 40000, financedReserve: 0, initialAdvance: 147500, purchasePrice: 250000 },
  ...over,
});

(async () => {
  const sfx = `${process.pid}-${Date.now()}`;
  let borrowerId;
  try {
    borrowerId = (await db.query(
      `INSERT INTO borrowers (first_name,last_name,email) VALUES ('Terms','Once',$1) RETURNING id`, [`terms-once-${sfx}@test.local`])).rows[0].id;
    const appId = (await db.query(
      `INSERT INTO applications (borrower_id, status, program, purchase_price, arv, rehab_budget)
       VALUES ($1,'processing','Fix & Flip With Construction',250000,400000,40000) RETURNING id`, [borrowerId])).rows[0].id;
    const count = async () => (await db.query(
      `SELECT count(*)::int n FROM notifications WHERE application_id=$1 AND recipient_kind='borrower' AND type='term_sheet'`, [appId])).rows[0].n;
    const memory = async () => (await db.query(`SELECT terms_key, send_count, last_reason FROM borrower_terms_sent WHERE application_id=$1`, [appId])).rows[0] || null;

    console.log('\nA. the first time');
    const a = await tn.sendBorrowerTerms(appId, { quote: quote(), total: 187500, termMonths: 12 });
    assert(a && a.sent === true && a.reason === 'first', `sent, reason "first" (${JSON.stringify(a && { sent: a.sent, reason: a.reason })})`);
    assert(await count() === 1, 'one borrower notification row');
    const m1 = await memory();
    assert(m1 && m1.send_count === 1 && m1.last_reason === 'first', 'the memory remembers what was sent');

    console.log('\nB. THE ONE THAT MATTERS: an experience-only re-register — new label, same numbers');
    const b = await tn.sendBorrowerTerms(appId, { quote: quote({ productLabel: 'Experienced (3)' }), total: 187500, termMonths: 12 });
    assert(b && b.sent === false && b.reason === 'unchanged', `NOT sent, reason "unchanged" (${JSON.stringify(b && { sent: b.sent, reason: b.reason })})`);
    assert(await count() === 1, 'still one notification — the borrower is not told twice about the same terms');
    assert((await memory()).send_count === 1, 'the memory is untouched by a non-send');

    console.log('\nC. a number the borrower sees moves');
    const c = await tn.sendBorrowerTerms(appId, { quote: quote({ noteRate: 11.25 }), total: 187500, termMonths: 12 });
    assert(c && c.sent === true && c.reason === 'changed', 'sent, reason "changed"');
    assert(await count() === 2, 'a second notification');
    const m3 = await memory();
    assert(m3.send_count === 2 && m3.terms_key !== m1.terms_key, 'the memory moved with it');

    console.log('\nD. a person asks for a re-send');
    const d = await tn.sendBorrowerTerms(appId, { quote: quote({ noteRate: 11.25 }), total: 187500, termMonths: 12, force: true });
    assert(d && d.sent === true && d.reason === 'forced' && await count() === 3, 'force sends the same terms again, and says why');

    console.log('\nE. an unreadable memory fails OPEN');
    await db.query(`ALTER TABLE borrower_terms_sent RENAME TO borrower_terms_sent_hidden`);
    let e;
    try { e = await tn.sendBorrowerTerms(appId, { quote: quote({ noteRate: 11.25 }), total: 187500, termMonths: 12 }); }
    finally { await db.query(`ALTER TABLE borrower_terms_sent_hidden RENAME TO borrower_terms_sent`); }
    assert(e && e.sent === true && await count() === 4, 'with no memory to read, the door sends — as it always did');

    console.log(failures ? `\n${failures} of ${n} assertion(s) failed` : `\nALL ${n} borrower-terms-once assertions passed`);
  } catch (err) {
    console.error('ERROR', err); failures++;
  } finally {
    try { if (borrowerId) await db.query(`DELETE FROM borrowers WHERE id=$1`, [borrowerId]); } catch (_) {}
    try { await db.end(); } catch (_) {}
  }
  process.exit(failures ? 1 : 0);
})();
