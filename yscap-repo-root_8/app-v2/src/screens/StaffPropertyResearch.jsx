import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { api } from '../lib/api.js';
import { useAuth } from '../lib/auth.jsx';
import {
  INK, MUTED, GOLD, S, money, sqft, num, saleMonth, baths, conditionLabel,
  CONDITION_CODES, compSetShort,
} from '../lib/research.js';

/* PROPERTY RESEARCH — the search engine over every property and every comparable
   sale our appraisers have ever put in front of us.

   The whole screen is driven off the URL query string, so a search is a LINK:
   it can be bookmarked, pasted into a chat, or re-opened tomorrow and it comes
   back exactly the same. Nothing is stored per user.

   The tray at the bottom is the bridge into the valuation tool: tick the sales
   you like while you browse, then send them all into a grid in one go. */

const EMPTY = {
  q: '', state: '', city: '', zip: '',
  beds_min: '', beds_max: '', baths_min: '', baths_max: '',
  sqft_min: '', sqft_max: '', year_min: '', year_max: '',
  price_min: '', price_max: '', sold_from: '', sold_to: '', sold_within_months: '',
  condition_best: '', condition_worst: '', property_type: '', units_min: '', units_max: '',
  comp_set: '', role: '', has_sale: '', has_photos: '', sale_status: '',
  sort: 'recent_sale', page: '1', limit: '25',
};

export default function StaffPropertyResearch() {
  const [params, setParams] = useSearchParams();
  const nav = useNavigate();
  const { can } = useAuth();
  const [rows, setRows] = useState(null);
  const [meta, setMeta] = useState({ total: 0, page: 1, pages: 1 });
  const [facets, setFacets] = useState(null);
  const [stats, setStats] = useState(null);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const [picked, setPicked] = useState(() => new Map());   // id -> row
  const [sending, setSending] = useState(false);
  const reqRef = useRef(0);

  // The live filter object = the defaults with whatever the URL says on top.
  const filters = useMemo(() => {
    const f = { ...EMPTY };
    for (const [k, v] of params.entries()) f[k] = v;
    return f;
  }, [params]);

  const [draft, setDraft] = useState(filters);
  useEffect(() => { setDraft(filters); }, [filters]);

  const run = useCallback((f) => {
    const mine = ++reqRef.current;
    setBusy(true); setErr('');
    const clean = {};
    for (const [k, v] of Object.entries(f)) if (v !== '' && v != null) clean[k] = v;
    api.researchSearch(clean)
      .then((d) => {
        if (reqRef.current !== mine) return;       // a newer search already went out
        setRows(d.rows || []);
        setMeta({ total: d.total || 0, page: d.page || 1, pages: d.pages || 1 });
        setFacets(d.facets || null);
      })
      .catch((e) => { if (reqRef.current === mine) { setRows([]); setErr(e.message || 'Could not run that search'); } })
      .finally(() => { if (reqRef.current === mine) setBusy(false); });
  }, []);

  useEffect(() => { run(filters); }, [filters, run]);
  useEffect(() => { api.researchStats().then(setStats).catch(() => {}); }, []);

  function apply(next, resetPage = true) {
    const merged = { ...filters, ...next };
    if (resetPage) merged.page = '1';
    const out = {};
    for (const [k, v] of Object.entries(merged)) if (v !== '' && v != null && EMPTY[k] !== v) out[k] = v;
    setParams(out, { replace: false });
  }
  const clearAll = () => setParams({}, { replace: false });

  function toggle(row) {
    setPicked((m) => {
      const n = new Map(m);
      if (n.has(row.id)) n.delete(row.id); else n.set(row.id, row);
      return n;
    });
  }

  async function buildValuation() {
    if (!picked.size) return;
    setSending(true); setErr('');
    try {
      // The valuation opens on a BLANK subject: the sales are what the user picked,
      // and the subject is theirs to describe (or to pull off a property page,
      // which is where the "Value this property" button starts instead).
      const v = await api.valuationCreate({ title: 'New valuation', address: '' });
      await api.valuationAddComps(v.valuation.id, { property_ids: [...picked.keys()] });
      nav(`/internal/research/valuation/${v.valuation.id}`);
    } catch (e) {
      setErr(e.message || 'Could not start that valuation');
      setSending(false);
    }
  }

  const activeCount = Object.entries(filters).filter(([k, v]) => v !== '' && EMPTY[k] !== v
    && !['sort', 'page', 'limit'].includes(k)).length;

  return (
    <div>
      <header style={{ marginBottom: 14 }}>
        <h1 style={{ margin: '0 0 4px', color: INK }}>Property Research</h1>
        <p style={{ margin: 0, color: MUTED, maxWidth: 760 }}>
          Every property and every comparable sale our appraisers have ever put in front of us, in one
          searchable place. Search by town, price, size, bedrooms, bathrooms, condition and when it sold.
          Tick the sales you want and build a valuation from them.
        </p>
        {stats && (
          <div style={{ display: 'flex', gap: 18, flexWrap: 'wrap', marginTop: 10, fontSize: 13, color: MUTED }}>
            <span><b style={{ color: INK }}>{num(stats.properties)}</b> properties</span>
            <span><b style={{ color: INK }}>{num(stats.with_sale)}</b> with a sale price</span>
            <span><b style={{ color: INK }}>{num(stats.sales)}</b> sales recorded</span>
            <span><b style={{ color: INK }}>{num(stats.with_photo)}</b> with photos</span>
            <span><b style={{ color: INK }}>{num(stats.cities)}</b> towns in {num(stats.states)} states</span>
            <span><b style={{ color: INK }}>{num(stats.ingested)}</b> of {num(stats.appraisals)} reports read</span>
            {stats.pending > 0 && (
              <span style={{ color: GOLD }}>
                {num(stats.pending)} still being read in — the numbers grow as it works through them.
              </span>
            )}
          </div>
        )}
      </header>

      {err && <div className="card" style={{ borderColor: '#B4423A', color: '#B4423A', marginBottom: 12 }}>{err}</div>}

      <div style={{ display: 'grid', gridTemplateColumns: 'minmax(220px, 280px) 1fr', gap: 16, alignItems: 'start' }}>
        {/* ---------------- filters ---------------- */}
        <aside style={{ ...S.panel, position: 'sticky', top: 12 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
            <strong style={{ color: INK }}>Search</strong>
            {activeCount > 0 && (
              <button className="btn ghost small" onClick={clearAll}>Clear ({activeCount})</button>
            )}
          </div>

          <Field label="Address, town or ZIP">
            <input style={S.input} value={draft.q} placeholder="e.g. 10th St Piscataway"
              onChange={(e) => setDraft({ ...draft, q: e.target.value })}
              onKeyDown={(e) => { if (e.key === 'Enter') apply({ q: draft.q }); }}
              onBlur={() => { if (draft.q !== filters.q) apply({ q: draft.q }); }} />
          </Field>

          <Row>
            <Field label="State"><input style={S.input} value={draft.state} maxLength={2}
              onChange={(e) => setDraft({ ...draft, state: e.target.value.toUpperCase() })}
              onBlur={() => apply({ state: draft.state })} /></Field>
            <Field label="ZIP"><input style={S.input} value={draft.zip}
              onChange={(e) => setDraft({ ...draft, zip: e.target.value })}
              onBlur={() => apply({ zip: draft.zip })} /></Field>
          </Row>

          <Field label="Town">
            <input style={S.input} value={draft.city} placeholder="Any town"
              onChange={(e) => setDraft({ ...draft, city: e.target.value })}
              onKeyDown={(e) => { if (e.key === 'Enter') apply({ city: draft.city }); }}
              onBlur={() => { if (draft.city !== filters.city) apply({ city: draft.city }); }} />
          </Field>

          <MinMax label="Sale price" lo="price_min" hi="price_max" draft={draft} setDraft={setDraft} apply={apply} money />
          <MinMax label="Living area (sq ft)" lo="sqft_min" hi="sqft_max" draft={draft} setDraft={setDraft} apply={apply} />
          <MinMax label="Bedrooms" lo="beds_min" hi="beds_max" draft={draft} setDraft={setDraft} apply={apply} />
          <MinMax label="Bathrooms" lo="baths_min" hi="baths_max" draft={draft} setDraft={setDraft} apply={apply} step="0.5" />
          <MinMax label="Year built" lo="year_min" hi="year_max" draft={draft} setDraft={setDraft} apply={apply} />
          <MinMax label="Units" lo="units_min" hi="units_max" draft={draft} setDraft={setDraft} apply={apply} />

          <Field label="Sold between">
            <Row>
              <input type="date" style={S.input} value={draft.sold_from}
                onChange={(e) => apply({ sold_from: e.target.value })} />
              <input type="date" style={S.input} value={draft.sold_to}
                onChange={(e) => apply({ sold_to: e.target.value })} />
            </Row>
            <div style={{ display: 'flex', gap: 5, marginTop: 6, flexWrap: 'wrap' }}>
              {[3, 6, 12, 24].map((m) => (
                <button key={m} className="btn ghost small"
                  style={String(filters.sold_within_months) === String(m) ? { borderColor: GOLD, color: GOLD } : undefined}
                  onClick={() => apply({ sold_within_months: String(filters.sold_within_months) === String(m) ? '' : String(m), sold_from: '', sold_to: '' })}>
                  Last {m}m
                </button>
              ))}
            </div>
          </Field>

          <Field label="Condition (C1 is best, C6 is worst)">
            <Row>
              <select style={S.input} value={draft.condition_best}
                onChange={(e) => apply({ condition_best: e.target.value })}>
                <option value="">Best: any</option>
                {CONDITION_CODES.map((c) => <option key={c} value={c}>{c} or worse</option>)}
              </select>
              <select style={S.input} value={draft.condition_worst}
                onChange={(e) => apply({ condition_worst: e.target.value })}>
                <option value="">Worst: any</option>
                {CONDITION_CODES.map((c) => <option key={c} value={c}>{c} or better</option>)}
              </select>
            </Row>
          </Field>

          <Field label="How we know it">
            <select style={S.input} value={draft.role} onChange={(e) => apply({ role: e.target.value })}>
              <option value="">Anything we have seen</option>
              <option value="comparable">Used as a comparable sale</option>
              <option value="subject">One of our own subject properties</option>
            </select>
          </Field>

          <Field label="Which grid it was used on">
            <select style={S.input} value={draft.comp_set} onChange={(e) => apply({ comp_set: e.target.value })}>
              <option value="">Either grid</option>
              <option value="arv">After-repair (ARV) comps</option>
              <option value="as_is">As-is comps</option>
              <option value="unknown">Grid was never stated</option>
            </select>
          </Field>

          <label style={{ display: 'flex', gap: 7, alignItems: 'center', fontSize: 13, color: INK, marginTop: 8 }}>
            <input type="checkbox" checked={filters.has_sale === '1'}
              onChange={(e) => apply({ has_sale: e.target.checked ? '1' : '' })} />
            Only ones with a sale price
          </label>
          <label style={{ display: 'flex', gap: 7, alignItems: 'center', fontSize: 13, color: INK, marginTop: 5 }}>
            <input type="checkbox" checked={filters.has_photos === '1'}
              onChange={(e) => apply({ has_photos: e.target.checked ? '1' : '' })} />
            Only ones with a photo
          </label>

          {facets && facets.cities && facets.cities.length > 1 && (
            <div style={{ marginTop: 14 }}>
              <div style={S.label}>Towns in these results</div>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 5 }}>
                {facets.cities.slice(0, 14).map((c) => (
                  <button key={c.city + c.state} className="btn ghost small"
                    style={draft.city.toLowerCase() === String(c.city).toLowerCase() ? { borderColor: GOLD, color: GOLD } : undefined}
                    onClick={() => apply({ city: draft.city.toLowerCase() === String(c.city).toLowerCase() ? '' : c.city })}>
                    {c.city} ({c.n})
                  </button>
                ))}
              </div>
            </div>
          )}
        </aside>

        {/* ---------------- results ---------------- */}
        <section>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10, marginBottom: 8, flexWrap: 'wrap' }}>
            <div style={{ color: MUTED, fontSize: 14 }}>
              {busy ? 'Searching…' : `${num(meta.total)} ${meta.total === 1 ? 'property' : 'properties'}`}
              {meta.pages > 1 && !busy && <span> · page {meta.page} of {meta.pages}</span>}
            </div>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              <Link className="btn ghost small" to="/internal/research/appraisers">Appraisers</Link>
              <select style={{ ...S.input, width: 'auto' }} value={filters.sort}
                onChange={(e) => apply({ sort: e.target.value })}>
                <option value="recent_sale">Newest sale first</option>
                <option value="oldest_sale">Oldest sale first</option>
                <option value="price_desc">Highest price</option>
                <option value="price_asc">Lowest price</option>
                <option value="ppsf_desc">Highest $ per sq ft</option>
                <option value="ppsf_asc">Lowest $ per sq ft</option>
                <option value="sqft_desc">Biggest</option>
                <option value="address">By address</option>
              </select>
            </div>
          </div>

          {rows && rows.length === 0 && !busy && (
            <div className="card" style={{ color: MUTED }}>
              Nothing matched. Try widening the price or size range, or clearing the town.
              {stats && stats.pending > 0 && <> The database is still reading in {num(stats.pending)} reports, so more will appear.</>}
            </div>
          )}

          <div style={{ display: 'grid', gap: 8 }}>
            {(rows || []).map((r) => (
              <PropertyCard key={r.id} p={r} checked={picked.has(r.id)} onToggle={() => toggle(r)} />
            ))}
          </div>

          {meta.pages > 1 && (
            <div style={{ display: 'flex', gap: 8, justifyContent: 'center', marginTop: 14 }}>
              <button className="btn ghost small" disabled={meta.page <= 1}
                onClick={() => apply({ page: String(meta.page - 1) }, false)}>← Previous</button>
              <span style={{ color: MUTED, fontSize: 13, alignSelf: 'center' }}>{meta.page} / {meta.pages}</span>
              <button className="btn ghost small" disabled={meta.page >= meta.pages}
                onClick={() => apply({ page: String(meta.page + 1) }, false)}>Next →</button>
            </div>
          )}
        </section>
      </div>

      {/* ---------------- the selection tray ---------------- */}
      {picked.size > 0 && (
        <div style={{ position: 'sticky', bottom: 0, marginTop: 16, background: '#fff',
          border: '1px solid ' + GOLD, borderRadius: 10, padding: '10px 14px',
          display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap',
          boxShadow: '0 -2px 14px rgba(20,27,34,0.10)' }}>
          <strong style={{ color: INK }}>{picked.size} sale{picked.size === 1 ? '' : 's'} picked</strong>
          <span style={{ color: MUTED, fontSize: 13 }}>
            {[...picked.values()].map((p) => p.display_address).slice(0, 3).join(' · ')}
            {picked.size > 3 ? ` · +${picked.size - 3} more` : ''}
          </span>
          <div style={{ marginLeft: 'auto', display: 'flex', gap: 8 }}>
            <button className="btn ghost small" onClick={() => setPicked(new Map())}>Clear</button>
            <button className="btn btn-gold small" disabled={sending} onClick={buildValuation}>
              {sending ? 'Starting…' : 'Build a valuation from these →'}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function Field({ label, children }) {
  return <div style={{ marginBottom: 10 }}><label style={S.label}>{label}</label>{children}</div>;
}
function Row({ children }) {
  return <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6 }}>{children}</div>;
}
function MinMax({ label, lo, hi, draft, setDraft, apply, step }) {
  return (
    <Field label={label}>
      <Row>
        <input style={S.input} inputMode="numeric" step={step} placeholder="min" value={draft[lo]}
          onChange={(e) => setDraft({ ...draft, [lo]: e.target.value })}
          onKeyDown={(e) => { if (e.key === 'Enter') apply({ [lo]: draft[lo] }); }}
          onBlur={() => { if (draft[lo] !== undefined) apply({ [lo]: draft[lo] }); }} />
        <input style={S.input} inputMode="numeric" step={step} placeholder="max" value={draft[hi]}
          onChange={(e) => setDraft({ ...draft, [hi]: e.target.value })}
          onKeyDown={(e) => { if (e.key === 'Enter') apply({ [hi]: draft[hi] }); }}
          onBlur={() => { if (draft[hi] !== undefined) apply({ [hi]: draft[hi] }); }} />
      </Row>
    </Field>
  );
}

function PropertyCard({ p, checked, onToggle }) {
  const ppsf = p.last_sale_price && p.gla ? Number(p.last_sale_price) / Number(p.gla) : null;
  return (
    <div style={{ ...S.panel, padding: 12, display: 'grid',
      gridTemplateColumns: 'auto 1fr auto', gap: 12, alignItems: 'start',
      borderColor: checked ? GOLD : '#E4DECF' }}>
      <input type="checkbox" checked={checked} onChange={onToggle} style={{ marginTop: 3 }}
        aria-label={`Pick ${p.display_address}`} />
      <div>
        <Link to={`/internal/research/property/${p.id}`}
          style={{ color: INK, fontWeight: 700, fontSize: 15, textDecoration: 'none' }}>
          {p.display_address}
        </Link>
        <div style={{ color: MUTED, fontSize: 13, marginTop: 3, display: 'flex', gap: 12, flexWrap: 'wrap' }}>
          {p.beds != null && <span>{p.beds} bed</span>}
          {(p.baths_full != null || p.baths_half != null) && <span>{baths(p)} bath</span>}
          {p.gla != null && <span>{sqft(p.gla)}</span>}
          {p.year_built != null && <span>built {p.year_built}</span>}
          {p.units != null && p.units > 1 && <span>{p.units} units</span>}
          {p.property_type && <span>{p.property_type}</span>}
        </div>
        <div style={{ marginTop: 6, display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          {p.condition_uad && <span style={S.tag} title={conditionLabel(p.condition_uad)}>{p.condition_uad}</span>}
          {!p.condition_uad && p.condition_text && <span style={S.tag}>{p.condition_text}</span>}
          {p.quality_uad && <span style={S.tag}>{p.quality_uad}</span>}
          {p.arv_comp_count > 0 && <span style={{ ...S.tag, borderColor: GOLD, color: GOLD }}>Used as an ARV comp ×{p.arv_comp_count}</span>}
          {p.asis_comp_count > 0 && <span style={{ ...S.tag }}>Used as an as-is comp ×{p.asis_comp_count}</span>}
          {p.subject_count > 0 && <span style={{ ...S.tag, borderColor: '#2F7F86', color: '#2F7F86' }}>Our own file ×{p.subject_count}</span>}
          {p.photo_count > 0 && <span style={S.tag}>{p.photo_count} photo{p.photo_count === 1 ? '' : 's'}</span>}
          {p.distance_miles != null && <span style={S.tag}>{Number(p.distance_miles).toFixed(2)} mi</span>}
        </div>
      </div>
      <div style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
        <div style={{ fontSize: 18, fontWeight: 700, color: INK }}>{money(p.last_sale_price)}</div>
        <div style={{ color: MUTED, fontSize: 13 }}>
          {p.last_sale_status && p.last_sale_status !== 'closed'
            ? (p.last_sale_status === 'active' ? 'asking' : 'under contract') + ' · '
            : ''}
          {saleMonth(p.last_sale_date)}
        </div>
        {ppsf != null && <div style={{ color: MUTED, fontSize: 12 }}>${Math.round(ppsf)}/sq ft</div>}
      </div>
    </div>
  );
}
