import React, { useMemo, useState } from 'react';
import { api } from '../lib/api.js';
import { MoneyInput } from './FormattedInputs.jsx';

/* Native rehab-budget / scope-of-work builder. Line items grouped by the same
   ROC-style categories as the standalone tool, plus custom lines and a
   contingency. Submitting stores the full SOW as the checklist item's
   tool_payload AND syncs the grand total onto applications.rehab_budget (which
   feeds the pricing engine) — so the borrower's scope drives the terms.
   The category taxonomy is data (line-item labels); it is NOT the frozen
   pricing math and is safe to carry in the client. */

const CATS = [
  { id: 'soft', label: 'Soft Costs & Permits', items: ['Permits', 'Architectural / engineering', 'Survey', 'Inspections / testing', 'Interior design / drawings'] },
  { id: 'genconds', label: 'General Conditions', items: ['Supervision / project management', 'Temporary utilities', 'Dumpsters / debris', 'Equipment rental', "Builder's risk / liability insurance"] },
  { id: 'demo', label: 'Demolition', items: ['Interior demolition', 'Exterior demolition', 'Trash-out', 'Hazmat / mold remediation'] },
  { id: 'site', label: 'Site Work', items: ['Grading / drainage', 'Driveway / walkway', 'Landscaping', 'Fencing', 'Retaining wall'] },
  { id: 'foundation', label: 'Foundation & Structural', items: ['Foundation repair', 'Structural framing', 'Beams / posts / supports', 'Waterproofing', 'Underpinning'] },
  { id: 'exterior', label: 'Exterior', items: ['Roof', 'Siding', 'Windows', 'Exterior doors', 'Gutters & downspouts', 'Exterior paint', 'Porch / deck'] },
  { id: 'interior', label: 'Interior', items: ['Framing / drywall', 'Insulation', 'Interior doors', 'Trim / millwork', 'Interior paint', 'Stairs / railings'] },
  { id: 'flooring', label: 'Flooring', items: ['Hardwood', 'Luxury vinyl / laminate', 'Tile', 'Carpet', 'Subfloor repair'] },
  { id: 'mep', label: 'Services — Mechanical / Electrical / Plumbing', items: ['Electrical', 'Panel / service upgrade', 'Plumbing', 'Water heater', 'HVAC system', 'Ductwork'] },
  { id: 'kitchen', label: 'Kitchen', items: ['Cabinets', 'Countertops', 'Backsplash', 'Sink & faucet', 'Kitchen flooring', 'Lighting'] },
  { id: 'baths', label: 'Bathrooms', items: ['Full bath remodel', 'Tub / shower', 'Vanity & top', 'Toilet', 'Tile', 'Fixtures'] },
  { id: 'appliances', label: 'Appliances', items: ['Refrigerator', 'Range / oven', 'Dishwasher', 'Microwave', 'Washer / dryer'] },
  { id: 'basement', label: 'Basement', items: ['Finish basement', 'Egress window', 'Sump pump', 'Waterproofing'] },
  { id: 'special', label: 'Special Construction', items: ['Pool / spa', 'ADU / addition', 'Solar'] },
  { id: 'final', label: 'Final Clean-Up', items: ['Final cleaning', 'Punch list', 'Staging'] },
];

const money = (n) => '$' + Math.round(Number(n) || 0).toLocaleString('en-US');
const keyOf = (cat, item) => `${cat}::${item}`;

/* Read-only scope-of-work breakdown of a submitted rehab-budget payload —
   used on the staff file so an underwriter sees the line items, not raw JSON. */
export function RehabBudgetView({ payload }) {
  if (!payload || typeof payload !== 'object') return null;
  const lines = Array.isArray(payload.lines) ? payload.lines : [];
  const custom = Array.isArray(payload.custom) ? payload.custom : [];
  const byCat = {};
  for (const l of lines) { (byCat[l.catLabel || l.cat] = byCat[l.catLabel || l.cat] || []).push(l); }
  return (
    <div className="rb-view">
      {Object.keys(byCat).map((cat) => (
        <div key={cat} className="rb-view-cat">
          <div className="rb-view-cat-h">{cat}</div>
          {byCat[cat].map((l, i) => (
            <div key={i} className="rb-view-line"><span>{l.item}</span><span>{money(l.amount)}</span></div>
          ))}
        </div>
      ))}
      {custom.length > 0 && (
        <div className="rb-view-cat">
          <div className="rb-view-cat-h">Custom</div>
          {custom.map((l, i) => <div key={i} className="rb-view-line"><span>{l.label}</span><span>{money(l.amount)}</span></div>)}
        </div>
      )}
      <div className="rb-view-line" style={{ marginTop: 6 }}><span className="muted">Subtotal</span><span>{money(payload.subtotal)}</span></div>
      {payload.contingency > 0 && <div className="rb-view-line"><span className="muted">Contingency ({payload.contingencyPct}%)</span><span>{money(payload.contingency)}</span></div>}
      <div className="rb-view-line rb-view-total"><span>Total rehab budget</span><span>{money(payload.total)}</span></div>
    </div>
  );
}

// Rebuild the editable amount map from a previously-submitted payload.
function seedFromPayload(p) {
  const m = {};
  if (p && Array.isArray(p.lines)) for (const l of p.lines) if (l && l.cat && l.item) m[keyOf(l.cat, l.item)] = String(l.amount || '');
  return m;
}

export default function RehabBudget({ appId, item, onSubmitted, submitFn, initialPayload, ctaLabel }) {
  const saved = (item && item.tool_payload && typeof item.tool_payload === 'object' ? item.tool_payload : null)
    || (initialPayload && typeof initialPayload === 'object' ? initialPayload : null);
  const [open, setOpen] = useState(!saved);          // collapsed once submitted
  const [amts, setAmts] = useState(() => seedFromPayload(saved));
  const [custom, setCustom] = useState(() => (saved && Array.isArray(saved.custom) ? saved.custom.map((c) => ({ ...c })) : []));
  const [contPct, setContPct] = useState(saved && saved.contingencyPct != null ? String(saved.contingencyPct) : '10');
  const [openCats, setOpenCats] = useState({});
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [okMsg, setOkMsg] = useState('');

  const set = (cat, it, v) => setAmts((m) => ({ ...m, [keyOf(cat, it)]: v }));

  const { subtotal, contingency, total, catTotals } = useMemo(() => {
    const catTotals = {};
    let sub = 0;
    for (const c of CATS) {
      let ct = 0;
      for (const it of c.items) ct += Number(amts[keyOf(c.id, it)]) || 0;
      catTotals[c.id] = ct; sub += ct;
    }
    for (const cl of custom) sub += Number(cl.amount) || 0;
    const cont = Math.round(sub * (Number(contPct) || 0) / 100);
    return { subtotal: sub, contingency: cont, total: sub + cont, catTotals };
  }, [amts, custom, contPct]);

  function buildPayload() {
    const lines = [];
    for (const c of CATS) for (const it of c.items) {
      const a = Number(amts[keyOf(c.id, it)]) || 0;
      if (a > 0) lines.push({ cat: c.id, catLabel: c.label, item: it, amount: a });
    }
    const cust = custom.filter((c) => (c.label || '').trim() && Number(c.amount) > 0)
      .map((c) => ({ label: c.label.trim(), amount: Number(c.amount) }));
    return { version: 1, contingencyPct: Number(contPct) || 0, lines, custom: cust, subtotal, contingency, total };
  }

  async function submit() {
    setBusy(true); setErr(''); setOkMsg('');
    try {
      const payload = buildPayload();
      if (!(payload.total > 0)) { setErr('Enter at least one line item.'); setBusy(false); return; }
      if (submitFn) await submitFn(payload);
      else await api.completeTool(appId, item.id, payload);
      setOkMsg(submitFn ? `Saved — ${money(total)} rehab budget on the file.` : `Submitted — ${money(total)} scope of work sent to your loan team.`);
      setOpen(false);
      if (onSubmitted) onSubmitted();
    } catch (e) { setErr(e.message || 'Could not submit'); }
    finally { setBusy(false); }
  }

  const lineCount = useMemo(() => Object.values(amts).filter((v) => Number(v) > 0).length + custom.filter((c) => Number(c.amount) > 0).length, [amts, custom]);

  return (
    <div className="rb-tool">
      <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center', cursor: 'pointer' }} onClick={() => setOpen((o) => !o)}>
        <strong>Rehab budget &amp; scope of work</strong>
        <span className="muted small">{saved ? `Submitted · ${money(saved.total)}` : (total > 0 ? money(total) : 'Build your budget')} {open ? '▾' : '▸'}</span>
      </div>

      {okMsg && <div className="notice ok" style={{ marginTop: 8 }}>{okMsg}</div>}
      {err && <div className="notice err" style={{ marginTop: 8 }}>{err}</div>}

      {open && (
        <div style={{ marginTop: 10 }}>
          <p className="muted small" style={{ margin: '0 0 10px' }}>Enter the cost for each line that applies — leave the rest blank. Your total becomes the rehab budget on your file.</p>
          {CATS.map((c) => {
            const isOpen = openCats[c.id];
            return (
              <div key={c.id} className="rb-cat">
                <button className="rb-cat-head" onClick={() => setOpenCats((s) => ({ ...s, [c.id]: !s[c.id] }))}>
                  <span className="rb-cat-tog">{isOpen ? '▾' : '▸'}</span>
                  <span className="rb-cat-label">{c.label}</span>
                  <span className="rb-cat-total">{catTotals[c.id] > 0 ? money(catTotals[c.id]) : ''}</span>
                </button>
                {isOpen && (
                  <div className="rb-lines">
                    {c.items.map((it) => (
                      <label key={it} className="rb-line">
                        <span className="rb-line-label">{it}</span>
                        <MoneyInput value={amts[keyOf(c.id, it)] || ''} onChange={(v) => set(c.id, it, v)} />
                      </label>
                    ))}
                  </div>
                )}
              </div>
            );
          })}

          {/* Custom line items */}
          <div className="rb-cat">
            <div className="rb-cat-head" style={{ cursor: 'default' }}>
              <span className="rb-cat-label">Other / custom items</span>
              <span className="rb-cat-total">{custom.reduce((s, c) => s + (Number(c.amount) || 0), 0) > 0 ? money(custom.reduce((s, c) => s + (Number(c.amount) || 0), 0)) : ''}</span>
            </div>
            <div className="rb-lines">
              {custom.map((cl, i) => (
                <div key={i} className="rb-line">
                  <input className="input" placeholder="Describe the work" value={cl.label}
                    onChange={(e) => setCustom((cs) => cs.map((x, j) => j === i ? { ...x, label: e.target.value } : x))} />
                  <MoneyInput value={cl.amount || ''} onChange={(v) => setCustom((cs) => cs.map((x, j) => j === i ? { ...x, amount: v } : x))} />
                </div>
              ))}
              <button className="btn link small" onClick={() => setCustom((cs) => [...cs, { label: '', amount: '' }])}>+ Add a custom line</button>
            </div>
          </div>

          <div className="rb-summary">
            <div className="metrow"><span className="k">Line items</span><span className="v">{lineCount}</span></div>
            <div className="metrow"><span className="k">Subtotal</span><span className="v">{money(subtotal)}</span></div>
            <label className="metrow" style={{ alignItems: 'center' }}>
              <span className="k">Contingency</span>
              <span className="v" style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                <input className="input" type="number" min="0" max="25" value={contPct} style={{ width: 64 }}
                  onChange={(e) => setContPct(e.target.value)} />% = {money(contingency)}
              </span>
            </label>
            <div className="metrow rb-grand"><span className="k">Total rehab budget</span><span className="v">{money(total)}</span></div>
          </div>

          <div className="row" style={{ gap: 8, marginTop: 12 }}>
            <button className="btn primary" disabled={busy} onClick={submit}>{busy ? 'Saving…' : (ctaLabel || (saved ? 'Resubmit budget' : 'Submit to your loan team'))}</button>
          </div>
        </div>
      )}
    </div>
  );
}
