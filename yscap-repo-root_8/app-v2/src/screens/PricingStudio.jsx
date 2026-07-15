import React, { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../lib/api.js';
import TermSheetStudio, { buildStudioState } from '../components/TermSheetStudio.jsx';
import { scenarioToDraft, scenarioLabelFromState } from '../lib/scenario.js';

/* #103 — Borrower self-service pricing. The borrower prices loans in the SAME
   frozen Term Sheet Studio the staff use (embedded as an iframe — the engine and
   guidelines are never touched). This screen only wraps it with a SAVE / RESTORE
   layer: save the current inputs as a named scenario and reopen any saved
   scenario later without retyping. The studio is prefilled from the borrower's
   own experience of record (editable). Internal margin is never shown
   (showAdmin=false). */
export default function PricingStudio() {
  const nav = useNavigate();
  const studioRef = useRef(null);
  const [prefill, setPrefill] = useState(null);
  const [ready, setReady] = useState(false);
  const [scenarios, setScenarios] = useState([]);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState('');

  const loadScenarios = () => api.pricingScenarios().then((r) => setScenarios(Array.isArray(r) ? r : [])).catch(() => {});
  useEffect(() => {
    api.pricingPrefill().then((p) => {
      const exp = (p && p.exp) || {};
      setPrefill(buildStudioState({ expFlips: exp.flips || 0, expHolds: exp.holds || 0, expGround: exp.ground || 0, fico: p && p.fico }));
    }).catch(() => setPrefill(buildStudioState({}))).finally(() => setReady(true));
    loadScenarios();
  }, []);

  const flash = (m) => { setNote(m); clearTimeout(flash._t); flash._t = setTimeout(() => setNote(''), 3200); };

  async function save() {
    const state = studioRef.current && studioRef.current.readState();
    if (!state) { flash('Give the studio a moment to finish loading, then try again.'); return; }
    // Owner rule: name the scenario from the property address by default (the
    // borrower can rename it); fall back to the deal type when no address yet.
    const label = window.prompt('Name this scenario', scenarioLabelFromState(state));
    if (label == null) return;   // cancelled
    setBusy(true);
    try { await api.savePricingScenario(label, state); await loadScenarios(); flash('Scenario saved.'); }
    catch (e) { flash(e.message || 'Could not save the scenario'); }
    finally { setBusy(false); }
  }
  function openScenario(s) {
    if (studioRef.current && studioRef.current.applyState(s.inputs)) flash(`Reopened "${s.label}" — reprice it and save again.`);
    else flash('Give the studio a moment to finish loading, then try again.');
  }
  async function removeScenario(s) {
    if (!window.confirm(`Delete the saved scenario "${s.label}"?`)) return;
    try { await api.deletePricingScenario(s.id); await loadScenarios(); }
    catch (e) { flash(e.message || 'Could not delete the scenario'); }
  }
  // #119: turn a priced scenario into a real application draft — pre-filled with
  // everything already entered (deal, property, economics, experience, FICO). The
  // borrower lands in the application with only the missing details left to add.
  async function startLoan(state, label) {
    if (!state) { flash('Give the studio a moment to finish loading, then try again.'); return; }
    setBusy(true);
    try {
      const data = scenarioToDraft(state);
      const d = await api.createDraft({ label: label || scenarioLabelFromState(state) || 'New application', data, step: 1 });
      nav(`/apply/${d.id}`);
    } catch (e) { flash(e.message || 'Could not start the loan'); setBusy(false); }
  }
  const startFromCurrent = () => startLoan(studioRef.current && studioRef.current.readState());

  return (
    <div className="toolsheet" role="dialog" aria-modal="true" aria-label="Price a loan">
      <header className="toolsheet-head">
        <button className="toolsheet-back" aria-label="Back to your dashboard" onClick={() => nav('/dashboard')}>←</button>
        <div className="toolsheet-titles">
          <strong>Price a loan</strong>
          <span className="muted small">Build a term sheet from your own numbers — save a scenario and come back to it anytime.</span>
        </div>
        <button className="btn ghost toolsheet-done" disabled={busy || !ready} onClick={save} title="Save these numbers as a scenario to return to later">{busy ? 'Saving…' : 'Save scenario'}</button>
        <button className="btn primary toolsheet-done" disabled={busy || !ready} onClick={startFromCurrent} title="Start a loan application pre-filled with everything you just entered">Start this loan →</button>
      </header>
      {note && <div className="toolsheet-sub"><span className="small" style={{ color: 'var(--ok)' }}>{note}</span></div>}
      {scenarios.length > 0 && (
        <div className="toolsheet-sub" style={{ gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
          <span className="muted small">Saved scenarios — reprice, start a loan, or remove:</span>
          {scenarios.map((s) => (
            <span key={s.id} className="reqchip" style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
              <button type="button" className="btn link small" style={{ padding: 0, fontWeight: 600 }} title="Reopen this scenario in the studio to reprice it" onClick={() => openScenario(s)}>{s.label}</button>
              <button type="button" className="btn link small" style={{ padding: 0 }} title="Start a loan from this scenario — pre-filled with its numbers" onClick={() => startLoan(s.inputs, s.label)}>Start loan →</button>
              <button type="button" className="btn link small" style={{ padding: 0, color: 'var(--danger)' }} title="Delete this scenario" onClick={() => removeScenario(s)} aria-label={`Delete ${s.label}`}>✕</button>
            </span>
          ))}
        </div>
      )}
      <div className="toolsheet-body scroll">
        <div className="toolsheet-inner">
          {ready && <TermSheetStudio ref={studioRef} prefill={prefill} showAdmin={false} />}
        </div>
      </div>
    </div>
  );
}
