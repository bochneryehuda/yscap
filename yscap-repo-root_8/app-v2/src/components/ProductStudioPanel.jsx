import React, { forwardRef, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react';
import { api } from '../lib/api.js';
import { useSubmitGate } from '../lib/useSubmitGate.js';
import TermSheetStudio, {
  buildStudioState, scenarioFromEngineInputs, adminStateFromEngineInputs, blobToBase64,
} from './TermSheetStudio.jsx';

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
const statusWord = (st) => (st === 'MANUAL' ? 'manual review' : st === 'INELIGIBLE' ? 'not eligible' : String(st || '').toLowerCase());

function addrLine(a) {
  if (!a) return '';
  if (typeof a === 'string') return a;
  if (a.oneLine) return a.oneLine;
  return [a.line1 || a.street, a.city, a.state, a.zip].filter(Boolean).join(', ');
}

/* Admin-mode soft gate — the SAME password gate the static Term Sheet tool
   carries (cyrb53 hash check). Unlocking reveals the studio's admin pricing
   zone (markups, origination, fee overrides, manual basis); the password is
   ALSO sent with the registration so the server honors those overrides. */
function cyrb53(str, seed = 0) {
  let h1 = 0xdeadbeef ^ seed, h2 = 0x41c6ce57 ^ seed;
  for (let i = 0, ch; i < str.length; i++) {
    ch = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507); h1 ^= Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507); h2 ^= Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return 4294967296 * (2097151 & h2) + (h1 >>> 0);
}
const ADMIN_HASH = 6019969998889003; // matches web/tools/termsheet.js

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
export function overridesFromSnapshot(snap, mode) {
  const f = snap.fields;
  const d = snap.d || {};
  const base = {
    ...compact({
      targetLTC: d.inp && d.inp.targetLTC ? d.inp.targetLTC : null,
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
      origStdPct: f.tsOrigStd, origGoldPct: f.tsOrigGold,
      lenderFee: f.tsFeeUW, creditFee: f.tsFeeCredit, appraisalFee: f.tsFeeAppr,
      titleFee: f.tsFeeTitle,
      ovrAcqLTVPct: f.tsManualOn ? f.tsMLtv : null,
      ovrARLTVPct: f.tsManualOn ? f.tsMArv : null,
      ovrLTCPct: f.tsManualOn ? f.tsMLtc : null,
      ovrRatePct: f.tsManualOn ? f.tsMRate : null,
      ovrIrMonths: f.tsManualOn ? f.tsMIr : null,
    }),
    cashOut: /cash/i.test(f.dealPurpose || ''),
    isAssignment: !!f.isAssign,
    heavyRehab: f.rehabScope === 'heavy',
    sqftAddition: !!f.sqft,
    manualPricing: !!f.tsManualOn,
    // Markup: an EXPLICITLY blanked field sends '' — the server drops the
    // sticky per-file markup and prices at the company default (root-caused
    // 2026-07-16: compact() omitted it, so the old sticky silently re-applied).
    // An untouched/absent field still sends nothing.
    ...(f.tsYspStd === '' ? { markupStdPct: '' } : f.tsYspStd != null ? { markupStdPct: f.tsYspStd } : {}),
    ...(f.tsYspGold === '' ? { markupGoldPct: '' } : f.tsYspGold != null ? { markupGoldPct: f.tsYspGold } : {}),
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
  const caps = (q.guidelines && q.guidelines.caps) || null;
  const Row = ({ k, v }) => <div className="metrow"><span className="k">{k}</span><span className="v">{v}</span></div>;
  return (
    <div className={compactView ? '' : 'panel'} style={compactView ? {} : { background: 'var(--ink-2)', marginTop: 10 }}>
      <div className="row" style={{ alignItems: 'baseline', gap: 8, marginBottom: 8 }}>
        <strong>{q.programLabel || (reg.program === 'gold' ? 'Gold Standard Program' : 'Standard Program')}</strong>
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
      <div className="grid cols-2">
        <div>
          <p className="muted small" style={{ margin: '0 0 4px', textTransform: 'uppercase', letterSpacing: '.06em' }}>Loan structure</p>
          <Row k="Total loan amount" v={money(s.totalLoan ?? reg.total_loan)} />
          <Row k="Note rate (interest-only)" v={pct(q.noteRate ?? reg.note_rate)} />
          <Row k="Initial advance (at closing)" v={money(s.initialAdvance)} />
          <Row k="Construction holdback" v={money(s.rehabHoldback)} />
          {s.financedReserve > 0 && <Row k="Financed interest reserve" v={money(s.financedReserve)} />}
          <Row k="Down payment (equity)" v={money(s.downPayment)} />
          {s.assignmentExcessOOP > 0 && <Row k="Assignment over cap (out of pocket)" v={money(s.assignmentExcessOOP)} />}
          <Row k="Payment — initial advance" v={s.initialPayment ? money(s.initialPayment) + '/mo' : '—'} />
          <Row k="Payment — fully drawn" v={s.monthlyPayment ? money(s.monthlyPayment) + '/mo' : '—'} />
          <Row k="Term" v={inp.term ? inp.term + ' months' : '—'} />
          <p className="muted small" style={{ margin: '10px 0 4px', textTransform: 'uppercase', letterSpacing: '.06em' }}>Leverage</p>
          <Row k="Loan-to-cost (LTC)" v={pct(s.ltcPct, 1)} />
          <Row k="Initial / as-is LTV" v={pct(s.acqLtvPct, 1)} />
          <Row k="Loan-to-ARV" v={pct(s.arvPct, 1)} />
          {reg.target_ltc > 0 && <Row k="Selected leverage (LTC target)" v={pct(reg.target_ltc, 1)} />}
          {s.binding && <Row k="Binding limit" v={s.binding} />}
          {caps && <Row k="Program max — LTC / ARV / as-is" v={`${pct(caps.maxLtc, 1)} / ${pct(caps.maxArvLtv, 1)} / ${pct(caps.maxAcqLtv, 1)}`} />}
        </div>
        <div>
          <p className="muted small" style={{ margin: '0 0 4px', textTransform: 'uppercase', letterSpacing: '.06em' }}>Fees & cash to close</p>
          <Row k={`Origination (${q.origPct != null ? (q.origPct * 100).toFixed(3).replace(/\.?0+$/, '') + '%' : '—'})`} v={money2(q.origination)} />
          <Row k="UW / processing / legal" v={money2(cc.lenderFee)} />
          <Row k="Credit report" v={money2(cc.creditFee)} />
          <Row k="Title / escrow (est.)" v={money2(cc.titleAndSettlement)} />
          <Row k="Appraisal (est., POC)" v={money2(cc.appraisalPoc)} />
          <Row k="Closing costs due at closing" v={money2(cc.dueAtClosing)} />
          <Row k="Estimated cash to close" v={<strong>{money2(q.cashToClose)}</strong>} />
          <Row k={`Reserve to show${q.reserveBasis ? ` (${q.reserveBasis})` : ''}`} v={money2(q.reserveRequirement)} />
          <Row k="Liquidity to verify" v={<strong>{money2(q.liquidity ?? q.liquidityRequired)}</strong>} />
          <p className="muted small" style={{ margin: '10px 0 4px', textTransform: 'uppercase', letterSpacing: '.06em' }}>Scenario as registered</p>
          <Row k="Strategy / purpose" v={`${inp.strategy || '—'} · ${inp.loanType || '—'}${inp.cashOut ? ' (cash-out)' : ''}`} />
          <Row k="Purchase price" v={money(inp.purchasePrice)} />
          {inp.isAssignment && <Row k="Seller price / assignment fee" v={`${money(inp.sellerPrice)} / ${money(Math.max(0, (inp.purchasePrice || 0) - (inp.sellerPrice || 0)))}`} />}
          <Row k="As-is value / ARV" v={`${money(inp.asIsValue)} / ${money(inp.arv)}`} />
          <Row k="Rehab budget" v={money(inp.rehabBudget)} />
          <Row k="FICO / experience" v={`${inp.fico || '—'} · ${inp.expFlips || 0} flips / ${inp.expHolds || 0} holds / ${inp.expGround || 0} ground-up`} />
          <Row k="Interest reserve" v={inp.irAmount ? money(inp.irAmount) : `${inp.irMonths || 0} months`} />
          {showAdmin && q.adminPricing && (q.adminPricing.markupPct != null || q.adminPricing.manualPricing) && (
            <Row k="Admin pricing" v={`${q.adminPricing.markupPct != null ? 'markup ' + q.adminPricing.markupPct + '%' : ''}${q.adminPricing.manualPricing ? ' · manual basis' : ''}`.trim()} />
          )}
        </div>
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
  // The admin pricing zone (manual rate/leverage basis, experience overrides)
  // only renders for roles the SERVER will honor (root-caused 2026-07-16,
  // Pinchus Wieder: every other staff role had those knobs silently stripped
  // on register — the studio displayed terms the file never got). Non-admin
  // staff never see knobs their register would now be refused for.
  const staffAdmin = isStaff && ['admin', 'super_admin'].includes(staffRole || '');
  const [data, setData] = useState(null);       // { current, history }
  const [profile, setProfile] = useState(null); // borrower profile (name + fico)
  const [snap, setSnap] = useState(null);       // live studio state
  const [openStudio, setOpenStudio] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [msg, setMsg] = useState('');
  const [adminKey, setAdminKey] = useState('');   // set after a correct admin-mode password (borrower)
  const [adminOpen, setAdminOpen] = useState(false); // is the admin zone VISIBLE right now
  const [savedStudio, setSavedStudio] = useState(undefined);   // undefined = still loading, null = none saved
  const studioRef = useRef(null);
  const sheetBodyRef = useRef(null);
  const studioSaveT = useRef(null);
  const lastStudioSaved = useRef('');
  const stateUrl = toolItemId
    ? `${isStaff ? '/api/staff' : '/api/borrower'}/applications/${appId}/checklist/${toolItemId}/tool-state`
    : null;

  useImperativeHandle(ref, () => ({
    openStudio() { setOpenStudio(true); },
  }), []);

  // Autosave the studio scenario onto the pricing condition (debounced).
  const onStudioState = (s2) => {
    setSnap(s2);
    if (!stateUrl || !s2 || !s2.fields) return;
    const state = studioStateFromFields(s2.fields);
    const key = JSON.stringify(state);
    if (key === lastStudioSaved.current) return;
    clearTimeout(studioSaveT.current);
    studioSaveT.current = setTimeout(() => {
      lastStudioSaved.current = key;
      api.put(stateUrl, { state }).catch(() => { lastStudioSaved.current = ''; });
    }, 1200);
  };
  const adminActive = isStaff || !!adminKey;   // overrides ride along even when the zone is locked shut

  function toggleAdmin() {
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
    const pw = window.prompt('Admin mode — enter the pricing admin password:');
    if (pw == null) return;
    if (cyrb53(pw, 0) === ADMIN_HASH) {
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

  const loadPricing = () => (isStaff ? api.staffPricing(appId) : api.borrowerPricing(appId));

  useEffect(() => {
    let alive = true;
    loadPricing().then((d) => { if (alive) setData(d); })
      .catch((e) => alive && setErr(e.message || 'Could not load product registration'));
    if (stateUrl) api.get(stateUrl).then((d) => alive && setSavedStudio((d && d.state && d.state.v) ? d.state : null)).catch(() => alive && setSavedStudio(null));
    else setSavedStudio(null);
    if (!isStaff) api.profile().then((p) => alive && setProfile(p)).catch(() => {});
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
      if (stateUrl) api.put(stateUrl, { state }).catch(() => { lastStudioSaved.current = ''; });
      setSavedStudio(state);
    }
    setAdminOpen(false);
    setOpenStudio(false);
  }

  const cur = data && data.current;
  const history = (data && data.history) || [];
  const superseded = history.filter((h) => !h.is_current);

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
    // The last working scenario (autosaved) resumes — but the file-owned
    // economics/experience SNAP to the file's CURRENT values first (#148): an
    // autosave made before the file was edited must never carry the old
    // numbers into a re-register. Studio-only work (names, fees, product
    // choice, scenario type) keeps resuming untouched, and a field the FILE
    // doesn't carry keeps the draft's value.
    if (savedStudio && savedStudio.v) {
      const ae = fileEcon();
      const st2 = buildStudioState(ae);
      const v = { ...savedStudio.v };
      const ID_FOR = {
        purchasePrice: 'price', asIsValue: 'asIs', arv: 'arv', rehabBudget: 'construction',
        expFlips: 'expFlips', expHolds: 'expBrrrr', expGround: 'expGround', termMonths: 'tsTerm',
        irMonths: 'irMonths', irAmount: 'irAmount', underlyingContractPrice: 'origPrice',
      };
      for (const [srcKey, id] of Object.entries(ID_FOR)) {
        if (!(srcKey in ae)) continue;               // app column empty → keep the draft
        const val = st2.v[id];
        if (val != null && val !== '') v[id] = val;
      }
      const c = { ...savedStudio.c };
      if ('isAssignment' in ae) c.isAssign = st2.c.isAssign;
      // A pre-fix autosave could carry an invisibly restored manual-pricing
      // flag (the #148 LO-403 poison) — non-admin staff never resume it.
      if (isStaff && !staffAdmin) c.tsManualOn = false;
      return { v, c };
    }
    const name = isStaff
      ? ([app.first_name, app.last_name].filter(Boolean).join(' ') || '')
      : ([profile && profile.first_name, profile && profile.last_name].filter(Boolean).join(' ') || '');
    // #104: the borrowing ENTITY (vesting name) prefills its own slot, separate
    // from the individual borrower name — no longer folded into borrowerName.
    const entity = isStaff ? (app.entity_name || '') : ((profile && profile.entity_name) || '');
    // Co-borrower name (staff view has it on the app) → prefills the term
    // sheet's second signature line (#137).
    const coName = (isStaff && app.co_borrower_id)
      ? ([app.co_first_name, app.co_last_name].filter(Boolean).join(' ') || '')
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
      st = buildStudioState(scenarioFromEngineInputs(inp, { entityName: entity, borrowerName: name, coBorrowerName: coName, address: inp.address || addrLine(app.property_address), ...econFallback(inp), ...fileEcon() }));
      if (isStaff) {
        // Admin knobs restore ONLY for roles the server will honor. The zone is
        // already hidden for non-admin staff (Pinchus), but the RESTORE used to
        // run for all staff — so a previously admin-manual-priced file silently
        // re-armed manualPricing/ovrRate* inside the hidden zone and every LO
        // re-register was refused 403 with a remedy the LO couldn't perform
        // (#148 root). Fees/markups still restore for all staff (the server
        // accepts those and they're the registered fee structure).
        const adm = adminStateFromEngineInputs(inp);
        if (!staffAdmin) {
          for (const k of ['tsMLtv', 'tsMArv', 'tsMLtc', 'tsMRate', 'tsMIr']) delete adm.v[k];
          delete adm.c.tsManualOn;
        }
        st = { v: { ...st.v, ...adm.v }, c: { ...st.c, ...adm.c } };
      }
    } else if (data.quote && data.quote.inputs) {
      // The server already built the exact engine input from the file — use
      // it, but prefer the experience the borrower requested on this file
      // over the verified track-record counts for the what-if display.
      const inp = data.quote.inputs;
      st = buildStudioState(scenarioFromEngineInputs(inp, {
        entityName: entity, borrowerName: name, coBorrowerName: coName,
        address: inp.address || addrLine(app.property_address),
        expFlips: app.requested_exp_flips ?? inp.expFlips,
        expHolds: app.requested_exp_holds ?? inp.expHolds,
        expGround: app.requested_exp_ground ?? inp.expGround,
        fico: inp.fico || (profile && profile.fico) || '',
        ...econFallback(inp),
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
        fico: app.fico || (profile && profile.fico) || '',
        expFlips: app.requested_exp_flips, expHolds: app.requested_exp_holds, expGround: app.requested_exp_ground,
        termMonths: app.term, irMonths: app.requested_ir_months, irAmount: app.requested_ir_amount,
      });
    }
    return st;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data, profile, savedStudio]);

  // Borrowers can price/choose but never change the file's deal economics
  // from here — those change through the loan team. Staff edit everything.
  const lockedIds = useMemo(() => {
    const ids = isStaff ? [] : [
      'propAddr', 'addrTBD', 'propState', 'propType', 'dealPurpose', 'dealType',
      'price', 'isAssign', 'origPrice', 'asIs', 'arv', 'construction', 'rehabScope', 'sqft',
    ];
    // #148: the server strips experience overrides from every non-admin STAFF
    // register (the claim of record prices the deal), so a non-admin staffer
    // editing these fields would see a tier the register won't honor — the
    // exact "studio showed the max-experience loan, the file registered
    // smaller" class. Lock them; the claim is edited on the (audited)
    // application form. Borrowers keep the fields editable — their what-if
    // quoting honors exp (#103) and their register path handles the strip.
    if (isStaff && !staffAdmin) ids.push('expFlips', 'expBrrrr', 'expGround');
    return ids;
  }, [isStaff, staffAdmin]);

  const d = snap && snap.d;
  const canRegister = !!(snap && snap.ready && snap.program && d && d.status !== 'INELIGIBLE' && d.totalLoan > 0);

  const gate = useSubmitGate();
  async function register() {
    const s = studioRef.current && studioRef.current.snapshot();
    if (!s) { setErr('The Term Sheet Studio is still loading.'); return; }
    if (!s.ready) { setErr('Complete the required pricing fields first: ' + s.missing.join(', ')); return; }
    if (!s.program) { setErr('Tap the Standard or Gold Standard card in the studio to choose your product first.'); return; }
    const dd = s.d;
    if (!dd || dd.status === 'INELIGIBLE' || !(dd.totalLoan > 0)) {
      setErr("This scenario isn't eligible as entered — adjust it in the studio, or contact your loan team for a manual review.");
      return;
    }
    if (!gate.enter()) return;             // a registration is already in flight
    setBusy(true); setErr(''); setMsg('');
    try {
      // exact PDF from the static generator (best-effort — registration still proceeds)
      let pdf = null;
      try { pdf = await studioRef.current.capturePdf(); } catch (_) { /* offline */ }
      // Admin-unlocked borrowers price like staff (fee/markup/manual overrides)
      // — the admin key rides along even when the zone is locked shut, so the
      // changes made in admin mode STAY in the registration and the exports.
      const overrides = overridesFromSnapshot(s, adminActive ? 'staff' : mode);
      // econVersion: the file-basis fingerprint this studio session prefilled
      // from — the server refuses (409) if the file's economics moved since,
      // so a stale sheet can never write old numbers back onto the file (#148).
      const econVersion = data && data.econVersion;
      if (isStaff) await api.staffRegisterProduct(appId, s.program, overrides, econVersion);
      else await api.borrowerRegisterProduct(appId, s.program, overrides, adminKey || undefined, econVersion);
      let note = 'Product registered — the loan file now carries these terms, the liquidity requirement and the term sheet.';
      if (pdf && pdf.blob) {
        try {
          const dataBase64 = await blobToBase64(pdf.blob);
          const body = { filename: pdf.filename, contentType: 'application/pdf', dataBase64, docKind: 'term_sheet' };
          if (isStaff) await api.staffUploadAppDoc(appId, body);
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
      } else {
        const detail = e.data && e.data.reasons ? e.data.reasons.map((r) => r.msg).join(' ') : (e.message || 'Could not register');
        setErr(detail);
      }
    } finally { setBusy(false); gate.leave(); }
  }

  const statusLine = snap && !snap.ready ? 'Missing: ' + snap.missing.join(', ')
    : snap && !snap.program ? 'Tap a program card above to choose Standard or Gold Standard.'
    : d && d.totalLoan > 0 ? `${snap.program === 'gold' ? 'Gold Standard' : 'Standard'} · ${money(d.totalLoan)} @ ${d.rate ? d.rate.toFixed(2) + '%' : '—'} · cash to close ${money2(d.cashToClose)} · liquidity ${money2(d.liquidity)}`
    : '';
  // A PLAIN-LANGUAGE reason the product can't be registered yet — shown as a
  // prominent banner in the studio so the Register action never silently
  // "does nothing" (owner-directed 2026-07-12: "it holds you back from
  // registering the product"). The Register button is always clickable (only
  // disabled while busy) so a click also surfaces the specific reason.
  const blockReason = busy ? ''
    : !snap ? 'The Term Sheet Studio is still loading — give it a moment, then register.'
    : !snap.ready ? 'To register, add the required pricing fields: ' + ((snap.missing && snap.missing.join(', ')) || 'see the highlighted fields in the studio') + '.'
    : !snap.program ? 'Choose a product — tap the Standard or Gold Standard card in the studio.'
    : (d && d.status === 'INELIGIBLE') ? "This scenario isn't eligible as entered — adjust it in the studio, or contact your loan team for a manual review."
    : (d && !(d.totalLoan > 0)) ? "This scenario didn't size a loan yet — check the purchase price, ARV / as-is value and rehab budget in the studio."
    : '';

  return (
    <div className="panel" style={{ marginTop: 18 }}>
      <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center' }}>
        <h3 style={{ margin: 0 }}>Product registration & term sheet</h3>
        <div className="row" style={{ gap: 10, alignItems: 'center' }}>
          {cur && <span className="ts-badge ok">Registered · {cur.program === 'gold' ? 'Gold Standard' : 'Standard'} · {money(cur.total_loan)} @ {pct(cur.note_rate)}</span>}
          <button className="btn primary small" onClick={() => setOpenStudio(true)}
            title="Opens the full-screen Term Sheet Studio — everything you enter autosaves to the file; leaving resumes where you left off.">
            {cur ? 'Reprice / re-register' : 'Open Products & Pricing'}
          </button>
        </div>
      </div>

      {err && !openStudio && <div role="alert" className="notice err" style={{ marginTop: 10 }}>{err}</div>}
      {msg && !openStudio && <div className="notice ok" style={{ marginTop: 10 }}>{msg}</div>}
      {/* #148: the current terms carry an admin manual-pricing basis this role
          cannot re-register. Say so UPFRONT — the old behavior silently
          re-armed the admin knobs and refused the register after the fact. */}
      {isStaff && !staffAdmin && cur && (() => {
        try {
          const inp = typeof cur.inputs === 'string' ? JSON.parse(cur.inputs) : (cur.inputs || {});
          return inp.manualPricing ? (
            <div className="notice" style={{ marginTop: 10 }}>
              The current registered terms use an admin manual-pricing basis (negotiated rate/leverage).
              Re-registering under your role prices on the standard engine basis — ask an admin to
              re-register if the negotiated terms must be preserved.
            </div>
          ) : null;
        } catch { return null; }
      })()}

      {!cur && data && (
        <p className="muted small" style={{ margin: '10px 0 0' }}>
          No product registered yet. Price the deal in the Term Sheet Studio, pick Standard or Gold
          Standard and your leverage, then register — the terms, cash to close and liquidity
          requirement all flow onto this file.
        </p>
      )}
      {cur && <RegisteredProductDetails reg={cur} showAdmin={staffAdmin} />}
      {superseded.length > 0 && (
        <p className="muted small" style={{ margin: '8px 0 0' }}>
          {superseded.length} previous registration{superseded.length === 1 ? '' : 's'} on this file (superseded):{' '}
          {superseded.map((h) => `${h.program === 'gold' ? 'Gold' : 'Standard'} ${money(h.total_loan)} @ ${pct(h.note_rate)} on ${when(h.created_at)}`).join(' · ')}
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
            {cur && <span className="ts-badge ok" style={{ marginRight: 4 }}>Registered · {money(cur.total_loan)} @ {pct(cur.note_rate)}</span>}
            <button className="btn primary toolsheet-done" disabled={busy} onClick={register}>
              {busy ? 'Registering…' : cur ? 'Re-register this product' : 'Register this product'}
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
              {prefill
                ? <TermSheetStudio ref={studioRef} prefill={prefill} lockedIds={lockedIds}
                    showAdmin={staffAdmin} onState={onStudioState} />
                : <p className="muted small">Loading your scenario…</p>}
              <div className="toolsheet-actions">
                <button className="btn primary" disabled={busy} onClick={register}>
                  {busy ? 'Registering…' : cur ? 'Re-register this product' : 'Register this product'}
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
