import React from 'react';

/* Staff "cockpit" band at the top of a loan file — the facts an officer wants
   without scrolling: borrower/entity, property, program, the registered terms
   (loan amount + note rate synced from product registration), the deal
   economics, and clear-to-close readiness. Read-only; defensive against any
   missing field. Ratios are simple display ratios of stored values, not the
   frozen pricing engine. */

const money = (n) => n == null || n === '' ? '—' : '$' + Math.round(Number(n)).toLocaleString('en-US');
// Exact cents for liquidity so V1 matches V2 and the term sheet to the penny
// (audit 2026-07-19). Whole-dollar money() stays on the floored loan amount.
const money2 = (n) => (n == null || n === '') ? '—' : '$' + Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const pctOf = (num, den) => (Number(num) > 0 && Number(den) > 0) ? (Number(num) / Number(den) * 100).toFixed(1) + '%' : null;
const pct = (n) => Number(n) > 0 ? (Number(n) * 100).toFixed(1) + '%' : null;
const addrLine = (a) => !a ? '—' : (a.oneLine || [a.line1 || a.street, a.city, a.state, a.zip].filter(Boolean).join(', ') || '—');

export default function DealSnapshot({ app, gating }) {
  if (!app) return null;
  const purchase = app.is_assignment && app.underlying_contract_price != null
    ? Number(app.underlying_contract_price) + Number(app.assignment_fee || 0)
    : app.purchase_price;
  const basis = (Number(purchase) || 0) + (Number(app.rehab_budget) || 0);
  const quote = app.registered_quote || null;
  // Fallback ratios (no registered quote) use simple display math on raw columns —
  // a different basis than the engine's; mark them approximate (owner audit 2026-07-17).
  const approx = (v) => (v ? '\u2248 ' + v : v);
  const ltc = quote?.sizing?.ltcPct ? pct(quote.sizing.ltcPct) : approx(pctOf(app.loan_amount, basis));
  const arvLtv = quote?.sizing?.arvPct ? pct(quote.sizing.arvPct) : approx(pctOf(app.loan_amount, app.arv));
  const acqLtv = quote?.sizing?.acqLtvPct ? pct(quote.sizing.acqLtvPct) : null;
  const product = app.registered_product_label || (quote && [quote.programLabel, quote.productLabel].filter(Boolean).join(' · '));
  const priced = app.loan_amount != null && Number(app.loan_amount) > 0;
  // The registered loan amount + leverage ratios are "as last registered" once any
  // deal number moves before a re-price (audit 2026-07-19) — flag them so they don't
  // read as live figures next to the freshly-edited economics beside them.
  const stale = !!app.pricing_stale && priced;
  const g = gating && gating.clear_to_close;

  const cell = (k, v) => <div className="snap-cell"><span className="snap-k">{k}</span><span className="snap-v">{v}</span></div>;

  return (
    <div className="deal-snap">
      <div className="snap-terms">
        <div className="snap-term">
          <span className="snap-k">Loan amount</span>
          <span className="snap-term-v">{priced ? money(app.loan_amount) : 'Not yet priced'}</span>
          {stale && <span className="snap-k" style={{ color: 'var(--warning)', marginTop: 2 }}>as last registered</span>}
        </div>
        <div className="snap-term">
          <span className="snap-k">Note rate</span>
          <span className="snap-term-v gold">{app.rate_pct != null ? Number(app.rate_pct).toFixed(2) + '%' : '—'}</span>
        </div>
        {g && (
          <div className="snap-term">
            <span className="snap-k">Clear to close</span>
            <span className={`ts-badge ${g.ready ? 'ok' : 'warn'}`} style={{ alignSelf: 'flex-start', marginTop: 4 }}>
              {g.ready ? 'Ready' : `${(g.conditions ? g.conditions.length : 0) + (g.gates ? g.gates.length : 0)} to clear`}
            </span>
          </div>
        )}
      </div>
      {stale && <div style={{ fontSize: '.82em', color: 'var(--warning)', margin: '2px 2px 8px', lineHeight: 1.3 }}>A deal number changed since this product was registered — the loan amount and the leverage ratios (LTC / Initial LTV / Loan-to-ARV) below are as last registered. Re-price the product to update them.</div>}
      <div className="snap-grid">
        {cell('Borrower', [app.first_name, app.last_name].filter(Boolean).join(' ') || '—')}
        {app.co_borrower_id && cell('Co-borrower', [app.co_first_name, app.co_last_name].filter(Boolean).join(' ') || '—')}
        {cell('Entity', app.entity_name || '—')}
        {cell('Property', addrLine(app.property_address))}
        {cell('Type', [app.property_type, app.units ? `${app.units}u` : null].filter(Boolean).join(' · ') || '—')}
        {cell('Program', app.program || '—')}
        {cell('Registered product', product || '—')}
        {cell('Loan type', [app.loan_type, app.is_assignment ? 'assignment' : null].filter(Boolean).join(' · ') || '—')}
        {cell('Purchase', money(purchase))}
        {cell('ARV', money(app.arv))}
        {cell('Rehab', money(app.rehab_budget))}
        {cell('LTC', ltc || '—')}
        {cell('Initial LTV', acqLtv || '—')}
        {cell('Loan-to-ARV', arvLtv || '—')}
        {quote && quote.liquidity != null ? cell('Liquidity required', money2(quote.liquidity)) : null}
        {cell('FICO', app.fico || '—')}
      </div>
    </div>
  );
}
