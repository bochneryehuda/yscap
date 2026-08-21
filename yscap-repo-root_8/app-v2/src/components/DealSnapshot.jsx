import React from 'react';
import { fullNameOf } from '../lib/personName.js';
import { dealPurchase } from '../lib/dealPrice.js';
import { revealAnchor } from './FileSections.jsx';
import { dealBasis, seasoningText } from '../lib/dealBasis.js';
import { fmtRatePctFromPct } from '../lib/rateFormat.js';
import BorrowerProfileLink from './BorrowerProfileLink.jsx';

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
  // The REAL total paid (seller's contract + the FULL fee on an assignment) —
  // the one shared derivation, so this and the closing desk can never disagree.
  const purchase = dealPurchase(app).total;
  // Which figure this deal is sized on — the as-is value on a refinance, the
  // purchase price on a purchase. One shared reading with the server + engine.
  const basisOf = dealBasis(app);
  /* The fallback LTC denominator follows the frozen engine's cost basis: the
     acquisition figure is the LOWER of the sizing basis and the as-is value
     (owner-directed 2026-08-05 — "when the as-is value is below the purchase price,
     the cost, and the LTC, go by the as-is value"), and on a refinance that basis is
     the as-is value, not `price + rehab`. Getting this wrong divided the ratio by a
     number the engine never used (an inflated price, or on a refinance usually
     0 + rehab, which read absurdly high). A registered quote still wins — its
     `sizing.ltcPct` is the engine's own — so this only corrects the estimate.
     basisOf.basis / basisOf.asIsValue are ALREADY numeric (dealBasis runs them
     through its own money parser), so there is no bare Number() on a money field. */
  const sizedBasis = basisOf.basis || 0;
  const asIsBasis = basisOf.asIsValue || 0;
  const costAcq = (sizedBasis > 0 && asIsBasis > 0) ? Math.min(sizedBasis, asIsBasis) : (sizedBasis || asIsBasis);
  const basis = costAcq + (Number(app.rehab_budget) || 0);
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
  // deal number moves before a re-price (audit 2026-07-19). Flag them so they don't
  // read as live figures next to the freshly-edited economics right beside them.
  const stale = !!app.pricing_stale && priced;
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

  const coName = app.co_borrower_id ? (fullNameOf(app, 'co_') || '—') : null;

  return (
    <div className="deal-snap">
      {/* Hero — the three headline terms, big and unmistakable. */}
      <div className="snap-hero">
        <div className="snap-stat">
          <span className="snap-stat-k">Loan amount</span>
          <span className="snap-stat-v">{priced ? money(app.loan_amount) : 'Not yet priced'}</span>
          {stale && <span className="snap-stat-sub" style={{ color: 'var(--warning)' }}>as last registered</span>}
        </div>
        <div className="snap-stat">
          <span className="snap-stat-k">Note rate</span>
          <span className="snap-stat-v gold">{app.rate_pct != null ? fmtRatePctFromPct(app.rate_pct) + '%' : '—'}</span>
        </div>
        {g && (
          // Clickable (owner-directed): the count jumps to the "What's left to
          // clear to close" list, which explains each item and links to the
          // section that fixes it. Not-ready shows the count; ready shows "Ready".
          <button type="button" className="snap-stat snap-stat-btn"
            title={g.ready ? 'All prerequisites met — see the checklist' : `${openCount} item(s) to clear — click to see exactly what's left and jump to each`}
            onClick={() => revealAnchor('ctc-outstanding')}>
            <span className="snap-stat-k">Clear to close</span>
            <span className="snap-stat-v" style={{ color: g.ready ? 'var(--ok)' : 'var(--warning)' }}>
              {g.ready ? 'Ready' : openCount}
            </span>
            <span className="snap-stat-sub">{g.ready ? 'view checklist →' : 'to clear — see what’s left →'}</span>
          </button>
        )}
      </div>

      {/* Facts, grouped into labeled clusters of roomy, readable rows. */}
      <div className="snap-clusters">
        <div className="snap-cluster">
          <div className="snap-cluster-h">Parties</div>
          {/* THE NAME IS THE WAY INTO THE PERSON (owner-directed 2026-08-21 — "in the
              file, you should be able to access it directly somehow and open up the
              borrower's profile on a full page"). It is here, on the overview, because
              this is where you are standing when you want it; the profile panel's own
              button is two collapsed sections down, which is why it did not count as
              "anywhere to access the borrower profile". Both go through the ONE
              definition in BorrowerProfileLink, so they can never land differently, and
              both carry this file so the trip back exists. With no borrower id the name
              renders as plain text — never a link to nowhere. */}
          {row('Borrower', (
            <BorrowerProfileLink borrowerId={app.borrower_id} fromAppId={app.id}>
              {fullNameOf(app) || '—'}
            </BorrowerProfileLink>
          ), { strong: true })}
          {row('Co-borrower', app.co_borrower_id
            ? <BorrowerProfileLink borrowerId={app.co_borrower_id} fromAppId={app.id}>{coName}</BorrowerProfileLink>
            : coName)}
          {/* The entity WITH its verification state (owner-directed 2026-08-02:
              entity belongs in this first block, and the old "Entity, team &
              assignment" panel it came from is now team-only). Whether the entity
              is verified is the part anyone actually acts on, so it travelled with
              the row rather than being left behind. On an individual-vested file
              this says so plainly instead of reading as a missing entity. */}
          {app.personal_name_purchase && !app.llc_id
            ? row('Vesting', <span>Closing as an individual <span className="ts-badge" style={{ marginLeft: 6 }}>no entity</span></span>)
            : row('Entity', (
              <span>
                {app.entity_name || (app.llc_id ? 'LLC on file' : '—')}
                {app.llc_id && (app.entity_verified
                  ? <span className="ts-badge ok" style={{ marginLeft: 6 }}>Verified ✓</span>
                  : <span className="ts-badge warn" style={{ marginLeft: 6 }}>Unverified</span>)}
              </span>
            ))}
          {/* FICO that prices the deal: the borrower's imported credit-report middle
              score, and the HIGHER of the two on a co-borrower file (owner-directed
              2026-08-05). A credit import writes each borrower's middle score to their
              fico, so this reads the real score, not the estimate. */}
          {row('FICO', (() => {
            const p = Number(app.fico) || 0;
            const c = Number(app.co_fico) || 0;
            const hi = Math.max(p, c);
            if (!hi) return '—';
            return (app.co_borrower_id && p && c && p !== c) ? `${hi} (higher of ${p} / ${c})` : String(hi);
          })())}
          {/* The note buyer at a glance (owner-directed 2026-07-27) — it used to be
              readable only inside the ClickUp panel, so an officer couldn't tell who is
              buying the loan without hunting for it. STAFF-ONLY: this component renders
              on the staff file view only, never the borrower's. Changed in the Note
              buyer panel below, not here. */}
          {row('Note buyer', app.lender || 'Not set')}
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
          {/* THE FIGURE THE LOAN IS SIZED ON, NAMED CORRECTLY (owner-directed
              2026-08-02). A refinance is sized on the AS-IS VALUE, so a row
              labelled "Purchase" is either blank or a leftover — which is exactly
              what the owner saw on a cash-out file. `dealBasis` is the one shared
              reading (it mirrors the server's, which is the frozen engine's own
              test), so this band can never disagree with what was priced. */}
          {basisOf.sizedOnAsIs
            ? <>
              {row('As-is value', money(basisOf.basis))}
              {row('Owned', seasoningText(app.acquisition_date))}
              {row('Original price', money(app.original_purchase_price))}
              {row('Payoff', money(app.payoff_amount))}
            </>
            : row('Purchase', money(purchase))}
          {row('ARV', money(app.arv))}
          {row('Rehab', money(app.rehab_budget))}
          {/* The SCOPE next to its cost — registering a product now writes the
              studio's rehab scope onto the file, so this stops reading blank on
              a priced file (owner-reported 2026-07-27). Dropped entirely on a
              deal with no rehab (bridge), where there is no scope to show. */}
          {row('Rehab type', app.rehab_type || (Number(app.rehab_budget) > 0 ? '—' : null))}
          {row('Liquidity required', quote && quote.liquidity != null ? money2(quote.liquidity) : null)}
          {/* ASSIGNMENT DETAILS (owner-directed 2026-08-02) — moved out of the old
              "Entity, team & assignment" panel into the block that already owns the
              deal's economics. Only on an assignment; an ordinary purchase renders
              nothing extra. The REAL total the borrower pays is what "Purchase"
              above shows; these are the two parts it is made of. */}
          {app.is_assignment && row('Underlying price', money(app.underlying_contract_price))}
          {app.is_assignment && row('Assignment fee', money(app.assignment_fee))}
        </div>

        <div className="snap-cluster">
          <div className="snap-cluster-h">Leverage{stale && <span style={{ color: 'var(--warning)', fontWeight: 400, textTransform: 'none', letterSpacing: 0 }}> · as last registered</span>}</div>
          {stale && <div style={{ fontSize: '.8em', color: 'var(--warning)', margin: '2px 0 6px', lineHeight: 1.3 }}>
            {app.pricing_stale_reason
              ? <><strong>Re-register needed:</strong> {app.pricing_stale_reason.replace(/^\[auto\]\s*/, '')}</>
              : 'A pricing detail changed since this product was registered — the loan amount and these ratios are as last registered. Re-price the product to update them.'}
          </div>}
          {row('LTC', ltc || '—')}
          {row('Initial LTV', acqLtv || '—')}
          {row('Loan-to-ARV', arvLtv || '—')}
        </div>
      </div>
    </div>
  );
}
