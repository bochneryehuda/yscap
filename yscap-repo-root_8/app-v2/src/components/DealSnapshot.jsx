import React from 'react';

/* Staff "cockpit" band at the top of a loan file — the facts an officer wants
   without scrolling: borrower/entity, property, program, the registered terms
   (loan amount + note rate synced from product registration), the deal
   economics, and clear-to-close readiness. Read-only; defensive against any
   missing field. Ratios are simple display ratios of stored values, not the
   frozen pricing engine.

   Redesigned 2026-07-15 (#65) to restore the "bigger and clearer" V1 read while
   staying in the V2/PILOT white-first design language: a prominent hero band for
   the three headline terms, then the facts grouped into labeled clusters
   (Parties · Property · Economics · Leverage) of roomy label-left / value-right
   rows instead of one dense grid of tiny stacked cells. Same data, same logic. */

const money = (n) => n == null || n === '' ? '—' : '$' + Math.round(Number(n)).toLocaleString('en-US');
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
  const ltc = quote?.sizing?.ltcPct ? pct(quote.sizing.ltcPct) : pctOf(app.loan_amount, basis);
  const arvLtv = quote?.sizing?.arvPct ? pct(quote.sizing.arvPct) : pctOf(app.loan_amount, app.arv);
  const acqLtv = quote?.sizing?.acqLtvPct ? pct(quote.sizing.acqLtvPct) : null;
  const product = app.registered_product_label || (quote && [quote.programLabel, quote.productLabel].filter(Boolean).join(' · '));
  const priced = app.loan_amount != null && Number(app.loan_amount) > 0;
  const g = gating && gating.clear_to_close;
  const openCount = g ? ((g.conditions ? g.conditions.length : 0) + (g.gates ? g.gates.length : 0)) : 0;

  // One clear label-left / value-right row. `v == null` drops the row entirely,
  // so optional facts (co-borrower, liquidity) simply don't appear.
  const row = (k, v, opts) => (v == null ? null : (
    <div className="snap-row" key={k}>
      <span className="snap-rk">{k}</span>
      <span className={`snap-rv${opts && opts.strong ? ' strong' : ''}`}>{v}</span>
    </div>
  ));

  const coName = app.co_borrower_id ? ([app.co_first_name, app.co_last_name].filter(Boolean).join(' ') || '—') : null;

  return (
    <div className="deal-snap">
      {/* Hero — the three headline terms, big and unmistakable. */}
      <div className="snap-hero">
        <div className="snap-stat">
          <span className="snap-stat-k">Loan amount</span>
          <span className="snap-stat-v">{priced ? money(app.loan_amount) : 'Not yet priced'}</span>
        </div>
        <div className="snap-stat">
          <span className="snap-stat-k">Note rate</span>
          <span className="snap-stat-v gold">{app.rate_pct != null ? Number(app.rate_pct).toFixed(2) + '%' : '—'}</span>
        </div>
        {g && (
          <div className="snap-stat">
            <span className="snap-stat-k">Clear to close</span>
            <span className="snap-stat-v" style={{ color: g.ready ? 'var(--ok)' : 'var(--warning)' }}>
              {g.ready ? 'Ready' : openCount}
            </span>
            {!g.ready && <span className="snap-stat-sub">to clear</span>}
          </div>
        )}
      </div>

      {/* Facts, grouped into labeled clusters of roomy, readable rows. */}
      <div className="snap-clusters">
        <div className="snap-cluster">
          <div className="snap-cluster-h">Parties</div>
          {row('Borrower', [app.first_name, app.last_name].filter(Boolean).join(' ') || '—', { strong: true })}
          {row('Co-borrower', coName)}
          {row('Entity', app.entity_name || '—')}
          {row('FICO', app.fico || '—')}
        </div>

        <div className="snap-cluster">
          <div className="snap-cluster-h">Property</div>
          {row('Address', addrLine(app.property_address), { strong: true })}
          {row('Type', [app.property_type, app.units ? `${app.units}u` : null].filter(Boolean).join(' · ') || '—')}
          {row('Program', app.program || '—')}
          {row('Registered product', product || '—')}
          {row('Loan type', [app.loan_type, app.is_assignment ? 'assignment' : null].filter(Boolean).join(' · ') || '—')}
        </div>

        <div className="snap-cluster">
          <div className="snap-cluster-h">Economics</div>
          {row('Purchase', money(purchase))}
          {row('ARV', money(app.arv))}
          {row('Rehab', money(app.rehab_budget))}
          {row('Liquidity required', quote && quote.liquidity != null ? money2(quote.liquidity) : null)}
        </div>

        <div className="snap-cluster">
          <div className="snap-cluster-h">Leverage</div>
          {row('LTC', ltc || '—')}
          {row('Initial LTV', acqLtv || '—')}
          {row('Loan-to-ARV', arvLtv || '—')}
        </div>
      </div>
    </div>
  );
}
