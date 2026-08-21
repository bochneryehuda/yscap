'use strict';
/* THE GENERAL CONTRACTOR'S RECORD AND ITS SHEET — the rules and the page (db/605).
 *
 * Owner-reported 2026-08-21: "The GC information condition now only has an upload
 * document slot. Keep that slot as an optional slot … You need to add that condition to
 * be informational, to put in: the name / the phone number / the email address / license
 * information … Don't make all the fields required. Maybe business name is optional. And
 * then, in the TPR export and in the SharePoint sync, you need to take this information
 * and lay it out on a PDF GC contractor information nicely."
 *
 * Pure — no database. Both modules are importable with no DATABASE_URL, which is the
 * point of the lazy require in gc-record: a rule that opens a connection just to be read
 * is a rule a test cannot reach.
 */
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`  ok   ${m}`); } else { fail++; console.log(`  FAIL ${m}`); } };

const GC = require('../src/lib/contractor/gc-record');
const { buildGcPdf, _internals } = require('../src/lib/contractor/gc-pdf');

console.log('\nA. what a contractor record is');
ok(GC.CREDENTIAL_FIELDS.length >= 10, 'the record carries more than a name and a phone number');
{
  const keys = GC.CREDENTIAL_FIELDS.map((f) => f.key);
  // Each of these answers a question a lender or an investor actually asks, and each was
  // missing before: a licence is per-STATE (the number alone is not checkable), and general
  // liability and workers' comp are two different policies from two different carriers.
  for (const k of ['license_number', 'license_state', 'license_expires_on',
    'gl_carrier', 'gl_policy_number', 'gl_expires_on',
    'wc_carrier', 'wc_policy_number', 'wc_expires_on', 'ein']) {
    ok(keys.includes(k), `the record carries ${k}`);
  }
  ok(new Set(keys).size === keys.length, 'no field is listed twice');
  ok(GC.CREDENTIAL_FIELDS.every((f) => f.label && f.label.trim()), 'every field has words a person can read');
}

console.log('\nB. nothing is required — the owner said so, and a builder pays in instalments');
ok(GC.credentialProblem({}) === '', 'an empty save is fine');
ok(GC.credentialProblem({ license_number: '', gl_carrier: '' }) === '', 'blanks are fine');
ok(GC.credentialProblem({ license_number: '13VH01234500' }) === '', 'one field alone is fine');
ok(GC.credentialProblem({ license_expires_on: '2027-03-31' }) === '', 'a real date is fine');
ok(/real date/.test(GC.credentialProblem({ license_expires_on: '31/03/2027' })), 'a date in the wrong shape is refused, in words');
ok(/real date/.test(GC.credentialProblem({ license_expires_on: '2026-02-31' })), 'and so is a date that does not exist');
ok(/under/i.test(GC.credentialProblem({ gl_carrier: 'x'.repeat(500) })), 'an absurd value is refused with the limit named');
ok(GC.credentialProblem({ ein: {} }) !== '', 'something that is not text is refused rather than stringified into nonsense');

console.log('\nC. what is stored');
{
  const c = GC.cleanCredentials({ license_state: 'nj', gl_carrier: '  Hartford  ', wc_carrier: '', license_expires_on: '2027-03-31' });
  ok(c.license_state === 'NJ', 'a state is stored the way a register spells it');
  ok(c.gl_carrier === 'Hartford', 'values are trimmed');
  ok(c.wc_carrier === null, 'a cleared field is NOTHING, never an empty string');
  ok(c.license_expires_on === '2027-03-31', 'a date stays a calendar string — never a timestamp, never a Date');
  ok(!('ein' in GC.cleanCredentials({ license_state: 'NJ' })), 'a key nobody sent is not touched — a save of one field cannot blank the rest');
}

console.log('\nD. is there anything worth printing');
ok(GC.hasAnything(null) === false && GC.hasAnything({}) === false, 'an empty record has nothing to say');
ok(GC.hasAnything({ company_name: 'Kraft Builders' }) === true, 'a name is enough');
ok(GC.hasAnything({ license_number: '13VH1' }) === true, '…and so is a licence with no name yet');
ok(GC.hasAnything({ company_name: '   ' }) === false, 'whitespace is not a record');

console.log('\nE. the sheet');
{
  let threw = false;
  try { buildGcPdf({}, {}, {}); } catch (_) { threw = true; }
  ok(threw, 'an empty record makes NO sheet — a page of dashes would ride into an investor package implying a record exists');

  const rec = { company_name: 'Kraft Builders LLC', contact_name: 'Moshe Kraft', phone: '732-555-0140',
    email: 'moshe@kraftbuilders.com', address: '12 Cedar Ave, Lakewood, NJ 08701',
    license_number: '13VH01234500', license_state: 'NJ', license_expires_on: '2027-03-31',
    gl_carrier: 'Hartford', gl_policy_number: 'GL-88231', gl_expires_on: '2026-05-01',
    wc_carrier: 'NJM', wc_policy_number: 'WC-4471', wc_expires_on: '2027-01-15',
    ein: '82-1234567', notes: 'Approved for ground-up.' };
  const buf = buildGcPdf(rec, { loanNo: 'YSCAP258134859', address: '598 Pawling Ave', borrowerName: 'M Scharf' }, { today: '2026-08-21' });
  ok(Buffer.isBuffer(buf) && buf.slice(0, 5).toString() === '%PDF-', 'a real PDF comes out');

  const text = pdfText(buf);
  for (const want of ['General Contractor Information', 'Kraft Builders LLC', '732-555-0140', '13VH01234500',
    'Hartford', 'GL-88231', 'NJM', 'WC-4471', '82-1234567', 'YSCAP258134859']) {
    ok(text.includes(want), `the sheet actually prints ${want}`);
  }
  ok(/03\/31\/2027/.test(text), 'dates print the way every other document here prints them');
  // The one thing a reader cannot work out for themselves at a glance.
  ok(/05\/01\/2026\s*\(expired\)/.test(text), 'a policy that has already lapsed SAYS SO — that is the whole reason expiries are recorded');
  ok(!/01\/15\/2027\s*\(expired\)/.test(text), '…and one that has not is left alone');
  ok(/A field that is blank was not recorded/.test(text),
    'and the sheet says a blank is a blank — never "there is no licence"');

  // A sparse record prints a short sheet, not a long one full of dashes.
  const sparse = pdfText(buildGcPdf({ company_name: 'Solo Builder', phone: '555-0100' }, {}, { today: '2026-08-21' }));
  ok(sparse.includes('Solo Builder') && !/LICENSE|INSURANCE|TAX/.test(sparse),
    'a record with only a name and a phone prints only those — no empty License or Insurance headings');
}

console.log('\nF. the modules are readable with no database');
ok(!/^\s*const db = require/m.test(require('fs').readFileSync(require('path').join(__dirname, '..', 'src/lib/contractor/gc-record.js'), 'utf8')),
  'gc-record requires the database LAZILY — reading the field list must not open a connection');
ok(!/require\('\.\.\/\.\.\/db'\)/.test(require('fs').readFileSync(require('path').join(__dirname, '..', 'src/lib/contractor/gc-pdf.js'), 'utf8')),
  'and the PDF builder never touches one at all');

/* Read the words back out of a jsPDF document. jsPDF writes text as `(…) Tj`, in streams
   that may be deflated — so this inflates what it can and reads the operators. Checking
   the BYTES would prove only that something was produced. */
function pdfText(buf) {
  const zlib = require('zlib');
  const s = buf.toString('latin1');
  const out = [];
  const re = /stream\r?\n/g; let m;
  while ((m = re.exec(s))) {
    const start = m.index + m[0].length;
    const end = s.indexOf('endstream', start);
    if (end < 0) continue;
    const raw = Buffer.from(s.slice(start, end), 'latin1');
    let t; try { t = zlib.inflateSync(raw).toString('latin1'); } catch (_) { t = raw.toString('latin1'); }
    if (!/Tj|TJ/.test(t)) continue;
    const r = /\(((?:\\.|[^\\()])*)\)\s*Tj/g; let x;
    while ((x = r.exec(t))) out.push(x[1].replace(/\\([()\\])/g, '$1'));
  }
  return out.join('\n');
}

console.log(`\ntest-gc-record-pure: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
