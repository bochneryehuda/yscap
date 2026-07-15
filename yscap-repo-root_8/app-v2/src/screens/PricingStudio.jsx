import React, { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../lib/api.js';
import TermSheetStudio, { buildStudioState } from '../components/TermSheetStudio.jsx';

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
    const label = window.prompt('Name this scenario (e.g. "125 Main St — Gold 80%")');
    if (label == null) return;   // cancelled
    setBusy(true);
    try { await api.savePricingScenario(label, state); await loadScenarios(); flash('Scenario saved.'); }
    catch (e) { flash(e.message || 'Could not save the scenario'); }
    finally { setBusy(false); }
  }
  function openScenario(s) {
    if (studioRef.current && studioRef.current.applyState(s.inputs)) flash(`Opened "${s.label}".`);
    else flash('Give the studio a moment to finish loading, then try again.');
  }
  async function removeScenario(s) {
    if (!window.confirm(`Delete the saved scenario "${s.label}"?`)) return;
    try { await api.deletePricingScenario(s.id); await loadScenarios(); }
    catch (e) { flash(e.message || 'Could not delete the scenario'); }
  }

  return (
    <div className="toolsheet" role="dialog" aria-modal="true" aria-label="Price a loan">
      <header className="toolsheet-head">
        <button className="toolsheet-back" aria-label="Back to your dashboard" onClick={() => nav('/dashboard')}>←</button>
        <div className="toolsheet-titles">
          <strong>Price a loan</strong>
          <span className="muted small">Build a term sheet from your own numbers — save a scenario and come back to it anytime.</span>
        </div>
        <button className="btn primary toolsheet-done" disabled={busy || !ready} onClick={save}>{busy ? 'Saving…' : 'Save scenario'}</button>
      </header>
      {note && <div className="toolsheet-sub"><span className="small" style={{ color: 'var(--ok)' }}>{note}</span></div>}
      {scenarios.length > 0 && (
        <div className="toolsheet-sub" style={{ gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
          <span className="muted small">Saved scenarios:</span>
          {scenarios.map((s) => (
            <span key={s.id} className="reqchip" style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
              <button type="button" className="btn link small" style={{ padding: 0 }} title="Open this scenario in the studio" onClick={() => openScenario(s)}>{s.label}</button>
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
