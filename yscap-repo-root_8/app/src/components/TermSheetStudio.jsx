import React, { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react';

/* The REAL static Term Sheet Studio (web/tools/term-sheet.html) embedded in
   the portal through a same-origin iframe. The static page and its frozen
   engines are never modified — the portal only prefills its inputs
   (YS.applyState), hides the marketing chrome, reads the exact computed
   results back out (window.TS._calc / _calcGold, exposed by termsheet.js),
   and captures the exact jsPDF term sheet by intercepting doc.save() so the
   identical document can be attached to the loan file. Every guideline,
   limitation, note and number the borrower sees is the static tool's own. */

const STUDIO_URL = '/tools/term-sheet.html';

// Marketing chrome that has no place inside the portal. Everything else —
// the full form, program cards, leverage slider, eligibility, structure,
// fees, cash to close, liquidity, compliance text — renders untouched.
const HIDE_CSS = `
  .topbar, .tool-hero, .suite-footer, #leadCapture, #handoff,
  #floatActions, #applyModal, .fill-hint { display: none !important; }
  body { padding-top: 0 !important; }
`;
// Borrowers never see the studio's admin pricing zone; staff keep it (and get
// it pre-unlocked) so markups, origination and fee overrides work exactly as
// they do on the marketing tool.
const HIDE_ADMIN_CSS = `.ts-admin-zone { display: none !important; }`;

/* ---- shared field mapping: portal loan data <-> studio input ids ---- */

export function studioDealPurpose(loanType) {
  const t = String(loanType || '').toLowerCase();
  if (t.includes('cash')) return 'Cash-out refinance';
  if (t.includes('refi')) return 'Rate & term refinance';
  return 'Purchase';
}
export function portalLoanType(dealPurpose) {
  const t = String(dealPurpose || '').toLowerCase();
  if (t.includes('cash')) return 'Refinance — Cash-Out';
  if (t.includes('refinance')) return 'Refinance — Rate & Term';
  return 'Purchase';
}
export function studioDealType(program) {
  const p = String(program || '').toLowerCase();
  if (p.includes('bridge') || p.includes('stabil')) return 'Bridge / Stabilized';
  if (p.includes('ground')) return 'Ground-up Construction';
  if (p.includes('hold') || p.includes('brrrr')) return 'Fix & Hold (BRRRR)';
  return 'Fix & Flip';
}
export function portalProgram(dealType) {
  const t = String(dealType || '').toLowerCase();
  if (t.includes('bridge') || t.includes('stabil')) return 'Bridge';
  if (t.includes('ground')) return 'Ground-Up Construction';
  if (t.includes('hold') || t.includes('brrrr')) return 'Fix & Hold (BRRRR)';
  return 'Fix & Flip w/ Construction';
}

const rawNum = (v) => {
  if (v == null || v === '') return '';
  const n = Number(String(v).replace(/[$,%\s,]/g, ''));
  return isFinite(n) ? String(n) : '';
};
const termDigits = (t) => {
  const m = /(\d{1,2})/.exec(String(t == null ? '' : t));
  return m ? m[1] : '12';
};

/* Build the YS.applyState payload the studio understands from portal loan
   data (an application draft or an applications row — caller normalizes). */
export function buildStudioState(x) {
  const isAssign = !!x.isAssignment && rawNum(x.underlyingContractPrice) !== '';
  const price = rawNum(x.purchasePrice) ||
    (isAssign ? String((Number(rawNum(x.underlyingContractPrice)) || 0) + (Number(rawNum(x.assignmentFee)) || 0)) : '');
  const v = {
    borrowerName: x.borrowerName || '',
    propAddr: x.address || '',
    dealPurpose: studioDealPurpose(x.loanType),
    dealType: studioDealType(x.program),
    propState: String(x.state || '').toUpperCase(),
    propType: /2.?4/.test(String(x.propertyType || '')) || Number(x.units) > 1 ? '2-4' : 'sfr',
    price,
    origPrice: isAssign ? rawNum(x.underlyingContractPrice) : '',
    asIs: rawNum(x.asIsValue),
    arv: rawNum(x.arv),
    construction: rawNum(x.rehabBudget),
    rehabScope: /heavy|gut/i.test(String(x.rehabType || '')) ? 'heavy' : 'light',
    fico: rawNum(x.fico),
    expFlips: rawNum(x.expFlips) || '0',
    expBrrrr: rawNum(x.expHolds) || '0',
    expGround: rawNum(x.expGround) || '0',
    tsTerm: termDigits(x.termMonths || x.term),
    irMonths: rawNum(x.irMonths) || '',
  };
  const c = {
    isAssign,
    addrTBD: !x.address,
    sqft: /square|addition/i.test(String(x.rehabType || '')),
  };
  return { v, c };
}

/* Everything the studio currently shows, read straight out of the static
   page: the raw inputs (by element id), the chosen program, and the exact
   calc objects the static tool renders + exports from. */
function readSnapshot(win) {
  const doc = win.document;
  const val = (id) => { const e = doc.getElementById(id); return e ? String(e.value).trim() : ''; };
  const chk = (id) => { const e = doc.getElementById(id); return !!(e && e.checked); };
  const active = (id) => { const e = doc.getElementById(id); return !!(e && e.classList.contains('pcard-active')); };
  const program = active('pcardGold') ? 'gold' : active('pcardStd') ? 'standard' : null;
  const missBox = doc.getElementById('rMissing');
  const ready = !!missBox && missBox.style.display === 'none';
  const missing = missBox ? Array.from(missBox.querySelectorAll('li')).map((li) => li.textContent) : [];
  let std = null, gold = null;
  try { std = win.TS._calc(); } catch (_) { /* engine not ready yet */ }
  try { gold = win.TS._calcGold(); } catch (_) { /* gold engine optional */ }
  const d = program === 'gold' && gold && !gold.unavailable ? gold : std;
  return {
    program, ready, missing, std, gold, d,
    fields: {
      borrowerName: val('borrowerName'), propAddr: val('propAddr'), addrTBD: chk('addrTBD'),
      dealPurpose: val('dealPurpose'), dealType: val('dealType'),
      propState: val('propState'), propType: val('propType'),
      price: val('price'), isAssign: chk('isAssign'), origPrice: val('origPrice'),
      asIs: val('asIs'), arv: val('arv'), construction: val('construction'),
      rehabScope: val('rehabScope'), sqft: chk('sqft'),
      fico: val('fico'), expFlips: val('expFlips'), expBrrrr: val('expBrrrr'), expGround: val('expGround'),
      tsTerm: val('tsTerm'), irMonths: val('irMonths'),
      // admin pricing knobs (staff mode) — same names the staff pricing API takes
      tsYspStd: val('tsYspStd'), tsYspGold: val('tsYspGold'),
      tsOrigStd: val('tsOrigStd'), tsOrigGold: val('tsOrigGold'),
      tsFeeUW: val('tsFeeUW'), tsFeeCredit: val('tsFeeCredit'),
      tsFeeAppr: val('tsFeeAppr'), tsFeeTitle: val('tsFeeTitle'),
      tsManualOn: chk('tsManualOn'),
      tsMLtv: val('tsMLtv'), tsMArv: val('tsMArv'), tsMLtc: val('tsMLtc'),
      tsMRate: val('tsMRate'), tsMIr: val('tsMIr'),
    },
  };
}

/* Normalize a saved product_registrations.inputs row (frozen-engine input
   shape) back into the scenario shape buildStudioState() takes, so reopening
   the studio shows exactly the registered scenario. */
export function scenarioFromEngineInputs(inp, extra = {}) {
  inp = inp || {};
  return {
    loanType: inp.loanType === 'Refinance' ? (inp.cashOut ? 'Refinance — Cash-Out' : 'Refinance — Rate & Term') : 'Purchase',
    program: inp.strategy,
    state: inp.state,
    propertyType: inp.propertyType,
    units: inp.units,
    purchasePrice: inp.purchasePrice,
    isAssignment: !!inp.isAssignment,
    underlyingContractPrice: inp.sellerPrice,
    assignmentFee: inp.isAssignment && inp.purchasePrice && inp.sellerPrice
      ? Math.max(0, Number(inp.purchasePrice) - Number(inp.sellerPrice)) : '',
    asIsValue: inp.asIsValue,
    arv: inp.arv,
    rehabBudget: inp.rehabBudget,
    rehabType: inp.heavyRehab ? 'Heavy / gut rehab' : (inp.sqftAddition ? 'Adding square footage' : ''),
    fico: inp.fico,
    expFlips: inp.expFlips, expHolds: inp.expHolds, expGround: inp.expGround,
    termMonths: inp.term, irMonths: inp.irMonths,
    ...extra,
  };
}

/* Admin-knob values from saved engine inputs -> studio admin field ids, so a
   staff re-open restores the registered markups/fees too. */
export function adminStateFromEngineInputs(inp) {
  inp = inp || {};
  const v = {};
  const put = (id, val) => { if (val != null && val !== '') v[id] = String(val); };
  put('tsYspStd', inp.markupStdPct); put('tsYspGold', inp.markupGoldPct);
  put('tsOrigStd', inp.origStdPct); put('tsOrigGold', inp.origGoldPct);
  put('tsFeeUW', inp.lenderFee); put('tsFeeCredit', inp.creditFee);
  put('tsFeeAppr', inp.appraisalFee); put('tsFeeTitle', inp.titleFee);
  put('tsMLtv', inp.ovrAcqLTVPct); put('tsMArv', inp.ovrARLTVPct);
  put('tsMLtc', inp.ovrLTCPct); put('tsMRate', inp.ovrRatePct); put('tsMIr', inp.ovrIrMonths);
  return { v, c: inp.manualPricing ? { tsManualOn: true } : {} };
}

/* A compact, human-readable copy of the priced structure — stored on the
   draft/file as the placeholders for every detail from the static studio. */
export function selectionFromSnapshot(snap) {
  const d = snap.d || {};
  return {
    source: 'term-sheet-studio',
    selectedAt: new Date().toISOString(),
    program: snap.program,
    programLabel: snap.program === 'gold' ? 'Gold Standard Program' : 'Standard Program',
    strategy: snap.fields.dealType,
    purpose: snap.fields.dealPurpose,
    status: d.status || null,
    tierLabel: d.tierLabel || null,
    totalLoan: d.totalLoan || 0,
    noteRatePct: d.rate || 0,
    termMonths: d.term || null,
    irMonths: d.irMonths || 0,
    initialAdvance: d.initialAdvance || 0,
    rehabHoldback: d.rehabHoldback || 0,
    financedInterestReserve: d.financedIR || 0,
    downPayment: d.downPayment || 0,
    originationFee: d.origFee || 0,
    originationPct: d.origPct != null ? d.origPct * 100 : null,
    lenderFee: d.lenderFee || 0,
    creditFee: d.creditFee || 0,
    appraisalFeePoc: d.apprFee || 0,
    titleEstimate: d.titleCost || 0,
    closingCosts: d.closing || 0,
    cashToClose: d.cashToClose || 0,
    reserveToShow: d.reserves || 0,
    liquidityToShow: d.liquidity || 0,
    ltcPct: d.ltcPct != null ? d.ltcPct * 100 : null,
    asIsLtvPct: d.ltvPct != null ? d.ltvPct * 100 : null,
    arvLtvPct: d.arvPct != null ? d.arvPct * 100 : null,
    binding: d.binding || '',
    targetLTC: (d.inp && d.inp.targetLTC) || null,
  };
}

export function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => { const s = String(r.result); const i = s.indexOf(','); resolve(i >= 0 ? s.slice(i + 1) : s); };
    r.onerror = reject;
    r.readAsDataURL(blob);
  });
}

function loadPdfEngine(doc) {
  return new Promise((resolve, reject) => {
    const add = (src, onerr) => {
      const s = doc.createElement('script');
      s.src = src; s.onload = resolve; s.onerror = onerr;
      doc.head.appendChild(s);
    };
    add('https://cdn.jsdelivr.net/npm/jspdf@2.5.1/dist/jspdf.umd.min.js',
      () => add('https://unpkg.com/jspdf@2.5.1/dist/jspdf.umd.min.js', reject));
  });
}

const TermSheetStudio = forwardRef(function TermSheetStudio({ prefill, lockedIds = [], onState, showAdmin = false }, ref) {
  const frameRef = useRef(null);
  const winRef = useRef(null);
  const onStateRef = useRef(onState);
  onStateRef.current = onState;
  const prefillRef = useRef(prefill);
  prefillRef.current = prefill;
  const [failed, setFailed] = useState(false);

  useImperativeHandle(ref, () => ({
    snapshot() {
      const win = winRef.current;
      if (!win || !win.TS) return null;
      try { return readSnapshot(win); } catch (_) { return null; }
    },
    /* Build the exact PDF the static tool downloads, but capture the bytes
       instead: doc.save() is swapped for an output('blob') capture for the
       duration of the one export call, then restored. */
    async capturePdf() {
      const win = winRef.current;
      if (!win || !win.TS) return null;
      if (!(win.jspdf && win.jspdf.jsPDF)) {
        try { await loadPdfEngine(win.document); } catch (_) { return null; }
      }
      if (!(win.jspdf && win.jspdf.jsPDF)) return null;
      const API = win.jspdf.jsPDF.API;
      const orig = API.save;
      let captured = null;
      API.save = function saveCapture(name) {
        try { captured = { blob: this.output('blob'), filename: String(name || 'YS_Term_Sheet.pdf') }; } catch (_) { /* fall through */ }
        return this;
      };
      try { await win.TS.exportPdf(null); } finally { API.save = orig; }
      return captured;
    },
  }), []);

  useEffect(() => {
    const frame = frameRef.current;
    if (!frame) return undefined;
    let poller = null;
    let disposed = false;

    const boot = () => {
      let win;
      try { win = frame.contentWindow; if (!win || !win.document) throw new Error('no frame'); }
      catch (_) { setFailed(true); return; }

      // termsheet.js wires itself on DOMContentLoaded, so TS/YS may land a
      // beat after the frame's load event — wait for both.
      let tries = 0;
      const ready = setInterval(() => {
        if (disposed) { clearInterval(ready); return; }
        tries += 1;
        if (!(win.TS && win.YS)) {
          if (tries > 100) { clearInterval(ready); setFailed(true); }
          return;
        }
        clearInterval(ready);
        winRef.current = win;
        const doc = win.document;
        try {
          const style = doc.createElement('style');
          style.textContent = HIDE_CSS + (showAdmin ? '' : HIDE_ADMIN_CSS);
          doc.head.appendChild(style);
        } catch (_) { /* cosmetic only */ }
        if (showAdmin) {
          // Staff are already authenticated in the portal — skip the studio's
          // client-side password gate and open the pricing controls directly.
          try {
            const panel = doc.getElementById('tsAdminPanel');
            const lock = doc.getElementById('tsAdminLock');
            const trig = doc.getElementById('tsAdminTrigger');
            if (panel) panel.hidden = false;
            if (lock) lock.hidden = true;
            if (trig) trig.hidden = true;
          } catch (_) { /* password gate still works */ }
        }
        try { if (prefillRef.current) win.YS.applyState(prefillRef.current); } catch (_) { /* keep defaults */ }
        for (const id of lockedIds) {
          const e = doc.getElementById(id);
          if (!e) continue;
          e.disabled = true;
          const wrap = e.closest && e.closest('.input');
          if (wrap) wrap.classList.add('is-ro');
        }
        // one input event on a wired field makes the studio recompute + render;
        // the manual-scenario checkbox needs its change handler to sync its
        // dependent fields' visibility after a prefill.
        try {
          const m = doc.getElementById('tsManualOn');
          if (m) m.dispatchEvent(new win.Event('change', { bubbles: true }));
          const f = doc.getElementById('fico');
          if (f) f.dispatchEvent(new win.Event('input', { bubbles: true }));
        } catch (_) { /* studio still renders on its own next input */ }

        poller = setInterval(() => {
          if (disposed) return;
          try {
            frame.style.height = Math.max(900, win.document.documentElement.scrollHeight + 24) + 'px';
            if (onStateRef.current) onStateRef.current(readSnapshot(win));
          } catch (_) { /* frame navigated / torn down */ }
        }, 700);
      }, 100);
    };

    frame.addEventListener('load', boot);
    return () => {
      disposed = true;
      frame.removeEventListener('load', boot);
      if (poller) clearInterval(poller);
      winRef.current = null;
    };
    // mount-once: the frame prefill/lock/admin setup applies to the initial props
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  if (failed) {
    return (
      <div className="notice err">
        The Term Sheet Studio could not be loaded. Refresh the page, or continue and your loan
        team will price the file with you.
      </div>
    );
  }
  return (
    <iframe ref={frameRef} src={STUDIO_URL} title="YS Term Sheet Studio"
      style={{ width: '100%', border: 0, display: 'block', minHeight: 900, background: 'transparent' }} />
  );
});

export default TermSheetStudio;
