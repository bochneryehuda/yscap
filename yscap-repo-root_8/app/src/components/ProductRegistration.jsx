import React, { useEffect, useRef, useState } from 'react';
import { api } from '../lib/api.js';
import { MoneyInput } from './FormattedInputs.jsx';

/* Product Registration / term sheet, computed on the server from the FROZEN
   pricing engines (Standard Program = YSP, Gold Standard Program = GSP). Staff
   price a file, trade leverage on the Standard ladder, and register the product
   — which becomes the file's official terms (loan amount + note rate). The
   note-buyer's real program name is never surfaced: borrower-safe labels only. */

const money = (n) => n == null ? '—' : '$' + Math.round(Number(n)).toLocaleString('en-US');
const pct = (f, d = 2) => f == null ? '—' : (Number(f) * 100).toFixed(d) + '%';
const STRATEGIES = [
  { v: 'Fix & Flip', label: 'Fix & Flip' },
  { v: 'Fix & Hold', label: 'Fix & Hold' },
  { v: 'Ground-Up Construction', label: 'Ground-Up' },
  { v: 'Bridge', label: 'Bridge' },
];

function StatusBadge({ status }) {
  const cls = status === 'ELIGIBLE' ? 'ok' : status === 'MANUAL' ? 'warn' : 'err';
  const label = status === 'ELIGIBLE' ? 'Eligible' : status === 'MANUAL' ? 'Manual review' : status === 'INELIGIBLE' ? 'Ineligible' : 'Error';
  return <span className={`ts-badge ${cls}`}>{label}</span>;
}

function TermSheet({ q, onRegister, registering, isCurrent }) {
  if (!q) return null;
  const s = q.sizing;
  const priced = q.status !== 'INELIGIBLE' && s && s.totalLoan > 0;
  return (
    <div className="ts-card">
      <div className="ts-head">
        <div>
          <div className="ts-title">{q.programLabel}{q.productLabel ? <span className="muted small"> · {q.productLabel}</span> : null}</div>
          {q.tierLabel && <div className="muted small">{q.tierLabel}</div>}
        </div>
        <StatusBadge status={q.status} />
      </div>

      {q.reasons && q.reasons.length > 0 && (
        <ul className="ts-reasons">
          {q.reasons.map((r, i) => (
            <li key={i} className={r.level === 'INELIGIBLE' ? 'err' : r.level === 'MANUAL' ? 'warn' : 'ok'}>{r.msg}</li>
          ))}
        </ul>
      )}

      {priced && (
        <>
          <div className="ts-hero">
            <div className="ts-hero-loan">
              <div className="ts-hero-k">Loan amount</div>
              <div className="ts-hero-v">{money(s.totalLoan)}</div>
            </div>
            <div className="ts-hero-rate">
              <div className="ts-hero-k">Note rate</div>
              <div className="ts-hero-v">{pct(q.noteRate)}</div>
            </div>
          </div>
          <div className="ts-grid">
            <div className="metrow"><span className="k">Initial advance</span><span className="v">{money(s.initialAdvance)}</span></div>
            {s.downPayment > 0 && <div className="metrow"><span className="k">Down payment</span><span className="v">{money(s.downPayment)}</span></div>}
            {s.rehabHoldback > 0 && <div className="metrow"><span className="k">Rehab holdback</span><span className="v">{money(s.rehabHoldback)}</span></div>}
            {s.financedReserve > 0 && <div className="metrow"><span className="k">Financed interest reserve</span><span className="v">{money(s.financedReserve)}</span></div>}
            <div className="metrow"><span className="k">Payment (at close)</span><span className="v">{money(s.initialPayment)}/mo</span></div>
            <div className="metrow"><span className="k">Payment (fully drawn)</span><span className="v">{money(s.monthlyPayment)}/mo</span></div>
            <div className="metrow"><span className="k">Origination ({pct(q.origPct, 3)})</span><span className="v">{money(q.origination)}</span></div>
            <div className="metrow"><span className="k">Est. title & settlement</span><span className="v">{money(q.title.total)}{!q.title.known ? ' *' : ''}</span></div>
            <div className="metrow"><span className="k">Loan-to-cost</span><span className="v">{pct(s.ltcPct, 1)}</span></div>
            {s.arvPct > 0 && <div className="metrow"><span className="k">Loan-to-ARV</span><span className="v">{pct(s.arvPct, 1)}</span></div>}
            {q.liquidity != null && <div className="metrow"><span className="k">Liquidity to show</span><span className="v">{money(q.liquidity)}</span></div>}
          </div>
          {s.binding && <p className="muted small" style={{ marginTop: 6 }}>Sized by {s.binding}.</p>}
          {!q.title.known && <p className="muted small" style={{ margin: '2px 0 0' }}>* Title estimate uses the national baseline — no filed rate on file for this state.</p>}
        </>
      )}

      <div className="row" style={{ gap: 8, marginTop: 12 }}>
        <button className="btn primary" disabled={registering || (!priced && q.status !== 'MANUAL')}
          onClick={() => onRegister(q)}>
          {registering ? 'Registering…' : isCurrent ? 'Re-register these terms' : 'Register this product'}
        </button>
        {q.status === 'INELIGIBLE' && <span className="muted small" style={{ alignSelf: 'center' }}>Resolve the ineligible items or override the basis to register.</span>}
      </div>
    </div>
  );
}

export default function ProductRegistration({ appId, app, onRegistered }) {
  const [data, setData] = useState(null);      // { current, history, quote, enginesReady }
  const [q, setQ] = useState(null);            // latest quoteAll { standard, gold, inputs, experience }
  const [program, setProgram] = useState('standard');
  const [ov, setOv] = useState(null);          // editable overrides (seeded from inputs)
  const [busy, setBusy] = useState(true);
  const [repricing, setRepricing] = useState(false);
  const [registering, setRegistering] = useState(false);
  const [err, setErr] = useState('');
  const [open, setOpen] = useState(true);
  const userEdited = useRef(false);
  const timer = useRef(null);

  // Initial load.
  useEffect(() => {
    let alive = true;
    setBusy(true); setErr('');
    api.staffPricing(appId).then((d) => {
      if (!alive) return;
      setData(d);
      if (d.quote) { setQ(d.quote); setOv({ ...d.quote.inputs }); }
      if (d.current && d.current.program) setProgram(d.current.program);
    }).catch((e) => alive && setErr(e.message || 'Could not load pricing'))
      .finally(() => alive && setBusy(false));
    return () => { alive = false; };
  }, [appId]);

  // Debounced server reprice whenever the staff edits an input.
  useEffect(() => {
    if (!ov || !userEdited.current) return;
    if (timer.current) clearTimeout(timer.current);
    setRepricing(true);
    timer.current = setTimeout(() => {
      api.staffPricingQuote(appId, ov)
        .then((d) => setQ(d))
        .catch((e) => setErr(e.message || 'Pricing failed'))
        .finally(() => setRepricing(false));
    }, 450);
    return () => timer.current && clearTimeout(timer.current);
  }, [ov, appId]);

  function set(k, v) { userEdited.current = true; setOv((o) => ({ ...o, [k]: v })); }
  function pickLadder(ltc) { set('targetLTC', ltc); }

  async function register(quote) {
    setRegistering(true); setErr('');
    try {
      await api.staffRegisterProduct(appId, program, ov || {});
      const d = await api.staffPricing(appId);
      setData(d);
      if (onRegistered) onRegistered();
    } catch (e) {
      // Surface engine reasons when the deal is ineligible.
      const detail = e.data && e.data.reasons ? e.data.reasons.map((r) => r.msg).join(' ') : (e.message || 'Could not register');
      setErr(detail);
    } finally { setRegistering(false); }
  }

  const cur = data && data.current;
  const active = q ? (program === 'gold' ? q.gold : q.standard) : null;
  const ladder = active && active.ladder;

  return (
    <div className="panel" style={{ marginTop: 18 }}>
      <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center', cursor: 'pointer' }} onClick={() => setOpen((o) => !o)}>
        <h3 style={{ margin: 0 }}>Product registration & term sheet</h3>
        <div className="row" style={{ gap: 10, alignItems: 'center' }}>
          {cur && <span className="ts-badge ok">Registered · {cur.program === 'gold' ? 'Gold Standard' : 'Standard'} · {pct(cur.note_rate)}</span>}
          <span className="muted">{open ? '▾' : '▸'}</span>
        </div>
      </div>

      {open && (
        <div style={{ marginTop: 12 }}>
          {busy && <p className="muted small">Pricing…</p>}
          {err && <div className="notice err" style={{ marginBottom: 10 }}>{err}</div>}
          {data && !data.enginesReady && <div className="notice err">Pricing engines are unavailable on the server.</div>}

          {cur && (
            <div className="ts-current">
              <strong>Currently registered:</strong> {cur.product_label || (cur.program === 'gold' ? 'Gold Standard Program' : 'Standard Program')} —
              {' '}{money(cur.total_loan)} @ {pct(cur.note_rate)}
              {cur.registered_by_name ? ` · by ${cur.registered_by_name}` : ''}
              {cur.status && cur.status !== 'ELIGIBLE' ? ` · ${cur.status.toLowerCase()}` : ''}
            </div>
          )}

          {ov && (
            <>
              {/* Editable pricing inputs — seeded from the file, staff can what-if. */}
              <div className="ts-inputs">
                <label><span>Strategy</span>
                  <select className="input" value={ov.strategy} onChange={(e) => set('strategy', e.target.value)}>
                    {STRATEGIES.every((s) => s.v !== ov.strategy) && <option value={ov.strategy}>{ov.strategy}</option>}
                    {STRATEGIES.map((s) => <option key={s.v} value={s.v}>{s.label}</option>)}
                  </select>
                </label>
                <label><span>Loan type</span>
                  <select className="input" value={ov.loanType} onChange={(e) => set('loanType', e.target.value)}>
                    <option>Purchase</option><option>Refinance</option>
                  </select>
                </label>
                <label><span>State</span>
                  <input className="input" value={ov.state || ''} maxLength={2} onChange={(e) => set('state', e.target.value.toUpperCase())} />
                </label>
                <label><span>{ov.isAssignment ? 'Seller price' : 'Purchase price'}</span>
                  <MoneyInput value={ov.isAssignment ? (ov.sellerPrice || '') : (ov.purchasePrice || '')}
                    onChange={(v) => set(ov.isAssignment ? 'sellerPrice' : 'purchasePrice', v)} />
                </label>
                <label><span>As-is value</span><MoneyInput value={ov.asIsValue || ''} onChange={(v) => set('asIsValue', v)} /></label>
                <label><span>ARV</span><MoneyInput value={ov.arv || ''} onChange={(v) => set('arv', v)} /></label>
                <label><span>Rehab budget</span><MoneyInput value={ov.rehabBudget || ''} onChange={(v) => set('rehabBudget', v)} /></label>
                <label><span>FICO</span>
                  <input className="input" type="number" min="300" max="850" value={ov.fico || ''} onChange={(e) => set('fico', e.target.value)} />
                </label>
                <label><span>Term (months)</span>
                  <input className="input" type="number" min="1" max="36" value={ov.term || ''} onChange={(e) => set('term', e.target.value)} />
                </label>
                <label><span>Interest reserve (months)</span>
                  <input className="input" type="number" min="0" max="24" value={ov.irMonths || 0} onChange={(e) => set('irMonths', e.target.value)} />
                </label>
                <label><span>Exp: flips</span>
                  <input className="input" type="number" min="0" value={ov.expFlips || 0} onChange={(e) => set('expFlips', e.target.value)} />
                </label>
                <label><span>Exp: holds</span>
                  <input className="input" type="number" min="0" value={ov.expHolds || 0} onChange={(e) => set('expHolds', e.target.value)} />
                </label>
                <label><span>Exp: ground-up</span>
                  <input className="input" type="number" min="0" value={ov.expGround || 0} onChange={(e) => set('expGround', e.target.value)} />
                </label>
              </div>
              <p className="muted small" style={{ margin: '2px 0 12px' }}>
                Seeded from the file{q && q.experience ? ` (track record: ${q.experience.flips} flips · ${q.experience.holds} holds · ${q.experience.ground} ground-up)` : ''}. Edits are for what-if only until you register.{repricing ? ' · repricing…' : ''}
              </p>

              {/* Program tabs */}
              <div className="ts-tabs">
                <button className={`ts-tab ${program === 'standard' ? 'on' : ''}`} onClick={() => setProgram('standard')}>
                  Standard Program {q && q.standard && <StatusBadge status={q.standard.status} />}
                </button>
                <button className={`ts-tab ${program === 'gold' ? 'on' : ''}`} onClick={() => setProgram('gold')}>
                  Gold Standard {q && q.gold && <StatusBadge status={q.gold.status} />}
                </button>
              </div>

              {/* Standard leverage ladder — trade leverage for a better rate. */}
              {program === 'standard' && ladder && ladder.rows && ladder.rows.length > 0 && (
                <div className="ts-ladder">
                  <div className="muted small" style={{ marginBottom: 4 }}>Leverage options — click to size at that LTC:</div>
                  <div className="ts-ladder-rows">
                    {ladder.rows.map((r) => {
                      const chosen = Math.abs((ov.targetLTC || ladder.maxBucket) - r.ltc) < 1e-6;
                      return (
                        <button key={r.ltc} className={`ts-lad ${chosen ? 'on' : ''}`} onClick={() => pickLadder(r.ltc)}>
                          <span className="lad-ltc">{pct(r.ltc, 1)}{r.isMax ? ' · max' : ''}</span>
                          <span className="lad-loan">{money(r.totalLoan)}</span>
                          <span className="lad-rate">{pct(r.noteRate)}</span>
                        </button>
                      );
                    })}
                  </div>
                  {ov.targetLTC > 0 && <button className="btn link small" onClick={() => pickLadder(0)}>Reset to max leverage</button>}
                </div>
              )}

              <TermSheet q={active} onRegister={register} registering={registering}
                isCurrent={!!cur && cur.program === program} />
            </>
          )}
        </div>
      )}
    </div>
  );
}
