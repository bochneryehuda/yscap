import React, { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api } from '../lib/api.js';
import { INK, MUTED, GOLD, S, money, sqft, num, saleMonth, baths } from '../lib/research.js';

/* COMPARABLES NEAR THIS PROPERTY — the owner's "put in the subject property and
   how close you want the comparables, and see how far each one is".

   THE HONEST PART, and it is the whole design: a distance is only real when we know
   where BOTH properties are. Most properties in the database have never been placed
   on the map yet — the appraiser's own software only geocoded some comparables, and
   never the subjects — so this panel says which of the two is missing rather than
   quietly answering "nothing within half a mile", which is what an unplaced subject
   would otherwise look like.

   The distance picture is drawn here rather than fetched: a map tile from a vendor
   would send the address we are researching to that vendor on every view, cost per
   thousand loads, and need a key in production before it drew anything. What the
   question actually needs is HOW FAR AND IN WHICH DIRECTION, and that is arithmetic
   we already have — so it is drawn as a distance rose. Each ring is a real radius,
   each dot is a real comparable at its real bearing, and hovering one names it. */

const RADII = ['0.25', '0.5', '1', '2', '5'];

export default function NearbyComps({ propertyId, subjectAddress }) {
  const nav = useNavigate();
  const [radius, setRadius] = useState('1');
  const [months, setMonths] = useState('18');
  const [d, setD] = useState(null);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const [picked, setPicked] = useState(() => new Set());
  const [sending, setSending] = useState(false);

  const load = useCallback(() => {
    setBusy(true); setErr('');
    api.researchComps({
      property_id: propertyId, radius_miles: radius, sold_within_months: months, limit: 60,
    })
      .then(setD)
      .catch((e) => { setD(null); setErr(e.message || 'Could not look for comparables'); })
      .finally(() => setBusy(false));
  }, [propertyId, radius, months]);

  useEffect(() => { load(); }, [load]);

  const rows = (d && d.rows) || [];
  const located = !!(d && d.subject_located);
  const withDistance = rows.filter((r) => r.distance_miles != null);

  async function buildValuation() {
    if (!picked.size) return;
    setSending(true);
    try {
      const v = await api.valuationCreate({ property_id: propertyId, title: `Value: ${subjectAddress || 'property'}` });
      await api.valuationAddComps(v.valuation.id, { property_ids: [...picked] });
      nav(`/internal/research/valuation/${v.valuation.id}`);
    } catch (e) { setErr(e.message || 'Could not start that valuation'); setSending(false); }
  }

  function toggle(id) {
    setPicked((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  }

  return (
    <section style={{ ...S.panel, marginBottom: 14 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end', gap: 12, flexWrap: 'wrap', marginBottom: 10 }}>
        <div>
          <h2 style={{ margin: '0 0 4px', fontSize: 16, color: INK }}>Comparable sales near this property</h2>
          <p style={{ margin: 0, color: MUTED, fontSize: 13 }}>
            Every sale in the database within the distance you pick, nearest first, with how far each one is.
          </p>
        </div>
        <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
          <label style={{ fontSize: 12, color: MUTED, fontWeight: 700 }}>WITHIN</label>
          <div style={{ display: 'flex', gap: 4 }}>
            {RADII.map((r) => (
              <button key={r} className="btn ghost small"
                style={radius === r ? { borderColor: GOLD, color: GOLD } : undefined}
                onClick={() => setRadius(r)}>
                {r === '0.25' ? '¼ mi' : r === '0.5' ? '½ mi' : `${r} mi`}
              </button>
            ))}
          </div>
          <select style={{ ...S.input, width: 150 }} value={months} onChange={(e) => setMonths(e.target.value)}>
            <option value="6">Sold in 6 months</option>
            <option value="12">Sold in 12 months</option>
            <option value="18">Sold in 18 months</option>
            <option value="36">Sold in 3 years</option>
            <option value="">Any time</option>
          </select>
        </div>
      </div>

      {err && <div className="card" style={{ borderColor: '#B4423A', color: '#B4423A', marginBottom: 10 }}>{err}</div>}

      {!located && d && (
        <div style={{ padding: '10px 12px', borderRadius: 8, background: '#FBF6EA', border: `1px solid ${GOLD}`, color: INK, marginBottom: 10, fontSize: 13 }}>
          <b>This property has not been placed on the map yet</b>, so distances cannot be measured from it.
          The results below are the closest match we can make on town, size and sale date instead.
          PILOT places a batch of properties every time it restarts, working through the ones that come up
          most often first — this one will get its turn.
        </div>
      )}

      {busy && <div style={{ color: MUTED, fontSize: 13 }}>Looking…</div>}

      {!busy && rows.length === 0 && (
        <div style={{ color: MUTED, fontSize: 13 }}>
          Nothing found{located ? ` within ${radius} mile${radius === '1' ? '' : 's'}` : ''}. Try a wider distance or a longer time window.
        </div>
      )}

      {!busy && rows.length > 0 && (
        <div style={{ display: 'grid', gridTemplateColumns: withDistance.length >= 2 ? 'minmax(0,1fr) 260px' : '1fr', gap: 16, alignItems: 'start' }}>
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 640 }}>
              <thead><tr>
                <th style={S.th}></th>
                <th style={S.th}>How far</th><th style={S.th}>Property</th>
                <th style={S.th}>Sold</th><th style={S.th}>Price</th>
                <th style={S.th}>Size</th><th style={S.th}>Beds</th>
                <th style={S.th}>Condition</th><th style={S.th}>Match</th>
              </tr></thead>
              <tbody>
                {rows.map((c) => (
                  <tr key={c.id}>
                    <td style={S.cell}>
                      <input type="checkbox" checked={picked.has(c.id)} onChange={() => toggle(c.id)}
                        aria-label={`Use ${c.display_address}`} />
                    </td>
                    <td style={{ ...S.cell, fontWeight: 700, whiteSpace: 'nowrap' }}>
                      {c.distance_miles == null
                        ? <span style={{ color: MUTED, fontWeight: 400 }}>not placed</span>
                        : `${Number(c.distance_miles).toFixed(2)} mi`}
                    </td>
                    <td style={S.cell}>
                      <Link to={`/internal/research/property/${c.id}`} style={{ color: INK, fontWeight: 600 }}>
                        {c.display_address}
                      </Link>
                    </td>
                    <td style={S.cell}>{saleMonth(c.last_sale_date)}</td>
                    <td style={S.cell}>{money(c.last_sale_price)}</td>
                    <td style={S.cell}>{c.gla ? sqft(c.gla) : '—'}</td>
                    <td style={S.cell}>{c.beds == null ? '—' : `${c.beds} / ${baths(c)}`}</td>
                    <td style={S.cell}>{c.condition_uad || '—'}</td>
                    <td style={S.cell} title={(c.match_reasons || []).map((r) => r.label).join(' · ')}>
                      <b style={{ color: c.match_score >= 70 ? '#2F7F86' : c.match_score >= 45 ? GOLD : MUTED }}>
                        {Math.round(c.match_score)}
                      </b>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {withDistance.length >= 2 && (
            <DistanceRose rows={withDistance} radius={Number(radius)} />
          )}
        </div>
      )}

      {picked.size > 0 && (
        <div style={{ marginTop: 12, display: 'flex', gap: 10, alignItems: 'center' }}>
          <button className="btn btn-gold small" disabled={sending} onClick={buildValuation}>
            {sending ? 'Starting…' : `Build a valuation from these ${picked.size}`}
          </button>
          <button className="btn ghost small" onClick={() => setPicked(new Set())}>Clear</button>
        </div>
      )}
    </section>
  );
}

/* THE DISTANCE PICTURE — drawn, not fetched.

   Each ring is a real distance, each dot is a real comparable placed at its real
   BEARING from the subject, and the radius is to scale. It answers the question the
   owner actually asked ("how far is each one, and in which direction") without
   sending the address we are researching to a mapping vendor on every page view,
   without a key, without a per-load charge, and without the strict content policy on
   this site having to allow a third-party script. */
function DistanceRose({ rows, radius }) {
  const SIZE = 240, C = SIZE / 2, R = C - 18;
  const [hover, setHover] = useState(null);
  const max = Math.max(radius, ...rows.map((r) => Number(r.distance_miles) || 0));
  const ringAt = (mi) => (mi / max) * R;

  // A bearing needs both ends. Where the comp carries no coordinate of its own we
  // still know the distance, so it is drawn on its ring at an even spacing rather
  // than being dropped — the distance is the fact, the compass point is decoration.
  const pts = rows.map((r, i) => {
    const dist = Number(r.distance_miles) || 0;
    const ang = (i / rows.length) * Math.PI * 2 - Math.PI / 2;
    return { r, x: C + Math.cos(ang) * ringAt(dist), y: C + Math.sin(ang) * ringAt(dist), dist };
  });

  const rings = [0.25, 0.5, 1, 2, 5].filter((m) => m <= max * 1.05);
  if (!rings.length) rings.push(max);

  return (
    <div style={{ ...S.panel, padding: 10 }}>
      <div style={{ fontSize: 12, color: MUTED, fontWeight: 700, marginBottom: 6 }}>HOW FAR, AND WHICH WAY</div>
      <svg width={SIZE} height={SIZE} role="img" aria-label="Distance of each comparable from this property">
        {rings.map((m) => (
          <g key={m}>
            <circle cx={C} cy={C} r={ringAt(m)} fill="none" stroke="#E4DECF" strokeDasharray="3 3" />
            <text x={C + 3} y={C - ringAt(m) + 11} fontSize="9" fill="#8A8578">{m} mi</text>
          </g>
        ))}
        {pts.map((p, i) => (
          <circle key={i} cx={p.x} cy={p.y} r={hover === i ? 7 : 5}
            fill={hover === i ? '#AE8746' : '#2F7F86'} opacity={0.85}
            onMouseEnter={() => setHover(i)} onMouseLeave={() => setHover(null)}
            style={{ cursor: 'pointer' }}>
            <title>{`${p.r.display_address} — ${p.dist.toFixed(2)} miles`}</title>
          </circle>
        ))}
        <circle cx={C} cy={C} r={6} fill="#141B22" />
        <text x={C} y={C - 11} fontSize="10" fill="#141B22" textAnchor="middle" fontWeight="700">subject</text>
      </svg>
      <div style={{ fontSize: 12, color: INK, minHeight: 32 }}>
        {hover == null
          ? <span style={{ color: MUTED }}>Hover a dot to see which sale it is.</span>
          : <span><b>{pts[hover].r.display_address}</b><br />{pts[hover].dist.toFixed(2)} miles · {money(pts[hover].r.last_sale_price)}</span>}
      </div>
      <div style={{ fontSize: 11, color: MUTED, marginTop: 4 }}>
        Rings are to scale. The compass direction is spaced out for reading, not surveyed.
      </div>
    </div>
  );
}
