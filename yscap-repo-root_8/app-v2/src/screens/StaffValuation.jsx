import React, { useCallback, useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api } from '../lib/api.js';
import {
  INK, MUTED, GOLD, S, money, sqft, num, saleMonth, day, baths,
  conditionLabel, compSetShort, severityColor,
} from '../lib/research.js';

/* BUILD YOUR OWN VALUATION — pick the comparable sales you believe in, adjust
   each one to the subject by hand, and see what the property would appraise for.

   The grid is the one an appraiser knows: comparables side by side, a row per
   adjustment line, the adjusted price at the bottom. What the tool adds is that
   every suggested number shows WHERE IT CAME FROM, and any number you type
   replaces it permanently — a suggestion is never allowed to overwrite a human.

   The number this produces is an internal indication. It is not an appraisal,
   and the disclaimer travels with it everywhere it is shown. */

export default function StaffValuation() {
  const { id } = useParams();
  const [d, setD] = useState(null);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState('');
  const [picker, setPicker] = useState(false);
  const [printing, setPrinting] = useState(false);

  const load = useCallback(() => {
    api.valuation(id).then(setD).catch((e) => setErr(e.message || 'Could not load that valuation'));
  }, [id]);
  useEffect(() => { setD(null); setErr(''); load(); }, [id, load]);

  async function act(name, fn) {
    setBusy(name); setErr('');
    try { setD(await fn()); } catch (e) { setErr(e.message || 'That did not work'); }
    finally { setBusy(''); }
  }

  if (err && !d) return <div className="card" style={{ borderColor: '#B4423A', color: '#B4423A' }}>{err}</div>;
  if (!d) return <div className="card" style={{ color: MUTED }}>Loading…</div>;

  const v = d.valuation;
  const g = d.grid;
  const isFinal = v.status === 'final';
  const comps = g.comps || [];

  return (
    <div>
      <div style={{ marginBottom: 10, display: 'flex', gap: 12, flexWrap: 'wrap' }}>
        <Link to="/internal/research" style={{ color: MUTED, fontSize: 13 }}>← Property Research</Link>
        {v.property_id && (
          <Link to={`/internal/research/property/${v.property_id}`} style={{ color: MUTED, fontSize: 13 }}>
            The subject property →
          </Link>
        )}
      </div>

      <header style={{ display: 'flex', gap: 16, alignItems: 'flex-start', flexWrap: 'wrap', marginBottom: 14 }}>
        <div style={{ flex: '1 1 340px' }}>
          <input value={v.title || ''} disabled={isFinal}
            onChange={(e) => setD({ ...d, valuation: { ...v, title: e.target.value } })}
            onBlur={(e) => !isFinal && act('title', () => api.valuationUpdate(id, { title: e.target.value }))}
            style={{ ...S.input, fontSize: 20, fontWeight: 700, border: 'none', padding: '2px 0', background: 'transparent' }} />
          <div style={{ color: MUTED, fontSize: 13 }}>
            {v.subject_address || 'No address yet'} · as of {day(v.effective_date)} ·
            {' '}created {day(String(v.created_at).slice(0, 10))}
            {isFinal && <span style={{ ...S.tag, marginLeft: 8, borderColor: '#2F7F86', color: '#2F7F86' }}>finished</span>}
          </div>
        </div>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          {!isFinal && <button className="btn ghost small" onClick={() => setPicker(true)}>+ Add comparables</button>}
          {!isFinal && (
            <button className="btn ghost small" disabled={busy === 'suggest'}
              title="Fill in the adjustments we can work out from our own sales. Anything you typed is kept."
              onClick={() => act('suggest', () => api.valuationSuggest(id))}>
              {busy === 'suggest' ? 'Working…' : 'Suggest adjustments'}
            </button>
          )}
          <button className="btn ghost small" onClick={() => { setPrinting(true); setTimeout(() => { window.print(); setPrinting(false); }, 50); }}>
            Print the report
          </button>
          {!isFinal
            ? <button className="btn btn-gold small" disabled={busy === 'final' || !comps.length}
              onClick={() => act('final', () => api.valuationFinalize(id))}>
              {busy === 'final' ? 'Finishing…' : 'Finish this valuation'}
            </button>
            : <button className="btn ghost small" disabled={busy === 'dup'}
              onClick={() => act('dup', () => api.valuationDuplicate(id))}>Make a revision</button>}
        </div>
      </header>

      {err && <div className="card" style={{ borderColor: '#B4423A', color: '#B4423A', marginBottom: 12 }}>{err}</div>}

      {/* ---- the answer ---- */}
      <section style={{ ...S.panel, marginBottom: 14, borderColor: GOLD }}>
        <div style={{ display: 'flex', gap: 28, flexWrap: 'wrap', alignItems: 'flex-start' }}>
          <div>
            <div style={{ color: MUTED, fontSize: 12, fontWeight: 700, textTransform: 'uppercase' }}>
              What this property looks like it would appraise for
            </div>
            <div style={{ fontSize: 38, fontWeight: 700, color: INK, lineHeight: 1.1 }}>
              {money(g.value.indicatedValue)}
            </div>
            {g.value.likelyLow != null && (
              <div style={{ color: MUTED, fontSize: 14 }}>
                most likely between {money(g.value.likelyLow)} and {money(g.value.likelyHigh)}
              </div>
            )}
            {g.value.low != null && (
              <div style={{ color: MUTED, fontSize: 13 }}>
                the sales themselves land between {money(g.value.low)} and {money(g.value.high)}
              </div>
            )}
          </div>
          <div>
            <div style={{ color: MUTED, fontSize: 12, fontWeight: 700, textTransform: 'uppercase' }}>How solid is it</div>
            <div style={{ fontSize: 20, fontWeight: 700, color: g.value.confidence.label === 'strong' ? '#2F7F86'
              : g.value.confidence.label === 'fair' ? GOLD : '#B4423A' }}>
              {({ strong: 'Solid', fair: 'Reasonable', weak: 'Thin', 'very weak': 'Very thin' })[g.value.confidence.label]}
            </div>
            <ul style={{ margin: '4px 0 0 16px', padding: 0, color: MUTED, fontSize: 13 }}>
              {g.value.confidence.reasons.map((r, i) => <li key={i}>{r}</li>)}
            </ul>
          </div>
          <div>
            <div style={{ color: MUTED, fontSize: 12, fontWeight: 700, textTransform: 'uppercase' }}>Other ways of reading it</div>
            <div style={{ fontSize: 13, color: MUTED, marginTop: 4 }}>
              <div>Middle sale: <b style={{ color: INK }}>{money(g.value.median)}</b></div>
              <div>Straight average: <b style={{ color: INK }}>{money(g.value.mean)}</b></div>
              {g.value.pricePerSqft != null && <div>About <b style={{ color: INK }}>${g.value.pricePerSqft}</b> a square foot</div>}
              <div style={{ marginTop: 6 }}>
                <select style={{ ...S.input, width: 'auto' }} value={v.method} disabled={isFinal}
                  onChange={(e) => act('method', () => api.valuationUpdate(id, { method: e.target.value }))}>
                  <option value="weighted">Lean on the closest matches</option>
                  <option value="median">Use the middle sale</option>
                  <option value="mean">Use a straight average</option>
                </select>
              </div>
            </div>
          </div>
        </div>
        {g.warnings.length > 0 && (
          <ul style={{ margin: '12px 0 0 16px', padding: 0 }}>
            {g.warnings.map((w, i) => (
              <li key={i} style={{ color: severityColor(w.severity), fontSize: 13 }}>{w.text}</li>
            ))}
          </ul>
        )}
      </section>

      {/* ---- the subject ---- */}
      <SubjectBlock v={v} isFinal={isFinal} onSave={(patch) => act('subject', () => api.valuationUpdate(id, { subject: patch }))} />

      {/* ---- the grid ---- */}
      {comps.length === 0 ? (
        <div className="card" style={{ color: MUTED }}>
          No comparable sales yet. <button className="btn ghost small" onClick={() => setPicker(true)}>Find some →</button>
        </div>
      ) : (
        <Grid d={d} isFinal={isFinal} onChange={(compId, patch) =>
          act('comp' + compId, () => api.valuationEditComp(id, compId, patch))}
        onRemove={(compId) => act('drop' + compId, () => api.valuationDropComp(id, compId))} />
      )}

      <p style={{ marginTop: 16, color: MUTED, fontSize: 12, maxWidth: 780, lineHeight: 1.5 }}>
        {g.disclaimer} It must not be given to a borrower, an investor or a note buyer as a valuation,
        and it is not a substitute for ordering an appraisal.
      </p>

      {picker && (
        <CompPicker valuationId={id} subject={v.subject_snapshot} onClose={() => setPicker(false)}
          onAdded={(next) => { setD(next); setPicker(false); }} />
      )}

      {printing && <style>{'@media print { .app-sidebar, .app-topbar, .btn { display: none !important; } }'}</style>}
    </div>
  );
}

/* ---------------------------------------------------------------------- */

function SubjectBlock({ v, isFinal, onSave }) {
  const s = v.subject_snapshot || {};
  const [draft, setDraft] = useState(s);
  const [open, setOpen] = useState(!s.gla);
  useEffect(() => { setDraft(v.subject_snapshot || {}); }, [v.subject_snapshot]);

  // A plain render FUNCTION, deliberately not an inline component. Declaring a
  // component inside a render creates a brand-new component type on every keystroke,
  // React unmounts and remounts the input, and the field loses focus after every
  // character typed. Calling a function returning JSX has no such identity.
  const field = (k, label, type) => (
    <div key={k}>
      <label style={S.label}>{label}</label>
      <input style={S.input} type={type || 'text'} disabled={isFinal} value={draft[k] == null ? '' : draft[k]}
        onChange={(e) => setDraft({ ...draft, [k]: e.target.value })}
        onBlur={() => { if (String(draft[k] ?? '') !== String(s[k] ?? '')) onSave({ [k]: draft[k] }); }} />
    </div>
  );

  return (
    <section style={{ ...S.panel, marginBottom: 14 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <h2 style={{ margin: 0, fontSize: 16, color: INK }}>The property being valued</h2>
        <button className="btn ghost small" onClick={() => setOpen((o) => !o)}>{open ? 'Hide' : 'Edit'}</button>
      </div>
      <div style={{ color: MUTED, fontSize: 13, marginTop: 6 }}>
        {[s.display_address, s.gla && sqft(s.gla), s.beds != null && `${s.beds} bed`,
          (s.baths_full != null || s.baths_half != null) && `${baths(s)} bath`,
          s.year_built && `built ${s.year_built}`, s.condition_uad].filter(Boolean).join(' · ') || 'Nothing filled in yet'}
      </div>
      {!s.gla && (
        <div style={{ color: GOLD, fontSize: 13, marginTop: 6 }}>
          Fill in at least the living area — without it the adjustments cannot be worked out for you.
        </div>
      )}
      {open && (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(150px, 1fr))', gap: 10, marginTop: 12 }}>
          {field('display_address', 'Address')}
          {field('city', 'Town')}
          {field('state', 'State')}
          {field('zip', 'ZIP')}
          {field('gla', 'Living area (sq ft)', 'number')}
          {field('beds', 'Bedrooms', 'number')}
          {field('baths_full', 'Full baths', 'number')}
          {field('baths_half', 'Half baths', 'number')}
          {field('year_built', 'Year built', 'number')}
          {field('units', 'Units', 'number')}
          <div>
            <label style={S.label}>Condition</label>
            <select style={S.input} disabled={isFinal} value={draft.condition_uad || ''}
              onChange={(e) => { setDraft({ ...draft, condition_uad: e.target.value }); onSave({ condition_uad: e.target.value }); }}>
              <option value="">Not stated</option>
              {['C1', 'C2', 'C3', 'C4', 'C5', 'C6'].map((c) => (
                <option key={c} value={c}>{conditionLabel(c)}</option>
              ))}
            </select>
          </div>
          {field('property_type', 'Property type')}
        </div>
      )}
    </section>
  );
}

/* The side-by-side adjustment grid. Comps are COLUMNS, exactly as on the form. */
function Grid({ d, isFinal, onChange, onRemove }) {
  const comps = d.grid.comps;
  const lines = d.grid.gridLines;
  const [busyCell, setBusyCell] = useState('');

  function setLine(comp, key, raw) {
    const amount = raw === '' || raw == null ? 0 : Number(String(raw).replace(/[$,\s]/g, ''));
    const kept = (comp.adjustments || []).filter((l) => l.key !== key);
    // ANYTHING THE USER TYPES BECOMES THEIRS. Once a line carries source:'user' the
    // "suggest" pass will never touch it again — that is the promise of the tool.
    const next = Number.isFinite(amount) && amount !== 0
      ? kept.concat([{ key, amount, source: 'user' }])
      : kept.filter((l) => l.key !== key);
    setBusyCell(comp.id + key);
    onChange(comp.id, { adjustments: next });
    setTimeout(() => setBusyCell(''), 200);
  }

  return (
    <section style={{ ...S.panel, overflowX: 'auto' }}>
      <h2 style={{ margin: '0 0 4px', fontSize: 16, color: INK }}>The comparable sales</h2>
      <p style={{ margin: '0 0 12px', color: MUTED, fontSize: 13 }}>
        Type a dollar amount on any line to adjust that sale towards the subject. A sale that is BETTER
        than the subject gets a minus (take money off); one that is worse gets a plus. Suggested numbers
        are marked — type over any of them and yours sticks.
      </p>
      <table style={{ borderCollapse: 'collapse', minWidth: 640 }}>
        <thead>
          <tr>
            <th style={{ ...S.th, minWidth: 190, position: 'sticky', left: 0, background: '#fff' }}>Line</th>
            {comps.map((c) => (
              <th key={c.id} style={{ ...S.th, minWidth: 175, opacity: c.include === false ? 0.5 : 1 }}>
                <Link to={`/internal/research/property/${c.property_id}`} style={{ color: INK, fontSize: 13 }}>
                  {c.display_address || 'Comparable'}
                </Link>
                <div style={{ fontWeight: 400, color: MUTED, marginTop: 2 }}>
                  {money(c.sale_price)} · {saleMonth(c.sale_date)}
                </div>
                <div style={{ fontWeight: 400, color: MUTED }}>
                  {[c.gla && sqft(c.gla), c.beds != null && `${c.beds}bd`,
                    (c.baths_full != null || c.baths_half != null) && `${baths(c)}ba`,
                    c.condition_uad, c.comp_set && compSetShort[c.comp_set]].filter(Boolean).join(' · ')}
                </div>
                {!isFinal && (
                  <div style={{ marginTop: 4, display: 'flex', gap: 6, fontWeight: 400 }}>
                    <label style={{ fontSize: 11, color: MUTED, display: 'flex', gap: 4, alignItems: 'center' }}>
                      <input type="checkbox" checked={c.include !== false}
                        onChange={(e) => onChange(c.id, { included: e.target.checked })} />
                      use it
                    </label>
                    <button className="btn ghost small" style={{ padding: '0 6px' }}
                      onClick={() => onRemove(c.id)} title="Remove this sale">✕</button>
                  </div>
                )}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {lines.map((line) => {
            const any = comps.some((c) => (c.adjustments || []).some((l) => l.key === line.key));
            return (
              <tr key={line.key} style={any ? undefined : { opacity: 0.65 }}>
                <td style={{ ...S.cell, position: 'sticky', left: 0, background: '#fff', fontWeight: any ? 700 : 400 }}>
                  {line.label}
                </td>
                {comps.map((c) => {
                  const l = (c.adjustments || []).find((x) => x.key === line.key);
                  return (
                    <td key={c.id} style={{ ...S.cell, padding: 4 }}>
                      <input disabled={isFinal} inputMode="numeric"
                        defaultValue={l ? l.amount : ''} key={c.id + line.key + (l ? l.amount : '')}
                        placeholder="—"
                        onBlur={(e) => { if (String(e.target.value || '') !== String(l ? l.amount : '')) setLine(c, line.key, e.target.value); }}
                        onKeyDown={(e) => { if (e.key === 'Enter') e.target.blur(); }}
                        style={{ ...S.input, padding: '4px 6px', textAlign: 'right',
                          borderColor: busyCell === c.id + line.key ? GOLD : '#DDD6C7',
                          color: l && Number(l.amount) < 0 ? '#B4423A' : INK,
                          background: l && l.source === 'suggested' ? '#FBF7EE' : '#fff' }} />
                      {l && l.note && (
                        <div style={{ fontSize: 10, color: MUTED, marginTop: 2, lineHeight: 1.3 }} title={l.note}>
                          {l.source === 'suggested' ? 'suggested: ' : ''}{l.note.length > 70 ? l.note.slice(0, 70) + '…' : l.note}
                        </div>
                      )}
                    </td>
                  );
                })}
              </tr>
            );
          })}
          <tr>
            <td style={{ ...S.cell, position: 'sticky', left: 0, background: '#F6F3EC', fontWeight: 700 }}>Total adjustment</td>
            {comps.map((c) => (
              <td key={c.id} style={{ ...S.cell, background: '#F6F3EC', textAlign: 'right', fontWeight: 700,
                color: c.netAdjustment < 0 ? '#B4423A' : INK }}>
                {c.netAdjustment ? (c.netAdjustment > 0 ? '+' : '') + money(c.netAdjustment) : '—'}
                <div style={{ fontWeight: 400, fontSize: 11, color: MUTED }}>
                  {c.grossAdjPct != null ? `${Math.round(c.grossAdjPct)}% moved in total` : ''}
                </div>
              </td>
            ))}
          </tr>
          <tr>
            <td style={{ ...S.cell, position: 'sticky', left: 0, background: '#F6F3EC', fontWeight: 700 }}>
              What it says the subject is worth
            </td>
            {comps.map((c) => (
              <td key={c.id} style={{ ...S.cell, background: '#F6F3EC', textAlign: 'right',
                fontWeight: 700, fontSize: 15, opacity: c.include === false ? 0.45 : 1 }}>
                {money(c.adjustedPrice)}
              </td>
            ))}
          </tr>
          <tr>
            <td style={{ ...S.cell, position: 'sticky', left: 0, background: '#fff' }}>Anything to watch</td>
            {comps.map((c) => (
              <td key={c.id} style={S.cell}>
                {(c.warnings || []).length === 0
                  ? <span style={{ color: MUTED, fontSize: 12 }}>Nothing standing out.</span>
                  : (c.warnings || []).map((w, i) => (
                    <div key={i} style={{ fontSize: 11, color: severityColor(w.severity), marginBottom: 3 }}>{w.text}</div>
                  ))}
              </td>
            ))}
          </tr>
        </tbody>
      </table>
    </section>
  );
}

/* Find comparables for this subject, ranked by how close a match they are. */
function CompPicker({ valuationId, subject, onClose, onAdded }) {
  const [rows, setRows] = useState(null);
  const [sel, setSel] = useState(() => new Set());
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [q, setQ] = useState({ city: subject.city || '', state: subject.state || '', sold_within_months: '18' });

  const search = useCallback(() => {
    setRows(null); setErr('');
    const f = { ...q };
    if (subject.id) f.property_id = subject.id;
    else { f.gla = subject.gla; f.beds = subject.beds; f.condition_uad = subject.condition_uad; }
    api.researchComps(f).then((d) => setRows(d.rows || [])).catch((e) => { setRows([]); setErr(e.message || 'Search failed'); });
  }, [q, subject]);
  useEffect(() => { search(); }, [search]);

  async function add() {
    if (!sel.size) return;
    setBusy(true);
    try { onAdded(await api.valuationAddComps(valuationId, { property_ids: [...sel] })); }
    catch (e) { setErr(e.message || 'Could not add those'); setBusy(false); }
  }

  return (
    <div role="dialog" aria-label="Find comparables" style={{ position: 'fixed', inset: 0, zIndex: 800,
      background: 'rgba(20,27,34,0.5)', display: 'flex', alignItems: 'flex-start', justifyContent: 'center', padding: 24 }}>
      <div style={{ background: '#fff', borderRadius: 12, padding: 18, width: 'min(920px, 100%)',
        maxHeight: '88vh', overflowY: 'auto' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <h2 style={{ margin: 0, fontSize: 18, color: INK }}>Find comparable sales</h2>
          <button className="btn ghost small" onClick={onClose}>Close</button>
        </div>
        <p style={{ color: MUTED, fontSize: 13, margin: '6px 0 12px' }}>
          Ordered by how close a match each one is to the subject. The score is a hint — you decide.
        </p>
        <div style={{ display: 'flex', gap: 8, marginBottom: 12, flexWrap: 'wrap' }}>
          <input style={{ ...S.input, maxWidth: 160 }} placeholder="Town" value={q.city}
            onChange={(e) => setQ({ ...q, city: e.target.value })} />
          <input style={{ ...S.input, maxWidth: 80 }} placeholder="State" value={q.state}
            onChange={(e) => setQ({ ...q, state: e.target.value.toUpperCase() })} />
          <select style={{ ...S.input, width: 'auto' }} value={q.sold_within_months}
            onChange={(e) => setQ({ ...q, sold_within_months: e.target.value })}>
            <option value="6">Sold in the last 6 months</option>
            <option value="12">Last 12 months</option>
            <option value="18">Last 18 months</option>
            <option value="36">Last 3 years</option>
            <option value="">Any time</option>
          </select>
          <button className="btn ghost small" onClick={search}>Search</button>
        </div>
        {err && <div style={{ color: '#B4423A', fontSize: 13, marginBottom: 8 }}>{err}</div>}
        {rows == null && <div style={{ color: MUTED }}>Looking…</div>}
        {rows && rows.length === 0 && <div style={{ color: MUTED }}>Nothing close by. Try widening the town or the date range.</div>}
        <div style={{ display: 'grid', gap: 6 }}>
          {(rows || []).map((r) => (
            <label key={r.id} style={{ display: 'grid', gridTemplateColumns: 'auto 1fr auto auto', gap: 10,
              alignItems: 'center', border: '1px solid #EEE9DD', borderRadius: 8, padding: 8, cursor: 'pointer' }}>
              <input type="checkbox" checked={sel.has(r.id)}
                onChange={() => setSel((s) => { const n = new Set(s); n.has(r.id) ? n.delete(r.id) : n.add(r.id); return n; })} />
              <div>
                <div style={{ color: INK, fontWeight: 600, fontSize: 14 }}>{r.display_address}</div>
                <div style={{ color: MUTED, fontSize: 12 }}>
                  {[r.gla && sqft(r.gla), r.beds != null && `${r.beds} bed`,
                    (r.baths_full != null || r.baths_half != null) && `${baths(r)} bath`,
                    r.year_built && `built ${r.year_built}`, r.condition_uad].filter(Boolean).join(' · ')}
                </div>
              </div>
              <div style={{ textAlign: 'right' }}>
                <div style={{ fontWeight: 700, color: INK }}>{money(r.last_sale_price)}</div>
                <div style={{ color: MUTED, fontSize: 12 }}>{saleMonth(r.last_sale_date)}</div>
              </div>
              <div title={(r.match_reasons || []).map((p) => `${p.label}: ${p.earned}/${p.weight}`).join('\n')}
                style={{ ...S.tag, borderColor: r.match_score >= 70 ? '#2F7F86' : r.match_score >= 45 ? GOLD : '#DDD6C7',
                  color: r.match_score >= 70 ? '#2F7F86' : r.match_score >= 45 ? GOLD : MUTED }}>
                {Math.round(r.match_score)}% match
              </div>
            </label>
          ))}
        </div>
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 14 }}>
          <button className="btn ghost small" onClick={onClose}>Cancel</button>
          <button className="btn btn-gold small" disabled={busy || !sel.size} onClick={add}>
            {busy ? 'Adding…' : `Add ${sel.size || ''} to the valuation`}
          </button>
        </div>
      </div>
    </div>
  );
}
