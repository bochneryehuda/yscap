import React, { forwardRef, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react';
import { api } from '../lib/api.js';
import { useSubmitGate } from '../lib/useSubmitGate.js';
import TermSheetStudio, {
  buildStudioState, scenarioFromEngineInputs, adminStateFromEngineInputs, blobToBase64,
} from './TermSheetStudio.jsx';
import { fullNameOf } from '../lib/personName.js';
import { moneyNum } from '../lib/money.js';
import { fmtRatePct, fmtRatePctFromPct } from '../lib/rateFormat.js';
import { askConfirm, askPrompt } from '../lib/dialog.js';

/* Product registration on a loan file — borrower AND staff logins. The panel
   shows the registered product; "Reprice / re-register" opens the real static
   Term Sheet Studio in the SAME full-screen tool sheet as the Rehab Budget —
   an edge-to-edge page takeover with a slim header, where leaving saves your
   working scenario back onto the file. Register exports every detail into the
   file: the registration row (full inputs + quote), the application's loan
   terms, the liquidity condition, and the exact studio PDF attached as the
   file's current term sheet (prior sheets are marked superseded). Re-pricing
   and re-registering any number of times is the intended workflow. */

const money = (n) => (n == null || n === '' ? '—' : '$' + Math.round(Number(n)).toLocaleString('en-US'));
// Fees / cash-to-close / liquidity show EXACT cents (owner-directed 2026-07-16);
// loan amount / advance / holdback stay whole-dollar (frozen loan rounding).
const money2 = (n) => (n == null || n === '' ? '—' : '$' + Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }));
const pct = (f, d = 2) => (f == null || f === '' ? '—' : (Number(f) * 100).toFixed(d) + '%');
const when = (t) => (t ? new Date(t).toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' }) : '');

// A short, human first-clause of the engine's own reason for a non-eligible status, so a
// "manual review" / "not eligible" badge can always say WHY. Prefers the reason matching the
// status (MANUAL vs INELIGIBLE); the full text still shows in the reasons list elsewhere.
function shortReason(reasons, status) {
  const rs = Array.isArray(reasons) ? reasons : [];
  const want = status === 'INELIGIBLE' ? 'INELIGIBLE' : status === 'MANUAL' ? 'MANUAL' : null;
  const nonOk = rs.filter((r) => r && r.level !== 'ELIGIBLE');
  const pick = (want ? nonOk.filter((r) => r.level === want) : nonOk).concat(nonOk)[0];
  if (!pick || !pick.msg) return '';
  let m = String(pick.msg).split(' — ')[0].split('. ')[0].trim();
  if (m.length > 96) m = m.slice(0, 94).replace(/[\s,;:]+\S*$/, '') + '…';
  return m;
}
const statusWord = (st) => (st === 'MANUAL' ? 'manual-review exception' : st === 'INELIGIBLE' ? 'not eligible' : String(st || '').toLowerCase());

// The rehab SCOPE a registered scenario describes, in the loan application's own
// words. Mirrors the server's rehabTypeFromInputs (src/lib/product-registration.js),
// which writes this same label onto the file's Rehab type on register — so the
// registered product visibly carries what kind of rehab was priced, not just its
// budget. Null (a bridge deal, or a renovation strategy with no rehab money)
// renders no row at all.
function registeredRehabType(inp) {
  const i = inp || {};
  if (/ground/i.test(String(i.strategy || ''))) return 'Ground-up construction';
  if (/bridge|stabil/i.test(String(i.strategy || ''))) return null;
  if (i.sqftAddition) return 'Adding square footage';
  if (i.heavyRehab) return 'Heavy / gut rehab';
  if (!(moneyNum(i.rehabBudget) > 0)) return null;
  return 'Light / moderate';
}

function addrLine(a) {
  if (!a) return '';
  if (typeof a === 'string') return a;
  // Every historical property_address shape (post-#717 audit): components,
  // oneLine, or a ClickUp-written formatted string — never let a shape gap make
  // the file's address read as blank (that would silently fall back to a stale
  // registered-scenario address).
  if (a.oneLine) return a.oneLine;
  const composed = [a.line1 || a.street || a.address, a.city, a.state, a.zip].filter(Boolean).join(', ');
  return composed || a.formatted_address || a.formatted || '';
}

/* Admin-mode gate — the SAME password gate the static Term Sheet tool carries,
   now CHECKED ON THE SERVER (POST /api/pricing-admin/unlock). This file is
   compiled into the one portal bundle EVERY visitor downloads, so the cyrb53
   hash that used to sit here shipped the gate to every borrower's browser.
   Same password, same behavior; the check just isn't decided on their machine.
   Unlocking reveals the studio's admin pricing zone (markups, origination, fee
   overrides, manual basis) — nothing more: a borrower session has been unable to
   send staff pricing overrides since audit S1-04 (src/routes/borrower.js). */
async function checkAdminPassword(pw) {
  try {
    const r = await fetch('/api/pricing-admin/unlock', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: String(pw == null ? '' : pw) }),
    });
    if (!r.ok) return false;
    const d = await r.json().catch(() => null);
    return !!(d && d.ok === true);
  } catch (_) { return false; }
}

// Omit empty values so a blank studio field never overrides file data with 0.
function compact(obj) {
  const out = {};
  for (const k of Object.keys(obj)) {
    const v = obj[k];
    if (v === '' || v == null) continue;
    out[k] = v;
  }
  return out;
}

/* The staff registration carries the FULL studio scenario (deal economics,
   experience, admin markups/fees/manual basis) so the server-side frozen
   engines recompute exactly what the studio displayed. Borrowers may only
   send the knobs a borrower owns; the deal basis stays the file's. */
// A structural leverage/ARV override (LTV/LTC/ARV) makes the registration a
// MANUAL PRODUCT (server: manual-program.js). Markup/points/fees/rate alone do
// not. Mirrors the server's STRUCTURAL_OVERRIDE_KEYS so the studio can prompt for
// the required reserve months before it registers.
const MANUAL_STRUCTURAL_KEYS = ['ovrAcqLTVPct', 'ovrARLTVPct', 'ovrLTCPct'];
export function overridesAreManual(ov) {
  if (!ov) return false;
  return MANUAL_STRUCTURAL_KEYS.some((k) => {
    const v = ov[k];
    return v != null && v !== '' && Number(v) !== 0 && !Number.isNaN(Number(v));
  });
}

export function overridesFromSnapshot(snap, mode) {
  const f = snap.fields;
  const d = snap.d || {};
  const base = {
    ...compact({
      targetLTC: d.inp && d.inp.targetLTC ? d.inp.targetLTC : null,
      // THE VALUE-SIDE LEVER MUST TRAVEL WITH THE COST-SIDE ONE. On Silver (EMCAP)
      // a ladder rung can be earned by giving up ARV leverage instead of cost
      // leverage, and the two are different engine inputs. Carrying only targetLTC
      // would register the deal's MAXIMUM loan whenever the borrower picked a
      // value-side step — the file would price differently from the paper they
      // signed. compact() drops it when unset, so every other program is unchanged.
      targetARLTV: d.inp && d.inp.targetARLTV ? d.inp.targetARLTV : null,
      // Interest reserve may instead be an exact dollar amount (owner-directed
      // 2026-07-12) — carried through to the frozen engine, which honors it over
      // months and fits it under the same caps. A BLANK amount is sent as 0 (not
      // null) so it actively clears any previously-registered amount: null would be
      // skipped by the override loop, leaving a stale amount to wrongly win over a
      // freshly-chosen months value when a file switches from amount back to months.
      irAmount: f.irAmount === '' ? 0 : f.irAmount,
      term: f.tsTerm,
      fico: f.fico,
      expFlips: f.expFlips, expHolds: f.expBrrrr, expGround: f.expGround,
      // Vesting LLC typed on the studio (owner-directed 2026-07-21): the
      // subject-property LLC name flows to the register endpoints, which
      // resolve-or-create it as the file's vesting LLC when none is linked
      // yet. Whitespace-only is dropped by compact() so a blank studio input
      // never accidentally creates a bogus llcs row.
      entityName: f.entityName && String(f.entityName).trim() ? String(f.entityName).trim() : null,
    }),
    // A blanked months field actively CLEARS the requested reserve on
    // re-register (root-caused 2026-07-16: compact() omitted it, so the server
    // silently fell back to the previously-registered months). buildInputs
    // maps '' → 0 — the same contract irAmount already has. An ABSENT field
    // (undefined — the studio never rendered it) still sends nothing.
    ...(f.irMonths === '' ? { irMonths: '' } : f.irMonths != null ? { irMonths: f.irMonths } : {}),
  };
  if (mode !== 'staff') return base;
  const refi = /refinance/i.test(f.dealPurpose || '');
  return {
    ...base,
    ...compact({
      loanType: refi ? 'Refinance' : 'Purchase',
      strategy: f.dealType,
      state: f.propState,
      propertyType: f.propType === '2-4' ? '2-4 units' : 'SFR (1 unit)',
      address: f.addrTBD ? null : f.propAddr,
      purchasePrice: refi ? null : f.price,
      sellerPrice: f.isAssign ? f.origPrice : null,
      asIsValue: f.asIs,
      arv: f.arv,
      rehabBudget: f.construction,
      origStdPct: f.tsOrigStd, origGoldPct: f.tsOrigGold, origSilverPct: f.tsOrigSilver,
      origManualPct: f.tsOrigManual,
      lenderFee: f.tsFeeUW, creditFee: f.tsFeeCredit, appraisalFee: f.tsFeeAppr,
      titleFee: f.tsFeeTitle,
      ovrAcqLTVPct: f.tsManualOn ? f.tsMLtv : null,
      ovrARLTVPct: f.tsManualOn ? f.tsMArv : null,
      ovrLTCPct: f.tsManualOn ? f.tsMLtc : null,
      ovrRatePct: f.tsManualOn ? f.tsMRate : null,
      ovrIrMonths: f.tsManualOn ? f.tsMIr : null,
      // Admin assignment exception: the approved effective purchase price. Must
      // ride the register/quote payload or the server re-prices at the auto 15%
      // cap and registers a different loan than the admin saw (audit #3, was
      // present only in the V1 copy). Engine clamps it to [seller, real total].
      ovrEffPrice: f.isAssign ? f.tsEffPrice : null,
      // Out-of-pocket rehab exception (owner-authorized 2026-07-31): the dollar amount
      // to bring out of pocket so the initial advance rises toward its cap. Rides the
      // register/quote payload (buildInputs whitelists it); the engine/normalize caps
      // it at the maximum. A blank is dropped by compact() (no exception).
      oopRehab: f.tsOopRehab,
      // A typed loan amount (owner-directed 2026-08-06). Rides the register/quote
      // payload exactly like oopRehab above. It reaches the frozen engines as a
      // voluntary CEILING, so it can only ever reduce and carries no approval —
      // the way UP is the manual basis keys above, which already escalate. A blank
      // is dropped by compact(), so an untouched box changes nothing. The borrower
      // register route's own allowlist never accepts it, so it stays staff-only
      // even though this panel is shared.
      targetLoan: f.tsTargetLoan,
      // The payoff the studio priced on — a refinance pays the existing loan out of
      // the initial advance, so this decides cash to close and its DIRECTION.
      // Without it the register silently used the file's (possibly stale, possibly
      // empty) column while the printed sheet used what the officer typed.
      payoff: f.payoff,
    }),
    cashOut: /cash/i.test(f.dealPurpose || ''),
    isAssignment: !!f.isAssign,
    heavyRehab: f.rehabScope === 'heavy',
    sqftAddition: !!f.sqft,
    manualPricing: !!f.tsManualOn,
    // "Raise the initial to its max" toggle — pairs with oopRehab (uses the full max).
    oopRehabMax: !!f.tsOopRehabMax,
    // Markup: an EXPLICITLY blanked field sends '' — the server drops the
    // sticky per-file markup and prices at the company default (root-caused
    // 2026-07-16: compact() omitted it, so the old sticky silently re-applied).
    // An untouched/absent field still sends nothing.
    ...(f.tsYspStd === '' ? { markupStdPct: '' } : f.tsYspStd != null ? { markupStdPct: f.tsYspStd } : {}),
    ...(f.tsYspGold === '' ? { markupGoldPct: '' } : f.tsYspGold != null ? { markupGoldPct: f.tsYspGold } : {}),
    ...(f.tsYspSilver === '' ? { markupSilverPct: '' } : f.tsYspSilver != null ? { markupSilverPct: f.tsYspSilver } : {}),
    // Manual GOLD top-tier markup (item 15): a blank clears the sticky per-file
    // value (company/historic default governs); a value overrides Gold Tier 1.
    ...(f.tsYspGoldT1 === '' ? { markupGoldT1Pct: '' } : f.tsYspGoldT1 != null ? { markupGoldT1Pct: f.tsYspGoldT1 } : {}),
  };
}

// Term-sheet options (owner-directed 2026-07-22) from the studio snapshot — the
// DISPLAY / record-only attributes the register persists (never engine math). The
// min-interest flag is the admin's EFFECTIVE choice for the drilled program: a
// manual scenario is ON unless the manual toggle is unchecked; Standard/Gold are
// OFF unless the admin added it per program. The server re-applies the same
// program default for any missing value.
export function termOptionsFromSnapshot(snap) {
  const f = (snap && snap.fields) || {};
  const gold = snap && snap.program === 'gold';
  const silver = snap && snap.program === 'silver';
  let minInterestEnabled;
  if (f.tsManualOn) minInterestEnabled = f.tsMinIntManual !== false;      // manual: on unless explicitly unchecked
  else minInterestEnabled = gold ? !!f.tsMinIntGold : silver ? !!f.tsMinIntSilver : !!f.tsMinIntStd;    // Standard/Gold/Silver: off unless added
  return {
    accrualType: f.tsAccrual === 'dutch' ? 'dutch' : 'non_dutch',
    minInterestEnabled,
    deferredOrigPct: (f.tsDeferredOrig === '' || f.tsDeferredOrig == null) ? 0 : (Number(f.tsDeferredOrig) || 0),
    estClosingDate: f.estClosingDate || '',
    /* The TYPED cash-out override rides the same channel as the closing date
       (audit-found 2026-07-31). Without it the officer's figure printed on the
       term sheet PDF and never reached the loan file, so the file and the sheet
       the borrower was shown quoted different cash — the exact divergence the
       payoff work exists to end. Display/record only; no engine reads it. */
    estimatedCashOut: f.cashOutAmt == null ? '' : String(f.cashOutAmt),
  };
}

/* Every detail of the registered product, laid out in the file. `reg` is a
   product_registrations row (quote + inputs jsonb). */
export function RegisteredProductDetails({ reg, compactView = false, showAdmin = false }) {
  if (!reg) return null;
  const q = typeof reg.quote === 'string' ? JSON.parse(reg.quote) : (reg.quote || {});
  const inp = typeof reg.inputs === 'string' ? JSON.parse(reg.inputs || '{}') : (reg.inputs || {});
  const s = q.sizing || {};
  const cc = q.closingCosts || {};
  // `caps` = the EFFECTIVE ceiling this deal was sized and priced at (unchanged
  // meaning — every enforcement reader still uses it). `programCaps` = the PROGRAM
  // MAXIMUM this borrower profile can actually reach: the tier cap already lowered to
  // the highest leverage band the rate grid genuinely prices. Owner-reported
  // 2026-07-30 — a label promising the program maximum must be BOTH fixed (it may not
  // move when the interest reserve moves) and REACHABLE ("the tier two cannot anytime
  // get 92.5 … because it doesn't price — so keep that tier at 85%"). Display only.
  const caps = (q.guidelines && q.guidelines.caps) || null;
  const cappedWhy = (q.guidelines && q.guidelines.leverageCappedWhy) || null;
  const progMax = (q.guidelines && q.guidelines.programCaps) || caps;
  const pricedLower = !!(progMax && caps && (
    caps.maxLtc < progMax.maxLtc - 1e-9 || caps.maxArvLtv < progMax.maxArvLtv - 1e-9 || caps.maxAcqLtv < progMax.maxAcqLtv - 1e-9));
  const Row = ({ k, v, sub = false }) => (
    <div className={'metrow' + (sub ? ' sos-sub-row' : '')}><span className="k">{k}</span><span className="v">{v}</span></div>
  );
  /* THE LINE A SECTION EXISTS TO PRODUCE (owner-directed 2026-08-07: "we also need
     to have more totals … a total of the closing costs, with the origination fee,
     legal fee, and title fees all together"). Every total on this page is a figure
     the pricing engine itself produced — never a sum this component adds up, which
     could silently disagree with the loan by a cent. */
  const Total = ({ k, v }) => (
    <div className="metrow sos-total"><span className="k">{k}</span><span className="v">{v}</span></div>
  );
  const Sec = ({ title, note, children, internal = false }) => (
    <section className={'sos' + (internal ? ' sos-internal' : '')}>
      <p className="sos-h">{title}{internal && <span className="sos-internal-tag">internal</span>}</p>
      {note && <p className="sos-sub">{note}</p>}
      {children}
    </section>
  );
  const g = q.guidelines || {};
  const refi = q.refi || null;                       // null on a purchase
  const isRefi = !!refi || inp.loanType === 'Refinance';
  const oop = Number(s.oopRehab) || 0;               // rehab brought out of pocket (exception)
  const payoff = Number(refi ? refi.payoff : inp.payoff) || 0;
  /* Our buy rate and margin. Present ONLY on a staff read: the server keeps the
     whole build-up inside `adminPricing`, which every borrower-facing path strips
     (routes/borrower.js, lib/tpr-export.js), and `showAdmin` is the second layer.
     `exact` is the server's own "this was measured, not estimated" flag — an
     unmeasurable build-up shows the note rate alone rather than a plausible guess. */
  const build = (showAdmin && q.adminPricing && q.adminPricing.rateBuildUp) || null;
  const showBuild = !!(build && build.exact && build.buyRatePct != null);
  return (
    <div className={compactView ? '' : 'panel'} style={compactView ? {} : { background: 'var(--ink-2)', marginTop: 10 }}>
      <div className="row" style={{ alignItems: 'baseline', gap: 8, marginBottom: 8 }}>
        <strong>{q.programLabel || (reg.program === 'gold' ? 'Gold Standard Program' : reg.program === 'silver' ? 'Silver Program' : reg.program === 'manual' ? 'Manual Program' : 'Standard Program')}</strong>
        {q.productLabel && <span className="muted small">· {q.productLabel}</span>}
        {q.tierLabel && <span className="muted small">· {q.tierLabel}</span>}
        {reg.status && reg.status !== 'ELIGIBLE' && <span className="ts-badge warn">{statusWord(reg.status)}</span>}
        <div className="spacer" />
        <span className="muted small">Registered {when(reg.created_at)}{reg.registered_by_name ? ` by ${reg.registered_by_name}` : ''}</span>
      </div>
      {reg.status && reg.status !== 'ELIGIBLE' && shortReason(q.reasons, reg.status) && (
        <p className="small" style={{ margin: '-2px 0 10px', color: 'var(--warn, #c69a4b)' }}>
          <strong>{reg.status === 'INELIGIBLE' ? 'Not eligible as entered' : 'Manual review needed'}:</strong> {shortReason(q.reasons, reg.status)}
        </p>
      )}
      {/* One flowing two-column run, NOT two hand-dealt halves — the money sections
          are much longer than the structure ones, so splitting them by hand left
          half a screen blank beside them. */}
      <div className="sos-cols">
          {/* RATE — the owner asked to see the rate the way it is BUILT ("the buy
              rate, the markup, and the final rate"), not just the number the
              borrower pays. On a borrower read, and whenever the build-up could
              not be measured exactly, this is simply the note-rate row. Term,
              payments and the draw fee are their OWN section below: a total has to
              be the LAST line of its sum, or it reads as one more entry. */}
          <Sec title="Rate" internal={showBuild}
            note={showBuild ? 'What the note rate is made of. The buy rate and our margin are internal — never quote them to a borrower.' : null}>
            {showBuild && <Row k="Program buy rate" v={fmtRatePctFromPct(build.buyRatePct) + '%'} />}
            {showBuild && <Row k="YS markup" v={(build.markupPct > 0 ? '+ ' : '') + fmtRatePctFromPct(build.markupPct) + '%'} />}
            <Total k="Note rate (interest-only)" v={fmtRatePct(q.noteRate ?? reg.note_rate) + '%'} />
            {build && build.why === 'rate_overridden' && (
              <p className="small" style={{ margin: '6px 0 0', color: '#4B585C' }}>
                An admin set this rate directly, so it carries no buy rate / markup build-up.
              </p>
            )}
          </Sec>

          <Sec title="Payments & term">
            <Row k="Term" v={inp.term ? inp.term + ' months' : '—'} />
            <Row k="Payment — initial advance" v={s.initialPayment ? money(s.initialPayment) + '/mo' : '—'} />
            <Row k="Payment — fully drawn" v={s.monthlyPayment ? money(s.monthlyPayment) + '/mo' : '—'} />
            {Number(g.drawFee) > 0 && <Row k="Draw fee (per draw)" v={money2(g.drawFee)} />}
          </Sec>

          {/* LOAN STRUCTURE — the three pieces of the loan, then the loan. Ordered
              so they read as parts of the total below them (the frozen rounding
              rule guarantees they reconcile to the cent). */}
          <Sec title="Loan structure" note="The advance, the holdback and any financed reserve are the three pieces of the loan.">
            <Row k="Initial advance (at closing)" v={money(s.initialAdvance)} />
            <Row k="Construction holdback (drawn later)" v={money(s.rehabHoldback)} />
            {s.financedReserve > 0 && <Row k="Financed interest reserve" v={money(s.financedReserve)} />}
            <Total k="Total loan amount" v={money(s.totalLoan ?? reg.total_loan)} />
          </Sec>

          {/* WHAT THE BORROWER PUTS IN — the money that is NOT the loan. The
              out-of-pocket rehab row is the owner's "I want to show what is out of
              pocket of rehab": an approved exception that moves part of the rehab
              budget off the holdback and onto the borrower so the initial advance
              can rise. */}
          <Sec title="Borrower's own funds in the deal">
            {!isRefi && <Row k="Down payment (equity)" v={money(s.downPayment)} />}
            {oop > 0 && <Row k="Rehab out of pocket (approved exception)" v={money2(oop)} />}
            {s.assignmentExcessOOP > 0 && <Row k="Assignment fee over the financeable cap" v={money(s.assignmentExcessOOP)} />}
            {oop > 0 && s.maxOopRehab > 0 && (
              <Row k="Most that could be taken out of pocket" v={money2(s.maxOopRehab)} />
            )}
            {isRefi && !(oop > 0) && !(s.assignmentExcessOOP > 0) && (
              <p className="small" style={{ margin: '4px 0 0', color: '#4B585C' }}>
                A refinance has no down payment — the cash to close below is what the payoff and the closing costs come to over the funds advanced.
              </p>
            )}
          </Sec>

          <Sec title="Leverage" note="Where this loan sits against value, cost and the program's ceilings.">
            <Row k="Loan-to-cost (LTC)" v={pct(s.ltcPct, 1)} />
            <Row k="Initial / as-is LTV" v={pct(s.acqLtvPct, 1)} />
            <Row k="Loan-to-ARV" v={pct(s.arvPct, 1)} />
            {Number(s.costBasis) > 0 && <Row k="Total project cost (the LTC basis)" v={money(s.costBasis)} />}
            {reg.target_ltc > 0 && <Row k="Selected leverage (LTC target)" v={pct(reg.target_ltc, 1)} />}
            {s.binding && <Row k="Binding limit" v={s.binding} />}
            {progMax && ((q.kind === 'bridge' || progMax.maxLtc >= 1 || progMax.maxArvLtv >= 1)
              // Bridge (and any no-cap product) has no LTC/ARV ceiling — the engine
              // uses a 100% sentinel. Don't display "100.0%" as if it were a real cap;
              // show only the as-is advance cap that actually governs (audit #12).
              ? <Row k="Program max — as-is" v={pct(progMax.maxAcqLtv, 1)} />
              : <Row k="Program max — LTC / ARV / as-is" v={`${pct(progMax.maxLtc, 1)} / ${pct(progMax.maxArvLtv, 1)} / ${pct(progMax.maxAcqLtv, 1)}`} />)}
            {pricedLower && <Row k="Most this deal can be priced at — LTC / ARV" v={`${pct(caps.maxLtc, 1)} / ${pct(caps.maxArvLtv, 1)}`} />}
            {pricedLower && (
              <p className="small" style={{ margin: '6px 0 0', color: '#4B585C' }}>
                {cappedWhy || 'On this deal the program prices a lower leverage band than the program maximum.'}{' '}
                The program maximum above is set by the tier (FICO and experience) and does not change when the deal changes — including the interest reserve.
              </p>
            )}
          </Sec>

          {/* CLOSING COSTS, WITH THE TOTAL THE OWNER ASKED FOR BY NAME: "a total of
              the closing costs, with the origination fee, legal fee, and title fees
              all together". `dueAtClosing` IS that sum (origination + UW/legal +
              credit + title + any extra fees), straight from the engine — the
              appraisal sits BELOW it because it is paid outside closing, and folding
              it in would overstate what the borrower brings to the table. */}
          <Sec title="Closing costs" note="Everything charged at the closing table, then the appraisal, which is paid separately.">
            <Row k={`Origination (${q.origPct != null ? (q.origPct * 100).toFixed(3).replace(/\.?0+$/, '') + '%' : '—'})`} v={money2(q.origination)} />
            {/* TPO broker origination fee (owner-directed 2026-08-06) — only present on
                a broker-registered file where a broker fee is set; retail registrations
                never carry it, so this row never renders on them. */}
            {Number(cc.brokerFee) > 0 && (
              <Row k={`Broker origination fee${cc.brokerFeePct != null ? ` (${cc.brokerFeePct}%)` : ''}`} v={money2(cc.brokerFee)} />
            )}
            <Row k="UW / processing / legal" v={money2(cc.lenderFee)} />
            <Row k="Credit report" v={money2(cc.creditFee)} />
            <Row k="Title / escrow (est.)" v={money2(cc.titleAndSettlement)} />
            {Array.isArray(cc.extraFees) && cc.extraFees.map((f, i) => (
              <Row key={i} k={f.name} v={money2(f.amount)} />
            ))}
            <Total k="Total closing costs due at closing" v={money2(cc.dueAtClosing)} />
            <Row k="Appraisal (est., paid outside closing)" v={money2(cc.appraisalPoc)} sub />
            <Total k="Total closing costs including the appraisal" v={money2(cc.totalIncludingPoc)} />
          </Sec>

          {/* CASH TO CLOSE — itemized the way the engine actually computes it, which
              is a DIFFERENT sum on a refinance (payoff + closing − the funds we
              advance) than on a purchase (down payment + closing). */}
          <Sec title="Cash to close"
            note={isRefi ? 'On a refinance the borrower brings whatever the payoff and the closing costs come to over the funds we advance.'
              : 'The equity and the closing costs the borrower brings to the table.'}>
            {isRefi ? (
              <>
                <Row k="Payoff of the existing loan" v={payoff > 0 ? money2(payoff) : '—'} />
                <Row k="Closing costs due at closing" v={money2(refi ? refi.closing : cc.dueAtClosing)} />
                <Row k="Less funds advanced at closing" v={'− ' + money2(refi ? refi.fundedAtClose : s.initialAdvance)} />
                <Total k="Estimated cash to close" v={money2(q.cashToClose)} />
                {refi && Number(refi.cashOut) > 0 && <Total k="Cash out to the borrower" v={money2(refi.cashOut)} />}
              </>
            ) : (
              <>
                <Row k="Down payment (equity)" v={money2(s.downPayment)} />
                {s.assignmentExcessOOP > 0 && <Row k="Assignment fee over the financeable cap" v={money2(s.assignmentExcessOOP)} />}
                <Row k="Closing costs due at closing" v={money2(cc.dueAtClosing)} />
                <Total k="Estimated cash to close" v={money2(q.cashToClose)} />
              </>
            )}
          </Sec>

          {/* LIQUIDITY — the engine's own build-up:
                cashToClose + reserveRequirement + oopRehab + closingBuffer.
              Itemizing it is the point: "liquidity to verify" as a bare figure told
              nobody WHY the borrower has to show that much. */}
          <Sec title="Liquidity to verify" note="The cash the borrower has to actually show us, and what makes it up.">
            <Row k="Estimated cash to close" v={money2(q.cashToClose)} />
            <Row k={`Reserve to show${q.reserveBasis ? ` (${q.reserveBasis})` : ''}${q.reserveMonths ? ` · ${q.reserveMonths} months` : ''}`}
              v={money2(q.reserveRequirement)} />
            {oop > 0 && <Row k="Rehab out of pocket" v={money2(oop)} />}
            {/* 1% closing-cost buffer (owner-authorized 2026-07-31): extra cash to
                verify so attorney/other closing charges never run short. Waivable
                per file by an admin (toggle below the card). */}
            {(Number(q.closingBuffer) > 0 || q.closingBufferWaived) && (
              <Row k={q.closingBufferWaived ? 'Closing cost buffer — waived on this file' : 'Closing cost buffer (1% of loan)'}
                v={q.closingBufferWaived ? '$0.00' : money2(q.closingBuffer)} />
            )}
            <Total k="Total liquidity to verify" v={money2(q.liquidity ?? q.liquidityRequired)} />
          </Sec>

          <Sec title="Scenario as registered" note="The deal exactly as it was priced. Changing any of these reopens Products &amp; pricing.">
          <Row k="Strategy / purpose" v={`${inp.strategy || '—'} · ${inp.loanType || '—'}${inp.cashOut ? ' (cash-out)' : ''}`} />
          {/* NAME THE FIGURE THE LOAN WAS SIZED ON (owner-directed 2026-08-02).
              On a refinance `inp.purchasePrice` IS the as-is value — that is the
              engine's own contract, and how the studio and the public form have
              always sent it — so a row labelled "Purchase price" here would put
              a purchase-price label on the property's current value. The as-is
              row below already carries the number; on a refinance this row would
              simply repeat it, so it is dropped. */}
          {inp.loanType !== 'Refinance' && <Row k="Purchase price" v={money(inp.purchasePrice)} />}
          {inp.isAssignment && <Row k="Seller price / assignment fee" v={`${money(inp.sellerPrice)} / ${money(Math.max(0, (inp.purchasePrice || 0) - (inp.sellerPrice || 0)))}`} />}
          {inp.isAssignment && q.assignment && (q.assignment.overLimit || q.assignment.overridden) &&
            <Row k={`Effective purchase price ${q.assignment.overridden ? '(admin exception)' : q.assignment.dollarCap ? '(fee capped at the program limit)' : '(fee capped at 15%)'}`} v={money(q.assignment.recognizedPrice)} />}
          <Row k="As-is value / ARV" v={`${money(inp.asIsValue)}${inp.asIsDefaulted ? ' (= purchase, defaulted)' : ''} / ${money(inp.arv)}`} />
          {/* THE PAYOFF, which the owner asked for by name. It is a real pricing
              input on a refinance (cash-to-close is sized off it), and it was on no
              surface here at all. */}
          {isRefi && <Row k="Payoff of the existing loan" v={payoff > 0 ? money(payoff) : '—'} />}
          <Row k="Rehab budget" v={money(inp.rehabBudget)} />
          {registeredRehabType(inp) && <Row k="Rehab scope" v={registeredRehabType(inp)} />}
          {oop > 0 && <Row k="Of that, out of pocket" v={money2(oop)} sub />}
          <Row k="Property type / units" v={`${inp.propertyType || '—'}${inp.units ? ' · ' + inp.units + (inp.units > 1 ? ' units' : ' unit') : ''}`} />
          <Row k="FICO / experience" v={`${inp.fico || '—'} · ${inp.expFlips || 0} flips / ${inp.expHolds || 0} holds / ${inp.expGround || 0} ground-up`} />
          <Row k="Requested interest reserve" v={`${inp.irAmount ? money(inp.irAmount) : `${inp.irMonths || 0} months`}${(inp.irAmount > 0 || inp.irMonths > 0) ? ` · financed: ${money(s.financedReserve || 0)}` : ''}`} />
          {showAdmin && q.adminPricing && (q.adminPricing.markupPct != null || q.adminPricing.manualPricing) && (
            <Row k="Admin pricing" v={`${q.adminPricing.markupPct != null ? 'markup ' + q.adminPricing.markupPct + '%' : ''}${q.adminPricing.manualPricing ? ' · manual basis' : ''}`.trim()} />
          )}
          </Sec>

          {(() => {
            // Term-sheet options (owner-directed 2026-07-22) — accrual, 3-month
            // minimum interest, deferred origination fee, and the estimated dates.
            const to = typeof reg.term_options === 'string' ? (() => { try { return JSON.parse(reg.term_options); } catch (_) { return null; } })() : (reg.term_options || null);
            if (!to) return null;
            const niceDate = (ymd) => {
              const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(ymd || ''));
              return m ? new Date(+m[1], +m[2] - 1, +m[3]).toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' }) : '—';
            };
            const def = Number(to.deferredOrigPct) || 0;
            return (
              <Sec title="Term-sheet options" note="What the term sheet says beyond the numbers.">
                <Row k="Guaranty / recourse" v={to.coBorrowerPgWaived === true ? 'Full recourse — co-borrower guaranty waived (approved exception)' : 'Full recourse — personal guaranty required'} />
                <Row k="Interest accrual" v={to.accrualType === 'dutch' ? 'Dutch / Full-Boat' : 'Non-Dutch / As-Drawn'} />
                <Row k="3-month minimum interest" v={to.minInterestEnabled === true ? 'Included' : 'Not included'} />
                {def > 0 && <Row k="Deferred origination fee (at payoff)" v={`${def}%`} />}
                {to.estClosing && <Row k="Estimated closing date" v={niceDate(to.estClosing)} />}
                {to.firstPayment && <Row k="First payment date (est.)" v={niceDate(to.firstPayment)} />}
                {to.maturity && <Row k="Maturity date (est.)" v={niceDate(to.maturity)} />}
              </Sec>
            );
          })()}
      </div>
    </div>
  );
}

/* The studio's working scenario persists onto the "Products & pricing"
   condition (tool_state): every edit autosaves, so closing the studio —
   or the page — loses nothing, and reopening resumes exactly where the
   user left off. */
function studioStateFromFields(f) {
  const checks = { isAssign: !!f.isAssign, addrTBD: !!f.addrTBD, sqft: !!f.sqft, tsManualOn: !!f.tsManualOn };
  const v = {};
  for (const k of Object.keys(f)) { if (!(k in checks) && f[k] !== '' && f[k] != null) v[k] = f[k]; }
  return { v, c: checks };
}

const ProductStudioPanel = forwardRef(function ProductStudioPanel({ appId, app, mode = 'borrower', onRegistered, toolItemId, staffRole }, ref) {
  const isStaff = mode === 'staff';
  // A TPO (broker) prices EXACTLY like a borrower — the same frozen engine, the
  // same borrower-safe override allowlist, the admin pricing zone hidden, deal
  // inputs locked — differing only in (a) which API the data-load / register /
  // upload call and (b) the parties' names come from the FILE (`app`) like staff,
  // since a broker has no "own profile". Everything gated on `isStaff` stays
  // borrower-side for a broker; only the seams below branch.
  const isTpo = mode === 'tpo';
  // The studio's admin PRICING ZONE (markup, origination points, closing-cost
  // fees, the approved effective price, and the manual LTV/LTC/ARV/rate basis) is
  // open to EVERY staff role again — owner-directed 2026-07-27, after a loan
  // officer reported "the admin section at the bottom is gone, I can't override
  // the pricing or create a manual program to send for an exception anymore".
  // This SUPERSEDES the 2026-07-16 rule that hid the zone from non-admins because
  // the server stripped those keys: the server no longer strips or refuses
  // anything — a knob moved off the company default makes the registration an
  // EXCEPTION that an admin approves in the Escalations box before the borrower
  // is sent terms or any term sheet can be sent.
  const staffAdmin = isStaff;
  // Is this staffer an ADMIN who could otherwise approve such an exception? Used
  // only to warn them that they can't approve their OWN request (a super_admin
  // is exempt from that control — see mayDecide in admin-manual-programs.js).
  // Never used to hide a control.
  const isApprover = isStaff && staffRole === 'admin';
  const [data, setData] = useState(null);       // { current, history }
  const [profile, setProfile] = useState(null); // borrower profile (name + fico)
  const [snap, setSnap] = useState(null);       // live studio state
  const [openStudio, setOpenStudio] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [msg, setMsg] = useState('');
  /* A file created from a term sheet REGISTERS ITSELF on the way in
     (owner-directed 2026-08-06). When that register was refused — a manual basis
     needs its reserve months, a value disagrees with the application, an
     exception is required — the file still exists, unregistered, exactly as it
     would have before. The reason is handed over in sessionStorage and surfaced
     HERE, on the one screen where it can be acted on, rather than being
     swallowed on a page the officer has already navigated away from. Consumed
     once: a stale reason on a later visit would be a lie. */
  useEffect(() => {
    try {
      const n = sessionStorage.getItem('ys-newfile-register-note');
      if (!n) return;
      sessionStorage.removeItem('ys-newfile-register-note');
      setErr(`This file was created from a term sheet, but the product could not be registered automatically: ${n} Review the scenario below and register it here.`);
    } catch (_) { /* best-effort */ }
  }, []);
  // Manual Program: how many months of RESERVES the borrower must show (in the
  // ending balance of the most recent statement) before a manual product
  // (LTV/LTC/ARV override) can register. Prefilled from the current manual
  // registration or the admin default (3); required only when the scenario is
  // actually manual.
  const [assetMonths, setAssetMonths] = useState('');
  const [exceptionInfo, setExceptionInfo] = useState(null);   // server exception_required payload (MANUAL scenario)
  const [excReq, setExcReq] = useState('');                   // "request an exception" note
  const [excReqOpen, setExcReqOpen] = useState(false);
  // Redesign 2026-07-24: the pricing exception is a first-class register record.
  // Staff pick a structured reason + compensating factors; the panel shows the
  // file's current pricing-exception state (open/approved/denied) inline.
  const [excReason, setExcReason] = useState('other');
  const [excFactors, setExcFactors] = useState([]);           // [{code}] picked
  const [excMaps, setExcMaps] = useState(null);               // {pricingReasonCodes, compensatingFactors, register}
  useEffect(() => {
    if (!excReqOpen || !isStaff || excMaps) return;
    api.fileExceptions(appId)
      .then((d) => setExcMaps({
        pricingReasonCodes: d.pricingReasonCodes || {},
        compensatingFactors: d.compensatingFactors || {},
        register: d.register || [],
      }))
      .catch(() => setExcMaps({ pricingReasonCodes: {}, compensatingFactors: {}, register: [] }));
    // eslint-disable-next-line
  }, [excReqOpen, isStaff]);
  const latestPricingExc = excMaps && excMaps.register
    ? excMaps.register.find((r) => (r.type || r.exception_type) === 'pricing_exception') : null;
  const [adminKey, setAdminKey] = useState('');   // set after a correct admin-mode password (borrower)
  const [adminOpen, setAdminOpen] = useState(false); // is the admin zone VISIBLE right now
  const [savedStudio, setSavedStudio] = useState(undefined);   // undefined = still loading, null = none saved
  const studioRef = useRef(null);
  const sheetBodyRef = useRef(null);
  const studioSaveT = useRef(null);
  const lastStudioSaved = useRef('');
  // Did a save in this studio session actually feed an experience claim onto the
  // file? Drives the one refresh on close (owner-directed 2026-08-06). A ref, not
  // state: it must not re-render the sheet mid-edit.
  const fedExperience = useRef(false);
  // Always points at the LATEST finalizeTermSheet closure, so the stable ([]-deps)
  // imperative handle below never calls a stale one (the E-sign Send button reaches
  // it through this handle).
  const finalizeRef = useRef(null);
  // Scenario autosave onto the pricing condition — staff/borrower only. A broker
  // has no tool-state endpoint (and TpoFile passes no toolItemId), so a broker's
  // studio simply doesn't autosave a draft; the register still captures the exact
  // scenario. Never build a /api/borrower URL for a tpo session.
  const stateUrl = (toolItemId && !isTpo)
    ? `${isStaff ? '/api/staff' : '/api/borrower'}/applications/${appId}/checklist/${toolItemId}/tool-state`
    : null;

  useImperativeHandle(ref, () => ({
    openStudio() { setOpenStudio(true); },
    // Generate + attach the FINAL term sheet on the spot (owner-directed
    // 2026-08-04) — the E-sign Send button calls this when the sheet on file still
    // prints "NOT FINAL" but the file is ready to issue. Returns { ok, reason }.
    finalizeTermSheet: (...a) => (finalizeRef.current
      ? finalizeRef.current(...a)
      : Promise.resolve({ ok: false, reason: 'Products & Pricing is still loading — try again in a moment.' })),
  }), []);

  // Autosave the studio scenario onto the pricing condition (debounced).
  //
  // The save also FEEDS the experience typed here onto the file (owner-directed
  // 2026-08-06 — see src/lib/studio-experience-claim.js), and the server says so
  // by returning the claim it wrote. Remember that it happened, but do NOT
  // refresh the file here: the conditions list lives behind this sheet, and
  // re-fetching it under the user mid-edit would churn the screen on every
  // debounced pass. The refresh happens once, on close (see closeStudio) — the
  // moment they go back to the list that was reading "no experience required".
  const onStudioState = (s2) => {
    setSnap(s2);
    if (!stateUrl || !s2 || !s2.fields) return;
    const state = studioStateFromFields(s2.fields);
    const key = JSON.stringify(state);
    if (key === lastStudioSaved.current) return;
    clearTimeout(studioSaveT.current);
    studioSaveT.current = setTimeout(() => {
      lastStudioSaved.current = key;
      api.put(stateUrl, { state })
        .then((r) => { if (r && r.experienceClaim) fedExperience.current = true; })
        .catch(() => { lastStudioSaved.current = ''; });
    }, 1200);
  };
  const adminActive = isStaff || !!adminKey;   // overrides ride along even when the zone is locked shut

  async function toggleAdmin() {
    if (isStaff) return;   // staff always have the zone
    if (adminKey) {
      // Lock the zone shut — the values REMAIN live in the studio and are
      // still honored when registering, exactly like the static tool.
      const next = !adminOpen;
      setAdminOpen(next);
      if (studioRef.current) {
        studioRef.current.setAdminVisible(next);
        if (next) setTimeout(() => studioRef.current && studioRef.current.scrollToAdmin(sheetBodyRef.current), 120);
      }
      return;
    }
    const pw = await askPrompt('Admin mode — enter the pricing admin password:');
    if (pw == null) return;
    if (await checkAdminPassword(pw)) {
      setAdminKey(pw);
      setAdminOpen(true);
      setMsg('Admin pricing unlocked — markup, origination and fee overrides are live.');
      // Reveal the zone in place and land the user ON it — no page jump.
      if (studioRef.current) {
        studioRef.current.setAdminVisible(true);
        setTimeout(() => studioRef.current && studioRef.current.scrollToAdmin(sheetBodyRef.current), 120);
      }
    } else setErr('Incorrect admin password.');
  }

  const loadPricing = () => (isStaff ? api.staffPricing(appId) : isTpo ? api.tpoPricing(appId) : api.borrowerPricing(appId));

  useEffect(() => {
    let alive = true;
    loadPricing().then((d) => {
      if (!alive) return;
      setData(d);
      // Prefill the reserve-months field: the current manual registration's
      // value, else the pending escalation's, else the company default (3).
      const pre = (d && d.current && d.current.asset_months)
        || (d && d.manualEscalation && d.manualEscalation.asset_months)
        || (d && d.manualDefaults && d.manualDefaults.assetMonths);
      if (pre != null) setAssetMonths(String(pre));
    })
      .catch((e) => alive && setErr(e.message || 'Could not load product registration'));
    if (stateUrl) api.get(stateUrl).then((d) => alive && setSavedStudio((d && d.state && d.state.v) ? d.state : null)).catch(() => alive && setSavedStudio(null));
    else setSavedStudio(null);
    // A broker has no borrower "own profile" — the parties' names come from the
    // file (`app`), like staff. Only a borrower loads api.profile() for the prefill.
    if (!isStaff && !isTpo) api.profile().then((p) => alive && setProfile(p)).catch(() => {});
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [appId, mode]);

  // Sheet mechanics: lock the page scroll behind it; Escape saves & closes.
  // Remember the position we opened from and restore it on exit (#108) so the
  // file/condition list doesn't jump to the top when the studio closes.
  useEffect(() => {
    if (!openStudio) return undefined;
    const onKey = (e) => { if (e.key === 'Escape') closeStudio(); };
    document.addEventListener('keydown', onKey);
    const y = window.scrollY || window.pageYOffset || 0;
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = '';
      requestAnimationFrame(() => window.scrollTo(0, y));
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [openStudio]);

  // Closing the sheet SAVES: flush the debounced autosave immediately and keep
  // the last scenario as the prefill, so reopening resumes exactly here.
  function closeStudio() {
    const s = studioRef.current && studioRef.current.snapshot();
    if (s && s.fields) {
      const state = studioStateFromFields(s.fields);
      clearTimeout(studioSaveT.current);
      lastStudioSaved.current = JSON.stringify(state);
      if (stateUrl) {
        api.put(stateUrl, { state })
          .then((r) => { if (r && r.experienceClaim) fedExperience.current = true; })
          .catch(() => { lastStudioSaved.current = ''; })
          // The experience typed here is now the file's CLAIM, so the
          // track-record condition has just gone from "no experience required"
          // to "verify N" (owner-directed 2026-08-06). Re-fetch the file so the
          // list they are landing back on says so, instead of showing the old
          // answer until something else happens to reload the screen. Runs after
          // the catch on purpose: a debounced save may already have fed the claim,
          // so a failed close-flush must not swallow the refresh it earned.
          .then(() => {
            if (!fedExperience.current) return;
            fedExperience.current = false;
            if (onRegistered) onRegistered();
          });
      }
      setSavedStudio(state);
    }
    setAdminOpen(false);
    setOpenStudio(false);
  }

  const cur = data && data.current;
  const history = (data && data.history) || [];
  const superseded = history.filter((h) => !h.is_current);

  // Products & Pricing is part of the SAME system as Application Details — not a
  // separate integration — so an edit to the file's economics/identity must show
  // up here WITHOUT a page reload (owner-reported 2026-08: "I edited application
  // details, then opened Products and Pricing and it was not yet updated — I had
  // to refresh"). The prefill below reads the file's CURRENT numbers straight off
  // the `app` prop, and the pricing snapshot (`data`) is the server's view of the
  // same file, so BOTH must follow a details edit. A stable signature of exactly
  // the fields those two reads depend on drives the refresh — so it happens on a
  // real change, not on every unrelated re-render (which could reset a scenario
  // the user is mid-edit).
  const appPrefillSig = app ? JSON.stringify([
    app.purchase_price, app.as_is_value, app.arv, app.rehab_budget, app.rehab_type,
    app.requested_exp_flips, app.requested_exp_holds, app.requested_exp_ground,
    app.term, app.requested_ir_months, app.requested_ir_amount,
    app.is_assignment, app.underlying_contract_price, app.assignment_fee,
    app.payoff_amount, app.payoff_lender, app.payoff_loan_number, app.estimated_cash_out,
    app.loan_type, app.program, app.property_type, app.units, app.fico, app.co_fico,
    app.entity_name, app.co_borrower_id, app.co_borrower_pg_waived, app.liquidity_buffer_waived,
    app.est_closing_date, app.expected_closing, app.property_address,
    app.first_name, app.middle_name, app.last_name, app.name_suffix, app.full_name,
    app.co_first_name, app.co_middle_name, app.co_last_name, app.co_name_suffix,
  ]) : '';
  // Re-pull the server pricing snapshot when the file's economics/identity change
  // (a details edit reopens the P&P condition), so `data.quote`/`data.current`
  // reflect the CURRENT file too. Skips the first run (the mount effect already
  // loaded it) and never disturbs an OPEN studio — you can't edit details behind
  // the full-screen sheet, and a register handles its own refresh.
  const econSynced = useRef(false);
  useEffect(() => {
    if (!econSynced.current) { econSynced.current = true; return; }
    if (openStudio) return;
    let alive = true;
    loadPricing().then((d) => { if (alive) setData(d); }).catch(() => {});
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [appPrefillSig]);

  // Prefill: the registered scenario when there is one (so a re-open shows
  // exactly what was registered), otherwise the loan file itself.
  const prefill = useMemo(() => {
    if (!data || savedStudio === undefined) return null;
    // The file-owned pricing basis, from the RAW app columns and ONLY when a
    // column genuinely carries a value (never buildInputs/quote output — that
    // layer coerces null→0 and fills defaults, which would wipe a draft;
    // audit-caught 2026-07-17). Shared by both prefill sources below.
    const fileEcon = () => {
      const out = {};
      const set = (k, v) => { if (v != null && v !== '') out[k] = v; };
      set('purchasePrice', app.purchase_price);
      set('asIsValue', app.as_is_value);
      set('arv', app.arv);
      set('rehabBudget', app.rehab_budget);
      set('expFlips', app.requested_exp_flips);
      set('expHolds', app.requested_exp_holds);
      set('expGround', app.requested_exp_ground);
      set('termMonths', app.term);
      set('irMonths', app.requested_ir_months);
      set('irAmount', app.requested_ir_amount);
      // is_assignment is NOT NULL DEFAULT false (db/016), so only a TRUE file
      // value is authoritative here — a false default must never uncheck an
      // assignment the officer is drafting in the studio ahead of the form
      // (the econVersion guard still refuses a register if the file moved).
      if (app.is_assignment === true) out.isAssignment = true;
      set('underlyingContractPrice', app.underlying_contract_price);
      set('assignmentFee', app.assignment_fee);
      return out;
    };
    /* THE PAYOFF IS FILE-OWNED, LIKE THE ADDRESS AND THE CLOSING DATE
       (re-audit-found 2026-07-31). These four live on the loan file, never in a
       registration's engine inputs — `scenarioFromEngineInputs` has no key for
       any of them — so unless they are spread in explicitly, the studio opens
       BLANK on every file that has a registration or a server quote, which is
       essentially every file. Two things went wrong because of that:

         · the payoff rows added to the printed term sheet ("Existing loan
           payoff", "Paid off to", "Their loan number") never rendered, because
           they are gated on the studio's own payoff box;
         · worse, `termOptionsFromSnapshot` still SENT the blank cash-out, and
           the register route reads a blank as "clear it" — so re-registering a
           file WIPED the cash-out figure that had been saved on it.

       Spread into every branch, so there is one answer to "what does the studio
       show for the payoff" no matter how the file was opened. */
    const filePayoff = () => ({
      payoffAmount: app.payoff_amount, payoffLender: app.payoff_lender,
      payoffLoanNumber: app.payoff_loan_number, estimatedCashOut: app.estimated_cash_out,
      // db/575 — the good-through date + the free-and-clear flag ride along so
      // the printed sheet states them (display only, never priced on).
      payoffGoodThrough: app.payoff_good_through, propertyFreeAndClear: app.property_free_and_clear === true,
    });
    /* FICO IS FILE-OWNED, NOT A FROZEN SCENARIO CHOICE (owner-directed 2026-08-05:
       "everywhere should be updated according to the imported credit score … the
       middle score of one borrower and the higher middle score of two borrowers").
       The imported credit report's middle score — the HIGHER-OF-TWO on a co-borrower
       file, exactly what the credit condition shows as "prices the deal" — must fill
       Products & Pricing / the term sheet, NOT the score the product was FIRST
       registered at (that stale value used to freeze here, so a re-import never
       reached the studio). The server already computes it as the file's current
       pricing FICO — the quote input = the higher-of-two borrowers.fico that the
       credit import writes the report score into — so prefer it, then the file's own
       fico, then the borrower profile's. It overrides the registered/draft fico ONLY
       when a real value exists (never blanks it), and the staff can still type a
       what-if over it; the register sends whatever the field holds, so this is what
       makes a re-register price at the imported score. */
    const filePricingFico = (() => {
      // The HIGHER of the two borrowers' scores, straight off the (always-fresh)
      // app prop — each borrower's fico is their imported middle score after the
      // credit write-back, so this is the file's current "prices the deal" score.
      const hi = Math.max(Number(app.fico) || 0, Number(app.co_fico) || 0);
      if (hi > 0) return hi;
      // Fallbacks: the server's pricing quote input (also higher-of-two), then the
      // borrower profile's fico (the borrower studio, where there is no app.co_fico).
      const q = (data.quote && data.quote.inputs) ? Number(data.quote.inputs.fico) : 0;
      if (q > 0) return q;
      return (profile && Number(profile.fico) > 0) ? Number(profile.fico) : '';
    })();
    // The last working scenario (autosaved) resumes — but the file-owned
    // economics/experience SNAP to the file's CURRENT values first (#148): an
    // autosave made before the file was edited must never carry the old
    // numbers into a re-register. Studio-only work (names, fees, product
    // choice, scenario type) keeps resuming untouched, and a field the FILE
    // doesn't carry keeps the draft's value.
    if (savedStudio && savedStudio.v) {
      /* The payoff snaps to the file for the SAME reason the economics do: it is
         file-owned, the Payoff section is where it is edited, and a draft
         autosaved before that edit must never carry the stale value back into a
         re-register — which, for the cash-out, would overwrite the file's own
         figure with the draft's. Only keys the FILE actually carries overwrite
         the draft (the `srcKey in ae` test below), so a blank column still keeps
         whatever the draft had. */
      const ae = { ...fileEcon(), ...filePayoff() };
      for (const k of Object.keys(ae)) if (ae[k] == null || ae[k] === '') delete ae[k];
      const st2 = buildStudioState(ae);
      const v = { ...savedStudio.v };
      const ID_FOR = {
        purchasePrice: 'price', asIsValue: 'asIs', arv: 'arv', rehabBudget: 'construction',
        expFlips: 'expFlips', expHolds: 'expBrrrr', expGround: 'expGround', termMonths: 'tsTerm',
        irMonths: 'irMonths', irAmount: 'irAmount', underlyingContractPrice: 'origPrice',
        payoffAmount: 'payoff', payoffLender: 'payoffLender',
        payoffLoanNumber: 'payoffLoanNo', estimatedCashOut: 'cashOutAmt',
      };
      for (const [srcKey, id] of Object.entries(ID_FOR)) {
        if (!(srcKey in ae)) continue;               // app column empty → keep the draft
        const val = st2.v[id];
        if (val != null && val !== '') v[id] = val;
      }
      const c = { ...savedStudio.c };
      if ('isAssignment' in ae) c.isAssign = st2.c.isAssign;
      // NOTE: a resumed draft keeps its manual-scenario flag for EVERY staff role
      // now (it used to be force-cleared for non-admins — the #148 "invisible
      // re-armed knob" guard). The zone is visible to everyone, so nothing is
      // hidden state anymore, and a manual basis simply routes to approval.
      // A BORROWER is the exception (audit 2026-07-30 #3): the borrower register
      // route strips every manual override, so a staff manual-scenario draft
      // resuming in the borrower's studio would dim the real program cards and
      // display admin-basis numbers the server would never register. Clear the
      // manual knobs from THEIR view only — the staff draft on the file keeps them.
      if (!isStaff) {
        delete c.tsManualOn;
        for (const k of ['tsMLtv', 'tsMArv', 'tsMLtc', 'tsMRate', 'tsMIr']) delete v[k];
      }
      // The property ADDRESS (and its state) is file-owned exactly like the
      // economics above (owner-reported 2026-07-24: the file's corrected
      // "392-394 Columbia Ave" never reached the term sheet — a draft/registered
      // snapshot kept showing, printing, and re-registering the old address).
      // A draft must never carry a stale address over the file's current one.
      const fileAddr = addrLine(app.property_address);
      if (fileAddr) { v.propAddr = fileAddr; c.addrTBD = false; }
      const fileState = app.property_address && app.property_address.state;
      if (fileState) v.propState = String(fileState).toUpperCase();
      // The two FILE-OWNED waiver flags snap over the draft too (pre-merge audit
      // 2026-07-31): a resumed draft carries neither, so without this a file
      // whose co-borrower guaranty or 1% closing-cost buffer was waived would
      // print the un-waived wording/figure on the exported term sheet. Display
      // only — the server ignores any client value for both — but the printed
      // sheet is the borrower-facing artifact, so it must read the file's truth.
      v.coBorrowerPgWaived = app.co_borrower_pg_waived ? 'true' : '';
      v.liqBufferWaived = app.liquidity_buffer_waived ? 'true' : '';
      // FICO snaps to the file's current pricing score (the imported credit
      // report's middle score / higher-of-two) — a draft autosaved before credit
      // was imported must never re-register at the old estimate.
      if (filePricingFico) v.fico = String(filePricingFico);
      // Program ON/OFF switches (owner-directed 2026-08-18): the FILE's effective
      // availability map (company switches + this file's super-admin exceptions)
      // SNAPS over the draft like every file-owned flag above — a draft autosaved
      // before a program was discontinued must never keep showing its card.
      v.tsProgAvail = (data && data.programAvailability) ? JSON.stringify(data.programAvailability) : '';
      return { v, c };
    }
    // Staff AND a broker read the parties off the FILE; a borrower reads their
    // own profile. `fromApp` is that split (a broker has no borrower profile).
    const fromApp = isStaff || isTpo;
    const name = fromApp
      ? (fullNameOf(app) || '')
      : ([profile && profile.first_name, profile && profile.last_name].filter(Boolean).join(' ') || '');
    // #104: the borrowing ENTITY (vesting name) prefills its own slot, separate
    // from the individual borrower name — no longer folded into borrowerName.
    const entity = fromApp ? (app.entity_name || '') : ((profile && profile.entity_name) || '');
    // Co-borrower name (the file carries it) → prefills the term sheet's second
    // signature line (#137).
    const coName = (fromApp && app.co_borrower_id)
      ? (fullNameOf(app, 'co_') || '')
      : '';
    // #143 — the stored engine inputs ARE the exact registered scenario, but
    // older registrations / server quotes sometimes omit an economics field (most
    // often the construction / rehab budget), so reopening the studio left that
    // field blank even though the application carries the number ("some files
    // missing the construction budget prefill"). Fill ONLY the fields the stored
    // input left empty from the application's authoritative economics — never
    // override a real stored value (incl. a genuine 0 on a bridge/purchase-only
    // deal). Spread LAST into scenarioFromEngineInputs' `extra`, which overrides.
    const econFallback = (inp) => {
      const out = {};
      const fill = (k, v) => { if ((inp[k] == null || inp[k] === '') && v != null && v !== '') out[k] = v; };
      fill('rehabBudget', app.rehab_budget);
      fill('purchasePrice', app.purchase_price);
      fill('asIsValue', app.as_is_value);
      fill('arv', app.arv);
      return out;
    };
    let st;
    if (cur && cur.inputs) {
      // #148 — the registered scenario prefills, but the FILE's current
      // file-owned economics overlay it (fileEcon above): a file edited AFTER
      // the last registration (form edit, ClickUp inbound — the exact change
      // that reopens the P&P condition) used to prefill the STALE economics; a
      // re-register then wrote those old numbers back onto the file
      // ("re-register doesn't update the file"), or a stale higher ARV tripped
      // the raise-block 403 for LOs. Scenario-only choices (strategy, loan
      // type, property/rehab type, fico) stay with the registered scenario.
      const inp = typeof cur.inputs === 'string' ? JSON.parse(cur.inputs) : cur.inputs;
      // Address + state are FILE-OWNED (owner-reported 2026-07-24): the file's
      // CURRENT address always prefills; the registered scenario's stored copy is
      // only a fallback for a file with no address yet. The old order kept the
      // registration-era address on the term sheet forever after a correction.
      st = buildStudioState(scenarioFromEngineInputs(inp, { entityName: entity, borrowerName: name, coBorrowerName: coName, address: addrLine(app.property_address) || inp.address, state: (app.property_address && app.property_address.state) || inp.state, estClosingDate: app.est_closing_date || app.expected_closing, coBorrowerPgWaived: app.co_borrower_pg_waived, liqBufferWaived: app.liquidity_buffer_waived, ...econFallback(inp), ...fileEcon(), ...filePayoff(), ...(filePricingFico ? { fico: filePricingFico } : {}) }));
      if (isStaff) {
        // The registered scenario's admin knobs (markup, points, fees, and any
        // manual LTV/LTC/ARV/rate basis) restore for EVERY staff role — the zone
        // is visible to everyone now, so nothing is re-armed invisibly and no
        // register can be refused for a knob its owner couldn't see (#148).
        const adm = adminStateFromEngineInputs(inp);
        st = { v: { ...st.v, ...adm.v }, c: { ...st.c, ...adm.c } };
      }
    } else if (data.quote && data.quote.inputs) {
      // The server already built the exact engine input from the file — use
      // it, but prefer the experience the borrower requested on this file
      // over the verified track-record counts for the what-if display.
      const inp = data.quote.inputs;
      st = buildStudioState(scenarioFromEngineInputs(inp, {
        entityName: entity, borrowerName: name, coBorrowerName: coName,
        // File-owned address/state — same rule as the registered-scenario path.
        address: addrLine(app.property_address) || inp.address,
        state: (app.property_address && app.property_address.state) || inp.state,
        expFlips: app.requested_exp_flips ?? inp.expFlips,
        expHolds: app.requested_exp_holds ?? inp.expHolds,
        expGround: app.requested_exp_ground ?? inp.expGround,
        // main's file-pricing FICO wins; then the studio input; then the borrower
        // profile; then — for a broker's TPO quote, which strips the internal FICO
        // and has no borrower profile — the file's own higher-of-two FICO (`app.fico`).
        fico: filePricingFico || inp.fico || (profile && profile.fico) || app.fico || '',
        estClosingDate: app.est_closing_date || app.expected_closing, coBorrowerPgWaived: app.co_borrower_pg_waived, liqBufferWaived: app.liquidity_buffer_waived,
        ...econFallback(inp), ...filePayoff(),
      }));
    } else {
      st = buildStudioState({
        entityName: entity, borrowerName: name, coBorrowerName: coName,
        address: addrLine(app.property_address),
        state: (app.property_address && app.property_address.state) || '',
        loanType: app.loan_type,
        program: app.program,
        propertyType: app.property_type,
        units: app.units,
        purchasePrice: app.purchase_price,
        isAssignment: app.is_assignment,
        underlyingContractPrice: app.underlying_contract_price,
        assignmentFee: app.assignment_fee,
        asIsValue: app.as_is_value,
        arv: app.arv,
        rehabBudget: app.rehab_budget,
        rehabType: app.rehab_type,
        fico: filePricingFico || app.fico || (profile && profile.fico) || '',
        expFlips: app.requested_exp_flips, expHolds: app.requested_exp_holds, expGround: app.requested_exp_ground,
        estClosingDate: app.est_closing_date || app.expected_closing, coBorrowerPgWaived: app.co_borrower_pg_waived, liqBufferWaived: app.liquidity_buffer_waived,
        termMonths: app.term, irMonths: app.requested_ir_months, irAmount: app.requested_ir_amount,
        // The refinance payoff and WHO it goes to, so the studio opens showing what
        // the file already knows instead of asking the officer to retype it.
        ...filePayoff(),
      });
    }
    // Program ON/OFF switches (owner-directed 2026-08-18): the FILE's effective
    // availability map — a discontinued program's card disappears from the studio;
    // a super-admin per-file exception brings it back with the discontinued banner.
    st = { ...st, v: { ...st.v, tsProgAvail: (data && data.programAvailability) ? JSON.stringify(data.programAvailability) : '' } };
    return st;
    // appPrefillSig makes this recompute when the file's own economics/identity
    // change (a details edit) — the fix for "P&P didn't update without a reload".
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data, profile, savedStudio, appPrefillSig]);

  // Borrowers can price/choose but never change the file's deal economics
  // from here — those change through the loan team. Staff edit everything.
  const lockedIds = useMemo(() => {
    const ids = isStaff
      // Staff: purchase price & as-is value are deliberately NOT written back on
      // register (they stay owned by the application form), so a studio edit to
      // them would size a loan the file never persists and the studio would snap
      // back on reopen — the "studio showed one price, the file kept another"
      // class (audit #24). Lock them; everything else staff may tune persists.
      ? ['price', 'asIs']
      : [
        'propAddr', 'addrTBD', 'propState', 'propType', 'dealPurpose', 'dealType',
        'price', 'isAssign', 'origPrice', 'asIs', 'arv', 'construction', 'rehabScope', 'sqft',
      ];
    // Owner-directed 2026-07-27: EVERY staff role may change the experience in the
    // studio and re-register off it — the loan officer has the same authority as
    // an underwriter/admin over the deal inputs. The server now honors a staff
    // experience override (src/lib/pricing-overrides.js), and the re-register
    // reopens the pricing + experience conditions so the underwriter re-signs.
    // A BORROWER still can't edit the claim from here (it prices off the verified
    // track record; the borrower REQUESTS a change and the team approves it) —
    // lock experience for borrowers only.
    if (!isStaff) ids.push('expFlips', 'expBrrrr', 'expGround');
    return ids;
  }, [isStaff]);

  const d = snap && snap.d;
  const canRegister = !!(snap && snap.ready && snap.program && d && d.status !== 'INELIGIBLE' && d.totalLoan > 0);

  const gate = useSubmitGate();
  // opts.submitException — the user explicitly submits a manual-review EXCEPTION
  // for a scenario the engine flags MANUAL (below the minimum, over the maximum,
  // or any other guideline exception). Without it, the server BLOCKS the register
  // (422 exception_required) and the studio surfaces the "Submit exception
  // request" action. An exception registers as pending and goes to a super-admin;
  // the borrower is not sent terms unless it's approved (owner-directed 2026-07-21).
  async function register(opts = {}) {
    const submitException = !!opts.submitException;
    const s = studioRef.current && studioRef.current.snapshot();
    if (!s) { setErr('The Term Sheet Studio is still loading.'); return; }
    if (!s.ready) { setErr('Complete the required pricing fields first: ' + s.missing.join(', ')); return; }
    if (!s.program) { setErr('No program selected yet — tap one of the four program cards (Standard, Gold Standard, Silver or Manual) in the studio first, then register.'); return; }
    const dd = s.d;
    if (!dd || dd.status === 'INELIGIBLE' || !(dd.totalLoan > 0)) {
      setErr("This scenario isn't eligible as entered — adjust it in the studio, or contact your loan team for a manual review.");
      return;
    }
    if (!gate.enter()) return;             // a registration is already in flight
    setBusy(true); setErr(''); setMsg('');
    try {
      // The exact PDF is captured AFTER the register lands (owner-directed
      // 2026-08-02) — see the stamp block below. Registration still proceeds if
      // the capture then fails; the note tells the user to download it instead.
      let pdf = null;
      // Admin-unlocked borrowers price like staff (fee/markup/manual overrides)
      // — the admin key rides along even when the zone is locked shut, so the
      // changes made in admin mode STAY in the registration and the exports.
      const overrides = overridesFromSnapshot(s, adminActive ? 'staff' : mode);
      // Manual product (LTV/LTC/ARV override): the registrant MUST state how many
      // months of RESERVES this file requires before it can register — it then
      // goes to the super-admin escalation box. Block here with a clear ask rather
      // than let the server 422 opaquely.
      const manual = overridesAreManual(overrides);
      const months = Number(assetMonths);
      if (manual && !(Number.isFinite(months) && months >= 1 && months <= 24)) {
        // The finally block clears busy + releases the submit gate on return.
        setErr('This is a manual product — you changed the LTV, LTC or ARV. Enter how many months of reserves this file must show (default 3, 1–24) below, then register. It will go to an admin for approval.');
        return;
      }
      // econVersion: the file-basis fingerprint this studio session prefilled
      // from — the server refuses (409) if the file's economics moved since,
      // so a stale sheet can never write old numbers back onto the file (#148).
      const econVersion = data && data.econVersion;
      // Term-sheet options (owner-directed 2026-07-22) ride the register body — the
      // server persists them and applies the min-interest program default.
      const termOptions = termOptionsFromSnapshot(s);
      const resp = isStaff
        ? await api.staffRegisterProduct(appId, s.program, overrides, econVersion, manual ? months : undefined, submitException, termOptions, opts.encompassOverrideReason || undefined)
        : isTpo
          ? await api.tpoRegisterProduct(appId, s.program, overrides, econVersion, submitException, termOptions)
          : await api.borrowerRegisterProduct(appId, s.program, overrides, adminKey || undefined, econVersion, submitException, termOptions);
      setExceptionInfo(null);
      const pendingApproval = !!(resp && resp.pendingApproval);
      const changed = (resp && Array.isArray(resp.overrideLines)) ? resp.overrideLines : [];
      let note = pendingApproval
        ? (isStaff
            ? (resp && resp.pendingReason === 'pricing_override'
                ? `Registered and sent to an admin for approval — you changed the pricing defaults${changed.length ? ` (${changed.join('; ')})` : ''}. It’s waiting in the Escalations box; the borrower is NOT sent terms and no term sheet can go out until it’s approved.`
                : `Exception request submitted — it’s waiting for approval in the Escalations box${changed.length ? ` (${changed.join('; ')})` : ''}. The borrower is NOT sent terms until it’s approved.`)
            : 'Exception request submitted — your loan team will review it. You won’t receive terms unless it’s approved.')
        : 'Product registered — the loan file now carries these terms, the liquidity requirement and the term sheet.';
      // THE STAMP (owner-directed 2026-08-02) — "the term sheet going out through
      // DocuSign should not say NOT FINAL". The INITIAL/FINAL wording is PRINTED
      // INTO the PDF, so it has to be right BEFORE the bytes are captured. The
      // register response says whether this file is now ready to issue (the
      // server computes it AFTER persisting, so it knows this registration's own
      // staleness and approval state — the panel's `data.termSheetFinal` was read
      // before the register and can be stale). Stamp, capture, then report the
      // stamp we ACTUALLY set on the upload so the DocuSign send can refuse an
      // initial sheet instead of mailing one.
      // ONE GENERATOR, TWO STAMPS (owner-directed 2026-08-14: "we just need to make
      // sure you're using the same system that you're generating every term sheet
      // with … the only difference should be that it should have the final stamped
      // instead of the active file stamp"). The studio draws the SAME six-page sheet
      // either way; `file_final` prints "FINAL TERM SHEET", `file` prints the
      // ACTIVE LOAN FILE / "INITIAL — NOT FINAL" stamp. Registering a file that is
      // ready to issue therefore attaches the FINAL one directly. (Between
      // 2026-08-06 and 2026-08-14 this was hard-coded to `false` because the sender
      // built its own short sheet; that renderer is gone.)
      const stampFinal = !!(resp && resp.termSheetFinal);
      let stamped = false;
      try { stamped = studioRef.current.setProvenance(stampFinal ? 'file_final' : 'file') === true; } catch (_) { stamped = false; }
      try { pdf = await studioRef.current.capturePdf(); } catch (_) { /* offline */ }
      if (pdf && pdf.blob) {
        try {
          const dataBase64 = await blobToBase64(pdf.blob);
          const body = { filename: pdf.filename, contentType: 'application/pdf', dataBase64, docKind: 'term_sheet',
            termSheetFinal: stampFinal && stamped };
          if (isStaff) await api.staffUploadAppDoc(appId, body);
          else if (isTpo) await api.tpoUploadDocument({ ...body, applicationId: appId });
          else await api.uploadDoc({ ...body, applicationId: appId });
        } catch (_) { note = 'Product registered. The term sheet PDF could not be attached — download it from the studio instead.'; }
      } else {
        note = 'Product registered. The term sheet PDF could not be generated (internet required) — download it from the studio.';
      }
      const dNew = await loadPricing();
      setData(dNew);
      closeStudio();
      setMsg(note);
      if (onRegistered) onRegistered();
    } catch (e) {
      if (e.status === 409 && e.data && e.data.code === 'econ_version_conflict') {
        // The file's economics moved while the sheet was open. Close WITHOUT
        // saving the stale snapshot as the resume-state — including the pending
        // debounced autosave, which would otherwise fire after close and PUT
        // the stale scenario anyway — reload the pricing basis, and let the
        // reopen prefill snap to the fresh values (#148).
        clearTimeout(studioSaveT.current);
        setOpenStudio(false);
        try { const dNew = await loadPricing(); setData(dNew); } catch (_) { /* keep old */ }
        setErr(e.data.error || 'This file changed since the studio was opened — reopen the studio to pick up the latest values, then register again.');
      } else if (e.status === 422 && e.data && e.data.code === 'manual_asset_months_required') {
        if (e.data.suggestedAssetMonths != null && !assetMonths) setAssetMonths(String(e.data.suggestedAssetMonths));
        setErr(e.data.error || 'This is a manual product — enter how many months of reserves this file must show, then register.');
      } else if (e.status === 422 && e.data && e.data.code === 'file_mismatch') {
        // The studio's scenario disagrees with the application record (property
        // type / units / loan type / deal type / state). The registration was
        // refused — the two must match (owner-directed 2026-07-31). Show the
        // server's line-by-line message; fixing either side clears it.
        setErr(e.data.error || 'The registration does not match the application — fix the application details (or the studio pick) and register again.');
      } else if (e.status === 422 && e.data && e.data.code === 'exception_required') {
        // Not eligible as-is — the engine flagged it MANUAL (below the minimum,
        // over the maximum, or another guideline exception). Surface WHY and offer
        // the "Submit exception request" action (registers as pending → super-admin).
        setExceptionInfo(e.data);
        setErr(e.data.message || 'This scenario isn’t eligible as-is — it needs a manual-review exception. Submit an exception request below.');
      } else if (e.status === 422 && e.data && e.data.code === 'encompass_override_reason_required') {
        // Admin: the Encompass sync has open blocking mismatches. Offer to issue
        // the term sheet anyway by typing a reason (logged). Retry after this
        // register fully settles (the submit gate is released in `finally`).
        const n = (e.data.openFields && e.data.openFields.length) || '';
        // The old feature-detect around window.prompt is gone: askPrompt is our
        // own module and is always there, falling back to the browser itself
        // when no dialog host is mounted.
        const reason = await askPrompt(
          `Encompass has ${n} field(s) that don’t match this file. To issue the term sheet anyway, type the reason for the override:`,
          { title: 'Override the Encompass check', confirmLabel: 'Issue anyway' });
        if (reason && reason.trim()) { const rr = reason.trim(); setTimeout(() => register({ ...opts, encompassOverrideReason: rr }), 0); }
        else setErr(e.data.error || 'Encompass has unmatched fields — provide an override reason to issue the term sheet.');
      } else if (e.status === 422 && e.data && e.data.code === 'encompass_findings_open') {
        // The server sends a surface-appropriate message; the fallback is neutral
        // because this component is borrower-reachable (no internal system name).
        setErr(e.data.error || 'This file is being finalized — your team will have your terms shortly.');
      } else {
        const detail = e.data && e.data.reasons ? e.data.reasons.map((r) => r.msg).join(' ') : (e.message || 'Could not register');
        setErr(detail);
      }
    } finally { setBusy(false); gate.leave(); }
  }

  // Poll the studio until it has loaded the (prefilled, registered) scenario and
  // computed a ready, eligible pricing snapshot — the SAME readiness register()
  // requires before it will capture. Resolves false on timeout (fail-safe).
  function waitForStudioReady(timeoutMs) {
    return new Promise((resolve) => {
      const start = Date.now();
      const tick = () => {
        let s = null;
        try { s = studioRef.current && studioRef.current.snapshot(); } catch (_) { s = null; }
        if (s && s.ready && s.program && s.d && s.d.status !== 'INELIGIBLE' && s.d.totalLoan > 0) return resolve(true);
        if (Date.now() - start > timeoutMs) return resolve(false);
        setTimeout(tick, 200);
      };
      setTimeout(tick, 250);
    });
  }

  // FINALIZE the term sheet in place (owner-directed 2026-08-04): "that button to
  // send out the term sheet and package should be the button that is generating the
  // final term sheet after all the conditions are met." The INITIAL/FINAL wording is
  // drawn into the PDF client-side, so the ONLY way to a FINAL sheet is to
  // regenerate it here. This re-captures the SAME registered scenario the studio
  // prefills — no re-pricing, no re-register side effects — stamped FINAL, but ONLY
  // when the server confirms the file is ready to issue one (termSheetFinal), so a
  // sheet can never call itself final on an unfinished file. Fail-safe: any problem
  // returns { ok:false, reason } and nothing is attached — the caller falls back to
  // re-registering, or (super-admin) the send override. Returns { ok, reason }.
  async function finalizeTermSheet() {
    if (busy) return { ok: false, reason: 'A registration is already in progress — try again in a moment.' };
    // Server authority FIRST — never stamp a sheet final on a file that isn't ready.
    let d;
    try { d = await loadPricing(); } catch (_) { return { ok: false, reason: 'Could not read Products & Pricing right now — try again in a moment.' }; }
    if (!d || !d.current) return { ok: false, reason: 'No product is registered on this file yet. Register the product in Products & Pricing first.' };
    if (d.termSheetHold) return { ok: false, reason: (isStaff && typeof d.termSheetHold === 'string') ? d.termSheetHold : 'Term sheets are on hold on this file (the appraisal is under review).' };
    if (!d.termSheetFinal) {
      const bl = (d.termSheetFinalBlockers || []).map((b) => b && b.label).filter(Boolean);
      return { ok: false, reason: bl.length
        ? `The term sheet can’t be finalized yet — still outstanding: ${bl.join(', ')}. Finish those, then send.`
        : 'This file isn’t ready to issue a final term sheet yet.' };
    }
    setBusy(true); setErr('');
    try {
      setData(d);
      setOpenStudio(true);
      const ready = await waitForStudioReady(12000);
      if (!ready) return { ok: false, reason: 'The Term Sheet Studio couldn’t load the registered scenario. Open Products & Pricing and re-register to attach the final term sheet.' };
      let stamped = false, pdf = null;
      try { stamped = studioRef.current.setProvenance('file_final') === true; } catch (_) { stamped = false; }
      try { pdf = await studioRef.current.capturePdf(); } catch (_) { pdf = null; }
      if (!pdf || !pdf.blob || !stamped) return { ok: false, reason: 'Could not generate the final term sheet PDF (an internet connection is required).' };
      try {
        const dataBase64 = await blobToBase64(pdf.blob);
        const body = { filename: pdf.filename, contentType: 'application/pdf', dataBase64, docKind: 'term_sheet', termSheetFinal: true };
        if (isStaff) await api.staffUploadAppDoc(appId, body);
        else await api.uploadDoc({ ...body, applicationId: appId });
      } catch (_) { return { ok: false, reason: 'The final term sheet was generated but could not be attached — try again.' }; }
      try { const dNew = await loadPricing(); setData(dNew); } catch (_) { /* keep old */ }
      if (onRegistered) onRegistered();
      return { ok: true };
    } finally {
      closeStudio();
      setBusy(false);
    }
  }
  finalizeRef.current = finalizeTermSheet;

  // Request an EXCEPTION to a guideline the deal otherwise follows — e.g. to
  // finance MORE of an assignment fee than the 15% cap (a bigger loan). Raises an
  // escalation into the super-admin Workflow; it does NOT change the current
  // registration (owner-directed 2026-07-21).
  async function requestException() {
    const note = excReq.trim();
    if (!note) { setErr('Describe the exception you’re requesting.'); return; }
    setBusy(true); setErr(''); setMsg('');
    try {
      if (isStaff) {
        // First-class register record (redesign 2026-07-24): structured reason +
        // compensating factors travel with the request into the Exceptions box.
        await api.staffRequestException(appId, note, excReason,
          excFactors.length ? excFactors.map((code) => ({ code })) : undefined);
      } else await api.borrowerRequestException(appId, note);
      setExcReq(''); setExcReqOpen(false); setExcFactors([]); setExcMaps(null);
      setMsg(isStaff
        ? 'Exception request filed — it now has its own record a super-admin reviews in the Exceptions box (you can track it under "My exceptions").'
        : 'Exception request sent — your loan team will review it and get back to you.');
    } catch (e) { setErr(e.message || 'Could not send the exception request'); }
    finally { setBusy(false); }
  }

  const statusLine = snap && !snap.ready ? 'Missing: ' + snap.missing.join(', ')
    : snap && !snap.program ? 'Tap a program card above to choose Standard, Gold Standard, Silver or Manual.'
    : d && d.totalLoan > 0 ? `${snap.program === 'gold' ? 'Gold Standard' : snap.program === 'silver' ? 'Silver' : snap.program === 'manual' ? 'Manual Program' : 'Standard'} · ${money(d.totalLoan)} @ ${d.rate ? fmtRatePctFromPct(d.rate) + '%' : '—'} · cash to close ${money2(d.cashToClose)} · liquidity ${money2(d.liquidity)}`
    : '';
  // A PLAIN-LANGUAGE reason the product can't be registered yet — shown as a
  // prominent banner in the studio so the Register action never silently
  // "does nothing" (owner-directed 2026-07-12: "it holds you back from
  // registering the product"). The Register button is always clickable (only
  // disabled while busy) so a click also surfaces the specific reason.
  // Is the LIVE scenario a manual-review EXCEPTION (the engine flagged it MANUAL —
  // below the minimum, over the maximum, or another guideline exception)? Such a
  // scenario is NOT eligible as-is: it can't be plain-registered, only submitted as
  // an exception for super-admin approval (owner-directed 2026-07-21).
  const scenarioManual = !!(d && d.status === 'MANUAL' && d.totalLoan > 0);
  // Is the LIVE studio scenario a manual product (LTV/LTC/ARV override)? Computed
  // BEFORE blockReason on purpose: a manual product on an engine-refused deal is
  // the flagship manual-underwrite case ("admin prices what the engine refuses")
  // and it REGISTERS normally (the server skips exception_required for a
  // structural override) — it must never read as blocked (audit 2026-07-30 #1).
  let manualLive = false;
  try { manualLive = isStaff && snap && overridesAreManual(overridesFromSnapshot(snap, 'staff')); } catch (_) { manualLive = false; }
  const blockReason = busy ? ''
    : !snap ? 'The Term Sheet Studio is still loading — give it a moment, then register.'
    : !snap.ready ? 'To register, add the required pricing fields: ' + ((snap.missing && snap.missing.join(', ')) || 'see the highlighted fields in the studio') + '.'
    : !snap.program ? 'No program selected yet — tap one of the four program cards (Standard, Gold Standard, Silver or Manual) to choose your product. Register unlocks once a program is selected.'
    : (d && d.status === 'INELIGIBLE') ? "This scenario isn't eligible as entered — adjust it in the studio, or contact your loan team for a manual review."
    : (d && !(d.totalLoan > 0)) ? "This scenario didn't size a loan yet — check the purchase price, ARV / as-is value and rehab budget in the studio."
    : (scenarioManual && !manualLive) ? `This scenario isn’t eligible as-is on the ${snap.program === 'gold' ? 'Gold Standard' : snap.program === 'silver' ? 'Silver' : snap.program === 'manual' ? 'Manual' : 'Standard'} program — it needs a manual-review exception. Submit an exception request${isStaff ? ' — an admin reviews it and the borrower isn’t sent terms unless it’s approved.' : ' and your loan team will review it.'}`
    : '';

  // (manualLive — whether the live scenario is a manual product — is computed
  // above blockReason; every staff role can enter those knobs and must state
  // the reserve months before it can register.)
  // Is the LIVE scenario carrying an admin-zone knob that is OFF the company
  // default (and therefore needs an admin's approval)? Compared against the real
  // company defaults the server sends on the pricing load — the SAME numbers the
  // register re-checks with, so the warning can never claim a change that isn't
  // one. Without defaults (older bundle / cold cache) it stays quiet and lets the
  // register be the authority.
  const liveOverrideKeys = useMemo(() => {
    if (!isStaff || !snap) return [];
    const cd = data && data.pricingDefaults;
    let ov = {};
    try { ov = overridesFromSnapshot(snap, 'staff') || {}; } catch (_) { return []; }
    const DEFAULTED = {
      markupStdPct: 'rate markup (Standard)', markupGoldPct: 'rate markup (Gold)',
      origStdPct: 'origination points (Standard)', origGoldPct: 'origination points (Gold)',
      origSilverPct: 'origination points (Silver)', origManualPct: 'origination points (Manual)',
      lenderFee: 'underwriting / legal fee', creditFee: 'credit-report fee',
      appraisalFee: 'appraisal fee', titleFee: 'title / escrow fee',
    };
    const NO_DEFAULT = { ovrEffPrice: 'effective purchase price', manualPricing: 'manual scenario',
      oopRehab: 'out-of-pocket rehab', oopRehabMax: 'out-of-pocket rehab (raise initial to max)',
      // Manual Gold top-tier markup (item 15): mirrors the server's placement in
      // ENGAGED_OVERRIDE_KEYS — any non-zero value is a deliberate override → approval.
      markupGoldT1Pct: 'Gold top-tier markup' };
    // A knob with no company default of its own borrows another's — the exact
    // mirror of pricing-overrides.js `defaultKey`, which is what the server
    // re-checks with. Without it the Manual origination has no `cd` entry at
    // all, so the panel would warn "needs an admin approval" for a value that
    // IS the default and the server would then say it isn't (audit 2026-07-30).
    const DEFAULT_SOURCE = { origManualPct: 'origStdPct' };
    const out = [];
    if (cd) {
      for (const k of Object.keys(DEFAULTED)) {
        const raw = ov[k];
        if (raw == null || raw === '') continue;              // blank = "use the company default"
        const v = Number(raw);
        if (!Number.isFinite(v)) continue;
        const dk = DEFAULT_SOURCE[k] || k;
        const d = cd[dk] == null || cd[dk] === '' ? null : Number(cd[dk]);
        if (d != null && Math.abs(v - d) < 0.0001) continue;  // typed the default back
        out.push(DEFAULTED[k]);
      }
    }
    const engagedVal = (v) => v === true || (v != null && v !== '' && v !== false && Number(v) !== 0);
    for (const k of Object.keys(NO_DEFAULT)) if (engagedVal(ov[k])) out.push(NO_DEFAULT[k]);
    return out;
  }, [isStaff, snap, data]);
  const liveNeedsApproval = manualLive || liveOverrideKeys.length > 0;
  // A plain MANUAL scenario (NOT a manual LTV/LTC/ARV product — that has its own
  // asset-months flow) registers via the "Submit exception request" action, which
  // opens a super-admin escalation and withholds borrower terms until approved.
  const submitExceptionMode = scenarioManual && !manualLive;
  // The Register button reads as LOCKED until it can actually register
  // (owner-directed 2026-07-30: "the register button ... needs to be grayed out
  // and when somebody is trying to click ... it should say that it didn't
  // selected a program"). It stays CLICKABLE — aria-disabled + the .is-blocked
  // grey carry the visual, never `disabled` — so a click surfaces the exact
  // reason instead of a dead end, and the reason line is ALSO shown before any
  // click (top bar + next to the bottom button).
  const registerBlocked = !busy && !!blockReason && !submitExceptionMode && !exceptionInfo;
  const registerClick = () => {
    if (registerBlocked) { setErr(blockReason); return; }
    register((submitExceptionMode || exceptionInfo) ? { submitException: true } : {});
  };
  const esc = data && data.manualEscalation;
  const escPending = esc && esc.status === 'pending';
  const escCountered = esc && esc.status === 'countered';
  const counterTerms = escCountered ? (esc.counter_terms || {}) : null;
  const acceptCounter = async () => {
    if (!escCountered) return;
    if (!(await askConfirm('Accept the super-admin’s counter-offer and re-register the file with those terms?'))) return;
    setBusy(true); setErr('');
    try {
      await api.acceptCounterOffer(appId);
      setMsg('Counter-offer accepted — the file has been re-registered with the countered terms.');
      // Reload the studio's snapshot so the new (approved) registration + updated escalation state show up.
      try { const dNew = await loadPricing(); setData(dNew); } catch (_) { /* keep old */ }
    } catch (e) { setErr(e.message || 'Could not accept the counter-offer'); }
    finally { setBusy(false); }
  };

  return (
    <div className="panel" style={{ marginTop: 18 }}>
      <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center' }}>
        <h3 style={{ margin: 0 }}>Product registration & term sheet</h3>
        <div className="row" style={{ gap: 10, alignItems: 'center' }}>
          {cur && <span className={`ts-badge ${escPending ? 'warn' : 'ok'}`}>Registered · {cur.program === 'gold' ? 'Gold Standard' : cur.program === 'silver' ? 'Silver' : cur.program === 'manual' ? 'Manual Program' : 'Standard'} · {money(cur.total_loan)} @ {fmtRatePct(cur.note_rate)}%</span>}
          <button className="btn primary small" onClick={() => setOpenStudio(true)}
            title="Opens the full-screen Term Sheet Studio — everything you enter autosaves to the file; leaving resumes where you left off.">
            {cur ? 'Reprice / re-register' : 'Open Products & Pricing'}
          </button>
        </div>
      </div>

      {/* Why a re-register is being asked for (owner-directed): never a blank
          "re-register" — always say which number changed and to what. Comes from
          the reopen trigger's stale_reason (db/187). */}
      {cur && app && app.pricing_stale && (
        <div className="notice warn" style={{ marginTop: 10 }}>
          <strong>Re-register needed.</strong>{' '}
          {app.pricing_stale_reason
            ? app.pricing_stale_reason.replace(/^\[auto\]\s*/, '')
            : 'A pricing input changed since this product was registered — re-register so the structure and loan amount match the new numbers.'}
        </div>
      )}
      {/* Escalation state — a registered file that needs an admin's approval
          (a Manual Program, any Standard/Gold manual-review exception — below the
          minimum, over the maximum — OR a pricing override off the company
          defaults, owner-directed 2026-07-27). The borrower is NOT sent terms
          until it's approved. A COUNTER-OFFER state (2026-07-21) surfaces the
          proposed terms with a one-click Accept that re-registers at them. */}
      {cur && esc && (
        <div className={`notice ${escCountered ? 'warn' : escPending ? 'warn' : esc.status === 'approved' ? 'ok' : 'err'}`} style={{ marginTop: 10 }}>
          <strong>{escCountered ? 'Counter-offer from an admin.'
            : cur.program === 'manual' ? 'Manual Program.'
            : (esc.summary && esc.summary.kind === 'pricing_override') ? 'Pricing changed from the defaults.'
            : 'Manual-review exception.'}</strong>{' '}
          {escCountered
            ? 'An admin proposed different terms they would accept. Review the terms below and accept them to re-register at the countered numbers, or open the studio and adjust the scenario for a fresh exception.'
            : escPending
              ? `Registered but NOT confirmed — waiting for an admin to approve it in the Escalations box${esc.asset_months ? ` (${esc.asset_months} month${esc.asset_months === 1 ? '' : 's'} of reserves required)` : ''}. The borrower isn’t sent terms until it’s approved.`
              : esc.status === 'approved'
                ? `Approved${esc.asset_months ? ` · ${esc.asset_months} month${esc.asset_months === 1 ? '' : 's'} of reserves required` : ''}.`
                : `Declined${esc.decision_note ? ` — ${esc.decision_note}` : ''}. Adjust the scenario and re-register, or re-submit the exception.`}
          {/* Exactly WHAT was moved off the company defaults (db/343), so the
              file itself always shows what is being approved. */}
          {Array.isArray(esc.summary && esc.summary.overrideLines) && esc.summary.overrideLines.length > 0 && (
            <div className="muted small" style={{ marginTop: 6 }}>
              Changed from the defaults: {esc.summary.overrideLines.join(' · ')}
            </div>
          )}
          {escCountered && (
            <div style={{ marginTop: 8, padding: 10, background: 'rgba(174,135,70,0.10)', border: '1px solid #AE8746', borderRadius: 8 }}>
              {esc.counter_note && <div style={{ fontSize: 13, whiteSpace: 'pre-wrap', marginBottom: 8, color: 'var(--ivory,#141B22)' }}>{esc.counter_note}</div>}
              {counterTerms && Object.keys(counterTerms).length > 0 && (
                <div className="muted small" style={{ marginBottom: 8 }}>
                  Super-admin would accept:{' '}
                  {counterTerms.maxAcqLtv != null && <span>as-is LTV {(counterTerms.maxAcqLtv * 100).toFixed(2)}% · </span>}
                  {counterTerms.maxArvLtv != null && <span>ARV LTV {(counterTerms.maxArvLtv * 100).toFixed(2)}% · </span>}
                  {counterTerms.maxLtc    != null && <span>LTC {(counterTerms.maxLtc * 100).toFixed(2)}% · </span>}
                  {counterTerms.noteRate  != null && <span>rate {fmtRatePct(counterTerms.noteRate)}% · </span>}
                  {counterTerms.origPct   != null && <span>origination {(counterTerms.origPct * 100).toFixed(2)}% · </span>}
                  {counterTerms.loanAmount != null && <span>loan {money(counterTerms.loanAmount)} · </span>}
                </div>
              )}
              <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
                <button className="btn primary small" disabled={busy} onClick={acceptCounter}>
                  {busy ? 'Accepting…' : 'Accept the counter-offer'}
                </button>
                <button className="btn ghost small" disabled={busy} onClick={() => setOpenStudio(true)}>
                  Open the studio and adjust
                </button>
              </div>
            </div>
          )}
        </div>
      )}
      {/* Manual product — the registrant states how many months of RESERVES the
          borrower must show (owner-directed 2026-08-11: it is reserve months, not a
          bank-statement count). Every staff role can reach the LTV/LTC/ARV knobs
          (owner-directed 2026-07-27); the approval is what governs. */}
      {manualLive && (
        <div className="notice" style={{ marginTop: 10 }}>
          <strong>Manual product (custom LTV / LTC / ARV).</strong> This registers as a Manual Program and goes to an
          admin for approval. How many months of reserves must this file show in the ending balance of the most recent
          statement? Defaults to 3; this box overrides it.
          <div className="row" style={{ gap: 8, alignItems: 'center', marginTop: 8 }}>
            <input type="number" min="1" max="24" step="1" value={assetMonths}
              onChange={(e) => setAssetMonths(e.target.value)} style={{ width: 90 }}
              aria-label="Months of reserves required" placeholder="months" />
            <span className="muted small">months of reserves (default 3, 1–24)</span>
          </div>
        </div>
      )}
      {err && !openStudio && <div role="alert" className="notice err" style={{ marginTop: 10 }}>{err}</div>}
      {msg && !openStudio && <div className="notice ok" style={{ marginTop: 10 }}>{msg}</div>}

      {/* The personal-guaranty status + co-borrower guaranty-waiver REQUEST moved
          OFF Products & Pricing into the Exceptions section (owner-directed
          2026-08-06): the request now lives with the other exceptions, not here. */}

      {/* Request an exception to a guideline the deal otherwise follows — e.g. to
          finance MORE of an assignment fee than the 15% cap (a bigger loan).
          Goes to the super-admin Workflow; doesn't change the current terms. */}
      {!openStudio && (
        <div style={{ marginTop: 10 }}>
          {!excReqOpen ? (
            <button className="btn ghost small" onClick={() => { setExcReqOpen(true); setErr(''); setMsg(''); }}>
              Request an exception
            </button>
          ) : (
            <div className="notice" style={{ padding: 10 }}>
              <div className="muted small" style={{ marginBottom: 6 }}>
                Ask a super-admin to make an exception to a guideline — for example, to finance more of an
                assignment fee than the 15% cap (a bigger loan). This doesn’t change your current terms; it
                {isStaff ? ' files a tracked request into the Exceptions box for review.' : ' goes to your loan team for review.'}
              </div>
              {/* The file's current pricing-exception state, so nobody double-files. */}
              {isStaff && latestPricingExc && (
                <div className={`notice ${latestPricingExc.status === 'approved' ? 'ok' : latestPricingExc.status === 'requested' ? 'warn' : ''}`} style={{ marginBottom: 8 }}>
                  {latestPricingExc.status === 'requested' && <>A pricing exception is already <b>awaiting review</b> on this file — add to that one in the Exceptions box instead of filing a second.</>}
                  {latestPricingExc.status === 'approved' && <>The latest pricing exception on this file was <b>approved</b>{latestPricingExc.decision_note ? ` — ${latestPricingExc.decision_note}` : ''}. A super-admin applies it in the studio and re-registers.</>}
                  {['denied', 'withdrawn', 'expired', 'cleared'].includes(latestPricingExc.status) && <>The last pricing exception on this file was <b>{latestPricingExc.status}</b> — a new request will link back to it.</>}
                </div>
              )}
              {isStaff && excMaps && (
                <div className="row" style={{ gap: 8, marginBottom: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                  <label className="muted small" htmlFor="excReason">What kind of exception?</label>
                  <select id="excReason" className="input" style={{ width: 'auto', maxWidth: '100%' }}
                    value={excReason} onChange={(e) => setExcReason(e.target.value)}>
                    {Object.entries(excMaps.pricingReasonCodes).map(([k, label]) => (
                      <option key={k} value={k}>{label}</option>
                    ))}
                  </select>
                </div>
              )}
              <textarea className="input" rows={2} style={{ width: '100%' }}
                placeholder="What exception are you requesting, and why?"
                value={excReq} onChange={(e) => setExcReq(e.target.value)} />
              {/* Compensating factors — what offsets the risk. Ticking them makes the
                  ask reviewable (and the register diligence-ready). */}
              {isStaff && excMaps && Object.keys(excMaps.compensatingFactors).length > 0 && (
                <div style={{ marginTop: 8 }}>
                  <div className="muted small" style={{ marginBottom: 4 }}>What offsets the risk? (tick any that apply)</div>
                  <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
                    {Object.entries(excMaps.compensatingFactors).filter(([k]) => k !== 'other').map(([k, label]) => (
                      <label key={k} className="muted small" style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                        <input type="checkbox" checked={excFactors.includes(k)}
                          onChange={(e) => setExcFactors((s) => e.target.checked ? [...s, k] : s.filter((x) => x !== k))} />
                        {label}
                      </label>
                    ))}
                  </div>
                </div>
              )}
              <div className="row" style={{ gap: 8, marginTop: 8 }}>
                <button className="btn primary small" disabled={busy || !excReq.trim()} onClick={requestException}>
                  {busy ? 'Sending…' : 'Send request'}
                </button>
                <button className="btn ghost small" onClick={() => { setExcReqOpen(false); setExcReq(''); setExcFactors([]); }}>Cancel</button>
              </div>
            </div>
          )}
        </div>
      )}

      {!cur && data && (
        <p className="muted small" style={{ margin: '10px 0 0' }}>
          No product registered yet. Price the deal in the Term Sheet Studio, pick the Standard, Gold
          Standard or Silver program and your leverage, then register — the terms, cash to close and
          liquidity requirement all flow onto this file.
        </p>
      )}
      {cur && <RegisteredProductDetails reg={cur} showAdmin={staffAdmin} />}
      {/* 1% closing-cost buffer waiver (owner-authorized 2026-07-31): admin-only
          per-file toggle. The buffer is part of the liquidity requirement
          everywhere (condition, structure, term sheet, closing) unless waived. */}
      {isStaff && app && (staffRole === 'admin' || staffRole === 'super_admin') && (
        <label className="row small" style={{ gap: 6, margin: '8px 0 0', alignItems: 'center', color: '#4B585C' }}>
          <input type="checkbox" checked={!!app.liquidity_buffer_waived} disabled={busy}
            onChange={async (e) => {
              const waived = e.target.checked;
              setBusy(true); setErr(''); setMsg('');
              try {
                await api.staffSetLiquidityBuffer(appId, waived);
                setMsg(waived ? 'Closing-cost buffer waived on this file.' : 'Closing-cost buffer restored (1% of the loan).');
                try { const dNew = await loadPricing(); setData(dNew); } catch (_) { /* keep old */ }
                if (onRegistered) onRegistered();   // parent re-fetches the app row (the flag lives there)
              } catch (e2) { setErr((e2 && e2.message) || 'Could not update the buffer waiver.'); }
              finally { setBusy(false); }
            }} />
          <span>Waive the 1% closing-cost buffer on this file (admin) — removes it from the liquidity to verify.</span>
        </label>
      )}
      {/* Program ON/OFF switches — the per-FILE exception (owner-directed
          2026-08-18). Renders only while a program is discontinued company-wide:
          a SUPER ADMIN turns it back on for this one file (a recorded, audited
          exception for a deal already in process); everyone else sees why the
          program's box is missing. The company switch itself lives in the
          Pricing Admin Center. */}
      {isStaff && data && data.programAvailability
        && Object.values(data.programAvailability).some((p) => p && p.active === false) && (
        <div style={{ border: '1px solid #d9b26a', borderRadius: 10, padding: '10px 12px', margin: '10px 0 0', background: 'rgba(201,168,106,.07)' }}>
          <strong style={{ color: '#141B22' }}>Discontinued programs on this file</strong>
          {Object.values(data.programAvailability).filter((p) => p && p.active === false).map((p) => (
            <div key={p.key} className="small" style={{ marginTop: 8, color: '#3A4550' }}>
              <div>
                <strong style={{ color: '#141B22' }}>{p.label}</strong> — discontinued company-wide.{' '}
                {p.exception
                  ? <>Turned <strong>ON for this file only</strong> by {p.exception.byName || 'a super admin'}
                      {p.exception.reason ? <> — “{p.exception.reason}”</> : null}. Its box shows in the studio with the discontinued note.</>
                  : (staffRole === 'super_admin'
                    ? 'Its box is hidden in the studio. You can turn it back on for this file only (a deal already in process).'
                    : 'Its box is hidden in the studio. A super admin can turn it back on for this file only (a deal already in process).')}
              </div>
              {staffRole === 'super_admin' && (
                <button className="btn ghost small" style={{ marginTop: 6 }} disabled={busy}
                  onClick={async () => {
                    const enabling = !p.exception;
                    if (enabling) {
                      const okc = await askConfirm(
                        `Turn the ${p.label} program back ON for this file only?\n\nThe program stays discontinued for every other file — this records a one-deal exception (who, when, why) and brings its box back in this file's studio with the discontinued note.`,
                        { confirmLabel: `Turn ${p.label} on for this file` });
                      if (!okc) return;
                      const reason = await askPrompt(`Why does this file stay on the ${p.label} program? (e.g. "already in process — term sheet out before the program was discontinued")`);
                      if (reason == null) return;
                      if (String(reason).trim().length < 5) { setErr('Add a short reason for the exception.'); return; }
                      setBusy(true); setErr(''); setMsg('');
                      try {
                        await api.staffProgramException(appId, p.key, true, String(reason).trim());
                        setMsg(`${p.label} is back on for this file only.`);
                        try { const dNew = await loadPricing(); setData(dNew); } catch (_) { /* keep old */ }
                      } catch (e2) { setErr((e2 && e2.message) || 'Could not record the exception.'); }
                      finally { setBusy(false); }
                    } else {
                      const okc = await askConfirm(
                        `Turn the ${p.label} program back OFF for this file? Its box disappears from this file's studio again.`,
                        { confirmLabel: `Turn ${p.label} off for this file` });
                      if (!okc) return;
                      setBusy(true); setErr(''); setMsg('');
                      try {
                        await api.staffProgramException(appId, p.key, false);
                        setMsg(`${p.label} is off for this file again.`);
                        try { const dNew = await loadPricing(); setData(dNew); } catch (_) { /* keep old */ }
                      } catch (e2) { setErr((e2 && e2.message) || 'Could not remove the exception.'); }
                      finally { setBusy(false); }
                    }
                  }}>
                  {p.exception ? `Turn ${p.label} off for this file` : `Turn ${p.label} on for this file only`}
                </button>
              )}
            </div>
          ))}
        </div>
      )}
      {superseded.length > 0 && (
        <p className="muted small" style={{ margin: '8px 0 0' }}>
          {superseded.length} previous registration{superseded.length === 1 ? '' : 's'} on this file (superseded):{' '}
          {superseded.map((h) => `${h.program === 'gold' ? 'Gold' : h.program === 'silver' ? 'Silver' : h.program === 'manual' ? 'Manual' : 'Standard'} ${money(h.total_loan)} @ ${fmtRatePct(h.note_rate)}% on ${when(h.created_at)}`).join(' · ')}
        </p>
      )}

      {openStudio && (
        <div className="toolsheet" role="dialog" aria-modal="true" aria-label="Products & Pricing — Term Sheet Studio">
          <header className="toolsheet-head">
            <button className="toolsheet-back" aria-label="Save and go back to the file" onClick={closeStudio}>←</button>
            <div className="toolsheet-titles">
              <strong>Products &amp; Pricing — Term Sheet Studio</strong>
              <span className="muted small">Autosaves as you work — leaving saves your scenario to the file too.</span>
            </div>
            {cur && <span className="ts-badge ok" style={{ marginRight: 4 }}>Registered · {money(cur.total_loan)} @ {fmtRatePct(cur.note_rate)}%</span>}
            <button className={`btn primary toolsheet-done${registerBlocked ? ' is-blocked' : ''}`}
              disabled={busy} aria-disabled={busy || registerBlocked} onClick={registerClick}>
              {busy ? (submitExceptionMode ? 'Submitting…' : 'Registering…')
                : submitExceptionMode ? 'Submit exception request'
                : cur ? 'Re-register this product' : 'Register this product'}
            </button>
          </header>
          {(err || msg || blockReason) && (
            <div className="toolsheet-sub">
              {err && <span role="alert" className="small" style={{ color: 'var(--danger)' }}>{err}</span>}
              {msg && !err && <span className="small" style={{ color: 'var(--ok)' }}>{msg}</span>}
              {blockReason && !err && !msg && <span className="small" style={{ color: 'var(--warning)' }}>⚠ {blockReason}</span>}
            </div>
          )}
          <div className="toolsheet-body scroll" ref={sheetBodyRef}>
            <div className="toolsheet-inner">
              <p className="muted small" style={{ margin: '12px 0 8px' }}>
                {isStaff
                  ? 'The live Term Sheet Studio, prefilled from this file. Adjust anything — pick the program and leverage, then register. Every detail saves back onto the file and the exact term sheet PDF is attached (previous sheets are marked superseded).'
                  : 'Prefilled from your loan file. Adjust your experience, credit and reserve, compare the programs, pick your leverage — then register your product. Deal numbers come from your file; ask your loan team to change those.'}
              </p>
              {/* Open fatal appraisal findings hold term-sheet generation
                  (owner-directed 2026-07-31). Server-enforced on the attach
                  door; said here BEFORE they try, and the studio's own
                  Download-PDF refuses with the same reason (issueHold). */}
              {data && data.termSheetHold && (
                <div className="notice warn" style={{ margin: '10px 0' }}>
                  <strong>Term sheets are on hold.</strong>{' '}
                  {isStaff ? data.termSheetHold : 'Your loan team is reviewing the appraisal — a term sheet will be available shortly.'}
                </div>
              )}
              {/* WHICH STAMP this sheet will print (owner-directed 2026-08-02).
                  The INITIAL/FINAL wording is drawn into the PDF as it is
                  generated, and only a FINAL sheet may go out for signature —
                  so say up front which one registering is about to produce, and
                  what is still standing in the way of the final one. Staff only:
                  a borrower's sheet is always a working copy. */}
              {isStaff && data && (data.termSheetFinal
                ? (
                  <div className="notice ok" style={{ margin: '10px 0' }}>
                    <strong>This will be issued as the FINAL term sheet.</strong>{' '}
                    Everything needed to send it for signature is in place, so registering attaches the sheet
                    stamped <em>Final Term Sheet</em> — the version that goes out on DocuSign.
                  </div>
                ) : (
                  <div className="notice" style={{ margin: '10px 0' }}>
                    <strong>This will be a working term sheet, marked “INITIAL — NOT FINAL”.</strong>{' '}
                    {(data.termSheetFinalBlockers || []).length
                      ? <>Still outstanding: {(data.termSheetFinalBlockers || []).map((b) => b.label).join(', ')}. </>
                      : null}
                    Once those are done, re-register here and the sheet regenerates as the final one — that is the
                    version DocuSign sends for signature.
                  </div>
                ))}
              {prefill
                ? <TermSheetStudio ref={studioRef} prefill={prefill} lockedIds={lockedIds}
                    showAdmin={staffAdmin} adminCapable={isStaff} onState={onStudioState}
                    issueHold={(data && data.termSheetHold) || null}
                    provenance={data && data.termSheetFinal ? 'file_final' : 'file'}
                    /* TPO only: the resolved firm pricing (channel/firm markup +
                       origination + broker fee) so the broker sheet prices exactly
                       what registers. Null on staff/borrower (route omits it). */
                    pricingDefaults={(isTpo && data && data.pricingDefaults) || null}
                    officer={isStaff && app && (app.loan_officer_name || app.loan_officer_email)
                      ? { name: app.loan_officer_name || '', email: app.loan_officer_email || '', nmls: app.loan_officer_nmls || '', role: 'Loan officer' }
                      : null} />
                : <p className="muted small">Loading your scenario…</p>}
              {/* Pricing controls are open to every staff role again, and every
                  change to them goes for approval (owner-directed 2026-07-27).
                  Say it BEFORE they register, not after. */}
              {isStaff && (
                <div className={`notice${liveNeedsApproval ? ' warn' : ''}`} style={{ margin: '10px 0' }}>
                  {liveNeedsApproval ? (
                    <>
                      <strong>This goes to an admin for approval.</strong>{' '}
                      You changed the pricing defaults{liveOverrideKeys.length ? ` — ${liveOverrideKeys.join(', ')}` : ''}
                      {manualLive ? `${liveOverrideKeys.length ? ', and' : ' —'} the LTV / LTC / ARV basis` : ''}.
                      {' '}Registering files it as an exception: the file carries the new terms, but the borrower isn’t
                      sent them and the term sheet can’t be sent until an admin approves it in the Escalations box.
                      {isApprover ? ' Someone other than you has to approve it.' : ''}
                    </>
                  ) : (
                    <>
                      <strong>Pricing controls</strong> are at the bottom of the form — rate markup, origination points,
                      closing-cost fees, and a manual LTV / LTC / ARV / rate basis. Anything you change there goes to an
                      admin for approval before the borrower gets terms. Leave them alone and the deal registers as usual.
                    </>
                  )}
                  {/* The Manual Program's months-of-RESERVES input lives HERE, inside
                      the same approval box as the manual program — one section, not a
                      separate box (owner-directed 2026-08-11). It is how many months of
                      reserves the borrower must show in the ending balance of the most
                      recent statement; defaults to 3 and this box overrides it. */}
                  {manualLive && (
                    <div style={{ marginTop: 10 }}>
                      <div className="small">
                        <strong>Manual program — months of reserves.</strong> How many months of reserves must this file
                        show in the ending balance of the most recent statement? Defaults to 3; this box overrides it.
                      </div>
                      <div className="row" style={{ gap: 8, alignItems: 'center', marginTop: 8 }}>
                        <input type="number" min="1" max="24" step="1" value={assetMonths}
                          onChange={(e) => setAssetMonths(e.target.value)} style={{ width: 90 }}
                          aria-label="Months of reserves required" placeholder="months" />
                        <span className="muted small">months of reserves (default 3, 1–24)</span>
                      </div>
                    </div>
                  )}
                </div>
              )}
              {(submitExceptionMode || exceptionInfo) && (
                <div className="notice warn" style={{ margin: '10px 0' }}>
                  <strong>Not eligible as-is — manual-review exception.</strong>{' '}
                  {(exceptionInfo && exceptionInfo.message) || blockReason || 'This scenario needs a manual-review exception.'}
                  {exceptionInfo && Array.isArray(exceptionInfo.manualReasons) && exceptionInfo.manualReasons.length > 0 && (
                    <ul style={{ margin: '6px 0 0 18px' }}>
                      {exceptionInfo.manualReasons.map((m, i) => <li key={i}>{m}</li>)}
                    </ul>
                  )}
                </div>
              )}
              {/* The refusal reason renders NEXT TO the bottom Register button too —
                  the top bar is off-screen by the time you scroll down here (the
                  EditFileDetails lesson: a notice only at the top reads as
                  "nothing happened"). */}
              {(err || blockReason) && (
                <p className="small" role={err ? 'alert' : undefined}
                  style={{ margin: '4px 0 6px', fontWeight: 600, color: err ? 'var(--danger)' : 'var(--warning)' }}>
                  {err || `⚠ ${blockReason}`}
                </p>
              )}
              <div className="toolsheet-actions">
                <button className={`btn primary${registerBlocked ? ' is-blocked' : ''}`}
                  disabled={busy} aria-disabled={busy || registerBlocked} onClick={registerClick}>
                  {busy ? (submitExceptionMode ? 'Submitting…' : 'Registering…')
                    : submitExceptionMode ? 'Submit exception request'
                    : cur ? 'Re-register this product' : 'Register this product'}
                </button>
                <button className="btn ghost" onClick={closeStudio}>Save &amp; exit</button>
                {/* Borrower-side "admin pricing" was removed (S1-04): the server no
                    longer honors a borrower adminKey, so no borrower admin-mode UI. */}
                <span className="muted small studio-foot-status">{statusLine}</span>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
});

export default ProductStudioPanel;
