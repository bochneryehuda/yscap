import React, { useEffect, useRef, useState } from 'react';
import { api, saveBlob } from '../lib/api.js';
import { useAutosave } from '../lib/useAutosave.js';
import AddressAutocomplete from '../components/AddressAutocomplete.jsx';
import { MoneyInput, PhoneInput } from '../components/FormattedInputs.jsx';
import Entities from '../components/Entities.jsx';
import DocPreview from '../components/DocPreview.jsx';
import { Link } from 'react-router-dom';

/* Canonical borrower profile — the single home for personal information so the
   loan application can skip the personal section entirely and pull from here.
   Physical (residence) address is separate from the mailing address; a photo ID
   uploaded here is collected ONCE and reused across every file. */

const CITIZENSHIP = ['US Citizen', 'Permanent Resident', 'Foreign National'];
const MARITAL = ['Single', 'Married', 'Separated', 'Divorced', 'Widowed'];

export default function Profile() {
  const [p, setP] = useState(null);
  const [err, setErr] = useState('');
  const [msg, setMsg] = useState('');
  const [busy, setBusy] = useState(false);
  const [ssn, setSsn] = useState('');
  const [phys, setPhys] = useState({ line1: '', unit: '', city: '', state: '', zip: '' });
  const [mailDiff, setMailDiff] = useState(false);
  const [mail, setMail] = useState({ line1: '', unit: '', city: '', state: '', zip: '' });
  const [idBusy, setIdBusy] = useState(false);
  const [hasPhotoId, setHasPhotoId] = useState(false);
  const idRef = useRef(null);
  const [trCounts, setTrCounts] = useState(null);  // live track-record counts
  const [trSnap, setTrSnap] = useState(null);      // saved static HTML copy
  const [trDl, setTrDl] = useState(false);
  const [trPreview, setTrPreview] = useState(false);

  useEffect(() => {
    api.profile().then(d => {
      setP(d);
      const ca = d.current_address || {};
      setPhys({ line1: ca.line1 || ca.street || '', unit: ca.unit || '', city: ca.city || '', state: ca.state || '', zip: ca.zip || '' });
      if (d.mailing_address) { setMailDiff(true); const m = d.mailing_address; setMail({ line1: m.line1 || '', unit: m.unit || '', city: m.city || '', state: m.state || '', zip: m.zip || '' }); }
      setHasPhotoId(!!d.photo_id_document_id);
    }).catch(e => setErr(e.message));
    // The live track record + its saved static copy, summarized right here.
    api.trackRecords().then(rows => {
      const c = { flips: 0, holds: 0, ground: 0, total: 0 };
      for (const r of rows || []) {
        const t = String(r.deal_type || '').toLowerCase();
        if (t.includes('ground')) c.ground++; else if (t.includes('flip')) c.flips++; else c.holds++;
        c.total++;
      }
      setTrCounts(c);
    }).catch(() => {});
    api.trackRecordSnapshot().then(setTrSnap).catch(() => {});
  }, []);

  async function downloadTrSnap() {
    if (!trSnap) return;
    setTrDl(true);
    try { const { blob, filename } = await api.downloadDoc(trSnap.documentId); saveBlob(blob, filename || trSnap.filename); }
    catch (e) { setErr(e.message || 'Download failed'); }
    finally { setTrDl(false); }
  }

  const edited = useRef(false);
  const set = (k, v) => { edited.current = true; setP(x => ({ ...x, [k]: v })); };
  const setA = (setter) => (k, v) => { edited.current = true; setter(s => ({ ...s, [k]: v })); };
  const setPhysF = setA(setPhys);
  const setMailF = setA(setMail);
  const flash = (m) => { setMsg(m); setTimeout(() => setMsg(''), 3500); };

  const addrOneLine = (a) => [[a.line1, a.unit].filter(Boolean).join(' '), a.city, [a.state, a.zip].filter(Boolean).join(' ')].filter(Boolean).join(', ');

  // Build the save payload from current state (shared by autosave + manual save).
  const buildPayload = () => {
    const currentAddress = phys.line1 || phys.city ? { ...phys, oneLine: addrOneLine(phys) } : undefined;
    const payload = {
      firstName: p.first_name, lastName: p.last_name,
      cellPhone: p.cell_phone ?? '', dateOfBirth: p.date_of_birth ? String(p.date_of_birth).slice(0, 10) : '',
      fico: p.fico ?? '', citizenship: p.citizenship ?? '', maritalStatus: p.marital_status ?? '',
      yearsAtResidence: p.years_at_residence ?? '', monthsAtResidence: p.months_at_residence ?? '',
      housingStatus: p.housing_status ?? '', housingPayment: p.housing_payment ?? '',
      currentAddress,
      mailingDifferent: mailDiff,
      mailingAddress: mailDiff ? { ...mail, oneLine: addrOneLine(mail) } : undefined,
    };
    if (ssn.trim()) payload.ssn = ssn.trim();
    return payload;
  };

  // Autosave: everything the borrower types is saved automatically ~1s after
  // they stop, even without pressing Save. The manual button stays for
  // reassurance and to force an immediate flush + refresh.
  const { status, save: queueSave } = useAutosave((payload) => api.saveProfile(payload), 1000);
  useEffect(() => {
    if (!p || !edited.current) return;
    queueSave(buildPayload());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [p, phys, mail, mailDiff, ssn]);

  async function save() {
    setBusy(true); setErr('');
    try {
      await api.saveProfile(buildPayload());
      setSsn('');
      const fresh = await api.profile(); setP(fresh);
      edited.current = false;
      flash('Profile saved ✓');
    } catch (e) { setErr(e.message || 'Could not save your profile'); }
    finally { setBusy(false); }
  }

  async function onPhotoId(e) {
    const file = e.target.files && e.target.files[0];
    if (!file) return;
    setIdBusy(true); setErr('');
    try {
      const dataUrl = await new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result); r.onerror = rej; r.readAsDataURL(file); });
      await api.uploadPhotoId({ filename: file.name, contentType: file.type, dataBase64: String(dataUrl).split(',')[1] });
      setHasPhotoId(true); flash('Photo ID saved to your profile ✓ — you won\'t be asked for it again.');
    } catch (e2) { setErr(e2.message || 'Could not upload the ID'); }
    finally { setIdBusy(false); if (idRef.current) idRef.current.value = ''; }
  }

  if (err && !p) return <div role="alert" className="notice err">{err}</div>;
  if (!p) return <div className="panel muted">Loading…</div>;

  return (
    <>
      <div className="row" style={{ marginBottom: 14 }}>
        <div><h1>Your profile</h1><p className="muted small">Your personal information lives here and prefills every loan application, so you never enter it twice.</p></div>
        <div className="spacer" />
        <span className="savechip" style={{ marginRight: 10 }}>
          <span className={`dot ${status === 'saved' ? 'done' : status === 'error' ? '' : status === 'saving' ? 'outstanding' : ''}`} />
          {status === 'saving' ? 'Saving…' : status === 'saved' ? 'All changes saved' : status === 'error' ? 'Save failed — retrying' : ''}
        </span>
        <button className="btn primary" onClick={save} disabled={busy}>{busy ? 'Saving…' : 'Save profile'}</button>
      </div>

      {msg && <div className="notice ok">{msg}</div>}
      {err && <div role="alert" className="notice err">{err}</div>}

      {/* Identity & contact */}
      <div className="panel">
        <h3 style={{ marginBottom: 12 }}>Identity &amp; contact</h3>
        <div className="grid cols-2">
          <div className="field"><label>First name</label>
            <input className="input" autoComplete="off" value={p.first_name || ''} onChange={e => set('first_name', e.target.value)} /></div>
          <div className="field"><label>Last name</label>
            <input className="input" autoComplete="off" value={p.last_name || ''} onChange={e => set('last_name', e.target.value)} /></div>
          <div className="field"><label>Email</label>
            <input className="input" value={p.email || ''} disabled title="Contact us to change your account email" /></div>
          <div className="field"><label>Cell phone</label>
            <PhoneInput value={p.cell_phone || ''} onChange={v => set('cell_phone', v)} /></div>
        </div>
      </div>

      {/* Personal (required on applications) */}
      <div className="panel">
        <h3 style={{ marginBottom: 4 }}>Personal information</h3>
        <p className="muted small" style={{ marginBottom: 12 }}>Required on every application — stored securely here so applications can skip it. Your SSN is encrypted and only its last 4 digits are ever shown.</p>
        <div className="grid cols-3">
          <div className="field"><label>Date of birth</label>
            <input className="input" type="date" value={p.date_of_birth ? String(p.date_of_birth).slice(0, 10) : ''} onChange={e => set('date_of_birth', e.target.value)} /></div>
          <div className="field"><label>Social Security Number</label>
            <input className="input" autoComplete="off" value={ssn} onChange={e => { edited.current = true; setSsn(e.target.value); }}
              placeholder={p.ssn_last4 ? `On file ••• ${p.ssn_last4}` : '•••-••-••••'} /></div>
          <div className="field"><label>Estimated FICO</label>
            <input className="input" type="number" min="300" max="850" value={p.fico || ''} onChange={e => set('fico', e.target.value)} placeholder="e.g. 720" /></div>
          <div className="field"><label>Citizenship</label>
            <select className="input" value={p.citizenship || ''} onChange={e => set('citizenship', e.target.value)}>
              <option value="">Select…</option>{CITIZENSHIP.map(c => <option key={c}>{c}</option>)}
            </select></div>
          <div className="field"><label>Marital status</label>
            <select className="input" value={p.marital_status || ''} onChange={e => set('marital_status', e.target.value)}>
              <option value="">Select…</option>{MARITAL.map(c => <option key={c}>{c}</option>)}
            </select></div>
        </div>
      </div>

      {/* Photo ID (collected once) */}
      <div className="panel">
        <div className="row" style={{ marginBottom: 6 }}>
          <h3>Government photo ID</h3>
          <div className="spacer" />
          <span className={`pill ${hasPhotoId ? 'done' : ''}`}>{hasPhotoId ? 'On file' : 'Not on file'}</span>
        </div>
        <p className="muted small" style={{ marginBottom: 10 }}>Upload a clear photo of your government-issued ID once. It's saved to your profile and reused on every file — you'll never be asked again.</p>
        <input ref={idRef} type="file" accept="image/*,application/pdf" style={{ display: 'none' }} onChange={onPhotoId} />
        <button className="btn ghost" disabled={idBusy} onClick={() => idRef.current && idRef.current.click()}>
          {idBusy ? 'Uploading…' : hasPhotoId ? 'Replace photo ID' : 'Upload photo ID'}
        </button>
      </div>

      {/* Addresses */}
      <div className="panel">
        <h3 style={{ marginBottom: 12 }}>Home (physical) address</h3>
        <div className="field"><label>Street address</label>
          <AddressAutocomplete value={phys.line1} onChange={v => setPhysF('line1', v)}
            onPick={a => setPhys(s => ({ ...s, line1: a.line1 || s.line1, city: a.city || s.city, state: a.state || s.state, zip: a.zip || s.zip }))}
            placeholder="Start typing your home address…" /></div>
        <div className="grid cols-2">
          <div className="field"><label>Apt / Unit</label>
            <input className="input" autoComplete="off" value={phys.unit} onChange={e => setPhysF('unit', e.target.value)} placeholder="Optional" /></div>
          <div className="field"><label>City</label>
            <input className="input" autoComplete="off" value={phys.city} onChange={e => setPhysF('city', e.target.value)} /></div>
          <div className="field"><label>State</label>
            <input className="input" autoComplete="off" maxLength={2} value={phys.state} onChange={e => setPhysF('state', e.target.value.toUpperCase())} placeholder="NY" /></div>
          <div className="field"><label>ZIP</label>
            <input className="input" autoComplete="off" value={phys.zip} onChange={e => setPhysF('zip', e.target.value)} /></div>
        </div>
        <div className="grid cols-3" style={{ marginTop: 4 }}>
          <div className="field"><label>Housing status</label>
            <select className="input" value={p.housing_status || ''} onChange={e => set('housing_status', e.target.value)}>
              <option value="">Select…</option>
              <option value="rent">Rent</option>
              <option value="mortgage">Own with mortgage</option>
              <option value="own_free_clear">Own free &amp; clear</option>
            </select></div>
          <div className="field"><label>Monthly housing payment</label>
            <MoneyInput value={p.housing_payment || ''} onChange={v => set('housing_payment', v)} /></div>
          <div className="field"><label>Time at residence</label>
            <div className="row" style={{ gap: 6 }}>
              <input className="input" type="number" min="0" style={{ maxWidth: 90 }} value={p.years_at_residence ?? ''} onChange={e => set('years_at_residence', e.target.value)} placeholder="Years" />
              <input className="input" type="number" min="0" max="11" style={{ maxWidth: 90 }} value={p.months_at_residence ?? ''} onChange={e => set('months_at_residence', e.target.value)} placeholder="Months" />
            </div></div>
        </div>
        <label style={{ display: 'flex', gap: 8, alignItems: 'center', cursor: 'pointer', marginTop: 4 }}>
          <input type="checkbox" checked={mailDiff} onChange={e => { edited.current = true; setMailDiff(e.target.checked); }} />
          <span>My mailing address is different from my home address</span>
        </label>
      </div>

      {mailDiff && (
        <div className="panel">
          <h3 style={{ marginBottom: 12 }}>Mailing address</h3>
          <div className="field"><label>Street address</label>
            <AddressAutocomplete value={mail.line1} onChange={v => setMailF('line1', v)}
              onPick={a => setMail(s => ({ ...s, line1: a.line1 || s.line1, city: a.city || s.city, state: a.state || s.state, zip: a.zip || s.zip }))}
              placeholder="Start typing your mailing address…" /></div>
          <div className="grid cols-2">
            <div className="field"><label>Apt / Unit</label>
              <input className="input" autoComplete="off" value={mail.unit} onChange={e => setMailF('unit', e.target.value)} placeholder="Optional" /></div>
            <div className="field"><label>City</label>
              <input className="input" autoComplete="off" value={mail.city} onChange={e => setMailF('city', e.target.value)} /></div>
            <div className="field"><label>State</label>
              <input className="input" autoComplete="off" maxLength={2} value={mail.state} onChange={e => setMailF('state', e.target.value.toUpperCase())} placeholder="NY" /></div>
            <div className="field"><label>ZIP</label>
              <input className="input" autoComplete="off" value={mail.zip} onChange={e => setMailF('zip', e.target.value)} /></div>
          </div>
        </div>
      )}

      <Entities />

      {/* The track record is its own general section (one live record per
          borrower, linked to every file) — not part of the profile form. */}
      <div className="panel">
        <div className="row" style={{ alignItems: 'center', flexWrap: 'wrap', gap: 10 }}>
          <div>
            <h3 style={{ marginBottom: 4 }}>Track record &amp; experience</h3>
            <p className="muted small" style={{ margin: 0 }}>Your completed deals live in their own section and link to every loan file automatically.</p>
          </div>
          <div className="spacer" />
          {trSnap && (
            <button className="btn ghost" onClick={() => setTrPreview(true)} title="Preview your saved track record without downloading">Preview</button>
          )}
          {trSnap && (
            <button className="btn ghost" disabled={trDl} onClick={downloadTrSnap} title="The static HTML copy of your track record — kept in sync automatically">
              {trDl ? '…' : '⤓ Saved copy (HTML)'}
            </button>
          )}
          <Link className="btn primary" to="/track-record">Open Track Record →</Link>
        </div>
        {trPreview && trSnap && (
          <DocPreview title="Track record — saved copy" filename={trSnap.filename} contentType="text/html"
            load={() => api.downloadDoc(trSnap.documentId)}
            onDownload={downloadTrSnap} onClose={() => setTrPreview(false)} />
        )}
        {trCounts && (
          <div className="reqchips" style={{ marginTop: 12 }}>
            <span className={`reqchip ${trCounts.total ? 'met' : ''}`}>{trCounts.total} deal{trCounts.total === 1 ? '' : 's'} on record</span>
            {trCounts.flips > 0 && <span className="reqchip">{trCounts.flips} flip{trCounts.flips === 1 ? '' : 's'}</span>}
            {trCounts.holds > 0 && <span className="reqchip">{trCounts.holds} hold{trCounts.holds === 1 ? '' : 's'}</span>}
            {trCounts.ground > 0 && <span className="reqchip">{trCounts.ground} ground-up</span>}
          </div>
        )}
      </div>

      <div className="row" style={{ marginTop: 8 }}>
        <div className="spacer" />
        <button className="btn primary" onClick={save} disabled={busy}>{busy ? 'Saving…' : 'Save profile'}</button>
      </div>
    </>
  );
}
