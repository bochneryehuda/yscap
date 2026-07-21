import React, { useCallback, useEffect, useState } from 'react';
import { api } from '../lib/api.js';

/* ═══════════════════════════════════════════════════════════════════════════
   PER-FILE NOTIFICATION OVERRIDES

   Small, collapsible panel that sits on the staff File screen. Lets THIS
   file's assigned loan officer override their own catalog defaults just for
   this one file — e.g. "silence everything for this deal" (via the '*' catch-
   all key), or "for this borrower, park the doc-uploaded emails as drafts".

   Only surfaces if the current staffer IS the assigned LO on the file.
   Everything else on the screen ignores this component.
   ═════════════════════════════════════════════════════════════════════════ */

const QUICK = [
  { id: 'auto',   label: 'Follow my defaults', hint: 'Clear the file-level override — this file uses your Notification Center choices.' },
  { id: 'vip',    label: 'VIP mode — everything automatic', hint: 'Pin every notification on this file to Automatic, no matter what your default says.' },
  { id: 'quiet',  label: 'Quiet — park everything as drafts', hint: 'Every notification on this file lands in Drafts. You review each one before it goes out.' },
  { id: 'silent', label: 'Silence — send nothing', hint: 'Drop every non-required notification on this file. DocuSign, security and account emails still send.' },
];

export default function FileNotificationOverrides({ applicationId, isMyFile }) {
  const [expanded, setExpanded] = useState(false);
  const [overrides, setOverrides] = useState(null);
  const [catalog, setCatalog] = useState(null);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    if (!applicationId) return;
    try {
      const [ov, cat] = await Promise.all([api.loNotifOverrides(applicationId), api.loNotifCatalog()]);
      setOverrides(ov.overrides || []);
      setCatalog(cat);
    } catch (e) { setErr(e.message || 'Could not load'); }
  }, [applicationId]);

  useEffect(() => { if (expanded) load(); }, [expanded, load]);

  if (!isMyFile) return null;

  const wildcard = overrides && overrides.find((o) => o.notif_key === '*');

  const applyQuick = async (id) => {
    setBusy(true); setErr('');
    try {
      if (id === 'auto') {
        // Clear all overrides — full defaults.
        for (const o of (overrides || [])) {
          await api.loNotifClearOverride(applicationId, o.notif_key);
        }
      } else if (id === 'vip') {
        await api.loNotifSaveOverride({ applicationId, key: '*', enabled: true, mode: 'automatic', note: 'VIP mode' });
      } else if (id === 'quiet') {
        await api.loNotifSaveOverride({ applicationId, key: '*', enabled: true, mode: 'manual', note: 'Quiet mode — everything to drafts' });
      } else if (id === 'silent') {
        await api.loNotifSaveOverride({ applicationId, key: '*', enabled: false, mode: 'automatic', note: 'Silenced — no non-required notifications' });
      }
      await load();
    } catch (e) { setErr(e.message || 'Failed'); }
    finally { setBusy(false); }
  };

  const savePerKey = async (key, next) => {
    setBusy(true); setErr('');
    try {
      await api.loNotifSaveOverride({ applicationId, key, enabled: next.enabled, mode: next.mode });
      await load();
    } catch (e) { setErr(e.message || 'Save failed'); }
    finally { setBusy(false); }
  };

  const clearPerKey = async (key) => {
    setBusy(true); setErr('');
    try { await api.loNotifClearOverride(applicationId, key); await load(); }
    catch (e) { setErr(e.message || 'Clear failed'); }
    finally { setBusy(false); }
  };

  const summary = wildcard
    ? (!wildcard.enabled ? 'Silenced' : wildcard.mode === 'manual' ? 'Quiet — all to drafts' : 'VIP — all automatic')
    : (overrides && overrides.length ? `${overrides.length} per-notification override${overrides.length > 1 ? 's' : ''}` : 'Following your defaults');

  return (
    <div className="panel" style={{ marginBottom: 12 }}>
      <button onClick={() => setExpanded(!expanded)}
        style={{ width: '100%', background: 'transparent', border: 'none', textAlign: 'left', cursor: 'pointer', padding: 0 }}>
        <div className="row" style={{ alignItems: 'center', gap: 6 }}>
          <div style={{ flex: 1 }}>
            <div style={{ fontWeight: 500 }}>Notifications on this file — {summary}</div>
            <div className="muted small">Override how notifications behave just for this borrower / deal.</div>
          </div>
          <span className="muted small">{expanded ? 'Hide' : 'Show'}</span>
        </div>
      </button>

      {expanded && (
        <>
          {err && <div className="notice err" style={{ marginTop: 10 }}>{err}</div>}
          <div style={{ marginTop: 12 }}>
            <div className="muted small" style={{ textTransform: 'uppercase', letterSpacing: '.06em', marginBottom: 6 }}>Quick presets</div>
            <div className="row" style={{ gap: 6, flexWrap: 'wrap' }}>
              {QUICK.map((q) => (
                <button key={q.id} className="btn ghost small" disabled={busy} onClick={() => applyQuick(q.id)} title={q.hint}>
                  {q.label}
                </button>
              ))}
            </div>
            {wildcard && (
              <div className="muted small" style={{ marginTop: 6 }}>
                Currently: <strong>{summary}</strong>{wildcard.note ? ` — ${wildcard.note}` : ''}
              </div>
            )}
          </div>

          <div style={{ marginTop: 16 }}>
            <div className="muted small" style={{ textTransform: 'uppercase', letterSpacing: '.06em', marginBottom: 6 }}>Per-notification overrides</div>
            {!overrides || !overrides.length ? (
              <div className="muted small">No per-notification overrides yet. Use the presets above, or set individual notifications in the Notification Center.</div>
            ) : (
              <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                <tbody>
                  {overrides.filter((o) => o.notif_key !== '*').map((o) => {
                    const entry = catalog && catalog.items.find((i) => i.key === o.notif_key);
                    return (
                      <tr key={o.notif_key} style={{ borderBottom: '1px solid var(--line)' }}>
                        <td style={{ padding: 6 }}>{entry ? entry.label : o.notif_key}</td>
                        <td style={{ padding: 6, textAlign: 'right' }}>
                          <span className="ec-pill ec-pill-muted" style={{ fontSize: 10, marginRight: 6 }}>
                            {!o.enabled ? 'Off' : o.mode === 'manual' ? 'Manual' : 'Automatic'}
                          </span>
                          <button className="btn ghost small" onClick={() => clearPerKey(o.notif_key)}>Clear</button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
          </div>
          <p className="muted small" style={{ marginTop: 12 }}>
            File overrides beat your default settings, but never the required notifications (DocuSign, security, account).
          </p>
        </>
      )}
    </div>
  );
}
