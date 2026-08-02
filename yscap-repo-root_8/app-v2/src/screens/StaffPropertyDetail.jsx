import React, { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api } from '../lib/api.js';
import {
  INK, MUTED, GOLD, S, money, sqft, num, day, saleMonth, baths,
  conditionLabel, qualityLabel, COMP_SET_LABEL,
} from '../lib/research.js';
import NearbyComps from '../components/NearbyComps.jsx';

/* ONE PROPERTY — everything every appraisal ever said about it.

   The point of the page is PROVENANCE. The top block is the best-known answer
   for each fact; underneath, every report that ever described this property is
   listed with what IT said and when, so "where does that number come from?" is
   always one glance away. A property we have seen four times can disagree with
   itself, and that disagreement is information, not something to hide. */

export default function StaffPropertyDetail() {
  const { id } = useParams();
  const nav = useNavigate();
  const [data, setData] = useState(null);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const [shot, setShot] = useState(null);   // the enlarged photo

  useEffect(() => {
    setData(null); setErr('');
    api.researchProperty(id).then(setData).catch((e) => setErr(e.message || 'Could not load that property'));
  }, [id]);

  async function valueThis() {
    setBusy(true);
    try {
      const v = await api.valuationCreate({ property_id: id, title: `Value: ${data.property.display_address}` });
      nav(`/internal/research/valuation/${v.valuation.id}`);
    } catch (e) { setErr(e.message || 'Could not start a valuation'); setBusy(false); }
  }

  if (err) return <div className="card" style={{ borderColor: '#B4423A', color: '#B4423A' }}>{err}</div>;
  if (!data) return <div className="card" style={{ color: MUTED }}>Loading…</div>;

  const p = data.property;
  const photos = data.photos || [];
  const hero = photos.find((x) => x.is_primary) || photos[0] || null;

  return (
    <div>
      <div style={{ marginBottom: 10 }}>
        <Link to="/internal/research" style={{ color: MUTED, fontSize: 13 }}>← Back to Property Research</Link>
      </div>

      <header style={{ display: 'flex', gap: 16, alignItems: 'flex-start', flexWrap: 'wrap', marginBottom: 16 }}>
        {hero && (
          <img src={api.researchPhotoUrl(hero.document_id)} alt={p.display_address}
            onClick={() => setShot(hero)}
            style={{ width: 240, height: 170, objectFit: 'cover', borderRadius: 10, cursor: 'zoom-in',
              border: '1px solid #E4DECF' }} />
        )}
        <div style={{ flex: '1 1 320px' }}>
          <h1 style={{ margin: '0 0 4px', color: INK, fontSize: 24 }}>{p.display_address}</h1>
          <div style={{ color: MUTED, fontSize: 14 }}>
            {[p.county && `${p.county} County`, p.apn && `Parcel ${p.apn}`, p.neighborhood].filter(Boolean).join(' · ') || ' '}
          </div>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 10 }}>
            {p.subject_count > 0 && <span style={{ ...S.tag, borderColor: '#2F7F86', color: '#2F7F86' }}>
              We lent on this {p.subject_count === 1 ? 'once' : `${p.subject_count} times`}</span>}
            {p.comp_count > 0 && <span style={S.tag}>Used as a comparable {p.comp_count} time{p.comp_count === 1 ? '' : 's'}</span>}
            {p.arv_comp_count > 0 && <span style={{ ...S.tag, borderColor: GOLD, color: GOLD }}>ARV grid ×{p.arv_comp_count}</span>}
            {p.asis_comp_count > 0 && <span style={S.tag}>As-is grid ×{p.asis_comp_count}</span>}
          </div>
          <div style={{ marginTop: 12, display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <button className="btn btn-gold small" disabled={busy} onClick={valueThis}>
              {busy ? 'Starting…' : 'Value this property'}
            </button>
            <Link className="btn ghost small"
              to={`/internal/research?city=${encodeURIComponent(p.city || '')}&state=${encodeURIComponent(p.state || '')}`}>
              Other sales in {p.city || 'this town'}
            </Link>
          </div>
        </div>
        <div style={{ ...S.panel, minWidth: 200 }}>
          <div style={{ color: MUTED, fontSize: 12, fontWeight: 700 }}>LAST KNOWN SALE</div>
          <div style={{ fontSize: 26, fontWeight: 700, color: INK, lineHeight: 1.2 }}>{money(p.last_sale_price)}</div>
          <div style={{ color: MUTED, fontSize: 13 }}>{saleMonth(p.last_sale_date)}</div>
          {p.last_sale_price && p.gla && (
            <div style={{ color: MUTED, fontSize: 13, marginTop: 4 }}>
              ${Math.round(Number(p.last_sale_price) / Number(p.gla))} per sq ft
            </div>
          )}
          {p.last_list_price && (
            <div style={{ color: MUTED, fontSize: 12, marginTop: 6 }}>Last asking price {money(p.last_list_price)}</div>
          )}
        </div>
      </header>

      {/* ---- comparable sales near it ---- */}
      <NearbyComps propertyId={id} subjectAddress={p.display_address} />

      {/* ---- what we know about the property ---- */}
      <section style={{ ...S.panel, marginBottom: 14 }}>
        <h2 style={{ margin: '0 0 4px', fontSize: 16, color: INK }}>What we know about it</h2>
        <p style={{ margin: '0 0 12px', color: MUTED, fontSize: 13 }}>
          The most recent report that stated each fact. Where two reports disagree, the newer one wins here —
          the full history is in the reports below.
        </p>
        <dl style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(180px, 1fr))', gap: 12, margin: 0 }}>
          <Fact k="Property type" v={p.property_type} />
          <Fact k="Units" v={p.units} />
          <Fact k="Living area" v={p.gla ? sqft(p.gla) : null} />
          <Fact k="Bedrooms" v={p.beds} />
          <Fact k="Bathrooms" v={(p.baths_full != null || p.baths_half != null) ? baths(p) : p.baths_text} />
          <Fact k="Total rooms" v={p.total_rooms} />
          <Fact k="Year built" v={p.year_built} />
          <Fact k="Condition" v={p.condition_uad || p.condition_text ? conditionLabel(p.condition_uad, p.condition_text) : null} />
          <Fact k="Quality" v={p.quality_uad || p.quality_text ? qualityLabel(p.quality_uad, p.quality_text) : null} />
          <Fact k="Lot" v={p.lot_area || (p.lot_sqft ? sqft(p.lot_sqft) : null)} />
          <Fact k="Basement" v={p.basement_sqft ? sqft(p.basement_sqft) : null} />
          <Fact k="Garage" v={[p.garage_type, p.garage_spaces && `${p.garage_spaces} space${p.garage_spaces === 1 ? '' : 's'}`].filter(Boolean).join(' · ') || null} />
          <Fact k="Heating" v={p.heating_type} />
          <Fact k="Cooling" v={p.cooling} />
          <Fact k="Style" v={p.design_style} />
          <Fact k="Stories" v={p.stories} />
          {/* db/413 — facts the reports have always stated. A flood determination
              is THREE-STATE: "no" is an answer worth showing, and blank means no
              report has said either way. */}
          <Fact k="Flood zone" v={p.sfha === true
            ? `${p.flood_zone || p.fema_flood_zone || 'yes'} — in a flood zone`
            : (p.sfha === false ? `${p.flood_zone || p.fema_flood_zone || 'X'} — not in a flood zone` : p.flood_zone)} />
          <Fact k="Held as" v={p.property_rights} />
          <Fact k="Occupancy" v={p.occupancy_status} />
          <Fact k="Lot shape" v={p.lot_shape} />
          <Fact k="Lot dimensions" v={p.lot_dimensions} />
          <Fact k="Basement finished" v={p.basement_finished_pct == null ? null : `${Number(p.basement_finished_pct)}%`} />
          <Fact k="Attic" v={p.attic === true ? 'Yes' : (p.attic === false ? 'No' : null)} />
          <Fact k="Extra dwelling unit" v={p.has_adu === true ? 'Yes' : (p.has_adu === false ? 'No' : null)} />
          <Fact k="Heating fuel" v={p.heating_fuel} />
          <Fact k="Remaining life" v={p.remaining_economic_life ? `${p.remaining_economic_life} years` : null} />
          <Fact k="Floor" v={p.condo_floor} />
          <Fact k="Zoning" v={p.zoning_id || p.zoning_desc} />
          <Fact k="Market rent" v={p.market_rent ? money(p.market_rent) + ' / month' : null} />
          <Fact k="Owner of record" v={p.owner_of_record} />
          <Fact k="HOA fee" v={p.hoa_fee_amount ? `${money(p.hoa_fee_amount)}${p.hoa_fee_period ? ' / ' + String(p.hoa_fee_period).toLowerCase() : ''}` : null} />
          <Fact k="First seen" v={day(p.first_observed_on)} />
          <Fact k="Last seen" v={day(p.last_observed_on)} />
        </dl>
      </section>

      {/* ---- photos ---- */}
      {photos.length > 0 && (
        <section style={{ ...S.panel, marginBottom: 14 }}>
          <h2 style={{ margin: '0 0 10px', fontSize: 16, color: INK }}>Photos ({photos.length})</h2>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            {photos.map((ph) => (
              <figure key={ph.id} style={{ margin: 0, width: 150 }}>
                <img src={api.researchPhotoUrl(ph.document_id)} alt={ph.caption || 'Property photo'}
                  onClick={() => setShot(ph)}
                  style={{ width: 150, height: 110, objectFit: 'cover', borderRadius: 8,
                    border: '1px solid #E4DECF', cursor: 'zoom-in' }} />
                <figcaption style={{ fontSize: 11, color: MUTED, marginTop: 3 }}>
                  {ph.caption || (ph.category || '').replace(/_/g, ' ') || 'photo'}
                </figcaption>
              </figure>
            ))}
          </div>
        </section>
      )}

      {/* ---- sales ---- */}
      <section style={{ ...S.panel, marginBottom: 14 }}>
        <h2 style={{ margin: '0 0 4px', fontSize: 16, color: INK }}>Sales we know about ({(data.sales || []).length})</h2>
        <p style={{ margin: '0 0 10px', color: MUTED, fontSize: 13 }}>
          Every transaction any of our appraisal reports has told us about — the sale itself, an earlier
          sale the appraiser researched, or a purchase that was under contract.
        </p>
        {(data.sales || []).length === 0
          ? <div style={{ color: MUTED, fontSize: 13 }}>No sale has been recorded for this property.</div>
          : (
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead><tr>
                <th style={S.th}>When</th><th style={S.th}>Price</th><th style={S.th}>Kind</th>
                <th style={S.th}>Status</th><th style={S.th}>How we know</th>
              </tr></thead>
              <tbody>
                {data.sales.map((s, i) => (
                  <tr key={i}>
                    <td style={S.cell}>{saleMonth(s.sale_date)}</td>
                    <td style={{ ...S.cell, fontWeight: 700 }}>{money(s.sale_price)}</td>
                    <td style={S.cell}>{s.sale_type || '—'}</td>
                    <td style={S.cell}>{s.sale_status === 'closed' ? 'Closed sale'
                      : s.sale_status === 'active' ? 'Was for sale (asking price)'
                        : s.sale_status === 'pending' ? 'Under contract' : (s.sale_status || '—')}</td>
                    <td style={{ ...S.cell, color: MUTED }}>{SOURCE_LABEL[s.source] || s.source}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
      </section>

      {/* ---- every report that mentioned it ---- */}
      <section style={S.panel}>
        <h2 style={{ margin: '0 0 4px', fontSize: 16, color: INK }}>
          Every report that mentioned it ({(data.observations || []).length})
        </h2>
        <p style={{ margin: '0 0 12px', color: MUTED, fontSize: 13 }}>
          What each appraiser said about this property, on the day they said it.
        </p>
        <div style={{ display: 'grid', gap: 10 }}>
          {(data.observations || []).map((o) => <Observation key={o.id} o={o} />)}
        </div>
      </section>

      {shot && (
        <div onClick={() => setShot(null)} role="dialog" aria-label="Photo"
          style={{ position: 'fixed', inset: 0, background: 'rgba(20,27,34,0.85)', zIndex: 900,
            display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'zoom-out', padding: 24 }}>
          <img src={api.researchPhotoUrl(shot.document_id)} alt={shot.caption || 'Property photo'}
            style={{ maxWidth: '95%', maxHeight: '90%', borderRadius: 8 }} />
        </div>
      )}
    </div>
  );
}

const SOURCE_LABEL = {
  comp_sale: 'used as a comparable sale on one of our appraisals',
  comp_prior_sale: 'the appraiser researched this earlier sale of a comparable',
  subject_prior_sale: 'the earlier sale researched on our own appraisal',
  subject_contract: 'the purchase under contract on our loan file',
};

function Fact({ k, v }) {
  return (
    <div>
      <dt style={{ fontSize: 11, color: MUTED, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.02em' }}>{k}</dt>
      <dd style={{ margin: '2px 0 0', fontSize: 14, color: v == null || v === '' ? MUTED : INK }}>
        {v == null || v === '' ? '—' : String(v)}
      </dd>
    </div>
  );
}

function Observation({ o }) {
  const isSubject = o.role === 'subject';
  return (
    <div style={{ border: '1px solid #EEE9DD', borderRadius: 8, padding: 10 }}>
      <div style={{ display: 'flex', gap: 10, alignItems: 'baseline', flexWrap: 'wrap' }}>
        <strong style={{ color: INK, fontSize: 14 }}>
          {isSubject ? 'Our own appraisal (this was the subject)' : `Used as comparable #${o.comp_seq || '?'}`}
        </strong>
        <span style={{ color: MUTED, fontSize: 13 }}>{day(o.observed_on)}</span>
        {o.appraiser_name && (
          <Link to={`/internal/research/appraiser/${o.appraiser_id}`} style={{ fontSize: 13, color: GOLD }}>
            {o.appraiser_name}
          </Link>
        )}
        {o.report_form && <span style={S.tag}>{o.report_form}</span>}
        {!isSubject && o.comp_set && <span style={S.tag}>{COMP_SET_LABEL[o.comp_set] || o.comp_set}</span>}
        {o.comp_set_needs_review && <span style={{ ...S.tag, borderColor: GOLD, color: GOLD }}>grid split needs a look</span>}
        {o.application_id && (
          <Link to={`/internal/app/${o.application_id}`} style={{ fontSize: 13, color: MUTED }}>
            on file {o.ys_loan_number || 'open'} →
          </Link>
        )}
      </div>
      <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap', marginTop: 6, fontSize: 13, color: MUTED }}>
        {o.sale_price != null && <span><b style={{ color: INK }}>{money(o.sale_price)}</b> {saleMonth(o.sale_date)}</span>}
        {o.gla != null && <span>{sqft(o.gla)}{o.gla_basis === 'gba' ? ' (whole building)' : ''}</span>}
        {o.beds != null && <span>{o.beds} bed</span>}
        {o.baths_text && <span>{o.baths_text} bath</span>}
        {o.year_built != null && <span>built {o.year_built}</span>}
        {(o.condition_uad || o.condition_text) && (
          <span>condition {conditionLabel(o.condition_uad, o.condition_text)}
            {o.condition_basis === 'as_repaired' && ' (after the repairs)'}</span>
        )}
        {(o.quality_uad || o.quality_text) && <span>quality {qualityLabel(o.quality_uad, o.quality_text)}</span>}
        {o.proximity && <span>{o.proximity} from that subject</span>}
        {o.days_on_market && <span>{o.days_on_market} days on market</span>}
        {o.data_source && <span>{o.data_source}</span>}
      </div>
      {isSubject && (o.as_is_value || o.arv_value || o.appraised_value) && (
        <div style={{ marginTop: 6, fontSize: 13, color: MUTED, display: 'flex', gap: 14, flexWrap: 'wrap' }}>
          {o.appraised_value != null && <span>Appraised <b style={{ color: INK }}>{money(o.appraised_value)}</b></span>}
          {o.as_is_value != null && <span>As-is <b style={{ color: INK }}>{money(o.as_is_value)}</b></span>}
          {o.arv_value != null && <span>After repair <b style={{ color: INK }}>{money(o.arv_value)}</b></span>}
          {o.contract_price != null && <span>Contract {money(o.contract_price)}</span>}
        </div>
      )}
      {Array.isArray(o.adjustments) && o.adjustments.length > 0 && (
        <details style={{ marginTop: 6 }}>
          <summary style={{ fontSize: 12, color: MUTED, cursor: 'pointer' }}>
            What the appraiser adjusted ({o.adjustments.length} line{o.adjustments.length === 1 ? '' : 's'},
            {o.gross_adj_pct != null ? ` ${Number(o.gross_adj_pct).toFixed(0)}% in total` : ''})
          </summary>
          <div style={{ marginTop: 6, display: 'grid', gap: 3 }}>
            {o.adjustments.map((a, i) => (
              <div key={i} style={{ fontSize: 12, color: MUTED, display: 'flex', gap: 8 }}>
                <span style={{ minWidth: 150, color: INK }}>{a.type || '—'}</span>
                <span style={{ minWidth: 130 }}>{a.description || ''}</span>
                <span style={{ fontWeight: 700, color: Number(a.amount) < 0 ? '#B4423A' : INK }}>
                  {a.amount == null ? '' : (Number(a.amount) > 0 ? '+' : '') + money(a.amount)}
                </span>
              </div>
            ))}
          </div>
        </details>
      )}
      {Array.isArray(o.unit_mix) && o.unit_mix.length > 0 && (
        <details style={{ marginTop: 6 }}>
          <summary style={{ fontSize: 12, color: MUTED, cursor: 'pointer' }}>Rent roll ({o.unit_mix.length} units)</summary>
          <table style={{ marginTop: 6, borderCollapse: 'collapse' }}>
            <thead><tr>
              <th style={S.th}>Unit</th><th style={S.th}>Beds</th><th style={S.th}>Baths</th>
              <th style={S.th}>Size</th><th style={S.th}>Rent now</th><th style={S.th}>Market rent</th>
            </tr></thead>
            <tbody>
              {o.unit_mix.map((u, i) => (
                <tr key={i}>
                  <td style={S.cell}>{u.unit_seq || i + 1}</td>
                  <td style={S.cell}>{u.beds ?? '—'}</td>
                  <td style={S.cell}>{u.baths ?? '—'}</td>
                  <td style={S.cell}>{u.sqft ? sqft(u.sqft) : '—'}</td>
                  <td style={S.cell}>{u.actual_rent ? money(u.actual_rent) : '—'}</td>
                  <td style={S.cell}>{u.market_rent ? money(u.market_rent) : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </details>
      )}
    </div>
  );
}
