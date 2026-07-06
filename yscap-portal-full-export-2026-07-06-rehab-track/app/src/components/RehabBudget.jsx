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
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const base64Text = (text) => btoa(unescape(encodeURIComponent(text)));
const TEMPLATES = [
  { name: 'Basic Cosmetic Refresh', cont: 10, items: ['Interior paint', 'Luxury vinyl / laminate', 'Electrical', 'Final cleaning'] },
  { name: 'Cosmetic + Kitchen & Baths', cont: 10, items: ['Interior paint', 'Luxury vinyl / laminate', 'Cabinets', 'Countertops', 'Sink & faucet', 'Lighting', 'Vanity & top', 'Toilet', 'Fixtures', 'Range / oven', 'Dishwasher', 'Electrical', 'Final cleaning'] },
  { name: 'Standard Moderate Rehab', cont: 12, items: ['Interior demolition', 'Trash-out', 'Cabinets', 'Countertops', 'Sink & faucet', 'Lighting', 'Full bath remodel', 'Tile', 'Luxury vinyl / laminate', 'Interior doors', 'Trim / millwork', 'Interior paint', 'Electrical', 'Plumbing', 'Refrigerator', 'Range / oven', 'Dishwasher', 'Exterior paint', 'Final cleaning', 'Punch list'] },
  { name: 'Moderate + Systems', cont: 13, items: ['Interior demolition', 'Trash-out', 'Cabinets', 'Countertops', 'Sink & faucet', 'Lighting', 'Full bath remodel', 'Luxury vinyl / laminate', 'Trim / millwork', 'Interior paint', 'Electrical', 'Panel / service upgrade', 'Plumbing', 'Water heater', 'HVAC system', 'Refrigerator', 'Range / oven', 'Dishwasher', 'Exterior paint', 'Final cleaning', 'Punch list'] },
  { name: 'Heavy / Gut Rehab', cont: 15, items: ['Permits', 'Architectural / engineering', 'Interior demolition', 'Exterior demolition', 'Foundation repair', 'Structural framing', 'Framing / drywall', 'Insulation', 'Electrical', 'Panel / service upgrade', 'Plumbing', 'Water heater', 'HVAC system', 'Ductwork', 'Cabinets', 'Countertops', 'Full bath remodel', 'Roof', 'Windows', 'Exterior paint', 'Final cleaning', 'Punch list'] },
  { name: 'Ground-Up / New Build', cont: 15, items: ['Permits', 'Architectural / engineering', 'Survey', 'Grading / drainage', 'Foundation repair', 'Structural framing', 'Roof', 'Siding', 'Windows', 'Exterior doors', 'Electrical', 'Plumbing', 'HVAC system', 'Insulation', 'Framing / drywall', 'Interior paint', 'Cabinets', 'Countertops', 'Full bath remodel', 'Final cleaning', 'Punch list'] },
  { name: 'Rental Turnover', cont: 10, items: ['Interior paint', 'Subfloor repair', 'Luxury vinyl / laminate', 'Refrigerator', 'Range / oven', 'Fixtures', 'Electrical', 'Final cleaning', 'Punch list'] },
];
function downloadText(filename, text, type) {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement('a');
  a.href = url; a.download = filename; document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

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
      {payload.details && (
        <div className="rb-view-cat">
          <div className="rb-view-cat-h">Project</div>
          <div className="rb-view-line"><span>{payload.details.address || 'Property'}</span><span>{payload.details.projectType || ''}</span></div>
          {payload.details.narrative && <div className="muted small">{payload.details.narrative}</div>}
        </div>
      )}
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
      {Array.isArray(payload.export_files) && payload.export_files.length > 0 && (
        <div className="muted small" style={{ marginTop: 6 }}>Generated exports: {payload.export_files.map((f) => f.filename).join(', ')}</div>
      )}
    </div>
  );
}

// Rebuild the editable amount map from a previously-submitted payload.
function seedFromPayload(p) {
  const m = {};
  if (p && Array.isArray(p.lines)) for (const l of p.lines) if (l && l.cat && l.item) m[keyOf(l.cat, l.item)] = String(l.amount || '');
  return m;
}
const addrLine = (a) => !a ? '' : (a.oneLine || [a.street || a.line1, a.city, a.state, a.zip].filter(Boolean).join(', '));
function initialDetails(saved, app) {
  const d = (saved && saved.details) || {};
  return {
    address: d.address || addrLine(app && app.property_address),
    propType: d.propType || (app && app.property_type) || '',
    units: d.units || (app && app.units) || '',
    projectType: d.projectType || (app && app.rehab_type) || '',
    sqftNow: d.sqftNow || (app && app.sqft_pre) || '',
    sqftAfter: d.sqftAfter || (app && app.sqft_post) || '',
    months: d.months || '',
    narrative: d.narrative || '',
    target: d.target || (app && app.rehab_budget) || '',
  };
}

export default function RehabBudget({ appId, item, app, onSubmitted, submitFn, initialPayload, ctaLabel }) {
  const saved = (item && item.tool_payload && typeof item.tool_payload === 'object' ? item.tool_payload : null)
    || (initialPayload && typeof initialPayload === 'object' ? initialPayload : null);
  const [open, setOpen] = useState(!saved);          // collapsed once submitted
  const [details, setDetails] = useState(() => initialDetails(saved, app));
  const [amts, setAmts] = useState(() => seedFromPayload(saved));
  const [custom, setCustom] = useState(() => (saved && Array.isArray(saved.custom) ? saved.custom.map((c) => ({ ...c })) : []));
  const [contPct, setContPct] = useState(saved && saved.contingencyPct != null ? String(saved.contingencyPct) : '10');
  const [suggested, setSuggested] = useState({});
  const [openCats, setOpenCats] = useState({});
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [okMsg, setOkMsg] = useState('');

  const set = (cat, it, v) => setAmts((m) => ({ ...m, [keyOf(cat, it)]: v }));
  const setD = (key, value) => setDetails((d) => ({ ...d, [key]: value }));

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

  function fileStem() {
    return `YS_Rehab_Budget_${String(details.address || 'property').replace(/[^A-Za-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 48) || 'property'}_${new Date().toISOString().slice(0, 10)}`;
  }
  function csvText(payload) {
    const rows = [
      ['YS Capital Group Rehab Budget'],
      ['Property', payload.details.address || ''],
      ['Project type', payload.details.projectType || ''],
      ['Units', payload.details.units || ''],
      [],
      ['Category', 'Line item', 'Amount'],
      ...payload.lines.map((l) => [l.catLabel, l.item, l.amount]),
      ...payload.custom.map((l) => ['Custom', l.label, l.amount]),
      [],
      ['Subtotal', '', payload.subtotal],
      ['Contingency', payload.contingencyPct + '%', payload.contingency],
      ['Total', '', payload.total],
    ];
    return rows.map((r) => r.map((x) => `"${String(x == null ? '' : x).replace(/"/g, '""')}"`).join(',')).join('\n');
  }
  function printableHtml(payload) {
    const rows = payload.lines.map((l) => `<tr><td>${esc(l.catLabel)}</td><td>${esc(l.item)}</td><td>${money(l.amount)}</td></tr>`).join('')
      + payload.custom.map((l) => `<tr><td>Custom</td><td>${esc(l.label)}</td><td>${money(l.amount)}</td></tr>`).join('');
    return `<!doctype html><html><head><meta charset="utf-8"><title>Rehab Budget</title><style>
body{font-family:Arial,sans-serif;color:#141B22;margin:36px;max-width:860px}h1{font-family:Georgia,serif;margin:0 0 4px}.brand{border-bottom:3px solid #C9A86A;padding-bottom:10px;margin-bottom:18px}.muted{color:#68747c}table{width:100%;border-collapse:collapse;margin-top:18px}td,th{border-bottom:1px solid #e7e2d6;padding:8px;text-align:left}td:last-child,th:last-child{text-align:right;font-weight:700}.tot{font-size:18px}.noprint{text-align:center;margin-top:20px}@media print{.noprint{display:none}}</style></head><body>
<div class="brand"><h1>YS Capital Group - Rehab Budget</h1><div class="muted">${esc(new Date().toLocaleDateString())}</div></div>
<p><strong>Property:</strong> ${esc(payload.details.address || '')}<br><strong>Project:</strong> ${esc(payload.details.projectType || '')} ${payload.details.units ? ' / ' + esc(payload.details.units) + ' units' : ''}</p>
${payload.details.narrative ? `<p>${esc(payload.details.narrative)}</p>` : ''}
<table><thead><tr><th>Category</th><th>Line item</th><th>Amount</th></tr></thead><tbody>${rows}
<tr><td colspan="2">Subtotal</td><td>${money(payload.subtotal)}</td></tr>
<tr><td colspan="2">Contingency (${payload.contingencyPct}%)</td><td>${money(payload.contingency)}</td></tr>
<tr class="tot"><td colspan="2">Total rehab budget</td><td>${money(payload.total)}</td></tr></tbody></table>
<div class="noprint"><button onclick="window.print()">Print / Save as PDF</button></div></body></html>`;
  }
  function buildPayload(withAttachments = false) {
    const lines = [];
    for (const c of CATS) for (const it of c.items) {
      const a = Number(amts[keyOf(c.id, it)]) || 0;
      if (a > 0) lines.push({ cat: c.id, catLabel: c.label, item: it, amount: a });
    }
    const cust = custom.filter((c) => (c.label || '').trim() && Number(c.amount) > 0)
      .map((c) => ({ label: c.label.trim(), amount: Number(c.amount) }));
    const payload = { version: 2, details, suggestedItems: Object.keys(suggested).filter((k) => suggested[k]), contingencyPct: Number(contPct) || 0, lines, custom: cust, subtotal, contingency, total, submittedAt: new Date().toISOString() };
    if (withAttachments) {
      const csv = csvText(payload);
      const html = printableHtml(payload);
      payload.attachments = [
        { filename: fileStem() + '.csv', contentType: 'text/csv', dataBase64: base64Text(csv) },
        { filename: fileStem() + '.html', contentType: 'text/html', dataBase64: base64Text(html) },
      ];
    }
    return payload;
  }

  async function submit() {
    setBusy(true); setErr(''); setOkMsg('');
    try {
      const payload = buildPayload(!submitFn);
      if (!(payload.total > 0)) { setErr('Enter at least one line item.'); setBusy(false); return; }
      if (submitFn) await submitFn(payload);
      else await api.completeTool(appId, item.id, payload);
      setOkMsg(submitFn ? `Saved — ${money(total)} rehab budget on the file.` : `Submitted — ${money(total)} scope of work sent to your loan team.`);
      setOpen(false);
      if (onSubmitted) onSubmitted();
    } catch (e) { setErr(e.message || 'Could not submit'); }
    finally { setBusy(false); }
  }

  function applyTemplate(tpl) {
    const next = {};
    const oc = {};
    for (const c of CATS) for (const it of c.items) {
      if (tpl.items.includes(it)) { next[keyOf(c.id, it)] = true; oc[c.id] = true; }
    }
    setSuggested(next);
    setOpenCats((s) => ({ ...s, ...oc }));
    setContPct(String(tpl.cont || 10));
    setD('projectType', tpl.name);
  }
  function exportCsv() {
    const payload = buildPayload(false);
    downloadText(fileStem() + '.csv', csvText(payload), 'text/csv');
  }
  function printPacket() {
    const w = window.open('', '_blank');
    if (!w) { setErr('Please allow pop-ups to open the printable budget.'); return; }
    w.document.write(printableHtml(buildPayload(false))); w.document.close();
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
          <div className="ts-inputs" style={{ marginBottom: 12 }}>
            <label style={{ gridColumn: '1 / -1' }}><span>Property address</span>
              <input className="input" value={details.address} onChange={(e) => setD('address', e.target.value)} /></label>
            <label><span>Property type</span><input className="input" value={details.propType} onChange={(e) => setD('propType', e.target.value)} /></label>
            <label><span>Units</span><input className="input" type="number" min="1" value={details.units} onChange={(e) => setD('units', e.target.value)} /></label>
            <label><span>Project type</span><input className="input" value={details.projectType} onChange={(e) => setD('projectType', e.target.value)} placeholder="Cosmetic, moderate, heavy, ground-up" /></label>
            <label><span>Existing sq ft</span><input className="input" type="number" min="0" value={details.sqftNow} onChange={(e) => setD('sqftNow', e.target.value)} /></label>
            <label><span>Completed sq ft</span><input className="input" type="number" min="0" value={details.sqftAfter} onChange={(e) => setD('sqftAfter', e.target.value)} /></label>
            <label><span>Timeline months</span><input className="input" type="number" min="0" value={details.months} onChange={(e) => setD('months', e.target.value)} /></label>
            <label><span>Target budget</span><MoneyInput value={details.target} onChange={(v) => setD('target', v)} /></label>
            <label style={{ gridColumn: '1 / -1' }}><span>Scope narrative</span>
              <input className="input" value={details.narrative} onChange={(e) => setD('narrative', e.target.value)} placeholder="Describe the work in plain English" /></label>
          </div>
          <div className="row" style={{ gap: 6, flexWrap: 'wrap', marginBottom: 10 }}>
            {TEMPLATES.map((tpl) => <button key={tpl.name} className="btn ghost small" onClick={() => applyTemplate(tpl)}>{tpl.name}</button>)}
          </div>
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
                    {c.items.map((it) => {
                      const k = keyOf(c.id, it);
                      return (
                      <label key={it} className={`rb-line ${suggested[k] ? 'rb-suggested' : ''}`}>
                        <span className="rb-line-label">{it}{suggested[k] ? <span className="ts-badge warn" style={{ marginLeft: 6 }}>Suggested</span> : null}</span>
                        <MoneyInput value={amts[k] || ''} onChange={(v) => set(c.id, it, v)} />
                      </label>
                      );
                    })}
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

          <div className="row" style={{ gap: 8, marginTop: 12, flexWrap: 'wrap' }}>
            <button className="btn primary" disabled={busy} onClick={submit}>{busy ? 'Saving…' : (ctaLabel || (saved ? 'Resubmit budget' : 'Submit to your loan team'))}</button>
            <button className="btn ghost" onClick={exportCsv}>Export Excel/CSV</button>
            <button className="btn ghost" onClick={printPacket}>Printable PDF</button>
          </div>
        </div>
      )}
    </div>
  );
}
