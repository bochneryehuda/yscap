import React, { useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../lib/api.js';

/* USPS ADDRESS VERIFICATION — the required, staff-only condition screen.
 *
 * The workflow the owner asked for, in one dialog:
 *   1. It opens on the file's current subject address.
 *   2. "Verify with USPS" checks that address against the official USPS Addresses
 *      API and shows the standardized result beside it.
 *   3. If USPS can't confirm a deliverable address, staff CORRECT the address in
 *      the same screen and verify again — repeat until USPS returns a deliverable,
 *      standardized address (right ZIP+4, right unit, every digit).
 *   4. Only then can staff "Import verified address," which adopts the USPS form as
 *      the working property address, clears this condition, and unlocks ordering.
 *
 * Verifying never changes the file. Importing is the one deliberate human action
 * that adopts the USPS address — nothing here silently rewrites a live loan. */

// --- small pure helpers (mirror src/lib/usps-verify.js so the UI reads the same) --
function compsFrom(a) {
  if (!a || typeof a !== 'object' || Array.isArray(a)) {
    if (typeof a === 'string') return parseLine(a);
    return { line1: '', unit: '', city: '', state: '', zip: '' };
  }
  const line1 = a.line1 || a.street || '';
  if (line1) return { line1, unit: a.unit || a.secondary || '', city: a.city || '', state: a.state || '', zip: a.zip || a.zipcode || '' };
  const s = a.oneLine || a.formatted_address || a.address;
  return typeof s === 'string' ? parseLine(s) : { line1: '', unit: '', city: '', state: '', zip: '' };
}
function parseLine(s) {
  // Light client-side split — the server re-parses authoritatively; this only
  // prefills the edit boxes so staff aren't retyping a whole address.
  const parts = String(s || '').split(',').map((x) => x.trim()).filter(Boolean);
  const out = { line1: parts[0] || '', unit: '', city: '', state: '', zip: '' };
  if (parts.length >= 3) {
    out.city = parts[parts.length - 2] || '';
    const m = /([A-Za-z]{2})\s+(\d{5}(?:-\d{4})?)/.exec(parts[parts.length - 1] || '');
    if (m) { out.state = m[1].toUpperCase(); out.zip = m[2]; }
  }
  return out;
}
function addressLine(a) {
  if (!a) return '';
  if (typeof a === 'string') return a;
  if (a.oneLine) return a.oneLine;
  const c = compsFrom(a);
  return [[c.line1, c.unit].filter(Boolean).join(' '), c.city, [c.state, c.zip].filter(Boolean).join(' ')].filter(Boolean).join(', ');
}
function sameComps(a, b) {
  return ['line1', 'unit', 'city', 'state', 'zip'].every((k) => String(a[k] || '').trim().toLowerCase() === String(b[k] || '').trim().toLowerCase());
}

// USPS Delivery Point Validation, in plain language (matches usps-verify.deliverability).
function dpvRead(dpv) {
  const code = dpv && dpv.dpvConfirmation ? String(dpv.dpvConfirmation).toUpperCase() : null;
  if (!dpv) return null;
  if (code === 'Y') return { tone: 'ok', label: 'Confirmed deliverable — primary and unit both match USPS.' };
  if (code === 'D') return { tone: 'ok', label: 'USPS confirms delivery to this building. An apartment/suite is optional — import this address as-is, or add the unit if you have it.' };
  if (code === 'S') return { tone: 'muted', label: 'USPS confirms delivery to this building but didn’t recognize the apartment/suite entered. The unit is optional — import as-is, or correct it if you have it.' };
  if (code === 'N') return { tone: 'bad', label: 'USPS could not confirm a deliverable point here. Correct the address and re-verify.' };
  return { tone: 'muted', label: 'USPS returned no delivery-point confirmation.' };
}
const YN = (v) => String(v || '').toUpperCase() === 'Y';

// Highlight the tokens in the USPS one-line that differ from what was entered.
function diffedTokens(fromStr, toStr) {
  const from = new Set(String(fromStr || '').toLowerCase().replace(/,/g, ' ').split(/\s+/).filter(Boolean));
  return String(toStr || '').split(/(\s+)/).map((tok, i) => {
    const bare = tok.trim().replace(/,$/, '').toLowerCase();
    const changed = bare && tok.trim() && !from.has(bare);
    return { key: i, tok, changed };
  });
}

function StatusBadge({ status, imported }) {
  const map = {
    verified: { t: 'USPS verified', tone: 'ok' },
    corrected: { t: 'Verified with corrections', tone: 'warn' },
    unverified: { t: 'Not confirmed deliverable', tone: 'bad' },
    not_configured: { t: 'USPS not configured', tone: 'muted' },
    rate_limited: { t: 'USPS limit reached', tone: 'muted' },
    error: { t: 'USPS unavailable', tone: 'muted' },
  };
  const s = imported ? { t: 'Imported ✓', tone: 'ok' } : (map[String(status || '').toLowerCase()] || { t: 'Not checked', tone: 'muted' });
  const c = { ok: 'var(--ok)', warn: 'var(--warning)', bad: 'var(--danger)', muted: 'var(--text-soft)' }[s.tone];
  return (
    <span className="pill" style={{ borderColor: c, color: c, background: 'var(--surface)' }}>
      <span aria-hidden="true" style={{ width: 7, height: 7, borderRadius: 9, background: c, display: 'inline-block' }} />
      {s.t}
    </span>
  );
}

const FIELD = { display: 'block' };
const LABEL = { display: 'block', fontSize: 11, letterSpacing: '.4px', textTransform: 'uppercase', color: 'var(--text-soft)', marginBottom: 4 };

export default function UspsAddressVerification({ appId, onChanged }) {
  const [open, setOpen] = useState(false);
  const [data, setData] = useState(null);
  const [form, setForm] = useState({ line1: '', unit: '', city: '', state: '', zip: '' });
  const [verifiedInput, setVerifiedInput] = useState(null); // the form snapshot the current result was produced from
  const [busy, setBusy] = useState('');
  const [err, setErr] = useState('');
  const [errDetail, setErrDetail] = useState('');  // the technical "exactly why" line, when USPS gives one
  const [flash, setFlash] = useState('');
  const [ovrOpen, setOvrOpen] = useState(false);   // super-admin exception panel
  const [ovrReason, setOvrReason] = useState('');
  const dialogRef = useRef(null);
  const restoreRef = useRef(null);
  const busyRef = useRef('');
  busyRef.current = busy;

  async function load(prefill) {
    setErr('');
    try {
      const d = await api.get(`/api/staff/applications/${appId}/usps-verification`);
      setData(d);
      if (prefill) { setForm(compsFrom(d.property_address)); setVerifiedInput(null); }
      return d;
    } catch (e) { setErr(e.message || 'Could not load USPS verification.'); return null; }
  }

  function openDialog() { restoreRef.current = document.activeElement; setFlash(''); setOpen(true); }
  useEffect(() => { if (open) load(true); }, [open, appId]);

  // Accessible dialog: focus in on open, trap Tab, Escape closes, focus restored.
  useEffect(() => {
    if (!open) return undefined;
    const el = dialogRef.current;
    const focusables = () => Array.from(el.querySelectorAll('button,[href],input,select,textarea,[tabindex]:not([tabindex="-1"])'))
      .filter((x) => !x.disabled && x.offsetParent !== null);
    const t = setTimeout(() => { const f = focusables(); (f[0] || el).focus(); }, 0);
    function onKey(e) {
      if (e.key === 'Escape' && !busyRef.current) { e.preventDefault(); setOpen(false); return; }
      if (e.key !== 'Tab') return;
      const f = focusables();
      if (!f.length) return;
      const first = f[0], last = f[f.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    }
    document.addEventListener('keydown', onKey);
    return () => { clearTimeout(t); document.removeEventListener('keydown', onKey); const r = restoreRef.current; if (r && r.focus) r.focus(); };
  }, [open]);

  const setField = (k) => (e) => { setForm((f) => ({ ...f, [k]: e.target.value })); };

  async function check() {
    if (!form.line1 || !form.state) { setErr('Enter at least a street address and state, then verify.'); return; }
    setBusy('check'); setErr(''); setErrDetail(''); setFlash('');
    try {
      const r = await api.post(`/api/staff/applications/${appId}/usps-verification/check`, { address: form });
      setVerifiedInput({ ...form });
      await load(false);
      if (r && (r.status === 'verified' || r.status === 'corrected')) setFlash('USPS returned a deliverable address. Review it, then Import to adopt it.');
    } catch (e) {
      // Surface the plain reason AND the exact technical detail USPS gave, so the
      // owner can "see exactly why" instead of a generic "try again" (2026-08-05).
      setErr(e.message || 'USPS verification failed.');
      setErrDetail((e && e.data && e.data.detail) || '');
    }
    finally { setBusy(''); }
  }

  // SUPER-ADMIN EXCEPTION — accept the address and lift the whole USPS hold-back
  // (the condition AND the title / insurance / attorney ordering gates) when USPS
  // itself won't cooperate. Adopts the edited candidate if one was typed, else the
  // file's current address; records who + why on the file.
  async function doOverride() {
    if (!ovrReason.trim()) { setErr('Add a reason for the exception — it’s saved on the file for everyone to see.'); return; }
    setBusy('override'); setErr(''); setFlash('');
    try {
      await api.post(`/api/staff/applications/${appId}/usps-verification/override`, {
        overrideReason: ovrReason.trim(),
        address: (form.line1 && form.state) ? form : undefined,
        lastError: errDetail || err || undefined,
      });
      setOvrOpen(false); setOvrReason('');
      await load(true);
      setFlash('Exception recorded. The address is accepted, the condition is cleared, and title / insurance / attorney ordering is unlocked.');
      if (onChanged) await onChanged();
    } catch (e) { setErr(e.message || 'Could not record the exception.'); }
    finally { setBusy(''); }
  }

  async function importAddress() {
    setBusy('import'); setErr(''); setFlash('');
    try {
      await api.post(`/api/staff/applications/${appId}/usps-verification/import`, {});
      const d = await load(true);
      setFlash('Imported. The USPS address is now the file address and the condition is cleared.');
      if (onChanged) await onChanged();
      return d;
    } catch (e) { setErr(e.message || 'Could not import the USPS address.'); }
    finally { setBusy(''); }
  }

  const status = data && String(data.usps_match || '').toLowerCase();
  const imported = !!(data && data.usps_imported_at);
  const hasResult = !!(data && data.usps_address);
  const deliverable = status === 'verified' || status === 'corrected';
  const formChanged = verifiedInput ? !sameComps(form, verifiedInput) : true;
  const importable = deliverable && hasResult && !imported && !formChanged;
  const dpv = data && data.usps_dpv;
  const read = dpvRead(dpv);

  const uspsOneLine = addressLine(data && data.usps_address);
  const enteredOneLine = addressLine(form);
  const tokens = useMemo(() => diffedTokens(enteredOneLine, uspsOneLine), [enteredOneLine, uspsOneLine]);

  return (
    <>
      <div className="row" style={{ gap: 8 }}>
        <button className="btn primary small" onClick={openDialog}>Open USPS Address Verification</button>
        {data && <StatusBadge status={status} imported={imported} />}
      </div>

      {open && (
        <div
          role="presentation"
          onMouseDown={(e) => { if (e.target === e.currentTarget && !busy) setOpen(false); }}
          style={{ position: 'fixed', inset: 0, zIndex: 10000, background: 'rgba(20,27,34,.55)', backdropFilter: 'blur(2px)', display: 'grid', placeItems: 'center', padding: 16 }}
        >
          <div
            ref={dialogRef}
            role="dialog"
            aria-modal="true"
            aria-labelledby="usps-title"
            aria-describedby="usps-sub"
            tabIndex={-1}
            className="panel"
            style={{ width: 'min(860px, 100%)', maxHeight: '92vh', overflow: 'auto', background: 'var(--surface)', color: 'var(--text)', padding: 0, borderRadius: 8, boxShadow: '0 30px 80px -30px rgba(0,0,0,.55)' }}
          >
            {/* header */}
            <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12, padding: '20px 24px 14px', borderBottom: '1px solid var(--line)' }}>
              <div style={{ flex: 1 }}>
                <div className="row" style={{ gap: 10 }}>
                  <h2 id="usps-title" style={{ margin: 0 }}>USPS Address Verification</h2>
                  <StatusBadge status={status} imported={imported} />
                </div>
                <p id="usps-sub" className="muted small" style={{ margin: '6px 0 0' }}>
                  Verify the subject property against the official USPS Addresses API, then import the deliverable USPS address.
                  This required condition clears — and title, insurance and attorney ordering unlock — only after import.
                </p>
              </div>
              <button className="btn ghost small" disabled={!!busy} onClick={() => setOpen(false)} aria-label="Close dialog">Close</button>
            </div>

            <div style={{ padding: '16px 24px 22px', display: 'flex', flexDirection: 'column', gap: 14 }}>
              {data && !data.configured && (
                <div style={{ padding: '10px 12px', borderRadius: 6, border: '1px solid var(--danger)', background: 'var(--danger-soft)', color: 'var(--text)', fontSize: 13.5 }}>
                  USPS is not configured on this service. Add <code>USPS_CLIENT_ID</code> and <code>USPS_CLIENT_SECRET</code> to enable verification.
                </div>
              )}

              {/* current file address */}
              <div className="small" style={{ color: 'var(--text-soft)' }}>
                Current file address:&nbsp;
                <span style={{ color: 'var(--text)', fontWeight: 600 }}>{addressLine(data && data.property_address) || '—'}</span>
                {imported && data.usps_imported_at && <span style={{ color: 'var(--ok)' }}> · imported {new Date(data.usps_imported_at).toLocaleDateString()}</span>}
              </div>

              {/* two columns: edit + verify | USPS result */}
              <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0,1fr) minmax(0,1fr)', gap: 14 }} className="usps-grid">
                {/* LEFT — address to verify (editable) */}
                <section style={{ border: '1px solid var(--line)', borderRadius: 8, padding: 14, background: 'var(--surface-soft)' }}>
                  <div className="small" style={{ fontWeight: 700, marginBottom: 10 }}>Address to verify</div>
                  <div style={{ ...FIELD, marginBottom: 10 }}>
                    <label style={LABEL} htmlFor="usps-line1">Street address</label>
                    <input id="usps-line1" className="input" value={form.line1} onChange={setField('line1')} placeholder="123 Main St" autoComplete="off" />
                  </div>
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, marginBottom: 10 }}>
                    <div style={FIELD}>
                      <label style={LABEL} htmlFor="usps-unit">Apt / Suite <span style={{ textTransform: 'none', letterSpacing: 0, color: 'var(--text-soft)' }}>(optional)</span></label>
                      <input id="usps-unit" className="input" value={form.unit} onChange={setField('unit')} placeholder="Apt 4B" autoComplete="off" />
                    </div>
                    <div style={FIELD}>
                      <label style={LABEL} htmlFor="usps-city">City</label>
                      <input id="usps-city" className="input" value={form.city} onChange={setField('city')} placeholder="Springfield" autoComplete="off" />
                    </div>
                  </div>
                  <div style={{ display: 'grid', gridTemplateColumns: '90px 1fr', gap: 10 }}>
                    <div style={FIELD}>
                      <label style={LABEL} htmlFor="usps-state">State</label>
                      <input id="usps-state" className="input" value={form.state} onChange={setField('state')} placeholder="IL" maxLength={2} autoComplete="off" style={{ textTransform: 'uppercase' }} />
                    </div>
                    <div style={FIELD}>
                      <label style={LABEL} htmlFor="usps-zip">ZIP</label>
                      <input id="usps-zip" className="input" value={form.zip} onChange={setField('zip')} placeholder="62704" autoComplete="off" />
                    </div>
                  </div>
                  <button className="btn primary btn-block" style={{ marginTop: 12 }} disabled={!!busy || (data && !data.configured)} onClick={check}>
                    {busy === 'check' ? 'Checking USPS…' : hasResult ? 'Verify again with USPS' : 'Verify with USPS'}
                  </button>
                  <div className="small" style={{ color: 'var(--text-soft)', marginTop: 8 }}>
                    Verifying never changes the file. Correct anything USPS can’t confirm here, then verify again.
                  </div>
                </section>

                {/* RIGHT — USPS result */}
                <section style={{ border: '1px solid ' + (deliverable ? 'var(--ok)' : hasResult ? 'var(--warning)' : 'var(--line)'), borderRadius: 8, padding: 14, background: 'var(--surface)' }}>
                  <div className="row" style={{ justifyContent: 'space-between', marginBottom: 10 }}>
                    <span className="small" style={{ fontWeight: 700 }}>USPS result</span>
                    {hasResult && <StatusBadge status={status} imported={imported} />}
                  </div>

                  {!hasResult && (
                    <div className="small" style={{ color: 'var(--text-soft)', padding: '18px 0' }}>
                      No USPS result yet. Click <strong>Verify with USPS</strong> to standardize the address on the left.
                    </div>
                  )}

                  {hasResult && (
                    <>
                      <div style={{ fontSize: 16, fontWeight: 600, lineHeight: 1.45, letterSpacing: '.2px' }}>
                        {tokens.map((t) => t.changed
                          ? <mark key={t.key} style={{ background: 'var(--gold-soft)', color: 'var(--text)', padding: '0 2px', borderRadius: 3, fontWeight: 700 }}>{t.tok}</mark>
                          : <span key={t.key}>{t.tok}</span>)}
                      </div>
                      {data.usps_address && (data.usps_address.zip || '').length > 5 && (
                        <div className="small" style={{ color: 'var(--ok)', marginTop: 6, fontWeight: 600 }}>ZIP+4 confirmed · {data.usps_address.zip}</div>
                      )}
                      {read && (
                        <div style={{ marginTop: 10, fontSize: 13, padding: '8px 10px', borderRadius: 6,
                          background: read.tone === 'ok' ? 'var(--success-soft)' : read.tone === 'warn' ? 'var(--warning-soft)' : read.tone === 'bad' ? 'var(--danger-soft)' : 'var(--surface-soft)',
                          border: '1px solid ' + (read.tone === 'ok' ? 'var(--ok)' : read.tone === 'warn' ? 'var(--warning)' : read.tone === 'bad' ? 'var(--danger)' : 'var(--line)'),
                          color: 'var(--text)' }}>
                          {read.label}
                        </div>
                      )}
                      {dpv && (YN(dpv.vacant) || YN(dpv.business) || YN(dpv.dpvCMRA)) && (
                        <div className="row" style={{ gap: 6, marginTop: 8 }}>
                          {YN(dpv.vacant) && <span className="pill" style={{ borderColor: 'var(--warning)', color: 'var(--warning)' }}>Vacant per USPS</span>}
                          {YN(dpv.dpvCMRA) && <span className="pill" style={{ borderColor: 'var(--warning)', color: 'var(--warning)' }}>Private mailbox (CMRA)</span>}
                          {YN(dpv.business) && <span className="pill muted">Business address</span>}
                        </div>
                      )}
                      {data.usps_verified_at && <div className="small" style={{ color: 'var(--text-soft)', marginTop: 8 }}>Checked {new Date(data.usps_verified_at).toLocaleString()}</div>}
                    </>
                  )}
                </section>
              </div>

              {/* action + guidance */}
              {flash && <div style={{ padding: '10px 12px', borderRadius: 6, border: '1px solid var(--ok)', background: 'var(--success-soft)', color: 'var(--text)', fontSize: 13.5 }}>{flash}</div>}
              {err && (
                <div style={{ padding: '10px 12px', borderRadius: 6, border: '1px solid var(--danger)', background: 'var(--danger-soft)', color: 'var(--text)', fontSize: 13.5 }}>
                  <div>{err}</div>
                  {errDetail && (
                    <div className="small" style={{ marginTop: 6, color: 'var(--text-soft)' }}>
                      <span style={{ fontWeight: 700 }}>Exactly what USPS said:</span> <code style={{ wordBreak: 'break-word' }}>{errDetail}</code>
                    </div>
                  )}
                </div>
              )}

              {hasResult && !deliverable && (
                <div className="small" style={{ color: 'var(--danger)' }}>
                  USPS did not confirm a deliverable address. Correct the street, unit or ZIP on the left and verify again — importing is only possible once USPS confirms it.
                </div>
              )}
              {hasResult && deliverable && formChanged && !imported && (
                <div className="small" style={{ color: 'var(--warning)' }}>You edited the address since the last check — verify it again before importing.</div>
              )}

              <div className="row" style={{ justifyContent: 'flex-end', gap: 10, borderTop: '1px solid var(--line)', paddingTop: 14 }}>
                <button className="btn ghost" disabled={!!busy} onClick={() => setOpen(false)}>Close</button>
                <button className="btn primary" disabled={!!busy || !importable} onClick={importAddress}
                  title={importable ? 'Adopt the USPS address as the file address and clear the condition' : imported ? 'Already imported' : 'A verified/corrected USPS result for the address above is required first'}>
                  {busy === 'import' ? 'Importing…' : imported ? 'Verified address imported ✓' : 'Import verified address'}
                </button>
              </div>
              <div className="small" style={{ color: 'var(--text-soft)' }}>
                <strong>Verify</strong> stages USPS’s standardized address. <strong>Import</strong> adopts it as the working property address for the loan, financing tapes and TPR exports, clears this condition, and unlocks title/insurance/attorney ordering. Changing the address later re-opens this condition automatically.
              </div>

              {/* SUPER-ADMIN EXCEPTION — never be stuck when USPS itself won't cooperate.
                  Only shown to a super admin, and only while the hold-back is still on. */}
              {data && data.canOverride && !imported && (
                <div style={{ marginTop: 4, border: '1px dashed var(--warning)', borderRadius: 8, padding: 14, background: 'var(--warning-soft)' }}>
                  <div className="row" style={{ justifyContent: 'space-between', gap: 10, alignItems: 'flex-start' }}>
                    <div>
                      <div className="small" style={{ fontWeight: 700, color: 'var(--text)' }}>Super-admin exception</div>
                      <div className="small" style={{ color: 'var(--text-soft)', marginTop: 4, maxWidth: 560 }}>
                        Accept this address without a USPS confirmation. This clears the condition and unlocks title, insurance and attorney ordering. It uses the address in the box above if you edited it, otherwise the file’s current address. The reason is saved on the file.
                      </div>
                    </div>
                    {!ovrOpen && (
                      <button className="btn ghost small" disabled={!!busy} onClick={() => { setOvrOpen(true); setErr(''); }}>
                        Override the USPS hold
                      </button>
                    )}
                  </div>
                  {ovrOpen && (
                    <div style={{ marginTop: 12 }}>
                      <label style={LABEL} htmlFor="usps-ovr-reason">Reason for the exception</label>
                      <textarea id="usps-ovr-reason" className="input" rows={2} value={ovrReason}
                        onChange={(e) => setOvrReason(e.target.value)} placeholder="e.g. USPS lookup failing; address confirmed against county records and the appraisal." />
                      <div className="row" style={{ justifyContent: 'flex-end', gap: 10, marginTop: 10 }}>
                        <button className="btn ghost small" disabled={!!busy} onClick={() => { setOvrOpen(false); setOvrReason(''); }}>Cancel</button>
                        <button className="btn primary small" disabled={!!busy || !ovrReason.trim()} onClick={doOverride}>
                          {busy === 'override' ? 'Recording…' : 'Accept address & clear the hold'}
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              )}
            </div>
          </div>
        </div>
      )}
      <style>{`@media (max-width: 640px){ .usps-grid{ grid-template-columns: 1fr !important; } }`}</style>
    </>
  );
}
