import React, { useCallback, useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { api } from '../lib/api.js';
import { INK, MUTED, GOLD, TEAL, S } from '../lib/research.js';
import { TownLookup } from '../components/AddressBox.jsx';

/* QUICK ANSWER — an address, a few basics, and roughly what properties like that
 * have been coming in at.
 *
 * THE SCREEN IS SHAPED BY WHAT IT MUST NOT BECOME. A big number next to an
 * address is read as a valuation however much small print sits under it, so:
 *
 *  · the RANGE is the headline, in the largest type on the page, and the median
 *    is smaller and sits inside it — never the other way round;
 *  · the denominator is next to the range, not in a footnote;
 *  · a refusal renders as prominently as an answer, in the same place, so
 *    "we cannot say" is as visible as "here it is";
 *  · nothing on this page is ever a single figure on its own.
 */

const money = (v) => (v == null ? '—' : `$${Math.round(Number(v)).toLocaleString('en-US')}`);

export default function StaffQuickAnswer() {
  const [sp, setSp] = useSearchParams();
  const qCity = sp.get('city') || '';
  const qState = sp.get('state') || '';
  const qUnits = sp.get('units') || '';
  const qGla = sp.get('gla') || '';
  const qMonths = sp.get('months') || '18';

  const [city, setCity] = useState(qCity);
  const [state, setState] = useState(qState);
  const [units, setUnits] = useState(qUnits);
  const [gla, setGla] = useState(qGla);
  const [months, setMonths] = useState(qMonths);
  const [d, setD] = useState(null);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);

  // The URL is what is shown; the boxes follow it. Same rule as the adjustment
  // screen — a link naming a different town must not leave the boxes behind.
  useEffect(() => {
    setCity(qCity); setState(qState); setUnits(qUnits); setGla(qGla); setMonths(qMonths || '18');
  }, [qCity, qState, qUnits, qGla, qMonths]);

  const load = useCallback(() => {
    if (!qCity && !qState) { setD(null); setErr(''); return; }
    setBusy(true); setErr('');
    api.researchQuick({ city: qCity, state: qState, units: qUnits, gla: qGla, months: qMonths })
      .then((x) => { setD(x); setBusy(false); })
      .catch((e) => { setErr(e.message || 'Could not work that out'); setBusy(false); });
  }, [qCity, qState, qUnits, qGla, qMonths]);
  useEffect(() => { load(); }, [load]);

  function search(e) {
    e.preventDefault();
    const next = {};
    if (city) next.city = city;
    if (state) next.state = state;
    if (units) next.units = units;
    if (gla) next.gla = gla;
    if (months) next.months = months;
    setSp(next, { replace: true });
  }

  const a = d && d.answer;

  return (
    <div>
      <h1 style={{ margin: '0 0 4px', color: INK, fontSize: 24 }}>Quick answer</h1>
      <p style={{ margin: '0 0 14px', color: MUTED, fontSize: 14, maxWidth: 760 }}>
        A town and a couple of basics, and what properties like that have been coming in at
        <b style={{ color: INK }}> in the appraisals we have paid for</b>. It is not a valuation and it
        is never a single figure — below five matches it says nothing at all.
      </p>

      <TownLookup style={{ marginBottom: 12, maxWidth: 460 }}
        onFill={({ city: c, state: s }) => { if (c) setCity(c); if (s) setState(s); }} />

      <form onSubmit={search} style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 16, alignItems: 'flex-end' }}>
        <label style={{ fontSize: 12, color: MUTED }}>Town<br />
          <input value={city} onChange={(e) => setCity(e.target.value)} placeholder="Trenton"
            style={{ ...S.input, width: 170 }} /></label>
        <label style={{ fontSize: 12, color: MUTED }}>State<br />
          <input value={state} onChange={(e) => setState(e.target.value.toUpperCase().slice(0, 2))}
            placeholder="NJ" style={{ ...S.input, width: 80 }} /></label>
        <label style={{ fontSize: 12, color: MUTED }}>Units<br />
          <input value={units} onChange={(e) => setUnits(e.target.value.replace(/\D/g, '').slice(0, 3))}
            placeholder="1" style={{ ...S.input, width: 80 }} /></label>
        <label style={{ fontSize: 12, color: MUTED }}>Size (sq ft)<br />
          <input value={gla} onChange={(e) => setGla(e.target.value.replace(/\D/g, '').slice(0, 6))}
            placeholder="1500" style={{ ...S.input, width: 110 }} /></label>
        <label style={{ fontSize: 12, color: MUTED }}>Sold within<br />
          <select value={months} onChange={(e) => setMonths(e.target.value)} style={{ ...S.input, width: 130 }}>
            {['6', '12', '18', '24', '36', '60'].map((m) => (
              <option key={m} value={m}>{m} months</option>
            ))}
          </select></label>
        <button className="btn btn-gold small" type="submit" disabled={busy}>
          {busy ? 'Working…' : 'Answer'}
        </button>
      </form>

      {err && <div className="card" style={{ borderColor: '#B4423A', color: '#B4423A' }}>{err}</div>}
      {!d && !err && (
        <div className="card" style={{ color: MUTED }}>
          Name a town to start. The more you tell it about the property, the closer the match — and the
          more likely it is to say it does not hold enough to answer.
        </div>
      )}

      {a && a.available && (
        <section style={{ ...S.panel, marginBottom: 14 }}>
          {/* THE RANGE IS THE HEADLINE. The median is smaller and INSIDE it. */}
          <div style={{ display: 'flex', gap: 14, alignItems: 'baseline', flexWrap: 'wrap' }}>
            <div style={{ font: '700 30px/1.1 Fraunces, Georgia, serif', color: TEAL }}>
              {money(a.low)} – {money(a.high)}
            </div>
            <div style={{ fontSize: 15, color: INK }}>median <b>{a.medianApprox}</b></div>
          </div>
          {/* THE DENOMINATOR SITS NEXT TO THE NUMBER, never in a footnote. */}
          <div style={{ fontSize: 13.5, color: INK, marginTop: 6 }}>{a.sentence}</div>
          {a.q1 != null && a.q3 != null && (
            <div style={{ fontSize: 12.5, color: MUTED, marginTop: 4 }}>
              The middle half of them sat between {money(a.q1)} and {money(a.q3)}.
            </div>
          )}
          {a.flags.length > 0 && (
            <ul style={{ margin: '8px 0 0 18px', padding: 0, fontSize: 12.5, color: '#8A5A00' }}>
              {a.flags.map((f) => <li key={f.code}>{f.message}</li>)}
            </ul>
          )}
          <div style={{ marginTop: 10, paddingTop: 8, borderTop: '1px solid #EFE9DA', fontSize: 12, color: MUTED }}>
            {d.disclaimer}
          </div>
        </section>
      )}

      {/* A REFUSAL RENDERS AS PROMINENTLY AS AN ANSWER, in the same place. If it
          were quieter, the screen would read as broken rather than as honest. */}
      {a && !a.available && (
        <section style={{ ...S.panel, marginBottom: 14, borderLeft: `3px solid ${GOLD}` }}>
          <div style={{ font: '700 17px/1.2 Fraunces, Georgia, serif', color: INK, marginBottom: 6 }}>
            We cannot answer this one
          </div>
          <div style={{ fontSize: 13.5, color: INK }}>{a.why}</div>
          <div style={{ fontSize: 12.5, color: MUTED, marginTop: 8 }}>
            Matched {a.coverage.matched}
            {a.coverage.noPrice > 0 ? `, of which ${a.coverage.noPrice} state no price` : ''}
            {a.coverage.heldNearby != null ? ` · we hold ${a.coverage.heldNearby} in the area altogether` : ''}
          </div>
        </section>
      )}

      {d && d.matched && d.matched.length > 0 && (
        <section style={{ ...S.panel }}>
          <h2 style={{ margin: '0 0 8px', fontSize: 15, color: INK }}>
            What it looked at{d.matched.length < (a && a.coverage.matched) ? ` (first ${d.matched.length})` : ''}
          </h2>
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', minWidth: 560, borderCollapse: 'collapse', fontSize: 13 }}>
              <thead>
                <tr style={{ textAlign: 'left', color: MUTED, borderBottom: '1px solid #E4DECF' }}>
                  <th style={{ padding: '5px 8px', fontWeight: 700 }}>Property</th>
                  <th style={{ padding: '5px 8px', fontWeight: 700, textAlign: 'right' }}>Sold for</th>
                  <th style={{ padding: '5px 8px', fontWeight: 700, textAlign: 'right' }}>Sold</th>
                  <th style={{ padding: '5px 8px', fontWeight: 700, textAlign: 'right' }}>Size</th>
                  <th style={{ padding: '5px 8px', fontWeight: 700, textAlign: 'right' }}>Units</th>
                </tr>
              </thead>
              <tbody>
                {d.matched.map((m) => (
                  <tr key={m.id} style={{ borderBottom: '1px solid #F0EBE0' }}>
                    <td style={{ padding: '6px 8px', color: INK }}>{m.display_address}</td>
                    <td style={{ padding: '6px 8px', textAlign: 'right', color: INK }}>{money(m.last_sale_price)}</td>
                    <td style={{ padding: '6px 8px', textAlign: 'right', color: MUTED }}>
                      {m.last_sale_date ? String(m.last_sale_date).slice(0, 10) : '—'}</td>
                    <td style={{ padding: '6px 8px', textAlign: 'right', color: MUTED }}>
                      {m.gla ? `${Number(m.gla).toLocaleString('en-US')} sqft` : '—'}</td>
                    <td style={{ padding: '6px 8px', textAlign: 'right', color: m.units == null ? '#B4483C' : INK }}>
                      {m.units == null ? 'not stated' : m.units}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}
    </div>
  );
}
