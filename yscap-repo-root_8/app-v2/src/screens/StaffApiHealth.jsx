import React, { useCallback, useEffect, useState } from 'react';
import { useLocation } from 'react-router-dom';
import { api } from '../lib/api.js';
import { useAuth } from '../lib/auth.jsx';
import { askConfirm } from '../lib/dialog.js';

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
  // A credential the connector reads under a name we ALSO accept is set — and the
  // chip says which name carried it, so "it says the key is missing but it plainly
  // works" can never happen. A NAME, never a value.
  const setAs = set ? (e.setAs || null) : null;
  return (
    <span title={setAs ? `Set — under the name ${setAs}, which this connector also reads`
      : (set ? 'Set' : (e.required ? 'Required — not set' : 'Optional — not set'))}
      style={{ fontSize: 11, fontFamily: 'ui-monospace,Menlo,monospace', color: fg, background: bg, border: '1px solid rgba(0,0,0,.06)',
        borderRadius: 6, padding: '2px 7px' }}>
      {set ? '✓' : (e.required ? '✕' : '○')} {e.name}
      {setAs ? <span style={{ opacity: .75 }}> (as {setAs})</span> : null}
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

/**
 * Elementix is the one integration on this page that a human has to APPROVE
 * rather than key in: PILOT signs in on the seat the company already pays for,
 * so nothing can be typed into Render to make it work. This is that approval.
 *
 * "Check" is offered separately, and deliberately: it answers the question the
 * vendor's own email did not — whether the sign-in renews itself, so nobody has
 * to keep re-approving — and it reads the endpoint's published settings without
 * spending any of the company's shared hourly allowance.
 */
function ElementixActions() {
  const [busy, setBusy] = useState('');
  const [note, setNote] = useState(null);
  // The real stored connection, read from OUR OWN database — never inferred from
  // the status light. The light folds "configured", "switched on" and "connected"
  // into one word, so a file with the lookups switched OFF reads the same as one
  // nobody has approved yet, and this panel would offer the wrong button.
  const [st, setSt] = useState(null);
  const loc = useLocation();

  const loadStatus = useCallback(async () => {
    try { setSt(await api.elementixStatus()); }
    catch (_) { setSt(null); } // the buttons still work; only the wording degrades
  }, []);
  useEffect(() => { loadStatus(); }, [loadStatus]);

  // The approval finishes in Elementix's browser tab, which sends the person back
  // here with the outcome on the address. Without this the screen would look
  // exactly as it did before they approved, and they would have no way to tell
  // whether it worked. Read from the ROUTE (HashRouter keeps the query inside the
  // hash, so window.location.search is empty here).
  const callback = React.useMemo(() => {
    const p = new URLSearchParams(loc.search || '');
    const outcome = p.get('elementix');
    if (outcome !== 'connected' && outcome !== 'error') return null;
    return { ok: outcome === 'connected', message: p.get('message') || '' };
  }, [loc.search]);

  const connected = !!(st && st.connected);

  async function connect() {
    setBusy('connect'); setNote(null);
    try {
      const r = await api.elementixConnect();
      if (!r || !r.ok || !r.authorizeUrl) {
        setNote({ bad: true, text: (r && (r.detail || r.reason)) || 'Could not start the sign-in.' });
        return;
      }
      // Leave the app ON PURPOSE. This has to happen in the address bar so the
      // person sees Elementix's own sign-in page and can trust what they are
      // approving; an in-page fetch would hide exactly the thing being consented to.
      window.location.href = r.authorizeUrl;
    } catch (e) {
      setNote({ bad: true, text: e.message || 'Could not start the sign-in.' });
    } finally { setBusy(''); }
  }

  async function check() {
    setBusy('check'); setNote(null);
    try {
      const d = await api.elementixDiscover();
      if (!d || !d.ok) {
        setNote({ bad: true, text: `Could not read Elementix’s sign-in settings${d && d.detail ? ` — ${d.detail}` : ''}.` });
        return;
      }
      const v = (d.unattended && d.unattended.verdict) || 'unknown';
      const text = v === 'likely'
        ? 'Good — Elementix offers the kind of sign-in that keeps itself alive, so this should only need approving once.'
        : v === 'unlikely'
          ? 'Heads up — Elementix does not appear to offer a self-renewing sign-in, so someone may have to approve again when it expires.'
          : 'Elementix does not say either way, so we will know for certain the moment you approve it once.';
      setNote({ bad: v === 'unlikely', text });
    } catch (e) {
      setNote({ bad: true, text: e.message || 'Could not check.' });
    } finally { setBusy(''); }
  }

  async function disconnect() {
    const okToGo = await askConfirm(
      'Forget the saved Elementix sign-in? Lookups stop working until someone approves it again. Nothing at Elementix is changed or cancelled.',
      { confirmLabel: 'Forget it', title: 'Disconnect Elementix' });
    if (!okToGo) return;
    setBusy('disconnect'); setNote(null);
    try {
      await api.elementixDisconnect();
      setNote({ text: 'Forgotten. Press Connect to approve it again.' });
      await loadStatus();
    } catch (e) {
      setNote({ bad: true, text: e.message || 'Could not disconnect.' });
    } finally { setBusy(''); }
  }

  return (
    <div style={{ marginTop: 10, borderTop: '1px solid rgba(0,0,0,.06)', paddingTop: 10 }}>
      {callback && (
        <div style={{ marginBottom: 10, fontSize: 12.5, fontWeight: 600,
          color: callback.ok ? '#256168' : '#B4483C',
          background: callback.ok ? 'rgba(47,127,134,.10)' : '#F6E7E4',
          border: '1px solid rgba(0,0,0,.06)', borderRadius: 8, padding: '9px 11px' }}>
          {callback.ok
            ? `Connected. ${callback.message || 'PILOT can now read Elementix on the company seat.'}`
            : `That did not go through${callback.message ? ` — ${callback.message}` : ''}. Nothing was saved; press Connect to try again.`}
        </div>
      )}
      <div style={{ fontSize: 12.5, color: '#4B585C', marginBottom: 8 }}>
        {connected
          ? (st.selfRenewing
            ? `Approved for the whole company. PILOT keeps itself signed in from here — nobody has to approve again.${st.lastError ? ` Last problem: ${st.lastError}` : ''}`
            : `Approved for the whole company, but Elementix did not hand over a renewal pass — somebody will have to press Connect again when this sign-in runs out.${st.lastError ? ` Last problem: ${st.lastError}` : ''}`)
          : 'This one is approved once in a browser instead of set up with a key: press Connect, sign in to Elementix as you normally would, and allow PILOT to read. It uses the seat you already pay for.'}
      </div>
      <div className="act-bar">
        <div className="act-group">
          <button className={`btn ${connected ? 'soft' : 'primary'} small`} disabled={!!busy} onClick={connect}>
            {busy === 'connect' ? 'Opening…' : (connected ? 'Approve again' : 'Connect')}
          </button>
          <button className="btn soft small" disabled={!!busy} onClick={check}
            title="Reads Elementix’s published sign-in settings. Costs nothing and spends none of the shared hourly allowance.">
            {busy === 'check' ? 'Checking…' : 'Check it stays signed in'}
          </button>
        </div>
        {connected && (
          <>
            <span className="act-sep" />
            <div className="act-group">
              <button className="btn ghost small" disabled={!!busy} onClick={disconnect}>
                {busy === 'disconnect' ? 'Working…' : 'Disconnect'}
              </button>
            </div>
          </>
        )}
      </div>
      {note && (
        <div style={{ marginTop: 8, fontSize: 12.5, color: note.bad ? '#B4483C' : '#256168',
          background: note.bad ? '#F6E7E4' : 'rgba(47,127,134,.10)', border: '1px solid rgba(0,0,0,.06)',
          borderRadius: 8, padding: '7px 10px' }}>{note.text}</div>
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
      {it.model && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 7, flexWrap: 'wrap', marginBottom: 8 }}>
          <span style={{ fontSize: 11, fontWeight: 800, letterSpacing: '.04em', textTransform: 'uppercase', color: '#4B585C' }}>Model in use</span>
          <span title="The exact model PILOT is running right now (the Azure deployment name). Set by AZURE_OPENAI_DEPLOYMENT in the hosting settings (Render)."
            style={{ fontSize: 12.5, fontWeight: 700, color: '#141B22', fontFamily: 'ui-monospace,Menlo,monospace',
              background: 'rgba(47,127,134,.12)', border: '1px solid rgba(0,0,0,.06)', borderRadius: 6, padding: '2px 9px' }}>{it.model}</span>
        </div>
      )}
      <div style={{ fontSize: 12.5, color: 'var(--muted,#4B585C)', marginBottom: 8 }}>{it.purpose}</div>
      {it.detail && <div style={{ fontSize: 12.5, marginBottom: 10 }}>{it.detail}</div>}

      {it.key === 'elementix' && <ElementixActions />}

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

/* Sitewire field explorer (super_admin). An OPTIONAL, behind-the-scenes helper: it READS the
   Sitewire TEST system (never writes, never the live account) and lists every field it exposes —
   the ones PILOT already controls vs the ones we could add next — so new Sitewire features are built
   on confirmed field names instead of guesses. It is NOT required for construction draws to work.
   Needs the SITEWIRE_TEST_* keys in Render; values are redacted (names/types only).

   IMPORTANT (plain English, never a raw code): when the test login isn't set up, the backend replies
   with a non-OK status, which the api helper turns into a thrown error whose text is the bare code
   `test_creds_missing`. So we read the STRUCTURED body off the error (e.data) and always show a
   friendly amber note — the raw code must never reach the owner. */
function SitewireExplorer() {
  const [running, setRunning] = useState(false);
  const [rep, setRep] = useState(null);
  // A single, always-plain-English problem: { notSetUp:true } OR { message:'…' }. Never a raw code.
  const [problem, setProblem] = useState(null);

  const run = async () => {
    setRunning(true); setProblem(null); setRep(null);
    try {
      const r = await api.sitewireExplore({});
      // The explorer can also hand back a structured "not set up" result on a 200.
      if (r && r.error === 'test_creds_missing') setProblem({ notSetUp: true });
      else setRep(r);
    } catch (e) {
      // A non-2xx (400 not-set-up, 502 unreachable, 403 …) throws with the structured body on e.data.
      const data = (e && e.data) || {};
      if (data.error === 'test_creds_missing') setProblem({ notSetUp: true });
      else setProblem({ message: data.message || data.error || 'Could not reach the Sitewire test system — please try again in a moment.' });
    } finally { setRunning(false); }
  };

  const types = rep && rep.catalog ? Object.keys(rep.catalog) : [];
  const newCount = rep && rep.new_fields ? rep.new_fields.length : 0;

  return (
    <section style={{ marginTop: 22 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', marginBottom: 2 }}>
        <h3 style={{ fontFamily: 'var(--serif,Georgia,serif)', margin: 0 }}>Sitewire field explorer</h3>
        <span style={{ fontSize: 11, fontWeight: 800, letterSpacing: '.04em', textTransform: 'uppercase', color: '#8A7A55',
          background: '#F3EEE0', borderRadius: 999, padding: '3px 10px' }}>Optional helper</span>
      </div>
      {/* Same card shell as every integration above, so it reads as "a card like everything else". */}
      <div style={{ border: '1px solid var(--line,#E7E1D3)', borderLeft: '4px solid #8A7A55', borderRadius: 12,
        background: 'var(--card,#fff)', padding: '14px 16px', marginTop: 8 }}>
        <p className="muted small" style={{ margin: '0 0 12px', maxWidth: 720 }}>
          A behind-the-scenes helper for building new Sitewire features. It peeks at Sitewire’s own <b>test</b> system and
          lists the field names their system uses, so anything we add later uses the exact right names instead of a guess.
          You don’t need this for construction draws to work. It only ever <b>reads</b> — it never changes anything, never
          touches your real Sitewire account, and never shows a borrower’s information. It uses a separate test login kept in
          the hosting settings (<code style={{ fontFamily: 'ui-monospace,Menlo,monospace' }}>SITEWIRE_TEST_…</code>), never your live key.
        </p>
        <button className="btn" disabled={running} onClick={run}>{running ? 'Reading Sitewire…' : 'Discover Sitewire fields'}</button>

        {problem && problem.notSetUp && (
          <div style={{ marginTop: 12, fontSize: 12.5, color: 'var(--amber,#B7791F)', background: 'var(--amber-bg,#F6EEDD)',
            border: '1px solid var(--line,#E7E1D3)', borderRadius: 8, padding: '10px 12px' }}>
            This helper isn’t set up yet — and that’s fine, it’s optional. Construction draws still work normally without it.
            To turn it on, a developer adds a separate Sitewire <b>test</b> login in the hosting settings (Render → Environment)
            as <code>SITEWIRE_TEST_ACCESS_TOKEN</code>, <code>SITEWIRE_TEST_CLIENT</code>, and <code>SITEWIRE_TEST_UID</code>
            (plus <code>SITEWIRE_TEST_BASE_URL</code> if the test site uses a different address). It never uses your live
            Sitewire key. Never paste a key here.
          </div>
        )}
        {problem && !problem.notSetUp && (
          <div style={{ marginTop: 12, fontSize: 12.5, color: 'var(--amber,#B7791F)', background: 'var(--amber-bg,#F6EEDD)',
            border: '1px solid var(--line,#E7E1D3)', borderRadius: 8, padding: '10px 12px' }}>
            {problem.message}
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
      </div>
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

/* Document-mirror scoreboard + backfill controls (platform_setup). Plain-English
   proof of "is every document in SharePoint?" — total documents vs how many are
   in SharePoint vs waiting vs stuck — plus a one-click "Copy everything now" (a
   full sweep) and "Retry stuck ones" (re-drive every document that was set aside
   after repeated failures). Wired to the existing, tested admin/sharepoint
   reconciliation + mirror + retry-exhausted endpoints. The req() helper throws
   with the structured body on e.data, so a plain-English reason always shows and
   a raw code never reaches the owner. */
/**
 * THE GOOGLE-COORDINATE LICENSING RULE, ON A SCREEN.
 *
 * The rule that keeps a Google-sourced coordinate out of the permanent property
 * warehouse is enforced by the database itself — but if that rule ever fails to
 * install, the app runs on happily with it switched off. The guard exists to say
 * so, and until now it said so only in the boot log and in the raw JSON of a
 * public endpoint. This is the page somebody actually opens to ask "is that
 * still on?", which is the same argument the environment chips make one section
 * below. Loads its own data, like the mirror panel above it.
 */
function LicensingControlPanel() {
  const [st, setSt] = useState(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try { setSt(await api.researchLicensing()); }
    // A screen that cannot ask must not imply the answer is fine.
    catch (e) { setSt({ ok: false, checked: false, why: (e && e.message) || 'Could not check.' }); }
    finally { setLoading(false); }
  }, []);
  useEffect(() => { load(); }, [load]);

  if (loading || !st) return null;
  /* A QUALIFIED YES IS NOT A YES. The server attaches a `why` to an `ok:true`
     answer in exactly one situation: the write probe could not run, so the verdict
     fell back to reading the constraint's TEXT — and a `lower()` shadowed from an
     earlier schema deparses byte-identically to db/459's while refusing nothing.
     Reading `ok` alone painted that green with the canned "the database itself
     refuses…" line underneath, which is the confident sentence this whole control
     exists to stop being printed when it is not true. No new field is needed: the
     guard never attaches a `why` to an unqualified pass. */
  const qualified = st.ok === true && !!st.why;
  const good = st.ok === true && !qualified;
  // Unconfirmed is its OWN state — amber, never green and never the red of a
  // rule we have proven is missing. A qualified yes lands here too.
  const fg = good ? '#3F7A5B' : (st.checked && !qualified ? '#B4483C' : '#8A6D1F');
  const bg = good ? 'rgba(63,122,91,.08)' : (st.checked && !qualified ? '#F6E7E4' : '#FBF3DF');
  return (
    <section style={{ marginTop: 18, border: '1px solid rgba(0,0,0,.08)', borderRadius: 10,
      background: bg, padding: '12px 14px' }}>
      <div className="row" style={{ gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
        <strong style={{ color: '#141B22' }}>Property warehouse — Google coordinate rule</strong>
        <span style={{ fontSize: 12.5, fontWeight: 700, color: fg }}>
          {good ? '✓ On'
            : qualified ? '○ Not fully confirmed'
              : (st.checked ? '✕ NOT installed' : '○ Not confirmed')}
        </span>
        <button className="btn ghost small" onClick={load} style={{ marginLeft: 'auto' }}>Re-check</button>
      </div>
      <p className="small" style={{ margin: '6px 0 0', color: '#3A4550' }}>
        {good
          ? 'The database itself refuses to store a Google-sourced coordinate in the property '
            + 'warehouse. Google may suggest an address and draw a map; it may never place a property here.'
          : (st.why || 'The rule could not be confirmed.')}
      </p>
      {st.at && <p className="small muted" style={{ margin: '4px 0 0' }}>Last checked {String(st.at).replace('T', ' ').slice(0, 19)} UTC</p>}
    </section>
  );
}

function MirrorBackfillPanel() {
  const [recon, setRecon] = useState(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(null);      // 'sweep' | 'retry' | 'refresh'
  const [msg, setMsg] = useState('');
  const [notEnabled, setNotEnabled] = useState(false);

  const load = useCallback(async () => {
    setErr(''); setBusy('refresh');
    try { const r = await api.sharepointReconciliation(); setRecon(r); setNotEnabled(false); }
    catch (e) {
      const data = (e && e.data) || {};
      if (/not enabled/i.test(data.error || e.message || '')) setNotEnabled(true);
      else setErr(data.error || e.message || 'Could not load the mirror status.');
    } finally { setLoading(false); setBusy(null); }
  }, []);
  useEffect(() => { load(); }, [load]);

  const runSweep = async () => {
    setBusy('sweep'); setMsg(''); setErr('');
    try { await api.sharepointRunSweep(); setMsg('Started copying everything now — it works through the list in the background. Give it a moment, then Refresh to watch the numbers move.'); setTimeout(load, 4000); }
    catch (e) { setErr((e && e.data && e.data.error) || e.message || 'Could not start the copy.'); }
    finally { setBusy(null); }
  };
  const retryStuck = async () => {
    setBusy('retry'); setMsg(''); setErr('');
    try { const r = await api.sharepointRetryStuck(); setMsg(`Re-queued ${(r && r.requeued) || 0} stuck document(s) to try again. Refresh in a moment to watch them clear.`); setTimeout(load, 4000); }
    catch (e) { setErr((e && e.data && e.data.error) || e.message || 'Could not retry the stuck ones.'); }
    finally { setBusy(null); }
  };

  const n = (v) => (v == null ? '—' : Number(v).toLocaleString());
  const waiting = recon ? Number(recon.pending || 0) : 0;
  const stuck = recon ? Number(recon.exhausted || 0) : 0;
  // The deliberately-not-copied pile. `skipped_not_mirrored` excludes a copy a
  // person moved in SharePoint (it carries a skip reason but IS in there);
  // fall back to the older `skipped` so a cached bundle still shows a number.
  const skipped = recon ? Number(recon.skipped_not_mirrored ?? recon.skipped ?? 0) : 0;
  const breakdown = (recon && Array.isArray(recon.skipped_breakdown)) ? recon.skipped_breakdown : null;
  const unaccounted = recon ? Number(recon.unaccounted || 0) : 0;
  const oldestHrs = recon ? recon.oldest_pending_hours : null;
  const allClear = recon && waiting === 0 && stuck === 0;
  // "Not copied on purpose" sits directly beside "In SharePoint" so the two
  // numbers that explain the total read together (owner-reported 2026-08-09:
  // "2,655 total / 1,755 in SharePoint … why are not all documents in
  // SharePoint?"). The gap was never missing documents — it was this pile, named
  // once in grey small print. A third of the library deserves its own tile.
  const tiles = recon ? [
    { label: 'Total documents', value: n(recon.total_docs), tone: null },
    { label: 'In SharePoint', value: n(recon.mirrored), tone: 'good' },
    { label: 'Not copied on purpose', value: n(skipped), tone: null },
    { label: 'Waiting to copy', value: n(recon.pending), tone: waiting > 0 ? 'warn' : null },
    { label: 'Stuck', value: n(recon.exhausted), tone: stuck > 0 ? 'bad' : null },
  ] : [];
  const toneBg = { good: 'rgba(63,122,91,.08)', warn: '#F6EEDD', bad: '#F6E7E4' };

  return (
    <section style={{ marginTop: 22 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', marginBottom: 2 }}>
        <h3 style={{ fontFamily: 'var(--serif,Georgia,serif)', margin: 0 }}>Document mirror — SharePoint</h3>
        <button className="btn ghost small" disabled={busy != null} onClick={load}>{busy === 'refresh' ? 'Checking…' : 'Refresh'}</button>
      </div>
      <div style={{ border: '1px solid var(--line,#E7E1D3)', borderLeft: '4px solid #2F7F86', borderRadius: 12,
        background: 'var(--card,#fff)', padding: '14px 16px', marginTop: 8 }}>
        <p className="small" style={{ margin: '0 0 12px', maxWidth: 760, color: '#4B585C' }}>
          Every document PILOT saves is copied into your team SharePoint site. This is the live scoreboard — how many are
          already in SharePoint, how many are waiting, and how many are stuck. Use <b>Copy everything now</b> to force a full
          sweep, and <b>Retry stuck ones</b> to re-try any that were set aside after repeated failures. Anything still stuck
          also appears in your review queue and emails the team.
        </p>

        {notEnabled ? (
          <div style={{ fontSize: 12.5, color: '#B7791F', background: '#F6EEDD',
            border: '1px solid var(--line,#E7E1D3)', borderRadius: 8, padding: '10px 12px' }}>
            The SharePoint mirror is switched off on this server. Turn it on in the “SharePoint (document mirror)” card above to start copying.
          </div>
        ) : loading ? (
          <p style={{ color: '#4B585C' }}>Loading the scoreboard…</p>
        ) : recon ? (
          <>
            <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
              {tiles.map((t) => (
                <div key={t.label} style={{ border: '1px solid var(--line,#E7E1D3)', borderRadius: 10, padding: '10px 14px',
                  minWidth: 120, background: t.tone ? toneBg[t.tone] : '#fff' }}>
                  <div style={{ fontSize: 22, fontWeight: 800, color: '#141B22' }}>{t.value}</div>
                  <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: '.03em', textTransform: 'uppercase', color: '#4B585C' }}>{t.label}</div>
                </div>
              ))}
            </div>
            <div style={{ marginTop: 10, fontSize: 12.5, color: allClear ? '#3F7A5B' : '#4B585C' }}>
              {allClear
                ? '✓ Everything saved is in SharePoint — nothing waiting, nothing stuck.'
                : `${waiting > 0 ? `${n(waiting)} waiting${oldestHrs != null ? ` (oldest ${oldestHrs}h)` : ''}. ` : ''}${stuck > 0 ? `${n(stuck)} stuck — use “Retry stuck ones” below.` : ''}`}
            </div>

            {/* The gap, spelled out. Every document with a copy saved is either in
                SharePoint, on this list, waiting, or stuck — so the two big numbers
                on the tiles above always add up, and you can see exactly why. */}
            {skipped > 0 && (
              <div style={{ marginTop: 12, border: '1px solid var(--line,#E7E1D3)', borderRadius: 10,
                background: 'var(--surface-soft,#FAF8F3)', padding: '11px 13px' }}>
                <div style={{ fontSize: 12.5, color: '#141B22', fontWeight: 700 }}>
                  Why {n(skipped)} of them are not copied
                </div>
                <div style={{ fontSize: 12, color: '#4B585C', margin: '3px 0 0' }}>
                  These are on purpose — nothing is lost, every one is still saved inside PILOT.
                  {' '}{n(recon.mirrored)} in SharePoint + {n(skipped)} here = {n(recon.total_docs)} saved.
                </div>
                {breakdown ? (
                  <ul style={{ margin: '9px 0 0', padding: 0, listStyle: 'none' }}>
                    {breakdown.map((b) => (
                      <li key={b.key} style={{ display: 'flex', gap: 10, alignItems: 'baseline',
                        padding: '4px 0', borderTop: '1px solid var(--line,#EFEAE0)' }}>
                        <span style={{ fontSize: 12.5, fontWeight: 700, color: '#141B22',
                          minWidth: 54, textAlign: 'right', flexShrink: 0 }}>{n(b.count)}</span>
                        <span style={{ fontSize: 12, color: b.key === 'other' ? '#B7791F' : '#4B585C' }}>{b.label}</span>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <div style={{ fontSize: 12, color: '#8A939A', marginTop: 6 }}>
                    e.g. Heter Iska, appraisal photos. Refresh to see the full list.
                  </div>
                )}
              </div>
            )}

            {unaccounted > 0 && (
              <div style={{ marginTop: 10, fontSize: 12.5, color: '#B7791F' }}>
                {n(unaccounted)} just saved and not sorted yet — check back in a minute.
              </div>
            )}
          </>
        ) : null}

        {!notEnabled && (
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 14 }}>
            <button className="btn" disabled={busy != null} onClick={runSweep}>{busy === 'sweep' ? 'Starting…' : 'Copy everything now'}</button>
            <button className="btn ghost" disabled={busy != null} onClick={retryStuck}>{busy === 'retry' ? 'Retrying…' : 'Retry stuck ones'}</button>
          </div>
        )}

        {msg && <div style={{ marginTop: 12, fontSize: 12.5, color: '#256168', background: 'rgba(47,127,134,.10)',
          border: '1px solid var(--line,#E7E1D3)', borderRadius: 8, padding: '10px 12px' }}>{msg}</div>}
        {err && <div style={{ marginTop: 12, fontSize: 12.5, color: '#B4483C' }}>{err}</div>}
      </div>
    </section>
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

  // After a switch actually changes, re-run that integration's live check so its status light AND
  // plain-English detail reflect the new state right away. Without this they stay stale (still say
  // "Switched off" / "…is off") until the next full refresh — which reads as "I turned it on but it
  // still says off". Find the owning card by which one carries this switch (membership is stable).
  const reprobeOwnerOf = (switchName) => {
    const owner = ((data && data.integrations) || []).find((it) => (it.switches || []).some((s) => s.name === switchName));
    if (owner) testOne(owner.key);
  };

  const applyToggle = async (sw, enabled, confirm) => {
    setSwitchBusy(sw.name); setErr('');
    try { const d = await api.integrationToggleSwitch(sw.name, enabled, confirm); mergeSwitch(d.switch); reprobeOwnerOf(sw.name); }
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
    try { const d = await api.integrationResetSwitch(sw.name); mergeSwitch(d.switch); reprobeOwnerOf(sw.name); }
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

      {/* HOW MUCH ROOM IS LEFT ON EACH OUTSIDE SERVICE (owner-directed 2026-08-07, after
          ClickUp phoned about our request rate). "Held back" is the number to watch: while
          it stays at zero the cap is never in anybody's way, and a climbing count is the
          signal to raise a limit BEFORE a provider calls. Renders nothing until the
          budgets exist. Explicit dark text — var(--ink*) is a LIGHT token here. */}
      {!loading && Array.isArray(data && data.rateLimits) && data.rateLimits.length > 0 && (
        <div className="panel" style={{ marginTop: 16 }}>
          <div className="panel-h"><h3>Request limits</h3></div>
          <div className="panel-b">
            <p className="small" style={{ margin: '0 0 8px', color: '#4B585C' }}>
              PILOT paces itself so it never asks an outside service for more than they allow — counted across
              every part of PILOT at once, not per copy. “Held back” is how many times we had to wait our turn.
            </p>
            <div style={{ overflowX: 'auto' }}>
              <table className="small" style={{ width: '100%', borderCollapse: 'collapse', color: '#141B22', minWidth: 420 }}>
                <thead>
                  <tr>
                    {['Service', 'Allowed per minute', 'Room left right now', 'Held back'].map((h) => (
                      <th key={h} style={{ textAlign: 'left', padding: '4px 10px 6px 0', color: '#4B585C', fontWeight: 600, whiteSpace: 'nowrap' }}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {data.rateLimits.map((r) => (
                    <tr key={r.api}>
                      <td style={{ padding: '3px 10px 3px 0', fontWeight: 600 }}>{r.api}</td>
                      <td style={{ padding: '3px 10px 3px 0' }}>{r.limitPerMin}</td>
                      <td style={{ padding: '3px 10px 3px 0' }}>{Math.floor(r.tokensAvailable)}</td>
                      <td style={{ padding: '3px 10px 3px 0', color: r.waits > 0 ? '#8A6D3B' : '#4B585C' }}>{r.waits}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}

      {/* The document-mirror scoreboard + backfill controls — front and center,
          because "is every document in SharePoint?" is the question this page most
          needs to answer at a glance. Loads its own data independent of the list. */}
      <MirrorBackfillPanel />

      {/* A licensing control that reports itself — but only into the boot log
          until it appeared here. Same argument as the environment chips below. */}
      <LicensingControlPanel />

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
