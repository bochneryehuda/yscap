'use strict';
/**
 * THE FEE AUDIT ENGINE — every fee this system charges, on every surface a fee can populate,
 * and in every total a fee has to reach.
 *
 * OWNER-DIRECTED 2026-08-26: *"open up an audit engine to audit the entire fee structure:
 * origination fees, legal fees, project review fees, attorney fees, processing fees — every single
 * fee that exists. Make sure every single fee populates every place where fees can populate, which
 * means on all the term sheets, on the structure screen, on the cash to close, on the liquidity
 * requirement, everywhere."*
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * WHY AN ENGINE AND NOT ANOTHER TEST. The rule it enforces — *folding an amount into a total is
 * HALF a fee; wire it into the total AND name it on every surface that itemises, in the same
 * commit* — has been broken three times in six days, and each break was found by a person reading
 * a document rather than by the build. The failure is silent by construction: the total is right,
 * every existing test passes, and the only symptom is that the fees a borrower can READ do not add
 * up to the total they are asked to BRING. So the roster's closing half is DERIVED from the
 * closing sum itself (`scripts/lib/fee-roster.js`): add an eleventh fee to that sum and this build
 * fails, naming the fee, before anybody has to notice a document that does not reconcile.
 *
 * WHAT IT PROVES, and each section exists because it catches a different way the class recurs:
 *
 *   A  THE ROSTER IS THE CLOSING SUM. Both directions, and against all three of the studio's
 *      browser mirrors — a fee in the server's sum and not the studio's means the printed sheet
 *      disagrees with the registered quote, which is the same defect one layer out.
 *   B  EVERY FEE IS NAMED ON EVERY SURFACE, keyed on each surface's OWN data variable. This is
 *      the section that catches the recurring bug, and it caught two more while being written.
 *   C  A REAL PRICED DEAL CARRIES IT. Fees are proven on quotes from the real engine, not on
 *      fixtures — and each fixture is asserted to SIZE before it is asserted to CHARGE, because a
 *      fee "proven" on a deal that does not price proves nothing.
 *   D  THE NAMED LINES ADD UP TO THE TOTAL, to the cent. This is the arithmetic form of the whole
 *      rule: it is true if and only if nothing was folded in unnamed.
 *   E  IT REACHES CASH TO CLOSE AND THE LIQUIDITY TO SHOW — measured by pricing the same deal
 *      with the fee and without it, so the assertion is about the CASCADE and not about a number
 *      that happens to be large.
 *   F  THE FEES THAT ARE DELIBERATELY OUTSIDE THE TABLE ARE STILL NAMED, and are proven to stay
 *      out of cash to close. "We checked and it is out on purpose" is a different answer from
 *      "nobody looked".
 *
 * PURE: no database, no network, no browser. `scripts/render-fee-audit.js` is the other half —
 * it RENDERS the real term sheet and proves the rows land on the page without overlapping.
 */
const path = require('path');
const R = require('./lib/fee-roster');

let pass = 0, fail = 0;
const ok = (m, c, extra) => { if (c) { pass++; } else { fail++; console.log('  FAIL - ' + m + (extra ? ' :: ' + extra : '')); } };
const eq = (m, a, b) => ok(m, a === b, `got ${JSON.stringify(a)} want ${JSON.stringify(b)}`);
const near = (m, a, b, tol) => ok(m, Math.abs(a - b) <= (tol == null ? 0.005 : tol), `got ${a} want ${b}`);

/* ── A. THE ROSTER IS THE CLOSING SUM, IN BOTH DIRECTIONS ───────────────────────────────────── */
const serverAddends = R.serverClosingAddends();
const rosterKeys = Object.keys(R.CLOSING_FEES);

for (const a of serverAddends) {
  ok(`A1 the closing sum's "${a}" is a fee the audit knows about`, rosterKeys.includes(a),
    'add it to CLOSING_FEES in scripts/lib/fee-roster.js — a fee inside the total that no surface names is the whole defect this engine exists to catch');
}
for (const k of rosterKeys) {
  ok(`A2 "${k}" is really in the closing sum`, serverAddends.includes(k),
    'the roster claims a fee the server no longer charges');
}
eq('A3 the roster and the closing sum are the same size', rosterKeys.length, serverAddends.length);
ok('A4 …and there are enough of them for that to mean something', serverAddends.length >= 10);

/* THE STUDIO'S BROWSER MIRROR. It cannot require server code, so it keeps its own copy of the sum
   — four of them, one per program (Speed joined 2026-09-03) — and a fee present in one and not
   another means the printed term sheet is short on that program alone. */
const mirrors = R.studioClosingAddends();
eq('A5 the studio keeps one closing sum per program', mirrors.length, R.STUDIO_MIRRORS);
for (let i = 0; i < mirrors.length; i++) {
  eq(`A6.${i} …and mirror #${i} carries the same number of fees as the server`, mirrors[i].length, serverAddends.length);
  for (const k of rosterKeys) {
    ok(`A7.${i} …including ${R.CLOSING_FEES[k].label}`, mirrors[i].includes(R.CLOSING_FEES[k].studio),
      `mirror #${i} = ${mirrors[i].join(' + ')}`);
  }
}
ok('A8 all the mirrors are identical to each other',
  new Set(mirrors.map((m) => m.join('+'))).size === 1, mirrors.map((m) => m.join('+')).join(' || '));

/* ── B. EVERY FEE IS NAMED ON EVERY SURFACE ─────────────────────────────────────────────────── */
const SRC = {};
for (const [key, s] of Object.entries(R.SURFACES)) {
  try { SRC[key] = s.src(); } catch (e) { SRC[key] = ''; ok(`B0 ${s.what} could be read`, false, String(e.message)); }
  ok(`B0 ${s.what} is a real region of source`, SRC[key].length > 200, `${SRC[key].length} chars`);
}

for (const [key, fee] of Object.entries(R.CLOSING_FEES)) {
  for (const [sKey, re] of Object.entries(fee.surfaces)) {
    if (re === null) continue;        // deliberately not on that surface — see the roster's note
    ok(`B1 ${fee.label} is named on ${R.SURFACES[sKey].what}`, re.test(SRC[sKey]),
      `no match for ${re} in ${sKey}`);
  }
  /* A fee with no surface entry at all is the silent case — the roster forces the decision to be
     written down rather than left out. */
  const named = Object.keys(fee.surfaces).length;
  ok(`B2 ${fee.label} states where it is named on every surface`, named === Object.keys(R.SURFACES).length,
    `covers ${named} of ${Object.keys(R.SURFACES).length} surfaces`);
}

/* ── C/D/E. THE REAL ENGINE ─────────────────────────────────────────────────────────────────── */
const pricing = require(path.join(R.REPO, 'src/lib/pricing'));
if (!pricing.enginesReady || !pricing.enginesReady()) {
  console.log('SKIP sections C-F: the frozen engines are not loadable —', pricing.loadErr && pricing.loadErr());
} else {
  const quote = (app, program, ov) => pricing.quoteProgram(program || 'standard', pricing.buildInputs(app, R.EXPERIENCE, ov || {}));

  /* Every named closing-cost line on a quote, as {label, amount}. This is the list a borrower can
     READ on any of the itemising surfaces — so summing it and comparing to the stated total is the
     arithmetic form of "nothing was folded in unnamed". */
  function namedLines(cc) {
    const out = [];
    const add = (label, amount) => { const n = Number(amount); if (n > 0) out.push({ label, amount: n }); };
    add('Origination', cc.origination);
    add('Broker origination', cc.brokerFee);
    if (cc.lenderFeeParts && cc.lenderFeeParts.split) {
      add(cc.lenderFeeParts.underwritingLabel, cc.lenderFeeParts.underwriting);
      add(cc.lenderFeeParts.legalLabel, cc.lenderFeeParts.legal);
    } else add('Underwriting / processing / legal', cc.lenderFee);
    if (cc.settlement) add(cc.settlement.label, cc.settlement.amount);
    if (cc.cema) add(cc.cema.label, cc.cema.amount);
    add('Credit report', cc.creditFee);
    add('Title / escrow / settlement', cc.titleAndSettlement);
    for (const f of (cc.extraFees || [])) add(f.name, f.amount);
    if (cc.feasibility) add(cc.feasibility.label, cc.feasibility.amount);
    for (const g of (cc.governmentChargeLines || [])) add(g.label, g.amount);
    return out;
  }

  for (const [fxKey, fx] of Object.entries(R.FIXTURES)) {
    let q = null, err = null;
    try { q = quote(fx.app); } catch (e) { err = String(e && e.message); }
    ok(`C1 ${fx.what} prices`, !!q && !err, err || 'no quote');
    if (!q) continue;
    ok(`C2 ${fx.what} really sized a loan`, Number(q.sizing && q.sizing.totalLoan) > 0, `totalLoan=${q.sizing && q.sizing.totalLoan}`);
    const cc = q.closingCosts;

    /* D. THE ARITHMETIC. Every itemised line, summed, against the total printed under them. */
    const lines = namedLines(cc);
    const sum = Math.round(lines.reduce((a, l) => a + l.amount, 0) * 100) / 100;
    near(`D1 ${fx.what}: the named fee lines add up to the total due at closing`, sum, Number(cc.dueAtClosing), 0.02);
    ok(`D2 ${fx.what}: …over a real set of lines`, lines.length >= 5, `${lines.length} lines`);

    /* E. THE CASCADE. Cash to close and the liquidity to show both carry the closing costs. */
    ok(`E1 ${fx.what}: cash to close carries the closing costs`,
      Number(q.cashToClose) >= Number(cc.dueAtClosing) - 0.02,
      `cashToClose=${q.cashToClose} dueAtClosing=${cc.dueAtClosing}`);
    ok(`E2 ${fx.what}: the liquidity to show carries the cash to close`,
      Number(q.liquidityRequired) >= Number(q.cashToClose) - 0.02,
      `liquidity=${q.liquidityRequired} cashToClose=${q.cashToClose}`);

    /* F. THE APPRAISAL IS OUTSIDE THE TABLE, ON PURPOSE — and is still stated. */
    ok(`F1 ${fx.what}: the appraisal is quoted but stays OUT of what is due at closing`,
      Number(cc.appraisalPoc) > 0
      && Math.abs(Number(cc.totalIncludingPoc) - (Number(cc.dueAtClosing) + Number(cc.appraisalPoc))) < 0.02,
      `poc=${cc.appraisalPoc} due=${cc.dueAtClosing} total=${cc.totalIncludingPoc}`);
  }

  /* ── C3. EACH OPTIONAL FEE IS CARRIED BY ITS OWN FIXTURE, AND BY NO OTHER ────────────────── */
  const carried = (cc, key) => {
    const f = R.CLOSING_FEES[key];
    if (key === 'lenderFee') return Number(cc.lenderFee) > 0;
    if (key === 'govChargesTotal') return (cc.governmentChargeLines || []).length > 0;
    if (key === 'extraFeesTotal') return (cc.extraFees || []).length > 0;
    if (key === 'feasibilityFee') return !!cc.feasibility && Number(cc.feasibility.amount) > 0;
    if (key === 'settlementFee') return !!cc.settlement && Number(cc.settlement.amount) > 0;
    if (key === 'cemaFee') return !!cc.cema && Number(cc.cema.amount) > 0;
    return Number(cc[f.quoteKey]) > 0;
  };
  const qs = {};
  for (const [k, fx] of Object.entries(R.FIXTURES)) { try { qs[k] = quote(fx.app); } catch (_) { qs[k] = null; } }

  for (const [key, fee] of Object.entries(R.CLOSING_FEES)) {
    if (fee.tpoOnly || fee.adminOnly) continue;   // needs a TPO firm / an admin-configured extra fee
    const q = qs[fee.fixture];
    if (!q) { ok(`C3 ${fee.label}: its fixture priced`, false, `fixture ${fee.fixture}`); continue; }
    ok(`C3 ${fee.label} is really charged on ${R.FIXTURES[fee.fixture].what}`, carried(q.closingCosts, key));
  }

  /* THE OPTIONAL FEES ARE ABSENT WHERE THEY SHOULD BE — a row that prints on every deal is not an
     optional fee, and a term sheet naming a fee the borrower is not charged is its own defect. */
  const gen = qs.general && qs.general.closingCosts;
  if (gen) {
    ok('C4 an ordinary New Jersey flip carries NO construction review fee', !carried(gen, 'feasibilityFee'));
    ok('C5 …NO New York settlement agent fee', !carried(gen, 'settlementFee'));
    ok('C6 …NO CEMA fee', !carried(gen, 'cemaFee'));
    ok('C7 …and no government charges (New Jersey levies none on the buyer)', !carried(gen, 'govChargesTotal'));
  }

  /* ── E3. THE CASCADE, MEASURED BY REMOVING THE FEE ───────────────────────────────────────── */
  /* Proving "the fee reached cash to close" by pointing at a big number proves nothing. Each of
     these prices the SAME deal twice — once carrying the fee, once with it waived by a typed 0 —
     and asserts that cash to close AND the liquidity to show each move by exactly the fee. */
  const cascade = [
    { key: 'feasibilityFee', fixture: 'groundUp', off: { feasibilityFee: 0 }, label: 'the construction feasibility fee' },
    { key: 'settlementFee', fixture: 'nycFlip', off: { settlementFee: 0 }, label: 'the New York settlement agent fee' },
    { key: 'legalFee', fixture: 'nycFlip', off: { legalFee: 0 }, label: "the legal half of our own fee" },
    { key: 'underwritingFee', fixture: 'general', off: { underwritingFee: 0 }, label: 'the underwriting & processing half of our own fee' },
  ];
  for (const c of cascade) {
    const fx = R.FIXTURES[c.fixture];
    let on = null, off = null;
    try { on = quote(fx.app); off = quote(fx.app, null, c.off); } catch (e) { /* reported below */ }
    if (!on || !off) { ok(`E3 ${c.label}: both quotes priced`, false); continue; }
    const delta = Math.round((Number(on.closingCosts.dueAtClosing) - Number(off.closingCosts.dueAtClosing)) * 100) / 100;
    ok(`E3 ${c.label} is a real, removable charge`, delta > 0, `delta=${delta}`);
    near(`E4 …and cash to close moves by exactly it`,
      Math.round((Number(on.cashToClose) - Number(off.cashToClose)) * 100) / 100, delta, 0.02);
    near(`E5 …and so does the liquidity the borrower must show`,
      Math.round((Number(on.liquidityRequired) - Number(off.liquidityRequired)) * 100) / 100, delta, 0.02);
  }

  /* ── E6. AN EVENT FEE NEVER REACHES THE TABLE ────────────────────────────────────────────── */
  /* The $500 closing reschedule fee and the per-draw inspection fees are DISCLOSED terms, not
     closing costs — the owner's own placement. If either ever leaked into a total, every borrower
     would be asked to bring money for something that has not happened. */
  const to = require(path.join(R.REPO, 'src/lib/term-options'));
  const g2 = qs.general;
  if (g2) {
    const cc = g2.closingCosts;
    ok('E6 the $500 closing reschedule fee is nowhere in what is due at closing',
      !JSON.stringify(cc).includes('reschedule'));
    ok('E7 …and no draw fee is either', !/draw fee/i.test(JSON.stringify(cc)));
    ok('E8 …though the term sheet does disclose the reschedule fee', /\$500/.test(to.CLOSING_RESCHEDULE_ROW));
    eq('E9 …at the owner’s figure', to.CLOSING_RESCHEDULE_FEE, 500);
  }
}

/* ── I. THE LIQUIDITY CONDITION ─────────────────────────────────────────────────────────────── */
/* The owner named it separately from cash to close, and it is the number a reviewer measures the
   borrower's bank statements against. It can never be SHORT of a fee — it is built from
   `dueAtClosing`, the total, rather than from a list of named lines somebody has to keep in step —
   but the BREAKDOWN it records is what a reviewer reconciles against a settlement statement, and
   that breakdown was reading the government charges off a key the quote has never carried. */
{
  const liq = require(path.join(R.REPO, 'src/lib/liquidity'));
  const liqSrc = R.stripComments(require('fs').readFileSync(path.join(R.REPO, 'src/lib/liquidity.js'), 'utf8'));

  ok('I1 the liquidity breakdown reads the government charges off closingCosts, where they live',
    /governmentCharges: Number\(cc\.governmentCharges\)/.test(liqSrc)
    && /governmentChargeLines: Array\.isArray\(cc\.governmentChargeLines\)/.test(liqSrc),
    'it read quote.governmentCharges — a key normalize() has never produced — so every file recorded $0');
  ok('I2 …and nothing reads them off the top of the quote again',
    !/Number\(quote\.governmentCharges\)/.test(liqSrc) && !/Array\.isArray\(quote\.governmentChargeLines\)/.test(liqSrc));

  if (pricing.enginesReady && pricing.enginesReady()) {
    const nyc = pricing.quoteProgram('standard', pricing.buildInputs(R.FIXTURES.nycFlip.app, R.EXPERIENCE, {}));
    const nj = pricing.quoteProgram('standard', pricing.buildInputs(R.FIXTURES.general.app, R.EXPERIENCE, {}));
    ok('I3 a New York deal\u2019s liquidity hint NAMES the mortgage recording tax',
      /mortgage recording tax/.test(liq.governmentChargeLine(nyc)), JSON.stringify(liq.governmentChargeLine(nyc)));
    /* THE OTHER SHAPE IS NOT HYPOTHETICAL: `asset-ledger` passes the flat pair straight off the
       stored breakdown, so reading only one of the two is what made this print nothing. */
    ok('I4 \u2026and so does the FLAT shape the asset ledger passes',
      /mortgage recording tax/.test(liq.governmentChargeLine({
        governmentCharges: nyc.closingCosts.governmentCharges,
        governmentChargeLines: nyc.closingCosts.governmentChargeLines })));
    ok('I5 a state that levies none says nothing rather than \u201c$0.00 of government charges\u201d',
      liq.governmentChargeLine(nj) === '' && liq.governmentChargeLine({}) === '');

    /* THE ARITHMETIC THE CONDITION STATES. Every fee inside `dueAtClosing` reaches this number by
       construction — which is exactly why the requirement can never be short of a fee nobody
       named, and why the audit measures the identity rather than a threshold. */
    for (const [k, fx] of Object.entries(R.FIXTURES)) {
      let q = null; try { q = pricing.quoteProgram('standard', pricing.buildInputs(fx.app, R.EXPERIENCE, {})); } catch (_) { /* reported in C1 */ }
      if (!q) continue;
      const parts = Number(q.cashToClose) + Number(q.reserveRequirement) + Number(q.sizing.oopRehab || 0) + Number(q.closingBuffer);
      near(`I6 ${fx.what}: liquidity to show = cash to close + reserves + out-of-pocket rehab + the 1% buffer`,
        Number(q.liquidityRequired), Math.round(parts * 100) / 100, 0.02);
    }
  }
}

/* ── G. THE FEES THAT ARE DELIBERATELY OUTSIDE THE CLOSING SUM ARE STILL NAMED ──────────────── */
for (const [key, fee] of Object.entries(R.OUTSIDE_CLOSING)) {
  ok(`G1 ${fee.label} records WHY it is not in cash to close`, typeof fee.why === 'string' && fee.why.length > 40);
  ok(`G2 ${fee.label} is not an addend of the closing sum`, !serverAddends.includes(key));
  for (const [sKey, re] of Object.entries(fee.surfaces)) {
    if (re === null) continue;
    ok(`G3 ${fee.label} is named on ${R.SURFACES[sKey].what}`, re.test(SRC[sKey]), `no match for ${re}`);
  }
}

/* ── J. A FEE CAN NEVER LEAVE THE LIQUIDITY CONDITION STALE ─────────────────────────────────── */
/* The owner asked that *"the liquidity condition updates"*. It reads `dueAtClosing` — the total —
   so it can never be SHORT of a fee; what it can be is OUT OF DATE, if some door were able to
   change a fee without re-pricing the file. That is the claim db/632 and db/609 both rest on when
   they decline to widen the economics-reopen trigger: the per-file fee columns *can only be
   written as part of a registration*. This asserts it mechanically instead of trusting the note,
   and it is DERIVED — it finds the writers rather than naming them, so a sixth fee column or a
   second writer added later is caught without anybody updating a list. */
{
  const fs = require('fs');
  const FEE_COLS = ['file_underwriting_fee', 'file_legal_fee', 'file_settlement_fee', 'file_cema_fee', 'file_feasibility_fee'];
  const walk = (dir, out = []) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const f = path.join(dir, e.name);
      if (e.isDirectory()) walk(f, out); else if (e.name.endsWith('.js')) out.push(f);
    }
    return out;
  };
  const files = walk(path.join(R.REPO, 'src'));
  const writers = {};
  for (const f of files) {
    const src = R.stripComments(fs.readFileSync(f, 'utf8'));
    for (const col of FEE_COLS) {
      const re = new RegExp(`UPDATE\\s+applications\\s+SET\\s+${col}\\s*=`, 'g');
      const n = (src.match(re) || []).length;
      if (n) (writers[col] = writers[col] || []).push({ f: path.relative(R.REPO, f), n });
    }
  }
  for (const col of FEE_COLS) {
    const w = writers[col] || [];
    const total = w.reduce((a, x) => a + x.n, 0);
    ok(`J1 ${col} has exactly ONE writer`, total === 1,
      w.length ? w.map((x) => `${x.f} x${x.n}`).join(', ') : 'nobody writes it — the column is dead or the pattern moved');
  }
  /* AND THAT WRITER RE-PRICES THE FILE. Derived from the writers found above, not from a list of
     doors — a fee changed without a re-sync is a liquidity requirement quoting yesterday's fees. */
  const writerFiles = [...new Set(Object.values(writers).flat().map((x) => x.f))];
  ok('J2 the fee columns really are written somewhere', writerFiles.length >= 1);
  for (const rel of writerFiles) {
    const src = R.stripComments(fs.readFileSync(path.join(R.REPO, rel), 'utf8'));
    ok(`J3 ${rel} re-syncs the liquidity condition in the same door that writes a fee`,
      /syncLiquidityCondition\(/.test(src) || /resyncLiquidityForFile\(/.test(src));
  }
  /* THE REGISTER DOORS. Each of these persists a quote a borrower is shown, so each has to leave
     the condition agreeing with it. Derived the same way: every file that calls
     `persistProductRegistration` must re-sync. */
  const registerFiles = files.filter((f) => /persistProductRegistration\s*\(/.test(R.stripComments(fs.readFileSync(f, 'utf8'))))
    .map((f) => path.relative(R.REPO, f))
    .filter((rel) => !rel.startsWith('src/lib/product-registration'));
  ok('J4 the register doors were found', registerFiles.length >= 3, registerFiles.join(', '));
  for (const rel of registerFiles) {
    const src = R.stripComments(fs.readFileSync(path.join(R.REPO, rel), 'utf8'));
    ok(`J5 ${rel} re-syncs the liquidity condition after registering`,
      /syncLiquidityCondition\(/.test(src) || /resyncLiquidityForFile\(/.test(src));
  }
}

/* ── H. THE ROSTER'S OWN GUARDS ─────────────────────────────────────────────────────────────── */
ok('H1 every surface token is a regular expression, never a bare string',
  Object.values(R.CLOSING_FEES).every((f) => Object.values(f.surfaces).every((v) => v === null || v instanceof RegExp)));
/* A token that matches on a surface it was not written for is a token that proves nothing. The
   three spreadsheet columns are the case that matters: they are near-identical text, told apart
   only by their own data variable. */
{
  const cols = ['xlsxStd', 'xlsxGold', 'xlsxSilver', 'xlsxSpeed'];
  for (const [key, fee] of Object.entries(R.CLOSING_FEES)) {
    if (key === 'brokerFee' || key === 'govChargesTotal') continue;  // spliced / helper-built — one shared expression by design
    for (const a of cols) for (const b of cols) {
      if (a === b || !fee.surfaces[a]) continue;
      ok(`H2 ${fee.label}: the ${a} token cannot be satisfied by ${b} alone`,
        !fee.surfaces[a].test(SRC[b]) || fee.surfaces[a].test(SRC[a]),
        'the column tokens are not keyed on their own data variable');
    }
  }
}

if (fail) { console.log(`\ntest-fee-audit-pure: ${fail} FAILURE(S), ${pass} passed`); process.exit(1); }
console.log(`test-fee-audit-pure: OK (${pass} assertions)`);
