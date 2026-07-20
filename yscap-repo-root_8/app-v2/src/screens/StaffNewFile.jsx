import React, { useEffect, useRef, useState } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import { api } from '../lib/api.js';
import { useAuth } from '../lib/auth.jsx';
import AddressAutocomplete from '../components/AddressAutocomplete.jsx';
import LlcPicker from '../components/LlcPicker.jsx';
import { MoneyInput, PhoneInput, ZipInput , EmailInput} from '../components/FormattedInputs.jsx';
import { unitsMode, unitsForType } from '../lib/enums.js';

/* Staff-side file origination. An admin, loan officer, or operations user opens
   a mortgage file from their end — the borrower does NOT need to be signed up.
   We match-or-create the borrower by email, create the application + checklist,
   assign the team, and (optionally) invite the borrower to the portal for this
   specific file right away. */

// Ground-Up is a PROGRAM, never a loan type/purpose (a loan type is Purchase or
// Refinance). It was wrongly listed under LOAN_TYPES here — the only such list in
// the app — which let a file be created with loan_type='Ground up', mis-pricing it
// (pricing keys Purchase vs Refinance off loan_type). Program label is the
// canonical hyphenated 'Ground-Up Construction' so the ClickUp crosswalk + every
// exact-match consumer recognize it. (#95)
const PROGRAMS = ['Fix & Flip w/ Construction', 'Bridge', 'Ground-Up Construction', 'DSCR Rental', 'Not sure yet'];
const LOAN_TYPES = ['Purchase', 'Refinance — Rate & Term', 'Refinance — Cash-Out'];
const PROP_TYPES = ['SFR (1 unit)', 'Multi 2–4', 'Multi 5+', 'Condo', 'Townhouse', 'Mixed use'];

const REHAB_TYPES = ['Cosmetic', 'Moderate', 'Heavy / gut rehab', 'Adding square footage', 'Ground-up construction'];
const needsSqft = (rehabType) => /square|adding|ground/i.test(rehabType || '');

const numOrNull = (v) => (v === '' || v == null) ? null : Number(String(v).replace(/[^0-9.]/g, '')) || null;

// This new-file form auto-saves as the officer types (no Save button): the
// in-progress state is persisted to localStorage on every change and restored on
// mount, so nothing typed is ever lost to a refresh or navigation. It is cleared
// the moment the file is successfully created.
const DRAFT_KEY = 'ys-staff-newfile-draft';
function readNewFileDraft() {
  try { const d = JSON.parse(localStorage.getItem(DRAFT_KEY) || 'null'); return (d && typeof d === 'object') ? d : null; }
  catch (_) { return null; }
}

/* Optional co-borrower at file creation (#98). Internal-only borrower-name
   typeahead (same guarded endpoint as elsewhere) so a co-borrower on record
   links to the existing person instead of duplicating. Reports the resolved
   payload up via onChange; renders nothing that reaches a borrower surface. */
function CoBorrowerPicker({ value, onChange }) {
  const [co, setCo] = useState(value || { firstName: '', lastName: '', email: '', phone: '', borrowerId: null });
  const [matches, setMatches] = useState([]);
  const [show, setShow] = useState(false);
  const seq = useRef(0);
  const box = useRef(null);

  const push = (next) => { setCo(next); onChange(next); };
  const setField = (k, v) => push({ ...co, [k]: v, ...(co.borrowerId ? { borrowerId: null } : {}) });

  useEffect(() => {
    if (co.borrowerId) { setMatches([]); return; }
    const q = `${co.firstName} ${co.lastName}`.trim();
    if (q.length < 2) { setMatches([]); setShow(false); return; }
    const mine = ++seq.current;
    const t = setTimeout(() => {
      api.staffBorrowerSearch(q)
        .then(rows => { if (mine === seq.current) { setMatches(rows || []); setShow(true); } })
        .catch(() => { if (mine === seq.current) setMatches([]); });
    }, 250);
    return () => clearTimeout(t);
  }, [co.firstName, co.lastName, co.borrowerId]);

  useEffect(() => {
    function onDoc(e) { if (box.current && !box.current.contains(e.target)) setShow(false); }
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, []);

  function pick(bo) {
    push({ firstName: bo.first_name || co.firstName, lastName: bo.last_name || co.lastName,
      email: bo.email || co.email, phone: bo.cell_phone || co.phone, borrowerId: bo.id });
    setShow(false); setMatches([]);
  }

  return (
    <>
      <div className="grid cols-2">
        <div className="field" ref={box} style={{ position: 'relative' }}>
          <label>Co-borrower first name</label>
          <input className="input" value={co.firstName} autoComplete="off"
            onChange={e => setField('firstName', e.target.value)}
            onFocus={() => { if (matches.length) setShow(true); }} />
          {show && matches.length > 0 && (
            <div className="addr-menu" role="listbox">
              {matches.map(bo => {
                const n = bo.prior_files || 0;
                return (
                  <div key={bo.id} role="option" className="addr-item"
                    onMouseDown={e => { e.preventDefault(); pick(bo); }}>
                    <span className="addr-pin">●</span>
                    <span>
                      <strong>{[bo.first_name, bo.last_name].filter(Boolean).join(' ') || '—'}</strong>
                      {bo.email ? ' · ' + bo.email : ''}
                      {' · ' + n + ' prior file' + (n === 1 ? '' : 's')}
                    </span>
                  </div>
                );
              })}
            </div>
          )}
        </div>
        <div className="field"><label>Co-borrower last name</label>
          <input className="input" value={co.lastName} autoComplete="off" onChange={e => setField('lastName', e.target.value)} /></div>
        <div className="field"><label>Co-borrower email</label>
          <EmailInput value={co.email} onChange={v => setField('email', v)} placeholder="coborrower@email.com" /></div>
        <div className="field"><label>Co-borrower cell phone</label>
          <PhoneInput value={co.phone} onChange={v => setField('phone', v)} placeholder="Optional" /></div>
      </div>
      {co.borrowerId && (
        <p className="muted small" style={{ marginTop: 6 }}>
          Linking to an existing borrower on record — no duplicate will be created.{' '}
          <button type="button" className="btn link" style={{ padding: 0 }}
            onClick={() => push({ ...co, borrowerId: null })}>Add as new instead</button>
        </p>
      )}
      <p className="muted small" style={{ marginTop: 6 }}>
        Both borrowers' experience counts toward the file; each keeps their own track record and government-ID condition.
      </p>
    </>
  );
}

/* Import a MISMO 3.4 file — the mortgage industry's shared format. Reads the
   uploaded XML, shows a PREVIEW of exactly what will be imported (nothing is
   saved yet), then creates a brand-new loan file from it on confirm. */
function fmtMoney(n) { return n == null || n === '' ? '—' : '$' + Math.round(Number(n)).toLocaleString('en-US'); }
function MismoImport() {
  const nav = useNavigate();
  const fileRef = useRef(null);
  const [state, setState] = useState({ status: 'idle' }); // idle | reading | ready | creating
  const [xml, setXml] = useState('');
  const [preview, setPreview] = useState(null);
  const [warnings, setWarnings] = useState([]);
  const [err, setErr] = useState('');

  async function onPick(e) {
    const file = e.target.files && e.target.files[0];
    if (!file) return;
    setErr(''); setPreview(null); setWarnings([]); setState({ status: 'reading' });
    try {
      const text = await file.text();
      setXml(text);
      const r = await api.staffMismoPreview(text);
      setPreview(r.preview || null);
      setWarnings(r.warnings || []);
      setState({ status: 'ready' });
    } catch (e2) {
      setErr(e2.message || 'This file could not be read as a MISMO 3.4 file.');
      setState({ status: 'idle' });
    }
  }
  async function create() {
    setErr(''); setState({ status: 'creating' });
    try {
      const r = await api.staffMismoCreate(xml);
      nav(`/internal/app/${r.applicationId}`);
    } catch (e2) {
      setErr(e2.message || 'Could not create a file from this import.');
      setState({ status: 'ready' });
    }
  }
  function reset() {
    setState({ status: 'idle' }); setXml(''); setPreview(null); setWarnings([]); setErr('');
    if (fileRef.current) fileRef.current.value = '';
  }

  const b = preview && preview.borrower;
  const p = preview && preview.property;
  const l = preview && preview.loan;
  const addr = p && p.address ? [p.address.line1, p.address.city, p.address.state, p.address.zip].filter(Boolean).join(', ') : '—';

  return (
    <div className="panel" style={{ marginBottom: 16 }}>
      <div className="panel-h"><div className="grp-h"><span className="n">★</span><h3>Import a MISMO 3.4 file</h3></div><span className="pill mut">Industry standard</span></div>
      <div className="panel-b">
        <p className="sub" style={{ marginTop: 0 }}>
          Have a loan file from another system in MISMO format? Upload it here and PILOT will read it in — you'll see
          exactly what it contains before anything is saved.
        </p>
        {err && <div role="alert" className="notice err" style={{ marginBottom: 10 }}>{err}</div>}
        <div className="row" style={{ gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
          <input ref={fileRef} type="file" accept=".xml,text/xml,application/xml" onChange={onPick}
            disabled={state.status === 'reading' || state.status === 'creating'} />
          {state.status === 'reading' && <span className="muted small">Reading the file…</span>}
          {(preview || err) && <button type="button" className="btn btn-ghost btn-sm" onClick={reset}>Clear</button>}
        </div>

        {preview && (
          <div style={{ marginTop: 12 }}>
            <div className="notice" style={{ marginBottom: 10 }}>Nothing is saved yet — this is a preview of what the file contains.</div>
            <div className="grid cols-2" style={{ gap: 8 }}>
              <div className="metrow"><span className="k">Borrower</span><span className="v">{b ? `${b.firstName || ''} ${b.lastName || ''}`.trim() || '—' : '—'}</span></div>
              <div className="metrow"><span className="k">Co-borrower</span><span className="v">{preview.coBorrower ? `${preview.coBorrower.firstName || ''} ${preview.coBorrower.lastName || ''}`.trim() : '—'}</span></div>
              <div className="metrow"><span className="k">Property</span><span className="v">{addr}</span></div>
              <div className="metrow"><span className="k">Vesting entity</span><span className="v">{preview.llc ? preview.llc.name : '—'}</span></div>
              <div className="metrow"><span className="k">Loan amount</span><span className="v">{fmtMoney(l && l.loanAmount)}</span></div>
              <div className="metrow"><span className="k">Loan purpose</span><span className="v">{(l && l.loanType) || '—'}</span></div>
              <div className="metrow"><span className="k">Purchase price</span><span className="v">{fmtMoney(p && p.purchasePrice)}</span></div>
              <div className="metrow"><span className="k">After-repair value</span><span className="v">{fmtMoney(preview.extras && preview.extras.arv)}</span></div>
            </div>
            {warnings.length > 0 && (
              <div style={{ marginTop: 10 }}>
                <span className="muted small">Notes about this file:</span>
                <ul className="muted small" style={{ margin: '4px 0 0', paddingLeft: 18 }}>
                  {warnings.map((w, i) => <li key={i}>{w}</li>)}
                </ul>
              </div>
            )}
            <div className="row" style={{ marginTop: 12 }}>
              <div className="spacer" />
              <button type="button" className="btn primary" onClick={create} disabled={state.status === 'creating' || !b}>
                {state.status === 'creating' ? 'Creating…' : 'Create loan file from this import'}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

export default function StaffNewFile() {
  const nav = useNavigate();
  const { role, actor } = useAuth();
  const seesAll = ['admin', 'super_admin', 'underwriter'].includes(role);
  // The staffer opening the file is put on it by default (owner-directed
  // 2026-07-20) — no need to pick, never Lead Capture — when they hold an
  // officer-eligible role (the roles the officer dropdown offers). A
  // processor/underwriter opener isn't a valid LO, so their default stays blank.
  const selfOfficerId = (['loan_officer', 'admin', 'super_admin'].includes(role) && actor && actor.id) ? actor.id : '';
  const [team, setTeam] = useState([]);
  const _d = readNewFileDraft();   // restore any in-progress draft (lazy, once, pre-persist)
  const [f, setF] = useState({
    firstName: '', lastName: '', email: '', phone: '',
    program: '', loanType: '', propertyType: '', units: '', entityName: '', llcId: '',
    purchasePrice: '', asIsValue: '', arv: '', rehabBudget: '', rehabType: '', sqftPre: '', sqftPost: '',
    isAssignment: false, underlyingContractPrice: '',
    requestedExpFlips: '', requestedExpHolds: '', requestedExpGround: '', requestedExpReo: '',
    loanOfficerId: selfOfficerId, processorId: '', inviteBorrower: true,
    ...(_d && _d.f ? _d.f : {}),
  });
  const [addr, setAddr] = useState({ street: '', unit: '', city: '', state: '', zip: '', ...(_d && _d.addr ? _d.addr : {}) });
  const [busy, setBusy] = useState(false);
  // Synchronous re-entry guard: `disabled={busy}` alone can't stop a second
  // Enter-submit or double-click landing before React re-renders, which would
  // create TWO loan files. A ref flips instantly, before the first await.
  const submittingRef = useRef(false);
  const [err, setErr] = useState('');
  const [savedAt, setSavedAt] = useState(_d ? true : false);

  // Borrower-name typeahead: match prior borrowers so a new file links to the
  // existing record (no duplicate) and known contact info pre-fills. `borrowerId`
  // holds the linked borrower; any manual edit to a borrower field unlinks it.
  const [matches, setMatches] = useState([]);
  const [showMatches, setShowMatches] = useState(false);
  const [borrowerId, setBorrowerId] = useState(_d && _d.borrowerId ? _d.borrowerId : null);
  const searchSeq = useRef(0);
  const nameBox = useRef(null);
  // Optional co-borrower added right at creation (#98).
  const [addCo, setAddCo] = useState(_d && _d.addCo ? true : false);
  const [co, setCo] = useState(_d && _d.co ? _d.co : { firstName: '', lastName: '', email: '', phone: '', borrowerId: null });

  useEffect(() => { api.staffTeam().then(setTeam).catch(() => {}); }, []);

  // Auto-save the in-progress form to localStorage on every change (no Save
  // button). Restored on mount via the lazy initializers above.
  useEffect(() => {
    try { localStorage.setItem(DRAFT_KEY, JSON.stringify({ f, addr, borrowerId, addCo, co })); setSavedAt(true); } catch (_) {}
  }, [f, addr, borrowerId, addCo, co]);

  // Debounced search on the borrower's name (first + last combined). Once a
  // borrower is linked we stop searching until the staffer edits the name again.
  useEffect(() => {
    if (borrowerId) { setMatches([]); return; }
    const q = `${f.firstName} ${f.lastName}`.trim();
    if (q.length < 2) { setMatches([]); setShowMatches(false); return; }
    const mine = ++searchSeq.current;
    const t = setTimeout(() => {
      api.staffBorrowerSearch(q)
        .then(rows => { if (mine === searchSeq.current) { setMatches(rows || []); setShowMatches(true); } })
        // Degrade gracefully: on any failure just show no dropdown (plain input).
        .catch(() => { if (mine === searchSeq.current) setMatches([]); });
    }, 250);
    return () => clearTimeout(t);
  }, [f.firstName, f.lastName, borrowerId]);

  // Close the dropdown on an outside click (matches AddressAutocomplete).
  useEffect(() => {
    function onDoc(e) { if (nameBox.current && !nameBox.current.contains(e.target)) setShowMatches(false); }
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, []);

  const set = (k, v) => setF(s => ({ ...s, [k]: v }));
  // Property type drives the units control: single-unit types auto-fill 1 (and
  // lock the field), "Multi 2–4" becomes a 2/3/4 dropdown, "Multi 5+" / "Mixed
  // use" take a free number. Mirrors the borrower application so both sides
  // behave identically (owner-reported: this wasn't happening on the staff side).
  const setPropertyType = (v) => setF(s => ({ ...s, propertyType: v, units: unitsForType(v, s.units) }));
  // Borrower identity fields: a manual edit unlinks any picked borrower so the
  // name search re-enables and the file won't force-link the wrong record.
  const setBorrowerField = (k, v) => { if (borrowerId) setBorrowerId(null); setF(s => ({ ...s, [k]: v })); };
  function pickBorrower(bo) {
    setF(s => ({
      ...s,
      firstName: bo.first_name || s.firstName,
      lastName: bo.last_name || s.lastName,
      email: bo.email || s.email,
      phone: bo.cell_phone || s.phone,
    }));
    setBorrowerId(bo.id);
    setShowMatches(false);
    setMatches([]);
  }
  const setA = (k, v) => setAddr(s => ({ ...s, [k]: v }));
  const pickAddr = (a) => setAddr(s => ({
    ...s, street: a.line1 || s.street, unit: a.unit || s.unit,
    city: a.city || s.city, state: a.state || s.state, zip: a.zip || s.zip,
  }));

  const officers = team.filter(m => ['loan_officer', 'admin', 'super_admin'].includes(m.role));
  const processors = team.filter(m => m.role === 'processor');

  function buildAddress() {
    const oneLine = [
      [addr.street, addr.unit].filter(Boolean).join(' '),
      addr.city,
      [addr.state, addr.zip].filter(Boolean).join(' '),
    ].filter(Boolean).join(', ');
    return { line1: addr.street || '', street: addr.street || '', unit: addr.unit || '',
             city: addr.city || '', state: addr.state || '', zip: addr.zip || '', oneLine };
  }

  async function submit(e) {
    e.preventDefault();
    setErr('');
    if (!f.firstName.trim()) return setErr('Borrower first name is required.');
    if (!f.email.trim()) return setErr('Borrower email is required.');
    if (!addr.street.trim() && !addr.city.trim()) return setErr('Enter the property address.');
    if (submittingRef.current) return;      // a second submit is already creating the file
    submittingRef.current = true;
    setBusy(true);
    try {
      const body = {
        borrower: { firstName: f.firstName.trim(), lastName: f.lastName.trim(), email: f.email.trim(), phone: f.phone.trim() || undefined },
        // Link to the picked prior borrower; the backend also match-or-creates by
        // email (the auto-filled address), so either way no duplicate is created.
        borrowerId: borrowerId || undefined,
        propertyAddress: buildAddress(),
        propertyType: f.propertyType || undefined,
        // Single-unit types are always 1 even if a stale draft left units blank;
        // otherwise use the entered/selected count (unitsForType returns '1'/'').
        units: (() => { const u = unitsForType(f.propertyType, f.units); return u ? Number(u) : undefined; })(),
        // Vesting entity: a picked LLC id, or a typed name the backend resolves /
        // creates on the borrower after the file is made.
        llcId: f.llcId || undefined,
        entityName: (!f.llcId && f.entityName.trim()) ? f.entityName.trim() : undefined,
        program: f.program || undefined,
        loanType: f.loanType || undefined,
        purchasePrice: numOrNull(f.purchasePrice),
        isAssignment: !!f.isAssignment,
        underlyingContractPrice: f.isAssignment ? numOrNull(f.underlyingContractPrice) : undefined,
        assignmentFee: f.isAssignment ? Math.max(0, (Number(f.purchasePrice) || 0) - (Number(f.underlyingContractPrice) || 0)) : undefined,
        asIsValue: numOrNull(f.asIsValue),
        arv: numOrNull(f.arv),
        rehabBudget: numOrNull(f.rehabBudget),
        rehabType: f.rehabType || undefined,
        sqftPre: f.sqftPre ? Number(f.sqftPre) : undefined,
        sqftPost: f.sqftPost ? Number(f.sqftPost) : undefined,
        requestedExpFlips: f.requestedExpFlips ? Number(f.requestedExpFlips) : 0,
        requestedExpHolds: f.requestedExpHolds ? Number(f.requestedExpHolds) : 0,
        requestedExpGround: f.requestedExpGround ? Number(f.requestedExpGround) : 0,
        requestedExpReo: f.requestedExpReo ? Number(f.requestedExpReo) : 0,
        loanOfficerId: f.loanOfficerId || undefined,
        processorId: f.processorId || undefined,
        inviteBorrower: !!f.inviteBorrower,
      };
      // Co-borrower at creation (#98): send only when the section is open and has
      // an existing link or at least a name/email. The backend match-or-creates.
      if (addCo && (co.borrowerId || co.firstName.trim() || co.email.trim())) {
        body.coBorrower = {
          borrowerId: co.borrowerId || undefined,
          firstName: co.firstName.trim() || undefined,
          lastName: co.lastName.trim() || undefined,
          email: co.email.trim() || undefined,
          phone: co.phone.trim() || undefined,
        };
      }
      const r = await api.staffCreateFile(body);
      if (r && r.coBorrowerWarning) console.warn('[new-file] co-borrower:', r.coBorrowerWarning);
      try { localStorage.removeItem(DRAFT_KEY); } catch (_) {}   // draft consumed — file created
      nav(`/internal/app/${r.applicationId}`);
    } catch (e2) {
      setErr(e2.message || 'Could not create the file.');
      setBusy(false);
      submittingRef.current = false;        // let them retry after a real failure
    }
  }

  return (
    <>
      <div className="page-head">
        <div>
          <h1>New loan file</h1>
          <div className="sub">Open a file from your side — the borrower doesn't need an account. You can invite them
            to this file at any time; once they join they'll see everything and can message you.</div>
        </div>
        <div className="page-head-actions">
          {savedAt && <span className="savechip"><span className="dot done" />Draft saved — nothing you type is lost</span>}
          <Link to="/internal" className="btn btn-ghost btn-sm">← Pipeline</Link>
        </div>
      </div>

      {err && <div role="alert" className="notice err" style={{ marginBottom: 14 }}>{err}</div>}

      <MismoImport />

      <form onSubmit={submit}>
        <div className="form-grid">
          <div className="form-col">
        <div className="panel">
          <div className="panel-h"><div className="grp-h"><span className="n">01</span><h3>Borrower</h3></div><span className="pill mut">Primary contact</span></div>
          <div className="panel-b">
          <div className="grid cols-2">
            <div className="field" ref={nameBox} style={{ position: 'relative' }}>
              <label>First name *</label>
              <input className="input" value={f.firstName} autoComplete="off"
                onChange={e => setBorrowerField('firstName', e.target.value)}
                onFocus={() => { if (matches.length) setShowMatches(true); }} required />
              {showMatches && matches.length > 0 && (
                <div className="addr-menu" role="listbox">
                  {matches.map(bo => {
                    const n = bo.prior_files || 0;
                    return (
                      <div key={bo.id} role="option" className="addr-item"
                        onMouseDown={e => { e.preventDefault(); pickBorrower(bo); }}>
                        <span className="addr-pin">●</span>
                        <span>
                          <strong>{[bo.first_name, bo.last_name].filter(Boolean).join(' ') || '—'}</strong>
                          {bo.email ? ' · ' + bo.email : ''}
                          {' · ' + n + ' prior file' + (n === 1 ? '' : 's')}
                        </span>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
            <div className="field"><label>Last name</label>
              <input className="input" value={f.lastName} autoComplete="off" onChange={e => setBorrowerField('lastName', e.target.value)} /></div>
            <div className="field"><label>Email *</label>
              <EmailInput value={f.email} onChange={v => setBorrowerField('email', v)} required
                placeholder="borrower@email.com" /></div>
            <div className="field"><label>Cell phone</label>
              <PhoneInput value={f.phone} onChange={v => setBorrowerField('phone', v)} placeholder="Optional" /></div>
          </div>
          {borrowerId && (
            <p className="muted small" style={{ marginTop: 6 }}>
              Linking to an existing borrower — this file won't create a duplicate.{' '}
              <button type="button" className="btn link" style={{ padding: 0 }}
                onClick={() => setBorrowerId(null)}>Create as new instead</button>
            </p>
          )}
          <label style={{ display: 'flex', gap: 8, alignItems: 'center', cursor: 'pointer', marginTop: 4 }}>
            <input type="checkbox" checked={f.inviteBorrower} onChange={e => set('inviteBorrower', e.target.checked)} />
            <span>Email the borrower an invite to join this file now</span>
          </label>
          <p className="muted small" style={{ marginTop: 6 }}>
            If unchecked, you can invite them later from the file. Nothing is sent to them until you do.
          </p>

          {!addCo ? (
            <button type="button" className="btn ghost small" style={{ marginTop: 10 }} onClick={() => setAddCo(true)}>
              + Add a co-borrower
            </button>
          ) : (
            <div style={{ marginTop: 14, paddingTop: 12, borderTop: '1px solid var(--line)' }}>
              <div className="row" style={{ alignItems: 'center', marginBottom: 8 }}>
                <h4 style={{ margin: 0 }}>Co-borrower</h4>
                <div className="spacer" />
                <button type="button" className="btn link small"
                  onClick={() => { setAddCo(false); setCo({ firstName: '', lastName: '', email: '', phone: '', borrowerId: null }); }}>
                  Remove
                </button>
              </div>
              <CoBorrowerPicker value={co} onChange={setCo} />
            </div>
          )}
          </div>
        </div>

        <div className="panel">
          <div className="panel-h"><div className="grp-h"><span className="n">02</span><h3>Property</h3></div><span className="pill mut">Subject collateral</span></div>
          <div className="panel-b">
          <div className="field"><label>Street address</label>
            <AddressAutocomplete value={addr.street} onChange={v => setA('street', v)} onPick={pickAddr}
              placeholder="Start typing the property address…" /></div>
          <div className="grid cols-2">
            <div className="field"><label>Unit / Apt</label>
              <input className="input" value={addr.unit} onChange={e => setA('unit', e.target.value)} placeholder="Optional" /></div>
            <div className="field"><label>City</label>
              <input className="input" value={addr.city} onChange={e => setA('city', e.target.value)} /></div>
            <div className="field"><label>State</label>
              <input className="input" maxLength={2} value={addr.state} onChange={e => setA('state', e.target.value.toUpperCase())} placeholder="NY" /></div>
            <div className="field"><label>ZIP</label>
              <ZipInput value={addr.zip} onChange={v => setA('zip', v)} /></div>
          </div>
          <div className="grid cols-2">
            <div className="field"><label>Property type</label>
              <select className="input" value={f.propertyType} onChange={e => setPropertyType(e.target.value)}>
                <option value="">Select…</option>{PROP_TYPES.map(p => <option key={p}>{p}</option>)}
              </select></div>
            {unitsMode(f.propertyType) === 'select24' ? (
              <div className="field"><label>Units</label>
                <select className="input" value={f.units || ''} onChange={e => set('units', e.target.value)}>
                  <option value="">Select…</option><option>2</option><option>3</option><option>4</option>
                </select></div>
            ) : unitsMode(f.propertyType) === 'multi' ? (
              <div className="field"><label>Units</label>
                <input className="input" type="number" min="5" value={f.units || ''} onChange={e => set('units', e.target.value)} placeholder="5 or more" /></div>
            ) : f.propertyType ? (
              // Single-unit type (SFR / Condo / Townhouse): 1 unit, locked.
              <div className="field"><label>Units</label>
                <input className="input" value="1 unit" disabled readOnly /></div>
            ) : (
              // No type picked yet — plain entry as a fallback.
              <div className="field"><label>Units</label>
                <input className="input" type="number" min="1" value={f.units} onChange={e => set('units', e.target.value)} /></div>
            )}
          </div>
          <div className="field"><label>Vesting entity / LLC (if any)</label>
            <LlcPicker value={f.entityName} staff borrowerId={borrowerId}
              placeholder={borrowerId ? 'Which LLC is this property purchased under?' : 'Type the LLC name (created once the borrower is saved)'}
              onPick={({ id, name }) => setF(s => ({ ...s, entityName: name, llcId: id || '' }))} />
            <p className="muted small" style={{ marginTop: 4 }}>
              {borrowerId ? 'Pick one of this borrower’s LLCs or create a new one — we’ll ask for its EIN letter, formation docs, and operating agreement.'
                : 'If the property vests in an LLC, type its name — it’s created on the borrower once the file is saved.'}
            </p></div>
          </div>
        </div>

        <div className="panel">
          <div className="panel-h"><div className="grp-h"><span className="n">03</span><h3>Loan</h3></div><span className="pill mut">Loan structure</span></div>
          <div className="panel-b">
          <div className="grid cols-2">
            <div className="field"><label>Program</label>
              <select className="input" value={f.program} onChange={e => set('program', e.target.value)}>
                <option value="">Select…</option>{PROGRAMS.map(p => <option key={p}>{p}</option>)}
              </select></div>
            <div className="field"><label>Loan type</label>
              <select className="input" value={f.loanType} onChange={e => set('loanType', e.target.value)}>
                <option value="">Select…</option>{LOAN_TYPES.map(p => <option key={p}>{p}</option>)}
              </select></div>
            <div className="field"><label>Purchase price</label>
              <MoneyInput value={f.purchasePrice} onChange={v => set('purchasePrice', v)} /></div>
            <div className="field" style={{ gridColumn: '1 / -1' }}>
              <label style={{ display: 'flex', alignItems: 'center', gap: 8, textTransform: 'none', letterSpacing: 0, fontWeight: 500 }}>
                <input type="checkbox" checked={f.isAssignment} onChange={e => set('isAssignment', e.target.checked)} />
                This is an assignment purchase
              </label>
              {f.isAssignment && (
                <div className="grid cols-2" style={{ gap: 12, marginTop: 8 }}>
                  <div className="field"><label>Original (underlying) purchase price</label>
                    <MoneyInput value={f.underlyingContractPrice} onChange={v => set('underlyingContractPrice', v)} /></div>
                  <div className="field"><label>Assignment fee (auto)</label>
                    <div className="input" style={{ background: 'var(--soft, #f4f1ea)', display: 'flex', alignItems: 'center' }}>
                      ${Math.max(0, (Number(f.purchasePrice) || 0) - (Number(f.underlyingContractPrice) || 0)).toLocaleString('en-US')}
                    </div></div>
                  <div className="hint" style={{ gridColumn: '1 / -1' }}>The fee is the total purchase price minus the original contract price.</div>
                </div>
              )}
            </div>
            <div className="field"><label>As-is value</label>
              <MoneyInput value={f.asIsValue} onChange={v => set('asIsValue', v)} /></div>
            <div className="field"><label>ARV</label>
              <MoneyInput value={f.arv} onChange={v => set('arv', v)} /></div>
            <div className="field"><label>Rehab budget</label>
              <MoneyInput value={f.rehabBudget} onChange={v => set('rehabBudget', v)} /></div>
            <div className="field"><label>Rehab type</label>
              <select className="input" value={f.rehabType} onChange={e => set('rehabType', e.target.value)}>
                <option value="">Select...</option>{REHAB_TYPES.map(x => <option key={x}>{x}</option>)}
              </select></div>
            {needsSqft(f.rehabType) && <>
              <div className="field"><label>Existing sq ft</label>
                <input className="input" type="number" min="0" value={f.sqftPre} onChange={e => set('sqftPre', e.target.value)} /></div>
              <div className="field"><label>Completed sq ft</label>
                <input className="input" type="number" min="0" value={f.sqftPost} onChange={e => set('sqftPost', e.target.value)} /></div>
            </>}
          </div>
          <h3 style={{ margin: '12px 0 8px' }}>Experience used for this request</h3>
          <div className="grid cols-2">
            <div className="field"><label>Fix &amp; flip deals</label>
              <input className="input" type="number" min="0" value={f.requestedExpFlips} onChange={e => set('requestedExpFlips', e.target.value)} /></div>
            <div className="field"><label>Fix &amp; hold deals</label>
              <input className="input" type="number" min="0" value={f.requestedExpHolds} onChange={e => set('requestedExpHolds', e.target.value)} /></div>
            <div className="field"><label>Ground-up deals</label>
              <input className="input" type="number" min="0" value={f.requestedExpGround} onChange={e => set('requestedExpGround', e.target.value)} /></div>
            <div className="field"><label>General REO owned</label>
              <input className="input" type="number" min="0" value={f.requestedExpReo} onChange={e => set('requestedExpReo', e.target.value)} /></div>
          </div>
          <p className="muted small" style={{ marginTop: 4 }}>General REO (rentals/properties owned) usually doesn't count toward program experience tiers, but it's captured on the file.</p>
          <p className="muted small">Final pricing and leverage are confirmed against program guidelines — these figures start the file.</p>
          </div>
        </div>

        <div className="panel">
          <div className="panel-h"><div className="grp-h"><span className="n">04</span><h3>Assignment</h3></div><span className="pill mut">Desk routing</span></div>
          <div className="panel-b">
          <div className="grid cols-2">
            <div className="field"><label>Loan officer</label>
              <select className="input" value={f.loanOfficerId} onChange={e => set('loanOfficerId', e.target.value)}>
                <option value="">{seesAll ? '— Lead Capture (unassigned) —' : 'Me'}</option>
                {officers.map(m => <option key={m.id} value={m.id}>{m.full_name} ({m.role})</option>)}
              </select></div>
            <div className="field"><label>Processor</label>
              <select className="input" value={f.processorId} onChange={e => set('processorId', e.target.value)}>
                <option value="">— none yet —</option>
                {processors.map(m => <option key={m.id} value={m.id}>{m.full_name}</option>)}
              </select></div>
          </div>
          {!seesAll && <p className="muted small">Left unassigned, this file lands on your pipeline.</p>}
          </div>
        </div>

          </div>{/* /.form-col */}

          <aside className="summary">
            <div className="panel">
              <div className="panel-h"><h3>File summary</h3><span className="pill mut">Draft</span></div>
              <div className="panel-b">
                <div className="metrow"><span className="k">Borrower</span><span className="v">{[f.firstName, f.lastName].filter(Boolean).join(' ') || '—'}</span></div>
                <div className="metrow"><span className="k">Property</span><span className="v">{[addr.street, addr.city, addr.state].filter(Boolean).join(', ') || '—'}</span></div>
                <div className="metrow"><span className="k">Program</span><span className="v">{f.program || '—'}</span></div>
                <div className="metrow"><span className="k">Loan type</span><span className="v">{f.loanType || '—'}</span></div>
                <div className="metrow"><span className="k">Purchase price</span><span className="v">{f.purchasePrice ? '$' + f.purchasePrice : '—'}</span></div>
                <div className="metrow"><span className="k">ARV</span><span className="v">{f.arv ? '$' + f.arv : '—'}</span></div>
                <div className="sum-actions">
                  <button className="btn primary btn-block" disabled={busy}>{busy ? 'Creating…' : 'Create file'}</button>
                  <Link to="/internal" className="btn ghost btn-block">Cancel</Link>
                </div>
                <p className="sum-note muted small">A file number is issued on creation; the borrower is invited to the portal if you left the invite checked.</p>
              </div>
            </div>
          </aside>

        </div>{/* /.form-grid */}
      </form>
    </>
  );
}
