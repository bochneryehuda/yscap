import React, { useCallback, useEffect, useState } from 'react';
import { askConfirm, askPrompt } from '../lib/dialog.js';
import { api } from '../lib/api.js';
import { fmtDay } from '../lib/dates.js';

/* THE FILE'S CRITICAL DATES — and the payoff-demand workflow that lives beside them.
 *
 * Owner-directed 2026-08-21: *"We need to add in the file, inside a critical date section, which
 * should have: the application date, which is the day the file started · the CTC date · the funded
 * date · the purchase advice date"*, and *"we should add a workflow which would be 'Pay Off Demand
 * Requested' … Our system should have a stamp when the payoff was requested, and that should be
 * added to the critical dates section also with the date."*
 *
 * EVERY DATE SAYS WHERE IT CAME FROM, and a missing one says WHY — both composed on the server
 * (`lib/critical-dates.js`), never here, so the file screen and any other surface that shows these
 * dates can never describe the same fact two ways. The team reconciles three systems by hand; a
 * date with no provenance is one more thing to take on trust.
 *
 * Colours are explicit darks: `var(--ink*)` is a LIGHT paper token in this palette and renders
 * white-on-white (the standing hard rule).
 */

const INK = '#141B22';
const MUTED = '#4B585C';
const GOLD = '#AE8746';

export default function CriticalDates({ appId, onChanged }) {
  const [data, setData] = useState(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  const load = useCallback(() => (
    api.get(`/api/staff/applications/${appId}/critical-dates`).then(setData).catch(() => setData(null))
  ), [appId]);
  useEffect(() => { load(); }, [load]);

  if (!data || !Array.isArray(data.dates)) return null;
  const rows = data.dates;
  const payoff = rows.find((r) => r.key === 'payoff_demand');
  const locked = !!(payoff && payoff.date);

  async function setPayoff() {
    const note = await askPrompt(
      'Record a PAYOFF DEMAND on this file?\n\n'
      + 'This locks the draw centre: no new draws can be set up, requested or released, and the '
      + 'property is deactivated in Sitewire so the borrower cannot submit one either.\n\n'
      + 'Who asked for the payoff, and anything worth recording:');
    if (note === null) return;
    setBusy(true); setErr('');
    try {
      const out = await api.post(`/api/staff/applications/${appId}/payoff-demand`, { note: note || undefined });
      await load();
      onChanged && onChanged();
      // SAY WHETHER THE BORROWER'S OWN DOOR IS SHUT YET. PILOT's block always stands; the Sitewire
      // half can be switched off or the file may never have been pushed, and pretending otherwise
      // would leave a coordinator believing the borrower cannot submit when they can.
      const sw = out && out.sitewire;
      if (sw && sw.skipped === 'not_managed') {
        setErr('Recorded, and PILOT is blocking draws. This file has no draw project in Sitewire, so there was nothing to block there.');
      } else if (sw && (sw.parked || sw.error)) {
        setErr('Recorded, and PILOT is blocking draws — but Sitewire did not confirm the block. Check the sync review queue.');
      }
    } catch (e) {
      setErr((e.data && (e.data.error || e.data.message)) || e.message || 'Could not record the payoff demand.');
    } finally { setBusy(false); }
  }

  async function clearPayoff() {
    if (!(await askConfirm('Lift the payoff demand on this file?\n\nDraws will be unlocked and the borrower will be able to request them again.'))) return;
    setBusy(true); setErr('');
    try {
      await api.post(`/api/staff/applications/${appId}/payoff-demand`, { clear: true });
      await load();
      onChanged && onChanged();
    } catch (e) {
      setErr((e.data && (e.data.error || e.data.message)) || e.message || 'Could not lift the payoff demand.');
    } finally { setBusy(false); }
  }

  return (
    <div className="card" style={{ marginTop: 12 }}>
      <div className="row" style={{ justifyContent: 'space-between', alignItems: 'baseline', gap: 8, flexWrap: 'wrap' }}>
        <div style={{ fontWeight: 700, color: INK }}>Critical dates</div>
        {locked
          ? (
            <button className="btn link small" style={{ color: '#256168' }} disabled={busy} onClick={clearPayoff}>
              Lift the payoff demand
            </button>
          )
          : (
            <button className="btn soft small" disabled={busy} onClick={setPayoff}>
              {busy ? 'Recording…' : 'Record a payoff demand'}
            </button>
          )}
      </div>

      {/* THE LOCK IS SAID LOUDLY, at the top, before the dates — the owner's *"it should come out
          big that there was a Pay Off Demand on this one"*. A person about to work a draw has to
          see this without reading a table. */}
      {locked && (
        <div style={{
          marginTop: 8, padding: '10px 12px', border: `2px solid ${GOLD}`, borderRadius: 8,
          background: 'rgba(174,135,70,0.10)',
        }}>
          <div style={{ fontWeight: 700, color: INK, fontSize: 15 }}>
            ⚠ Payoff demand requested — the draw centre is locked
          </div>
          <div style={{ color: MUTED, marginTop: 2 }}>
            Requested {fmtDay(payoff.date)}{payoff.by ? ` by ${payoff.by}` : ''}. No new draws can be set up,
            requested or released while a payoff is outstanding.
            {payoff.note ? ` ${payoff.note}` : ''}
          </div>
        </div>
      )}

      <div style={{ marginTop: 10, display: 'grid', gap: 6 }}>
        {rows.map((r) => (
          <div key={r.key} className="row" style={{ gap: 10, alignItems: 'baseline', flexWrap: 'wrap' }}>
            <div style={{ minWidth: 170, color: MUTED }}>{r.label}</div>
            <div style={{ fontWeight: r.date ? 600 : 400, color: r.date ? INK : MUTED, minWidth: 110 }}>
              {r.date ? fmtDay(r.date) : '—'}
            </div>
            {/* WHERE IT CAME FROM, or WHY IT IS NOT THERE — never blank, because "no date" and
                "we could not read it" are different pieces of work for different people. */}
            <div className="small" style={{ color: MUTED, flex: 1, minWidth: 200 }}>{r.source || r.note || ''}</div>
          </div>
        ))}
        {data.payoffDate && (
          <div className="row" style={{ gap: 10, alignItems: 'baseline' }}>
            <div style={{ minWidth: 170, color: MUTED }}>Paid off</div>
            <div style={{ fontWeight: 600, color: INK }}>{fmtDay(data.payoffDate)}</div>
          </div>
        )}
      </div>
      {err && <div className="notice" style={{ marginTop: 8 }}>{err}</div>}
    </div>
  );
}
