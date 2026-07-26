import React, { useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../lib/api.js';
import { PhoneInput , EmailInput} from '../components/FormattedInputs.jsx';
import { useSubmitGate } from '../lib/useSubmitGate.js';
import { useAuth } from '../lib/auth.jsx';

/* Vendor directory (admin): every title company / insurance agent contact
   entered anywhere on the platform, tagged by type. Admins enrich, correct,
   or delete entries — borrowers then autocomplete against the clean records. */

const TYPES = [
  { v: 'title_company', label: 'Title company' },
  { v: 'insurance_agent', label: 'Insurance agent' },
  { v: 'attorney', label: 'Attorney' },
  { v: 'contractor', label: 'Contractor' },
  { v: 'other', label: 'Other' },
];
const TYPE_LABEL = Object.fromEntries(TYPES.map(t => [t.v, t.label]));
// Presentational only: type→swatch colour class + monogram initials for the directory table.
const SWATCH = { title_company: 'sw-title', insurance_agent: 'sw-insurance', attorney: 'sw-attorney', contractor: 'sw-inspector', other: '' };
const initials = (s) => (String(s || '').trim().split(/\s+/).map(w => w[0]).filter(Boolean).slice(0, 2).join('').toUpperCase()) || '—';
const blank = () => ({ contactType: 'title_company', companyName: '', contactName: '', emails: [''], phones: [''], address: '', notes: '' });

// Multiple emails / phones per vendor (owner-directed 2026-07-21): a title
// company with rundown@ AND closing@ addresses, or an agent with a personal
// and a company inbox, should carry ALL of them on ONE row. Renders each entry
// as its own input with add / remove controls; a blank trailing input is
// tolerated (dropped server-side).
function MultiInput({ label, kind, values, onChange }) {
  const set = (i, v) => onChange(values.map((x, j) => j === i ? v : x));
  const add = () => onChange([...(values || []), '']);
  const rm = (i) => onChange(values.filter((_, j) => j !== i));
  const Comp = kind === 'email' ? EmailInput : kind === 'phone' ? PhoneInput : null;
  const arr = values.length ? values : [''];
  return (
    <div className="field" style={{ gridColumn: '1 / -1' }}>
      <label className="row" style={{ alignItems: 'baseline', gap: 8 }}>
        <span>{label}</span>
        {values.filter((v) => String(v || '').trim()).length > 1 && (
          <span className="pill mut small" title={`Multiple ${kind}s on this vendor`}>
            {values.filter((v) => String(v || '').trim()).length}
          </span>
        )}
      </label>
      {arr.map((v, i) => (
        <div key={i} className="row" style={{ gap: 8, marginTop: i ? 6 : 0, alignItems: 'center' }}>
          {Comp
            ? <Comp value={v} onChange={(nv) => set(i, nv)} />
            : <input className="input" value={v} onChange={(e) => set(i, e.target.value)} />}
          {arr.length > 1 && (
            <button className="btn link small" onClick={() => rm(i)}
              aria-label={`Remove this ${kind}`}
              title={`Remove this ${kind}`}>
              <span aria-hidden="true">×</span>
            </button>
          )}
        </div>
      ))}
      <button className="btn link small" style={{ marginTop: 8 }} onClick={add}
        aria-label={`Add another ${kind}`}>
        <span aria-hidden="true" style={{ marginRight: 4 }}>+</span>Add another {kind}
      </button>
    </div>
  );
}

function VendorForm({ initial, onSave, onCancel, busy }) {
  const [f, setF] = useState(initial);
  return (
    <div className="panel" style={{ background: 'var(--ink-2)', marginTop: 8 }}>
      <div className="grid cols-3">
        <div className="field"><label>Type</label>
          <select className="input" value={f.contactType} onChange={e => setF({ ...f, contactType: e.target.value })}>
            {TYPES.map(t => <option key={t.v} value={t.v}>{t.label}</option>)}
          </select></div>
        <div className="field"><label>Company / agency</label>
          <input className="input" value={f.companyName} onChange={e => setF({ ...f, companyName: e.target.value })} /></div>
        <div className="field"><label>Contact name</label>
          <input className="input" value={f.contactName} onChange={e => setF({ ...f, contactName: e.target.value })} /></div>
        <MultiInput label="Emails" kind="email" values={f.emails || ['']}
          onChange={(v) => setF({ ...f, emails: v })} />
        <MultiInput label="Phones" kind="phone" values={f.phones || ['']}
          onChange={(v) => setF({ ...f, phones: v })} />
        <div className="field" style={{ gridColumn: '1 / -1' }}><label>Address</label>
          <input className="input" value={f.address} onChange={e => setF({ ...f, address: e.target.value })} /></div>
        <div className="field" style={{ gridColumn: '1 / -1' }}><label>Notes (internal)</label>
          <input className="input" value={f.notes} onChange={e => setF({ ...f, notes: e.target.value })} placeholder="e.g. preferred contact for Brooklyn closings" /></div>
      </div>
      <div className="row" style={{ gap: 8 }}>
        <button className="btn primary" disabled={busy} onClick={() => onSave(f)}>{busy ? 'Saving…' : 'Save vendor'}</button>
        <button className="btn link" onClick={onCancel}>Cancel</button>
      </div>
    </div>
  );
}

// Merge two vendors: side-by-side comparison; per-field pick radio for each
// scalar (name, contact name, address, notes, type, primary email/phone);
// UNION of emails/phones with checkboxes so an admin can drop a bad entry.
// Runs on the survivor (the vendor the merged row folds INTO).
function MergeVendorPanel({ survivor, merged, onCancel, onMerged, busy }) {
  const svEmails = survivor.emails && survivor.emails.length ? survivor.emails : (survivor.email ? [survivor.email] : []);
  const mdEmails = merged.emails && merged.emails.length ? merged.emails : (merged.email ? [merged.email] : []);
  const svPhones = survivor.phones && survivor.phones.length ? survivor.phones : (survivor.phone ? [survivor.phone] : []);
  const mdPhones = merged.phones && merged.phones.length ? merged.phones : (merged.phone ? [merged.phone] : []);
  const uniqEmails = Array.from(new Set([...svEmails, ...mdEmails].map((x) => String(x || '').trim()).filter(Boolean).map((x) => x.toLowerCase())))
    .map((k) => [...svEmails, ...mdEmails].find((x) => String(x || '').trim().toLowerCase() === k));
  const uniqPhones = Array.from(new Set([...svPhones, ...mdPhones].map((x) => String(x || '').replace(/\D+/g, '')).filter(Boolean)))
    .map((k) => [...svPhones, ...mdPhones].find((x) => String(x || '').replace(/\D+/g, '') === k));
  // Field pick side ('s'=survivor, 'm'=merged) per field.
  const pref = (a, b) => a && a !== '' && a !== null ? 's' : (b ? 'm' : 's');
  const [pick, setPick] = useState({
    companyName: pref(survivor.company_name, merged.company_name),
    contactName: pref(survivor.contact_name, merged.contact_name),
    address: pref(survivor.address, merged.address),
    notes: pref(survivor.notes, merged.notes),
    contactType: 's',
    primaryEmail: 's',
    primaryPhone: 's',
  });
  const [emailsChecked, setEmailsChecked] = useState(uniqEmails.map(() => true));
  const [phonesChecked, setPhonesChecked] = useState(uniqPhones.map(() => true));
  const valFor = (k) => {
    if (k === 'contactType') return pick.contactType === 's' ? survivor.contact_type : merged.contact_type;
    const s = pick[k] === 's' ? survivor : merged;
    const map = { companyName: 'company_name', contactName: 'contact_name', address: 'address', notes: 'notes' };
    return s[map[k]] || '';
  };
  const primaryEmailValue = pick.primaryEmail === 's' ? (svEmails[0] || '') : (mdEmails[0] || '');
  const primaryPhoneValue = pick.primaryPhone === 's' ? (svPhones[0] || '') : (mdPhones[0] || '');
  const Row = ({ label, fieldKey, sVal, mVal }) => (
    <tr>
      <th style={{ textAlign: 'left', paddingRight: 12 }}>{label}</th>
      <td style={{ paddingRight: 8 }}>
        <label className="row" style={{ gap: 6, alignItems: 'center' }}>
          <input type="radio" checked={pick[fieldKey] === 's'} onChange={() => setPick((p) => ({ ...p, [fieldKey]: 's' }))} />
          <span>{sVal || <span className="muted">—</span>}</span>
        </label>
      </td>
      <td>
        <label className="row" style={{ gap: 6, alignItems: 'center' }}>
          <input type="radio" checked={pick[fieldKey] === 'm'} onChange={() => setPick((p) => ({ ...p, [fieldKey]: 'm' }))} />
          <span>{mVal || <span className="muted">—</span>}</span>
        </label>
      </td>
    </tr>
  );
  async function doMerge() {
    const emails = uniqEmails.filter((_, i) => emailsChecked[i]);
    const phones = uniqPhones.filter((_, i) => phonesChecked[i]);
    await onMerged({
      survivorId: survivor.id, mergedId: merged.id,
      picks: {
        companyName: valFor('companyName'),
        contactName: valFor('contactName'),
        address: valFor('address'),
        notes: valFor('notes'),
        contactType: valFor('contactType'),
        primaryEmail: primaryEmailValue,
        primaryPhone: primaryPhoneValue,
      },
      emails, phones,
    });
  }
  const svTitle = survivor.company_name || survivor.contact_name || survivor.email || 'Vendor A';
  const mdTitle = merged.company_name || merged.contact_name || merged.email || 'Vendor B';
  const finalEmailsCount = emailsChecked.filter(Boolean).length;
  const finalPhonesCount = phonesChecked.filter(Boolean).length;
  return (
    <div className="panel" role="region" aria-label="Merge vendors"
      style={{ background: 'var(--surface, #FFFFFF)', marginTop: 10,
        borderLeft: '3px solid var(--gold, #AE8746)' }}>
      <div className="row" style={{ marginBottom: 10, gap: 10, alignItems: 'baseline', flexWrap: 'wrap' }}>
        <h3 style={{ margin: 0 }}>Merge vendors</h3>
        <span className="pill mut" title="This action is not automatically reversible">Careful — combines files</span>
        <div className="spacer" style={{ flex: 1 }} />
        <span className="muted small">
          Pick the value to keep for each field. Emails and phones combine —
          uncheck any you don't want to keep.
        </span>
      </div>
      {/* Vendor identity chips so the person is always oriented on which two
          vendors are being merged (the table headers repeat these, but a chip
          row at the top is easier to scan). */}
      <div className="row" style={{ gap: 10, marginBottom: 12, flexWrap: 'wrap', alignItems: 'stretch' }}>
        <div style={{ flex: 1, minWidth: 220, background: 'var(--surface-soft)',
          border: '1px solid var(--line)', borderRadius: 10, padding: '8px 12px' }}>
          <div className="small muted">Survivor (keeps the row)</div>
          <div style={{ fontWeight: 600, marginTop: 2 }}>{svTitle}</div>
          <div className="small muted">{TYPE_LABEL[survivor.contact_type] || survivor.contact_type}</div>
        </div>
        <div style={{ alignSelf: 'center', color: 'var(--muted)', fontSize: 20 }} aria-hidden="true">＋</div>
        <div style={{ flex: 1, minWidth: 220, background: 'var(--surface-soft)',
          border: '1px solid var(--line)', borderRadius: 10, padding: '8px 12px' }}>
          <div className="small muted">Folded in (soft-deleted)</div>
          <div style={{ fontWeight: 600, marginTop: 2 }}>{mdTitle}</div>
          <div className="small muted">{TYPE_LABEL[merged.contact_type] || merged.contact_type}</div>
        </div>
      </div>
      <div style={{ overflowX: 'auto' }}>
        <table className="tbl" style={{ width: '100%' }}>
          <thead>
            <tr>
              <th style={{ textAlign: 'left', minWidth: 120 }}>Field</th>
              <th style={{ textAlign: 'left' }}>From: <em>{svTitle}</em></th>
              <th style={{ textAlign: 'left' }}>From: <em>{mdTitle}</em></th>
            </tr>
          </thead>
          <tbody>
            <Row label="Type" fieldKey="contactType" sVal={TYPE_LABEL[survivor.contact_type] || survivor.contact_type} mVal={TYPE_LABEL[merged.contact_type] || merged.contact_type} />
            <Row label="Company" fieldKey="companyName" sVal={survivor.company_name} mVal={merged.company_name} />
            <Row label="Contact name" fieldKey="contactName" sVal={survivor.contact_name} mVal={merged.contact_name} />
            <Row label="Address" fieldKey="address" sVal={survivor.address} mVal={merged.address} />
            <Row label="Notes" fieldKey="notes" sVal={survivor.notes} mVal={merged.notes} />
            <Row label="Primary email" fieldKey="primaryEmail" sVal={svEmails[0]} mVal={mdEmails[0]} />
            <Row label="Primary phone" fieldKey="primaryPhone" sVal={svPhones[0]} mVal={mdPhones[0]} />
          </tbody>
        </table>
      </div>
      {(uniqEmails.length > 0 || uniqPhones.length > 0) && (
        <div className="grid" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))',
          gap: 12, marginTop: 14 }}>
          {uniqEmails.length > 0 && (
            <div style={{ background: 'var(--surface-soft)', border: '1px solid var(--line)',
              borderRadius: 10, padding: '10px 12px' }}>
              <div className="row" style={{ marginBottom: 6 }}>
                <div style={{ fontWeight: 600 }}>Emails</div>
                <div className="spacer" style={{ flex: 1 }} />
                <span className="pill mut small">{finalEmailsCount} keeping</span>
              </div>
              {uniqEmails.map((em, i) => (
                <label key={em} className="row" style={{ gap: 8, alignItems: 'center', padding: '3px 0' }}>
                  <input type="checkbox" checked={emailsChecked[i]}
                    onChange={() => setEmailsChecked((s) => s.map((v, j) => j === i ? !v : v))} />
                  <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{em}</span>
                </label>
              ))}
            </div>
          )}
          {uniqPhones.length > 0 && (
            <div style={{ background: 'var(--surface-soft)', border: '1px solid var(--line)',
              borderRadius: 10, padding: '10px 12px' }}>
              <div className="row" style={{ marginBottom: 6 }}>
                <div style={{ fontWeight: 600 }}>Phones</div>
                <div className="spacer" style={{ flex: 1 }} />
                <span className="pill mut small">{finalPhonesCount} keeping</span>
              </div>
              {uniqPhones.map((ph, i) => (
                <label key={ph} className="row" style={{ gap: 8, alignItems: 'center', padding: '3px 0' }}>
                  <input type="checkbox" checked={phonesChecked[i]}
                    onChange={() => setPhonesChecked((s) => s.map((v, j) => j === i ? !v : v))} />
                  <span>{ph}</span>
                </label>
              ))}
            </div>
          )}
        </div>
      )}
      <div className="row" style={{ gap: 8, marginTop: 16, alignItems: 'center' }}>
        <button className="btn primary" disabled={busy} onClick={doMerge}
          aria-label={`Merge ${mdTitle} into ${svTitle}`}>
          {busy ? 'Merging…' : `Merge ${mdTitle} → ${svTitle}`}
        </button>
        <button className="btn link" onClick={onCancel} disabled={busy}>Cancel</button>
        <div className="spacer" style={{ flex: 1 }} />
        <span className="muted small">
          {finalEmailsCount + finalPhonesCount === 0
            ? 'No emails or phones will be kept.'
            : `${finalEmailsCount} email${finalEmailsCount === 1 ? '' : 's'} · ${finalPhonesCount} phone${finalPhonesCount === 1 ? '' : 's'}`}
        </span>
      </div>
    </div>
  );
}

export default function StaffVendors() {
  const { can } = useAuth();
  const isAdmin = can('manage_vendors');
  const [rows, setRows] = useState(null);
  const [type, setType] = useState('');
  const [q, setQ] = useState('');
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState(null);   // vendor id being edited
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [msg, setMsg] = useState('');
  // Manual merge (owner-directed 2026-07-21): mergePick = { survivorId, mergedId }.
  const [mergePick, setMergePick] = useState(null);
  const [mergePickChoice, setMergePickChoice] = useState(null);   // vendor id when picking a merge partner

  // Last-request-wins: switching vendor types fast must never let a slow
  // earlier type's response overwrite the current one (vanishing-search class).
  const loadSeq = useRef(0);
  const load = () => {
    const mine = ++loadSeq.current;
    return api.staffVendors(type)
      .then(r => { if (mine === loadSeq.current) setRows(r); })
      .catch(e => { if (mine === loadSeq.current) setErr(e.message); });
  };
  useEffect(() => { load(); /* eslint-disable-next-line */ }, [type]);
  const flash = (t) => { setMsg(t); setTimeout(() => setMsg(''), 3000); };

  const gate = useSubmitGate();
  async function add(f) {
    if (!gate.enter()) return;             // a vendor add is already in flight
    setBusy(true); setErr('');
    try { await api.staffAddVendor(f); setAdding(false); flash('Vendor added ✓'); await load(); }
    catch (e) { setErr(e.message || 'Could not add'); } finally { setBusy(false); gate.leave(); }
  }
  async function saveEdit(id, f) {
    setBusy(true); setErr('');
    try { await api.staffUpdateVendor(id, f); setEditing(null); flash('Saved ✓'); await load(); }
    catch (e) { setErr(e.message || 'Could not save'); } finally { setBusy(false); }
  }
  async function del(v) {
    if (!window.confirm(`Delete this ${TYPE_LABEL[v.contact_type] || 'vendor'} (${v.company_name || v.contact_name || v.email})? Borrowers will no longer see it in autocomplete.`)) return;
    try { await api.staffDeleteVendor(v.id); flash('Deleted ✓'); await load(); }
    catch (e) { setErr(e.message || 'Could not delete'); }
  }
  async function doMerge(body) {
    setBusy(true); setErr('');
    try { await api.staffMergeVendors(body); setMergePick(null); setMergePickChoice(null); flash('Merged ✓'); await load(); }
    catch (e) { setErr(e.message || 'Could not merge'); } finally { setBusy(false); }
  }

  // Directory KPIs — derived purely from the vendor rows the screen already holds
  // (each row carries contact_type + files_used). No new data is fetched.
  const stats = useMemo(() => {
    const list = rows || [];
    const by = (t) => list.filter(v => v.contact_type === t).length;
    return {
      total: list.length,
      title: by('title_company'),
      insurance: by('insurance_agent'),
      files: list.reduce((n, v) => n + (Number(v.files_used) || 0), 0),
    };
  }, [rows]);

  if (!isAdmin) return <div role="alert" className="notice err">The vendor directory is admin-only.</div>;
  const needle = q.trim().toLowerCase();
  const shown = (rows || []).filter(v => !needle
    || [v.company_name, v.contact_name, v.email, v.phone].some(x => String(x || '').toLowerCase().includes(needle)));

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Vendors</h1>
          <div className="sub">Every title company and insurance agent entered across the platform — curate them here.</div>
        </div>
        <div className="page-head-actions">
          <button className="btn btn-ink btn-sm" onClick={() => { setAdding(a => !a); setEditing(null); }}>{adding ? 'Close' : '+ Add vendor'}</button>
        </div>
      </div>
      {msg && <div className="notice ok">{msg}</div>}
      {err && <div role="alert" className="notice err">{err}</div>}

      {rows != null && (
        <div className="kpi-grid" style={{ margin: '4px 0 14px' }}>
          <div className="kpi"><div className="v">{stats.total}</div><div className="k">Vendors</div><div className="d">In the directory</div></div>
          <div className="kpi"><div className="v">{stats.title}</div><div className="k">Title companies</div></div>
          <div className="kpi"><div className="v">{stats.insurance}</div><div className="k">Insurance agents</div></div>
          <div className="kpi"><div className="v">{stats.files}</div><div className="k">Files referenced</div><div className="d">Across all vendors</div></div>
        </div>
      )}

      {adding && <VendorForm initial={blank()} busy={busy} onSave={add} onCancel={() => setAdding(false)} />}

      {/* Duplicate suggestions (owner-directed 2026-07-21): the server flagged
          vendors sharing a company name / email / phone with another vendor of
          the same type. The banner surfaces each cluster with a Merge button. */}
      {(() => {
        const list = rows || [];
        const groups = new Map();
        for (const v of list) if (v.duplicate_group) {
          const k = v.duplicate_group;
          if (!groups.has(k)) groups.set(k, []);
          groups.get(k).push(v);
        }
        if (!groups.size) return null;
        return (
          <div className="notice" role="region" aria-label="Duplicate vendor suggestions"
            style={{ margin: '0 0 12px', background: 'var(--gold-soft, rgba(174,135,70,.08))',
              borderLeft: '3px solid var(--gold, #AE8746)', padding: '12px 14px', borderRadius: 10 }}>
            <div className="row" style={{ alignItems: 'baseline', gap: 8, marginBottom: 4 }}>
              <span aria-hidden="true" style={{ fontSize: 16 }}>⚠</span>
              <strong>Possible duplicates ({groups.size} group{groups.size === 1 ? '' : 's'})</strong>
              <div className="spacer" style={{ flex: 1 }} />
              <span className="muted small">Sharing a name, email or phone</span>
            </div>
            <div className="muted small" style={{ marginBottom: 8 }}>
              Merge combines emails, phones, and files onto one row — the "loser" is soft-deleted (never truly gone).
            </div>
            <ul style={{ margin: '0', paddingLeft: 18, listStyle: 'square' }}>
              {[...groups.values()].map((grp) => (
                <li key={grp[0].id} style={{ marginBottom: 6 }}>
                  <div className="row" style={{ gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
                    <span style={{ flex: 1, minWidth: 200 }}>
                      {grp.map((v, i) => (
                        <React.Fragment key={v.id}>
                          {i > 0 && <span className="muted" style={{ margin: '0 6px' }}>·</span>}
                          <strong>{v.company_name || v.contact_name || v.email || v.id}</strong>
                        </React.Fragment>
                      ))}
                    </span>
                    {grp.length === 2 && (
                      <button className="btn primary small"
                        onClick={() => setMergePick({ survivorId: grp[0].id, mergedId: grp[1].id })}
                        aria-label={`Merge ${grp[1].company_name || grp[1].contact_name || grp[1].email} into ${grp[0].company_name || grp[0].contact_name || grp[0].email}`}>
                        Review & merge
                      </button>
                    )}
                    {grp.length > 2 && (
                      <span className="muted small">
                        {grp.length} vendors · use the row <strong>Merge</strong> action pairwise
                      </span>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          </div>
        );
      })()}

      {mergePick && (() => {
        const survivor = (rows || []).find((v) => v.id === mergePick.survivorId);
        const merged = (rows || []).find((v) => v.id === mergePick.mergedId);
        if (!survivor || !merged) return null;
        return <MergeVendorPanel survivor={survivor} merged={merged} busy={busy}
          onMerged={doMerge} onCancel={() => setMergePick(null)} />;
      })()}

      <div className="row" style={{ gap: 8, margin: '12px 0', flexWrap: 'wrap' }}>
        <select className="input" style={{ maxWidth: 180 }} value={type} onChange={e => setType(e.target.value)}>
          <option value="">All types</option>
          {TYPES.map(t => <option key={t.v} value={t.v}>{t.label}</option>)}
        </select>
        <input className="input" style={{ maxWidth: 280 }} placeholder="Search name / email / phone…" value={q} onChange={e => setQ(e.target.value)} />
        <span className="muted small" style={{ alignSelf: 'center' }}>{shown.length} vendor{shown.length === 1 ? '' : 's'}</span>
      </div>

      <div className="panel">
        <div className="panel-h">
          <h3>Directory</h3>
          <span className="pill mut">{shown.length} of {rows ? rows.length : 0}</span>
        </div>
        {rows == null ? <div className="panel-b"><p className="muted small">Loading…</p></div>
          : shown.length === 0 ? <div className="empty-state"><h3>No vendors match</h3><p>Try a different type or search term, or add a new vendor.</p></div>
          : (
            <div className="tbl-wrap">
              <table className="tbl tbl-vendors">
                <thead>
                  <tr>
                    <th>Company</th>
                    <th>Type</th>
                    <th>Contact</th>
                    <th>Phone</th>
                    <th className="num">Files</th>
                    <th>Added by</th>
                    <th className="actc"></th>
                  </tr>
                </thead>
                <tbody>
                  {shown.map(v => (
                    <React.Fragment key={v.id}>
                      <tr>
                        <td data-label="Company">
                          <div className="co">
                            <span className="mono">{initials(v.company_name || v.contact_name || v.email)}</span>
                            <span>
                              <span className="nm">{v.company_name || v.contact_name || v.email || '—'}</span>
                              {v.notes && <span className="id">{v.notes}</span>}
                            </span>
                          </div>
                        </td>
                        <td data-label="Type"><span className="tchip"><span className={`sw ${SWATCH[v.contact_type] || ''}`} />{TYPE_LABEL[v.contact_type] || v.contact_type}</span></td>
                        <td data-label="Contact">
                          <span className="ct-nm">{v.contact_name || '—'}</span>
                          {v.email && <span className="ct-em">{v.email}</span>}
                        </td>
                        <td data-label="Phone"><span className="num">{v.phone || '—'}</span></td>
                        <td className="num files-c" data-label="Files">{v.files_used || 0}</td>
                        <td data-label="Added by"><span className="mut">{v.added_by_staff ? `${v.added_by_staff} (staff)` : v.added_by_borrower ? `${v.added_by_borrower} (borrower)` : '—'}</span></td>
                        <td className="actc" data-label="">
                          <button className="rowbtn" onClick={() => { setEditing(editing === v.id ? null : v.id); setAdding(false); }}>{editing === v.id ? 'Close' : 'Edit'}</button>
                          <button className="rowbtn" title="Merge this vendor into another one — combines emails, phones, and files"
                            onClick={() => setMergePickChoice(mergePickChoice === v.id ? null : v.id)}>
                            {mergePickChoice === v.id ? 'Pick target…' : 'Merge'}
                          </button>
                          <button className="rowbtn danger" onClick={() => del(v)}>Delete</button>
                        </td>
                      </tr>
                      {editing === v.id && (
                        <tr className="editrow">
                          <td colSpan={7} data-label="">
                            <VendorForm busy={busy}
                              initial={{ contactType: v.contact_type,
                                companyName: v.company_name || '', contactName: v.contact_name || '',
                                emails: (v.emails && v.emails.length ? v.emails : (v.email ? [v.email] : [''])),
                                phones: (v.phones && v.phones.length ? v.phones : (v.phone ? [v.phone] : [''])),
                                address: v.address || '', notes: v.notes || '' }}
                              onSave={(f) => saveEdit(v.id, f)} onCancel={() => setEditing(null)} />
                          </td>
                        </tr>
                      )}
                      {mergePickChoice === v.id && (() => {
                        const candidates = (rows || []).filter((x) =>
                          x.id !== v.id && x.contact_type === v.contact_type && !x.merged_into_id);
                        return (
                          <tr className="editrow">
                            <td colSpan={7} data-label="">
                              <div className="panel" style={{ background: 'var(--surface-soft)',
                                borderLeft: '3px solid var(--gold, #AE8746)' }} role="dialog"
                                aria-label={`Pick a vendor to merge ${v.company_name || v.contact_name || v.email} into`}>
                                <div className="row" style={{ marginBottom: 10, gap: 10, alignItems: 'baseline', flexWrap: 'wrap' }}>
                                  <strong>Merge <em>{v.company_name || v.contact_name || v.email}</em> into…</strong>
                                  <div className="spacer" style={{ flex: 1 }} />
                                  <span className="muted small">
                                    The one you pick keeps its row; this vendor's emails, phones and files fold in.
                                  </span>
                                </div>
                                {candidates.length === 0 ? (
                                  <div className="empty-state" style={{ padding: '10px 12px' }}>
                                    <p className="muted small" style={{ margin: 0 }}>
                                      No other {TYPE_LABEL[v.contact_type] || 'vendor'}s to merge into.
                                    </p>
                                  </div>
                                ) : (
                                  <div style={{ maxHeight: 320, overflowY: 'auto',
                                    border: '1px solid var(--line)', borderRadius: 10, background: 'var(--surface)' }}>
                                    {candidates.map((x, i) => (
                                      <div key={x.id} className="row"
                                        style={{ padding: '10px 14px', gap: 10, alignItems: 'center',
                                          borderBottom: i < candidates.length - 1 ? '1px solid var(--line)' : 'none' }}>
                                        <span className="mono" style={{ width: 30, height: 30, borderRadius: 999,
                                          background: 'var(--surface-soft)', border: '1px solid var(--line)',
                                          display: 'grid', placeItems: 'center', fontSize: 11, fontWeight: 600,
                                          color: 'var(--muted)' }}>
                                          {initials(x.company_name || x.contact_name || x.email)}
                                        </span>
                                        <div style={{ flex: 1, minWidth: 0 }}>
                                          <div style={{ fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis' }}>
                                            {x.company_name || x.contact_name || x.email || '—'}
                                          </div>
                                          <div className="muted small" style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>
                                            {[x.contact_name, x.email, x.phone].filter(Boolean).join(' · ') || '—'}
                                          </div>
                                        </div>
                                        {x.files_used > 0 && (
                                          <span className="pill mut small" title="Files this vendor is attached to">
                                            {x.files_used} file{x.files_used === 1 ? '' : 's'}
                                          </span>
                                        )}
                                        <button className="btn primary small"
                                          onClick={() => { setMergePickChoice(null); setMergePick({ survivorId: x.id, mergedId: v.id }); }}
                                          aria-label={`Merge ${v.company_name || v.contact_name || v.email} into ${x.company_name || x.contact_name || x.email}`}>
                                          Merge into this
                                        </button>
                                      </div>
                                    ))}
                                  </div>
                                )}
                                <div className="row" style={{ gap: 8, marginTop: 10 }}>
                                  <button className="btn link small" onClick={() => setMergePickChoice(null)}>Cancel</button>
                                </div>
                              </div>
                            </td>
                          </tr>
                        );
                      })()}
                    </React.Fragment>
                  ))}
                </tbody>
              </table>
            </div>
          )}
      </div>
    </>
  );
}
