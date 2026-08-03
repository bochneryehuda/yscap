import React, { useState } from 'react';

/* THE QC PANEL — does this set actually support the number?
 *
 * Three things that already existed and reached no screen at all:
 *
 *  · BRACKETING (`lib/research/bracketing`) — whether the comparables surround
 *    the subject or all sit on one side of it. If they are all bigger, the value
 *    is extrapolated downward from every one of them and the ADJUSTMENT is doing
 *    the work rather than a sale.
 *  · `scoreComp.parts[]` — the score has always been a sum of named parts with a
 *    weight each, and the screen showed only the total. "Fair, 62" tells a
 *    reviewer nothing they can act on; "distance 20/20, size 6/15, condition
 *    not stated" tells them exactly which comparable to look at and why.
 *  · `weight` — a per-comparable weight, writable through the API since the day
 *    it was built, with no control anywhere. A reviewer who can see that one
 *    comparable is a poor match and cannot do anything about it is being shown a
 *    problem and denied the fix.
 *
 * EVERYTHING HERE IS ADVISORY. Nothing on this panel blocks a valuation, changes
 * a number on its own, or refuses to reconcile. It says which direction the
 * answer is unsupported in and lets a human decide whether they care.
 */

const INK = '#141B22';
const MUTED = '#4B585C';
const GOLD = '#AE8746';
const TEAL = '#2F7F86';
const BAD = '#B4483C';

const money = (v) => (v == null ? '—' : `$${Math.round(Number(v)).toLocaleString('en-US')}`);

export default function ValuationQc({ bracketing, comps = [], warnings = [], onWeight = null, disabled = false }) {
  const [open, setOpen] = useState(false);
  const b = bracketing;

  return (
    <section style={{ background: '#fff', border: '1px solid #E7E1D3', borderRadius: 10, padding: 12, marginBottom: 14 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 10, flexWrap: 'wrap' }}>
        <h3 style={{ margin: 0, fontSize: 15, color: INK }}>Does this set support the number?</h3>
        <button type="button" className="btn ghost small" onClick={() => setOpen((v) => !v)}>
          {open ? 'Hide the detail' : 'Show the detail'}
        </button>
      </div>

      {/* THE CONCLUSION FIRST — a value outside every adjusted comparable is a
          different and more serious thing than a dimension not bracketing,
          because it is about the answer rather than about the evidence. */}
      {b && b.value && !b.value.inside && (
        <div style={{ marginTop: 8, padding: 8, borderRadius: 6, background: 'rgba(180,72,60,.07)',
          border: `1px solid ${BAD}`, color: INK, fontSize: 13 }}>
          <b style={{ color: BAD }}>{b.value.why}.</b>{' '}
          The {b.value.n} adjusted comparable{b.value.n === 1 ? '' : 's'} run from {money(b.value.low)} to{' '}
          {money(b.value.high)}, and the indicated value is {money(b.value.indicated)}.
        </div>
      )}

      {b && <div style={{ marginTop: 8, fontSize: 13, color: INK }}>{b.summary}</div>}

      {b && b.dimensions.some((d) => d.known) && (
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 8 }}>
          {b.dimensions.filter((d) => d.known).map((d) => (
            <span key={d.key} title={d.why || `${d.below} below, ${d.equal} the same, ${d.above} above`}
              style={{ fontSize: 11.5, padding: '2px 8px', borderRadius: 999,
                border: `1px solid ${d.brackets ? TEAL : GOLD}`,
                color: d.brackets ? TEAL : '#8A5A00',
                background: d.brackets ? 'rgba(47,127,134,.07)' : 'rgba(174,135,70,.10)' }}>
              {d.label} {d.brackets ? '✓' : '— one side only'}
            </span>
          ))}
        </div>
      )}

      {open && (
        <>
          {/* A dimension we could not judge is stated, so "5 of 7" never reads as
              "the other 2 failed". */}
          {b && b.dimensions.some((d) => !d.known) && (
            <div style={{ marginTop: 10, fontSize: 12.5, color: MUTED }}>
              <b style={{ color: INK }}>Not checked:</b>{' '}
              {b.dimensions.filter((d) => !d.known).map((d) => `${d.label} (${d.why})`).join('; ')}.
            </div>
          )}

          {b && b.misses.length > 0 && (
            <ul style={{ margin: '10px 0 0 18px', padding: 0, fontSize: 12.5, color: '#8A5A00' }}>
              {b.misses.map((m) => <li key={m.key}><b style={{ color: INK }}>{m.label}</b> — {m.why}</li>)}
            </ul>
          )}

          {warnings.length > 0 && (
            <div style={{ marginTop: 12 }}>
              <div style={{ fontSize: 12, color: MUTED, fontWeight: 700, marginBottom: 4 }}>
                Worth a look
              </div>
              <ul style={{ margin: '0 0 0 18px', padding: 0, fontSize: 12.5, color: '#8A5A00' }}>
                {warnings.map((w, i) => <li key={i}>{w.message || w.code || String(w)}</li>)}
              </ul>
            </div>
          )}

          {/* 5.4 — THE SCORE'S FACTORS, AND THE WEIGHT. */}
          <div style={{ marginTop: 14 }}>
            <div style={{ fontSize: 12, color: MUTED, fontWeight: 700, marginBottom: 6 }}>
              How each comparable scored, and how much it counts
            </div>
            {comps.map((c, i) => <CompScore key={c.id != null ? c.id : i} c={c} n={i + 1}
              onWeight={onWeight} disabled={disabled} />)}
            {comps.length === 0 && (
              <div style={{ fontSize: 12.5, color: MUTED }}>No comparables on this valuation yet.</div>
            )}
          </div>
        </>
      )}
    </section>
  );
}

function CompScore({ c, n, onWeight, disabled }) {
  const s = c.score || {};
  const parts = Array.isArray(s.parts) ? s.parts : [];
  const [w, setW] = useState(c.weight == null ? '' : String(c.weight));

  return (
    <div style={{ borderTop: '1px solid #F0EBE0', padding: '8px 0' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10, flexWrap: 'wrap', alignItems: 'baseline' }}>
        <div style={{ fontSize: 13, color: INK }}>
          {n}. {c.display_address || c.live_address || 'Comparable'}
          {c.include === false && <span style={{ color: MUTED }}> — set aside</span>}
        </div>
        <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
          {s.label && (
            <span style={{ fontSize: 12, color: s.label === 'strong' ? TEAL : s.label === 'very weak' ? BAD : GOLD }}>
              {s.label}{s.score != null ? ` · ${s.score}` : ''}
            </span>
          )}
          {onWeight && (
            <label style={{ fontSize: 11.5, color: MUTED, display: 'flex', gap: 4, alignItems: 'center' }}
              title="How much this comparable counts in the reconciliation. Leave blank to let the score decide.">
              weight
              <input value={w} disabled={disabled}
                onChange={(e) => setW(e.target.value.replace(/[^\d.]/g, '').slice(0, 5))}
                onBlur={() => onWeight(c.id, w === '' ? null : Number(w))}
                placeholder="auto"
                style={{ width: 54, fontSize: 12, padding: '2px 4px', border: '1px solid #E4DECF',
                  borderRadius: 4, color: INK, background: '#fff' }} />
            </label>
          )}
        </div>
      </div>

      {/* THE PARTS. "Fair, 62" is not something a reviewer can act on; a part
          that scored 6 of 15 tells them which comparable to look at and why. */}
      {parts.length > 0 && (
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 5 }}>
          {parts.map((p, i) => {
            const ratio = p.unknown || !p.weight ? null : p.earned / p.weight;
            const tone = p.unknown ? MUTED : ratio >= 0.8 ? TEAL : ratio >= 0.5 ? GOLD : BAD;
            return (
              <span key={i} title={p.unknown
                ? 'Neither report states this, so it counts for nothing either way — a fact nobody stated is not a bad match'
                : `${p.earned} of ${p.weight}`}
              style={{ fontSize: 11, padding: '1px 7px', borderRadius: 999, border: `1px solid ${tone}`, color: tone }}>
                {p.label}{p.unknown ? ' — not stated' : ` ${p.earned}/${p.weight}`}
              </span>
            );
          })}
        </div>
      )}
      {Array.isArray(s.reasons) && s.reasons.length > 0 && (
        <div style={{ fontSize: 11.5, color: MUTED, marginTop: 4 }}>{s.reasons.join(' · ')}</div>
      )}
    </div>
  );
}
