import React, { useEffect, useRef, useState, useCallback, useMemo } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { api } from '../lib/api.js';
import { useSubmitGate } from '../lib/useSubmitGate.js';
import { useAutosave } from '../lib/useAutosave.js';
import AddressAutocomplete from '../components/AddressAutocomplete.jsx';
import LlcPicker from '../components/LlcPicker.jsx';
import { MoneyInput, PhoneInput } from '../components/FormattedInputs.jsx';
import TermSheetStudio, {
  buildStudioState, portalLoanType, portalProgram, selectionFromSnapshot, blobToBase64,
} from '../components/TermSheetStudio.jsx';

const STEPS = ['Property', 'Loan', 'Borrower', 'Price & register'];
// The property identity is step 1's job — everything else in the studio is editable.
const STUDIO_LOCKED = ['propAddr', 'addrTBD', 'propState'];
// Ground-Up is a PROGRAM (not a loan type/purpose). DSCR Rental is intentionally
// not offered here for now.
const PROGRAMS = ['Fix & Flip w/ Construction', 'Bridge', 'Ground-Up Construction', 'Not sure yet'];
const LOAN_TYPES = ['Purchase', 'Refinance — Rate & Term', 'Refinance — Cash-Out'];
const PROP_TYPES = ['SFR (1 unit)', 'Multi 2–4', 'Multi 5+', 'Condo', 'Townhouse', 'Mixed use'];
const CITIZENSHIP = ['US Citizen', 'Permanent Resident', 'Foreign National'];
const REHAB_TYPES = ['Cosmetic', 'Moderate', 'Heavy / gut rehab', 'Adding square footage', 'Ground-up construction'];
// Plain-language explanations so a first-time borrower can tell the options apart.
const REHAB_TYPE_INFO = {
  'Cosmetic': 'Surface-level updates only — paint, flooring, fixtures, appliances, landscaping. No layout or structural changes.',
  'Moderate': 'Cosmetic work plus some upgrades — e.g. a kitchen or bath remodel, new HVAC or roof, or minor reconfiguration. The building footprint stays the same.',
  'Heavy / gut rehab': 'A down-to-the-studs renovation: replacing major systems (plumbing, electrical, roof) and/or reworking the interior layout — but without adding square footage.',
  'Adding square footage': 'Expanding the existing structure — an addition, finishing a basement or attic, or raising the roofline — so the finished home is larger than it is today.',
  'Ground-up construction': 'Building brand-new from the ground up (including after a teardown) — you are financing construction of a new structure, not renovating an existing one.',
};
const MARITAL = ['Single', 'Married', 'Separated', 'Divorced', 'Widowed'];
const HOUSING = ['Rent', 'Own with mortgage', 'Own free and clear', 'Live with family', 'Other'];

// Fix & Flip / Ground-Up / construction files use ARV + rehab budget; a straight
// Bridge does not, so those fields are hidden for them (same rule as the
// static loan application: Bridge/Stabilized wipes rehab + ARV).
const needsRehab = (program) => !program || /flip|ground|construction|rehab|not sure/i.test(program);
const needsSqft = (rehabType) => /square|adding|ground/i.test(rehabType || '');
// An assignment only applies to a purchase; a refinance swaps the purchase
// price for payoff / original-purchase fields (static loan-application logic).
const isPurchase = (loanType) => !loanType || /purchase/i.test(loanType);
const isRefi = (loanType) => /refi/i.test(loanType || '');

// Property type drives the unit-count control. Single-unit types default to 1
// and never ask; 2–4 offers a dropdown; 5+ / mixed-use take a number.
function unitsMode(propType) {
  if (/2.?4/.test(propType || '')) return 'select24';
  if (/5\+|mixed/i.test(propType || '')) return 'multi';
  return 'single'; // SFR / Condo / Townhouse
}
const money = (n) => (n || n === 0) ? '$' + Number(n).toLocaleString() : '—';

function SaveChip({ status }) {
  const map = { idle: '', saving: 'Saving…', saved: 'All changes saved', error: 'Save failed — retrying' };
  return <span className="savechip"><span className={`dot ${status === 'saved' ? 'done' : status === 'error' ? '' : 'outstanding'}`} />{map[status] || ''}</span>;
}

export default function Apply() {
  const { draftId } = useParams();
  const nav = useNavigate();
  const [id, setId] = useState(draftId || null);
  const [form, setForm] = useState(null);      // null = loading
  const [step, setStep] = useState(1);
  const [showErrors, setShowErrors] = useState(false);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const [officers, setOfficers] = useState([]);
  const [partners, setPartners] = useState([]);
  const [snap, setSnap] = useState(null);          // live Term Sheet Studio state (step 4)
  const [appId, setAppId] = useState(null);        // set the moment the application is submitted (step 4 entry)
  const [adminKey, setAdminKey] = useState('');    // admin pricing unlock (same gate as the static studio)
  const studioRef = useRef(null);
  const lastStudioSync = useRef('');
  const idRef = useRef(id);
  idRef.current = id;
  const appIdRef = useRef(null);
  appIdRef.current = appId;

  // load existing draft, or create a fresh one — then prefill the personal
  // section from the borrower's saved profile (empty fields only), so repeat
  // applicants never retype what the portal already knows. Employment is not
  // collected (no-doc / no-income).
  useEffect(() => {
    let live = true;
    (async () => {
      try {
        let data = {}, stepN = 1;
        if (draftId) {
          const d = await api.draft(draftId);
          if (!live) return;
          // An already-submitted draft is read-only server-side: every autosave
          // and the submit itself would 409. Send the borrower to the created
          // file instead of stranding them on a dead, un-saveable form.
          if (d.submitted_application_id) { nav(`/app/${d.submitted_application_id}`, { replace: true }); return; }
          data = d.data || {}; stepN = d.step || 1; setId(draftId);
        } else {
          const d = await api.createDraft({ label: 'New application', data: {}, step: 1 });
          if (!live) return;
          setId(d.id);
          nav(`/apply/${d.id}`, { replace: true });
        }
        try {
          const p = await api.profile();
          if (!live) return;
          const cur = data.personal || {};
          data.personal = {
            cellPhone: cur.cellPhone || p.cell_phone || '',
            dateOfBirth: cur.dateOfBirth || (p.date_of_birth ? String(p.date_of_birth).slice(0, 10) : ''),
            citizenship: cur.citizenship || p.citizenship || '',
            maritalStatus: cur.maritalStatus || p.marital_status || '',
            fico: cur.fico || p.fico || '',
            currentAddress: cur.currentAddress || p.current_address || {},
            yearsAtResidence: cur.yearsAtResidence || p.years_at_residence || '',
            monthsAtResidence: cur.monthsAtResidence || p.months_at_residence || '',
            housingStatus: cur.housingStatus || p.housing_status || '',
            housingPayment: cur.housingPayment || p.housing_payment || '',
          };
          if (data.ssnOnFile === undefined) data.ssnOnFile = !!p.ssn_last4;
        } catch { /* profile prefill is best-effort */ }
        setForm(data); setStep(stepN);
      } catch (e) { if (live) setErr(e.message); }
    })();
    return () => { live = false; };
  }, [draftId, nav]);

  // The requested-officer dropdown is fed live from the public roster (sales
  // team). We store the chosen officer's name + email; the borrower never types
  // an email, and the backend resolves the officer from it.
  useEffect(() => {
    api.roster().then(r => setOfficers((r.people || []).filter(x => x && x.name))).catch(() => {});
    api.partners().then(setPartners).catch(() => {});
  }, []);

  // Prefill the experience boxes from the borrower's live track record — the
  // application should already know their flips / holds / ground-up / REO.
  useEffect(() => {
    if (!form) return;
    if (form.requestedExpFlips || form.requestedExpHolds || form.requestedExpGround || form.requestedExpReo) return;
    let live = true;
    api.trackRecords().then(rows => {
      if (!live || !rows || !rows.length) return;
      const c = { flips: 0, holds: 0, ground: 0 };
      for (const r of rows) {
        const t = String(r.deal_type || '').toLowerCase();
        if (t.includes('ground')) c.ground++;
        else if (t.includes('flip')) c.flips++;
        else c.holds++;
      }
      setForm(f => {
        if (!f || f.requestedExpFlips || f.requestedExpHolds || f.requestedExpGround) return f;
        const patch = {
          requestedExpFlips: c.flips ? String(c.flips) : '',
          requestedExpHolds: c.holds ? String(c.holds) : '',
          requestedExpGround: c.ground ? String(c.ground) : '',
          requestedExpReo: c.holds ? String(c.holds) : '',
        };
        save({ data: patch });
        return { ...f, ...patch };
      });
    }).catch(() => {});
    return () => { live = false; };
    // prefill once, when the form first loads
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [form == null]);

  // Once the application is submitted (entering step 4), the draft is closed —
  // further wizard edits stay local; the file is the record from then on.
  const doSave = useCallback((patch) => (appIdRef.current ? Promise.resolve({ ok: true }) : api.saveDraft(idRef.current, patch)), []);
  const { status, save, flush } = useAutosave(doSave, 800);

  const set = (k, v) => {
    setForm(f => ({ ...(f || {}), [k]: v }));
    // Never autosave the SSN into the draft blob (it would sit in plaintext at
    // rest). Keep it in local form state only; it's sent once on submit and
    // encrypted server-side. The backend also strips it defensively.
    if (k === 'ssn') return;
    save({ data: { [k]: v } });
  };
  const mergeAddr = (patch) => {
    setForm(f => {
      const address = { ...((f && f.propertyAddress) || {}), ...patch };
      address.oneLine = [[address.street, address.unit].filter(Boolean).join(' '), address.city, [address.state, address.zip].filter(Boolean).join(' ')].filter(Boolean).join(', ');
      save({ data: { propertyAddress: address } });
      return { ...(f || {}), propertyAddress: address };
    });
  };
  const setAddr = (k, v) => mergeAddr({ [k]: v });
  const pickAddr = (a) => mergeAddr({ street: a.line1 || '', unit: a.unit || '', city: a.city || '', state: a.state || '', zip: a.zip || '', county: a.county || '' });
  const setNested = (key) => (k, v) => setForm(f => {
    const obj = { ...((f && f[key]) || {}), [k]: v };
    save({ data: { [key]: obj } });
    return { ...(f || {}), [key]: obj };
  });
  const setPersonal = setNested('personal');
  const setCo = setNested('coBorrower');
  const mergePersonalAddr = (patch) => setForm(f => {
    const personal = { ...((f && f.personal) || {}) };
    const address = { ...(personal.currentAddress || {}), ...patch };
    address.oneLine = [[address.street, address.unit].filter(Boolean).join(' '), address.city, [address.state, address.zip].filter(Boolean).join(' ')].filter(Boolean).join(', ');
    personal.currentAddress = address;
    save({ data: { personal } });
    return { ...(f || {}), personal };
  });
  const setPersonalAddr = (k, v) => mergePersonalAddr({ [k]: v });
  const pickPersonalAddr = (x) => mergePersonalAddr({ street: x.line1 || '', unit: x.unit || '', city: x.city || '', state: x.state || '', zip: x.zip || '' });

  // Choosing the property type auto-resolves units for single-unit types so the
  // borrower never has to answer "units" for a single-family / condo / townhouse.
  const setPropertyType = (v) => {
    setForm(f => {
      const next = { ...(f || {}), propertyType: v };
      if (unitsMode(v) === 'single') next.units = '1';
      else if (String((f || {}).units) === '1') next.units = ''; // clear the auto value when switching to multi
      save({ data: { propertyType: v, units: next.units } });
      return next;
    });
  };

  const pickOfficer = (name) => {
    const o = officers.find(x => x.name === name);
    setForm(f => ({ ...(f || {}), loanOfficerName: name || '', loanOfficerEmail: (o && o.email) || '' }));
    save({ data: { loanOfficerName: name || '', loanOfficerEmail: (o && o.email) || '' } });
  };

  // The property basics (street/type/units) are the only fields the file truly
  // needs — everything else can be finished later. They're enforced at SUBMIT,
  // not while navigating, so a borrower can fill sections in any order.
  const propBasicsMissing = () => {
    const pa = (form && form.propertyAddress) || {};
    const miss = [];
    if (!pa.street) miss.push('Street address');
    if (!(form && form.propertyType)) miss.push('Property type');
    if (!(form && form.units)) miss.push('Number of units');
    return miss;
  };

  const goStep = async (n) => {
    // Steps 1–3: free navigation — fill any section in any order (owner request).
    if (n >= 1 && n <= 3) {
      try { await flush(); } catch (e) { setErr(e.message || 'Autosave hit a snag — your changes are on this device and will retry.'); }
      setStep(n); save({ step: n });
      return;
    }
    // n === 4 SUBMITS the application: the file exists and the team is notified
    // from this moment. Enforce the property basics here and highlight anything
    // still missing, bouncing back to step 1 rather than submitting a bad file.
    const miss = propBasicsMissing();
    if (miss.length) {
      setShowErrors(true); setStep(1);
      setErr(`Before submitting, complete the highlighted required field${miss.length > 1 ? 's' : ''}: ${miss.join(', ')}.`);
      return;
    }
    if (!appIdRef.current) {
      setErr(''); setBusy(true);
      try {
        await flush();
        // SSN is intentionally not in the draft; send it once here so it's
        // encrypted server-side on submit.
        const r = await api.submitDraft(id, form && form.ssn ? { ssn: form.ssn } : {});
        setAppId(r.applicationId);
      } catch (e) {
        if (e.status === 409 && e.data && e.data.applicationId) setAppId(e.data.applicationId);
        else { setErr(e.message || 'Could not submit the application'); setBusy(false); return; }
      }
      setBusy(false);
    }
    // A failed flush isn't fatal here — the batch stays queued and retries on
    // the next change/submit — but surface it so the user knows.
    try { await flush(); } catch (e) { setErr(e.message || 'Autosave hit a snag — your changes are still on this device and will retry.'); }
    setStep(4); save({ step: 4 });
  };

  function finishLater() {
    if (appIdRef.current) nav(`/app/${appIdRef.current}`);
  }

  /* ---- Step 4: the real static Term Sheet Studio, prefilled from this
     draft. The studio is the pricer of record: whatever is entered there is
     written back onto the draft (and therefore the loan file), and
     registering exports every priced detail + the exact studio PDF. ---- */

  // Studio field readouts -> draft fields, so the file carries exactly what
  // was priced. FICO merges into personal so it also reaches the profile.
  const patchFromStudio = (f, cur) => {
    const refi = /refinance/i.test(f.dealPurpose || '');
    const patch = {
      program: portalProgram(f.dealType),
      loanType: portalLoanType(f.dealPurpose),
      asIsValue: f.asIs, arv: f.arv, rehabBudget: f.construction,
      requestedExpFlips: f.expFlips, requestedExpHolds: f.expBrrrr, requestedExpGround: f.expGround,
      termMonths: f.tsTerm, irMonths: f.irMonths || '0', irAmount: f.irAmount || '0',
      isAssignment: !!f.isAssign && !refi,
    };
    if (!refi) patch.purchasePrice = f.price;
    if (patch.isAssignment) {
      patch.underlyingContractPrice = f.origPrice;
      const fee = Math.max(0, (Number(f.price) || 0) - (Number(f.origPrice) || 0));
      patch.assignmentFee = fee ? String(fee) : '';
    }
    if (f.rehabScope === 'heavy') patch.rehabType = 'Heavy / gut rehab';
    if (f.fico) patch.personal = { ...((cur && cur.personal) || {}), fico: f.fico };
    return patch;
  };

  const onStudioState = useCallback((s) => {
    setSnap(s);
    setForm((fm) => {
      if (!fm) return fm;
      const patch = patchFromStudio(s.fields, fm);
      const key = JSON.stringify(patch);
      if (key === lastStudioSync.current) return fm;
      lastStudioSync.current = key;
      save({ data: patch });
      return { ...fm, ...patch };
    });
  }, [save]);

  const studioPrefill = useMemo(() => {
    if (step !== 4 || !form) return null;
    const pa = form.propertyAddress || {};
    return buildStudioState({
      borrowerName: form.entityName || '',
      address: pa.oneLine || '',
      state: pa.state || '',
      loanType: form.loanType, program: form.program,
      propertyType: form.propertyType, units: form.units,
      purchasePrice: form.purchasePrice, isAssignment: form.isAssignment,
      underlyingContractPrice: form.underlyingContractPrice, assignmentFee: form.assignmentFee,
      asIsValue: form.asIsValue, arv: form.arv, rehabBudget: form.rehabBudget, rehabType: form.rehabType,
      fico: (form.personal || {}).fico,
      expFlips: form.requestedExpFlips, expHolds: form.requestedExpHolds, expGround: form.requestedExpGround,
      termMonths: form.termMonths, irMonths: form.irMonths, irAmount: form.irAmount,
    });
    // rebuilt on entering the step — inside it, the studio is the editor
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step, form == null]);

  // The application is ALREADY submitted by the time step 4 renders — this
  // only registers the product on it (the last, skippable step).
  const regGate = useSubmitGate();
  async function registerProduct() {
    const target = appIdRef.current;
    if (!target) { setErr('The application has not finished submitting — one moment.'); return; }
    const s = studioRef.current && studioRef.current.snapshot();
    if (!s) { setErr('The Term Sheet Studio is still loading — one moment.'); return; }
    if (!s.ready) { setErr('Complete the required pricing fields first: ' + s.missing.join(', ')); return; }
    if (!s.program) { setErr('Tap the Standard or Gold Standard card above to choose your product, then register.'); return; }
    const d = s.d;
    if (!d || d.status === 'INELIGIBLE' || !(d.totalLoan > 0)) {
      setErr("This scenario isn't eligible as entered — adjust the deal above, or finish later and price it with your loan team.");
      return;
    }
    if (!regGate.enter()) return;          // a registration is already in flight
    setErr(''); setBusy(true);
    try {
      // the EXACT term sheet the static studio exports (best-effort)
      let pdf = null;
      try { pdf = await studioRef.current.capturePdf(); } catch (_) { /* offline */ }
      const overrides = {
        targetLTC: (d.inp && d.inp.targetLTC) || undefined,
        irMonths: s.fields.irMonths || 0,
        irAmount: s.fields.irAmount || 0,
        term: s.fields.tsTerm,
        fico: s.fields.fico,
        expFlips: s.fields.expFlips, expHolds: s.fields.expBrrrr, expGround: s.fields.expGround,
      };
      if (adminKey) {
        // Admin-unlocked pricing: carry the studio's fee/markup/manual knobs.
        Object.assign(overrides, {
          markupStdPct: s.fields.tsYspStd, markupGoldPct: s.fields.tsYspGold,
          origStdPct: s.fields.tsOrigStd, origGoldPct: s.fields.tsOrigGold,
          lenderFee: s.fields.tsFeeUW, creditFee: s.fields.tsFeeCredit,
          appraisalFee: s.fields.tsFeeAppr, titleFee: s.fields.tsFeeTitle,
          manualPricing: !!s.fields.tsManualOn,
          ovrAcqLTVPct: s.fields.tsManualOn ? s.fields.tsMLtv : undefined,
          ovrARLTVPct: s.fields.tsManualOn ? s.fields.tsMArv : undefined,
          ovrLTCPct: s.fields.tsManualOn ? s.fields.tsMLtc : undefined,
          ovrRatePct: s.fields.tsManualOn ? s.fields.tsMRate : undefined,
          ovrIrMonths: s.fields.tsManualOn ? s.fields.tsMIr : undefined,
        });
      }
      await api.borrowerRegisterProduct(target, s.program, overrides, adminKey || undefined);
      if (pdf && pdf.blob) {
        try {
          const dataBase64 = await blobToBase64(pdf.blob);
          await api.uploadDoc({ applicationId: target, filename: pdf.filename, contentType: 'application/pdf', dataBase64, docKind: 'term_sheet' });
        } catch (_) { /* sheet can be re-generated from the file page */ }
      }
      nav(`/app/${target}`);
    } catch (e) {
      const detail = e.data && e.data.reasons ? e.data.reasons.map((r) => r.msg).join(' ') : (e.message || 'Could not register');
      setErr(detail); setBusy(false); regGate.leave();
    }
  }

  function unlockAdminPricing() {
    if (adminKey) { setAdminKey(''); return; }
    const pw = window.prompt('Admin mode — enter the pricing admin password:');
    if (pw == null) return;
    // same soft gate as the static Term Sheet tool (cyrb53 hash)
    let h1 = 0xdeadbeef, h2 = 0x41c6ce57;
    for (let i = 0, ch; i < pw.length; i++) {
      ch = pw.charCodeAt(i);
      h1 = Math.imul(h1 ^ ch, 2654435761);
      h2 = Math.imul(h2 ^ ch, 1597334677);
    }
    h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507); h1 ^= Math.imul(h2 ^ (h2 >>> 13), 3266489909);
    h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507); h2 ^= Math.imul(h1 ^ (h1 >>> 13), 3266489909);
    if (4294967296 * (2097151 & h2) + (h1 >>> 0) === 6019969998889003) setAdminKey(pw);
    else setErr('Incorrect admin password.');
  }

  if (err && !form) return <div role="alert" className="notice err">{err}</div>;
  if (!form) return <div className="panel muted">Loading your application…</div>;
  const a = form.propertyAddress || {};
  const showRehab = needsRehab(form.program);
  const step1Ready = !!a.street && !!form.propertyType && !!form.units;
  // Required-field highlighting (#12). Only step 1 has hard-required fields;
  // errCls turns them red once the borrower has tried to advance/submit, and
  // each clears itself the moment its field is filled.
  const reqEmpty = { street: !a.street, propertyType: !form.propertyType, units: !form.units };
  const errCls = (k) => (showErrors && reqEmpty[k]) ? ' input-err' : '';
  const onContinue = () => {
    // Non-blocking: highlight what's still needed but let the borrower keep
    // going and finish it before submitting. Submit (step 4) enforces it.
    if (step === 1 && (reqEmpty.street || reqEmpty.propertyType || reqEmpty.units)) setShowErrors(true);
    goStep(step + 1);
  };

  return (
    <>
      <div className="row" style={{ marginBottom: 14 }}>
        <div><h1>New application</h1></div>
        <div className="spacer" />
        <SaveChip status={status} />
      </div>

      <div className="stepper">
        {STEPS.map((s, i) => (
          <div key={s} className={`step ${step === i + 1 ? 'active' : ''} ${step > i + 1 ? 'done' : ''}`}
            onClick={() => goStep(i + 1)} style={{ cursor: 'pointer' }}>
            {step > i + 1 ? '✓ ' : `${i + 1}. `}{s}
          </div>
        ))}
      </div>

      {err && <div role="alert" className="notice err">{err}</div>}

      {/* autoComplete off on the whole form so the browser never treats the
          subject-property address as the applicant's own contact card. */}
      <form className="panel" autoComplete="off" onSubmit={e => e.preventDefault()}>
        {step === 1 && (
          <>
            <h3 style={{ marginBottom: 14 }}>Subject property</h3>
            <div className="field"><label>Street address *</label>
              <AddressAutocomplete value={a.street || ''} className={'input' + errCls('street')} placeholder="Start typing the property address…"
                onChange={v => setAddr('street', v)} onPick={pickAddr} /></div>
            <div className="grid cols-2">
              <div className="field"><label>Apt / Unit</label>
                <input className="input" autoComplete="off" value={a.unit || ''} onChange={e => setAddr('unit', e.target.value)} placeholder="Optional" /></div>
              <div className="field"><label>City</label>
                <input className="input" autoComplete="off" value={a.city || ''} onChange={e => setAddr('city', e.target.value)} /></div>
            </div>
            <div className="grid cols-2">
              <div className="field"><label>State</label>
                <input className="input" autoComplete="off" maxLength={2} value={a.state || ''} onChange={e => setAddr('state', e.target.value.toUpperCase())} placeholder="NY" /></div>
              <div className="field"><label>ZIP</label>
                <input className="input" autoComplete="off" value={a.zip || ''} onChange={e => setAddr('zip', e.target.value)} /></div>
            </div>
            <div className="grid cols-2">
              <div className="field"><label>Property type *</label>
                <select className={'input' + errCls('propertyType')} value={form.propertyType || ''} onChange={e => setPropertyType(e.target.value)}>
                  <option value="">Select…</option>{PROP_TYPES.map(p => <option key={p}>{p}</option>)}
                </select></div>
              {unitsMode(form.propertyType) === 'select24' && (
                <div className="field"><label>Number of units *</label>
                  <select className={'input' + errCls('units')} value={form.units || ''} onChange={e => set('units', e.target.value)}>
                    <option value="">Select…</option><option>2</option><option>3</option><option>4</option>
                  </select></div>
              )}
              {unitsMode(form.propertyType) === 'multi' && (
                <div className="field"><label>Number of units *</label>
                  <input className={'input' + errCls('units')} type="number" min="5" value={form.units || ''} onChange={e => set('units', e.target.value)} placeholder="5 or more" /></div>
              )}
              {unitsMode(form.propertyType) === 'single' && form.propertyType && (
                <div className="field"><label>Number of units</label>
                  <input className="input" value="1 unit" disabled readOnly /></div>
              )}
            </div>
            {!step1Ready && <p className={showErrors ? 'small' : 'muted small'} style={showErrors ? { color: 'var(--danger)', marginTop: 4 } : undefined}>
              Property address and type{unitsMode(form.propertyType) !== 'single' ? ', plus the number of units,' : ''} are required before you submit — you can still fill the other sections first.</p>}
          </>
        )}

        {step === 2 && (
          <>
            <h3 style={{ marginBottom: 14 }}>Loan details</h3>
            <div className="grid cols-2">
              <div className="field"><label>Program</label>
                <select className="input" value={form.program || ''} onChange={e => set('program', e.target.value)}>
                  <option value="">Select…</option>{PROGRAMS.map(p => <option key={p}>{p}</option>)}
                </select></div>
              <div className="field"><label>Loan type</label>
                <select className="input" value={form.loanType || ''} onChange={e => set('loanType', e.target.value)}>
                  <option value="">Select…</option>{LOAN_TYPES.map(p => <option key={p}>{p}</option>)}
                </select></div>
            </div>
            {/* Purchase → purchase price. Refinance → the purchase price falls
                away; payoff + original purchase + date acquired come up
                (ported from the static loan application). */}
            {!isRefi(form.loanType) ? (
              <div className="grid cols-2">
                <div className="field"><label>Purchase price</label>
                  <MoneyInput value={form.purchasePrice || ''} onChange={v => set('purchasePrice', v)} /></div>
                <div className="field"><label>As-is value</label>
                  <MoneyInput value={form.asIsValue || ''} onChange={v => set('asIsValue', v)} /></div>
              </div>
            ) : (
              <>
                <div className="grid cols-3">
                  <div className="field"><label>Current loan payoff</label>
                    <MoneyInput value={form.payoffAmount || ''} onChange={v => set('payoffAmount', v)} /></div>
                  <div className="field"><label>Original purchase price</label>
                    <MoneyInput value={form.originalPurchasePrice || ''} onChange={v => set('originalPurchasePrice', v)} /></div>
                  <div className="field"><label>Date acquired</label>
                    <input className="input" type="date" value={form.acquisitionDate || ''} onChange={e => set('acquisitionDate', e.target.value)} /></div>
                </div>
                <div className="grid cols-2">
                  <div className="field"><label>As-is value *</label>
                    <MoneyInput value={form.asIsValue || ''} onChange={v => set('asIsValue', v)} /></div>
                </div>
                <p className="muted small" style={{ marginBottom: 12 }}>
                  On a refinance we lend against the property's current (as-is) value; the payoff tells us
                  what needs to be retired at closing{/cash/i.test(form.loanType || '') ? ' — anything above it is your cash-out' : ''}.
                </p>
              </>
            )}
            {isPurchase(form.loanType) && (
              <label style={{ display: 'flex', gap: 8, alignItems: 'center', cursor: 'pointer', margin: '2px 0 12px' }}>
                <input type="checkbox" checked={!!form.isAssignment} onChange={e => set('isAssignment', e.target.checked)} />
                <span>This purchase is an <strong>assignment</strong> of contract</span>
              </label>
            )}
            {form.isAssignment && (
              <>
                <div className="grid cols-2">
                  <div className="field"><label>Underlying contract price</label>
                    <MoneyInput value={form.underlyingContractPrice || ''} onChange={v => set('underlyingContractPrice', v)} /></div>
                  <div className="field"><label>Assignment fee</label>
                    <MoneyInput value={form.assignmentFee || ''} onChange={v => set('assignmentFee', v)} /></div>
                </div>
                <p className="muted small" style={{ marginBottom: 12 }}>
                  Total purchase price: <strong>{money((Number(form.underlyingContractPrice) || 0) + (Number(form.assignmentFee) || 0))}</strong>.
                  We'll ask for the <strong>assignment contract</strong> and the <strong>underlying purchase contract</strong> on your file.
                </p>
              </>
            )}
            {showRehab && (
              <>
                <div className="grid cols-2">
                  <div className="field"><label>ARV (after-repair value)</label>
                    <MoneyInput value={form.arv || ''} onChange={v => set('arv', v)} /></div>
                  <div className="field"><label>Rehab budget</label>
                    <MoneyInput value={form.rehabBudget || ''} onChange={v => set('rehabBudget', v)} /></div>
                </div>
                <div className="grid cols-2">
                  <div className="field"><label>Rehab type</label>
                    <select className="input" value={form.rehabType || ''} onChange={e => set('rehabType', e.target.value)}>
                      <option value="">Select...</option>{REHAB_TYPES.map(x => <option key={x}>{x}</option>)}
                    </select>
                    {form.rehabType && REHAB_TYPE_INFO[form.rehabType] &&
                      <p className="muted small" style={{ marginTop: 6 }}>{REHAB_TYPE_INFO[form.rehabType]}</p>}
                    <details style={{ marginTop: 6 }}>
                      <summary className="small" style={{ cursor: 'pointer', color: 'var(--teal-br)' }}>Not sure? What each option means</summary>
                      <ul className="muted small" style={{ margin: '6px 0 0', paddingLeft: 18 }}>
                        {REHAB_TYPES.map(x => <li key={x} style={{ marginBottom: 4 }}><strong style={{ color: 'var(--ivory)' }}>{x}:</strong> {REHAB_TYPE_INFO[x]}</li>)}
                      </ul>
                    </details>
                  </div>
                  {needsSqft(form.rehabType) && (
                    <div className="grid cols-2" style={{ margin: 0 }}>
                      <div className="field"><label>Existing sq ft</label>
                        <input className="input" type="number" min="0" value={form.sqftPre || ''} onChange={e => set('sqftPre', e.target.value)} /></div>
                      <div className="field"><label>Completed sq ft</label>
                        <input className="input" type="number" min="0" value={form.sqftPost || ''} onChange={e => set('sqftPost', e.target.value)} /></div>
                    </div>
                  )}
                </div>
              </>
            )}
            <h3 style={{ margin: '14px 0 8px' }}>Experience used for this request</h3>
            <p className="muted small" style={{ marginBottom: 8 }}>Prefilled from your track record — adjust if needed.</p>
            <div className="grid cols-2">
              <div className="field"><label>Fix &amp; flip deals</label>
                <input className="input" type="number" min="0" value={form.requestedExpFlips || ''} onChange={e => set('requestedExpFlips', e.target.value)} /></div>
              <div className="field"><label>Fix &amp; hold deals</label>
                <input className="input" type="number" min="0" value={form.requestedExpHolds || ''} onChange={e => set('requestedExpHolds', e.target.value)} /></div>
              <div className="field"><label>Ground-up deals</label>
                <input className="input" type="number" min="0" value={form.requestedExpGround || ''} onChange={e => set('requestedExpGround', e.target.value)} /></div>
              <div className="field"><label>Rental / REO properties owned now</label>
                <input className="input" type="number" min="0" value={form.requestedExpReo || ''} onChange={e => set('requestedExpReo', e.target.value)} /></div>
            </div>
            <p className="muted small">Final pricing and leverage are confirmed by your loan officer against program guidelines — these figures start the file.</p>
          </>
        )}

        {step === 3 && (
          <>
            <h3 style={{ marginBottom: 4 }}>Your information</h3>
            <p className="muted small" style={{ marginBottom: 12 }}>
              Pulled from your profile where we have it — anything you add here is saved to your
              profile automatically, so you never fill it twice.
            </p>
            {(() => { const p = form.personal || {}; return (
              <>
                <div className="grid cols-2">
                  <div className="field"><label>Cell phone</label>
                    <PhoneInput value={p.cellPhone || ''} onChange={v => setPersonal('cellPhone', v)} /></div>
                  <div className="field"><label>Date of birth</label>
                    <input className="input" type="date" value={p.dateOfBirth || ''} onChange={e => setPersonal('dateOfBirth', e.target.value)} /></div>
                </div>
                <div className="grid cols-3">
                  <div className="field"><label>Social Security Number</label>
                    <input className="input" autoComplete="off" value={form.ssn || ''} onChange={e => set('ssn', e.target.value)}
                      placeholder={form.ssnOnFile ? 'On file — leave blank' : '•••-••-••••'} /></div>
                  <div className="field"><label>Estimated FICO</label>
                    <input className="input" type="number" min="300" max="850" value={p.fico || ''} onChange={e => setPersonal('fico', e.target.value)} placeholder="e.g. 720" /></div>
                  <div className="field"><label>Citizenship</label>
                    <select className="input" value={p.citizenship || ''} onChange={e => setPersonal('citizenship', e.target.value)}>
                      <option value="">Select…</option>{CITIZENSHIP.map(c => <option key={c}>{c}</option>)}
                    </select></div>
                </div>
                <div className="grid cols-2">
                  <div className="field"><label>Marital status</label>
                    <select className="input" value={p.maritalStatus || ''} onChange={e => setPersonal('maritalStatus', e.target.value)}>
                      <option value="">Select...</option>{MARITAL.map(c => <option key={c}>{c}</option>)}
                    </select></div>
                  <div className="field"><label>Housing status</label>
                    <select className="input" value={p.housingStatus || ''} onChange={e => setPersonal('housingStatus', e.target.value)}>
                      <option value="">Select...</option>{HOUSING.map(c => <option key={c}>{c}</option>)}
                    </select></div>
                </div>
                <h3 style={{ margin: '16px 0 10px' }}>Primary residence</h3>
                <div className="field"><label>Home address</label>
                  <AddressAutocomplete value={(p.currentAddress && p.currentAddress.street) || ''} placeholder="Start typing your home address..."
                    onChange={v => setPersonalAddr('street', v)} onPick={pickPersonalAddr} /></div>
                <div className="grid cols-2">
                  <div className="field"><label>Apt / Unit</label>
                    <input className="input" autoComplete="off" value={(p.currentAddress && p.currentAddress.unit) || ''} onChange={e => setPersonalAddr('unit', e.target.value)} /></div>
                  <div className="field"><label>City</label>
                    <input className="input" autoComplete="off" value={(p.currentAddress && p.currentAddress.city) || ''} onChange={e => setPersonalAddr('city', e.target.value)} /></div>
                </div>
                <div className="grid cols-3">
                  <div className="field"><label>State</label>
                    <input className="input" maxLength={2} value={(p.currentAddress && p.currentAddress.state) || ''} onChange={e => setPersonalAddr('state', e.target.value.toUpperCase())} /></div>
                  <div className="field"><label>ZIP</label>
                    <input className="input" value={(p.currentAddress && p.currentAddress.zip) || ''} onChange={e => setPersonalAddr('zip', e.target.value)} /></div>
                  <div className="field"><label>Housing payment</label>
                    <MoneyInput value={p.housingPayment || ''} onChange={v => setPersonal('housingPayment', v)} /></div>
                </div>
                <div className="grid cols-2">
                  <div className="field"><label>Years at address</label>
                    <input className="input" type="number" min="0" step="0.1" value={p.yearsAtResidence || ''} onChange={e => setPersonal('yearsAtResidence', e.target.value)} /></div>
                  <div className="field"><label>Additional months</label>
                    <input className="input" type="number" min="0" max="11" value={p.monthsAtResidence || ''} onChange={e => setPersonal('monthsAtResidence', e.target.value)} /></div>
                </div>
              </>
            ); })()}

            <div className="row" style={{ margin: '18px 0 6px', alignItems: 'center' }}>
              <h3 style={{ margin: 0 }}>Co-borrower</h3>
              <span className="muted small">(optional)</span>
              <div className="spacer" />
              <label style={{ display: 'flex', gap: 8, alignItems: 'center', cursor: 'pointer' }}>
                <input type="checkbox" checked={!!form.hasCoBorrower} onChange={e => set('hasCoBorrower', e.target.checked)} />
                <span className="small">Add a co-borrower</span>
              </label>
            </div>
            {form.hasCoBorrower && (() => { const c = form.coBorrower || {}; return (
              <>
                {partners.length > 0 && (
                  <div className="row" style={{ gap: 6, flexWrap: 'wrap', marginBottom: 8 }}>
                    <span className="muted small">Reuse a partner:</span>
                    {partners.map(pt => (
                      <button key={pt.id} type="button" className="btn ghost small"
                        onClick={() => setForm(f => { const co = { firstName: pt.first_name || '', lastName: pt.last_name || '', email: pt.email || '', phone: pt.phone || '' }; save({ data: { coBorrower: co } }); return { ...(f || {}), coBorrower: co }; })}>
                        {[pt.first_name, pt.last_name].filter(Boolean).join(' ') || pt.email}
                      </button>
                    ))}
                  </div>
                )}
                <p className="muted small" style={{ marginBottom: 12 }}>
                  We'll email them an invitation to join this loan in PILOT — they can add their own
                  personal information and upload their documents themselves.
                </p>
                <div className="grid cols-2">
                  <div className="field"><label>First name</label>
                    <input className="input" autoComplete="off" value={c.firstName || ''} onChange={e => setCo('firstName', e.target.value)} /></div>
                  <div className="field"><label>Last name</label>
                    <input className="input" autoComplete="off" value={c.lastName || ''} onChange={e => setCo('lastName', e.target.value)} /></div>
                </div>
                <div className="grid cols-2">
                  <div className="field"><label>Email</label>
                    <input className="input" autoComplete="off" value={c.email || ''} onChange={e => setCo('email', e.target.value)} placeholder="They'll receive a PILOT invitation" /></div>
                  <div className="field"><label>Phone</label>
                    <PhoneInput value={c.phone || ''} onChange={v => setCo('phone', v)} /></div>
                </div>
              </>
            ); })()}

            <h3 style={{ margin: '18px 0 14px' }}>Entity &amp; officer</h3>
            <div className="field"><label>Vesting entity / LLC (if any)</label>
              <LlcPicker value={form.entityName || ''} placeholder="e.g. 1420 Bedford Holdings LLC"
                onPick={({ id, name }) => setForm(f => { const next = { ...(f || {}), entityName: name, llcId: id }; save({ data: { entityName: name, llcId: id } }); return next; })} />
              <p className="muted small" style={{ marginTop: 4 }}>Reuse an LLC you've used before, or create a new one — we'll ask for its EIN letter, formation docs, and operating agreement once.</p></div>
            {(() => {
              // Explicit officer question. OFF (default) → file routes to the
              // Lead Capture desk; the backend keys routing off a blank officer,
              // so "No" clears any prior pick. The answer persists on the draft.
              const worksWithOfficer = form.worksWithOfficer != null ? !!form.worksWithOfficer : !!form.loanOfficerName;
              const setYes = () => { setForm(f => ({ ...(f || {}), worksWithOfficer: true })); save({ data: { worksWithOfficer: true } }); };
              const setNo = () => {
                setForm(f => ({ ...(f || {}), worksWithOfficer: false, loanOfficerName: '', loanOfficerEmail: '' }));
                save({ data: { worksWithOfficer: false, loanOfficerName: '', loanOfficerEmail: '' } });
              };
              return (
                <>
                  <div className="field"><label>Do you already work with a specific loan officer?</label>
                    <div className="row" style={{ gap: 8, marginTop: 4, flexWrap: 'wrap' }}>
                      <button type="button" className={`btn ${worksWithOfficer ? 'primary' : 'ghost'} small`} onClick={setYes}>Yes, I have an officer</button>
                      <button type="button" className={`btn ${!worksWithOfficer ? 'primary' : 'ghost'} small`} onClick={setNo}>No — assign one for me</button>
                    </div>
                  </div>
                  {worksWithOfficer && (
                    <div className="field"><label>Requested loan officer</label>
                      <select className="input" value={form.loanOfficerName || ''} onChange={e => pickOfficer(e.target.value)}>
                        <option value="">Select your loan officer…</option>
                        {officers.map(o => <option key={o.email || o.name} value={o.name}>{o.name}{o.title ? ` — ${o.title}` : ''}</option>)}
                      </select></div>
                  )}
                  <p className="muted small">
                    {worksWithOfficer
                      ? 'We’ll route your file straight to your officer.'
                      : 'Your file will go to our Lead Capture desk for prompt assignment.'}
                  </p>
                </>
              );
            })()}
            <div className="panel" style={{ background: 'var(--ink-2)', marginTop: 8 }}>
              <div className="metrow"><span className="k">Property</span><span className="v">{a.oneLine || '—'}</span></div>
              <div className="metrow"><span className="k">Program</span><span className="v">{form.program || '—'}</span></div>
              <div className="metrow"><span className="k">Loan type</span><span className="v">{form.loanType || '—'}</span></div>
            </div>
          </>
        )}

        {step === 4 && (
          <>
            <h3 style={{ marginBottom: 4 }}>Price your deal & register your product</h3>
            {appId && (
              <div className="notice ok" style={{ marginBottom: 10 }}>
                Your application is <strong>submitted</strong> — your loan team has it already.
                Registering a product is the last step; skip it and it stays open as a condition
                on your file, with a link to come back here.
              </div>
            )}
            <p className="muted small" style={{ marginBottom: 12 }}>
              This is the live YS Term Sheet Studio, prefilled from your application — the same
              guidelines, limits and pricing as our public tool. Adjust anything, compare the
              Standard and Gold Standard programs, choose your leverage, then tap a program card
              and register: your loan amount, structure, cash to close, liquidity requirement and
              the signable term sheet PDF are all saved onto your loan file.
            </p>
            <TermSheetStudio key={adminKey ? 'admin' : 'std'} ref={studioRef} prefill={studioPrefill}
              lockedIds={STUDIO_LOCKED} onState={onStudioState} showAdmin={!!adminKey} />
          </>
        )}

        <div className="row" style={{ marginTop: 18, flexWrap: 'wrap', gap: 8 }}>
          {step > 1 && <button className="btn ghost" type="button" onClick={() => goStep(step - 1)}>Back</button>}
          <div className="spacer" />
          <SaveChip status={status} />
          {step < 4 && (
            <button className="btn primary" type="button" onClick={onContinue} disabled={busy}>
              {step === 3 ? (busy ? 'Submitting…' : 'Submit & continue to Products & Pricing') : 'Continue'}
            </button>
          )}
          {step === 4 && (
            <>
              <button className="btn ghost" type="button" onClick={finishLater} disabled={!appId}
                title="Your application is already submitted — register the product later from your file.">
                Finish later — go to my file
              </button>
              <button className="btn primary" type="button" onClick={registerProduct} disabled={busy || !appId}>
                {busy ? 'Registering…' : 'Register this product'}
              </button>
            </>
          )}
        </div>
        {step === 4 && (
          <p className="muted small" style={{ marginTop: 8 }}>
            {snap && !snap.ready ? `Still needed to price: ${snap.missing.join(', ')}.`
              : snap && !snap.program ? 'Tap the Standard or Gold Standard card above to open your product.'
              : snap && snap.d && snap.d.totalLoan > 0 ? `Selected: ${snap.program === 'gold' ? 'Gold Standard' : 'Standard'} · ${'$' + Math.round(snap.d.totalLoan).toLocaleString('en-US')} @ ${snap.d.rate ? snap.d.rate.toFixed(2) + '%' : '—'} · cash to close ${'$' + Math.round(snap.d.cashToClose).toLocaleString('en-US')} · liquidity to show ${'$' + Math.round(snap.d.liquidity).toLocaleString('en-US')}`
              : ''}
          </p>
        )}
      </form>
    </>
  );
}
