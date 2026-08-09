import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useLocation } from 'react-router-dom';
import { api } from '../lib/api.js';
import { useAuth } from '../lib/auth.jsx';
import { askConfirm } from '../lib/dialog.js';

/* API Health (admin / platform_setup) — the status desk for every outside service PILOT
   talks to: is it Live, Configured, Off, or Not connected, with a live "Test now" check,
   plain-English fix guidance, and the on/off switches you can flip right here.

   Driven entirely by GET /api/admin/integrations/health, which is backed by the health
   registry — so an integration added on the backend appears here on its own, in its
   group, with its status, its credential chips and its switches, with no change here.

   A switch that changes live behaviour (sending e-signatures, writing to ClickUp or
   Sitewire) is marked and asks you to type a short confirmation first. Turning one off
   takes effect immediately; "Reset" returns it to the hosting default.

   Keys are set and rotated in the hosting dashboard (Render), never here — this page
   reads status only and never shows or accepts a secret value.

   ── THE REDESIGN (owner-directed 2026-08-09, "the API health page is very outdated …
   focus on modernization") ──────────────────────────────────────────────────────────
   The old screen answered "what is the state of each of these 28 things?" but never
   "is anything broken right now?", and it was built entirely from hand-written inline
   hex, so it could not follow the portal palette. The shape now:

     1. ONE VERDICT, first. A headline that says whether anything needs attention, the
        whole estate's mix on a single bar, and a legend whose counts ARE the filter.
     2. PROBLEMS FIRST. Within every group an unreachable service sorts to the top and
        opens itself; a healthy one collapses to its status, name and purpose.
     3. FINDABLE. Search (press "/") plus a filter, because scrolling six sections to
        check on one named vendor is not a way to run an integration.
     4. HOW LONG. A red light says "since when" from the monitor's own record, and the
        page states plainly when nothing is watching between visits — "all green" means
        something quite different when the only checker is whoever opens the page.

   REFRESH IS DELIBERATELY MANUAL. Every load of /health probes ~28 outside services for
   real; auto-polling this screen would put a standing load on every vendor we use, and
   ClickUp has already phoned once about our request rate. So the freshness signal is a
   client-side clock ("checked 45s ago", free) and the reload is a human's click, which
   no longer blanks the page while it runs. */

// ── status vocabulary ──────────────────────────────────────────────────────────────
// One entry per `state` word the backend computes: the label, the tone class that
// decides its colour, the bar colour, and whether it counts as a PROBLEM. "Problem"
// is deliberately just `unreachable` — the same definition the down-alert monitor
// uses (src/lib/integrations/monitor.js isDownState), so the page and the alert email
// can never disagree about what "something is wrong" means. Switched off, not
// connected and awaiting-keys are all deliberate states, never faults.
const STATE = {
  live:           { label: 'Live',            tone: 'ah-t-live', bar: '#2E7A5E', rank: 5 },
  configured:     { label: 'Configured',      tone: 'ah-t-info', bar: '#2F7F86', rank: 3 },
  disabled:       { label: 'Switched off',    tone: 'ah-t-warn', bar: '#C79A3C', rank: 1 },
  unreachable:    { label: 'Not reachable',   tone: 'ah-t-bad',  bar: '#A32A2A', rank: 0, problem: true },
  not_configured: { label: 'Not connected',   tone: 'ah-t-mute', bar: '#C7C0B0', rank: 2 },
  framework:      { label: 'Ready — add keys', tone: 'ah-t-mute', bar: '#D9D4C8', rank: 4 },
  planned:        { label: 'Planned',         tone: 'ah-t-mute', bar: '#EAE4D7', rank: 6 },
};
const stateOf = (s) => STATE[s] || STATE.not_configured;
// Bar + legend order: worst first, so the eye lands on trouble before it lands on green.
const STATE_ORDER = ['unreachable', 'disabled', 'not_configured', 'configured', 'framework', 'planned', 'live'];

const GROUP = {
  core:      { title: 'Document AI', blurb: 'The reading + analysis brain behind the underwriting desk.' },
  workflow:  { title: 'Workflow & documents', blurb: 'Pipeline sync, e-signatures, the document mirror, and construction draws.' },
  comms:     { title: 'Email', blurb: 'How the platform sends notifications and receives replies.' },
  data:      { title: 'Address & data lookups', blurb: 'Address verification, property photos, flood, and OCR helpers.' },
  framework: { title: 'Built, awaiting keys', blurb: 'Fully coded — they switch on the moment credentials are added.' },
  planned:   { title: 'Planned / not connected yet', blurb: 'Reserved slots for integrations we haven’t wired up.' },
};
const GROUP_ORDER = ['core', 'workflow', 'comms', 'data', 'framework', 'planned'];

/* The filters offered above the list. `test` runs against a resolved integration.
   A filter is EITHER one of these keys or the synthetic `state:<name>` the legend sets,
   so the count somebody just read in the hero is the thing they get when they click it —
   resolved in one place (`filterFn`) so the two controls can never disagree. */
const FILTERS = [
  { key: 'all',       label: 'All',             test: () => true },
  { key: 'attention', label: 'Needs attention', test: (i) => !!stateOf(i.state).problem },
  { key: 'live',      label: 'Live',            test: (i) => i.state === 'live' },
  { key: 'off',       label: 'Switched off',    test: (i) => i.state === 'disabled' },
  { key: 'switches',  label: 'Has switches',    test: (i) => (i.switches || []).length > 0 },
  { key: 'nokeys',    label: 'Awaiting keys',   test: (i) => i.state === 'framework' || i.state === 'not_configured' },
];
const STATE_FILTER = 'state:';
function filterFor(key) {
  if (key && key.startsWith(STATE_FILTER)) {
    const want = key.slice(STATE_FILTER.length);
    return (i) => i.state === want;
  }
  return (FILTERS.find((f) => f.key === key) || FILTERS[0]).test;
}

// ── small helpers ──────────────────────────────────────────────────────────────────
// A figure, or an em dash. Anything that is not a real number reads "—", never the
// literal "NaN" — a scoreboard that prints NaN teaches people its numbers are junk.
const n = (v) => { const x = Number(v); return (v == null || !Number.isFinite(x)) ? '—' : x.toLocaleString(); };

/* "3 days" / "2h" / "just now" — a duration a person reads without doing arithmetic.
   Returns null for anything unparseable rather than a fabricated "0m": a red light
   with no honest since-when is better than one with an invented one. */
function since(iso) {
  if (!iso) return null;
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return null;
  const s = Math.max(0, Math.round((Date.now() - t) / 1000));
  if (s < 60) return 'just now';
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h} hour${h === 1 ? '' : 's'}`;
  return `${Math.round(h / 24)} days`;
}

function Icon({ name }) {
  const p = {
    check:   <><circle cx="12" cy="12" r="9" /><path d="M8.5 12.3l2.4 2.4 4.6-5" /></>,
    alert:   <><path d="M12 4l8.5 15h-17z" /><path d="M12 10v4" /><path d="M12 17.5h.01" /></>,
    pause:   <><circle cx="12" cy="12" r="9" /><path d="M10 9v6M14 9v6" /></>,
    plug:    <><path d="M9 3v6M15 3v6" /><path d="M6 9h12v3a6 6 0 01-12 0z" /><path d="M12 18v3" /></>,
    search:  <><circle cx="11" cy="11" r="7" /><path d="M20 20l-3.6-3.6" /></>,
    chevron: <><path d="M6 9l6 6 6-6" /></>,
    refresh: <><path d="M20 11a8 8 0 10-2.3 6.3" /><path d="M20 5v6h-6" /></>,
    gauge:   <><path d="M12 13l4-4" /><path d="M4 18a9 9 0 1116 0" /></>,
    cloud:   <><path d="M7 18h10a4 4 0 000-8 6 6 0 00-11.7 1.7A3.5 3.5 0 006 18z" /></>,
    shield:  <><path d="M12 3l7 3v6c0 4.2-2.9 7.6-7 9-4.1-1.4-7-4.8-7-9V6z" /><path d="M9 12l2 2 4-4" /></>,
    bell:    <><path d="M18 15V10a6 6 0 10-12 0v5l-1.5 2.5h15z" /><path d="M10 20a2 2 0 004 0" /></>,
    compass: <><circle cx="12" cy="12" r="9" /><path d="M15 9l-1.8 4.2L9 15l1.8-4.2z" /></>,
  }[name] || null;
  return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7"
    strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{p}</svg>;
}

// The status pill. Tone + label both come from STATE, so a state added on the backend
// only ever needs an entry there.
function Light({ state }) {
  const s = stateOf(state);
  return <span className={`ah-pill ${s.tone}`}><span className="ah-dot" />{s.label}</span>;
}

/* One credential NAME and whether it is set. A credential the connector reads under a
   name we ALSO accept is set — and the chip says WHICH name carried it, so "it says the
   key is missing but it plainly works" can never happen. A NAME, never a value. */
function EnvChip({ e }) {
  const tone = e.set ? 'ah-t-live' : (e.required ? 'ah-t-bad' : 'ah-t-mute');
  const title = e.set
    ? (e.setAs ? `Set — under the name ${e.setAs}, which this connector also reads` : 'Set')
    : (e.required ? 'Required — not set' : 'Optional — not set');
  return (
    <span className={`ah-envchip ${tone}`} title={title}>
      {e.set ? '✓' : (e.required ? '✕' : '○')} {e.name}
      {e.set && e.setAs ? <span className="ah-envas">(as {e.setAs})</span> : null}
    </span>
  );
}

// A real on/off control (accessible: role="switch").
function Toggle({ on, disabled, onClick, danger, label }) {
  return (
    <button type="button" role="switch" aria-checked={on} aria-label={label} disabled={disabled}
      onClick={onClick} className={`ah-tog${on ? ' ah-on' : ''}${danger ? ' ah-danger' : ''}`}><i /></button>
  );
}

// One runtime, toggleable switch (a real control, not a read-out).
function SwitchRow({ s, busy, onToggle, onReset }) {
  const sub = [
    s.on ? 'On' : 'Off',
    s.overridden ? `overridden — the hosting default is ${s.envDefault ? 'on' : 'off'}` : 'matches the hosting default',
  ];
  if (s.resume && s.on) sub.push('turning off applies right away; the background reader fully stops on the next restart');
  return (
    <div className="ah-sw">
      <Toggle on={s.on} danger={s.dangerous} disabled={busy} onClick={() => onToggle(s)} label={s.label} />
      <div className="ah-sw-l">
        <div className="ah-sw-t">
          {s.label}
          {s.dangerous && (
            <span className="ah-tag ah-t-bad" title="Changes what the platform actually sends to the outside world — you’ll be asked to confirm.">
              changes live behavior
            </span>
          )}
          {s.overridden && (
            <span className="ah-tag ah-t-warn" title="An admin flipped this from the hosting default. Reset returns it to the default.">
              overridden
            </span>
          )}
        </div>
        <div className="ah-sw-s">{sub.join(' · ')}</div>
      </div>
      {s.overridden && (
        <button className="btn ghost small" disabled={busy} onClick={() => onReset(s)}
          title="Return this switch to the hosting default">Reset</button>
      )}
    </div>
  );
}

/**
 * Elementix is the one integration on this page that a human has to APPROVE rather than
 * key in: PILOT signs in on the seat the company already pays for, so nothing can be
 * typed into Render to make it work. This is that approval.
 *
 * "Check" is offered separately, and deliberately: it answers the question the vendor's
 * own email did not — whether the sign-in renews itself, so nobody has to keep
 * re-approving — and it reads the endpoint's published settings without spending any of
 * the company's shared hourly allowance.
 */
function ElementixActions() {
  const [busy, setBusy] = useState('');
  const [note, setNote] = useState(null);
  // The real stored connection, read from OUR OWN database — never inferred from the
  // status light. The light folds "configured", "switched on" and "connected" into one
  // word, so a file with the lookups switched OFF reads the same as one nobody has
  // approved yet, and this panel would offer the wrong button.
  const [st, setSt] = useState(null);
  const loc = useLocation();

  const loadStatus = useCallback(async () => {
    try { setSt(await api.elementixStatus()); }
    catch (_) { setSt(null); } // the buttons still work; only the wording degrades
  }, []);
  useEffect(() => { loadStatus(); }, [loadStatus]);

  // The approval finishes in Elementix's browser tab, which sends the person back here
  // with the outcome on the address. Without this the screen would look exactly as it
  // did before they approved, and they would have no way to tell whether it worked.
  // Read from the ROUTE (HashRouter keeps the query inside the hash, so
  // window.location.search is empty here).
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
      // Leave the app ON PURPOSE. This has to happen in the address bar so the person
      // sees Elementix's own sign-in page and can trust what they are approving; an
      // in-page fetch would hide exactly the thing being consented to.
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
    <div className="ah-body">
      {callback && (
        <div className={`ah-note ${callback.ok ? 'ah-t-info' : 'ah-t-bad'}`}>
          {callback.ok
            ? `Connected. ${callback.message || 'PILOT can now read Elementix on the company seat.'}`
            : `That did not go through${callback.message ? ` — ${callback.message}` : ''}. Nothing was saved; press Connect to try again.`}
        </div>
      )}
      <div className="ah-sw-s" style={{ marginTop: 2 }}>
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
      {note && <div className={`ah-note ${note.bad ? 'ah-t-bad' : 'ah-t-info'}`}>{note.text}</div>}
    </div>
  );
}

/* ONE INTEGRATION.
   Collapsed it carries what you read at a glance — status, name, what it is for, and
   the one plain-English sentence saying what is happening. Expanding adds the reference
   material: the credential NAMES, the direction, the sign-in type, and the fix note.
   The runtime SWITCHES are never hidden: they are the controls somebody came here to
   flip, and burying an action behind a disclosure is how a screen becomes a dead end.

   It opens ITSELF whenever there is something to act on — a service that is not
   reachable, a required credential missing, or a switch an admin has moved off the
   hosting default — so nothing that needs a human is one click away from being seen. */
function Card({ it, onTest, testing, onToggle, onReset, switchBusy, forceOpen }) {
  const s = stateOf(it.state);
  const missingRequired = (it.env || []).filter((e) => e.required && !e.set);
  const runtimeSwitches = it.switches || [];
  const displaySwitches = it.displaySwitches || [];
  const overridden = runtimeSwitches.filter((x) => x.overridden).length;
  const envSet = (it.env || []).filter((e) => e.set).length;
  const needsEye = !!s.problem || missingRequired.length > 0 || overridden > 0;

  const [openState, setOpenState] = useState(null); // null = follow the default
  const open = openState == null ? (needsEye || !!forceOpen) : openState;
  const downFor = since(it.downSince);

  return (
    <div className={`ah-card ${s.tone}`}>
      <div className="ah-card-h">
        <Light state={it.state} />
        <span className="ah-name">{it.name}</span>
        <span className="ah-spacer" />
        {!it.notBuilt && (
          <button className="btn soft small" disabled={testing} onClick={() => onTest(it.key)}
            title={it.liveProbe ? 'Run a live connection check now' : 'Re-check configuration now'}>
            {testing ? 'Testing…' : (it.liveProbe ? 'Test now' : 'Re-check')}
          </button>
        )}
      </div>

      {/* How long it has been down, from the monitor's own record — the fact that
          separates a blip from an outage nobody has noticed for three days. */}
      {downFor && <div className="ah-meta"><span className="ah-tag ah-t-bad">down for {downFor}</span></div>}

      <div className="ah-purpose">{it.purpose}</div>
      {it.detail && <div className="ah-detail">{it.detail}</div>}

      {/* Only render the strip when it has something in it — an empty flex row still
          carries its margin, which reads as a stray gap on a card with no keys, no
          switches and no model (Elementix, the reserved slots). */}
      {(it.model || (it.env || []).length > 0 || runtimeSwitches.length > 0) && (
        <div className="ah-meta">
          {it.model && (
            <span className="ah-tag ah-t-info"
              title="The exact model PILOT is running right now (the Azure deployment name), set by AZURE_OPENAI_DEPLOYMENT in the hosting settings (Render).">
              model: {it.model}
            </span>
          )}
          {(it.env || []).length > 0 && (
            <span className="ah-fact"><b>{envSet}</b> of {it.env.length} key{it.env.length === 1 ? '' : 's'} set</span>
          )}
          {(it.env || []).length > 0 && runtimeSwitches.length > 0 && <span className="ah-dotsep" aria-hidden="true">·</span>}
          {runtimeSwitches.length > 0 && (
            <span className="ah-fact"><b>{runtimeSwitches.filter((x) => x.on).length}</b> of {runtimeSwitches.length} switch{runtimeSwitches.length === 1 ? '' : 'es'} on</span>
          )}
        </div>
      )}

      {/* The controls always stay in the open. */}
      {runtimeSwitches.length > 0 && (
        <div className="ah-body">
          <div className="ah-eyebrow">Switches</div>
          {runtimeSwitches.map((sw) => (
            <SwitchRow key={sw.name} s={sw} busy={switchBusy === sw.name} onToggle={onToggle} onReset={onReset} />
          ))}
        </div>
      )}

      {it.key === 'elementix' && <ElementixActions />}

      {((it.env || []).length > 0 || displaySwitches.length > 0 || it.direction || it.auth) && (
        <button className={`ah-more${open ? ' ah-open' : ''}`} aria-expanded={open}
          onClick={() => setOpenState(!open)}>
          <Icon name="chevron" />{open ? 'Hide details' : 'Details'}
        </button>
      )}

      {open && (
        <div className="ah-body">
          {(it.env || []).length > 0 && (
            <>
              <div className="ah-eyebrow">Credentials (names only — never a value)</div>
              <div className="ah-env">{it.env.map((e) => <EnvChip key={e.name} e={e} />)}</div>
            </>
          )}

          {displaySwitches.length > 0 && (
            <div className="ah-env" style={{ marginTop: 10 }}>
              {displaySwitches.map((sw) => (
                <span key={sw.name} className={`ah-envchip ${sw.on ? 'ah-t-info' : 'ah-t-mute'}`}
                  title="Set in the hosting settings (Render), not here.">
                  {sw.label}: <b>{sw.on ? 'on' : 'off'}</b>
                </span>
              ))}
            </div>
          )}

          {missingRequired.length > 0 && !it.notBuilt && (
            <div className="ah-note ah-t-warn">
              To turn this on, set{' '}
              {missingRequired.map((e) => <code key={e.name}>{e.name}</code>).reduce((a, b) => [a, ', ', b])}
              {' '}in the hosting settings (Render → Environment), then it goes live on the next deploy.
            </div>
          )}

          {(it.direction || it.auth) && (
            <div className="ah-meta" style={{ marginTop: 10 }}>
              {it.direction && it.direction !== '—' && <span className="ah-fact">Direction: <b>{it.direction}</b></span>}
              {it.direction && it.direction !== '—' && it.auth && it.auth !== '—' && <span className="ah-dotsep" aria-hidden="true">·</span>}
              {it.auth && it.auth !== '—' && <span className="ah-fact">Sign-in: <b>{it.auth}</b></span>}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/* Sitewire field explorer (super_admin). An OPTIONAL, behind-the-scenes helper: it READS
   the Sitewire TEST system (never writes, never the live account) and lists every field
   it exposes — the ones PILOT already controls vs the ones we could add next — so new
   Sitewire features are built on confirmed field names instead of guesses. It is NOT
   required for construction draws to work. Needs the SITEWIRE_TEST_* keys in Render;
   values are redacted (names/types only).

   IMPORTANT (plain English, never a raw code): when the test login isn't set up, the
   backend replies with a non-OK status, which the api helper turns into a thrown error
   whose text is the bare code `test_creds_missing`. So we read the STRUCTURED body off
   the error (e.data) and always show a friendly note — the raw code must never reach
   the owner. */
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
    <div className="dd-card" style={{ marginTop: 14 }}>
      <div className="dd-card-h">
        <span className="dd-card-ic"><Icon name="compass" /></span>
        <div>
          <h3>Sitewire field explorer</h3>
          <div className="dd-sub" style={{ marginTop: 1 }}>Optional helper — super admin only.</div>
        </div>
      </div>
      <p className="ah-purpose" style={{ maxWidth: 760 }}>
        A behind-the-scenes helper for building new Sitewire features. It peeks at Sitewire’s own <b>test</b> system and
        lists the field names their system uses, so anything we add later uses the exact right names instead of a guess.
        You don’t need this for construction draws to work. It only ever <b>reads</b> — it never changes anything, never
        touches your real Sitewire account, and never shows a borrower’s information. It uses a separate test login kept
        in the hosting settings (<code>SITEWIRE_TEST_…</code>), never your live key.
      </p>
      <div className="act-bar">
        <button className="btn primary" disabled={running} onClick={run}>{running ? 'Reading Sitewire…' : 'Discover Sitewire fields'}</button>
      </div>

      {problem && problem.notSetUp && (
        <div className="ah-note ah-t-warn">
          This helper isn’t set up yet — and that’s fine, it’s optional. Construction draws still work normally without it.
          To turn it on, a developer adds a separate Sitewire <b>test</b> login in the hosting settings (Render → Environment)
          as <code>SITEWIRE_TEST_ACCESS_TOKEN</code>, <code>SITEWIRE_TEST_CLIENT</code>, and <code>SITEWIRE_TEST_UID</code>
          {' '}(plus <code>SITEWIRE_TEST_BASE_URL</code> if the test site uses a different address). It never uses your live
          Sitewire key. Never paste a key here.
        </div>
      )}
      {problem && !problem.notSetUp && <div className="ah-note ah-t-warn">{problem.message}</div>}

      {rep && rep.catalog && (
        <div style={{ marginTop: 14 }}>
          <div className="ah-meta">
            <span className="ah-tag ah-t-bad">{newCount} new fields we could add</span>
            {rep.counts && Object.entries(rep.counts).map(([k, v]) => (
              <span key={k} className="ah-fact"><b>{v}</b> {k.replace(/_/g, ' ')}</span>
            ))}
          </div>
          {rep.errors && rep.errors.length > 0 && (
            <p className="ah-sw-s" style={{ marginTop: 8 }}>Some endpoints did not return (test data may be sparse): {rep.errors.join(' · ')}</p>
          )}
          {types.map((t) => (
            <div key={t} style={{ border: '1px solid var(--border)', borderRadius: 10, padding: '10px 12px', marginTop: 10 }}>
              <div className="ah-envchip ah-t-mute" style={{ marginBottom: 7 }}>{t}</div>
              <div className="ah-fields">
                {rep.catalog[t].map((f) => (
                  <span key={f.name} className={`ah-fieldchip ${f.integrated ? 'ah-t-live' : 'ah-t-bad'}`}
                    title={`${f.type}${f.enum_values ? ' — ' + f.enum_values.join(', ') : ''}`}>
                    {f.integrated ? '✓' : '＋'} {f.name}{f.enum_values ? ` (${f.enum_values.slice(0, 4).join('/')})` : ''}
                  </span>
                ))}
              </div>
            </div>
          ))}
          <p className="ah-sw-s" style={{ marginTop: 8 }}>Green = PILOT already controls it · Red ＋ = available to add. Only field names/types shown (no borrower data).</p>
        </div>
      )}
    </div>
  );
}

// The typed-confirmation modal for a switch that changes live behavior. On `.cv-modal`,
// so it inherits the solid card surface and the phone bottom-sheet behaviour every other
// modal in the portal has, and can never render transparent.
function ConfirmModal({ pending, text, setText, busy, onCancel, onConfirm }) {
  const phrase = pending.next ? 'TURN ON' : 'TURN OFF';
  const ok = text.trim().toUpperCase() === phrase;
  return (
    <div className="cv-modal-back" role="presentation"
      onMouseDown={(e) => { if (e.target === e.currentTarget) onCancel(); }}>
      <div className="cv-modal ah-confirm" role="dialog" aria-modal="true" aria-labelledby="ah-confirm-t">
        <h3 id="ah-confirm-t" style={{ margin: '0 0 8px' }}>Confirm this change</h3>
        <p style={{ fontSize: 13.5, margin: '0 0 8px', color: 'var(--text)' }}>
          You’re about to <b>{pending.next ? 'turn ON' : 'turn OFF'}</b> “{pending.sw.label}”. This changes what the
          platform actually sends to the outside world, so it takes effect right away.
        </p>
        <p style={{ fontSize: 13, margin: '0 0 6px', color: 'var(--text-muted)' }}>
          Type <code style={{ fontFamily: 'ui-monospace,Menlo,monospace', background: 'var(--surface-soft)', padding: '1px 6px', borderRadius: 5 }}>{phrase}</code> to confirm.
        </p>
        <input autoFocus value={text} onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && ok && !busy) onConfirm(); }}
          placeholder={phrase} className="input" style={{ fontSize: 16 }} />
        <div className="act-bar" style={{ justifyContent: 'flex-end' }}>
          <button className="btn ghost" disabled={busy} onClick={onCancel}>Cancel</button>
          <button className="btn primary" disabled={!ok || busy} onClick={onConfirm}
            style={pending.next ? undefined : { background: 'var(--danger)' }}>
            {busy ? 'Working…' : (pending.next ? 'Turn on' : 'Turn off')}
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * THE GOOGLE-COORDINATE LICENSING RULE, ON A SCREEN.
 *
 * The rule that keeps a Google-sourced coordinate out of the permanent property
 * warehouse is enforced by the database itself — but if that rule ever fails to install,
 * the app runs on happily with it switched off. The guard exists to say so, and until it
 * appeared here it said so only in the boot log and in the raw JSON of a public endpoint.
 * This is the page somebody actually opens to ask "is that still on?", which is the same
 * argument the credential chips make. Loads its own data.
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
  /* A QUALIFIED YES IS NOT A YES. The server attaches a `why` to an `ok:true` answer in
     exactly one situation: the write probe could not run, so the verdict fell back to
     reading the constraint's TEXT — and a `lower()` shadowed from an earlier schema
     deparses byte-identically to db/459's while refusing nothing. Reading `ok` alone
     painted that green with the canned "the database itself refuses…" line underneath,
     which is the confident sentence this whole control exists to stop being printed when
     it is not true. No new field is needed: the guard never attaches a `why` to an
     unqualified pass. */
  const qualified = st.ok === true && !!st.why;
  const good = st.ok === true && !qualified;
  // Unconfirmed is its OWN state — amber, never green and never the red of a rule we
  // have proven is missing. A qualified yes lands here too.
  const tone = good ? 'ah-t-live' : (st.checked && !qualified ? 'ah-t-bad' : 'ah-t-warn');
  const verdict = good ? 'On'
    : qualified ? 'Not fully confirmed'
      : (st.checked ? 'NOT installed' : 'Not confirmed');

  return (
    <div className="dd-card" style={{ marginTop: 14 }}>
      <div className="dd-card-h" style={{ justifyContent: 'space-between' }}>
        <div className="row" style={{ gap: 10, alignItems: 'center' }}>
          <span className="dd-card-ic"><Icon name="shield" /></span>
          <div>
            <h3>Property warehouse — Google coordinate rule</h3>
            <div className="dd-sub" style={{ marginTop: 1 }}>A licensing guard the database enforces on itself.</div>
          </div>
        </div>
        <div className="row" style={{ gap: 8, alignItems: 'center' }}>
          <span className={`ah-pill ${tone}`}><span className="ah-dot" />{verdict}</span>
          <button className="btn soft small" onClick={load}>Re-check</button>
        </div>
      </div>
      <p className="ah-detail" style={{ maxWidth: 760 }}>
        {good
          ? 'The database itself refuses to store a Google-sourced coordinate in the property warehouse. '
            + 'Google may suggest an address and draw a map; it may never place a property here.'
          : (st.why || 'The rule could not be confirmed.')}
      </p>
      {st.at && <p className="ah-sw-s">Last checked {String(st.at).replace('T', ' ').slice(0, 19)} UTC</p>}
    </div>
  );
}

/* Document-mirror scoreboard + backfill controls. Plain-English proof of "is every
   document in SharePoint?" — total documents vs how many are in SharePoint vs waiting vs
   stuck — plus a one-click "Copy everything now" (a full sweep) and "Retry stuck ones"
   (re-drive every document that was set aside after repeated failures). Wired to the
   existing, tested admin/sharepoint reconciliation + mirror + retry-exhausted endpoints.
   The api helper throws with the structured body on e.data, so a plain-English reason
   always shows and a raw code never reaches the owner.

   Kept high on the page on purpose: "is every document in SharePoint?" is the question
   this screen most needs to answer at a glance. */
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

  const waiting = recon ? Number(recon.pending || 0) : 0;
  const stuck = recon ? Number(recon.exhausted || 0) : 0;
  // The deliberately-not-copied pile. `skipped_not_mirrored` excludes a copy a person
  // moved in SharePoint (it carries a skip reason but IS in there); fall back to the
  // older `skipped` so a cached bundle still shows a number.
  const skipped = recon ? Number(recon.skipped_not_mirrored ?? recon.skipped ?? 0) : 0;
  const breakdown = (recon && Array.isArray(recon.skipped_breakdown)) ? recon.skipped_breakdown : null;
  const unaccounted = recon ? Number(recon.unaccounted || 0) : 0;
  const oldestHrs = recon ? recon.oldest_pending_hours : null;
  const allClear = recon && waiting === 0 && stuck === 0;
  // "Not copied on purpose" sits directly beside "In SharePoint" so the two numbers that
  // explain the total read together (owner-reported 2026-08-09: "2,655 total / 1,755 in
  // SharePoint … why are not all documents in SharePoint?"). The gap was never missing
  // documents — it was this pile, named once in grey small print. A third of the library
  // deserves its own tile.
  const tiles = recon ? [
    { label: 'Total documents', value: n(recon.total_docs), tone: null },
    { label: 'In SharePoint', value: n(recon.mirrored), tone: 'ah-t-live' },
    { label: 'Not copied on purpose', value: n(skipped), tone: null },
    { label: 'Waiting to copy', value: n(recon.pending), tone: waiting > 0 ? 'ah-t-warn' : null },
    { label: 'Stuck', value: n(recon.exhausted), tone: stuck > 0 ? 'ah-t-bad' : null },
  ] : [];

  return (
    <div className="dd-card">
      <div className="dd-card-h" style={{ justifyContent: 'space-between' }}>
        <div className="row" style={{ gap: 10, alignItems: 'center' }}>
          <span className="dd-card-ic"><Icon name="cloud" /></span>
          <div>
            <h3>Document mirror — SharePoint</h3>
            <div className="dd-sub" style={{ marginTop: 1 }}>Every document PILOT saves is copied into your team site.</div>
          </div>
        </div>
        <button className="btn soft small" disabled={busy != null} onClick={load}>{busy === 'refresh' ? 'Checking…' : 'Refresh'}</button>
      </div>

      <p className="ah-purpose" style={{ maxWidth: 780 }}>
        This is the live scoreboard — how many are already in SharePoint, how many are waiting, and how many are stuck.
        Use <b>Copy everything now</b> to force a full sweep, and <b>Retry stuck ones</b> to re-try any that were set
        aside after repeated failures. Anything still stuck also appears in your review queue and emails the team.
      </p>

      {notEnabled ? (
        <div className="ah-note ah-t-warn">
          The SharePoint mirror is switched off on this server. Turn it on with the “Document mirroring to SharePoint”
          switch on the SharePoint card below to start copying.
        </div>
      ) : loading ? (
        <p className="ah-sw-s">Loading the scoreboard…</p>
      ) : recon ? (
        <>
          <div className="ah-tiles" style={{ marginTop: 12 }}>
            {tiles.map((t) => (
              <div key={t.label} className={`ah-tile${t.tone ? ` ah-toned ${t.tone}` : ''}`}>
                <div className="ah-tile-v">{t.value}</div>
                <div className="ah-tile-k">{t.label}</div>
              </div>
            ))}
          </div>
          <div className="ah-detail" style={{ color: allClear ? '#1F6A4E' : 'var(--text)' }}>
            {allClear
              ? '✓ Everything saved is in SharePoint — nothing waiting, nothing stuck.'
              : `${waiting > 0 ? `${n(waiting)} waiting${oldestHrs != null ? ` (oldest ${oldestHrs}h)` : ''}. ` : ''}${stuck > 0 ? `${n(stuck)} stuck — use “Retry stuck ones” below.` : ''}`}
          </div>

          {/* The gap, spelled out. Every document with a copy saved is either in
              SharePoint, on this list, waiting, or stuck — so the two big numbers on the
              tiles above always add up, and you can see exactly why. */}
          {skipped > 0 && (
            <div className="ah-note ah-t-mute">
              <b>Why {n(skipped)} of them are not copied.</b> These are on purpose — nothing is lost, every one is still
              saved inside PILOT. {n(recon.mirrored)} in SharePoint + {n(skipped)} here = {n(recon.total_docs)} saved.
              {breakdown ? (
                <ul style={{ margin: '9px 0 0', padding: 0, listStyle: 'none' }}>
                  {breakdown.map((b) => (
                    <li key={b.key} style={{ display: 'flex', gap: 10, alignItems: 'baseline', padding: '4px 0', borderTop: '1px solid var(--border)' }}>
                      <span style={{ fontWeight: 700, minWidth: 54, textAlign: 'right', flexShrink: 0, fontVariantNumeric: 'tabular-nums' }}>{n(b.count)}</span>
                      <span style={{ color: b.key === 'other' ? '#8A6110' : 'var(--text-muted)' }}>{b.label}</span>
                    </li>
                  ))}
                </ul>
              ) : (
                <div style={{ marginTop: 6 }}>Refresh to see the full list.</div>
              )}
            </div>
          )}

          {unaccounted > 0 && (
            <div className="ah-note ah-t-warn">{n(unaccounted)} just saved and not sorted yet — check back in a minute.</div>
          )}
        </>
      ) : null}

      {!notEnabled && (
        <div className="act-bar">
          <button className="btn primary" disabled={busy != null} onClick={runSweep}>{busy === 'sweep' ? 'Starting…' : 'Copy everything now'}</button>
          <button className="btn soft" disabled={busy != null} onClick={retryStuck}>{busy === 'retry' ? 'Retrying…' : 'Retry stuck ones'}</button>
        </div>
      )}

      {msg && <div className="ah-note ah-t-info">{msg}</div>}
      {err && <div className="ah-note ah-t-bad">{err}</div>}
    </div>
  );
}

/* THE DOWN-ALERT MONITOR, as a control rather than a caption.
   It is the one switch that belongs to no single integration — it watches all of them — so
   it lives here instead of on a card, and it is driven through the SAME toggle/reset
   endpoints (and the same audit row) as every other switch on this page. Nothing is
   `dangerous` about it: it sends no borrower-facing mail and writes nothing outward except
   an email to our own admins, so it never asks for a typed confirmation. */
function MonitorBanner({ monitor, busy, onToggle, onReset }) {
  const sw = monitor.switch;
  const on = !!monitor.enabled;
  const swept = since(monitor.lastSweepAt);
  /* WHO gets the mail, in plain words. The page must be able to answer "why did the emails
     stop?" on its own — otherwise the quieting (owner-directed 2026-08-09) reads as the
     alerts being broken. Both numbers come from the server so the screen can never state a
     policy the monitor is not actually running. */
  const waitMin = Number(monitor.alertAfterMin);
  const roles = Array.isArray(monitor.emailRoles) ? monitor.emailRoles : [];
  const mailedTo = roles.length === 1 && roles[0] === 'super_admin' ? 'super admins' : 'the admins';
  return (
    <div className={`ah-note ${on ? 'ah-t-info' : 'ah-t-warn'} ah-monitor`}>
      <span className="ah-monitor-ic"><Icon name="bell" /></span>
      <div className="ah-monitor-t">
        <b>{on ? 'Automatic down-alerts are on.' : 'Automatic down-alerts are off.'}</b>{' '}
        {on
          ? <>Every service is checked every {monitor.intervalMin} minutes.{swept ? ` Last checked ${swept} ago.` : ' No check recorded yet.'}</>
          : <>Nothing checks these services between visits, so one can go down and nobody is told. Turning this on
            checks every service every {monitor.intervalMin} minutes.</>}
        {' '}
        {Number.isFinite(waitMin) && waitMin > 0
          ? <>Nothing is emailed until a service has been unreachable for <b>more than {waitMin} minutes</b>, so a
            short wobble is never an email — and when several go at once it is <b>one email</b>, not one per service.</>
          : <>An email goes out on a real change only — never on every check.</>}
        {' '}
        {/* Present-tense "only super admins are emailed" reads oddly on a banner that has
            just said the alerts are OFF, so the sentence is written to be true either way. */}
        <>When one does go out, only <b>{mailedTo}</b> are emailed — every admin still sees it
          here and in their notifications.</>
        {sw && sw.overridden && (
          <> <span className="ah-tag ah-t-warn">overridden</span> The hosting default is {sw.envDefault ? 'on' : 'off'}.</>
        )}
      </div>
      {/* No switch in the payload (an older server, or the read failed) → say what to set
          rather than render a control that cannot work. */}
      {sw ? (
        <div className="ah-monitor-act">
          <Toggle on={on} disabled={busy === sw.key} onClick={() => onToggle({ ...sw, name: sw.key, on })}
            label="Automatic down-alerts" />
          {sw.overridden && (
            <button className="btn ghost small" disabled={busy === sw.key}
              onClick={() => onReset({ ...sw, name: sw.key })}>Reset</button>
          )}
        </div>
      ) : (
        <code>INTEGRATIONS_MONITOR_ENABLED=1</code>
      )}
    </div>
  );
}

/* HOW MUCH ROOM IS LEFT ON EACH OUTSIDE SERVICE (owner-directed 2026-08-07, after ClickUp
   phoned about our request rate). "Held back" is the number to watch: while it stays at
   zero the cap is never in anybody's way, and a climbing count is the signal to raise a
   limit BEFORE a provider calls. Renders nothing until the budgets exist. */
function RateLimitPanel({ rows }) {
  if (!Array.isArray(rows) || rows.length === 0) return null;
  const held = rows.reduce((a, r) => a + (Number(r.waits) || 0), 0);
  return (
    <div className="dd-card" style={{ marginTop: 14 }}>
      <div className="dd-card-h" style={{ justifyContent: 'space-between' }}>
        <div className="row" style={{ gap: 10, alignItems: 'center' }}>
          <span className="dd-card-ic"><Icon name="gauge" /></span>
          <div>
            <h3>Request limits</h3>
            <div className="dd-sub" style={{ marginTop: 1 }}>How much room is left on each outside service.</div>
          </div>
        </div>
        <span className={`ah-pill ${held > 0 ? 'ah-t-warn' : 'ah-t-live'}`}>
          <span className="ah-dot" />{held > 0 ? `${n(held)} held back` : 'Never held back'}
        </span>
      </div>
      <p className="ah-purpose" style={{ maxWidth: 780 }}>
        PILOT paces itself so it never asks an outside service for more than they allow — counted across every part of
        PILOT at once, not per copy. “Held back” is how many times we had to wait our turn.
      </p>
      <div className="ah-scroll" style={{ marginTop: 10 }}>
        <table className="dd-table" style={{ minWidth: 460 }}>
          <thead>
            <tr>
              <th>Service</th>
              <th className="num">Allowed / min</th>
              <th className="num">Room left now</th>
              <th className="num">Held back</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.api}>
                <td style={{ fontWeight: 650 }}>{r.api}</td>
                <td className="num">{n(r.limitPerMin)}</td>
                <td className="num">{n(Math.floor(r.tokensAvailable))}</td>
                <td className="num" style={{ color: r.waits > 0 ? '#8A6110' : 'var(--text-muted)', fontWeight: r.waits > 0 ? 700 : 400 }}>{n(r.waits)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

export default function StaffApiHealth() {
  const { role } = useAuth();
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);       // first paint only
  const [refreshing, setRefreshing] = useState(false); // a re-check that must NOT blank the page
  const [err, setErr] = useState('');
  const [testing, setTesting] = useState(null);       // key currently being re-tested
  const [switchBusy, setSwitchBusy] = useState(null); // switch key currently being flipped
  const [pending, setPending] = useState(null);       // { sw, next } awaiting typed confirm
  const [confirmText, setConfirmText] = useState('');
  const [q, setQ] = useState('');
  const [filter, setFilter] = useState('all');
  // A bare re-render trigger for the "checked Xs ago" clock — the value is never read,
  // the re-render is the whole point (`since()` is recomputed on every render).
  const [, tickClock] = useState(0);
  const searchRef = useRef(null);

  const load = useCallback(async () => {
    setErr('');
    try { const d = await api.integrationsHealth(); setData(d); }
    catch (e) { setErr(e.message || 'Could not load API health.'); }
    finally { setLoading(false); setRefreshing(false); }
  }, []);

  useEffect(() => { load(); }, [load]);

  // The freshness clock. A local interval only — it re-renders the "checked Xs ago"
  // label and NEVER re-probes: one /health call reaches out to ~28 outside services, so
  // polling it on a timer would put a standing load on every vendor we use.
  useEffect(() => {
    const t = setInterval(() => tickClock((x) => x + 1), 15000);
    return () => clearInterval(t);
  }, []);

  // "/" focuses the search, the way every list screen worth using behaves. Ignored while
  // the caret is in a field, so typing a slash into the search box still types a slash.
  useEffect(() => {
    const onKey = (e) => {
      if (e.key !== '/' || e.metaKey || e.ctrlKey || e.altKey) return;
      const t = e.target;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
      e.preventDefault();
      if (searchRef.current) searchRef.current.focus();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const testOne = async (key) => {
    setTesting(key); setErr('');
    try {
      const d = await api.integrationTest(key);
      setData((prev) => prev ? {
        ...prev,
        integrations: prev.integrations.map((i) => i.key === key
          // The test route re-probes ONE integration and knows nothing about the monitor's
          // stored history, so carry `downSince` across — but only while the fresh probe
          // still says it is unreachable, or a recovery would keep wearing "down for 3 days".
          ? { ...d.integration, downSince: d.integration.state === 'unreachable' ? i.downSince : null }
          : i),
      } : prev);
    } catch (e) { setErr(e.message || 'Could not test that integration.'); }
    finally { setTesting(null); }
  };

  // Merge a server-returned switch (from toggle/reset) back into whichever integration owns it —
  // or into the monitor block, for the one PLATFORM-level switch that belongs to no card.
  const mergeSwitch = (after) => {
    setData((prev) => {
      if (!prev) return prev;
      const next = {
        ...prev,
        integrations: prev.integrations.map((it) => ({
          ...it,
          switches: (it.switches || []).map((s) => s.name === after.key
            ? { ...s, on: after.on, overridden: after.overridden, envDefault: after.envDefault } : s),
        })),
      };
      if (prev.monitor && prev.monitor.switch && prev.monitor.switch.key === after.key) {
        next.monitor = { ...prev.monitor, enabled: after.on, switch: { ...prev.monitor.switch, ...after } };
      }
      return next;
    });
  };

  // After a switch actually changes, re-run that integration's live check so its status
  // light AND plain-English detail reflect the new state right away. Without this they
  // stay stale (still say "Switched off" / "…is off") until the next full refresh — which
  // reads as "I turned it on but it still says off". Find the owning card by which one
  // carries this switch (membership is stable).
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

  const integrations = useMemo(() => (data && data.integrations) || [], [data]);
  const counts = useMemo(() => integrations.reduce((a, i) => { a[i.state] = (a[i.state] || 0) + 1; return a; }, {}), [integrations]);
  const problems = useMemo(() => integrations.filter((i) => stateOf(i.state).problem), [integrations]);
  const monitor = (data && data.monitor) || null;

  // Search matches the things a person actually types: the vendor's name, what it is for,
  // its registry key, and a credential NAME (searching "AZURE_OPENAI_KEY" should find its
  // card). Never a value — there are none on this page.
  const matches = useCallback((i) => {
    const term = q.trim().toLowerCase();
    if (!term) return true;
    const hay = [i.name, i.purpose, i.key, i.detail, i.model,
      ...(i.env || []).map((e) => e.name), ...(i.switches || []).map((s) => s.label)]
      .filter(Boolean).join(' ').toLowerCase();
    return hay.includes(term);
  }, [q]);

  const activeTest = useMemo(() => filterFor(filter), [filter]);
  const shown = useMemo(() => integrations.filter((i) => activeTest(i) && matches(i)), [integrations, activeTest, matches]);
  const filtering = filter !== 'all' || q.trim() !== '';
  const stateFilter = filter.startsWith(STATE_FILTER) ? filter.slice(STATE_FILTER.length) : null;

  // The headline. `problems` is the only thing that makes this page urgent; everything
  // else is a state somebody chose on purpose, and saying otherwise would train people
  // to ignore the banner.
  const verdict = (() => {
    if (loading) return { tone: 'ah-t-mute', icon: 'plug', head: 'Checking every integration…', sub: 'Each service is asked directly; this takes a moment.' };
    if (err) return { tone: 'ah-t-bad', icon: 'alert', head: 'Could not read the status', sub: err };
    if (problems.length) {
      return {
        tone: 'ah-t-bad', icon: 'alert',
        head: `${problems.length} service${problems.length === 1 ? '' : 's'} not reachable`,
        sub: problems.map((p) => p.name).join(' · '),
      };
    }
    const liveN = counts.live || 0;
    return {
      tone: 'ah-t-live', icon: 'check',
      head: liveN > 0 ? `All ${liveN} connected service${liveN === 1 ? '' : 's'} healthy` : 'Nothing is reporting a fault',
      sub: 'Nothing configured is failing right now. Anything below that is switched off or awaiting keys is deliberate.',
    };
  })();

  // The mix bar + its legend, worst state first.
  const mix = STATE_ORDER.filter((k) => counts[k]).map((k) => ({ key: k, n: counts[k], ...stateOf(k) }));
  const total = integrations.length || 1;
  const checkedAgo = data && data.checkedAt ? since(data.checkedAt) : null;

  return (
    <div className="wrap">
      <div className="dd-wrap">
        {/* ── head ─────────────────────────────────────────────────────────── */}
        <div className="dd-head">
          <div>
            <h1 className="dd-title">API Health</h1>
            <div className="dd-sub" style={{ maxWidth: 660 }}>
              Every outside service PILOT connects to — whether it’s live, what it needs, a one-click test, and the
              on/off switches you can flip right here. Keys are set and rotated in the hosting settings (Render), never
              here, so a problem in the app can never leak a key.
            </div>
          </div>
          <div className="row" style={{ gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
            {checkedAgo && (
              <span className="dd-chip"><span className="dot" />
                <span className="ah-live-ago">Checked {checkedAgo === 'just now' ? 'just now' : `${checkedAgo} ago`}</span>
              </span>
            )}
            <button className="btn primary" disabled={loading || refreshing}
              onClick={() => { setRefreshing(true); load(); }}>
              {refreshing ? 'Checking…' : 'Re-check all'}
            </button>
          </div>
        </div>

        {/* ── the verdict, and the whole estate on one bar ──────────────────── */}
        <div className="ah-hero">
          <div className={`ah-verdict ${verdict.tone}`}>
            <span className="ah-verdict-ic"><Icon name={verdict.icon} /></span>
            <div style={{ minWidth: 0 }}>
              <h2 className="ah-verdict-h" role="status">{verdict.head}</h2>
              <div className="ah-verdict-sub">{verdict.sub}</div>
            </div>
          </div>
          <div>
            <div className="ah-mixtop">
              <span className="dd-hero-label">Every integration</span>
              <span className="dd-hero-pct">{integrations.length}</span>
            </div>
            <div className="ah-mix" aria-hidden="true">
              {mix.map((m) => <i key={m.key} style={{ width: `${(m.n / total) * 100}%`, background: m.bar }} title={`${m.n} ${m.label}`} />)}
            </div>
            {/* The count you just read IS the filter — one click narrows the list to it,
                a second click puts everything back. */}
            <div className="ah-legend">
              {mix.map((m) => {
                const target = STATE_FILTER + m.key;
                const sel = filter === target;
                return (
                  <button key={m.key} type="button"
                    className={`ah-leg ${m.tone}${sel ? ' ah-sel' : ''}`}
                    onClick={() => setFilter(sel ? 'all' : target)}
                    title={sel ? 'Show everything again' : `Show only: ${m.label}`}>
                    <span className="ah-leg-sw" style={{ background: m.bar }} />
                    <span className="ah-leg-n">{m.n}</span>
                    <span className="ah-leg-k">{m.label}</span>
                  </button>
                );
              })}
            </div>
          </div>
        </div>

        {/* IS ANYTHING WATCHING BETWEEN VISITS? A page full of green lights means something
            quite different when the only thing checking is whoever opened it, so the answer
            is stated — and it is a real control, not an instruction to go elsewhere. The
            monitor's timer is always armed and re-reads this switch every tick, so flipping
            it here takes effect without a redeploy. */}
        {monitor && <MonitorBanner monitor={monitor} busy={switchBusy} onToggle={onToggle} onReset={onReset} />}

        {err && !loading && <div className="ah-note ah-t-bad" style={{ marginTop: 0 }}>{err}</div>}

        {/* The question this page most needs to answer at a glance. */}
        <MirrorBackfillPanel />

        {/* ── the integration list ──────────────────────────────────────────── */}
        <div className="ah-tools" role="search">
          <div className="ah-search">
            <span className="ah-search-ic"><Icon name="search" /></span>
            <input ref={searchRef} className="ah-search-in" value={q} onChange={(e) => setQ(e.target.value)}
              placeholder="Search a service, what it does, or a key name  ( / )" aria-label="Search integrations" />
            {q && <button className="ah-search-x" onClick={() => setQ('')} aria-label="Clear search">×</button>}
          </div>
          <div className="ah-chips">
            {/* A state picked from the hero legend has no chip of its own, so it gets one
                here — otherwise the list is narrowed and nothing on screen says why. */}
            {stateFilter && (
              <button type="button" className="ah-chip ah-sel" onClick={() => setFilter('all')}
                title="Clear this filter">
                {stateOf(stateFilter).label}
                <span className="ah-chip-n">{integrations.filter((i) => i.state === stateFilter).length}</span>
                <span className="ah-chip-n" aria-hidden="true">×</span>
              </button>
            )}
            {FILTERS.map((f) => {
              const c = f.key === 'all' ? integrations.length : integrations.filter(f.test).length;
              if (c === 0 && f.key !== 'all') return null;
              return (
                <button key={f.key} type="button" className={`ah-chip${filter === f.key ? ' ah-sel' : ''}`}
                  onClick={() => setFilter(f.key)}>
                  {f.label}<span className="ah-chip-n">{c}</span>
                </button>
              );
            })}
          </div>
        </div>

        {loading && <div className="ah-empty">Checking every integration…</div>}

        {!loading && shown.length === 0 && (
          <div className="ah-empty">
            Nothing matches {q.trim() ? <>“{q.trim()}”</> : 'that filter'}.{' '}
            <button className="btn link" onClick={() => { setQ(''); setFilter('all'); }}>Show everything</button>
          </div>
        )}

        {GROUP_ORDER.map((g) => {
          // Problems first inside every group, then by the state's own rank, then by
          // name — so a red card is never below a green one on the same screen.
          const items = shown.filter((i) => i.group === g)
            .slice()
            .sort((a, b) => (stateOf(a.state).rank - stateOf(b.state).rank) || a.name.localeCompare(b.name));
          if (!items.length) return null;
          const meta = GROUP[g] || { title: g, blurb: '' };
          const bad = items.filter((i) => stateOf(i.state).problem).length;
          return (
            <section key={g} className="ah-sec">
              <div className="ah-sec-h">
                <h3>{meta.title}</h3>
                <span className="ah-sec-n">{items.length}</span>
                {bad > 0 && <span className="ah-tag ah-t-bad">{bad} not reachable</span>}
              </div>
              <p className="ah-sec-sub">{meta.blurb}</p>
              <div className="ah-grid">
                {items.map((it) => (
                  <Card key={it.key} it={it} onTest={testOne} testing={testing === it.key}
                    onToggle={onToggle} onReset={onReset} switchBusy={switchBusy}
                    /* A search or a filter is somebody looking for something specific —
                       show them the whole card rather than make them click again. */
                    forceOpen={filtering} />
                ))}
              </div>
            </section>
          );
        })}

        {/* ── the rest of the platform's own checks ───────────────────────────
            Held back until the first probe lands, so the heading never sits alone
            over three panels that are all still loading. */}
        {!loading && (
          <section className="ah-sec">
            <div className="ah-sec-h"><h3>Platform checks</h3></div>
            <p className="ah-sec-sub">Limits, guards and helpers that sit around the integrations above.</p>
            <RateLimitPanel rows={data && data.rateLimits} />
            <LicensingControlPanel />
            {role === 'super_admin' && <SitewireExplorer />}
          </section>
        )}
      </div>

      {pending && (
        <ConfirmModal pending={pending} text={confirmText} setText={setConfirmText} busy={switchBusy === pending.sw.name}
          onCancel={() => { setPending(null); setConfirmText(''); }} onConfirm={confirmToggle} />
      )}
    </div>
  );
}
