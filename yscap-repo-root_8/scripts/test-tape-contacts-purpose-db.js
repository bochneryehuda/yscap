'use strict';
/**
 * THE TAPE DESK IS NOT THE DRAW TEAM (owner-reported 2026-08-21: "It's
 * automatically filling in the FileContacts as those same as the draw. It's a
 * different contact.").
 *
 * db/454 built `investor_delivery_contacts` for the DRAW delivery, keyed on the
 * note buyer ALONE, and the 2026-08-18 tape send read the same book -- so the
 * people who release construction money were prefilled as the people who review
 * a new file for purchase. db/602 gives a contact its PURPOSE.
 *
 * This proves, against a real Postgres:
 *   - the DRAW list is byte-for-byte what it was; nothing about draws moved;
 *   - the TAPE list is the owner's own addresses, and only those;
 *   - a real EMCAP label ("EMCAP Financial") finds them, which needs the key
 *     fold -- without it the seed key 'emcap' is unreachable on a live file;
 *   - sending to a new address ADDS it to the tape list without touching the
 *     draw list, and a person on BOTH lists keeps both;
 *   - the extra Cc rides VISIBLY and is never doubled with the To line.
 *
 * Run: DATABASE_URL=... node scripts/test-tape-contacts-purpose-db.js
 */
if (!process.env.DATABASE_URL) { console.log('SKIP test-tape-contacts-purpose-db (no DATABASE_URL)'); process.exit(0); }

const db = require('../src/db');
const send = require('../src/sitewire/investor-delivery-send');
const IS = require('../src/lib/tapes/investor-send');

let pass = 0, fail = 0;
const ok = (name, cond) => { if (cond) { pass++; } else { fail++; console.error('  FAIL:', name); } };
const emails = (rows) => rows.map((r) => String(r.email).toLowerCase()).sort();

(async () => {
  // ---- the key fold ---------------------------------------------------------
  ok('A1 every Fidelis spelling folds onto one key',
    send.investorKeyFor('Fidelis') === 'fidelis'
    && send.investorKeyFor('Fidelis Investors LLC') === 'fidelis'
    && send.investorKeyFor('FIDELIS INVESTMENTS LLC') === 'fidelis');
  // Without this fold the production label normalizes to 'emcapfinancial' and the
  // seeded 'emcap' contact list is unreachable on every real EMCAP file.
  ok('A2 every EMCAP spelling folds onto one key',
    send.investorKeyFor('EMCAP') === 'emcap'
    && send.investorKeyFor('EMCAP Financial') === 'emcap'
    && send.investorKeyFor('emcap financial llc') === 'emcap');
  ok('A3 a DIFFERENT buyer is never folded into either',
    send.investorKeyFor('Blue Lake Capital') === 'bluelakecapital'
    && send.investorKeyFor('Fidelity National') !== 'fidelis');
  ok('A4 a blank buyer has no key at all', send.investorKeyFor('') === null && send.investorKeyFor(null) === null);

  // ---- the two lists are different people -----------------------------------
  const drawF = await send.contactsForNoteBuyer('Fidelis Investors LLC');            // default purpose
  const tapeF = await send.contactsForNoteBuyer('Fidelis Investors LLC', { purpose: 'tape' });
  ok('B1 the DRAW list is the draw team, unchanged by db/602',
    drawF.length === 3 && emails(drawF).join(',')
      === 'cquintano@fidelis-investors.com,drawrequest@fidelis-investors.com,jcarara@fidelis-investors.com');
  ok('B2 the TAPE list is the owner\'s tape address, and ONLY that',
    tapeF.length === 1 && tapeF[0].email === 'mbrancatella@fidelis-investors.com');
  ok('B3 the two lists share nobody -- that IS the reported bug',
    !emails(drawF).some((e) => emails(tapeF).includes(e)));
  ok('B4 omitting the purpose still reads the DRAW list (every pre-db/602 caller unchanged)',
    JSON.stringify(emails(await send.contactsForNoteBuyer('Fidelis'))) === JSON.stringify(emails(drawF)));

  const tapeE = await send.contactsForNoteBuyer('EMCAP Financial', { purpose: 'tape' });
  ok('C1 EMCAP tape contacts are the owner\'s two, found through the real production label',
    emails(tapeE).join(',') === 'bdetommaso@emcapfinancial.com,tmartello@emcapfinancial.com');
  ok('C2 EMCAP has no draw contacts, and none were invented',
    (await send.contactsForNoteBuyer('EMCAP Financial')).length === 0);
  ok('C3 an unknown buyer has neither list, rather than somebody else\'s',
    (await send.contactsForNoteBuyer('Nobody Capital', { purpose: 'tape' })).length === 0);

  // ---- saving a recipient touches the TAPE list only ------------------------
  const fresh = `tape.test.${Date.now().toString(36)}@example.com`;
  await IS.saveRecipients(db, 'Fidelis Investors LLC', [fresh], null);
  ok('D1 a newly-used address joins the TAPE list',
    emails(await send.contactsForNoteBuyer('Fidelis', { purpose: 'tape' })).includes(fresh));
  ok('D2 ...and the DRAW list is untouched',
    JSON.stringify(emails(await send.contactsForNoteBuyer('Fidelis'))) === JSON.stringify(emails(drawF)));

  // A person who genuinely handles BOTH keeps both memberships -- the array is
  // added to, never replaced. This is why `purposes` is an array and not a column.
  await IS.saveRecipients(db, 'Fidelis Investors LLC', ['jcarara@fidelis-investors.com'], null);
  const both = (await db.query(
    `SELECT purposes FROM investor_delivery_contacts WHERE label_norm='fidelis' AND lower(email)=$1`,
    ['jcarara@fidelis-investors.com'])).rows[0];
  ok('D3 an existing DRAW contact used for a tape keeps BOTH purposes',
    both && both.purposes.includes('draw') && both.purposes.includes('tape'));
  ok('D4 ...so they now appear on both lists',
    emails(await send.contactsForNoteBuyer('Fidelis')).includes('jcarara@fidelis-investors.com')
    && emails(await send.contactsForNoteBuyer('Fidelis', { purpose: 'tape' })).includes('jcarara@fidelis-investors.com'));

  // Re-running the save adds nothing a second time.
  await IS.saveRecipients(db, 'Fidelis Investors LLC', ['jcarara@fidelis-investors.com'], null);
  const again = (await db.query(
    `SELECT purposes FROM investor_delivery_contacts WHERE label_norm='fidelis' AND lower(email)=$1`,
    ['jcarara@fidelis-investors.com'])).rows[0];
  ok('D5 saving the same address twice does not stack purposes', again.purposes.length === 2);

  // ---- the extra Cc, on the wire -------------------------------------------
  // A send against the noop mail provider proves nothing about what went out, so
  // the mailer is stubbed and the PAYLOAD is asserted (the house rule).
  const mail = require('../src/lib/email');
  const realSend = mail.sendMail;
  let captured = null;
  mail.sendMail = async (m) => { captured = m; return { ok: true, id: 'stub' }; };
  try {
    const app = (await db.query(`SELECT a.id FROM applications a ORDER BY a.created_at LIMIT 1`)).rows[0];
    if (!app) { ok('E0 (skipped -- no application row to send against)', true); }
    else {
      const out = await IS.sendTapeToInvestor(app.id, db, {
        tape: { buf: Buffer.from('PKstub'), filename: 't.xlsx', contentType: 'application/vnd.ms-excel' },
        to: ['investor@example.com', 'INVESTOR@example.com'],
        cc: ['Extra Person <EXTRA@example.com>', 'investor@example.com'],
        note: 'hello',
      });
      ok('E1 the To line is deduped case-insensitively', out.to.length === 1 && out.to[0] === 'investor@example.com');
      ok('E2 the typed extra rides in the Cc', out.cc.includes('extra@example.com'));
      ok('E3 nobody is on BOTH lines -- one person, one email',
        !out.cc.some((c) => out.to.includes(c)));
      ok('E4 the Cc is VISIBLE on the wire, never a Bcc (a reply-all must reach everyone)',
        captured && Array.isArray(captured.cc) && captured.cc.includes('extra@example.com') && !captured.bcc);
      ok('E5 exactly one attachment -- the tape', captured.attachments.length === 1);
      ok('E6 the body still never names an origination fee',
        !/originat/i.test(String(captured.text || '') + String(captured.html || '')));
      ok('E7 the body never carries the retired effective-LTV figure',
        !/effective ltv/i.test(String(captured.text || '')));

      // A bad extra address refuses the WHOLE send -- never a partial one.
      captured = null;
      let refused = null;
      try {
        await IS.sendTapeToInvestor(app.id, db, {
          tape: { buf: Buffer.from('x'), filename: 't.xlsx', contentType: 'application/vnd.ms-excel' },
          to: ['investor@example.com'], cc: ['not-an-address'],
        });
      } catch (e) { refused = e; }
      ok('E8 a bad Cc address refuses the send, naming it, and nothing goes out',
        refused && refused.status === 400 && /not a valid email/.test(refused.message) && captured === null);

      // A tape-purpose contact is what the compose screen offers.
      const pre = await IS.previewTapeSend(app.id, db);
      ok('E9 the compose screen reads the TAPE list (never the draw one)',
        pre && Array.isArray(pre.contacts)
        && !pre.contacts.some((c) => c.email === 'drawrequest@fidelis-investors.com'));
    }
  } finally { mail.sendMail = realSend; }

  // Clean up only what this run created.
  await db.query(`DELETE FROM investor_delivery_contacts WHERE lower(email)=$1`, [fresh]);
  await db.query(
    `UPDATE investor_delivery_contacts SET purposes = ARRAY['draw']::text[]
      WHERE label_norm='fidelis' AND lower(email)='jcarara@fidelis-investors.com'`);

  console.log(`test-tape-contacts-purpose-db: ${pass} passed, ${fail} failed`);
  await db.end?.();
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
