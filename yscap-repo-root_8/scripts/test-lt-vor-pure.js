'use strict';
/**
 * LONG-TERM — THE VERIFICATION OF RENT, proven without a database.
 *
 * WHAT THIS SUITE IS REALLY ABOUT is the ONE property everything else rests on:
 * a DocuSign anchor tab lands on a string PRINTED IN THE DOCUMENT, so the tab list
 * and the PDF are two halves of one mechanism. If an anchor is declared and not
 * drawn, DocuSign is told to ignore a missing anchor (the shared client hard-codes
 * `anchorIgnoreIfNotPresent: 'true'`), the REQUIRED question silently stops being
 * asked, and the landlord returns a form with a blank we then have to chase. So the
 * anchors are not asserted against a list — they are read back OUT of the rendered
 * PDF.
 *
 * Everything here runs with no database and no network: the desk's reads and writes
 * go through an injected client, and DocuSign is stubbed in `require.cache` before
 * the desk is loaded — a passing call against a real-looking stub proves nothing
 * unless the stub is what the code actually reached.
 */
const assert = require('assert');
const path = require('path');

let checks = 0;
function ok(name, fn) {
  fn();
  checks += 1;
  console.log(`  ok - ${name}`);
}
async function okAsync(name, fn) {
  await fn();
  checks += 1;
  console.log(`  ok - ${name}`);
}

// ── stub DocuSign BEFORE anything loads the desk ────────────────────────────
const dsPath = require.resolve('../src/lib/integrations/docusign');
const ds = {
  calls: [],
  _configured: true,
  configured() { return this._configured; },
  buildEnvelopeDefinition(def) { ds.calls.push({ kind: 'build', def }); return { built: true, def }; },
  async createEnvelope(def, opts) { ds.calls.push({ kind: 'create', def, opts }); return { envelopeId: 'ENV-1' }; },
  async voidEnvelope(id, reason) { ds.calls.push({ kind: 'void', id, reason }); return { ok: true }; },
  async getEnvelope(id) { ds.calls.push({ kind: 'get', id }); return ds.envelope || { status: 'completed' }; },
  parseRecipients(env) { return (env && env._recipients) || []; },
  verifyConnectHmac() { return true; },
  connectSignatureHeaders() { return ['sig']; },
};
require.cache[dsPath] = { id: dsPath, filename: dsPath, loaded: true, exports: ds };

const F = require('../src/longterm/vor/fields');
const { buildVorPdf } = require('../src/longterm/vor/pdf');
const vorData = require('../src/longterm/vor/data');
const desk = require('../src/longterm/vor/desk');
const claim = require('../src/longterm/routes/esign-claim');

/* Items 1 to 9 of the OWNER'S form — and nothing else, because there is nothing
   else for us to fill in. Parts II and III are the landlord's. */
const FULL = {
  landlord_block: 'Rivka Stein\nAcme Realty Management LLC\n88 Clifton Avenue, Lakewood, NJ 08701',
  lender_block: 'YS Capital Group\n5 New Montrose Avenue, #Bsmt\nBrooklyn, NY 11211',
  lender_signature: 'Chaya Gruber', lender_title: 'Loan Officer', request_date: '2026-08-30',
  loan_number: 'YSCAP258134700',
  property_address: '12 Oak Street, Lakewood, NJ 08701',
  account_name: 'Leib Lichtman',
  applicant_block: 'Leib Lichtman\n12 Oak Street, Lakewood, NJ 08701',
  applicant_signature: 'See attached signature',
};

console.log('\nLong-Term — the verification of rent\n');

(async () => {
  // ────────────────────────────────────────────────────────────────────────
  // A. The anchor is the contract
  // ────────────────────────────────────────────────────────────────────────
  const pdf = await buildVorPdf(FULL);
  const { extractText } = require('unpdf');
  const rendered = String((await extractText(new Uint8Array(pdf), { mergePages: true })).text || '');

  await okAsync('every landlord field’s anchor is DRAWN into the rendered PDF, not merely declared', () => {
    const missing = F.allAnchors().filter((a) => !rendered.includes(a));
    assert.deepStrictEqual(missing, [], `anchors declared but never drawn: ${missing.join(', ')}`);
    assert.ok(F.allAnchors().length >= 14, 'the form should ask the landlord more than a handful of questions');
  });

  ok('no two fields share an anchor — two tabs on one line leaves the other blank', () => {
    const seen = new Set();
    for (const a of F.allAnchors()) {
      assert.ok(!seen.has(a), `duplicate anchor ${a}`);
      seen.add(a);
    }
  });

  ok('the tab list is the shared client’s own shape, and the label IS the field key', () => {
    const tabs = F.tabsForLandlord();
    assert.deepStrictEqual(Object.keys(tabs).sort(), ['date', 'radio', 'sign', 'text']);
    assert.strictEqual(tabs.sign.length, 1, 'item 12, one signature');
    assert.strictEqual(tabs.date.length, 1, 'item 14, one date-signed, stamped by DocuSign');
    // The answer comes BACK keyed by tabLabel, so a label that is not the field key
    // is an answer nothing can file.
    for (const t of tabs.text) {
      assert.ok(F.BY_KEY.has(t.tabLabel), `tabLabel ${t.tabLabel} is not a field`);
      assert.strictEqual(F.BY_KEY.get(t.tabLabel).who, 'landlord');
    }
    // The form's two either/or questions are RADIO GROUPS, not pairs of boxes: a
    // landlord who ticks both, or neither, returns a form that answers nothing.
    assert.strictEqual(tabs.radio.length, 2, 'satisfactory, and arrears');
    for (const g of tabs.radio) {
      assert.ok(F.BY_KEY.has(g.group), `radio group ${g.group} is not a field`);
      assert.strictEqual(F.BY_KEY.get(g.group).who, 'landlord');
      assert.deepStrictEqual(g.radios.map((r) => r.value), ['Yes', 'No']);
      assert.strictEqual(g.required, true, 'a yes/no the underwriter needs is not optional');
    }
  });

  ok('the ONE bottom-up/top-down flip is done in one place, and every tab carries it', () => {
    // A DocuSign tab's y is measured DOWN from the top; every coordinate in
    // fields.js is the PDF one, measured UP from the bottom.
    assert.strictEqual(F.docusignY(792), 0);
    assert.strictEqual(F.docusignY(F.LANDLORD_BAND_TOP), 792 - F.LANDLORD_BAND_TOP);
    const tabs = F.tabsForLandlord();
    for (const t of tabs.text) {
      assert.strictEqual(t.yTop, F.docusignY(F.BY_KEY.get(t.tabLabel).y), `${t.tabLabel} did not go through the one conversion`);
      assert.ok(t.yTop > F.docusignY(F.LANDLORD_BAND_TOP), 'and it lands below the bar, measured from the top');
    }
    for (const g of tabs.radio) {
      const opts = F.BY_KEY.get(g.group).options;
      assert.deepStrictEqual(g.radios.map((r) => r.yTop), opts.map((o) => F.docusignY(o.y)));
    }
  });

  ok('every landlord question is REQUIRED unless the field says otherwise', () => {
    const tabs = F.tabsForLandlord();
    for (const t of tabs.text) {
      const f = F.BY_KEY.get(t.tabLabel);
      assert.strictEqual(t.required, !f.optional, `${t.tabLabel} required flag disagrees with the field`);
    }
    assert.ok(tabs.text.some((t) => t.required === true), 'at least one required question');
    assert.ok(tabs.text.some((t) => t.required === false), 'the optional comment box stays optional');
  });

  // ────────────────────────────────────────────────────────────────────────
  // B. We never answer for the landlord
  // ────────────────────────────────────────────────────────────────────────
  ok('a landlord key sent from our side is DROPPED at the door', () => {
    const cleaned = F.cleanOurData({
      account_name: 'Jane', ll_rent_amount: '2400', ll_satisfactory: 'Yes',
      ll_rented_from: '2023-04-01', nonsense: 'x',
    });
    assert.strictEqual(cleaned.account_name, 'Jane');
    assert.ok(!('ll_rent_amount' in cleaned), 'the landlord’s rent must never come from us');
    assert.ok(!('ll_satisfactory' in cleaned), 'nor whether the account is satisfactory');
    assert.ok(!('ll_rented_from' in cleaned), 'nor when the tenancy began');
    assert.ok(!('nonsense' in cleaned), 'and a key nothing recognises is not stored');
  });

  ok('OUR half is items 1 to 9 and stops at the bar — Part II and Part III are the landlord’s', () => {
    /* The defect the owner reported was prefill in PART TWO. This is that rule read
       off the field table itself, before a single byte is drawn. */
    for (const f of F.ourFields()) {
      assert.ok(f.y > F.LANDLORD_BAND_TOP, `${f.key} is ours but sits at y=${f.y}, in the landlord’s half`);
      assert.strictEqual(f.part, 'request', `${f.key} is ours but claims to be in Part ${f.part}`);
      assert.ok(Number(f.item) >= 1 && Number(f.item) <= 9, `${f.key} is ours but is item ${f.item}`);
    }
    for (const f of F.landlordFields()) {
      const ys = f.tab === 'radio' ? f.options.map((o) => o.y) : [f.y];
      for (const y of ys) assert.ok(y <= F.LANDLORD_BAND_TOP, `${f.key} is the landlord’s but sits at y=${y}`);
      assert.ok(Number(f.item) >= 10, `${f.key} is the landlord’s but is item ${f.item}`);
    }
    // Every item 1..9 of the form is accounted for, so none was quietly dropped.
    const items = new Set(F.ourFields().map((f) => f.item));
    assert.deepStrictEqual([...items].sort(), ['1', '2', '3', '4', '5', '6', '7', '8', '9']);
  });

  ok('the prefill produces no landlord answer of any kind', () => {
    // Every field the prefill can emit is one of OURS, by construction.
    const cleaned = F.cleanOurData(FULL);
    for (const k of Object.keys(cleaned)) assert.strictEqual(F.BY_KEY.get(k).who, 'us');
  });

  ok('what is still missing names only OUR half, and never an optional field', () => {
    assert.deepStrictEqual(F.missing(FULL), [], 'a complete form is complete');
    const missing = F.missing({ ...FULL, property_address: '' });
    assert.deepStrictEqual(missing, ['property_address']);
    // A file with one borrower has no co-applicant; asking for one is nonsense.
    assert.ok(!F.missing({ ...FULL, coapplicant_signature: '' }).includes('coapplicant_signature'));
    // The form itself prints "(Optional)" against item 6, so we do not demand it.
    assert.ok(!F.missing({ ...FULL, loan_number: '' }).includes('loan_number'));
    // The landlord's blanks are the POINT of the form, never a blocker.
    for (const f of F.landlordFields()) assert.ok(!F.missing(FULL).includes(f.key));
  });

  // ────────────────────────────────────────────────────────────────────────
  // C. The edit wins, and the file still teaches it
  // ────────────────────────────────────────────────────────────────────────
  ok('a person’s own edit beats the prefill, and an untouched field still learns', () => {
    const merged = vorData.mergeSaved(
      { property_address: '12 Oak Street', account_name: 'Leib Lichtman', landlord_block: 'Acme Realty' },
      { property_address: '12 Oak Street, Apt 2, Lakewood, NJ 08701' },
    );
    assert.strictEqual(merged.property_address, '12 Oak Street, Apt 2, Lakewood, NJ 08701', 'their correction stands');
    assert.strictEqual(merged.account_name, 'Leib Lichtman', 'and the file still fills in what they never touched');
    assert.strictEqual(merged.landlord_block, 'Acme Realty');
  });

  // ────────────────────────────────────────────────────────────────────────
  // D. What stops a send
  // ────────────────────────────────────────────────────────────────────────
  /* CONFIRMED, because since db/663 that is part of what "good" means: the owner
     asked for the form to be confirmed before it can go out, so a fixture without
     it is a form nobody has read through — see test-lt-vor-confirm-db.js. */
  const goodForm = { data: FULL, landlord: { name: 'Acme Realty', email: 'ap@acme.example' }, unreadable: [],
    confirmedAt: '2026-08-31T00:00:00.000Z' };
  const B = desk._internals.blockersFor;

  ok('a complete form with a landlord on file can go all three ways', () => {
    for (const method of ['docusign', 'email', 'both']) {
      assert.deepStrictEqual(B({ form: goodForm, method, envelopes: [] }), [], `${method} should be clear`);
    }
  });

  ok('each refusal is its own, and names the thing to fix', () => {
    assert.deepStrictEqual(B({ form: null, method: 'email', envelopes: [] }), ['file']);
    assert.ok(B({ form: { ...goodForm, landlord: null }, method: 'email', envelopes: [] }).includes('landlord'));
    assert.ok(B({ form: { ...goodForm, landlord: { name: 'Acme' } }, method: 'email', envelopes: [] }).includes('landlord_email'));
    assert.ok(B({ form: { ...goodForm, data: { ...FULL, property_address: '' } }, method: 'email', envelopes: [] }).includes('fields'));
    assert.ok(B({ form: { ...goodForm, unreadable: ['parties'] }, method: 'email', envelopes: [] }).includes('unreadable'));
    // THE OWNER'S GATE (db/663). A form nobody has confirmed cannot go, and the
    // refusal asks for the confirmation rather than for the fields, which are in.
    const unconfirmed = B({ form: { ...goodForm, confirmedAt: null }, method: 'email', envelopes: [] });
    assert.ok(unconfirmed.includes('not_confirmed'), 'an unconfirmed form is refused');
    assert.ok(!unconfirmed.includes('fields'), 'and it is the confirmation being asked for, not the answers');
    for (const code of ['file', 'landlord', 'landlord_email', 'fields', 'unreadable', 'in_flight', 'docusign_off', 'anchors', 'not_confirmed']) {
      assert.ok(typeof desk.BLOCKER_TEXT[code] === 'string' && desk.BLOCKER_TEXT[code].length > 12,
        `${code} needs a sentence a person can act on`);
    }
  });

  ok('DocuSign being unconfigured greys DocuSign and leaves the email alone', () => {
    ds._configured = false;
    assert.ok(B({ form: goodForm, method: 'docusign', envelopes: [] }).includes('docusign_off'));
    assert.ok(B({ form: goodForm, method: 'both', envelopes: [] }).includes('docusign_off'));
    assert.deepStrictEqual(B({ form: goodForm, method: 'email', envelopes: [] }), [],
      'an email attachment needs no DocuSign at all');
    ds._configured = true;
  });

  ok('a form already out stops another one going to the same landlord', () => {
    for (const status of desk.LIVE_ENVELOPE) {
      assert.ok(B({ form: goodForm, method: 'docusign', envelopes: [{ status }] }).includes('in_flight'),
        `${status} is still out`);
    }
    for (const status of ['completed', 'voided', 'declined', 'failed']) {
      assert.ok(!B({ form: goodForm, method: 'docusign', envelopes: [{ status }] }).includes('in_flight'),
        `${status} is finished, so a new one may go`);
    }
  });

  // ────────────────────────────────────────────────────────────────────────
  // E. Nothing is sent that would ask the landlord nothing
  // ────────────────────────────────────────────────────────────────────────
  await okAsync('a document whose anchors did not render is REFUSED, and an unreadable one too', async () => {
    const good = await desk._internals.anchorsPresent(pdf);
    assert.strictEqual(good.ok, true, 'the real form passes');
    const bad = await desk._internals.anchorsPresent(Buffer.from('not a pdf at all'));
    assert.strictEqual(bad.ok, false, 'a document we cannot read is one we do not send');
  });

  // ────────────────────────────────────────────────────────────────────────
  // F. What comes back
  // ────────────────────────────────────────────────────────────────────────
  ok('the landlord’s answers are keyed by our own field keys, and a stray tab is dropped', () => {
    const answers = desk.answersFromEnvelope({
      _recipients: [{
        textValues: {
          ll_rent_amount: ' 2450 ', ll_rented_to: 'current', ll_satisfactory: 'Yes',
          not_a_field: 'x', ll_late_12: '',
        },
      }],
    });
    assert.strictEqual(answers.ll_rent_amount, '2450', 'trimmed');
    assert.strictEqual(answers.ll_rented_to, 'current');
    // A radio group comes back under its GROUP name, which is the field key too —
    // the shared client folds it into the same map as the typed boxes.
    assert.strictEqual(answers.ll_satisfactory, 'Yes');
    assert.ok(!('not_a_field' in answers), 'a tab we did not put there is not an answer');
    assert.ok(!('ll_late_12' in answers), 'an empty tab is not an answer either');
  });

  await okAsync('a VOIDED envelope never moves again, whatever arrives late', async () => {
    const seen = [];
    const client = {
      async query(sql, params) {
        seen.push(sql.trim().split('\n')[0]);
        if (/SELECT id, loan_id, status FROM lt_vor_envelopes/.test(sql)) {
          return { rows: [{ id: 'e1', loan_id: 'L1', status: 'voided' }] };
        }
        return { rows: [] };
      },
    };
    const r = await desk.applyEnvelopeStatus('ENV-1', 'delivered', { db: client });
    assert.strictEqual(r.ignored, 'already_voided');
    assert.ok(!seen.some((s) => /UPDATE lt_vor_envelopes/.test(s)),
      'a late delivery must not put a stopped form back in flight');
  });

  await okAsync('an envelope nobody here owns is reported untracked, and nothing is written', async () => {
    const writes = [];
    const client = {
      async query(sql) {
        if (/^\s*(UPDATE|INSERT)/i.test(sql)) writes.push(sql);
        return { rows: [] };
      },
    };
    const r = await desk.applyEnvelopeStatus('SOMEBODY-ELSES', 'completed', { db: client });
    assert.strictEqual(r.reason, 'untracked');
    assert.deepStrictEqual(writes, [], 'a short-term envelope is not ours to touch');
  });

  await okAsync('an unrecognised status is ignored rather than guessed at', async () => {
    const writes = [];
    const client = {
      async query(sql) {
        if (/SELECT id, loan_id, status FROM lt_vor_envelopes/.test(sql)) return { rows: [{ id: 'e1', loan_id: 'L1', status: 'sent' }] };
        if (/^\s*(UPDATE|INSERT)/i.test(sql)) writes.push(sql);
        return { rows: [] };
      },
    };
    const r = await desk.applyEnvelopeStatus('ENV-1', 'correcting', { db: client });
    assert.strictEqual(r.ignored, 'correcting');
    assert.deepStrictEqual(writes, []);
  });

  // ────────────────────────────────────────────────────────────────────────
  // G. A manual return voids what is out — OUR row first
  // ────────────────────────────────────────────────────────────────────────
  await okAsync('a manual return records the answer AND voids every form still out', async () => {
    ds.calls.length = 0;
    const order = [];
    const client = {
      async query(sql, params) {
        const head = sql.trim().split('\n')[0];
        order.push(head);
        if (/SELECT id, envelope_id, status/.test(sql)) {
          return { rows: [{ id: 'e1', envelope_id: 'ENV-1', status: 'sent' }, { id: 'e2', envelope_id: null, status: 'completed' }] };
        }
        if (/INSERT INTO lt_vor_returns/.test(sql)) return { rows: [{ id: 'r1' }] };
        return { rows: [] };
      },
    };
    const r = await desk.recordManualReturn('L1', { note: 'The landlord emailed it back signed.', staffId: 'S1' }, client);
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.voided.length, 1, 'only the one still out');
    assert.strictEqual(r.voided[0].provider, 'voided');
    // OUR row is written before the provider is told: a DocuSign outage must never
    // lose the fact that a person filled the form in.
    const ourVoid = order.findIndex((s) => /UPDATE lt_vor_envelopes SET status = 'voided'/.test(s));
    const providerCall = ds.calls.findIndex((c) => c.kind === 'void');
    assert.ok(ourVoid >= 0 && providerCall >= 0, 'both happen');
    const insert = order.findIndex((s) => /INSERT INTO lt_vor_returns/.test(s));
    assert.ok(insert < ourVoid, 'the return is recorded first of all');
  });

  await okAsync('DocuSign refusing the void still leaves the form voided HERE, with the reason kept', async () => {
    ds.calls.length = 0;
    ds.voidEnvelope = async () => { throw new Error('DocuSign is unreachable'); };
    const errors = [];
    const client = {
      async query(sql, params) {
        if (/SELECT id, envelope_id, status/.test(sql)) return { rows: [{ id: 'e1', envelope_id: 'ENV-1', status: 'sent' }] };
        if (/INSERT INTO lt_vor_returns/.test(sql)) return { rows: [{ id: 'r1' }] };
        if (/SET last_error/.test(sql)) errors.push(params[1]);
        return { rows: [] };
      },
    };
    const r = await desk.recordManualReturn('L1', { note: 'Handed over at the closing table.' }, client);
    assert.strictEqual(r.ok, true, 'the return is still recorded');
    assert.ok(/^failed: /.test(r.voided[0].provider), 'and the failure is reported, never silent');
    assert.ok(errors.some((e) => /unreachable/i.test(e)), 'the reason is kept on the row');
    ds.voidEnvelope = async (id, reason) => { ds.calls.push({ kind: 'void', id, reason }); return { ok: true }; };
  });

  await okAsync('a manual return with no explanation is refused — the note is the only record afterwards', async () => {
    const writes = [];
    const client = { async query(sql) { if (/^\s*INSERT/i.test(sql)) writes.push(sql); return { rows: [] }; } };
    const r = await desk.recordManualReturn('L1', { note: 'ok' }, client);
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.reason, 'note');
    assert.deepStrictEqual(writes, [], 'and nothing is recorded');
  });

  // ────────────────────────────────────────────────────────────────────────
  // H. The claim on the shared DocuSign webhook
  // ────────────────────────────────────────────────────────────────────────
  ok('the envelope is found in every payload shape Connect sends', () => {
    const c = claim._internals.correlate;
    assert.deepStrictEqual(c({ event: 'envelope-completed', data: { envelopeId: 'A' } }),
      { envelopeId: 'A', status: 'completed' });
    assert.deepStrictEqual(c({ data: { envelopeSummary: { envelopeId: 'B', status: 'Delivered' } } }),
      { envelopeId: 'B', status: 'delivered' });
    assert.deepStrictEqual(c({ envelopeStatus: { envelopeId: 'C', status: 'Voided' } }),
      { envelopeId: 'C', status: 'voided' });
    assert.deepStrictEqual(c({}), { envelopeId: null, status: null });
    // An unrecognised event never becomes a guessed status.
    assert.strictEqual(c({ event: 'recipient-something', data: { envelopeId: 'D' } }).status, null);
  });

  // ────────────────────────────────────────────────────────────────────────
  // I. Structural guards — the shapes that must not come back
  // ────────────────────────────────────────────────────────────────────────
  const fs = require('fs');
  const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');
  /* A guard that reads a file's own PROSE fails on the explanation of the very rule
     it protects, and then gets "fixed" by deleting the explanation. Comments first. */
  const strip = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');

  ok('there is no door that takes PDF bytes from a browser', () => {
    const route = strip(read('src/longterm/routes/vor.js'));
    assert.ok(!/upload|multipart|pdfBase64|dataBase64/i.test(route),
      'a hand-edited PDF cannot be re-anchored, so its required questions would stop being asked');
    assert.ok(/preview\.pdf/.test(route), 'the PDF is rendered by us and served, never received');
  });

  ok('the claim is mounted IN FRONT of the short-term receiver on the shared endpoint', () => {
    const server = read('src/server.js');
    const lt = server.indexOf("app.use('/api/esign/webhook', require('./longterm/routes/esign-claim'))");
    const rtl = server.indexOf("app.use('/api/esign/webhook', require('./routes/esign-webhook'))");
    assert.ok(lt > 0, 'the long-term claim is mounted');
    assert.ok(rtl > lt, 'and it runs BEFORE the short-term route, or the event is swallowed as untracked');
  });

  ok('the long-term side never reads a short-term table for any of this', () => {
    for (const p of ['src/longterm/vor/desk.js', 'src/longterm/vor/data.js', 'src/longterm/vor/fields.js',
      'src/longterm/vor/pdf.js', 'src/longterm/routes/vor.js', 'src/longterm/routes/esign-claim.js']) {
      const src = strip(read(p));
      /* The test is a SQL REFERENCE, not the bare word: `documents:` is DocuSign's
         own envelope-definition key and `applications` is ordinary English. A guard
         that matched either would be "fixed" by loosening it, which is how a real
         crossing eventually gets waved through. */
      const RTL_TABLE = /\b(?:FROM|JOIN|INTO|UPDATE)\s+(esign_envelopes|docusign_event_inbox|applications|checklist_items|documents)\b/i;
      assert.ok(!RTL_TABLE.test(src), `${p} reaches a short-term table in SQL`);
    }
  });

  ok('the desk never uses a dynamic require — the separation gate cannot see where one points', () => {
    for (const p of ['src/longterm/vor/desk.js', 'src/longterm/vor/data.js', 'src/longterm/vor/pdf.js',
      'src/longterm/vor/fields.js', 'src/longterm/routes/vor.js', 'src/longterm/routes/esign-claim.js']) {
      assert.ok(!/require\s*\(\s*[^'")]/.test(strip(read(p))), `${p} has a computed require`);
    }
  });

  ok('the reconcile pass is wired into the worker — a webhook is a nudge, not the machinery', () => {
    const worker = read('src/longterm/sync/worker.js');
    assert.ok(/vorDesk\.reconcileOpenEnvelopes/.test(worker),
      'a lost Connect delivery is SILENT: the landlord signs and nobody hears');
    assert.ok(/require\('\.\.\/vor\/desk'\)/.test(worker), 'and the desk is actually imported');
  });

  ok('the reconcile pass PACES itself to DocuSign\'s polling policy — one question per envelope per 15 minutes', () => {
    const src = strip(read('src/longterm/vor/desk.js'));
    const fn = src.slice(src.indexOf('async function reconcileOpenEnvelopes'), src.indexOf('function answersFromEnvelope'));
    assert.ok(/docusign_checked_at IS NULL/.test(fn) && /docusign_checked_at < now\(\) - \(\$3 \|\| ' minutes'\)::interval/.test(fn),
      'the SELECT skips an envelope asked about inside the window — the tick is every 5 minutes, the policy is 15');
    assert.ok(/String\(POLL_EVERY_MIN\)/.test(fn), 'and the window is the ONE constant, bound as a parameter');
    const stampAt = fn.indexOf('SET docusign_checked_at = now()');
    const askAt = fn.indexOf('docusign.getEnvelope(');
    assert.ok(stampAt > 0 && askAt > 0 && stampAt < askAt,
      'the stamp is written BEFORE DocuSign is asked, so a failing read is paced like a successful one');
    assert.ok(/continue;\s*\/\/ never ask DocuSign about a row the pass cannot pace/.test(fn) || /continue;/.test(fn.slice(stampAt, askAt)),
      'and a row whose stamp could not be written is not asked about at all');
    const desk = require('../src/longterm/vor/desk');
    assert.ok(desk.POLL_EVERY_MIN >= 15, `the window is never below 15 minutes (got ${desk.POLL_EVERY_MIN})`);
    assert.ok(/Math\.max\(15, asked\)/.test(src), 'LT_VOR_DOCUSIGN_POLL_MIN may only RAISE the window, never lower it');
    const mig = read('db/684_lt_vor_envelope_poll_cadence.sql');
    assert.ok(/ADD COLUMN IF NOT EXISTS docusign_checked_at timestamptz/.test(mig), 'the stamp column ships in its own lt_ migration');
    const prisma = read('src/longterm/prisma/schema.prisma');
    assert.ok(/docusignCheckedAt DateTime\? @map\("docusign_checked_at"\)/.test(prisma), 'and the Long-Term model declares it in the same commit');
  });

  console.log(`\ntest-lt-vor-pure: ${checks} checks passed\n`);
})().catch((e) => {
  console.error('\nFAILED:', e && e.message);
  console.error(e && e.stack);
  process.exit(1);
});
