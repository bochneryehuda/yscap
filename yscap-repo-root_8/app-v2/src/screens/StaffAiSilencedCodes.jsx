import React, { useEffect, useState, useCallback } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../lib/api.js';

/** R4.10 — super_admin management screen for the portfolio-wide AI code
 *  mute list (R4.8 backend). Add codes with a required reason; unmute in
 *  one click. Muted codes never surface as new suggestions on any file. */
export default function StaffAiSilencedCodes() {
  const [rows, setRows] = useState(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [code, setCode] = useState('');
  const [reason, setReason] = useState('');
  const [history, setHistory] = useState(null);
  const load = useCallback(async () => {
    setBusy(true); setErr('');
    try {
      const r = await api.aiSilencedCodesList();
      setRows((r && r.codes) || []);
    } catch (e) { setErr((e && e.message) || 'Failed to load.'); }
    finally { setBusy(false); }
    // R4.20 — the silence/un-silence history rail. Best-effort — never blocks the list.
    try {
      const h = await api.aiSilencedCodesHistory();
      setHistory((h && h.history) || []);
    } catch (_) { setHistory([]); }
  }, []);
  useEffect(() => { load(); }, [load]);
  const add = async () => {
    if (!code.trim() || !reason.trim()) { alert('Both code and reason are required.'); return; }
    try {
      await api.aiSilencedCodesAdd(code.trim(), reason.trim());
      setCode(''); setReason('');
      load();
    } catch (e) { alert(`Failed: ${(e && e.message) || 'error'}`); }
  };
  const remove = async (c) => {
    if (!window.confirm(`Un-mute "${c}"? New findings with this code will start surfacing again.`)) return;
    try { await api.aiSilencedCodesRemove(c); load(); }
    catch (e) { alert(`Failed: ${(e && e.message) || 'error'}`); }
  };
  return (
    <div style={{ maxWidth: 960, margin: '0 auto', padding: '20px 16px' }}>
      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', marginBottom: 16 }}>
        <div>
          <h2 style={{ margin: 0, fontFamily: 'var(--serif,Georgia,serif)' }}>Silenced AI codes</h2>
          <div className="muted small">
            When an AI finding CODE turns out to be a chronic false positive across many files, mute it here.
            New findings with the code will be dropped before they show on any file. Existing findings are untouched.
          </div>
        </div>
        <div><Link to="/internal/insights" style={{ fontSize: 12 }}>Insights →</Link></div>
      </div>

      <div style={{ background: 'var(--card,#fff)', border: '1px solid var(--paper,#E9E4D3)', borderRadius: 12, padding: 14, marginBottom: 18 }}>
        <div style={{ fontSize: 12, textTransform: 'uppercase', letterSpacing: '.06em', color: 'var(--muted,#4B585C)', fontWeight: 700, marginBottom: 8 }}>Mute a code</div>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 2fr auto', gap: 10, alignItems: 'end' }}>
          <label style={{ fontSize: 12 }}>Code
            <input type="text" value={code} onChange={(e) => setCode(e.target.value)} placeholder="e.g. identity_name_variation"
              style={{ width: '100%', marginTop: 4 }} />
          </label>
          <label style={{ fontSize: 12 }}>Reason (required, for audit)
            <input type="text" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Why is this being muted?"
              style={{ width: '100%', marginTop: 4 }} />
          </label>
          <button className="btn" onClick={add} disabled={busy || !code.trim() || !reason.trim()}>Mute</button>
        </div>
      </div>

      {err && <div style={{ color: 'var(--crit,#B4483C)', fontSize: 13, marginBottom: 10 }}>{err}</div>}
      {rows == null && <div className="muted small">Loading…</div>}
      {rows && rows.length === 0 && <div className="muted small">No codes are currently muted.</div>}
      {rows && rows.length > 0 && (
        <div style={{ border: '1px solid var(--paper,#E9E4D3)', borderRadius: 12, overflow: 'hidden' }}>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 2fr 1fr 1fr auto', gap: 10, padding: '8px 12px', background: 'var(--paper,#F6F3EC)', fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.06em', color: 'var(--muted,#4B585C)' }}>
            <span>Code</span><span>Reason</span><span>Muted by</span><span>When</span><span></span>
          </div>
          {rows.map((r) => (
            <div key={r.code} style={{ display: 'grid', gridTemplateColumns: '1fr 2fr 1fr 1fr auto', gap: 10, padding: '8px 12px', borderTop: '1px solid var(--paper,#E9E4D3)', fontSize: 12, alignItems: 'center' }}>
              <span style={{ fontFamily: 'ui-monospace,monospace' }}>{r.code}</span>
              <span>{r.reason}</span>
              <span className="muted small">{r.silenced_by_email || '—'}</span>
              <span className="muted small">{r.silenced_at ? new Date(r.silenced_at).toLocaleDateString() : '—'}</span>
              <button className="btn ghost small" onClick={() => remove(r.code)}>Un-mute</button>
            </div>
          ))}
        </div>
      )}

      {/* R4.20 — audit trail: every mute + un-mute, newest first. */}
      {history && history.length > 0 && (
        <div style={{ marginTop: 26 }}>
          <div style={{ fontSize: 12, textTransform: 'uppercase', letterSpacing: '.06em', color: 'var(--muted,#4B585C)', fontWeight: 700, marginBottom: 8 }}>History</div>
          <div style={{ border: '1px solid var(--paper,#E9E4D3)', borderRadius: 12, overflow: 'hidden' }}>
            {history.map((h, i) => {
              const d = h.detail || {};
              const muted = h.action === 'ai_code_silenced';
              return (
                <div key={i} style={{ display: 'flex', gap: 10, padding: '7px 12px', borderTop: i ? '1px solid var(--paper,#E9E4D3)' : 'none', fontSize: 12, alignItems: 'baseline' }}>
                  <span style={{ minWidth: 66, fontWeight: 700, color: muted ? 'var(--crit,#B4483C)' : 'var(--good,#3F7A5B)' }}>{muted ? 'Muted' : 'Un-muted'}</span>
                  <span style={{ fontFamily: 'ui-monospace,monospace', minWidth: 0, flexShrink: 0 }}>{d.code || '—'}</span>
                  <span style={{ flex: 1, minWidth: 0, color: 'var(--muted,#4B585C)' }}>{d.reason || ''}</span>
                  <span className="muted small" style={{ whiteSpace: 'nowrap' }}>{h.actor_name || h.actor_email || 'staff'} · {h.created_at ? new Date(h.created_at).toLocaleDateString() : ''}</span>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
