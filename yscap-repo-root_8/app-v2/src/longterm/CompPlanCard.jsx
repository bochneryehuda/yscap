// LT PPE — who makes what on a file (D18 / E9).
//
// THE OWNER'S TWO SENTENCES THIS SCREEN EXISTS FOR: "Company default: the minimum is not enforced.
// It's not a hard rule. It's a movable default, and every loan officer can set this movable default
// differently. The split does not apply for the margin. The entire margin hold back goes for the
// company."
//
// WHAT IT REFUSES TO DO:
//   1. IT NEVER SHOWS A NUMBER WHOSE BASIS IS UNSETTLED. When a per-loan minimum or maximum moves an
//      officer who earns on BOTH sides, nobody has yet said whether the change comes out of the
//      origination or the rebate — so the total is shown and the two halves are not. An invented
//      figure here is somebody's own pay.
//   2. IT NEVER IMPLIES A PRICE MOVED. Nothing in this stack changes a quote, and the card says so.
//   3. IT NEVER OFFERS TO EDIT A NUMBER HERE. Compensation figures are settings, and they go through
//      the audited settings door above — which is what records who changed a person's pay and when.
//
// Dark text on the white PILOT canvas throughout — never an `--ink*` token (a LIGHT paper colour in
// this palette, which renders white-on-white).

import React, { useCallback, useEffect, useState } from 'react';
import { ltApi } from './api.js';
import { INK, MUTED, SLATE, DANGER, CAUTION, card, h2, sub, eyebrow, input, label } from './ppeStyles.js';

const money = (cents) => (cents == null ? '—' : `$${(cents / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`);
const points = (milli) => (milli == null ? '—' : (milli / 1000).toFixed(3));

const FROM = {
  officer: 'their own',
  derived_from_how_they_are_paid: 'from how they are paid',
  company: 'the company',
  product_default: 'the shipped default',
  requested: 'what you asked for',
};

function Line({ what, value, from, note }) {
  return (
    <div style={{ display: 'flex', gap: 10, alignItems: 'baseline', padding: '3px 0', flexWrap: 'wrap' }}>
      <span style={{ fontSize: 13, color: SLATE, minWidth: 220 }}>{what}</span>
      <strong style={{ fontSize: 13, color: INK }}>{value}</strong>
      {from && <span style={{ fontSize: 12, color: MUTED }}>({FROM[from] || from})</span>}
      {note && <span style={{ fontSize: 12, color: MUTED }}>{note}</span>}
    </div>
  );
}

export default function CompPlanCard({ officers = [] }) {
  const [officerId, setOfficerId] = useState('');
  const [amount, setAmount] = useState('100000');
  const [mode, setMode] = useState('');
  const [data, setData] = useState(null);
  const [error, setError] = useState('');

  const load = useCallback(() => {
    setError(''); setData(null);
    if (!officerId) return;
    const dollars = Number(String(amount).replace(/[^0-9.]/g, ''));
    const cents = Number.isFinite(dollars) && dollars > 0 ? Math.round(dollars * 100) : 0;
    ltApi.ppeCompPlan({ officerId, loanAmountCents: cents || undefined, mode: mode || undefined })
      .then(setData)
      .catch((e) => setError(e.message || 'That could not be read.'));
  }, [officerId, amount, mode]);
  useEffect(() => { load(); }, [load]);

  const b = data && data.breakdown;

  return (
    <div style={card}>
      <h2 style={h2}>Who makes what on a file</h2>
      <p style={sub}>
        The company keeps its holdback in full — it is never split with the officer and never counted
        toward what they must make on a loan. The officer earns their own margin, either as an
        origination charge to the borrower or as a rebate in the back, and the company takes its share
        of the origination. The least and the most an officer makes on a loan are <strong>movable
        defaults</strong>, not limits: an officer may set their own, higher or lower. None of this
        changes a quoted price.
      </p>

      <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap', alignItems: 'flex-end', marginBottom: 12 }}>
        <div style={{ minWidth: 240, flex: '0 1 300px' }}>
          <span style={label}>Which loan officer</span>
          <select style={input} value={officerId} onChange={(e) => setOfficerId(e.target.value)}>
            <option value="">Pick a loan officer…</option>
            {officers.map((o) => <option key={o.id} value={o.id}>{o.name || o.email}</option>)}
          </select>
        </div>
        <div style={{ minWidth: 160, flex: '0 1 200px' }}>
          <span style={label}>On a loan of</span>
          <input style={input} value={amount} onChange={(e) => setAmount(e.target.value)} inputMode="decimal" />
        </div>
        <div style={{ minWidth: 200, flex: '0 1 240px' }}>
          <span style={label}>Paid by</span>
          <select style={input} value={mode} onChange={(e) => setMode(e.target.value)}>
            <option value="">However they are set up</option>
            <option value="borrower_paid">The borrower (origination)</option>
            <option value="lender_paid">The lender (rebate)</option>
          </select>
        </div>
      </div>

      {/* Nobody linked yet is a real state with a real next step, and it is said rather than shown as
          an empty picker. */}
      {officers.length === 0 && (
        <p style={{ fontSize: 13, color: CAUTION }}>
          No loan officer is linked to one of our staff records yet, so there is nobody to show. Link
          somebody on the People screen first.
        </p>
      )}
      {error && <p style={{ fontSize: 13, color: DANGER }}>{error}</p>}

      {data && (
        <div>
          <div style={{ ...eyebrow, marginBottom: 6 }}>How they are set up</div>
          <Line what="The company keeps (holdback)" value={`${points(data.plan.companyHoldbackMilli)} points`} from={data.sources.companyHoldbackMilli} note="never theirs, never split" />
          <Line what="The officer earns" value={`${points(data.plan.officerMarginMilli)} points`} from={data.sources.officerMarginMilli} />
          <Line what="…as origination" value={data.plan.officerFrontMilli == null ? 'however they are paid' : `${points(data.plan.officerFrontMilli)} points`} from={data.sources.officerFrontMilli} />
          <Line what="…as a rebate" value={data.plan.officerBackMilli == null ? 'however they are paid' : `${points(data.plan.officerBackMilli)} points`} from={data.sources.officerBackMilli} />
          <Line what="Least on a loan" value={data.plan.minCents == null ? 'no minimum' : money(data.plan.minCents)} from={data.sources.minCents} note="a movable default, not a floor" />
          <Line what="Most on a loan" value={data.plan.maxCents == null ? 'no maximum' : money(data.plan.maxCents)} from={data.sources.maxCents} />
          <Line what="Their share of the origination" value={data.plan.splitPct == null ? 'nobody has set it' : `${data.plan.splitPct}%`} from={data.sources.splitPct} />
          <Line what="Paid by" value={data.plan.mode === 'lender_paid' ? 'the lender (rebate)' : 'the borrower (origination)'} from={data.sources.mode} />

          {b && b.ok === false && (
            <div style={{ marginTop: 12 }}>
              <div style={{ ...eyebrow, marginBottom: 6 }}>Not worked out on this loan</div>
              {b.refusals.map((r) => (
                <p key={r.code} style={{ margin: '4px 0', fontSize: 13, color: CAUTION }}>{r.message}</p>
              ))}
            </div>
          )}

          {b && b.ok && (
            <div style={{ marginTop: 12 }}>
              <div style={{ ...eyebrow, marginBottom: 6 }}>On {money(b.loanAmountCents)}</div>
              <Line what="The officer earns" value={money(b.officer.grossCents)} note={b.clamp.applied ? `the ${b.clamp.applied} moved this` : null} />
              <Line what="…they keep" value={money(b.officer.netCents)} />
              <Line what="The company's share of the origination" value={money(b.company.shareOfCompCents)} />
              <Line what="The company's holdback" value={money(b.holdback.cents)} note="in full" />
              <Line what="The company makes" value={money(b.company.totalCents)} />
              {b.unsettled.map((u) => (
                <p key={u.code} style={{ margin: '6px 0 0', fontSize: 13, color: CAUTION }}>{u.message}</p>
              ))}
            </div>
          )}

          <p style={{ margin: '10px 0 0', fontSize: 12, color: MUTED }}>
            {data.priceEffect.reason} To change one of these numbers, pick this officer in
            &ldquo;Whose settings&rdquo; above — every change is recorded with who made it.
          </p>
        </div>
      )}
    </div>
  );
}
