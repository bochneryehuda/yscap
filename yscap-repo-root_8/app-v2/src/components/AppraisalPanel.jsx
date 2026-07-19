import React, { useEffect, useState, useCallback } from 'react';
import { api } from '../lib/api.js';

/* Appraisal desk (staff). Imports the appraisal XML, shows the property profile read
   from it, and drives the PILOT findings workflow (appraisal vs the loan file). Read-only
   for the data; the only writes are the finding actions, which the backend audits and which
   never overwrite the file silently. Defensive against any missing field. */

const money = (n) => (n == null || n === '' ? '—' : '$' + Number(n).toLocaleString('en-US'));
const or = (v) => (v == null || v === '' ? '—' : v);

function readFileAsBase64(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result || '').split(',').pop()); // strip the data: prefix
    r.onerror = reject;
    r.readAsDataURL(file);
  });
}

const SEV = {
  fatal: { bg: 'var(--crit-bg,#F6E7E4)', fg: 'var(--crit,#B4483C)', label: 'Fatal' },
  warning: { bg: 'var(--amber-bg,#F6EEDD)', fg: 'var(--amber,#B7791F)', label: 'Warning' },
  info: { bg: 'rgba(47,127,134,.14)', fg: 'var(--teal-deep,#256168)', label: 'Info' },
};

function Finding({ appId, f, onChange, readOnly }) {
  const [busy, setBusy] = useState(false);
  const [custom, setCustom] = useState('');
  const [showCustom, setShowCustom] = useState(false);
  const s = SEV[f.severity] || SEV.info;
  const act = async (action, value) => {
    setBusy(true);
    try { await api.appraisalResolveFinding(appId, f.id, { action, value, note: '' }); onChange && onChange(); }
    catch (e) { alert(e.message || 'Could not resolve'); }
    finally { setBusy(false); }
  };
  const canWriteBack = ['arv', 'as_is_value', 'purchase_price', 'units', 'property_type'].includes(f.field);
  return (
    <div style={{ border: '1px solid var(--line,#E7E1D3)', borderLeft: `4px solid ${s.fg}`, borderRadius: 12, background: 'var(--card,#fff)', padding: '14px 16px', marginBottom: 12 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 6 }}>
        <span style={{ fontSize: 11, fontWeight: 800, textTransform: 'uppercase', letterSpacing: '.06em', color: s.fg, background: s.bg, padding: '3px 8px', borderRadius: 6 }}>{s.label}</span>
        <strong style={{ fontSize: 14 }}>{f.title}</strong>
      </div>
      {f.appraisal_value != null && (
        <div style={{ display: 'flex', gap: 24, fontSize: 13, margin: '6px 0' }}>
          <span>Appraisal: <b style={{ color: 'var(--teal-deep,#256168)' }}>{f.appraisal_value}</b></span>
          {f.file_value != null && <span>Our file: <b>{f.file_value}</b></span>}
        </div>
      )}
      {f.how_to && <div style={{ fontSize: 12.5, color: 'var(--muted,#4B585C)', marginBottom: readOnly ? 0 : 10 }}>{f.how_to}</div>}
      {/* Borrowers SEE every finding but never act on it — the actions are our team's. */}
      {!readOnly && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
          {canWriteBack && <button disabled={busy} onClick={() => act('replace')} style={btn(true)}>Replace with appraisal · re-prices</button>}
          <button disabled={busy} onClick={() => act('keep')} style={btn()}>Keep file value</button>
          {canWriteBack && <button disabled={busy} onClick={() => setShowCustom((v) => !v)} style={btn()}>Enter custom…</button>}
          <button disabled={busy} onClick={() => act('dismiss')} style={btn()}>Dismiss</button>
          {f.severity === 'fatal' && <button disabled={busy} onClick={() => { if (confirm('Decline this file?')) act('decline'); }} style={btn(false, true)}>Decline file</button>}
        </div>
      )}
      {!readOnly && showCustom && (
        <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
          <input value={custom} onChange={(e) => setCustom(e.target.value)} placeholder="new value" style={{ padding: '7px 10px', border: '1px solid var(--line,#E7E1D3)', borderRadius: 8, fontSize: 14 }} />
          <button disabled={busy || !custom} onClick={() => act('custom', custom)} style={btn(true)}>Save · re-prices</button>
        </div>
      )}
    </div>
  );
}

function btn(primary, danger) {
  return {
    fontSize: 12.5, fontWeight: 600, borderRadius: 8, padding: '7px 13px', cursor: 'pointer',
    border: '1px solid ' + (primary ? 'var(--teal,#2F7F86)' : danger ? 'color-mix(in srgb,var(--crit,#B4483C) 35%,var(--line,#E7E1D3))' : 'var(--line,#E7E1D3)'),
    background: primary ? 'var(--teal,#2F7F86)' : 'transparent',
    color: primary ? '#fff' : danger ? 'var(--crit,#B4483C)' : 'var(--ink,#141B22)',
  };
}

function Fact({ label, value }) {
  return (
    <div style={{ minWidth: 0 }}>
      <div style={{ fontSize: 10.5, fontWeight: 700, letterSpacing: '.06em', textTransform: 'uppercase', color: 'var(--muted,#4B585C)' }}>{label}</div>
      <div style={{ fontSize: 15, fontWeight: 600, fontFamily: 'var(--serif,Georgia,serif)', overflowWrap: 'anywhere' }}>{value}</div>
    </div>
  );
}

export default function AppraisalPanel({ appId, readOnly = false, onSummary }) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState('');
  const [importing, setImporting] = useState(false);

  const load = useCallback(async () => {
    setLoading(true); setErr('');
    try {
      const d = readOnly ? await api.appraisalGetBorrower(appId) : await api.appraisalGet(appId);
      setData(d);
      // Report the summary up ONLY when an appraisal actually exists, so the section
      // nav badge (and the borrower section's presence) reflects real data, not an
      // empty placeholder response.
      if (onSummary) onSummary(d && d.appraisal ? (d.summary || null) : null);
    } catch (e) { setErr(e.message || 'Could not load the appraisal'); }
    finally { setLoading(false); }
  }, [appId, onSummary, readOnly]);

  useEffect(() => { load(); }, [load]);

  const onFile = async (e) => {
    const file = e.target.files && e.target.files[0];
    e.target.value = '';
    if (!file) return;
    setImporting(true); setErr('');
    try {
      const xmlBase64 = await readFileAsBase64(file);
      await api.appraisalImport(appId, { xmlBase64, filename: file.name });
      await load();
    } catch (e2) { setErr(e2.message || 'Import failed'); }
    finally { setImporting(false); }
  };

  if (loading) return <p style={{ color: 'var(--muted,#4B585C)' }}>Loading the appraisal…</p>;

  const a = data && data.appraisal;
  const sum = (data && data.summary) || { fatal: 0, warning: 0, info: 0, blocksCtc: false };
  const findings = (data && data.findings) || [];

  return (
    <div>
      {err && <p style={{ color: 'var(--crit,#B4483C)', fontSize: 13 }}>{err}</p>}

      {/* import row — staff only. Borrowers see the report, never the upload. */}
      {!readOnly ? (
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 18, flexWrap: 'wrap' }}>
          <label style={{ ...btn(true), display: 'inline-flex', alignItems: 'center', gap: 8 }}>
            {importing ? 'Importing…' : a ? 'Re-import appraisal XML' : 'Import appraisal XML'}
            <input type="file" accept=".xml,text/xml,application/xml" onChange={onFile} disabled={importing} style={{ display: 'none' }} />
          </label>
          {a && <span style={{ fontSize: 12.5, color: 'var(--muted,#4B585C)' }}>Form {or(a.form_type)} · effective {or(a.effective_date)} · imported {a.imported_at ? String(a.imported_at).slice(0, 10) : '—'}</span>}
        </div>
      ) : (
        a && <div style={{ fontSize: 12.5, color: 'var(--muted,#4B585C)', marginBottom: 16 }}>Form {or(a.form_type)} · effective {or(a.effective_date)}</div>
      )}

      {!a && !importing && (
        <p style={{ color: 'var(--muted,#4B585C)' }}>{readOnly ? 'The appraisal report will appear here once it has been received and reviewed.' : 'No appraisal imported yet. Upload the appraisal XML — the property profile and the underwriting review are built from it automatically.'}</p>
      )}

      {a && (
        <>
          {/* findings summary + gate */}
          {(sum.fatal > 0 || sum.warning > 0) && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 14, flexWrap: 'wrap' }}>
              {sum.fatal > 0 && <span style={{ fontWeight: 700, color: SEV.fatal.fg, background: SEV.fatal.bg, borderRadius: 999, padding: '4px 12px', fontSize: 12.5 }}>{sum.fatal} fatal</span>}
              {sum.warning > 0 && <span style={{ fontWeight: 700, color: SEV.warning.fg, background: SEV.warning.bg, borderRadius: 999, padding: '4px 12px', fontSize: 12.5 }}>{sum.warning} warning</span>}
              {sum.blocksCtc && <span style={{ fontSize: 12.5, color: SEV.fatal.fg }}>Clear-to-close is blocked until every fatal is resolved.</span>}
            </div>
          )}

          {/* PILOT findings */}
          {findings.length > 0 ? (
            <div style={{ marginBottom: 24 }}>
              <h4 style={{ fontFamily: 'var(--serif,Georgia,serif)', margin: '0 0 12px' }}>PILOT findings — appraisal vs file</h4>
              {findings.map((f) => <Finding key={f.id} appId={appId} f={f} onChange={load} readOnly={readOnly} />)}
            </div>
          ) : (
            <p style={{ color: 'var(--good,#3F7A5B)', fontSize: 13, marginBottom: 20 }}>✓ No open findings — the appraisal matches the file.</p>
          )}

          {/* property profile */}
          <h4 style={{ fontFamily: 'var(--serif,Georgia,serif)', margin: '0 0 12px' }}>Property profile</h4>
          <div style={{ background: 'var(--card,#fff)', border: '1px solid var(--line,#E7E1D3)', borderRadius: 14, padding: 18 }}>
            <div style={{ fontSize: 20, fontWeight: 600, fontFamily: 'var(--serif,Georgia,serif)', marginBottom: 4 }}>
              {or(a.subject_address)}
            </div>
            <div style={{ color: 'var(--muted,#4B585C)', marginBottom: 16 }}>
              {[a.subject_city, a.subject_state, a.subject_zip].filter(Boolean).join(', ') || '—'}{a.subject_county ? ` · ${a.subject_county} County` : ''}
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill,minmax(140px,1fr))', gap: 16 }}>
              <Fact label="As-Is value" value={money(a.as_is_value)} />
              <Fact label="ARV" value={money(a.arv_value)} />
              <Fact label="Appraised" value={money(a.appraised_value)} />
              <Fact label="Condition" value={or(a.condition_of_appraisal)} />
              <Fact label="Year built" value={or(a.year_built)} />
              <Fact label="Units" value={or(a.units)} />
              <Fact label="GLA (sq ft)" value={a.gla ? Number(a.gla).toLocaleString('en-US') : '—'} />
              <Fact label="Beds / baths" value={`${or(a.beds)} / ${a.baths_full != null ? a.baths_full + (a.baths_half ? '.' + a.baths_half : '') : '—'}`} />
              <Fact label="Zoning" value={or(a.zoning_id)} />
              <Fact label="Condition / quality" value={`${or(a.condition_uad)} / ${or(a.quality_uad)}`} />
              <Fact label="Cost approach" value={money(a.value_cost_approach)} />
              <Fact label="Income / GRM" value={a.value_income_approach ? `${money(a.value_income_approach)} · ${or(a.grm)}` : '—'} />
            </div>

            {a.condo_project_name && (
              <div style={{ marginTop: 16, paddingTop: 16, borderTop: '1px solid var(--line-soft,#EFEADD)', display: 'grid', gridTemplateColumns: 'repeat(auto-fill,minmax(140px,1fr))', gap: 16 }}>
                <Fact label="Condo project" value={or(a.condo_project_name)} />
                <Fact label="Unit / floor" value={`${or(a.condo_unit_identifier)} · ${or(a.condo_floor)}`} />
                <Fact label="HOA fee" value={a.hoa_fee_amount != null ? `${money(a.hoa_fee_amount)} / ${(a.hoa_fee_period || '').toLowerCase() || 'mo'}` : '—'} />
              </div>
            )}

            <div style={{ marginTop: 16, paddingTop: 16, borderTop: '1px solid var(--line-soft,#EFEADD)', display: 'grid', gridTemplateColumns: 'repeat(auto-fill,minmax(160px,1fr))', gap: 16 }}>
              <Fact label="Appraiser" value={or(a.appraiser_name)} />
              <Fact label="Company" value={or(a.appraiser_company)} />
              <Fact label="License" value={a.license_id ? `${a.license_id}${a.license_state ? ' · ' + a.license_state : ''}` : '—'} />
              <Fact label="License exp." value={or(a.license_exp)} />
              <Fact label="Comparables" value={(data.comparables || []).length || '—'} />
            </div>
          </div>

          {/* comps */}
          {(data.comparables || []).length > 0 && (
            <div style={{ marginTop: 18, overflowX: 'auto' }}>
              <h4 style={{ fontFamily: 'var(--serif,Georgia,serif)', margin: '0 0 10px' }}>Comparable sales</h4>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
                <thead>
                  <tr style={{ textAlign: 'left', color: 'var(--muted,#4B585C)' }}>
                    <th style={th}>#</th><th style={th}>Address</th><th style={th}>Proximity</th>
                    <th style={{ ...th, textAlign: 'right' }}>Sale price</th><th style={{ ...th, textAlign: 'right' }}>Adjusted</th>
                  </tr>
                </thead>
                <tbody>
                  {(data.comparables || []).map((c) => (
                    <tr key={c.id} style={{ borderTop: '1px solid var(--line-soft,#EFEADD)' }}>
                      <td style={td}>{c.seq}</td>
                      <td style={td}>{or(c.address)}{c.city ? `, ${c.city} ${c.state || ''}` : ''}</td>
                      <td style={td}>{or(c.proximity)}</td>
                      <td style={{ ...td, textAlign: 'right' }}>{money(c.sale_price)}</td>
                      <td style={{ ...td, textAlign: 'right' }}>{money(c.adjusted_price)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </div>
  );
}

const th = { padding: '6px 10px', fontSize: 11, fontWeight: 700, letterSpacing: '.05em', textTransform: 'uppercase', whiteSpace: 'nowrap' };
const td = { padding: '8px 10px', fontVariantNumeric: 'tabular-nums' };
