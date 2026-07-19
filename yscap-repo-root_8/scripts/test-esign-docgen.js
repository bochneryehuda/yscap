/**
 * Unit tests for the in-house document generator (src/lib/esign/docgen.js) and the
 * loan-file → document-field loader (orchestrate.loadDocGenData). No database and
 * no DocuSign — docgen fills the real stored .docx templates in memory, and
 * loadDocGenData is driven by a tiny stub db. Guards every fill/anchor/structure
 * invariant a human would eyeball on the finished document.
 *
 * Run: node scripts/test-esign-docgen.js
 */
const assert = require('assert');
const path = require('path');
const R = path.resolve(__dirname, '..');
const dg = require(R + '/src/lib/esign/docgen');
const { unzip } = require(R + '/src/lib/zip');
const orch = require(R + '/src/lib/esign/orchestrate');

let n = 0;
const ok = (c, m) => { assert.ok(c, m); n++; };
const eq = (a, b, m) => { assert.strictEqual(a, b, `${m} (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`); n++; };

// Visible text a human sees: strip tags, drop white (FFFFFF) anchor runs + field
// codes (w:instrText), decode the three escaped entities.
function docXml(buf) { return unzip(buf).find((e) => e.name === 'word/document.xml').data.toString('utf8'); }
function visibleText(buf) {
  const xml = docXml(buf);
  let out = '';
  for (const runSeg of xml.split('</w:r>')) {
    const rpr = (runSeg.match(/<w:rPr>[\s\S]*?<\/w:rPr>/) || [''])[0];
    if (/w:color\s+w:val="FFFFFF"/.test(rpr)) continue;          // invisible anchor
    out += [...runSeg.matchAll(/<w:t[^>]*>([\s\S]*?)<\/w:t>/g)].map((m) => m[1]).join('');
  }
  return out.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
}

const SAMPLE = {
  loanNumber: 'YS-2026-0412', applicationDate: '2026-06-01', executionDate: '2026-07-19',
  loanAmount: 1287500.5, propStreet: '392 Columbia Ave Unit 2B', propCity: 'Lakewood',
  propState: 'NJ', propZip: '08701', bFirst: 'Yaakov M', bLast: "O'Brien",
  hasCoBorrower: true, cbFirst: 'Rivka', cbLast: "O'Brien",
};

// ---- 1. helper-level: escaping, money, dates ---------------------------------
eq(dg.escapeXml('Tom & Sons <LLC>'), 'Tom &amp; Sons &lt;LLC&gt;', 'escape & < >');
eq(dg.escapeXml("O'Brien \"x\""), 'O\'Brien "x"', 'quotes/apostrophes stay literal (Word style)');
eq(dg.fmtMoney(1287500.5), '1,287,500.50', 'money: commas + 2 decimals');
eq(dg.fmtMoney(650000), '650,000.00', 'money: whole dollars → .00');
eq(dg.fmtMoney(null), '0.00', 'money: null → 0.00');
eq(dg.fmtMoney(undefined), '', 'money: undefined → empty');
// Date-only string must NOT shift a day in any timezone (repo hard rule).
process.env.TZ = 'America/New_York';
eq(dg.fmtDate('2026-06-01'), '06/01/2026', 'date-only string: no day-shift in NY');
eq(dg.fmtDate('2026-06-01T00:00:00Z'), '06/01/2026', 'ISO datetime string → date');
eq(dg.fmtDate(new Date('2026-06-01T00:00:00Z')), '06/01/2026', 'Date object (UTC) → deterministic day');
eq(dg.fmtDate(null), '', 'date: null → empty');

// ---- 2. structural surgery helpers -------------------------------------------
{
  const x = '<w:tbl><w:tr><w:tc><w:p><w:r><w:t>MARK</w:t></w:r></w:p></w:tc></w:tr></w:tbl><w:p>after</w:p>';
  eq(dg.removeTableContaining(x, 'MARK'), '<w:p>after</w:p>', 'removeTableContaining strips the whole table');
}

// ---- 3. disclosure: filled, anchored, right structure (WITH co-borrower) ------
{
  const buf = dg.generate('bp_disclosure', SAMPLE);
  const xml = docXml(buf), vis = visibleText(buf);
  ok(!/«[^»]+»/.test(xml), 'disclosure: no unfilled «merge fields»');
  ok(!/descr="(Borrower|Coborrower)Signature"/.test(xml), 'disclosure: leftover Sign-Here tag images removed');
  ok(!/<w:tc>(?:(?!<w:p[ >])[\s\S])*?<\/w:tc>/.test(xml), 'disclosure: no empty table cell (valid OOXML)');
  for (const v of ['YS-2026-0412', '06/01/2026', '1,287,500.50', '392 Columbia Ave Unit 2B', 'Lakewood', 'NJ', '08701', 'Yaakov M', "O'Brien", 'Rivka'])
    ok(vis.includes(v), `disclosure shows "${v}"`);
  for (const a of ['/bpd_b1_sig/', '/bpd_b1_dt/', '/bpd_b2_sig/', '/bpd_b2_dt/'])
    ok(xml.includes(a), `disclosure carries anchor ${a}`);
  // Disclosure signature cell holds ONLY the invisible anchor (its own bottom
  // border is the line) — the anchor run is immediately followed by the cell's </w:p>.
  ok(/\/bpd_b1_sig\/<\/w:t><\/w:r><\/w:p>/.test(xml), 'disclosure: sig cell is anchor-only (cell border is the line)');
  ok(!vis.includes('Date:'), 'disclosure: no drawn "Date:" label (date is inline after the name)');
}

// ---- 4. disclosure WITHOUT co-borrower ---------------------------------------
{
  const buf = dg.generate('bp_disclosure', { ...SAMPLE, hasCoBorrower: false, cbFirst: '', cbLast: '' });
  const xml = docXml(buf), vis = visibleText(buf);
  ok(!/«[^»]+»/.test(xml), 'solo disclosure: no leftover tokens');
  ok(!/<w:tc>(?:(?!<w:p[ >])[\s\S])*?<\/w:tc>/.test(xml), 'solo disclosure: no empty cell');
  ok(!/\/bpd_b2_/.test(xml), 'solo disclosure: no co-borrower anchors');
  ok(!/Co-?\s*Borrower/.test(vis), 'solo disclosure: no visible co-borrower line');
  ok(vis.includes('Yaakov M') && vis.includes("O'Brien"), 'solo disclosure: borrower still present');
}

// ---- 5. Heter Iska: nusach byte-preserved, filled, anchored ------------------
{
  const buf = dg.generate('heter_iska', SAMPLE);
  const xml = docXml(buf), vis = visibleText(buf);
  ok(!/«[^»]+»/.test(xml), 'iska: no unfilled «merge fields»');
  ok(vis.includes('נאום'), 'iska: Hebrew nusach preserved');
  ok(vis.includes('1,287,500.50'), 'iska: loan amount filled');
  ok(vis.includes('Yaakov M') && vis.includes('Rivka'), 'iska: both declarant names filled');
  for (const a of ['/iska_b1_sig/', '/iska_b1_dt/', '/iska_b2_sig/', '/iska_b2_dt/'])
    ok(xml.includes(a), `iska carries anchor ${a}`);
  ok(vis.includes('Date:'), 'iska: draws its own signature + Date line (cell has no border)');
}

// ---- 6. Heter Iska WITHOUT co-borrower ---------------------------------------
{
  const buf = dg.generate('heter_iska', { ...SAMPLE, hasCoBorrower: false, cbFirst: '', cbLast: '' });
  const xml = docXml(buf), vis = visibleText(buf);
  ok(!/<w:tc>(?:(?!<w:p[ >])[\s\S])*?<\/w:tc>/.test(xml), 'solo iska: no empty cell');
  ok(!/\/iska_b2_/.test(xml), 'solo iska: no co-borrower anchors');
  ok(!vis.includes('Co-Borrower'), 'solo iska: co-borrower name line removed');
  ok(vis.includes('נאום'), 'solo iska: borrower נאום label kept');
  // exactly one נאום label remains (the borrower's; the co one is gone)
  eq((vis.match(/נאום/g) || []).length, 1, 'solo iska: exactly one declarant label remains');
}

// ---- 7. loadDocGenData address fallback (stub db) ----------------------------
function stubDb(appRow) {
  return { query: async () => ({ rows: [appRow] }) };
}
(async () => {
  const base = { ys_loan_number: 'YS-1', application_date: '2026-06-01', loan_amount: '425000.00',
    purchase_price: null, b_first: 'Meir', b_last: 'Klein', cb_first: null, cb_last: null, co_borrower_id: null };

  // structured keys present
  let d = await orch.loadDocGenData(stubDb({ ...base, addr_line1: '5 Elm St', addr_unit: 'Apt 1', addr_city: 'Lakewood', addr_state: 'NJ', addr_zip: '08701' }), 'x');
  eq(d.propStreet, '5 Elm St Apt 1', 'loader: structured line1+unit'); eq(d.propCity, 'Lakewood', 'loader: structured city');

  // oneLine-only (ClickUp shape) → parsed into parts
  d = await orch.loadDocGenData(stubDb({ ...base, addr_oneline: '17 Sunset Rd Unit 4, Jackson, NJ 08527' }), 'x');
  eq(d.propStreet, '17 Sunset Rd Unit 4', 'loader: oneLine → street'); eq(d.propCity, 'Jackson', 'loader: oneLine → city');
  eq(d.propState, 'NJ', 'loader: oneLine → state'); eq(d.propZip, '08527', 'loader: oneLine → zip');

  // formatted_address-only → parsed
  d = await orch.loadDocGenData(stubDb({ ...base, addr_formatted: '890 Oak Ave, Toms River, NJ 08753' }), 'x');
  eq(d.propCity, 'Toms River', 'loader: formatted_address → city'); eq(d.propZip, '08753', 'loader: formatted_address → zip');

  // loan_amount null → purchase_price fallback
  d = await orch.loadDocGenData(stubDb({ ...base, loan_amount: null, purchase_price: '500000.00', addr_oneline: '1 A St, B, NJ 07001' }), 'x');
  eq(String(d.loanAmount), '500000.00', 'loader: loan_amount null → purchase_price fallback');

  console.log(`\n✓ esign docgen: ${n} assertions passed`);
})().catch((e) => { console.error('\n✗ FAILED:', e); process.exit(1); });
