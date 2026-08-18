import React, { useCallback, useEffect, useMemo, useState } from 'react';
import LtLayout from './LtLayout.jsx';
import { ltApi } from './api.js';
import LtShadowCompare from './LtShadowCompare.jsx';

// ---------------------------------------------------------------------------
// PRICING TRANSPARENCY — the "mother interface" (owner-directed 2026-08-17):
// "we can see every single adjustment, every single LLPA, and we should be able
// to see the base price and the final price — same way everything is visible in
// Lender Price."
//
// This screen shows ONE scenario's price the way Lender Price does: the base price
// at the top, every itemized LLPA/adjustment with its running effect down the
// stack, the corporate margin as its own line, the round-and-floor as its own
// reconciling line, and the final price standing out. Beside it, why either engine
// would decline it.
//
// It computes NOTHING. The server's read-model (`ppe/pricing-breakdown.js`) is the
// one place a price is broken down; this page only draws what it returns, so the
// screen and the engine can never disagree about the same number.
//
// Dark text on the white PILOT canvas throughout — never a `--ink*` token, which is
// a LIGHT paper colour in this palette and would render white-on-white. Explicit
// darks (#141B22 / #3A4550 / #4B585C) per the hard rule.
// ---------------------------------------------------------------------------

const INK = '#141B22';
const SLATE = '#3A4550';
const MUTED = '#4B585C';
const GOLD = '#AE8746';
const GOLD_INK = '#856529';
const TEAL = '#256168';
const RED = '#8A2F2F';
const PAPER = '#F4F1EA';
const LINE = 'rgba(20,27,34,.10)';

const card = {
  border: '1px solid rgba(20,27,34,.12)', borderRadius: 14, padding: 18,
  background: '#fff', marginBottom: 16,
};
const h2 = { margin: '0 0 4px', fontSize: 16, color: INK, fontWeight: 600 };
const sub = { margin: '0 0 14px', fontSize: 13, color: MUTED, lineHeight: 1.5 };
const eyebrow = {
  fontSize: 11, letterSpacing: '.1em', textTransform: 'uppercase',
  color: MUTED, fontWeight: 700,
};
const numFont = { fontVariantNumeric: 'tabular-nums' };

// milli-points → a signed points figure, 3 places. +0.500 / −0.250.
function fmtPts(m) {
  if (!Number.isFinite(m)) return '—';
  const sign = m > 0 ? '+' : m < 0 ? '−' : '';
  return `${sign}${(Math.abs(m) / 1000).toFixed(3)}`;
}
// milli-points price → a plain price figure, 3 places. 99.500
function fmtPrice(m) {
  if (!Number.isFinite(m)) return '—';
  return (m / 1000).toFixed(3);
}
function fmtRate(r) {
  if (r == null || !Number.isFinite(Number(r))) return '—';
  return `${Number(r)}%`;
}

function Pill({ tone, children }) {
  const tones = {
    good: { bg: 'rgba(47,127,134,.10)', fg: TEAL, bd: 'rgba(47,127,134,.35)' },
    warn: { bg: 'rgba(174,135,70,.12)', fg: GOLD_INK, bd: 'rgba(174,135,70,.40)' },
    bad: { bg: 'rgba(158,58,58,.10)', fg: RED, bd: 'rgba(158,58,58,.32)' },
    flat: { bg: PAPER, fg: SLATE, bd: 'rgba(20,27,34,.14)' },
  };
  const t = tones[tone] || tones.flat;
  return (
    <span style={{
      display: 'inline-block', padding: '2px 9px', borderRadius: 999, fontSize: 12,
      fontWeight: 600, background: t.bg, color: t.fg, border: `1px solid ${t.bd}`,
    }}>{children}</span>
  );
}

function Field({ label, hint, children }) {
  return (
    <label style={{ display: 'block', minWidth: 120 }}>
      <div style={{ ...eyebrow, marginBottom: 4 }}>{label}</div>
      {children}
      {hint && <div style={{ fontSize: 11, color: MUTED, marginTop: 3 }}>{hint}</div>}
    </label>
  );
}

// The prominent base → final headline.
function PriceHeadline({ b }) {
  const box = {
    flex: 1, minWidth: 160, padding: '14px 16px', borderRadius: 12,
    background: PAPER, border: '1px solid rgba(20,27,34,.10)',
  };
  return (
    <div style={{ display: 'flex', gap: 14, alignItems: 'stretch', flexWrap: 'wrap' }}>
      <div style={box}>
        <div style={eyebrow}>Base price</div>
        <div style={{ ...numFont, fontSize: 30, color: SLATE, fontWeight: 600, lineHeight: 1.1 }}>{fmtPrice(b.base_price)}</div>
        <div style={{ fontSize: 12, color: MUTED, marginTop: 2 }}>par is 100.000</div>
      </div>
      <div style={{ display: 'flex', alignItems: 'center', color: GOLD, fontSize: 26, fontWeight: 700 }} aria-hidden>→</div>
      <div style={{ ...box, background: 'linear-gradient(180deg,#fff,#FBF9F3)', border: `1px solid ${GOLD}` }}>
        <div style={{ ...eyebrow, color: GOLD_INK }}>Final price</div>
        <div style={{ ...numFont, fontSize: 34, color: INK, fontWeight: 700, lineHeight: 1.1 }}>{fmtPrice(b.final_price)}</div>
        <div style={{ ...numFont, fontSize: 12, color: MUTED, marginTop: 2 }}>
          {b.final_points == null ? '' : `${fmtPts(b.final_points)} points`}
        </div>
      </div>
    </div>
  );
}

// One row of the waterfall.
function StackRow({ label, dimension, pointsMilli, costPositive, runningPrice, tone, bold }) {
  const ptsColor = pointsMilli == null ? MUTED : (costPositive ? RED : TEAL);
  return (
    <tr style={{ borderTop: `1px solid ${LINE}` }}>
      <td style={{ padding: '9px 12px 9px 0', verticalAlign: 'top' }}>
        {dimension && <div style={{ ...eyebrow, fontSize: 10, marginBottom: 2 }}>{dimension}</div>}
        <div style={{ fontSize: 13.5, color: INK, fontWeight: bold ? 600 : 500 }}>{label}</div>
      </td>
      <td style={{ ...numFont, padding: '9px 12px', textAlign: 'right', fontSize: 13.5, fontWeight: 600, color: ptsColor, whiteSpace: 'nowrap' }}>
        {pointsMilli == null ? '' : fmtPts(pointsMilli)}
      </td>
      <td style={{ ...numFont, padding: '9px 0 9px 12px', textAlign: 'right', fontSize: 13.5, color: bold ? INK : SLATE, fontWeight: bold ? 700 : 500, whiteSpace: 'nowrap' }}>
        {runningPrice == null ? '' : fmtPrice(runningPrice)}
      </td>
    </tr>
  );
}

const DIM_LABEL = (d) => (d ? String(d).replace(/[_-]+/g, ' ') : '');

// The engine expects its own integer units; the form is honest about that rather
// than inventing a conversion rule (LTV in milli-percent, DSCR in milli, etc.).
const NUMERIC_KEYS = ['fico', 'ltv', 'cltv', 'dscr', 'loan_amount', 'units', 'lock_days', 'term'];

export default function LtPricingBreakdown() {
  const [investors, setInvestors] = useState(null);
  const [form, setForm] = useState({
    rateSheetVersionId: '', investor: '', source: '', rate: '',
    fico: '', ltv: '', dscr: '', loan_amount: '', purpose: '', occupancy: '', property_type: '',
  });
  const [result, setResult] = useState(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    ltApi.ppeInvestors().then(setInvestors).catch(() => setInvestors(null));
  }, []);

  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));

  const buildBody = useCallback((overrideRate) => {
    const scenario = {};
    for (const [k, v] of Object.entries(form)) {
      if (['rateSheetVersionId', 'investor', 'source', 'rate'].includes(k)) continue;
      if (v === '' || v == null) continue;
      scenario[k] = NUMERIC_KEYS.includes(k) ? Number(v) : v;
    }
    const body = { scenario };
    if (form.rateSheetVersionId) body.rateSheetVersionId = form.rateSheetVersionId.trim();
    if (form.investor) body.investor = form.investor;
    if (form.source) body.source = form.source;
    const r = overrideRate != null ? overrideRate : form.rate;
    if (r !== '' && r != null) body.rate = Number(r);
    return body;
  }, [form]);

  const price = useCallback(async (overrideRate) => {
    setBusy(true); setError('');
    try {
      const out = await ltApi.ppeBreakdown(buildBody(overrideRate));
      setResult(out.breakdown || null);
    } catch (e) {
      // The server names WHICH input it refused (a missing scenario, no rate sheet,
      // an unpriceable deal) — show that, not a generic failure.
      setError(e.message || 'That scenario could not be priced.');
      setResult(null);
    } finally { setBusy(false); }
  }, [buildBody]);

  const onSubmit = (e) => { e.preventDefault(); price(); };

  const b = result;
  const stackRows = useMemo(() => (b && Array.isArray(b.adjustments) ? b.adjustments : []), [b]);

  return (
    <LtLayout title="Pricing transparency">
      <div style={card}>
        <h2 style={h2}>See a price the way Lender Price shows it</h2>
        <p style={sub}>
          Enter one deal and a rate-sheet version, and this lays the price out in full — the base price,
          every LLPA and adjustment with its running effect, the margin, and the final price. Lender Price
          stays the source of truth; our engine reconstructs the same stack beside it so nothing is hidden.
        </p>

        <form onSubmit={onSubmit}>
          <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap', alignItems: 'flex-end', marginBottom: 12 }}>
            <Field label="Rate-sheet version" hint="the priced sheet to break down">
              <input className="input" style={{ width: 220 }} value={form.rateSheetVersionId} onChange={set('rateSheetVersionId')} placeholder="version id" />
            </Field>
            {investors && investors.investors && investors.investors.length > 0 && (
              <Field label="Investor" hint="optional filter">
                <select className="input" style={{ minWidth: 160 }} value={form.investor} onChange={set('investor')}>
                  <option value="">Any</option>
                  {investors.investors.map((i) => <option key={i.id} value={i.code}>{i.name || i.code}</option>)}
                </select>
              </Field>
            )}
            <Field label="Show" hint="which engine's stack">
              <select className="input" style={{ minWidth: 150 }} value={form.source} onChange={set('source')}>
                <option value="">Our reconstruction</option>
                <option value="lp">Lender Price sheet</option>
              </select>
            </Field>
            <Field label="Feature rate" hint="coupon to break down">
              <input className="input" style={{ width: 110 }} value={form.rate} onChange={set('rate')} placeholder="e.g. 7.5" inputMode="decimal" />
            </Field>
          </div>

          <div style={{ ...eyebrow, marginBottom: 6 }}>The deal</div>
          <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap', alignItems: 'flex-end', marginBottom: 4 }}>
            <Field label="FICO"><input className="input" style={{ width: 90 }} value={form.fico} onChange={set('fico')} inputMode="numeric" /></Field>
            <Field label="LTV" hint="milli-% (72500 = 72.5%)"><input className="input" style={{ width: 120 }} value={form.ltv} onChange={set('ltv')} inputMode="numeric" /></Field>
            <Field label="DSCR" hint="milli (1200 = 1.20)"><input className="input" style={{ width: 110 }} value={form.dscr} onChange={set('dscr')} inputMode="numeric" /></Field>
            <Field label="Loan amount"><input className="input" style={{ width: 130 }} value={form.loan_amount} onChange={set('loan_amount')} inputMode="numeric" /></Field>
            <Field label="Purpose"><input className="input" style={{ width: 130 }} value={form.purpose} onChange={set('purpose')} placeholder="purchase" /></Field>
            <Field label="Occupancy"><input className="input" style={{ width: 130 }} value={form.occupancy} onChange={set('occupancy')} /></Field>
            <Field label="Property type"><input className="input" style={{ width: 140 }} value={form.property_type} onChange={set('property_type')} /></Field>
          </div>

          <div style={{ marginTop: 14, display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
            <button className="btn" type="submit" disabled={busy}>{busy ? 'Pricing…' : 'Break down the price'}</button>
            <span style={{ fontSize: 12, color: MUTED }}>Values are in the engine's own integer units.</span>
          </div>
          {/*
            THE READ SAYS IT IS A READ. `/ppe/breakdown` prices our engine against a stored
            rate sheet and calls nobody; the shadow comparison below it calls Lender Price and
            writes to the findings ledger. Two buttons that cost wildly different things must
            not read the same, which is exactly why the shadow was NOT folded in here — a tap
            on a ladder row re-posts this form, and nobody taps a rate meaning "spend a vendor
            call and file a finding".
          */}
          <p style={{ margin: '8px 0 0', fontSize: 12, color: MUTED }}>
            This breaks the price down from a stored rate sheet. It does not call Lender Price and it
            records nothing.
          </p>
        </form>

        {error && (
          <div style={{ marginTop: 12, padding: '10px 12px', borderRadius: 10, background: 'rgba(158,58,58,.06)', border: '1px solid rgba(158,58,58,.28)', color: RED, fontSize: 13 }}>
            {error}
          </div>
        )}
      </div>

      {/*
        The one control on the whole front end that reaches `POST /ppe/quote` — and therefore
        the only automatic producer of the findings ledger and the parity-cell series. It reuses
        THIS form's scenario (`buildBody`) so the deal broken down above and the deal measured
        against Lender Price are the same deal, rather than two forms that drift apart.
      */}
      <LtShadowCompare buildBody={buildBody} />

      {b && (
        <>
          {/* headline: base → final */}
          <div style={card}>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', marginBottom: 12 }}>
              {b.rate != null && <Pill tone="flat">Coupon {fmtRate(b.rate)}</Pill>}
              <Pill tone={b.source === 'lp' ? 'warn' : 'flat'}>{b.source === 'lp' ? 'Lender Price sheet' : 'Our reconstruction'}</Pill>
              {b.eligible === true && <Pill tone="good">Eligible</Pill>}
              {b.eligible === false && <Pill tone="bad">Ineligible</Pill>}
              {b.program && b.program.name && <span style={{ fontSize: 13, color: MUTED }}>{b.program.name}</span>}
            </div>

            {b.final_price != null ? (
              <PriceHeadline b={b} />
            ) : (
              <p style={{ ...sub, marginBottom: 0 }}>{b.note || 'No price to break down.'}</p>
            )}
          </div>

          {/* the waterfall */}
          {b.final_price != null && (
            <div style={card}>
              <h2 style={h2}>Every adjustment, in order</h2>
              <p style={sub}>
                A positive figure is a <strong style={{ color: RED }}>cost</strong> the borrower pays — it lowers the price;
                a negative figure is a <strong style={{ color: TEAL }}>credit</strong> — it raises it. The rightmost column
                is the price after each line, ending on the final price.
              </p>
              <div style={{ overflowX: 'auto' }}>
                <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 440 }}>
                  <thead>
                    <tr>
                      <th style={{ ...eyebrow, textAlign: 'left', padding: '0 12px 8px 0' }}>Adjustment</th>
                      <th style={{ ...eyebrow, textAlign: 'right', padding: '0 12px 8px' }}>Points</th>
                      <th style={{ ...eyebrow, textAlign: 'right', padding: '0 0 8px 12px' }}>Running price</th>
                    </tr>
                  </thead>
                  <tbody>
                    <StackRow label="Base price" dimension="grid" pointsMilli={null} runningPrice={b.base_price} bold />
                    {stackRows.map((l, i) => (
                      <StackRow
                        key={i}
                        label={l.label}
                        dimension={DIM_LABEL(l.dimension)}
                        pointsMilli={l.points_milli}
                        costPositive={l.cost_positive}
                        runningPrice={l.running_price_milli}
                      />
                    ))}
                    <StackRow label="Final price" dimension="" pointsMilli={null} runningPrice={b.final_price} bold />
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {/* eligibility reasons */}
          {b.eligibility && Array.isArray(b.eligibility.reasons) && b.eligibility.reasons.length > 0 && (
            <div style={{ ...card, borderColor: 'rgba(158,58,58,.30)' }}>
              <h2 style={h2}>Why our engine would decline this</h2>
              <ul style={{ margin: '6px 0 0', paddingLeft: 18, fontSize: 13.5, color: SLATE, lineHeight: 1.6 }}>
                {b.eligibility.reasons.map((r, i) => <li key={i}>{String(r)}</li>)}
              </ul>
            </div>
          )}

          {/* LP disqualifications */}
          {Array.isArray(b.disqualify_reasons) && b.disqualify_reasons.length > 0 && (
            <div style={{ ...card, borderColor: 'rgba(174,135,70,.34)' }}>
              <h2 style={h2}>Lender Price's own disqualifications</h2>
              <p style={sub}>What Lender Price declined for this deal, verbatim.</p>
              {b.disqualify_reasons.map((d, i) => (
                <div key={i} style={{ display: 'flex', gap: 10, alignItems: 'baseline', flexWrap: 'wrap', borderTop: i ? `1px solid ${LINE}` : 'none', padding: '8px 0' }}>
                  <span style={{ fontSize: 13.5, color: INK, fontWeight: 600 }}>{d.label || d.rule}</span>
                  {d.program && <Pill tone="flat">{d.program}</Pill>}
                  {(d.investor || d.lender) && <span style={{ fontSize: 12, color: MUTED }}>{d.investor || d.lender}</span>}
                </div>
              ))}
            </div>
          )}

          {/* the coupon ladder */}
          {Array.isArray(b.ladder) && b.ladder.length > 0 && (
            <div style={card}>
              <h2 style={h2}>The rate ladder</h2>
              <p style={sub}>Pay points for a lower rate, take a credit for a higher one. Tap a rate to break it down.</p>
              <div style={{ overflowX: 'auto' }}>
                <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 360 }}>
                  <thead>
                    <tr>
                      <th style={{ ...eyebrow, textAlign: 'left', padding: '0 12px 8px 0' }}>Rate</th>
                      <th style={{ ...eyebrow, textAlign: 'right', padding: '0 12px 8px' }}>Base</th>
                      <th style={{ ...eyebrow, textAlign: 'right', padding: '0 12px 8px' }}>Final price</th>
                      <th style={{ ...eyebrow, textAlign: 'right', padding: '0 0 8px 12px' }}>Points</th>
                    </tr>
                  </thead>
                  <tbody>
                    {b.ladder.map((r, i) => (
                      <tr
                        key={i}
                        onClick={() => r.rate != null && price(r.rate)}
                        style={{
                          borderTop: `1px solid ${LINE}`, cursor: r.rate != null ? 'pointer' : 'default',
                          background: r.featured ? 'rgba(174,135,70,.08)' : 'transparent',
                        }}
                      >
                        <td style={{ padding: '9px 12px 9px 0', fontSize: 13.5, color: INK, fontWeight: r.featured ? 700 : 500 }}>
                          {fmtRate(r.rate)} {r.featured && <span style={{ color: GOLD_INK, fontSize: 11, fontWeight: 700 }}>· shown</span>}
                        </td>
                        <td style={{ ...numFont, padding: '9px 12px', textAlign: 'right', fontSize: 13, color: SLATE }}>{fmtPrice(r.base_price)}</td>
                        <td style={{ ...numFont, padding: '9px 12px', textAlign: 'right', fontSize: 13.5, color: INK, fontWeight: 600 }}>{fmtPrice(r.final_price)}</td>
                        <td style={{ ...numFont, padding: '9px 0 9px 12px', textAlign: 'right', fontSize: 13, color: r.final_points > 0 ? RED : TEAL }}>{fmtPts(r.final_points)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </>
      )}

      <p style={{ fontSize: 12, color: MUTED, marginTop: 4 }}>
        Every number here is broken down by the server's read-model
        (<code>src/longterm/ppe/pricing-breakdown.js</code>) — this page computes nothing, so it can never
        disagree with the engine about the same price.
      </p>
    </LtLayout>
  );
}
