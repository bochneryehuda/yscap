import React, { useEffect, useState } from 'react';
import { api } from '../lib/api.js';

/* WHO HANDLES THIS CLOSING — the per-file half of the three-way switch
   (owner-directed 2026-08-28): internal / attorney / lender-direct. The file
   inherits its note buyer's default, then the company default (both set on the
   API Health page); this control shows the RESOLVED answer, where it came from,
   and lets staff override it for this one file. When the resolution disables a
   workflow (the attorney prep on an internal or lender-direct file), the reason
   renders here in full — "if an option is disabled, it should always say why". */

const INK = '#141B22';
const MUTED = '#4B585C';

const SOURCE_WORDS = {
  file: 'set on this file',
  note_buyer: 'this note buyer’s default',
  company: 'the company default',
  default: 'the standing default',
};

export default function ClosingHandlingControl({ appId, onChanged }) {
  const [data, setData] = useState(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  const load = () => api.closingHandling(appId).then(setData).catch(() => setData(null));
  useEffect(() => { load(); }, [appId]);   // eslint-disable-line react-hooks/exhaustive-deps

  if (!data) return null;
  const { resolution, capabilities, handlings } = data;

  const set = async (value) => {
    setBusy(true); setErr('');
    try {
      await api.setClosingHandling(appId, value || null);
      await load();
      onChanged && onChanged();
    } catch (e) { setErr((e && e.message) || 'Could not change who handles the closing.'); }
    finally { setBusy(false); }
  };

  return (
    <div style={{ border: '1px solid #E4DFD3', borderRadius: 10, padding: '10px 12px', marginBottom: 10, background: '#FBF9F4' }}>
      <div className="row" style={{ gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
        <span style={{ fontWeight: 700, color: INK, fontSize: 13 }}>Who handles this closing</span>
        <select className="input flt-sm" style={{ width: 'auto' }} disabled={busy}
          value={resolution.fileOverride || ''}
          onChange={(e) => set(e.target.value)}>
          <option value="">Inherit — {capabilities.label} ({SOURCE_WORDS[resolution.source] || resolution.source})</option>
          {handlings.map((h) => <option key={h.key} value={h.key}>{h.label} (this file only)</option>)}
        </select>
        {resolution.noteBuyer && (
          <span className="muted small">Note buyer: {resolution.noteBuyer}</span>
        )}
      </div>
      {err && <div role="alert" className="small" style={{ color: 'var(--danger)', marginTop: 4 }}>{err}</div>}
      {!capabilities.attorneyPrep.enabled && (
        <div className="small" style={{ color: INK, marginTop: 6, padding: '6px 8px', border: '1px solid #AE8746', borderRadius: 8, background: '#FBF7EE' }}>
          <b>The attorney closing prep is off on this file.</b> {capabilities.attorneyPrep.reason}
        </div>
      )}
      {capabilities.titleSlots === 'itemized' && (
        <div className="muted small" style={{ marginTop: 4 }}>
          In-house closing: the title condition carries a slot per requested item (set up automatically).
        </div>
      )}
    </div>
  );
}
