import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { api } from '../lib/api.js';
import { INK, MUTED, GOLD, TEAL, S, money, num } from '../lib/research.js';
import { TownLookup } from '../components/AddressBox.jsx';
import ResearchNav from '../components/ResearchNav.jsx';

/* THE MARKET — what our own appraisers have said about the areas we lend in.
 *
 * Every report carries a 1004MC grid: how much sold, how much is listed, months
 * of supply, median price, days on market, sale-to-list. Each report states its
 * windows RELATIVELY ("the last 3 months"), and the server resolves those against
 * that report's own effective date, so reports written months apart stack onto
 * one axis. This screen draws the stack.
 *
 * ─── THE HONESTY, WHICH DECIDES THE WHOLE DESIGN ────────────────────────────
 *
 * This is NOT market data. It is what one appraiser thought about an area THEY
 * drew the boundary of, and in a town we have lent in twice it is two opinions.
 * So the sample size is not a footnote here — it is a first-class part of every
 * reading:
 *
 *   · a REPORTS row sits under the charts on the same axis, so "how much is this
 *     built on" is answered at a glance, per month;
 *   · a month resting on ONE report is drawn hollow and called out, because one
 *     opinion is not a trend;
 *   · the server's own caveat is printed verbatim, not paraphrased away.
 *
 * ─── WHY THREE SEPARATE CHARTS ──────────────────────────────────────────────
 *
 * Months of supply (~2–6), median price (~$450,000) and days on market (~30–60)
 * are three different units. Putting two of them on one plot needs two y-scales,
 * which makes the crossing point meaningless and is the single most misleading
 * thing a chart can do. Small multiples instead — one scale each, same x-axis,
 * read down the column for one month.
 *
 * Each chart is a SINGLE series, so no legend is needed (the title names it) and
 * no categorical palette is in play — colour carries no identity here, so there
 * is nothing for a colour-blind reader to confuse. Text is explicit dark ink; the
 * `--ink*` tokens in this codebase are LIGHT despite their names.
 */

const RANGES = [
  { v: '12', label: 'last 12 months' },
  { v: '24', label: 'last 2 years' },
  { v: '36', label: 'last 3 years' },
  { v: '60', label: 'last 5 years' },
];

/* The three readings, each with its own scale and its own sense of "good". */
const METRICS = [
  { key: 'months_supply', title: 'Months of supply',
    hint: 'How long it would take to sell everything currently listed. Under ~4 is a sellers’ market; over ~6 is a buyers’ market.',
    fmt: (v) => (v == null ? '—' : Number(v).toFixed(1)), suffix: ' mo' },
  { key: 'median_sale_price', title: 'Median sale price',
    hint: 'The middle sale price the appraisers reported for their market area.',
    fmt: (v) => money(v), suffix: '' },
  { key: 'median_dom', title: 'Days on market',
    hint: 'How long the middle home took to sell. Falling means the market is speeding up.',
    fmt: (v) => (v == null ? '—' : Math.round(Number(v))), suffix: ' days' },
];

export default function StaffMarket() {
  const [params, setParams] = useSearchParams();
  const [d, setD] = useState(null);
  const [reports, setReports] = useState(null);
  const [flips, setFlips] = useState(null);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const [showTable, setShowTable] = useState(false);

  const q = useMemo(() => {
    const o = {};
    for (const [k, v] of params.entries()) o[k] = v;
    return o;
  }, [params]);
  const [form, setForm] = useState({ city: q.city || '', state: q.state || '', zip: q.zip || '' });
  useEffect(() => { setForm({ city: q.city || '', state: q.state || '', zip: q.zip || '' }); }, [q]);

  const named = !!(q.city || q.zip || q.state);
  const months = q.months || '24';

  const load = useCallback(() => {
    if (!named) { setD(null); setReports(null); setFlips(null); return; }
    setBusy(true); setErr('');
    const where = { city: q.city, state: q.state, zip: q.zip };
    Promise.all([
      api.researchMarket({ ...where, months }),
      api.researchMarketReports(where).catch(() => null),
      api.researchFlips({ ...where, months: 24, limit: 25 }).catch(() => null),
    ])
      .then(([series, rep, fl]) => { setD(series); setReports(rep); setFlips(fl); })
      .catch((e) => { setD(null); setErr(e.message || 'Could not load that market'); })
      .finally(() => setBusy(false));
  }, [q.city, q.state, q.zip, months, named]);

  useEffect(() => { load(); }, [load]);

  function apply(next) {
    const merged = { ...q, ...next };
    const out = {};
    for (const [k, v] of Object.entries(merged)) if (v !== '' && v != null) out[k] = v;
    setParams(out, { replace: false });
  }

  // OLDEST FIRST for a chart — the server returns newest first, which is right
  // for a list and backwards for a time axis.
  const series = useMemo(() => ((d && d.months) || []).slice().reverse(), [d]);
  const totalReports = (d && d.reports) || 0;
  const thin = series.filter((m) => m.reports === 1).length;

  return (
    <div>
      <ResearchNav />
      <header style={{ marginBottom: 14 }}>
        <div style={{ marginBottom: 8 }}>
          <Link to="/internal/research" style={{ color: MUTED, fontSize: 13 }}>← Property Research</Link>
        </div>
        <h1 style={{ margin: '0 0 4px', color: INK }}>Market conditions</h1>
        <p style={{ margin: 0, color: MUTED, maxWidth: 800 }}>
          What our own appraisers have reported about a town — how fast it is selling, and which way
          it is moving. Built from the market page of every appraisal we hold for that area.
        </p>
      </header>

      {err && <div className="card" style={{ borderColor: '#B4423A', color: '#B4423A', marginBottom: 12 }}>{err}</div>}

      <TownLookup style={{ marginBottom: 12, maxWidth: 460 }}
        onFill={({ city, state, zip }) => setForm((f) => ({ ...f, city: city || f.city, state: state || f.state, zip: zip || f.zip }))} />

      <section style={{ ...S.panel, marginBottom: 12, display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'flex-end' }}>
        <label style={{ display: 'block' }}>
          <span style={S.label}>Town</span>
          <input style={{ ...S.input, width: 180 }} value={form.city}
            onChange={(e) => setForm({ ...form, city: e.target.value })}
            onKeyDown={(e) => { if (e.key === 'Enter') apply(form); }} placeholder="Piscataway" />
        </label>
        <label style={{ display: 'block' }}>
          <span style={S.label}>State</span>
          <input style={{ ...S.input, width: 70 }} maxLength={2} value={form.state}
            onChange={(e) => setForm({ ...form, state: e.target.value })}
            onKeyDown={(e) => { if (e.key === 'Enter') apply(form); }} placeholder="NJ" />
        </label>
        <label style={{ display: 'block' }}>
          <span style={S.label}>or ZIP</span>
          <input style={{ ...S.input, width: 110 }} value={form.zip}
            onChange={(e) => setForm({ ...form, zip: e.target.value })}
            onKeyDown={(e) => { if (e.key === 'Enter') apply(form); }} placeholder="08854" />
        </label>
        <button className="btn btn-gold small" onClick={() => apply(form)}>Show</button>
        <select style={{ ...S.input, width: 'auto' }} value={months}
          onChange={(e) => apply({ months: e.target.value })}>
          {RANGES.map((r) => <option key={r.v} value={r.v}>{r.label}</option>)}
        </select>
        {busy && <span style={{ color: MUTED, fontSize: 13, alignSelf: 'center' }}>Loading…</span>}
      </section>

      {!named && (
        <div className="card" style={{ color: MUTED }}>
          Name a town and state, or a ZIP, to see what our appraisers have said about it.
        </div>
      )}

      {named && d && series.length === 0 && (
        <div className="card" style={{ borderColor: '#B4423A' }}>
          <strong style={{ color: INK }}>Nothing to show for that area.</strong>
          <p style={{ margin: '6px 0 0', color: MUTED, fontSize: 13 }}>
            No appraisal we hold reported a market page for it. This only knows the places we have
            actually lent in — a town we have not worked is simply empty here, and no date range will change that.
          </p>
        </div>
      )}

      {named && series.length > 0 && (
        <>
          <Caveat totalReports={totalReports} thin={thin} months={series.length} note={d.note} />

          <div style={{ display: 'grid', gap: 12, gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))' }}>
            {METRICS.map((m) => <MetricChart key={m.key} metric={m} series={series} />)}
          </div>

          <ReportsStrip series={series} />

          <div style={{ marginTop: 12 }}>
            <button className="btn ghost small" onClick={() => setShowTable((v) => !v)}>
              {showTable ? 'Hide the numbers' : 'Show the numbers'}
            </button>
            {showTable && <NumbersTable series={series} />}
          </div>

          {reports && reports.rows && reports.rows.length > 0 && <BehindIt rows={reports.rows} />}
        </>
      )}

      {/* OUTSIDE the charts' own gate, deliberately. What appraisers SAID about a
          market and what they DID on their grids are two different corpora, and a
          town can be rich in one and empty in the other — measured, 55 of our 84
          ZIPs carry a single market read, while Trenton alone holds 71 size
          adjustments. Gating this on the charts would hide the adjustment evidence
          in precisely the towns where the market grid is thinnest. */}
      {/* NOT GATED ON THE CHARTS, for the reason the block below already gives:
          what appraisers SAID about a market and what actually TRADED in it are
          two different corpora, and a town can be rich in one and empty in the
          other. Measured: 3 of 22 towns holding flips have no 24-month market
          series at all, so gating this hid the transaction evidence in exactly
          the towns where the market grid is thinnest. */}
      {flips && flips.rows && flips.rows.length > 0 && <Flips d={flips} />}

      {named && <WhatAppraisersAdjust where={{ city: q.city, state: q.state, zip: q.zip, months }} />}
    </div>
  );
}

/* THE SAMPLE SIZE, STATED BEFORE ANY NUMBER IS READ. */
/* WHAT APPRAISERS AROUND HERE ACTUALLY ADJUST.

   The charts above are what appraisers SAID about this market — their own
   neighbourhood grids, stacked. This is what they DID: every size adjustment
   they wrote, divided by the size difference they wrote it for. It is the one
   corpus no data vendor has, because it comes out of reports we paid for.

   `GET /api/research/rates` has answered this since the warehouse shipped and no
   screen ever called it, so the only way to ask "what is a foot worth here" was
   to start a valuation and read it off the grid. This is the direct question, on
   the screen that already asks the neighbouring one.

   TWO FEET, NEVER MIXED. A 1004 states living area and a 1025 states gross
   building area, and the two are measured and shown apart (db/443) — several of
   our own towns hold their evidence almost entirely on the 2-4 unit side.

   REFUSALS ARE SHOWN. "Too few adjustments here to say" is the honest answer and
   the useful one: it tells an officer the number they are about to type has no
   local backing, which a blank space does not. */
function WhatAppraisersAdjust({ where }) {
  const [r, setR] = useState(null);
  const [why, setWhy] = useState('');
  useEffect(() => {
    let live = true;
    setR(null); setWhy('');
    api.researchRates(where)
      .then((d) => { if (!live) return; setR(d.rates || null); setWhy(d.why || ''); })
      .catch(() => { if (live) setWhy('could not be worked out'); });
    return () => { live = false; };
  }, [where.city, where.state, where.zip, where.months]);

  if (!r && !why) return null;
  const psf = r && r.pricePerSqft;
  const living = r && r.glaAdjustmentPerSqft;
  const building = r && r.glaAdjustmentPerSqftGba;
  const Rate = ({ label, rate, peerOnly }) => {
    if (!rate) return null;
    const peer = rate.source === 'peer';
    if (peerOnly && !peer) return null;
    return (
      <div style={{ minWidth: 210, flex: '1 1 210px' }}>
        <div style={{ color: MUTED, fontSize: 12, fontWeight: 700, textTransform: 'uppercase' }}>{label}</div>
        {rate.value != null ? (
          <>
            <div style={{ fontSize: 22, fontWeight: 700, color: INK }}>
              ${rate.value}<span style={{ fontSize: 13, fontWeight: 400, color: MUTED }}> a sq ft</span>
            </div>
            {rate.low != null && rate.high != null && (
              <div style={{ color: MUTED, fontSize: 12 }}>most between ${rate.low} and ${rate.high}</div>
            )}
            {peer && <span style={{ ...S.tag, borderColor: '#2F7F86', color: '#2F7F86', marginTop: 4 }}>
              from our own reports</span>}
            {rate.source === 'convention' && <span style={{ ...S.tag, borderColor: GOLD, color: GOLD, marginTop: 4 }}>
              national rule of thumb</span>}
          </>
        ) : <div style={{ fontSize: 14, color: MUTED, marginTop: 4 }}>too few here to say</div>}
        <div style={{ color: MUTED, fontSize: 12, marginTop: 4, lineHeight: 1.45 }}>{rate.basis || rate.why}</div>
      </div>
    );
  };

  return (
    <section style={{ ...S.panel, marginTop: 14 }}>
      <h2 style={{ margin: '0 0 4px', fontSize: 16, color: INK }}>What appraisers here actually adjust</h2>
      <p style={{ margin: '0 0 12px', color: MUTED, fontSize: 13, maxWidth: 780, lineHeight: 1.5 }}>
        The charts above are what appraisers <b style={{ color: INK }}>said</b> about this market. This is
        what they <b style={{ color: INK }}>did</b> — every size adjustment they wrote on a grid, divided by
        the size difference they wrote it for. It comes out of reports we paid for, so no data service has it.
      </p>
      {why && !r && <div style={{ color: MUTED, fontSize: 13 }}>{why}</div>}
      {r && (
        <div style={{ display: 'flex', gap: 22, flexWrap: 'wrap' }}>
          <Rate label="A square foot sells for" rate={psf} />
          <Rate label="Adjusted per square foot" rate={living} />
          <Rate label="On 2–4 unit sales" rate={building} peerOnly />
        </div>
      )}
      {r && r.distressedNote && (
        <div style={{ marginTop: 10, color: GOLD, fontSize: 13, lineHeight: 1.5 }}>{r.distressedNote}</div>
      )}
    </section>
  );
}

function Caveat({ totalReports, thin, months, note }) {
  return (
    <section style={{ ...S.panel, marginBottom: 12, borderColor: GOLD, background: '#FCFAF4' }}>
      <div style={{ color: INK, fontWeight: 600, marginBottom: 4 }}>
        Built from {num(totalReports)} appraisal{totalReports === 1 ? '' : 's'} across {num(months)} month{months === 1 ? '' : 's'}
        {thin > 0 && <span style={{ fontWeight: 400 }}> — {num(thin)} of those months rest on a single report</span>}
      </div>
      <p style={{ margin: 0, color: MUTED, fontSize: 13 }}>{note}</p>
    </section>
  );
}

/* ONE METRIC, ONE SCALE. A line for the reading, a hollow marker where only one
   report stands behind the month, and a hover tooltip on every point. */
function MetricChart({ metric, series }) {
  const [hover, setHover] = useState(null);
  const W = 320, H = 120, PAD_L = 6, PAD_R = 6, PAD_T = 10, PAD_B = 18;

  const pts = series.map((m, i) => ({ i, month: m.month, v: m[metric.key] == null ? null : Number(m[metric.key]), reports: m.reports }));
  const vals = pts.filter((p) => p.v != null).map((p) => p.v);
  if (!vals.length) {
    return (
      <section style={{ ...S.panel }}>
        <h3 style={{ margin: '0 0 2px', fontSize: 14, color: INK }}>{metric.title}</h3>
        <p style={{ margin: 0, color: MUTED, fontSize: 12 }}>No report stated this one.</p>
      </section>
    );
  }
  // Pad the scale so a flat series is not drawn as a line pinned to an edge.
  let lo = Math.min(...vals), hi = Math.max(...vals);
  if (lo === hi) { lo = lo * 0.9; hi = hi * 1.1 || 1; }
  const x = (i) => PAD_L + (pts.length === 1 ? (W - PAD_L - PAD_R) / 2 : (i * (W - PAD_L - PAD_R)) / (pts.length - 1));
  const y = (v) => PAD_T + (H - PAD_T - PAD_B) * (1 - (v - lo) / (hi - lo));

  const drawn = pts.filter((p) => p.v != null);
  const path = drawn.map((p, k) => `${k === 0 ? 'M' : 'L'}${x(p.i).toFixed(1)},${y(p.v).toFixed(1)}`).join(' ');
  const last = drawn[drawn.length - 1];
  const first = drawn[0];
  const dir = drawn.length > 1 ? last.v - first.v : 0;

  return (
    <section style={{ ...S.panel }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 8 }}>
        <h3 style={{ margin: '0 0 2px', fontSize: 14, color: INK }}>{metric.title}</h3>
        <span style={{ color: INK, fontWeight: 700, fontSize: 16 }}>
          {metric.fmt(last.v)}<span style={{ color: MUTED, fontWeight: 400, fontSize: 12 }}>{metric.suffix}</span>
        </span>
      </div>
      <p style={{ margin: '0 0 6px', color: MUTED, fontSize: 12, minHeight: 30 }}>{metric.hint}</p>

      <svg viewBox={`0 0 ${W} ${H}`} style={{ width: '100%', height: 'auto', display: 'block', overflow: 'visible' }}
        role="img" aria-label={`${metric.title} over time, ending at ${metric.fmt(last.v)}`}>
        {/* Recessive baseline — a grid would be noise on a series this short. */}
        <line x1={PAD_L} y1={H - PAD_B} x2={W - PAD_R} y2={H - PAD_B} stroke="#E4DECF" strokeWidth="1" />
        <path d={path} fill="none" stroke={TEAL} strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" />
        {drawn.map((p) => (
          <g key={p.i}>
            {/* A month resting on ONE report is drawn HOLLOW — one opinion is not a
                trend, and that must be visible in the mark itself, not only in a note. */}
            <circle cx={x(p.i)} cy={y(p.v)} r={hover === p.i ? 6 : 4.5}
              fill={p.reports === 1 ? '#fff' : TEAL} stroke={TEAL} strokeWidth="2" />
            {/* A hit target far bigger than the mark. */}
            <circle cx={x(p.i)} cy={y(p.v)} r="14" fill="transparent"
              onMouseEnter={() => setHover(p.i)} onMouseLeave={() => setHover(null)} />
          </g>
        ))}
        {hover != null && (() => {
          const p = pts.find((z) => z.i === hover);
          if (!p || p.v == null) return null;
          const tx = Math.min(Math.max(x(p.i), 52), W - 52);
          return (
            <g pointerEvents="none">
              <line x1={x(p.i)} y1={PAD_T} x2={x(p.i)} y2={H - PAD_B} stroke="#DDD6C7" strokeWidth="1" />
              <rect x={tx - 50} y={2} width="100" height="30" rx="4" fill="#141B22" opacity="0.92" />
              <text x={tx} y={14} textAnchor="middle" fontSize="10" fill="#fff">
                {monthLabel(p.month)} · {metric.fmt(p.v)}{metric.suffix}
              </text>
              <text x={tx} y={26} textAnchor="middle" fontSize="9" fill="#D9D2C4">
                from {p.reports} report{p.reports === 1 ? '' : 's'}
              </text>
            </g>
          );
        })()}
        <text x={PAD_L} y={H - 4} fontSize="9" fill={MUTED}>{monthLabel(first.month)}</text>
        <text x={W - PAD_R} y={H - 4} fontSize="9" fill={MUTED} textAnchor="end">{monthLabel(last.month)}</text>
      </svg>

      {drawn.length > 1 && (
        <div style={{ color: MUTED, fontSize: 12, marginTop: 4 }}>
          {dir === 0 ? 'Flat' : dir > 0 ? 'Up' : 'Down'} over the period
          {' '}({metric.fmt(first.v)} → {metric.fmt(last.v)})
        </div>
      )}
    </section>
  );
}

/* HOW MUCH EACH MONTH IS BUILT ON, on the same axis as the charts above it.
   Deliberately its own row rather than encoded into the marks: sample size is
   not a property of the reading, it is how far you should trust it. */
function ReportsStrip({ series }) {
  const max = Math.max(...series.map((m) => m.reports), 1);
  return (
    <section style={{ ...S.panel, marginTop: 12 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 6 }}>
        <h3 style={{ margin: 0, fontSize: 14, color: INK }}>Appraisals behind each month</h3>
        <span style={{ color: MUTED, fontSize: 12 }}>A bar of one is a single opinion, not a market.</span>
      </div>
      <div style={{ display: 'flex', alignItems: 'flex-end', gap: 2, height: 44 }}>
        {series.map((m) => (
          <div key={m.month} title={`${monthLabel(m.month)} — ${m.reports} report${m.reports === 1 ? '' : 's'}`}
            style={{ flex: 1, minWidth: 3, display: 'flex', flexDirection: 'column', justifyContent: 'flex-end', height: '100%' }}>
            <div style={{
              height: `${Math.max(8, (m.reports / max) * 100)}%`,
              background: m.reports === 1 ? '#EAE4D7' : TEAL,
              borderRadius: '3px 3px 0 0',
              border: m.reports === 1 ? '1px solid #DDD6C7' : 'none',
            }} />
          </div>
        ))}
      </div>
      <div style={{ display: 'flex', justifyContent: 'space-between', color: MUTED, fontSize: 10, marginTop: 3 }}>
        <span>{monthLabel(series[0].month)}</span>
        <span>{monthLabel(series[series.length - 1].month)}</span>
      </div>
    </section>
  );
}

/* The table view — every chart here has one, so nothing is available only as a
   picture. */
function NumbersTable({ series }) {
  return (
    <div style={{ ...S.panel, marginTop: 8, overflowX: 'auto' }}>
      <table style={{ borderCollapse: 'collapse', width: '100%', minWidth: 520 }}>
        <thead><tr>
          <th style={S.th}>Month</th><th style={S.th}>Appraisals</th>
          <th style={S.th}>Months of supply</th><th style={S.th}>Median sale price</th>
          <th style={S.th}>Days on market</th><th style={S.th}>Sale to list</th>
        </tr></thead>
        <tbody>
          {series.slice().reverse().map((m) => (
            <tr key={m.month}>
              <td style={S.cell}>{monthLabel(m.month)}</td>
              <td style={{ ...S.cell, fontWeight: m.reports === 1 ? 700 : 400, color: m.reports === 1 ? GOLD : INK }}>
                {m.reports}
              </td>
              <td style={S.cell}>{m.months_supply == null ? '—' : Number(m.months_supply).toFixed(1)}</td>
              <td style={S.cell}>{money(m.median_sale_price)}</td>
              <td style={S.cell}>{m.median_dom == null ? '—' : Math.round(Number(m.median_dom))}</td>
              <td style={S.cell}>{m.sale_to_list_pct == null ? '—' : `${Number(m.sale_to_list_pct).toFixed(1)}%`}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/* BOUGHT AND RESOLD — the completed exits in this town, out of the prior-sale
   line of appraisals we already paid for. A bridge lender's own question, and
   until now the warehouse could not answer it: `properties` carries only the
   LATEST sale, so the purchase a flip started from was invisible.

   IT SAYS WHAT IT IS NOT, every time. Two recorded sales and the time between
   them is not proof anybody renovated anything, and it is not a rate of return —
   these are the sales our appraisers happened to describe, a fraction of a town.
   The renovated marker is the APPRAISER's judgement (they put the resale on an
   after-repair grid), never inferred from the size of the spread. */
function Flips({ d }) {
  const rows = d.rows || [];
  return (
    <section style={{ ...S.panel, marginTop: 12 }}>
      <h3 style={{ margin: '0 0 4px', fontSize: 14, color: INK }}>Bought and resold within two years</h3>
      <p style={{ margin: '0 0 8px', color: MUTED, fontSize: 12 }}>
        {d.caveat}
        {d.setAsideNote ? ` ${d.setAsideNote}.` : ''}
      </p>
      <div style={{ overflowX: 'auto' }}>
        <table style={{ borderCollapse: 'collapse', width: '100%', minWidth: 640 }}>
          <thead><tr>
            <th style={S.th}>Property</th><th style={S.th}>Bought</th><th style={S.th}>Resold</th>
            <th style={S.th}>Held</th><th style={S.th}>Difference</th>
          </tr></thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={`${r.property_id}-${i}`}>
                <td style={S.cell}>
                  <Link to={`/internal/research/property/${r.property_id}`} style={{ color: INK, fontWeight: 600 }}>
                    {r.display_address}
                  </Link>
                  <div style={{ color: MUTED, fontSize: 11 }}>
                    {[r.property_type, r.units != null ? `${r.units} unit${Number(r.units) === 1 ? '' : 's'}` : null]
                      .filter(Boolean).join(' · ') || 'type not stated'}
                  </div>
                  {r.resold_as_renovated && (
                    <div style={{ color: TEAL, fontSize: 11, fontWeight: 600 }}>
                      resold as a finished house — an appraiser used it on an after-repair grid
                    </div>
                  )}
                  {r.bought_arms_length === false && (
                    <div style={{ color: GOLD, fontSize: 11 }}>bought {String(r.bought_type).replace(/Sale$/, '').toLowerCase()}</div>
                  )}
                </td>
                <td style={S.cell}>{money(r.bought_for)}<div style={{ color: MUTED, fontSize: 11 }}>{dayLabel(r.bought_on)}</div></td>
                <td style={S.cell}>{money(r.sold_for)}<div style={{ color: MUTED, fontSize: 11 }}>{dayLabel(r.sold_on)}</div></td>
                <td style={S.cell}>{r.held_months == null ? '—' : `${r.held_months} mo`}</td>
                <td style={{ ...S.cell, fontWeight: 700, color: Number(r.spread) < 0 ? '#B4423A' : TEAL }}>
                  {money(r.spread)}
                  <div style={{ fontWeight: 400, fontSize: 11 }}>
                    {r.spread_pct == null ? '' : `${Number(r.spread_pct) > 0 ? '+' : ''}${Number(r.spread_pct)}%`}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

/* THE REPORTS THEMSELVES — who said it, when, and what they concluded. The
   series is an average of these; being able to open the actual opinions is what
   keeps it honest. */
function BehindIt({ rows }) {
  return (
    <section style={{ ...S.panel, marginTop: 12 }}>
      <h3 style={{ margin: '0 0 6px', fontSize: 14, color: INK }}>The appraisals behind this</h3>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        {rows.slice(0, 25).map((r) => (
          <div key={r.id} style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'baseline',
            borderBottom: '1px solid #EEE9DD', paddingBottom: 6 }}>
            <span style={{ color: INK, fontWeight: 600, minWidth: 92 }}>{dayLabel(r.effective_date)}</span>
            <span style={{ color: MUTED, fontSize: 13 }}>
              {[r.city, r.state, r.zip].filter(Boolean).join(', ')}
              {r.appraiser_name ? ` · ${r.appraiser_name}` : ''}
              {r.appraiser_company ? ` (${r.appraiser_company})` : ''}
            </span>
            {r.trends && Object.entries(r.trends).map(([k, v]) => (
              <span key={k} style={{ ...S.tag, borderColor: v === 'Declining' ? '#B4423A' : v === 'Increasing' ? TEAL : '#DDD6C7' }}>
                {trendLabel(k)}: {v}
              </span>
            ))}
            {r.nbhd_marketing_time && <span style={S.tag}>typical sale: {r.nbhd_marketing_time}</span>}
          </div>
        ))}
      </div>
      {rows.length > 25 && (
        <p style={{ margin: '8px 0 0', color: MUTED, fontSize: 12 }}>
          Showing the 25 most recent of {num(rows.length)}.
        </p>
      )}
    </section>
  );
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
/* A date-only value is a 'YYYY-MM-DD' STRING end to end here — never run one
   through `new Date()`, which reads it as UTC midnight and can render the month
   before in a western timezone. */
function monthLabel(v) {
  const m = /^(\d{4})-(\d{2})/.exec(String(v || ''));
  return m ? `${MONTHS[+m[2] - 1]} ${m[1].slice(2)}` : '—';
}
function dayLabel(v) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(v || ''));
  return m ? `${MONTHS[+m[2] - 1]} ${+m[3]}, ${m[1]}` : '—';
}
const TREND_LABEL = {
  MedianSalesPrice: 'Prices', MedianListPrice: 'Asking prices', Supply: 'Supply',
  MedianSalesDOM: 'Time to sell', TotalSales: 'Sales', TotalListings: 'Listings',
  AbsorptionRate: 'Absorption', MedianSalesToListRatio: 'Sale to list', MedianListDOM: 'Listing age',
};
const trendLabel = (k) => TREND_LABEL[k] || k;
