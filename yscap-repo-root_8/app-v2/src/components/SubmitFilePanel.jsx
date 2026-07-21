import React, { useCallback, useEffect, useState } from 'react';
import { api } from '../lib/api.js';

/* THE WORKFLOW — the "Submit file" panel on a loan file (owner-directed
   2026-07-21). One plain button per step, each with a one-line "what happens
   when you click this" so anyone understands it without training. Clicking a
   button hands the file to the right person's workflow AND moves the file's
   status automatically. When nobody is assigned yet, you pick the person.

   props: { appId, onChange } — onChange() lets the file view refresh its status. */

// The order the buttons appear in. draw_setup / post_closing only show on a
// funded file; exception + escalation live in a separate "Need help?" group.
const MAIN = ['loan_setup', 'processing', 'condition_clearing', 'clear_to_close', 'closing'];
const POST_FUNDING = ['draw_setup', 'post_closing'];
const HELP = ['exception', 'escalation'];

export default function SubmitFilePanel({ appId, onChange }) {
  const [opts, setOpts] = useState(null);
  const [err, setErr] = useState('');
  const [flash, setFlash] = useState('');
  const [openType, setOpenType] = useState(null);   // which type's form is expanded
  const [pick, setPick] = useState('');             // chosen recipient id
  const [estDate, setEstDate] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => api.workflowOptions(appId).then(setOpts).catch(e => setErr(e.message)), [appId]);
  useEffect(() => { load(); }, [load]);
  const say = (m) => { setFlash(m); setTimeout(() => setFlash(''), 6000); };

  if (err && !opts) return <div className="panel"><div className="panel-b"><div className="notice err">{err}</div></div></div>;
  if (!opts) return <div className="panel"><div className="panel-b muted">Loading…</div></div>;

  const T = opts.types || {};
  const liveByType = {};
  for (const it of (opts.live || [])) liveByType[it.submission_type] = it;

  // For a type, work out who it goes to + whether we need the person picker.
  function destination(type) {
    const cfg = T[type] || {};
    if (cfg.pointer === 'processor_id') return { assigned: opts.assigned.processor, candidates: opts.candidates.processor, role: 'processor' };
    if (cfg.pointer === 'closer_id') return { assigned: opts.assigned.closer, candidates: opts.candidates.closer, role: 'closer' };
    if (type === 'draw_setup') return { assigned: null, candidates: opts.candidates.draw_coordinator, role: 'draw coordinator' };
    if (type === 'escalation') return { assigned: null, candidates: opts.candidates.super_admin, role: 'super admin' };
    // post_closing + exception → pick anyone.
    return { assigned: null, candidates: opts.candidates.all, role: 'a teammate' };
  }

  // Why a button is blocked (plain language) — or null if it's ready.
  function blockedReason(type) {
    if (type === 'loan_setup' && !opts.completeness.complete)
      return `Finish the file first — still needs: ${opts.completeness.missing.join(', ')}.`;
    if (type === 'condition_clearing') {
      const pct = Math.round((opts.conditionsCleared.pct || 0) * 100);
      const need = Math.round((opts.conditionsThreshold || 0.8) * 100);
      if (opts.conditionsCleared.pct < opts.conditionsThreshold) return `${pct}% of conditions are cleared — you need at least ${need}%.`;
    }
    if (type === 'clear_to_close' && (opts.ctcHardBlockers || []).length)
      return `Resolve the underwriting dealbreaker${opts.ctcHardBlockers.length === 1 ? '' : 's'} first.`;
    if ((type === 'draw_setup' || type === 'post_closing') && !opts.funded)
      return 'Available once the loan is funded.';
    return null;
  }

  // A short helper describing WHERE it goes, shown under the helper text.
  function goesTo(type) {
    const d = destination(type);
    if (d.assigned) return `Goes to ${d.assigned.name} (already on this file).`;
    if (d.candidates && d.candidates.length === 1) return `Goes to ${d.candidates[0].name}.`;
    if (d.candidates && d.candidates.length > 1) return `You’ll pick who to send it to.`;
    return `No ${d.role} set up yet — add one on the Team screen.`;
  }

  async function submit(type) {
    const cfg = T[type] || {};
    const d = destination(type);
    // Decide whether we need the picker / date open first.
    const needsPick = !d.assigned && (!d.candidates || d.candidates.length !== 1);
    if ((needsPick || cfg.needsEstClosing) && openType !== type) {
      setOpenType(type); setPick(''); setEstDate(opts.expectedClosing || ''); setNote(''); return;
    }
    const body = { submissionType: type };
    if (needsPick) {
      if (!pick) { setErr('Pick who to send it to.'); return; }
      body.toStaffId = pick;
    }
    if (cfg.needsEstClosing) {
      if (!estDate) { setErr('Enter your estimated closing date.'); return; }
      body.estClosingDate = estDate;
    }
    if (note) body.note = note;
    setBusy(true); setErr('');
    try {
      await api.workflowSubmit(appId, body);
      say(`Submitted for ${cfg.label}. It’s on their workflow${cfg.internalStatus ? ' and the status has moved' : ''}.`);
      setOpenType(null); setPick(''); setEstDate(''); setNote('');
      await load();
      if (onChange) onChange();
    } catch (e) {
      // Map the server's plain reasons to friendly copy.
      const d2 = e.data || {};
      if (d2.error === 'incomplete') setErr(`Finish the file first — still needs: ${(d2.missing || []).join(', ')}.`);
      else if (d2.error === 'conditions_not_ready') setErr(`Only ${Math.round((d2.pct || 0) * 100)}% of conditions are cleared — you need at least ${Math.round((d2.threshold || 0.8) * 100)}%.`);
      else if (d2.error === 'not_funded') setErr('This step is available once the loan is funded.');
      else if (d2.error === 'blocked') setErr('Resolve the outstanding underwriting item(s) first.');
      else if (d2.error === 'pick_recipient') { setErr('Pick who to send it to.'); setOpenType(type); }
      else setErr(e.message || 'Could not submit.');
    } finally { setBusy(false); }
  }

  function Button({ type }) {
    const cfg = T[type] || {};
    const reason = blockedReason(type);
    const live = liveByType[type];
    const d = destination(type);
    const noTarget = !d.assigned && (!d.candidates || d.candidates.length === 0);
    return (
      <div className={`wf-submit-card${reason ? ' is-blocked' : ''}`}>
        <div className="wf-submit-main">
          <div className="wf-submit-title">{cfg.label}</div>
          <div className="wf-submit-help muted small">{cfg.helper}</div>
          <div className="wf-submit-goes muted small">{reason ? <span className="wf-blockmsg">{reason}</span> : goesTo(type)}</div>
          {live && <div className="muted small">Already in {live.to_name || 'someone'}’s workflow{live.status === 'in_progress' ? ' (in progress)' : ''}.</div>}
        </div>
        <div className="wf-submit-act">
          <button className="btn primary small" disabled={busy || !!reason || noTarget} onClick={() => submit(type)}>
            {openType === type ? 'Submit now' : 'Submit'}
          </button>
        </div>
        {openType === type && (
          <div className="wf-submit-form">
            {(!d.assigned && d.candidates && d.candidates.length !== 1) && (
              <label className="field" style={{ margin: 0 }}>
                <span className="small muted">Send to</span>
                <select className="input" value={pick} onChange={e => setPick(e.target.value)}>
                  <option value="">— pick a person —</option>
                  {(d.candidates || []).map(c => <option key={c.id} value={c.id}>{c.full_name}{c.role ? ` (${c.role})` : ''}</option>)}
                </select>
              </label>
            )}
            {cfg.needsEstClosing && (
              <label className="field" style={{ margin: 0 }}>
                <span className="small muted">Estimated closing date</span>
                <input className="input" type="date" value={estDate} onChange={e => setEstDate(e.target.value)} />
              </label>
            )}
            <label className="field" style={{ margin: 0 }}>
              <span className="small muted">Note (optional)</span>
              <input className="input" value={note} placeholder="Anything they should know" onChange={e => setNote(e.target.value)} />
            </label>
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="panel">
      <div className="panel-h"><h3 style={{ margin: 0 }}>Submit this file</h3>
        <span className="muted small">Send it to the next person. The status moves for you — no need to touch it.</span></div>
      <div className="panel-b">
        {flash && <div className="notice ok" style={{ marginBottom: 10 }}>{flash}</div>}
        {err && <div role="alert" className="notice err" style={{ marginBottom: 10 }}>{err}<button className="btn link small" onClick={() => setErr('')}>Dismiss</button></div>}

        <div className="wf-submit-grid">
          {MAIN.map(t => <Button key={t} type={t} />)}
          {opts.funded && POST_FUNDING.map(t => <Button key={t} type={t} />)}
        </div>

        <div className="wf-help-group">
          <div className="muted small" style={{ margin: '14px 0 8px' }}>Need help with this file?</div>
          <div className="wf-submit-grid">
            {HELP.map(t => <Button key={t} type={t} />)}
          </div>
        </div>
      </div>
    </div>
  );
}
