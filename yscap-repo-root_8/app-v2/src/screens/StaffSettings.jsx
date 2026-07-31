import React, { useEffect, useState } from 'react';
import { api } from '../lib/api.js';

/* MY SETTINGS — each officer's own business settings (owner-directed
 * 2026-07-31: "the loan officers should have their settings section where they
 * can set different settings … different per loan officer how he wants to run
 * his business"). The server owns the key whitelist + defaults
 * (src/lib/lo-settings.js) and sends {settings, keys}; this screen just renders
 * one row per key, so adding a setting server-side appears here automatically.
 * First setting: CC my borrowers on title order emails by default (off).
 * Notification preferences stay in the Notification Center — this is business
 * behavior, not delivery. */
export default function StaffSettings() {
  const [settings, setSettings] = useState(null);
  const [keys, setKeys] = useState({});
  const [busy, setBusy] = useState('');
  const [msg, setMsg] = useState(null);

  const load = () => api.mySettings()
    .then((d) => { setSettings(d.settings || {}); setKeys(d.keys || {}); })
    .catch((e) => setMsg({ ok: false, text: (e && e.message) || 'Could not load your settings.' }));
  useEffect(() => { load(); }, []);

  const flip = async (key, value) => {
    setBusy(key); setMsg(null);
    try {
      const d = await api.saveMySettings({ [key]: value });
      setSettings(d.settings || {});
      setMsg({ ok: true, text: 'Saved.' });
      setTimeout(() => setMsg(null), 4000);
    } catch (e) {
      setMsg({ ok: false, text: (e && e.message) || 'Could not save.' });
    } finally { setBusy(''); }
  };

  return (
    <div className="page">
      <div className="wrap" style={{ maxWidth: 760 }}>
        <h1 style={{ margin: 0 }}>My settings</h1>
        <p className="muted" style={{ marginTop: 6 }}>
          How you run your business — each officer sets their own. These change your defaults; you can still
          override most of them on any single file or order.
        </p>
        {msg && <div className={`notice${msg.ok ? '' : ' warn'}`} role="status">{msg.text}</div>}
        {!settings && !msg && <p className="muted small">Loading…</p>}
        {settings && (
          <div className="panel" style={{ marginTop: 12 }}>
            {Object.entries(keys).map(([key, spec]) => (
              <label key={key} className="row" style={{ gap: 10, alignItems: 'flex-start', padding: '10px 0', borderBottom: '1px solid var(--line,#E4DECF)' }}>
                <input type="checkbox" style={{ marginTop: 3 }} disabled={busy === key}
                  checked={settings[key] === true}
                  onChange={(e) => flip(key, e.target.checked)} />
                <span style={{ flex: 1 }}>
                  <span style={{ display: 'block', fontWeight: 600, color: '#141B22' }}>{spec.label || key}</span>
                  {spec.help && <span className="small" style={{ display: 'block', color: '#4B585C', marginTop: 2 }}>{spec.help}</span>}
                </span>
              </label>
            ))}
            {Object.keys(keys).length === 0 && <p className="muted small">No settings available yet.</p>}
          </div>
        )}
        <p className="muted small" style={{ marginTop: 10 }}>
          Looking for notification preferences (what emails you get)? Those live in the Notification Center → “For me”.
        </p>
      </div>
    </div>
  );
}
