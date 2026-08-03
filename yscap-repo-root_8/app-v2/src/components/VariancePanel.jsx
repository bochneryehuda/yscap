import React, { useCallback, useEffect, useState } from 'react';
import { api } from '../lib/api.js';

/* WHAT OUR OWN FILES SAY ABOUT THIS APPRAISER'S VALUE.
 *
 * The engine (`src/lib/research/variance.js`) shipped with 37 assertions and a
 * verified route, and had no screen — so the answer existed and nobody could
 * see it. This is that screen, and it is deliberately the quietest panel on the
 * appraisal tab.
 *
 * WHY QUIET. "The appraisal is 14% high" is an accusation about a licensed
 * professional's work. Produced from four sales in the wrong town it is a FALSE
 * accusation that reads exactly like a true one — so the engine is mostly
 * refusals, and the screen's job is to carry them at full size rather than let a
 * percentage be the only thing anyone reads. A refusal is rendered the same way
 * an answer is, the disclaimer travels with every number, and the wording is a
 * prompt to go and look, never a verdict.
 */

const INK = '#141B22';
const MUTED = '#4B585C';
const GOLD = '#AE8746';
const TEAL = '#2F7F86';
const BAD = '#B4483C';

const money = (v) => (v == null ? '—' : `$${Math.round(Number(v)).toLocaleString('en-US')}`);

export default function VariancePanel({ appraisalId }) {
  const [d, setD] = useState(null);
  const [err, setErr] = useState('');

  const load = useCallback(() => {
    if (!appraisalId) return;
    setErr('');
    api.researchVariance({ appraisal_id: appraisalId })
      .then(setD)
      .catch((e) => setErr(e.message || 'Could not work that out'));
  }, [appraisalId]);
  useEffect(() => { setD(null); load(); }, [load]);

  if (!appraisalId) return null;
  if (err) {
    return (
      <section style={panel}>
        <Head />
        <div style={{ color: MUTED, fontSize: 13 }}>{err}</div>
      </section>
    );
  }
  if (!d) return null;
  const v = d.variance || d;
  const cov = v.coverage || {};

  return (
    <section style={panel}>
      <Head />

      {v.available ? (
        <>
          <div style={{ display: 'flex', gap: 14, alignItems: 'baseline', flexWrap: 'wrap' }}>
            <div style={{ font: '700 22px/1.1 Fraunces, Georgia, serif',
              color: v.direction === 'in line' ? TEAL : v.notable ? GOLD : INK }}>
              {v.direction === 'in line'
                ? 'In line with our own files'
                : `${Math.abs(v.variancePct).toFixed(1)}% ${v.direction === 'above ours' ? 'above' : 'below'} ours`}
            </div>
            {v.notable && (
              <span style={{ fontSize: 12, padding: '2px 9px', borderRadius: 999,
                border: `1px solid ${GOLD}`, color: '#8A5A00' }}>worth a look</span>
            )}
          </div>
          <div style={{ fontSize: 13.5, color: INK, marginTop: 6 }}>
            Our own comparables indicate <b>{money(v.ourValue)}</b>.
          </div>

          {/* THE COVERAGE IS NOT A FOOTNOTE. A percentage with no denominator is
              the false accusation this panel exists to avoid. */}
          <div style={{ fontSize: 12.5, color: MUTED, marginTop: 6 }}>
            Built from <b style={{ color: INK }}>{cov.comps}</b> comparable{cov.comps === 1 ? '' : 's'} in{' '}
            <b style={{ color: INK }}>{cov.reports}</b> report{cov.reports === 1 ? '' : 's'} by{' '}
            <b style={{ color: INK }}>{cov.appraisers}</b> appraiser{cov.appraisers === 1 ? '' : 's'}
            {cov.fromThisReport > 0 && (
              <> · {cov.fromThisReport} more came from THIS report and were set aside — a report checked
                against its own comparables agrees with itself and means nothing</>
            )}
            {cov.spreadCv != null && <> · our own sales agree to within ±{Math.round(cov.spreadCv * 100)}%</>}
          </div>
        </>
      ) : (
        /* A REFUSAL AT FULL SIZE. If it were quieter than an answer, the panel
           would read as broken on exactly the files where it is being careful. */
        <>
          <div style={{ font: '700 16px/1.2 Fraunces, Georgia, serif', color: INK }}>
            We cannot second-guess this one
          </div>
          <div style={{ fontSize: 13.5, color: INK, marginTop: 5 }}>{v.why}</div>
          {cov.fromThisReport > 0 && (
            <div style={{ fontSize: 12.5, color: MUTED, marginTop: 6 }}>
              {cov.fromThisReport} of the comparables nearby came from this report itself and were set
              aside before anything was counted.
            </div>
          )}
        </>
      )}

      <div style={{ marginTop: 10, paddingTop: 8, borderTop: '1px solid #EFE9DA',
        fontSize: 11.5, color: MUTED }}>
        {v.disclaimer}
      </div>
    </section>
  );
}

const Head = () => (
  <div style={{ marginBottom: 8 }}>
    <h3 style={{ margin: 0, fontSize: 15, color: INK }}>What our own files say about this value</h3>
    <div style={{ fontSize: 12, color: MUTED, marginTop: 2 }}>
      A prompt to go and look — never a conclusion, and never an appraisal review.
    </div>
  </div>
);

const panel = {
  background: '#fff', border: `1px solid ${GOLD}33`, borderLeft: `3px solid ${GOLD}`,
  borderRadius: 10, padding: 12, marginBottom: 14,
};
