import React, { useCallback, useEffect, useState } from 'react';
import { askConfirm } from '../lib/dialog.js';
import { api } from '../lib/api.js';

/* THE TRINITY BUDGET REVIEW (form 159) — the pre-closing read of the construction plan.
 *
 * Owner-directed 2026-08-21: *"Add a Trinity workflow during the file … a 159 Budget Review …
 * should be available in the order section. You should mark over there that it's only intended
 * for real heavy rehabs and for ground-ups. On ground-ups where we post the condition for
 * feasibility review, that condition should get a button where, from that button, we can order
 * this report directly."*
 *
 * ONE COMPONENT, TWO PLACES. The Orders room mounts it full (`compact={false}`) and the
 * feasibility CONDITION mounts it compact — never a second copy of the card, because two copies
 * of "may this file order one, and what is still missing?" drift, and the one that drifts is the
 * one somebody presses. Everything it says comes from the server's own gate
 * (`GET /api/trinity/files/:appId/budget-review`); nothing here re-derives whether a file is
 * ready, which deal kinds may order one, or what the blockers are.
 *
 * IT IS NOT A DRAW. This orders a review of the PLAN before the loan closes — no money is
 * requested, nothing is released, and it never touches the Draw Center.
 *
 * Every colour is an explicit dark on the white PILOT canvas: `var(--ink*)` is a LIGHT paper
 * token in this palette and renders white-on-white (the standing hard rule).
 */

const INK = '#141B22';
const MUTED = '#4B585C';

export default function TrinityBudgetReview({ appId, compact = false, onChanged }) {
  const [state, setState] = useState(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  const [err, setErr] = useState('');

  const load = useCallback(() => (
    api.get(`/api/trinity/files/${appId}/budget-review`).then(setState).catch(() => setState(null))
  ), [appId]);
  useEffect(() => { load(); }, [load]);

  // A read that failed says nothing rather than claiming the file cannot order one — an
  // unreadable gate is not a "no".
  if (!state) return null;

  const review = state.review || null;
  const live = review && review.status !== 'cancelled' ? review : null;
  const blockers = Array.isArray(state.blockers) ? state.blockers : [];
  const suitability = state.suitability || {};
  const box = {
    marginTop: compact ? 6 : 0,
    padding: '10px 12px',
    border: '1px solid var(--gold)',
    borderRadius: 8,
    background: 'rgba(174,135,70,0.06)',
  };

  async function order() {
    const okToGo = await askConfirm(
      'This orders the construction budget review from Trinity for this file.\n\n'
      + 'They read the whole scope of work, the contractor’s details and the appraisal, and we are billed for the report.\n\n'
      + 'Order it now?');
    if (!okToGo) return;
    setBusy(true); setErr(''); setMsg('');
    try {
      const out = await api.post(`/api/trinity/files/${appId}/budget-review`, {});
      setMsg(out && out.dryrun
        ? 'Test mode is on — PILOT built the order and sent nothing.'
        : 'Ordered. Trinity has the scope, the contractor’s details and the appraisal.');
      await load();
      onChanged && onChanged();
    } catch (e) {
      // The server answers 422 with the blockers it re-checked at the moment of sending — a
      // scope can change between opening this screen and pressing the button.
      const d = (e && e.data) || {};
      setErr((Array.isArray(d.blockers) && d.blockers.join(' ')) || d.message || d.error || e.message
        || 'Could not order the budget review.');
      await load();
    } finally { setBusy(false); }
  }

  async function cancel() {
    if (!(await askConfirm('Stand this budget review down? You can order another one afterwards.'))) return;
    setBusy(true); setErr(''); setMsg('');
    try {
      await api.post(`/api/trinity/files/${appId}/budget-review/${review.id}/cancel`, {});
      setMsg('Stood down.');
      await load();
      onChanged && onChanged();
    } catch (e) {
      setErr((e.data && (e.data.error || e.data.message)) || e.message || 'Could not stand it down.');
    } finally { setBusy(false); }
  }

  const notes = (
    <>
      {msg && <div className="notice" style={{ marginTop: 6 }}>{msg}</div>}
      {err && <div className="notice err" style={{ marginTop: 6 }}>{err}</div>}
    </>
  );

  // ALREADY ORDERED — what Trinity has, and the way to stand it down.
  if (live && live.trinity_order_id) {
    return (
      <div className="small" style={box}>
        <div style={{ fontWeight: 600, color: INK }}>
          {live.status === 'report_received' ? 'Trinity’s budget review is back' : 'Budget review ordered from Trinity'}
        </div>
        <div style={{ color: MUTED, marginTop: 2 }}>
          Trinity order #{live.trinity_order_id}. They have the whole scope of work, the contractor’s
          details and the appraisal.
          {live.status !== 'report_received' && ' Their report will appear here when it comes back.'}
        </div>
        {live.status !== 'report_received' && (
          <button className="btn link small" style={{ marginTop: 4, color: '#256168', display: 'block' }}
            disabled={busy} onClick={cancel}>Stand this review down</button>
        )}
        {notes}
      </div>
    );
  }

  // REQUESTED BUT NOT SENT — the desk asked, Trinity does not have it yet.
  const requested = live && !live.trinity_order_id;

  return (
    <div className="small" style={box}>
      <div style={{ fontWeight: 600, color: INK }}>Construction budget review (Trinity, form 159)</div>
      <div style={{ color: MUTED, marginTop: 2 }}>
        An independent read of the construction plan before the loan closes — the plans, the permits,
        the contractor’s numbers and the schedule. It is <b>not</b> a draw: no money is requested and
        nothing is released.
      </div>
      {/* The owner's own words, on the screen, so nobody orders one on a light rehab because the
          button happened to be there. */}
      <div style={{ color: MUTED, marginTop: 4 }}>
        <b>Only for {state.intendedFor || 'ground-up construction, and heavy rehabs case by case.'}</b>
      </div>
      {suitability.note && (
        <div style={{ color: suitability.allowed ? MUTED : INK, marginTop: 4 }}>{suitability.note}</div>
      )}

      {suitability.allowed && (
        <>
          {requested && (
            <div style={{ color: MUTED, marginTop: 6 }}>
              Asked for, but not sent to Trinity yet — press the button to send it.
            </div>
          )}
          <button className="btn ghost small" style={{ marginTop: 8 }}
            disabled={busy || blockers.length > 0} onClick={order}>
            {busy ? 'Ordering…' : requested ? 'Send this review to Trinity' : 'Order the budget review from Trinity'}
          </button>
          {blockers.length > 0 && (
            <div style={{ marginTop: 6 }}>
              <div style={{ color: INK, fontWeight: 600 }}>Before this can be ordered:</div>
              <ul style={{ margin: '4px 0 0 18px', padding: 0, color: MUTED }}>
                {blockers.map((b, i) => <li key={i}>{b}</li>)}
              </ul>
            </div>
          )}
          {live && live.blocked_reason && !blockers.length && (
            <div className="notice err" style={{ marginTop: 6 }}>{live.blocked_reason}</div>
          )}
        </>
      )}
      {notes}
    </div>
  );
}
