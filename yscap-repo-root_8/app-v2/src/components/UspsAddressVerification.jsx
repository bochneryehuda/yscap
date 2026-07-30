import React, { useEffect, useState } from 'react';
import { api } from '../lib/api.js';

function addressLine(a) {
  if (!a) return 'Not available';
  if (typeof a === 'string') return a;
  return a.oneLine || [
    [a.line1 || a.street, a.unit || a.secondary].filter(Boolean).join(' '),
    a.city,
    [a.state, a.zip].filter(Boolean).join(' '),
  ].filter(Boolean).join(', ');
}

function Status({ value }) {
  const good = value === 'verified' || value === 'corrected';
  const text = value === 'verified' ? 'USPS verified'
    : value === 'corrected' ? 'USPS verified with corrections'
      : value === 'unverified' ? 'Not confirmed deliverable by USPS'
        : value ? value.replaceAll('_', ' ') : 'Not checked';
  return <span className="pill" style={good ? { borderColor: 'var(--ok)', color: 'var(--ok)' } : undefined}>{text}</span>;
}

export default function UspsAddressVerification({ appId, onChanged }) {
  const [open, setOpen] = useState(false);
  const [data, setData] = useState(null);
  const [busy, setBusy] = useState('');
  const [err, setErr] = useState('');

  async function load() {
    setErr('');
    try { setData(await api.get(`/api/staff/applications/${appId}/usps-verification`)); }
    catch (e) { setErr(e.message || 'Could not load USPS verification.'); }
  }
  useEffect(() => { if (open) load(); }, [open, appId]);

  async function check() {
    setBusy('check'); setErr('');
    try {
      await api.post(`/api/staff/applications/${appId}/usps-verification/check`, {});
      await load();
    } catch (e) { setErr(e.message || 'USPS verification failed.'); }
    finally { setBusy(''); }
  }
  async function importAddress() {
    setBusy('import'); setErr('');
    try {
      await api.post(`/api/staff/applications/${appId}/usps-verification/import`, {});
      await load();
      if (onChanged) await onChanged();
    } catch (e) { setErr(e.message || 'Could not import the USPS address.'); }
    finally { setBusy(''); }
  }

  const importable = data && ['verified', 'corrected'].includes(String(data.usps_match || '').toLowerCase())
    && data.usps_address && !data.usps_imported_at;

  return (
    <>
      <button className="btn primary small" onClick={() => setOpen(true)}>
        Open USPS Address Verification
      </button>
      {open && (
        <div role="dialog" aria-modal="true" aria-labelledby="usps-dialog-title"
          style={{ position: 'fixed', inset: 0, zIndex: 10000, background: 'rgba(13,20,24,.62)', display: 'grid', placeItems: 'center', padding: 20 }}
          onMouseDown={(e) => { if (e.target === e.currentTarget && !busy) setOpen(false); }}>
          <div className="panel" style={{ width: 'min(720px, 100%)', maxHeight: '90vh', overflow: 'auto', background: '#fff', color: '#141B22', padding: 22 }}>
            <div className="row" style={{ alignItems: 'flex-start', gap: 12 }}>
              <div style={{ flex: 1 }}>
                <h2 id="usps-dialog-title" style={{ margin: 0 }}>USPS Address Verification</h2>
                <p className="muted small">Compare the working subject address with the official USPS result. The condition clears only when you import a verified address.</p>
              </div>
              <button className="btn ghost small" disabled={!!busy} onClick={() => setOpen(false)} aria-label="Close">Close</button>
            </div>

            {!data && !err && <div className="muted">Loading…</div>}
            {data && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
                {!data.configured && <div className="notice err">USPS is not configured on this service. Add USPS_CLIENT_ID and USPS_CLIENT_SECRET.</div>}
                <div className="panel" style={{ padding: 12 }}>
                  <div className="small muted">Current working address</div>
                  <div style={{ fontWeight: 600, marginTop: 3 }}>{addressLine(data.property_address)}</div>
                </div>
                <div className="panel" style={{ padding: 12, borderColor: data.usps_address ? 'var(--ok)' : undefined }}>
                  <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
                    <div className="small muted" style={{ flex: 1 }}>Official USPS result</div>
                    <Status value={data.usps_match} />
                  </div>
                  <div style={{ fontWeight: 600, marginTop: 6 }}>{addressLine(data.usps_address)}</div>
                  {data.usps_verified_at && <div className="muted small" style={{ marginTop: 4 }}>Checked {new Date(data.usps_verified_at).toLocaleString()}</div>}
                  {data.usps_imported_at && <div className="small" style={{ color: 'var(--ok)', marginTop: 4 }}>Imported {new Date(data.usps_imported_at).toLocaleString()} ✓</div>}
                </div>
                <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
                  <button className="btn ghost" disabled={!!busy || !data.configured} onClick={check}>
                    {busy === 'check' ? 'Checking USPS…' : data.usps_verified_at ? 'Check again with USPS' : 'Verify with USPS'}
                  </button>
                  <button className="btn primary" disabled={!!busy || !importable} onClick={importAddress}
                    title={importable ? 'Replace the working address with the verified USPS address and clear the condition' : 'A deliverable USPS result is required first'}>
                    {busy === 'import' ? 'Importing…' : data.usps_imported_at ? 'Verified address imported ✓' : 'Import verified address'}
                  </button>
                </div>
                <div className="muted small">“Verify” only stages USPS’s proposed address. “Import verified address” deliberately adopts it for financing exports and clears this required condition.</div>
              </div>
            )}
            {err && <div className="notice err" style={{ marginTop: 12 }}>{err}</div>}
          </div>
        </div>
      )}
    </>
  );
}
