import React, { useEffect, useRef, useState } from 'react';
import { api } from '../lib/api.js';
import { MoneyInput } from './FormattedInputs.jsx';

/* Product Registration / term sheet, computed on the server from the FROZEN
   pricing engines (Standard Program = YSP, Gold Standard Program = GSP). Staff
   price a file, trade leverage on the Standard ladder, and register the product
   — which becomes the file's official terms (loan amount + note rate). The
   note-buyer's real program name is never surfaced: borrower-safe labels only. */

const money = (n) => n == null ? '—' : '$' + Math.round(Number(n)).toLocaleString('en-US');
const pct = (f, d = 2) => f == null ? '—' : (Number(f) * 100).toFixed(d) + '%';
const STRATEGIES = [
  { v: 'Fix & Flip', label: 'Fix & Flip' },
  { v: 'Fix & Hold', label: 'Fix & Hold' },
  { v: 'Ground-Up Construction', label: 'Ground-Up' },
  { v: 'Bridge', label: 'Bridge' },
];
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const YS_STATE_PREFIX = 'YSLOAN1\u0001';

function rawNum(v) {
  if (v == null || v === '') return '';
  const n = Number(String(v).replace(/[$,%\s,]/g, ''));
  return isFinite(n) ? String(n) : '';
}
function has(v) { return v != null && v !== ''; }
function valOr(v, fallback = '') { return has(v) ? String(v) : fallback; }
function borrowerName(app) {
  return [app.first_name, app.last_name].filter(Boolean).join(' ') || app.entity_name || 'Applicant';
}
function purposeLabel(ov) {
  if (String(ov.loanType || '').toLowerCase().includes('refi')) return ov.cashOut ? 'Cash-out refinance' : 'Rate & term refinance';
  return 'Purchase';
}
function strategyLabel(s) {
  const x = String(s || '').toLowerCase();
  if (x.includes('ground') || x.includes('construction')) return 'Ground-up Construction';
  if (x.includes('bridge') || x.includes('stabil')) return 'Bridge / Stabilized';
  if (x.includes('hold') || x.includes('brrrr')) return 'Fix & Hold (BRRRR)';
  return 'Fix & Flip';
}
function portalState(ov, app, program, allQuote) {
  const address = ov.address || addrLine(app.property_address);
  const v = {
    borrowerName: borrowerName(app),
    propAddr: address || '',
    dealPurpose: purposeLabel(ov),
    dealType: strategyLabel(ov.strategy),
    propState: valOr(ov.state),
    propType: String(ov.propertyType || '').includes('2-4') || Number(ov.units) > 1 ? '2-4' : 'sfr',
    price: rawNum(ov.purchasePrice),
    origPrice: rawNum(ov.sellerPrice),
    asIs: rawNum(ov.asIsValue),
    arv: rawNum(ov.arv),
    construction: rawNum(ov.rehabBudget),
    fico: rawNum(ov.fico),
    expFlips: rawNum(ov.expFlips) || '0',
    expBrrrr: rawNum(ov.expHolds) || '0',
    expGround: rawNum(ov.expGround) || '0',
    tsTerm: rawNum(ov.term) || '12',
    irMonths: rawNum(ov.irMonths) || '0',
    tsYspStd: valOr(ov.markupStdPct, '0.5'),
    tsYspGold: valOr(ov.markupGoldPct, '0.5'),
    tsOrigStd: valOr(ov.origStdPct, '1.25'),
    tsOrigGold: valOr(ov.origGoldPct, '1.25'),
    tsFeeUW: valOr(ov.lenderFee, '2195'),
    tsFeeCredit: valOr(ov.creditFee, '150'),
    tsFeeAppr: valOr(ov.appraisalFee, '800'),
    tsFeeTitle: valOr(ov.titleFee),
    tsMLtv: valOr(ov.ovrAcqLTVPct),
    tsMArv: valOr(ov.ovrARLTVPct),
    tsMLtc: valOr(ov.ovrLTCPct),
    tsMRate: valOr(ov.ovrRatePct),
    tsMIr: valOr(ov.ovrIrMonths),
  };
  const c = { isAssign: !!ov.isAssignment, tsManualOn: !!ov.manualPricing };
  if (!address) c.addrTBD = true;
  return {
    v, c,
    portal: {
      version: 1,
      exportedAt: new Date().toISOString(),
      program,
      overrides: ov,
      quote: allQuote || null,
    },
  };
}
function applyStateToOverrides(st, base) {
  const v = (st && st.v) || {};
  const c = (st && st.c) || {};
  const out = { ...(base || {}) };
  const setNum = (id, key) => { const n = rawNum(v[id]); if (n !== '') out[key] = n; };
  const setText = (id, key) => { if (v[id] != null && v[id] !== '') out[key] = String(v[id]); };
  if (v.dealPurpose) {
    const p = String(v.dealPurpose).toLowerCase();
    out.loanType = p.includes('refinance') ? 'Refinance' : 'Purchase';
    out.cashOut = p.includes('cash');
  }
  setText('dealType', 'strategy');
  setText('propState', 'state');
  setText('propAddr', 'address');
  setText('propType', 'propertyType');
  setNum('price', 'purchasePrice');
  setNum('origPrice', 'sellerPrice');
  setNum('asIs', 'asIsValue');
  setNum('arv', 'arv');
  setNum('construction', 'rehabBudget');
  setNum('fico', 'fico');
  setNum('expFlips', 'expFlips');
  setNum('expBrrrr', 'expHolds');
  setNum('expGround', 'expGround');
  setNum('tsTerm', 'term');
  setNum('irMonths', 'irMonths');
  setNum('tsYspStd', 'markupStdPct');
  setNum('tsYspGold', 'markupGoldPct');
  setNum('tsOrigStd', 'origStdPct');
  setNum('tsOrigGold', 'origGoldPct');
  setNum('tsFeeUW', 'lenderFee');
  setNum('tsFeeCredit', 'creditFee');
  setNum('tsFeeAppr', 'appraisalFee');
  setNum('tsFeeTitle', 'titleFee');
  setNum('tsMLtv', 'ovrAcqLTVPct');
  setNum('tsMArv', 'ovrARLTVPct');
  setNum('tsMLtc', 'ovrLTCPct');
  setNum('tsMRate', 'ovrRatePct');
  setNum('tsMIr', 'ovrIrMonths');
  if (Object.prototype.hasOwnProperty.call(c, 'isAssign')) out.isAssignment = !!c.isAssign;
  if (Object.prototype.hasOwnProperty.call(c, 'tsManualOn')) out.manualPricing = !!c.tsManualOn;
  if (st && st.portal && st.portal.overrides) Object.assign(out, st.portal.overrides);
  return out;
}
function loadScript(src) {
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = src; s.onload = resolve; s.onerror = reject;
    document.head.appendChild(s);
  });
}
async function ensureXLSX() {
  if (window.XLSX && window.XLSX.utils) return window.XLSX;
  try { await loadScript('https://cdn.jsdelivr.net/npm/xlsx-js-style@1.2.0/dist/xlsx.bundle.js'); }
  catch (_) { await loadScript('https://unpkg.com/xlsx-js-style@1.2.0/dist/xlsx.bundle.js'); }
  if (!(window.XLSX && window.XLSX.utils)) throw new Error('spreadsheet library failed to load');
  return window.XLSX;
}
function fileStem(app) {
  return 'YS_Term_Sheet_' + borrowerName(app).replace(/[^A-Za-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 48)
    + '_' + new Date().toISOString().slice(0, 10);
}
function stateChunks(st) {
  const enc = YS_STATE_PREFIX + JSON.stringify(st);
  const chunks = [];
  for (let p = 0; p < enc.length; p += 30000) chunks.push(enc.slice(p, p + 30000));
  return chunks;
}
async function stateFromImportFile(file) {
  if (!file) return null;
  if (/\.(json|txt)$/i.test(file.name || '')) {
    const text = await file.text();
    const body = text.indexOf(YS_STATE_PREFIX) === 0 ? text.slice(YS_STATE_PREFIX.length) : text;
    return JSON.parse(body);
  }
  const X = await ensureXLSX();
  const wb = X.read(await file.arrayBuffer(), { type: 'array' });
  if (wb.SheetNames.indexOf('_ys') < 0) throw new Error('No saved YS term-sheet data found');
  const aoa = X.utils.sheet_to_json(wb.Sheets['_ys'], { header: 1 });
  if (!(aoa[0] && String(aoa[0][0]) === 'YSLOANSTATE')) throw new Error('No saved YS term-sheet data found');
  const nch = parseInt(aoa[0][1], 10);
  let joined = '';
  for (let i = 1; i <= nch && i < aoa.length; i++) joined += (aoa[i] && aoa[i][0]) ? aoa[i][0] : '';
  if (joined.indexOf(YS_STATE_PREFIX) !== 0) throw new Error('Saved YS state was not recognized');
  return JSON.parse(joined.slice(YS_STATE_PREFIX.length));
}
function quoteRows(label, q) {
  if (!q || !q.sizing) return [[label + ' status', q ? q.status : 'Not priced']];
  const s = q.sizing;
  return [
    [label + ' status', q.status],
    [label + ' product', q.productLabel || q.programLabel || label],
    [label + ' loan amount', money(s.totalLoan)],
    [label + ' note rate', pct(q.noteRate)],
    [label + ' initial advance', money(s.initialAdvance)],
    [label + ' rehab / construction holdback', money(s.rehabHoldback)],
    [label + ' loan-to-cost', pct(s.ltcPct, 1)],
    [label + ' as-is LTV', pct(s.acqLtvPct, 1)],
    [label + ' ARV LTV', pct(s.arvPct, 1)],
    [label + ' origination', money(q.origination)],
    [label + ' cash to close', money(q.cashToClose)],
    [label + ' liquidity to show', money(q.liquidity)],
  ];
}
async function exportPortalXlsx(ov, app, program, allQuote) {
  const X = await ensureXLSX();
  const active = allQuote ? (program === 'gold' ? allQuote.gold : allQuote.standard) : null;
  const rows = [
    ['YS CAPITAL GROUP - TERM SHEET'],
    ['Generated', new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' })],
    [],
    ['Borrower / entity', borrowerName(app)],
    ['Property', ov.address || addrLine(app.property_address) || 'To be determined'],
    ['Purpose', purposeLabel(ov)],
    ['Strategy', strategyLabel(ov.strategy)],
    ['State', ov.state || ''],
    ['Purchase price', money(ov.purchasePrice)],
    ['As-is value', money(ov.asIsValue)],
    ['ARV', money(ov.arv)],
    ['Rehab budget', money(ov.rehabBudget)],
    ['FICO', ov.fico || ''],
    ['Experience', `${ov.expFlips || 0} flips / ${ov.expHolds || 0} holds / ${ov.expGround || 0} ground-up`],
    [],
    ['Selected program', active ? active.programLabel : program],
    ...quoteRows('Standard Program', allQuote && allQuote.standard),
    [],
    ...quoteRows('Gold Standard Program', allQuote && allQuote.gold),
    [],
    ['Portal admin pricing'],
    ['Standard markup', valOr(ov.markupStdPct, '0.5') + '%'],
    ['Gold markup', valOr(ov.markupGoldPct, '0.5') + '%'],
    ['Standard origination', valOr(ov.origStdPct, '1.25') + '%'],
    ['Gold origination', valOr(ov.origGoldPct, '1.25') + '%'],
    ['UW / processing / legal', money(valOr(ov.lenderFee, 2195))],
    ['Credit report', money(valOr(ov.creditFee, 150))],
    ['Appraisal POC', money(valOr(ov.appraisalFee, 800))],
    ['Title / escrow override', has(ov.titleFee) ? money(ov.titleFee) : 'Auto-estimate'],
  ];
  const ws = X.utils.aoa_to_sheet(rows);
  ws['!cols'] = [{ wch: 32 }, { wch: 54 }];
  const wb = X.utils.book_new();
  X.utils.book_append_sheet(wb, ws, 'Term Sheet');
  const hidden = [['YSLOANSTATE', stateChunks(portalState(ov, app, program, allQuote)).length]];
  stateChunks(portalState(ov, app, program, allQuote)).forEach((ch) => hidden.push([ch]));
  X.utils.book_append_sheet(wb, X.utils.aoa_to_sheet(hidden), '_ys');
  wb.Workbook = { Sheets: [{ Hidden: 0 }, { Hidden: 2 }] };
  X.writeFile(wb, fileStem(app) + '.xlsx');
}

function addrLine(a) {
  if (!a) return '';
  if (typeof a === 'string') return a;
  if (a.oneLine) return a.oneLine;
  return [a.line1 || a.street, a.city, a.state, a.zip].filter(Boolean).join(', ');
}

/* Branded, self-contained term sheet opened in a print window (browser
   print-to-PDF). Borrower-safe program name only; final terms subject to
   underwriting. Today's date is stamped for the borrower's reference. */
function printTermSheet(q, app) {
  if (!q || !q.sizing) return;
  const s = q.sizing;
  const borrower = [app.first_name, app.last_name].filter(Boolean).join(' ') || app.entity_name || 'Borrower';
  const today = new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
  const row = (k, v) => `<tr><td class="k">${esc(k)}</td><td class="v">${esc(v)}</td></tr>`;
  const terms = [
    ['Program', q.programLabel + (q.productLabel ? ' — ' + q.productLabel : '')],
    ['Loan amount', money(s.totalLoan)],
    ['Note rate', pct(q.noteRate)],
    ['Initial advance', money(s.initialAdvance)],
    s.downPayment > 0 ? ['Estimated down payment', money(s.downPayment)] : null,
    s.rehabHoldback > 0 ? ['Rehab / construction holdback', money(s.rehabHoldback)] : null,
    s.financedReserve > 0 ? ['Financed interest reserve', money(s.financedReserve)] : null,
    ['Monthly payment (at close)', money(s.initialPayment)],
    ['Monthly payment (fully drawn)', money(s.monthlyPayment)],
    ['Origination fee (' + pct(q.origPct, 3) + ')', money(q.origination)],
    ['Estimated title & settlement', money(q.title.total)],
    q.closingCosts ? ['Estimated closing costs', money(q.closingCosts.dueAtClosing)] : null,
    q.cashToClose != null ? ['Estimated cash to close', money(q.cashToClose)] : null,
    q.reserveRequirement != null ? ['Asset reserve requirement', money(q.reserveRequirement)] : null,
    q.liquidity != null ? ['Assets / liquidity to verify', money(q.liquidity)] : null,
    ['Loan-to-cost', pct(s.ltcPct, 1)],
    s.arvPct > 0 ? ['Loan-to-after-repair-value', pct(s.arvPct, 1)] : null,
  ].filter(Boolean).map((r) => row(r[0], r[1])).join('');

  const html = `<!doctype html><html><head><meta charset="utf-8"><title>Term Sheet — ${esc(borrower)}</title>
<style>
  *{box-sizing:border-box} body{font-family:'Hanken Grotesk',Arial,sans-serif;color:#141B22;margin:0;padding:40px;max-width:720px;margin:0 auto}
  .hd{display:flex;justify-content:space-between;align-items:flex-end;border-bottom:3px solid #C9A86A;padding-bottom:14px;margin-bottom:6px}
  .brand{font-family:Georgia,'Fraunces',serif;font-size:24px;font-weight:700;letter-spacing:.01em}
  .brand small{display:block;font-family:Arial,sans-serif;font-size:11px;font-weight:600;color:#6b7680;letter-spacing:.14em;text-transform:uppercase;margin-top:3px}
  .meta{text-align:right;font-size:12px;color:#6b7680}
  h1{font-family:Georgia,serif;font-size:19px;margin:22px 0 4px}
  .sub{color:#6b7680;font-size:13px;margin:0 0 18px}
  table{width:100%;border-collapse:collapse}
  td{padding:9px 4px;border-bottom:1px solid #e7e2d6;font-size:13.5px}
  td.k{color:#6b7680} td.v{text-align:right;font-weight:700}
  tr:first-child td{border-top:1px solid #e7e2d6}
  .hero{background:#faf7f0;border:1px solid #ece5d5;border-radius:10px;padding:16px 20px;display:flex;gap:26px;margin:16px 0}
  .hero div{flex:1} .hero .lab{font-size:11px;text-transform:uppercase;letter-spacing:.05em;color:#6b7680;font-weight:600}
  .hero .val{font-family:Georgia,serif;font-size:26px;font-weight:700;margin-top:2px}
  .hero .val.rate{color:#b2914d}
  .disc{margin-top:22px;font-size:11px;color:#8a949b;line-height:1.55}
  @media print{body{padding:0}.noprint{display:none}}
  .noprint{margin-top:24px;text-align:center}
  .noprint button{background:#141B22;color:#fff;border:none;border-radius:8px;padding:10px 20px;font-size:14px;cursor:pointer;margin:0 4px}
</style></head><body>
  <div class="hd">
    <div class="brand">YS Capital Group<small>Business-Purpose Real-Estate Lending</small></div>
    <div class="meta">${esc(today)}<br>NMLS #2609746</div>
  </div>
  <h1>Preliminary Term Sheet</h1>
  <p class="sub">Prepared for <strong>${esc(borrower)}</strong>${addrLine(app.property_address) ? ' &middot; ' + esc(addrLine(app.property_address)) : ''}</p>
  <div class="hero">
    <div><div class="lab">Loan amount</div><div class="val">${money(s.totalLoan)}</div></div>
    <div><div class="lab">Note rate</div><div class="val rate">${pct(q.noteRate)}</div></div>
  </div>
  <table><tbody>${terms}</tbody></table>
  <p class="disc">This preliminary term sheet is an estimate for discussion only and does not constitute a commitment to lend. All amounts, rates and fees are subject to full underwriting, appraisal/valuation, title, and final credit approval and may change. Title &amp; settlement figures are planning estimates; the settlement agent issues binding figures at closing. Business-purpose loans only — not for personal, family, or household use. YS Capital Group, NMLS #2609746.</p>
  <div class="noprint"><button onclick="window.print()">Print / Save as PDF</button></div>
</body></html>`;
  const w = window.open('', '_blank');
  if (!w) { alert('Please allow pop-ups to open the term sheet.'); return; }
  w.document.write(html); w.document.close();
}

function printPreApproval(q, app) {
  if (!q || !q.sizing) return;
  const s = q.sizing;
  const borrower = borrowerName(app);
  const property = addrLine(app.property_address) || 'To be determined';
  const today = new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
  const html = `<!doctype html><html><head><meta charset="utf-8"><title>Pre-Approval - ${esc(borrower)}</title>
<style>
  *{box-sizing:border-box} body{font-family:Arial,sans-serif;color:#141B22;margin:0;padding:46px;max-width:760px;margin:0 auto;line-height:1.55}
  .top{border-bottom:3px solid #C9A86A;padding-bottom:14px;margin-bottom:28px;display:flex;justify-content:space-between;gap:20px;align-items:flex-end}
  .brand{font-family:Georgia,serif;font-size:25px;font-weight:700}.brand small{display:block;font-family:Arial,sans-serif;font-size:11px;color:#68747c;letter-spacing:.12em;text-transform:uppercase;margin-top:4px}
  .meta{text-align:right;font-size:12px;color:#68747c} h1{font-family:Georgia,serif;font-size:24px;margin:0 0 18px}.amount{font-family:Georgia,serif;font-size:32px;font-weight:700;color:#1F3A40;margin:10px 0 4px}
  p{font-size:14px}.box{border:1px solid #e7e2d6;background:#faf7f0;border-radius:10px;padding:16px 18px;margin:20px 0}.sig{margin-top:42px}.line{width:260px;border-top:1px solid #141B22;margin-top:32px;padding-top:6px;font-size:12px;color:#68747c}
  .disc{font-size:11px;color:#7b858c;margin-top:28px}.noprint{text-align:center;margin-top:24px}.noprint button{background:#141B22;color:#fff;border:0;border-radius:8px;padding:10px 20px;cursor:pointer}
  @media print{body{padding:0}.noprint{display:none}}
</style></head><body>
  <div class="top"><div class="brand">YS Capital Group<small>Business-Purpose Real-Estate Lending</small></div><div class="meta">${esc(today)}<br>NMLS #2609746</div></div>
  <h1>Pre-Approval / Proof of Funds</h1>
  <p>To whom it may concern,</p>
  <p>Based on the preliminary information provided, ${esc(borrower)} has been reviewed for a business-purpose real-estate loan through YS Capital Group.</p>
  <div class="box">
    <div>Indicated financing amount</div>
    <div class="amount">${money(s.totalLoan)}</div>
    <div>Program: ${esc(q.programLabel)}${q.productLabel ? ' - ' + esc(q.productLabel) : ''}</div>
    <div>Property: ${esc(property)}</div>
  </div>
  <p>This letter may be used to support an offer or transaction discussion. Final approval remains subject to underwriting, appraisal or valuation, title review, entity and borrower verification, available liquidity, and final credit committee approval.</p>
  <div class="sig"><div>Sincerely,</div><div class="line">YS Capital Group</div></div>
  <p class="disc">This is not a commitment to lend and does not create an obligation to fund. Loan terms, fees, leverage and eligibility may change after full underwriting. Business-purpose loans only.</p>
  <div class="noprint"><button onclick="window.print()">Print / Save as PDF</button></div>
</body></html>`;
  const w = window.open('', '_blank');
  if (!w) { alert('Please allow pop-ups to open the pre-approval letter.'); return; }
  w.document.write(html); w.document.close();
}

function StatusBadge({ status }) {
  const cls = status === 'ELIGIBLE' ? 'ok' : status === 'MANUAL' ? 'warn' : 'err';
  const label = status === 'ELIGIBLE' ? 'Eligible' : status === 'MANUAL' ? 'Manual review' : status === 'INELIGIBLE' ? 'Ineligible' : 'Error';
  return <span className={`ts-badge ${cls}`}>{label}</span>;
}

function TermSheet({ q, app, onRegister, registering, isCurrent, mode = 'staff', onExportXlsx, onImportClick }) {
  if (!q) return null;
  const s = q.sizing;
  const priced = q.status !== 'INELIGIBLE' && s && s.totalLoan > 0;
  const borrower = mode === 'borrower';
  const actionText = registering ? (borrower ? 'Selecting...' : 'Registering...')
    : isCurrent ? (borrower ? 'Update selection' : 'Re-register these terms')
    : borrower ? (q.status === 'MANUAL' ? 'Request manual review' : 'Select this product')
    : 'Register this product';
  return (
    <div className="ts-card">
      <div className="ts-head">
        <div>
          <div className="ts-title">{q.programLabel}{q.productLabel ? <span className="muted small"> · {q.productLabel}</span> : null}</div>
          {q.tierLabel && <div className="muted small">{q.tierLabel}</div>}
        </div>
        <StatusBadge status={q.status} />
      </div>

      {q.reasons && q.reasons.length > 0 && (
        <ul className="ts-reasons">
          {q.reasons.map((r, i) => (
            <li key={i} className={r.level === 'INELIGIBLE' ? 'err' : r.level === 'MANUAL' ? 'warn' : 'ok'}>{r.msg}</li>
          ))}
        </ul>
      )}

      {priced && (
        <>
          <div className="ts-hero">
            <div className="ts-hero-loan">
              <div className="ts-hero-k">Loan amount</div>
              <div className="ts-hero-v">{money(s.totalLoan)}</div>
            </div>
            <div className="ts-hero-rate">
              <div className="ts-hero-k">Note rate</div>
              <div className="ts-hero-v">{pct(q.noteRate)}</div>
            </div>
          </div>
          <div className="ts-grid">
            <div className="metrow"><span className="k">Initial advance</span><span className="v">{money(s.initialAdvance)}</span></div>
            {s.downPayment > 0 && <div className="metrow"><span className="k">Down payment</span><span className="v">{money(s.downPayment)}</span></div>}
            {s.rehabHoldback > 0 && <div className="metrow"><span className="k">Rehab holdback</span><span className="v">{money(s.rehabHoldback)}</span></div>}
            {s.financedReserve > 0 && <div className="metrow"><span className="k">Financed interest reserve</span><span className="v">{money(s.financedReserve)}</span></div>}
            <div className="metrow"><span className="k">Payment (at close)</span><span className="v">{money(s.initialPayment)}/mo</span></div>
            <div className="metrow"><span className="k">Payment (fully drawn)</span><span className="v">{money(s.monthlyPayment)}/mo</span></div>
            <div className="metrow"><span className="k">Origination ({pct(q.origPct, 3)})</span><span className="v">{money(q.origination)}</span></div>
            <div className="metrow"><span className="k">Est. title & settlement</span><span className="v">{money(q.title.total)}{!q.title.known ? ' *' : ''}</span></div>
            {q.closingCosts && <div className="metrow"><span className="k">Closing costs due</span><span className="v">{money(q.closingCosts.dueAtClosing)}</span></div>}
            {q.cashToClose != null && <div className="metrow"><span className="k">Cash to close</span><span className="v">{money(q.cashToClose)}</span></div>}
            {q.reserveRequirement != null && <div className="metrow"><span className="k">Asset reserves</span><span className="v">{money(q.reserveRequirement)}</span></div>}
            <div className="metrow"><span className="k">Loan-to-cost</span><span className="v">{pct(s.ltcPct, 1)}</span></div>
            {s.acqLtvPct > 0 && <div className="metrow"><span className="k">Initial / as-is LTV</span><span className="v">{pct(s.acqLtvPct, 1)}</span></div>}
            {s.arvPct > 0 && <div className="metrow"><span className="k">Loan-to-ARV</span><span className="v">{pct(s.arvPct, 1)}</span></div>}
            {q.liquidity != null && <div className="metrow"><span className="k">Liquidity to show</span><span className="v">{money(q.liquidity)}</span></div>}
            {q.guidelines && q.guidelines.caps && <div className="metrow"><span className="k">Max LTC guideline</span><span className="v">{pct(q.guidelines.caps.maxLtc, 1)}</span></div>}
            {q.guidelines && q.guidelines.caps && <div className="metrow"><span className="k">Max ARV guideline</span><span className="v">{pct(q.guidelines.caps.maxArvLtv, 1)}</span></div>}
          </div>
          {s.binding && <p className="muted small" style={{ marginTop: 6 }}>Sized by {s.binding}.</p>}
          {q.reserveBasis && <p className="muted small" style={{ margin: '2px 0 0' }}>Asset requirement: {q.reserveBasis} plus cash to close.</p>}
          {!q.title.known && <p className="muted small" style={{ margin: '2px 0 0' }}>* Title estimate uses the national baseline — no filed rate on file for this state.</p>}
        </>
      )}

      <div className="row" style={{ gap: 8, marginTop: 12 }}>
        <button className="btn primary" disabled={registering || (!priced && (borrower || q.status !== 'MANUAL'))}
          onClick={() => onRegister(q)}>
          {actionText}
        </button>
        {priced && <button className="btn ghost" onClick={() => printTermSheet(q, app)}>Print term sheet</button>}
        {priced && <button className="btn ghost" onClick={() => printPreApproval(q, app)}>Pre-approval</button>}
        <button className="btn ghost" onClick={onExportXlsx}>Export Excel</button>
        {!borrower && <button className="btn ghost" onClick={onImportClick}>Import Excel</button>}
        {q.status === 'INELIGIBLE' && <span className="muted small" style={{ alignSelf: 'center' }}>{borrower ? 'Your loan team can review alternatives.' : 'Resolve the ineligible items or override the basis to register.'}</span>}
      </div>
    </div>
  );
}

function ScenarioSummary({ ov, q }) {
  const exp = q && q.experience;
  const fields = [
    ['Strategy', ov.strategy || '—'],
    ['Loan type', ov.loanType || '—'],
    ['State', ov.state || '—'],
    [ov.isAssignment ? 'Seller price' : 'Purchase price', money(ov.isAssignment ? ov.sellerPrice : ov.purchasePrice)],
    ['As-is value', money(ov.asIsValue)],
    ['ARV', money(ov.arv)],
    ['Rehab budget', money(ov.rehabBudget)],
    ['FICO', ov.fico || '—'],
    ['Term', ov.term ? `${ov.term} months` : '—'],
    ['Track record', exp ? `${exp.flips} flips · ${exp.holds} holds · ${exp.ground} ground-up` : '—'],
  ];
  return (
    <>
      <div className="ts-inputs ts-readonly">
        {fields.map(([k, v]) => (
          <label key={k}><span>{k}</span><output>{v}</output></label>
        ))}
      </div>
      <p className="muted small" style={{ margin: '2px 0 12px' }}>
        Pulled from your application and verified track record. Your loan team can adjust the file if anything is missing or incorrect.{q && q.standard && q.standard.status ? ' Choose a qualifying product below.' : ''}
      </p>
    </>
  );
}

function StaffAdminControls({ ov, set }) {
  const number = (key, label, opts = {}) => (
    <label><span>{label}</span>
      <input className="input" type="number" inputMode="decimal" min={opts.min ?? 0} max={opts.max}
        step={opts.step || '0.01'} placeholder={opts.placeholder || ''}
        value={ov[key] ?? ''} onChange={(e) => set(key, e.target.value)} />
    </label>
  );
  const moneyInput = (key, label, placeholder) => (
    <label><span>{label}</span>
      <MoneyInput value={ov[key] ?? ''} placeholder={placeholder || '0'} onChange={(v) => set(key, v)} />
    </label>
  );
  return (
    <div className="ts-admin-panel portal">
      <div className="ts-admin-head">Pricing controls <span className="ts-admin-badge">Staff</span></div>
      <p className="muted small" style={{ margin: '0 0 10px' }}>
        These match the marketing term-sheet admin knobs and flow into the live quote, registration, term sheet, pre-approval and Excel export.
      </p>

      <div className="ts-admin-group">Rate markup / YSP</div>
      <div className="ts-inputs">
        {number('markupStdPct', 'Standard (%)', { step: '0.05', placeholder: '0.5' })}
        {number('markupGoldPct', 'Gold (%)', { step: '0.05', placeholder: '0.5' })}
      </div>

      <div className="ts-admin-group">Origination points</div>
      <div className="ts-inputs">
        {number('origStdPct', 'Standard (%)', { step: '0.25', placeholder: '1.25' })}
        {number('origGoldPct', 'Gold (%)', { step: '0.25', placeholder: '1.25' })}
      </div>

      <div className="ts-admin-group">Closing-cost overrides</div>
      <div className="ts-inputs">
        {moneyInput('lenderFee', 'UW / processing / legal', '2,195')}
        {moneyInput('creditFee', 'Credit report', '150')}
        {moneyInput('appraisalFee', 'Appraisal - POC', '800')}
        {moneyInput('titleFee', 'Title / escrow', 'auto-estimate')}
      </div>

      <div className="ts-admin-group">Manual scenario</div>
      <label className="ts-admin-check">
        <input type="checkbox" checked={!!ov.manualPricing} onChange={(e) => set('manualPricing', e.target.checked)} />
        <span>Price as a manual scenario with an admin-set basis.</span>
      </label>
      {ov.manualPricing && (
        <div className="ts-inputs" style={{ marginTop: 8 }}>
          {number('ovrAcqLTVPct', 'Initial / as-is LTV (%)', { step: '1', max: 100, placeholder: 'auto' })}
          {number('ovrARLTVPct', 'ARV LTV (%)', { step: '1', max: 100, placeholder: 'auto' })}
          {number('ovrLTCPct', 'LTC (%)', { step: '1', max: 100, placeholder: 'auto' })}
          {number('ovrRatePct', 'Note rate (%)', { step: '0.125', placeholder: 'auto' })}
          {number('ovrIrMonths', 'Interest reserve months', { step: '1', placeholder: 'from file' })}
        </div>
      )}
      {ov.manualPricing && <p className="muted small" style={{ margin: '8px 0 0' }}>Blank manual fields fall back to the program's computed value. Registered manual files are saved as manually reviewed terms.</p>}
    </div>
  );
}

export default function ProductRegistration({ appId, app, onRegistered, mode = 'staff' }) {
  const [data, setData] = useState(null);      // { current, history, quote, enginesReady }
  const [q, setQ] = useState(null);            // latest quoteAll { standard, gold, inputs, experience }
  const [program, setProgram] = useState('standard');
  const [ov, setOv] = useState(null);          // editable overrides (seeded from inputs)
  const [busy, setBusy] = useState(true);
  const [repricing, setRepricing] = useState(false);
  const [registering, setRegistering] = useState(false);
  const [err, setErr] = useState('');
  const [open, setOpen] = useState(true);
  const userEdited = useRef(false);
  const timer = useRef(null);
  const importInputRef = useRef(null);
  const isBorrower = mode === 'borrower';
  const loadPricing = () => isBorrower ? api.borrowerPricing(appId) : api.staffPricing(appId);
  const quotePricing = (overrides) => isBorrower ? api.borrowerPricingQuote(appId, overrides) : api.staffPricingQuote(appId, overrides);
  const registerProduct = (selectedProgram, overrides) => isBorrower
    ? api.borrowerRegisterProduct(appId, selectedProgram, overrides)
    : api.staffRegisterProduct(appId, selectedProgram, overrides);

  // Initial load. Re-seeds from the file whenever the file changes; the
  // userEdited flag is reset so a stale, edited what-if from a previous file
  // never reprices against the new file.
  useEffect(() => {
    let alive = true;
    userEdited.current = false;
    setBusy(true); setErr(''); setQ(null); setOv(null);
    loadPricing().then((d) => {
      if (!alive) return;
      setData(d);
      if (d.quote) { setQ(d.quote); setOv({ ...d.quote.inputs }); }
      if (d.current && d.current.program) setProgram(d.current.program);
    }).catch((e) => alive && setErr(e.message || 'Could not load pricing'))
      .finally(() => alive && setBusy(false));
    return () => { alive = false; };
  }, [appId, mode]);

  // Debounced server reprice whenever the staff edits an input. An alive guard
  // drops a late response so it can't overwrite newer state (or set state after
  // unmount / a file switch).
  useEffect(() => {
    if (!ov || !userEdited.current) return;
    let alive = true;
    if (timer.current) clearTimeout(timer.current);
    setRepricing(true);
    timer.current = setTimeout(() => {
      quotePricing(ov)
        .then((d) => { if (alive) setQ(d); })
        .catch((e) => { if (alive) setErr(e.message || 'Pricing failed'); })
        .finally(() => { if (alive) setRepricing(false); });
    }, 450);
    return () => { alive = false; if (timer.current) clearTimeout(timer.current); };
  }, [ov, appId, mode]);

  function set(k, v) { userEdited.current = true; setOv((o) => ({ ...o, [k]: v })); }
  function pickLadder(ltc) { set('targetLTC', ltc); }

  async function exportXlsx() {
    if (!ov) return;
    setErr('');
    try {
      await exportPortalXlsx(ov, app, program, q);
    } catch (e) {
      setErr(e.message || 'Excel export needs an internet connection to load the spreadsheet engine.');
    }
  }

  async function importXlsx(e) {
    const file = e.target.files && e.target.files[0];
    if (!file || !ov) return;
    setErr('');
    try {
      const st = await stateFromImportFile(file);
      const next = applyStateToOverrides(st, ov);
      userEdited.current = true;
      setOv(next);
      if (st && st.portal && st.portal.program) setProgram(st.portal.program === 'gold' ? 'gold' : 'standard');
    } catch (ex) {
      setErr(ex.message || 'Could not import that YS Excel file.');
    } finally {
      e.target.value = '';
    }
  }

  async function register(quote) {
    setRegistering(true); setErr('');
    try {
      await registerProduct(program, ov || {});
      const d = await loadPricing();
      setData(d);
      if (onRegistered) onRegistered();
    } catch (e) {
      // Surface engine reasons when the deal is ineligible.
      const detail = e.data && e.data.reasons ? e.data.reasons.map((r) => r.msg).join(' ') : (e.message || 'Could not register');
      setErr(detail);
    } finally { setRegistering(false); }
  }

  const cur = data && data.current;
  const active = q ? (program === 'gold' ? q.gold : q.standard) : null;
  const ladder = active && active.ladder;

  return (
    <div className="panel" style={{ marginTop: 18 }}>
      <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center', cursor: 'pointer' }} onClick={() => setOpen((o) => !o)}>
        <h3 style={{ margin: 0 }}>{isBorrower ? 'Product options & term sheet' : 'Product registration & term sheet'}</h3>
        <div className="row" style={{ gap: 10, alignItems: 'center' }}>
          {cur && <span className="ts-badge ok">Registered · {cur.program === 'gold' ? 'Gold Standard' : 'Standard'} · {pct(cur.note_rate)}</span>}
          <span className="muted">{open ? '▾' : '▸'}</span>
        </div>
      </div>

      {open && (
        <div style={{ marginTop: 12 }}>
          {busy && <p className="muted small">Pricing…</p>}
          {err && <div className="notice err" style={{ marginBottom: 10 }}>{err}</div>}
          {data && !data.enginesReady && <div className="notice err">Pricing engines are unavailable on the server.</div>}
          <input ref={importInputRef} type="file" accept=".xlsx,.xls,.json,.txt" style={{ display: 'none' }} onChange={importXlsx} />

          {cur && (
            <div className="ts-current">
              <strong>{isBorrower ? 'Selected product:' : 'Currently registered:'}</strong> {cur.product_label || (cur.program === 'gold' ? 'Gold Standard Program' : 'Standard Program')} —
              {' '}{money(cur.total_loan)} @ {pct(cur.note_rate)}
              {cur.registered_by_name ? ` · by ${cur.registered_by_name}` : ''}
              {cur.status && cur.status !== 'ELIGIBLE' ? ` · ${cur.status.toLowerCase()}` : ''}
            </div>
          )}

          {ov && (
            <>
              {isBorrower ? <ScenarioSummary ov={ov} q={q} /> : (
              <>
              {/* Editable pricing inputs — seeded from the file, staff can what-if. */}
              <div className="ts-inputs">
                <label><span>Strategy</span>
                  <select className="input" value={ov.strategy} onChange={(e) => set('strategy', e.target.value)}>
                    {STRATEGIES.every((s) => s.v !== ov.strategy) && <option value={ov.strategy}>{ov.strategy}</option>}
                    {STRATEGIES.map((s) => <option key={s.v} value={s.v}>{s.label}</option>)}
                  </select>
                </label>
                <label><span>Loan type</span>
                  <select className="input" value={ov.loanType} onChange={(e) => set('loanType', e.target.value)}>
                    <option>Purchase</option><option>Refinance</option>
                  </select>
                </label>
                <label><span>State</span>
                  <input className="input" value={ov.state || ''} maxLength={2} onChange={(e) => set('state', e.target.value.toUpperCase())} />
                </label>
                <label><span>{ov.isAssignment ? 'Seller price' : 'Purchase price'}</span>
                  <MoneyInput value={ov.isAssignment ? (ov.sellerPrice || '') : (ov.purchasePrice || '')}
                    onChange={(v) => set(ov.isAssignment ? 'sellerPrice' : 'purchasePrice', v)} />
                </label>
                <label><span>As-is value</span><MoneyInput value={ov.asIsValue || ''} onChange={(v) => set('asIsValue', v)} /></label>
                <label><span>ARV</span><MoneyInput value={ov.arv || ''} onChange={(v) => set('arv', v)} /></label>
                <label><span>Rehab budget</span><MoneyInput value={ov.rehabBudget || ''} onChange={(v) => set('rehabBudget', v)} /></label>
                <label><span>FICO</span>
                  <input className="input" type="number" min="300" max="850" value={ov.fico || ''} onChange={(e) => set('fico', e.target.value)} />
                </label>
                <label><span>Term (months)</span>
                  <input className="input" type="number" min="1" max="36" value={ov.term || ''} onChange={(e) => set('term', e.target.value)} />
                </label>
                <label><span>Interest reserve (months)</span>
                  <input className="input" type="number" min="0" max="24" value={ov.irMonths || 0} onChange={(e) => set('irMonths', e.target.value)} />
                </label>
                <label><span>Exp: flips</span>
                  <input className="input" type="number" min="0" value={ov.expFlips || 0} onChange={(e) => set('expFlips', e.target.value)} />
                </label>
                <label><span>Exp: holds</span>
                  <input className="input" type="number" min="0" value={ov.expHolds || 0} onChange={(e) => set('expHolds', e.target.value)} />
                </label>
                <label><span>Exp: ground-up</span>
                  <input className="input" type="number" min="0" value={ov.expGround || 0} onChange={(e) => set('expGround', e.target.value)} />
                </label>
              </div>
              <StaffAdminControls ov={ov} set={set} />
              <p className="muted small" style={{ margin: '2px 0 12px' }}>
                Seeded from the file{q && q.experience ? ` (track record: ${q.experience.flips} flips · ${q.experience.holds} holds · ${q.experience.ground} ground-up)` : ''}. Edits are for what-if only until you register.{repricing ? ' · repricing…' : ''}
              </p>
              </>
              )}

              {/* Program tabs */}
              <div className="ts-tabs">
                <button className={`ts-tab ${program === 'standard' ? 'on' : ''}`} onClick={() => setProgram('standard')}>
                  Standard Program {q && q.standard && <StatusBadge status={q.standard.status} />}
                </button>
                <button className={`ts-tab ${program === 'gold' ? 'on' : ''}`} onClick={() => setProgram('gold')}>
                  Gold Standard {q && q.gold && <StatusBadge status={q.gold.status} />}
                </button>
              </div>

              {/* Standard leverage ladder — trade leverage for a better rate. */}
              {program === 'standard' && ladder && ladder.rows && ladder.rows.length > 0 && (
                <div className="ts-ladder">
                  <div className="muted small" style={{ marginBottom: 4 }}>Leverage options — click to size at that LTC:</div>
                  <div className="ts-ladder-rows">
                    {ladder.rows.map((r) => {
                      const chosen = Math.abs((ov.targetLTC || ladder.maxBucket) - r.ltc) < 1e-6;
                      return (
                        <button key={r.ltc} className={`ts-lad ${chosen ? 'on' : ''}`} onClick={() => pickLadder(r.ltc)}>
                          <span className="lad-ltc">{pct(r.ltc, 1)}{r.isMax ? ' · max' : ''}</span>
                          <span className="lad-loan">{money(r.totalLoan)}</span>
                          <span className="lad-rate">{pct(r.noteRate)}</span>
                        </button>
                      );
                    })}
                  </div>
                  {ov.targetLTC > 0 && <button className="btn link small" onClick={() => pickLadder(0)}>Reset to max leverage</button>}
                </div>
              )}

              <TermSheet q={active} app={app} onRegister={register} registering={registering}
                isCurrent={!!cur && cur.program === program} mode={mode}
                onExportXlsx={exportXlsx} onImportClick={() => importInputRef.current && importInputRef.current.click()} />
            </>
          )}
        </div>
      )}
    </div>
  );
}
