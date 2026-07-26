import React, { useCallback, useEffect, useState } from 'react';
import { api } from '../lib/api.js';
import { useAuth } from '../lib/auth.jsx';

/* API Health (admin / platform_setup).
   One section per external API / integration: is it Live, Configured, Off, or Not connected —
   with a live "Test now" check and plain-English fix guidance. Driven entirely by
   GET /api/admin/integrations/health, which is backed by the health registry, so any new
   integration added on the backend appears here automatically.

   Each integration also shows its WORKING on/off switches: a real toggle you can flip right here,
   backed by a runtime override (POST /api/admin/integrations/switches/:key). A switch that changes
   live behavior (sending e-signatures, writing to ClickUp/Sitewire) is marked "changes live
   behavior" and asks you to type a short confirmation first. Turning a switch off takes effect
   immediately; a switch reverts to the hosting default with "Reset".

   Keys are set/rotated in the hosting dashboard (Render), never here — this page reads status
   only and never shows or accepts a secret value. */

// state -> light color + label. Keyed on the single `state` word the backend computes.
const STATE = {
  live:           { fg: '#3F7A5B', bg: 'rgba(63,122,91,.12)', label: 'Live' },
  configured:     { fg: '#256168', bg: 'rgba(47,127,134,.12)', label: 'Configured' },
  disabled:       { fg: '#B7791F', bg: '#F6EEDD', label: 'Switched off' },
  unreachable:    { fg: '#B4483C', bg: '#F6E7E4', label: 'Not reachable' },
  not_configured: { fg: '#4B585C', bg: '#EFEFEA', label: 'Not connected' },
  framework:      { fg: '#4B585C', bg: '#EFEFEA', label: 'Ready — add keys' },
  planned:        { fg: '#8A7A55', bg: '#F3EEE0', label: 'Planned' },
};
const GROUP = {
  core:      { title: 'Document AI', blurb: 'The reading + analysis brain behind the underwriting desk.' },
  workflow:  { title: 'Workflow & documents', blurb: 'Pipeline sync, e-signatures, the document mirror, and construction draws.' },
  comms:     { title: 'Email', blurb: 'How the platform sends notifications and receives replies.' },
  data:      { title: 'Address & data lookups', blurb: 'Address verification, property photos, flood, and OCR helpers.' },
  framework: { title: 'Built, awaiting keys', blurb: 'Fully coded — they switch on the moment credentials are added.' },
  planned:   { title: 'Planned / not connected yet', blurb: 'Reserved slots for integrations we haven’t wired up.' },
};
const GROUP_ORDER = ['core', 'workflow', 'comms', 'data', 'framework', 'planned'];

function Light({ state }) {
  const s = STATE[state] || STATE.not_configured;
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 7, fontWeight: 800, fontSize: 11.5,
      letterSpacing: '.04em', textTransform: 'uppercase', color: s.fg, background: s.bg, padding: '4px 10px', borderRadius: 999 }}>
      <span style={{ width: 8, height: 8, borderRadius: 999, background: s.fg, boxShadow: state === 'live' ? `0 0 0 3px ${s.bg}` : 'none' }} />
      {s.label}
    </span>
  );
}

function EnvChip({ e }) {
  const set = e.set;
  const fg = set ? '#3F7A5B' : (e.required ? '#B4483C' : '#8A939A');
  const bg = set ? 'rgba(63,122,91,.10)' : (e.required ? '#F6E7E4' : '#F1F1EC');
  return (
    <span title={set ? 'Set' : (e.required ? 'Required — not set' : 'Optional — not set')}
      style={{ fontSize: 11, fontFamily: 'ui-monospace,Menlo,monospace', color: fg, background: bg, border: '1px solid rgba(0,0,0,.06)',
        borderRadius: 6, padding: '2px 7px' }}>
      {set ? '✓' : (e.required ? '✕' : '○')} {e.name}
    </span>
  );
}

// A real on/off toggle control (accessible: role="switch").
function Toggle({ on, disabled, onClick, danger }) {
  const track = on ? (danger ? '#B4483C' : '#2F7F86') : '#D5D5CC';
  return (
    <button type="button" role="switch" aria-checked={on} disabled={disabled} onClick={onClick}
      style={{ width: 42, height: 24, borderRadius: 999, border: '1px solid rgba(0,0,0,.10)', position: 'relative', flex: '0 0 auto',
        background: track, cursor: disabled ? 'default' : 'pointer', transition: 'background .15s', padding: 0, opacity: disabled ? 0.55 : 1 }}>
      <span style={{ position: 'absolute', top: 1, left: on ? 20 : 1, width: 20, height: 20, borderRadius: 999,
        background: '#fff', boxShadow: '0 1px 2px rgba(0,0,0,.3)', transition: 'left .15s' }} />
    </button>
  );
}

// One runtime, toggleable switch (a real control).
function SwitchRow({ s, busy, onToggle, onReset }) {
  const sub = [];
  sub.push(s.on ? 'On' : 'Off');
  sub.push(s.overridden ? `overridden — the hosting default is ${s.envDefault ? 'on' : 'off'}` : 'matches the hosting default');
  if (s.resume && s.on) sub.push('turning off applies right away; the background reader fully stops on the next restart');
  return (
    <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10, padding: '8px 0', borderTop: '1px solid rgba(0,0,0,.06)' }}>
      <Toggle on={s.on} danger={s.dangerous} disabled={busy} onClick={() => onToggle(s)} />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 12.5, fontWeight: 700, display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
          {s.label}
          {s.dangerous && (
            <span title="Changes what the platform actually sends to the outside world — you’ll be asked to confirm."
              style={{ fontSize: 10, fontWeight: 800, letterSpacing: '.03em', textTransform: 'uppercase', color: '#B4483C',
                background: '#F6E7E4', borderRadius: 999, padding: '1px 7px' }}>changes live behavior</span>
          )}
          {s.overridden && (
            <span title="An admin flipped this from the hosting default. Reset returns it to the default."
              style={{ fontSize: 10, fontWeight: 800, letterSpacing: '.03em', textTransform: 'uppercase', color: '#B7791F',
                background: '#F6EEDD', borderRadius: 999, padding: '1px 7px' }}>overridden</span>
          )}
        </div>
        <div style={{ fontSize: 11, color: 'var(--muted,#8A939A)', marginTop: 2 }}>{sub.join(' · ')}</div>
      </div>
      {s.overridden && (
        <button className="btn ghost small" disabled={busy} onClick={() => onReset(s)} title="Return this switch to the hosting default">Reset</button>
      )}
    </div>
  );
}

function Card({ it, onTest, testing, onToggle, onReset, switchBusy }) {
  const missingRequired = (it.env || []).filter((e) => e.required && !e.set);
  const runtimeSwitches = (it.switches || []);
  const displaySwitches = (it.displaySwitches || []);
  return (
    <div style={{ border: '1px solid var(--line,#E7E1D3)', borderLeft: `4px solid ${(STATE[it.state] || STATE.not_configured).fg}`,
      borderRadius: 12, background: 'var(--card,#fff)', padding: '14px 16px' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', marginBottom: 6 }}>
        <strong style={{ fontSize: 14.5 }}>{it.name}</strong>
        <Light state={it.state} />
        <span style={{ flex: 1 }} />
        {!it.notBuilt && (
          <button className="btn ghost small" disabled={testing} onClick={() => onTest(it.key)}
            title={it.liveProbe ? 'Run a live connection check now' : 'Re-check configuration now'}>
            {testing ? 'Testing…' : (it.liveProbe ? 'Test now' : 'Re-check')}
          </button>
        )}
      </div>
      <div style={{ fontSize: 12.5, color: 'var(--muted,#4B585C)', marginBottom: 8 }}>{it.purpose}</div>
      {it.detail && <div style={{ fontSize: 12.5, marginBottom: 10 }}>{it.detail}</div>}

      {(it.env && it.env.length > 0) && (
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: (runtimeSwitches.length || displaySwitches.length) ? 8 : 0 }}>
          {it.env.map((e) => <EnvChip key={e.name} e={e} />)}
        </div>
      )}

      {runtimeSwitches.length > 0 && (
        <div style={{ marginTop: 4, borderTop: '1px solid rgba(0,0,0,.06)' }}>
          <div style={{ fontSize: 10.5, fontWeight: 800, letterSpacing: '.05em', textTransform: 'uppercase', color: 'var(--muted,#8A939A)', padding: '8px 0 0' }}>Switches</div>
          {runtimeSwitches.map((s) => (
            <SwitchRow key={s.name} s={s} busy={switchBusy === s.name} onToggle={onToggle} onReset={onReset} />
          ))}
        </div>
      )}

      {displaySwitches.length > 0 && (
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center', marginTop: 8 }}>
          {displaySwitches.map((s) => (
            <span key={s.name} title="Set in the hosting settings (Render), not here." style={{ fontSize: 11, borderRadius: 6, padding: '2px 8px',
              color: s.on ? '#256168' : '#8A939A', background: s.on ? 'rgba(47,127,134,.10)' : '#F1F1EC', border: '1px solid rgba(0,0,0,.06)' }}>
              {s.label}: <b>{s.on ? 'on' : 'off'}</b>
            </span>
          ))}
        </div>
      )}

      {missingRequired.length > 0 && !it.notBuilt && (
        <div style={{ marginTop: 10, fontSize: 12, color: 'var(--amber,#B7791F)', background: 'var(--amber-bg,#F6EEDD)',
          border: '1px solid var(--line,#E7E1D3)', borderRadius: 8, padding: '7px 10px' }}>
          To turn this on, set {missingRequired.map((e) => <code key={e.name} style={{ fontFamily: 'ui-monospace,Menlo,monospace' }}>{e.name}</code>).reduce((a, b) => [a, ', ', b])} in the hosting settings (Render → Environment), then it goes live on the next deploy.
        </div>
      )}
      <div style={{ marginTop: 8, fontSize: 10.5, color: 'var(--muted,#8A939A)', display: 'flex', gap: 12, flexWrap: 'wrap' }}>
        {it.direction && it.direction !== '—' && <span>Direction: {it.direction}</span>}
        {it.auth && it.auth !== '—' && <span>Sign-in: {it.auth}</span>}
      </div>
    </div>
  );
}

/* Sitewire capability explorer (super_admin). Reads the Sitewire TEST system (never writes, never
   prod) and lists every field it exposes — the ones we already control vs the ones we could add
   next. This is how we turn "everything Sitewire can do" into PILOT buttons with confirmed field
   names. Needs the SITEWIRE_TEST_* keys in Render; values are redacted (names/types only). */
function SitewireExplorer() {
  const [running, setRunning] = useState(false);
  const [rep, setRep] = useState(null);
  const [err, setErr] = useState('');

  const run = async () => {
    setRunning(true); setErr(''); setRep(null);
    try { setRep(await api.sitewireExplore({})); }
    catch (e) { setErr(e.message || 'Could not reach the Sitewire test environment.'); }
    finally { setRunning(false); }
  };

  const types = rep && rep.catalog ? Object.keys(rep.catalog) : [];
  const newCount = rep && rep.new_fields ? rep.new_fields.length : 0;

  return (
    <section style={{ marginTop: 22 }}>
      <h3 style={{ fontFamily: 'var(--serif,Georgia,serif)', margin: '0 0 2px' }}>Sitewire capability explorer</h3>
      <p className="muted small" style={{ margin: '0 0 12px', maxWidth: 720 }}>
        Reads the Sitewire <b>test</b> system and lists every field it has — the ones PILOT already controls, and the
        ones we could add next — so nothing is guessed. It only ever <b>reads</b> (never changes anything), and uses a
        separate test key set in the hosting settings (<code style={{ fontFamily: 'ui-monospace,Menlo,monospace' }}>SITEWIRE_TEST_…</code>), never your live key.
      </p>
      <button className="btn" disabled={running} onClick={run}>{running ? 'Reading Sitewire…' : 'Discover Sitewire fields'}</button>
      {err && <p style={{ color: 'var(--crit,#B4483C)', fontSize: 13, marginTop: 10 }}>{err}</p>}

      {rep && rep.error === 'test_creds_missing' && (
        <div style={{ marginTop: 12, fontSize: 12.5, color: 'var(--amber,#B7791F)', background: 'var(--amber-bg,#F6EEDD)',
          border: '1px solid var(--line,#E7E1D3)', borderRadius: 8, padding: '10px 12px' }}>
          Add the test key in the hosting settings (Render → Environment) as <code>SITEWIRE_TEST_ACCESS_TOKEN</code>, <code>SITEWIRE_TEST_CLIENT</code>, <code>SITEWIRE_TEST_UID</code> (and <code>SITEWIRE_TEST_BASE_URL</code> if the test site uses a different address), then try again. Never paste the key here.
        </div>
      )}

      {rep && rep.catalog && (
        <div style={{ marginTop: 14 }}>
          <div className="row" style={{ gap: 8, flexWrap: 'wrap', marginBottom: 10 }}>
            <span style={{ fontSize: 12.5, fontWeight: 700, color: '#B4483C', background: '#F6E7E4', borderRadius: 999, padding: '4px 12px' }}>{newCount} new fields we could add</span>
            {rep.counts && Object.entries(rep.counts).map(([k, v]) => (
              <span key={k} className="muted" style={{ fontSize: 12, alignSelf: 'center' }}>{v} {k.replace(/_/g, ' ')}</span>
            ))}
          </div>
          {rep.errors && rep.errors.length > 0 && (
            <p className="muted small" style={{ marginBottom: 10 }}>Some endpoints did not return (test data may be sparse): {rep.errors.join(' · ')}</p>
          )}
          {types.map((t) => (
            <div key={t} style={{ border: '1px solid var(--line,#E7E1D3)', borderRadius: 10, padding: '10px 12px', marginBottom: 10 }}>
              <div style={{ fontWeight: 700, fontSize: 13, marginBottom: 6, fontFamily: 'ui-monospace,Menlo,monospace' }}>{t}</div>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                {rep.catalog[t].map((f) => (
                  <span key={f.name} title={`${f.type}${f.enum_values ? ' — ' + f.enum_values.join(', ') : ''}`}
                    style={{ fontSize: 11.5, fontFamily: 'ui-monospace,Menlo,monospace', borderRadius: 6, padding: '2px 8px',
                      border: '1px solid rgba(0,0,0,.06)',
                      color: f.integrated ? '#3F7A5B' : '#B4483C',
                      background: f.integrated ? 'rgba(63,122,91,.10)' : '#F6E7E4' }}>
                    {f.integrated ? '✓' : '＋'} {f.name}{f.enum_values ? ` (${f.enum_values.slice(0, 4).join('/')})` : ''}
                  </span>
                ))}
              </div>
            </div>
          ))}
          <p className="muted small" style={{ marginTop: 4 }}>Green = PILOT already controls it · Red ＋ = available to add. Only field names/types shown (no borrower data).</p>
        </div>
      )}
    </section>
  );
}

// The typed-confirmation modal for a switch that changes live behavior.
function ConfirmModal({ pending, text, setText, busy, onCancel, onConfirm }) {
  const phrase = pending.next ? 'TURN ON' : 'TURN OFF';
  const ok = text.trim().toUpperCase() === phrase;
  return (
    <div onClick={onCancel} style={{ position: 'fixed', inset: 0, background: 'rgba(20,27,34,.45)', display: 'flex',
      alignItems: 'center', justifyContent: 'center', zIndex: 1000, padding: 16 }}>
      <div onClick={(e) => e.stopPropagation()} style={{ background: '#fff', borderRadius: 14, maxWidth: 460, width: '100%',
        padding: '20px 22px', boxShadow: '0 20px 60px rgba(0,0,0,.3)' }}>
        <h3 style={{ margin: '0 0 8px', fontFamily: 'var(--serif,Georgia,serif)' }}>Confirm this change</h3>
        <p style={{ fontSize: 13.5, margin: '0 0 8px' }}>
          You’re about to <b>{pending.next ? 'turn ON' : 'turn OFF'}</b> “{pending.sw.label}”. This changes what the platform
          actually sends to the outside world, so it takes effect right away.
        </p>
        <p style={{ fontSize: 13, margin: '0 0 6px' }}>Type <code style={{ fontFamily: 'ui-monospace,Menlo,monospace', background: '#F1F1EC', padding: '1px 6px', borderRadius: 5 }}>{phrase}</code> to confirm.</p>
        <input autoFocus value={text} onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && ok && !busy) onConfirm(); }}
          placeholder={phrase} style={{ width: '100%', fontSize: 16, padding: '9px 11px', borderRadius: 8,
            border: '1px solid var(--line,#E7E1D3)', boxSizing: 'border-box' }} />
        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 14 }}>
          <button className="btn ghost" disabled={busy} onClick={onCancel}>Cancel</button>
          <button className="btn" disabled={!ok || busy} onClick={onConfirm}
            style={{ background: pending.next ? undefined : '#B4483C' }}>
            {busy ? 'Working…' : (pending.next ? 'Turn on' : 'Turn off')}
          </button>
        </div>
      </div>
    </div>
  );
}

export default function StaffApiHealth() {
  const { role } = useAuth();
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState('');
  const [testing, setTesting] = useState(null); // key currently being re-tested
  const [switchBusy, setSwitchBusy] = useState(null); // switch key currently being flipped
  const [pending, setPending] = useState(null); // { sw, next } awaiting typed confirm
  const [confirmText, setConfirmText] = useState('');

  const load = useCallback(async () => {
    setErr('');
    try { const d = await api.integrationsHealth(); setData(d); }
    catch (e) { setErr(e.message || 'Could not load API health.'); }
    finally { setLoading(false); }
  }, []);

  useEffect(() => { load(); }, [load]);

  const testOne = async (key) => {
    setTesting(key); setErr('');
    try {
      const d = await api.integrationTest(key);
      setData((prev) => prev ? { ...prev, integrations: prev.integrations.map((i) => i.key === key ? d.integration : i) } : prev);
    } catch (e) { setErr(e.message || 'Could not test that integration.'); }
    finally { setTesting(null); }
  };

  // Merge a server-returned switch (from toggle/reset) back into whichever integration owns it.
  const mergeSwitch = (after) => {
    setData((prev) => prev ? {
      ...prev,
      integrations: prev.integrations.map((it) => ({
        ...it,
        switches: (it.switches || []).map((s) => s.name === after.key
          ? { ...s, on: after.on, overridden: after.overridden, envDefault: after.envDefault } : s),
      })),
    } : prev);
  };

  const applyToggle = async (sw, enabled, confirm) => {
    setSwitchBusy(sw.name); setErr('');
    try { const d = await api.integrationToggleSwitch(sw.name, enabled, confirm); mergeSwitch(d.switch); }
    catch (e) { setErr(e.message || 'Could not change that switch.'); }
    finally { setSwitchBusy(null); }
  };

  const onToggle = (sw) => {
    const next = !sw.on;
    if (sw.dangerous) { setPending({ sw, next }); setConfirmText(''); return; }
    applyToggle(sw, next, false);
  };

  const onReset = async (sw) => {
    setSwitchBusy(sw.name); setErr('');
    try { const d = await api.integrationResetSwitch(sw.name); mergeSwitch(d.switch); }
    catch (e) { setErr(e.message || 'Could not reset that switch.'); }
    finally { setSwitchBusy(null); }
  };

  const confirmToggle = async () => {
    if (!pending) return;
    await applyToggle(pending.sw, pending.next, true);
    setPending(null); setConfirmText('');
  };

  const integrations = (data && data.integrations) || [];
  const counts = integrations.reduce((a, i) => { a[i.state] = (a[i.state] || 0) + 1; return a; }, {});
  const checkedAt = data && data.checkedAt ? new Date(data.checkedAt).toLocaleString() : null;

  return (
    <div className="wrap" style={{ maxWidth: 1100 }}>
      <div className="row" style={{ justifyContent: 'space-between', alignItems: 'flex-end', gap: 12, flexWrap: 'wrap' }}>
        <div>
          <h1 style={{ margin: '0 0 4px' }}>API Health</h1>
          <p className="muted" style={{ margin: 0, maxWidth: 640 }}>
            Every outside service PILOT connects to — whether it’s live, what it needs, a one-click test, and the on/off
            switches you can flip right here. Keys are set and rotated in the hosting settings (Render), never here, so a
            problem in the app can never leak a key.
          </p>
        </div>
        <button className="btn" disabled={loading} onClick={() => { setLoading(true); load(); }}>{loading ? 'Checking…' : 'Refresh all'}</button>
      </div>

      {err && <p style={{ color: 'var(--crit,#B4483C)', fontSize: 13 }}>{err}</p>}

      {/* summary */}
      {!loading && integrations.length > 0 && (
        <div className="row" style={{ gap: 8, flexWrap: 'wrap', margin: '14px 0 4px' }}>
          {[['live', 'Live'], ['unreachable', 'Not reachable'], ['disabled', 'Switched off'], ['configured', 'Configured'], ['not_configured', 'Not connected'], ['framework', 'Awaiting keys'], ['planned', 'Planned']]
            .filter(([k]) => counts[k]).map(([k, label]) => {
              const s = STATE[k];
              return <span key={k} style={{ fontSize: 12.5, fontWeight: 700, color: s.fg, background: s.bg, borderRadius: 999, padding: '4px 12px' }}>{counts[k]} {label}</span>;
            })}
          {checkedAt && <span className="muted small" style={{ alignSelf: 'center' }}>Last checked {checkedAt}</span>}
        </div>
      )}

      {loading && <p className="muted">Checking every integration…</p>}

      {GROUP_ORDER.map((g) => {
        const items = integrations.filter((i) => i.group === g);
        if (!items.length) return null;
        const meta = GROUP[g] || { title: g, blurb: '' };
        return (
          <section key={g} style={{ marginTop: 22 }}>
            <h3 style={{ fontFamily: 'var(--serif,Georgia,serif)', margin: '0 0 2px' }}>{meta.title}</h3>
            <p className="muted small" style={{ margin: '0 0 12px' }}>{meta.blurb}</p>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill,minmax(330px,1fr))', gap: 12 }}>
              {items.map((it) => (
                <Card key={it.key} it={it} onTest={testOne} testing={testing === it.key}
                  onToggle={onToggle} onReset={onReset} switchBusy={switchBusy} />
              ))}
            </div>
          </section>
        );
      })}

      {role === 'super_admin' && <SitewireExplorer />}

      {pending && (
        <ConfirmModal pending={pending} text={confirmText} setText={setConfirmText} busy={switchBusy === pending.sw.name}
          onCancel={() => { setPending(null); setConfirmText(''); }} onConfirm={confirmToggle} />
      )}
    </div>
  );
}
