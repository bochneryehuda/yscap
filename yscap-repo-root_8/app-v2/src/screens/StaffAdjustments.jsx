import React, { useCallback, useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { api } from '../lib/api.js';
import { INK, MUTED, GOLD, TEAL, S } from '../lib/research.js';

/* A DOLLAR FIGURE THAT KEEPS ITS CENTS WHEN THEY MATTER. The shared `money`
   rounds to whole dollars, which is right for a $25,000 condition line and wrong
   for a $49.73 square-foot rate — it would print $50 and quietly erase the
   difference between two markets. Cents below $100, whole dollars above. */
const dollars = (v) => {
  if (v == null || v === '') return '—';
  const n = Number(v);
  if (!Number.isFinite(n)) return '—';
  return n < 100
    ? `$${n.toFixed(2).replace(/\.00$/, '')}`
    : `$${Math.round(n).toLocaleString('en-US')}`;
};

/* WHAT OUR OWN APPRAISERS CHARGE — the adjustment corpus.
 *
 * Every appraisal carries a grid of adjustments: "this comparable was 200 feet
 * bigger, so I took $10,000 off". We hold about 9× more of those than we hold
 * actual sales, and until this screen nothing ever looked at one.
 *
 * ─── THE CLAIM DECIDES THE WHOLE DESIGN ─────────────────────────────────────
 *
 * The indefensible version is "a square foot is worth $50 in Newark". Our sample
 * is our own handful of reports, not the market, and nothing here can support
 * that. The defensible version — the one this screen renders — is:
 *
 *     "This report used $40 a square foot. 42 of our reports, by 16 appraisers,
 *      used a median of $50; half of them between $40 and $50."
 *
 * Every number in that is something an appraiser handed us in writing. So the
 * counts are not a footnote, they are the load-bearing part: a median with no n,
 * no report count and no appraiser count is the indefensible claim wearing the
 * defensible one's clothes. They get their own columns, always visible, never
 * behind a toggle.
 *
 * ─── THE FORM ───────────────────────────────────────────────────────────────
 *
 * One row per market, and each row is a RANGE, not a bar: a thin rule from the
 * first quartile to the third with a dot at the median. A bar chart would say
 * "this is the number"; a range says "half of them were in here", which is what
 * the data actually supports. All rows share one dollar axis so they can be read
 * against each other — but the per-unit markets ($/sqft) and the flat ones ($ a
 * line) are DIFFERENT UNITS and get their own axis each, because putting $50 and
 * $25,000 on one scale makes every small one invisible and compares nothing.
 *
 * A market that REFUSED still gets a row. "We hold nothing worth reporting here"
 * is the ordinary answer and hiding it would make the screen look complete.
 */

const LINE_LABEL = {
  GrossLivingArea: 'Living area', GrossBuildingArea: 'Building area',
  RoomCount: 'Room count', CarStorage: 'Garage / parking', Parking: 'Parking',
  BasementFinish: 'Finished basement', BasementArea: 'Basement area',
  PorchDeck: 'Porch / deck', SiteArea: 'Lot size', HeatingCooling: 'Heating / cooling',
  Condition: 'Condition', Quality: 'Quality', DesignStyle: 'Design / style',
  FunctionalUtility: 'Functional utility', View: 'View', Location: 'Location',
  Age: 'Age', DateOfSale: 'Date of sale', OtherFeature: 'Other feature',
  Other: 'Other', PropertyRights: 'Property rights', SalesConcessions: 'Concessions',
  FinancingConcessions: 'Financing concessions', EnergyEfficient: 'Energy efficiency',
};
const label = (m) => (m.kind === 'per_unit'
  ? (m.basis === 'sqft_gba' ? 'Per sq ft of building' : 'Per sq ft of living area')
  : (LINE_LABEL[m.line_type] || m.line_type));

const unitOf = (m) => (m.kind === 'per_unit' ? '/sq ft' : '');

export default function StaffAdjustments() {
  const [sp, setSp] = useSearchParams();
  // THE URL IS WHAT IS SHOWN; THE BOXES ARE ONLY A DRAFT. Seeding the boxes from
  // the URL once and then reading the boxes to decide what to fetch looks
  // equivalent and is not: arriving here from a link that names a different
  // market (an appraisal's "what do we usually charge here?") changes the query
  // without remounting the screen, so a once-only seed leaves the boxes — and
  // therefore the fetch — on the market the officer came from. The screen would
  // sit on the wrong state, or on the empty prompt, with the answer in the
  // address bar. So the fetch reads the URL, and the boxes follow it.
  const appraisalId = sp.get('appraisal_id') || '';
  const qState = sp.get('state') || '';
  const qCity = sp.get('city') || '';

  const [state, setState] = useState(qState);
  const [city, setCity] = useState(qCity);
  const [data, setData] = useState(null);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => { setState(qState); setCity(qCity); }, [qState, qCity]);

  const load = useCallback(() => {
    const q = {};
    if (appraisalId) q.appraisal_id = appraisalId;
    if (qState) q.state = qState;
    if (qCity) q.city = qCity;
    if (!q.appraisal_id && !q.state && !q.city) { setData(null); setErr(''); return; }
    setBusy(true); setErr('');
    api.researchAdjustmentRates(q)
      .then((d) => { setData(d); setBusy(false); })
      .catch((e) => { setErr(e.message || 'Could not read the adjustment rates'); setBusy(false); });
  }, [qState, qCity, appraisalId]);
  useEffect(() => { load(); }, [load]);

  function search(e) {
    e.preventDefault();
    const next = {};
    if (appraisalId) next.appraisal_id = appraisalId;
    if (state) next.state = state;
    if (city) next.city = city;
    setSp(next, { replace: true });
  }

  const markets = (data && data.markets) || [];
  const perUnit = markets.filter((m) => m.kind === 'per_unit');
  const flat = markets.filter((m) => m.kind !== 'per_unit');

  return (
    <div>
      <h1 style={{ margin: '0 0 4px', color: INK, fontSize: 24 }}>What our appraisers charge</h1>
      <p style={{ margin: '0 0 14px', color: MUTED, fontSize: 14, maxWidth: 720 }}>
        Every adjustment our own appraisers have written, gathered by what they adjusted for. This is
        a statement about <b style={{ color: INK }}>our reports</b> — not about the market — which is
        exactly what makes it worth quoting: every figure came to us in writing.
      </p>

      <form onSubmit={search} style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 16 }}>
        <input value={state} onChange={(e) => setState(e.target.value.toUpperCase().slice(0, 2))}
          placeholder="State" style={{ ...S.input, width: 90 }} aria-label="State" />
        <input value={city} onChange={(e) => setCity(e.target.value)}
          placeholder="Town (optional)" style={{ ...S.input, width: 200 }} aria-label="Town" />
        <button className="btn btn-gold small" type="submit" disabled={busy}>
          {busy ? 'Reading…' : 'Show'}
        </button>
      </form>

      {err && <div className="card" style={{ borderColor: '#B4423A', color: '#B4423A' }}>{err}</div>}
      {!data && !err && (
        <div className="card" style={{ color: MUTED }}>
          Name a state, or a town, to see what our reports have charged there.
        </div>
      )}

      {data && (
        <>
          <ScopeNote data={data} />
          {!markets.length && (
            <div className="card" style={{ color: MUTED }}>
              We hold no adjustment lines at all for that market. Our warehouse holds what our own
              reports described, so a town we have not lent in is simply empty — no filter will help.
            </div>
          )}
          <Group title="Per square foot" markets={perUnit}
            note="A living-area figure and a building-area figure are different measures. They are kept apart, never averaged." />
          <Group title="Per line" markets={flat}
            note="A garage, a porch, a finished basement. No measurable difference to divide by, so this is what the line itself was worth." />
        </>
      )}
    </div>
  );
}

/* WHICH MARKET ANSWERED, AND WHAT WAS TRIED. A town-level answer and a
   state-level one are different claims, and presenting the second as the first is
   the failure this screen most has to avoid. */
function ScopeNote({ data }) {
  const tried = data.tried || [];
  if (!data.scope) return null;
  const fellBack = tried.length > 1 && tried[0] && !tried[0].answered;
  return (
    <div style={{ ...S.panel, marginBottom: 14, borderLeft: `3px solid ${fellBack ? GOLD : TEAL}` }}>
      <div style={{ color: INK, fontSize: 14 }}>
        Showing <b>{data.scope}</b>.
        {fellBack && (
          <> We hold too little in <b>{tried[0].scope}</b> to say anything there, so this is the
            wider area — treat it as what our appraisers do generally, not as a local rate.</>
        )}
      </div>
      {data.truncated && (
        <div style={{ color: '#8A5A00', fontSize: 13, marginTop: 6 }}>
          There were more lines than one reading can hold, so this is a large sample rather than
          every line. The figures may shift a little as more is read.
        </div>
      )}
    </div>
  );
}

function Group({ title, markets, note }) {
  if (!markets.length) return null;
  const answered = markets.filter((m) => m.summary.available);
  // ONE AXIS PER GROUP, because the two groups are different units. Scaled to the
  // widest quartile in this group so the ranges can be read against each other.
  const max = Math.max(1, ...answered.map((m) => Number(m.summary.q3) || 0));

  return (
    <section style={{ ...S.panel, marginBottom: 16 }}>
      <h2 style={{ margin: '0 0 2px', fontSize: 16, color: INK }}>{title}</h2>
      <p style={{ margin: '0 0 12px', color: MUTED, fontSize: 13 }}>{note}</p>
      <div style={{ overflowX: 'auto' }}>
        <table style={{ width: '100%', minWidth: 720, borderCollapse: 'collapse', fontSize: 13 }}>
          <thead>
            <tr style={{ textAlign: 'left', color: MUTED, borderBottom: '1px solid #E4DECF' }}>
              <th style={{ padding: '6px 8px', fontWeight: 700 }}>What was adjusted</th>
              <th style={{ padding: '6px 8px', fontWeight: 700, width: '34%' }}>Half of them were between</th>
              <th style={{ padding: '6px 8px', fontWeight: 700, textAlign: 'right' }}>Median</th>
              {/* THE COUNTS ARE COLUMNS, NOT A FOOTNOTE. A median with no n and no
                  appraiser count is the indefensible version of this claim. */}
              <th style={{ padding: '6px 8px', fontWeight: 700, textAlign: 'right' }}>Lines</th>
              <th style={{ padding: '6px 8px', fontWeight: 700, textAlign: 'right' }}>Reports</th>
              <th style={{ padding: '6px 8px', fontWeight: 700, textAlign: 'right' }}>Appraisers</th>
              <th style={{ padding: '6px 8px', fontWeight: 700, textAlign: 'right' }}>$0 lines</th>
            </tr>
          </thead>
          <tbody>
            {markets.map((m, i) => <Row key={i} m={m} max={max} />)}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function Row({ m, max }) {
  const s = m.summary;
  const zeros = (s.declines || 0) + (s.zeros || 0);
  const zeroTitle = s.declines
    ? `${s.declines} reports saw the same difference and adjusted nothing — a judgement that it did not matter`
    : (s.zeros ? `${s.zeros} reports wrote $0. The grid does not say whether they saw no difference `
      + 'or chose not to adjust' : '');

  if (!s.available) {
    // A REFUSAL IS A ROW. Hiding it would make the screen look complete.
    return (
      <tr style={{ borderBottom: '1px solid #F0EBE0' }}>
        <td style={{ padding: '8px', color: INK }}>{label(m)}</td>
        <td colSpan={5} style={{ padding: '8px', color: MUTED }}>{s.why}</td>
        <td style={{ padding: '8px', textAlign: 'right', color: MUTED }}>{zeros || '—'}</td>
      </tr>
    );
  }
  const pctOf = (v) => `${Math.max(0, Math.min(100, (Number(v) / max) * 100))}%`;
  return (
    <tr style={{ borderBottom: '1px solid #F0EBE0' }}>
      <td style={{ padding: '8px', color: INK }}>
        {label(m)}
        {m.thisReport && (
          <div style={{ fontSize: 12, marginTop: 2, color: m.thisReport.inside ? TEAL : '#8A5A00' }}>
            This report used {dollars(m.thisReport.rate)}{unitOf(m)} — {m.thisReport.where}
          </div>
        )}
      </td>
      <td style={{ padding: '8px' }}>
        {/* A RANGE, NOT A BAR. A bar says "this is the number"; the rule from the
            first quartile to the third says "half of them were in here", which is
            what the data supports. The median is a dot on it. */}
        <div style={{ position: 'relative', height: 16 }} title={s.sentence}>
          <div style={{ position: 'absolute', top: 7, left: 0, right: 0, height: 2, background: '#EDE7DA' }} />
          <div style={{ position: 'absolute', top: 6, left: pctOf(s.q1),
            width: `calc(${pctOf(s.q3)} - ${pctOf(s.q1)})`, height: 4, background: '#CBBF9E', borderRadius: 2 }} />
          <div style={{ position: 'absolute', top: 3, left: pctOf(s.median), width: 10, height: 10,
            marginLeft: -5, borderRadius: '50%', background: GOLD, border: '2px solid #fff' }} />
        </div>
        <div style={{ color: MUTED, fontSize: 12, marginTop: 2 }}>
          {dollars(s.q1)} – {dollars(s.q3)}{unitOf(m)}
        </div>
      </td>
      <td style={{ padding: '8px', textAlign: 'right', color: INK, fontWeight: 700 }}>
        {dollars(s.median)}{unitOf(m)}
      </td>
      <td style={{ padding: '8px', textAlign: 'right', color: INK }}>{s.n}</td>
      <td style={{ padding: '8px', textAlign: 'right', color: INK }}>{s.reports}</td>
      <td style={{ padding: '8px', textAlign: 'right', color: INK }}>
        {s.appraisers}
        {s.capped && <span title="One appraiser wrote more than their share, so they count once here"
          style={{ color: GOLD, marginLeft: 4 }}>*</span>}
      </td>
      <td style={{ padding: '8px', textAlign: 'right', color: MUTED }} title={zeroTitle}>
        {zeros || '—'}
      </td>
    </tr>
  );
}
