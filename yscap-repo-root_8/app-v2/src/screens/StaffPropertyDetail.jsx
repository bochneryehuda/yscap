import React, { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api } from '../lib/api.js';
import {
  INK, MUTED, GOLD, S, money, sqft, num, day, saleMonth, baths,
  conditionLabel, conditionRead, qualityLabel, COMP_SET_LABEL,
} from '../lib/research.js';
import NearbyComps from '../components/NearbyComps.jsx';
import ResearchPhoto from '../components/ResearchPhoto.jsx';
import { uadWords } from '../lib/uadWords.js';
import ResearchNav from '../components/ResearchNav.jsx';
import { askConfirm } from '../lib/dialog.js';

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

  // A NAMED LOADER, not an anonymous effect body, so anything that changes this
  // property (a merge folds another row's observations into it) can ask for the
  // page to be re-read rather than leaving the facts on screen describing the
  // state before the change.
  const load = useCallback(() => {
    setData(null); setErr('');
    api.researchProperty(id).then(setData).catch((e) => {
      // THIS PROPERTY WAS MERGED INTO ANOTHER ROW. The server deliberately answers
      // 301 with `merged_into` so a bookmarked or emailed link says where the
      // property went instead of reading as data loss — but nothing was reading
      // it, so the page showed the user the single word "merged". Follow it, and
      // replace the history entry so Back does not bounce off the dead id.
      if (e && e.status === 301 && e.data && e.data.merged_into) {
        nav(`/internal/research/property/${e.data.merged_into}`, { replace: true });
        return;
      }
      setErr(e.message || 'Could not load that property');
    });
  }, [id, nav]);
  useEffect(() => { load(); }, [load]);

  async function valueThis() {
    setBusy(true);
    try {
      const v = await api.valuationCreate({ property_id: id, title: `Value: ${data.property.display_address}` });
      nav(`/internal/research/valuation/${v.valuation.id}`);
    } catch (e) { setErr(e.message || 'Could not start a valuation'); setBusy(false); }
  }

  /* THE SECTION'S PAGE STRIP SURVIVES LOADING AND FAILURE. It used to sit below
     these early returns, so it flickered out on every navigation here and vanished
     entirely on an error — leaving somebody on a dead-end page with no way back
     into the section except the sidebar. The strip is not about this page's data,
     so it does not wait for it. */
  if (err) return (<div><ResearchNav /><div className="card" style={{ borderColor: '#B4423A', color: '#B4423A' }}>{err}</div></div>);
  if (!data) return (<div><ResearchNav /><div className="card" style={{ color: MUTED }}>Loading…</div></div>);

  const p = data.property;
  const photos = data.photos || [];
  const hero = photos.find((x) => x.is_primary) || photos[0] || null;

  return (
    <div>
      <ResearchNav />
      <div style={{ marginBottom: 10 }}>
        <Link to="/internal/research" style={{ color: MUTED, fontSize: 13 }}>← Back to Property Research</Link>
      </div>

      <header style={{ display: 'flex', gap: 16, alignItems: 'flex-start', flexWrap: 'wrap', marginBottom: 16 }}>
        {/* The appraiser's own photograph when the warehouse holds one; otherwise
            the street, clearly labelled as the street (see ResearchPhoto). */}
        <ResearchPhoto documentId={hero && hero.document_id} alt={p.display_address}
          streetAddress={[p.display_address, p.city, p.state].filter(Boolean).join(', ')}
          onClick={hero ? () => setShot(hero) : undefined}
          style={{ width: 240, height: 170, objectFit: 'cover', borderRadius: 10,
            cursor: hero ? 'zoom-in' : 'default', border: '1px solid #E4DECF' }} />
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

      {/* ---- valuations already built on this property ---- */}
      <PriorValuations propertyId={id} />

      {/* ---- comparable sales near it ---- */}
      <NearbyComps propertyId={id} subjectAddress={p.display_address} />

      {/* ---- where the reports disagree about this house ---- */}
      <Conflicts list={data.conflicts || []} />

      {/* ---- another row that may be this same house ---- */}
      <MaybeSameHouse propertyId={id} onMerged={load} />

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
          <Fact k="Condition" v={p.condition_uad || p.condition_text ? conditionRead(p) : null} />
          <Fact k="Quality" v={p.quality_uad || p.quality_text ? qualityLabel(p.quality_uad, p.quality_text) : null} />
          <Fact k="Lot" v={p.lot_area || (p.lot_sqft ? sqft(p.lot_sqft) : null)} />
          <Fact k="Basement" v={p.basement_sqft ? sqft(p.basement_sqft) : null} />
          <Fact k="Garage" v={[p.garage_type, p.garage_spaces && `${p.garage_spaces} space${p.garage_spaces === 1 ? '' : 's'}`].filter(Boolean).join(' · ') || null} />
          <Fact k="Heating" v={p.heating_type} />
          <Fact k="Cooling" v={p.cooling} />
          <Fact k="Style" v={p.design_style} />
          <Fact k="Stories" v={p.stories} />
          {/* db/414 — facts the reports have always stated. A flood determination
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
          {/* db/437 — WHAT IS ACTUALLY DOWN THERE, beside how big it is. The
              bedroom and bathroom counts above are the ABOVE-grade ones the
              appraisal grid states, and the form separates them because a
              basement bedroom is not a bedroom — 800 finished feet is two
              bedrooms or it is a boiler room, and only these say which. A stated
              ZERO is shown: "no bedrooms down there" is an answer, and it reads
              differently from a blank. */}
          <Fact k="Basement rooms" v={(() => {
            const bits = [];
            if (p.below_grade_beds != null) bits.push(`${p.below_grade_beds} bed${p.below_grade_beds === 1 ? '' : 's'}`);
            if (p.below_grade_baths_full != null || p.below_grade_baths_half != null) {
              const f = p.below_grade_baths_full || 0; const h = p.below_grade_baths_half || 0;
              bits.push(`${f}${h ? `.${h}` : ''} bath${f === 1 && !h ? '' : 's'}`);
            }
            // `!= null`, NOT truthiness — the comment above promises a stated zero
            // shows, and 16 corpus comparables state 0 rec rooms while 62 state 0
            // other rooms. Truthiness swallowed every one of them.
            if (p.below_grade_rec_rooms != null) bits.push(`${p.below_grade_rec_rooms} rec`);
            if (p.below_grade_other_rooms != null) bits.push(`${p.below_grade_other_rooms} other`);
            return bits.length ? bits.join(' · ') : null;
          })()} />
          <Fact k="Basement exit" v={p.basement_exit === 'WalkOut' ? 'Walk-out'
            : p.basement_exit === 'WalkUp' ? 'Walk-up'
              : p.basement_exit === 'InteriorOnly' ? 'Inside only' : p.basement_exit} />
          <Fact k="Below-grade area" v={p.below_grade_sqft ? sqft(p.below_grade_sqft) : null} />
          {/* THE THING AND THE VERDICT ON IT ARE TWO DIFFERENT FACTS, and this
              screen used to render only the first — so once the UAD reader
              started filing `Average` where it belongs (the RATING column, since
              "Average" judges a location rather than naming one), 98 comparables
              went from showing a word here to showing nothing. The fact never
              left; the screen was only ever reading half of it. `similar` and
              `INFERIOR` are gone for good and should be: they say how this
              compared with THAT report's subject, which is not a location. */}
          {/* …and a value the UAD reader REFUSED is still the raw grid cell
              ("N;Res;"), so it is never printed as if it were words — see
              `lib/uadWords`. */}
          <Fact k="View" v={p.view_type || p.view_rating ? uadWords(p.view_rating, p.view_type) : null} />
          {/* The price-relevant half of the same fix — "Residential; BusyRoad".
              24 corpus comparables gain a second location factor against 10 on
              the view side, and it reached no screen at all. `Adverse` is the
              one an underwriter needs and it was the most invisible of all. */}
          <Fact k="Location"
            v={p.location_type || p.location_rating ? uadWords(p.location_rating, p.location_type) : null} />
          {/* db/439 — the appraiser's own words for whether the layout works. */}
          <Fact k="Functional utility" v={p.functional_utility} />
          <Fact k="Attic" v={p.attic === true ? 'Yes' : (p.attic === false ? 'No' : null)} />
          <Fact k="Extra dwelling unit" v={p.has_adu === true ? 'Yes' : (p.has_adu === false ? 'No' : null)} />
          <Fact k="Heating fuel" v={p.heating_fuel} />
          <Fact k="Remaining life" v={p.remaining_economic_life ? `${p.remaining_economic_life} years` : null} />
          <Fact k="Floor" v={p.condo_floor} />
          <Fact k="Zoning" v={p.zoning_id || p.zoning_desc} />
          <Fact k="Market rent" v={p.market_rent ? money(p.market_rent) + ' / month' : null} />
          <Fact k="Owner of record" v={p.owner_of_record} />
          <Fact k="HOA fee" v={p.hoa_fee_amount ? `${money(p.hoa_fee_amount)}${p.hoa_fee_period ? ' / ' + String(p.hoa_fee_period).toLowerCase() : ''}` : null} />
          {/* db/448 + db/450. A fact you can FILTER on but never SEE is half a
              feature — the tax search shipped without a tax column, so a search
              on the tax bill returned rows that never said what the tax bill was. */}
          <Fact k="Attached / detached" v={p.attachment_type} />
          <Fact k="Property tax" v={p.property_tax_amount
            ? `${money(p.property_tax_amount)}${p.property_tax_year ? ' (' + p.property_tax_year + ')' : ''}` : null} />
          <Fact k="Condo project" v={p.condo_project_name} />
          <Fact k="Project type" v={p.condo_project_type} />
          <Fact k="Units planned" v={p.condo_units_planned} />
          <Fact k="Parking spaces" v={p.condo_parking_spaces} />
          <Fact k="Common elements" v={p.condo_common_elements} />
          <Fact k="Managed by" v={p.condo_management_type} />
          <Fact k="Effective age" v={p.effective_age ? `${p.effective_age} years` : null} />
          <Fact k="Foundation" v={p.foundation_type} />
          <Fact k="Neighbourhood" v={p.neighborhood} />
          {/* The cost approach. AS-IS ONLY (db/450): a renovation report states
              these about the FINISHED house, so the roll-up refuses them there —
              which is why "condition C5" and "no depreciation" can no longer
              appear on one row. */}
          <Fact k="Cost new" v={p.cost_new_total ? money(p.cost_new_total) : null} />
          <Fact k="Depreciation" v={p.depreciation_total != null ? money(p.depreciation_total) : null} />
          <Fact k="Depreciated improvements" v={p.depreciated_cost_improvements ? money(p.depreciated_cost_improvements) : null} />
          <Fact k="Site improvements" v={p.site_improvements_value ? money(p.site_improvements_value) : null} />
          <Fact k="Cost quality grade" v={p.cost_quality_rating} />
          <Fact k="Building status" v={p.building_status} />
          <Fact k="Zoning compliance" v={p.zoning_compliance_note} />
          <Fact k="Noted deficiency" v={p.physical_deficiency_note} />
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
                <ResearchPhoto documentId={ph.document_id} alt={ph.caption || 'Property photo'}
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
          <ResearchPhoto documentId={shot.document_id} alt={shot.caption || 'Property photo'}
            style={{ maxWidth: '95%', maxHeight: '90%', borderRadius: 8 }} />
        </div>
      )}
    </div>
  );
}

/* VALUATIONS ALREADY BUILT ON THIS PROPERTY.
 *
 * Without this there is no way back to one. "Value this property" creates a
 * valuation and navigates to it; after that the only route back was browser
 * history, so twenty minutes of grid work disappeared from the UI the moment
 * anyone clicked away. `GET /valuations?property_id=` already returned
 * everything needed and had no caller anywhere in the app.
 *
 * Self-hiding: a property nobody has valued shows nothing at all. */
/* WHERE TWO REPORTS DISAGREE ABOUT THIS HOUSE.

   The block above shows ONE answer per fact — the best-sourced, most recent
   reading — which is what you want for "what do we think this house is", and it
   necessarily throws away the fact that the reports did not agree. This hands
   that back. It is a review signal nobody else can compute, because nobody else
   holds several appraisals of one property.

   NOT AN ACCUSATION. Two appraisers are allowed to differ, and the tolerances
   are set so that rounding never appears here: a year built one apart is
   silence, twenty is a card. Nothing here resolves anything — a person decides,
   or decides both readings are fine. */
/* TWO ROWS, ONE HOUSE — and the door a person answers it through.

   The address key already folds two SPELLINGS of one address; this covers only
   what the key cannot reach on its own — a report that named the town against
   one that gave only a ZIP, an address with a unit number against one without,
   two rows the geocoder put on the same point.

   IT IS ADVISORY BY DESIGN: "nothing here is ever merged without a person saying
   so", because folding two DIFFERENT houses corrupts every price-per-foot
   reading in the warehouse and no re-ingest undoes it. The detection, the merge
   and the "these really are two different houses" record were all built and
   wired to three endpoints — and no screen ever called them, so the pairs were
   found and then nobody could answer them either way.

   THE MERGE IS THE MOST DESTRUCTIVE ACTION IN HERE — it deletes a row — so the
   panel never picks a side for you: it shows what each row holds, asks which one
   stays, and confirms. "Not the same house" is offered just as prominently,
   because on the unit-number pairs it is usually the right answer. */
function MaybeSameHouse({ propertyId, onMerged }) {
  const [rows, setRows] = useState(null);
  const [busy, setBusy] = useState('');
  const [err, setErr] = useState('');

  const load = useCallback(() => {
    api.researchDuplicates({ property_id: propertyId })
      .then((d) => setRows(d.rows || [])).catch(() => setRows([]));
  }, [propertyId]);
  useEffect(() => { load(); }, [load]);

  // `platform_setup` gates both actions server-side; a staffer without it gets a
  // plain refusal rather than a silent failure.
  async function act(key, fn, after) {
    setBusy(key); setErr('');
    try { await fn(); after(); }
    catch (e) { setErr(e.message || 'That did not work'); }
    finally { setBusy(''); }
  }

  if (!rows || !rows.length) return null;
  return (
    <section style={{ ...S.panel, marginBottom: 14, borderColor: GOLD }}>
      <h2 style={{ margin: '0 0 4px', fontSize: 16, color: INK }}>
        {rows.length === 1 ? 'Another row may be this same house' : `${rows.length} other rows may be this same house`}
      </h2>
      <p style={{ margin: '0 0 12px', color: MUTED, fontSize: 13, maxWidth: 760, lineHeight: 1.5 }}>
        Nothing is joined up until somebody says so. Joining two rows that are really different
        houses would put one house&rsquo;s sales onto another and cannot be undone, so read both
        before choosing — and if they are genuinely different, say that instead and the pair stops
        coming back.
      </p>
      {err && <div style={{ color: '#B4423A', fontSize: 13, marginBottom: 8 }}>{err}</div>}
      {rows.map((r) => {
        // The OTHER row is whichever side of the pair is not the property we are on.
        // A PAIR THAT IS NOT ABOUT THIS PROPERTY IS NOT SHOWN. The derivation
        // below falls through to `a_id`, so a stale or foreign row would bind the
        // merge buttons to an unrelated property and "keep THIS page" would
        // DELETE a stranger's row — which nothing undoes. The parent unmounts
        // this panel before the id changes, so it is not reachable today; the
        // guard costs one line and removes an unrecoverable failure mode.
        if (r.a_id !== propertyId && r.b_id !== propertyId) return null;
        const otherId = r.a_id === propertyId ? r.b_id : r.a_id;
        const otherAddr = r.a_id === propertyId ? r.b_address : r.a_address;
        const otherSeen = r.a_id === propertyId ? r.b_observations : r.a_observations;
        const mineSeen = r.a_id === propertyId ? r.a_observations : r.b_observations;
        const key = otherId;
        return (
          <div key={key} style={{ borderTop: '1px solid #EEE9DD', paddingTop: 10, marginTop: 10 }}>
            <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center' }}>
              <Link to={`/internal/research/property/${otherId}`}
                style={{ color: INK, fontWeight: 600, textDecoration: 'none' }}>{otherAddr}</Link>
              <span style={{ ...S.tag, borderColor: r.confidence === 'high' ? GOLD : '#B4423A',
                color: r.confidence === 'high' ? INK : '#B4423A' }}>{r.confidence}</span>
            </div>
            <div style={{ color: MUTED, fontSize: 13, marginTop: 3 }}>{r.why}</div>
            <div style={{ color: MUTED, fontSize: 12, marginTop: 3 }}>
              this page: {num(mineSeen)} report{Number(mineSeen) === 1 ? '' : 's'} ·
              {' '}that one: {num(otherSeen)} report{Number(otherSeen) === 1 ? '' : 's'}
            </div>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 8 }}>
              <button className="btn ghost small" disabled={!!busy}
                title="Everything the other row knows moves onto this page, and that row is removed."
                onClick={async () => {
                  if (!(await askConfirm(`Join these into ONE house, keeping this page?\n\n${otherAddr}\nwill be removed and everything it knows moves here. This cannot be undone.`))) return;
                  act(`m${key}`, () => api.researchMergeProps(
                    { survivor_id: propertyId, merged_id: otherId, cause: r.cause }), onMerged);
                }}>
                {busy === `m${key}` ? 'Joining…' : 'Same house — keep THIS page'}
              </button>
              <button className="btn ghost small" disabled={!!busy}
                title="Everything this page knows moves onto the other row, and this page is removed."
                onClick={async () => {
                  if (!(await askConfirm(`Join these into ONE house, keeping the other row?\n\nThis page will be removed and everything it knows moves to ${otherAddr}. This cannot be undone.`))) return;
                  act(`o${key}`, () => api.researchMergeProps(
                    { survivor_id: otherId, merged_id: propertyId, cause: r.cause }), onMerged);
                }}>
                {busy === `o${key}` ? 'Joining…' : 'Same house — keep the OTHER one'}
              </button>
              <button className="btn ghost small" disabled={!!busy}
                title="Records that you checked and they are different houses, so this pair stops being raised."
                onClick={() => act(`n${key}`, () => api.researchNotDup(
                  { property_id: propertyId, other_property_id: otherId }), load)}>
                {busy === `n${key}` ? 'Saving…' : 'Not the same house'}
              </button>
            </div>
          </div>
        );
      })}
    </section>
  );
}

/** How many REPORTS said it — one appraisal can describe a house several times. */
function reportCount(saidBy) {
  const ids = new Set();
  let unattributed = 0;
  for (const s of (saidBy || [])) {
    // A row with no appraisal id cannot be proven to share a report with any
    // other, so it counts as its own.
    if (s.appraisal_id) ids.add(s.appraisal_id); else unattributed += 1;
  }
  return ids.size + unattributed;
}

function Conflicts({ list }) {
  if (!list || !list.length) return null;
  const TONE = { high: '#B4423A', medium: GOLD, low: MUTED };
  return (
    <section style={{ ...S.panel, marginBottom: 14, borderColor: GOLD }}>
      <h2 style={{ margin: '0 0 4px', fontSize: 16, color: INK }}>
        {/* The heading must not claim the REPORTS disagree when the only entry is
            one report disagreeing with itself — that is the exact sentence this
            panel was corrected for saying. */}
        {list.every((c) => c.within_report)
          ? `Something to check on ${list.length === 1 ? 'one thing' : `${list.length} things`}`
          : `The reports don’t agree on ${list.length === 1 ? 'one thing' : `${list.length} things`}`}
      </h2>
      <p style={{ margin: '0 0 12px', color: MUTED, fontSize: 13 }}>
        Where two appraisals describe this property differently, neither is presumed wrong —
        small differences are already ignored, so what is here is worth a look.
      </p>
      <div style={{ display: 'grid', gap: 10 }}>
        {list.map((c) => (
          <div key={c.field} style={{ border: '1px solid #E4DECF', borderRadius: 8, padding: 10 }}>
            <div style={{ display: 'flex', gap: 8, alignItems: 'baseline', flexWrap: 'wrap' }}>
              <strong style={{ color: INK, fontSize: 14 }}>{c.label}</strong>
              <span style={{ ...S.tag, borderColor: TONE[c.severity] || MUTED, color: TONE[c.severity] || MUTED }}>
                {c.severity === 'high' ? 'worth checking' : c.severity === 'medium' ? 'worth a look' : 'minor'}
              </span>
            </div>
            <div style={{ marginTop: 6, display: 'flex', gap: 14, flexWrap: 'wrap' }}>
              {c.values.map((v, i) => (
                <div key={i} style={{ minWidth: 120 }}>
                  <div style={{ fontSize: 18, color: INK, fontWeight: 600 }}>
                    {/* A within-report entry states the SEVERAL things that one
                        report said; a cross-report entry states one value. */}
                    {v.said ? v.said.join(' and ') : String(v.value)}
                  </div>
                  <div style={{ color: MUTED, fontSize: 12 }}>
                    {/* REPORTS, NOT ROWS. `said_by` holds one entry per
                        OBSERVATION, and the whole point of the grouping behind
                        this panel is that one report contributes several — a
                        report that listed the house as comp #3 and again as comp
                        #4 rendered as "2 reports", which is the same over-claim
                        the grouping exists to kill, moved one layer up. */}
                    {reportCount(v.said_by)} report{reportCount(v.said_by) === 1 ? '' : 's'}
                    {v.said_by[0] && v.said_by[0].observed_on ? ` · ${day(v.said_by[0].observed_on)}` : ''}
                  </div>
                </div>
              ))}
            </div>
            <div style={{ marginTop: 6, color: MUTED, fontSize: 12 }}>{c.note || c.why}</div>
            {!c.within_report && c.reports_inconsistent > 0 && (
              <div style={{ marginTop: 4, color: MUTED, fontSize: 12 }}>
                {c.reports_inconsistent} other report{c.reports_inconsistent === 1 ? '' : 's'} could not be
                compared here — {c.reports_inconsistent === 1 ? 'it describes' : 'they each describe'} this
                property two different ways.
              </div>
            )}
          </div>
        ))}
      </div>
    </section>
  );
}

function PriorValuations({ propertyId }) {
  const [rows, setRows] = useState(null);
  useEffect(() => {
    let alive = true;
    api.valuations({ property_id: propertyId })
      .then((d) => { if (alive) setRows(d.rows || []); })
      .catch(() => { if (alive) setRows([]); });
    return () => { alive = false; };
  }, [propertyId]);

  if (!rows || !rows.length) return null;
  return (
    <section style={{ ...S.panel, marginBottom: 14 }}>
      <h2 style={{ margin: '0 0 4px', fontSize: 16, color: INK }}>Valuations built on this property ({rows.length})</h2>
      <p style={{ margin: '0 0 10px', color: MUTED, fontSize: 13 }}>
        Grids somebody has built here before. Open one to carry on where they left off.
      </p>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        {rows.map((v) => (
          <Link key={v.id} to={`/internal/research/valuation/${v.id}`}
            style={{ display: 'flex', gap: 12, alignItems: 'baseline', flexWrap: 'wrap',
              padding: '8px 10px', border: '1px solid #E4DECF', borderRadius: 8, textDecoration: 'none' }}>
            <strong style={{ color: INK }}>{v.title || v.subject_address || 'Untitled valuation'}</strong>
            {v.indicated_value != null && <span style={{ color: INK }}>{money(v.indicated_value)}</span>}
            {v.confidence_label && <span style={S.tag}>{v.confidence_label}</span>}
            {v.status === 'final' && <span style={S.tag}>final</span>}
            <span style={{ color: MUTED, fontSize: 12 }}>
              {num(v.comp_count)} comp{v.comp_count === 1 ? '' : 's'}
              {v.created_by_name ? ` · ${v.created_by_name}` : ''}
              {v.updated_at ? ` · ${day(v.updated_at)}` : ''}
            </span>
          </Link>
        ))}
      </div>
    </section>
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
