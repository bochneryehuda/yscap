import React, { useCallback, useEffect, useState } from 'react';
import { api } from '../lib/api.js';
import { useAuth } from '../lib/auth.jsx';

/* API Health (admin / platform_setup).
   One section per external API / integration: is it Live, Configured, Off, or Not connected —
   with a live "Test now" check and plain-English fix guidance. Driven entirely by
   GET /api/admin/integrations/health, which is backed by the health registry, so any new
   integration added on the backend appears here automatically.

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

function Card({ it, onTest, testing }) {
  const missingRequired = (it.env || []).filter((e) => e.required && !e.set);
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
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: (it.switches && it.switches.length) ? 8 : 0 }}>
          {it.env.map((e) => <EnvChip key={e.name} e={e} />)}
        </div>
      )}
      {(it.switches && it.switches.length > 0) && (
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
          {it.switches.map((s) => (
            <span key={s.name} style={{ fontSize: 11, borderRadius: 6, padding: '2px 8px',
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

export default function StaffApiHealth() {
  const { role } = useAuth();
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState('');
  const [testing, setTesting] = useState(null); // key currently being re-tested

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

  const integrations = (data && data.integrations) || [];
  const counts = integrations.reduce((a, i) => { a[i.state] = (a[i.state] || 0) + 1; return a; }, {});
  const checkedAt = data && data.checkedAt ? new Date(data.checkedAt).toLocaleString() : null;

  return (
    <div className="wrap" style={{ maxWidth: 1100 }}>
      <div className="row" style={{ justifyContent: 'space-between', alignItems: 'flex-end', gap: 12, flexWrap: 'wrap' }}>
        <div>
          <h1 style={{ margin: '0 0 4px' }}>API Health</h1>
          <p className="muted" style={{ margin: 0, maxWidth: 640 }}>
            Every outside service PILOT connects to — whether it’s live, what it needs, and a one-click test.
            Keys are set and rotated in the hosting settings (Render), never here, so a problem in the app can never leak a key.
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
              {items.map((it) => <Card key={it.key} it={it} onTest={testOne} testing={testing === it.key} />)}
            </div>
          </section>
        );
      })}

      {role === 'super_admin' && <SitewireExplorer />}
    </div>
  );
}
