import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { api } from '../lib/api.js';
import {
  INK, MUTED, GOLD, S, money, sqft, num, saleMonth, baths, conditionLabel, conditionRead,
  CONDITION_CODES, compSetShort,
} from '../lib/research.js';
import ResearchPhoto from '../components/ResearchPhoto.jsx';
import CompMap from '../components/CompMap.jsx';
import { geoBasisInfo } from '../lib/geoBasis.js';

/* FIND COMPARABLES — start from a PROPERTY, not from six filters typed by hand.
 *
 * This is the other way round from the browse screen. There you name a town, a
 * price band and a bed count and read what comes back. Here you name the house
 * you are valuing and the search fills itself in from it — which is how every
 * professional comp tool works, and what an officer actually has in front of
 * them when they are working a file.
 *
 * THREE WAYS TO NAME THE SUBJECT, all the same screen:
 *   ?property_id=…      a property already in the warehouse
 *   ?application_id=…   a loan file — the subject comes off the file
 *   typed               a brand-new deal with no appraisal and no warehouse row
 *
 * THE HONEST PART, and it is the point of the design. The warehouse only holds
 * houses that appeared in an appraisal WE paid for — in a typical town a small
 * share of what actually sold. So a thin answer here is usually a statement
 * about our coverage, not about the filters. This screen therefore always says
 * (a) how hard it had to look before it found anything (the ladder), and (b) how
 * much of that town we hold at all. "4 properties" with no denominator is the
 * failure mode this exists to prevent.
 */

const RADII = [
  { v: '0.5', label: 'within ½ mile' },
  { v: '1', label: 'within 1 mile' },
  { v: '2', label: 'within 2 miles' },
  { v: '5', label: 'within 5 miles' },
  { v: '0', label: 'any distance' },
];
const MONTHS = [
  { v: '6', label: 'sold in the last 6 months' },
  { v: '12', label: 'last 12 months' },
  { v: '18', label: 'last 18 months' },
  { v: '36', label: 'last 3 years' },
  { v: '0', label: 'any time' },
];

export default function StaffCompSearch() {
  const [params, setParams] = useSearchParams();
  const nav = useNavigate();
  const [d, setD] = useState(null);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const [picked, setPicked] = useState(() => new Map());
  const [mapPick, setMapPick] = useState(null);
  const [sending, setSending] = useState(false);

  // Everything the search runs on lives in the URL, so a comp search is a LINK —
  // paste it to a colleague and they see exactly what you saw.
  const q = useMemo(() => {
    const o = {};
    for (const [k, v] of params.entries()) o[k] = v;
    return o;
  }, [params]);

  const [subjForm, setSubjForm] = useState({
    address: q.address || '', city: q.city || '', state: q.state || '', zip: q.zip || '',
    gla: q.gla || '', beds: q.beds || '', year_built: q.year_built || '', condition_uad: q.condition_uad || '',
  });
  useEffect(() => {
    setSubjForm({
      address: q.address || '', city: q.city || '', state: q.state || '', zip: q.zip || '',
      gla: q.gla || '', beds: q.beds || '', year_built: q.year_built || '', condition_uad: q.condition_uad || '',
    });
  }, [q]);

  const anchored = !!(q.property_id || q.application_id);
  const typedEnough = !!(subjForm.city && subjForm.state) || !!subjForm.zip;
  const canSearch = anchored || typedEnough;

  // WHAT THE CONTROLS SAY IS WHAT THE SERVER RUNS. The route's own defaults are
  // "the whole town, last 18 months" — no radius at all — so a distance box
  // showing "within 1 mile" while nothing constrained the distance would be a
  // control that lies about its own search. The screen's defaults are therefore
  // sent explicitly rather than left to the server, and the same object drives
  // both the request and the dropdowns.
  //
  // `relaxable` names the ones that are OUR defaults rather than the user's
  // choice. Without it, sending a default would look identical to someone
  // deliberately asking for half a mile — and the server refuses to relax what
  // it was explicitly asked for, so the ladder's most useful rungs would never
  // fire. A control the user actually touches lands in the URL and drops off
  // this list, and from then on it is honoured exactly as typed.
  // `comp_set` is NOT in here on purpose: it is off by default, so when it IS set
  // the officer set it and the server must honour it exactly. That is why the
  // ladder's "sales of any kind" rung is unreachable from this screen, and why
  // the empty state below has to say so rather than promise a fallback.
  const DEFAULTS = { radius_miles: '1', sold_within_months: '18', want: '6' };
  const effective = useMemo(() => {
    const e = Object.assign({}, DEFAULTS, q);
    const mine = Object.keys(DEFAULTS).filter((k) => q[k] === undefined);
    if (mine.length) e.relaxable = mine.join(',');
    return e;
  }, [q]);

  const run = useCallback(() => {
    if (!canSearch) { setD(null); return; }
    setBusy(true); setErr('');
    api.researchComps(effective)
      .then(setD)
      .catch((e) => { setD(null); setErr(e.message || 'Could not look for comparables'); })
      .finally(() => setBusy(false));
  }, [effective, canSearch]);

  useEffect(() => { run(); }, [run]);
  // A NEW SUBJECT MEANS A NEW SHORTLIST. Without this, ticking two comps and then
  // searching a different property left the sticky bar offering to build a
  // valuation for the NEW subject out of the OLD subject's comps.
  const subjectKey = `${q.property_id || ''}|${q.application_id || ''}|${q.address || ''}|${q.city || ''}|${q.zip || ''}`;
  useEffect(() => { setPicked(new Map()); }, [subjectKey]);

  function apply(next) {
    const merged = { ...q, ...next };
    const out = {};
    for (const [k, v] of Object.entries(merged)) if (v !== '' && v != null) out[k] = v;
    setParams(out, { replace: false });
  }

  function searchTyped() {
    apply({ ...subjForm, property_id: undefined, application_id: undefined });
  }

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
      // CARRY THE SUBJECT, whichever way we got here. Sending only a title and an
      // address left `subject_snapshot` with one key, so `ratesFor` refused ("no
      // market was named") and every comp landed with an EMPTY adjustment grid —
      // on two of the three entry paths, including the loan file.
      const subj = d && d.subject;
      const title = `Value: ${(subj && subj.display_address) || subjForm.address || 'new property'}`;
      const pid = q.property_id || (subj && subj.id) || null;
      const v = await api.valuationCreate(
        pid ? { property_id: pid, title }
          : q.application_id ? { application_id: q.application_id, title }
            : { title,
              address: (subj && subj.display_address) || subjForm.address || '',
              subject: {
                display_address: (subj && subj.display_address) || subjForm.address || null,
                city: subjForm.city || null, state: subjForm.state || null, zip: subjForm.zip || null,
                gla: subjForm.gla || null, beds: subjForm.beds || null,
                year_built: subjForm.year_built || null, condition_uad: subjForm.condition_uad || null,
              } });
      await api.valuationAddComps(v.valuation.id, { property_ids: [...picked.keys()] });
      nav(`/internal/research/valuation/${v.valuation.id}`);
    } catch (e) { setErr(e.message || 'Could not start that valuation'); setSending(false); }
  }

  const rows = (d && d.rows) || [];
  const subject = d && d.subject;

  return (
    <div>
      <header style={{ marginBottom: 14 }}>
        <div style={{ marginBottom: 8 }}>
          <Link to="/internal/research" style={{ color: MUTED, fontSize: 13 }}>← Property Research</Link>
        </div>
        <h1 style={{ margin: '0 0 4px', color: INK }}>Find comparables</h1>
        <p style={{ margin: 0, color: MUTED, maxWidth: 780 }}>
          Name the property you are valuing and the search fills itself in from it — the same town,
          a similar size, sold recently. Everything comes from our own appraisal reports.
        </p>
      </header>

      {err && <div className="card" style={{ borderColor: '#B4423A', color: '#B4423A', marginBottom: 12 }}>{err}</div>}

      <SubjectBar
        anchored={anchored} subject={subject} form={subjForm} setForm={setSubjForm}
        onSearch={searchTyped} onClear={() => setParams({}, { replace: false })}
      />

      {canSearch && (
        <div style={{ ...S.panel, marginBottom: 12, display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center' }}>
          {/* A DISTANCE WE COULD NOT APPLY MUST NOT LOOK APPLIED. Most warehouse
              properties have never been placed on a map, and the route drops the
              radius and says so (`radius_dropped`) — while this box went on
              reading "within 1 mile". */}
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
            <select style={{ ...S.input, width: 'auto',
              ...(d && d.radius_dropped ? { borderColor: GOLD, color: MUTED } : null) }}
              value={effective.radius_miles}
              onChange={(e) => apply({ radius_miles: e.target.value })}>
              {RADII.map((r) => <option key={r.v} value={r.v}>{r.label}</option>)}
            </select>
            {d && d.radius_dropped && (
              <span style={{ color: GOLD, fontSize: 12 }}>not applied — this property isn’t on the map yet</span>
            )}
          </span>
          <select style={{ ...S.input, width: 'auto' }} value={effective.sold_within_months}
            onChange={(e) => apply({ sold_within_months: e.target.value })}>
            {MONTHS.map((m) => <option key={m.v} value={m.v}>{m.label}</option>)}
          </select>
          {/* RENOVATED OR NOT — AND WE DO NOT HAVE TO GUESS. An after-repair
              value has to rest on sales of FINISHED houses, and every other tool
              in this industry leaves you to work that out from a photograph. The
              appraiser put each comparable on either the as-is grid or the
              after-repair grid and the warehouse kept which, so this is the
              appraiser's own judgement, not ours. Measured: 154 of 955
              properties have been used on an after-repair grid, 144 of them with
              a recorded sale, and only 6 appear on both — the two sets really are
              different sales.
              Left OFF by default: it is a real narrowing and the officer should
              choose it. Once chosen it is HONOURED — the ladder never widens
              what someone asked for explicitly — so an empty answer here means
              this town holds no renovated sales, which the coverage panel below
              says in words. */}
          <select style={{ ...S.input, width: 'auto' }} value={effective.comp_set || ''}
            onChange={(e) => apply({ comp_set: e.target.value })}
            aria-label="Which kind of sale">
            <option value="">Any sale</option>
            <option value="arv">Renovated sales only (after-repair grids)</option>
            <option value="as_is">As-is sales only</option>
          </select>
          <select style={{ ...S.input, width: 'auto' }} value={effective.want}
            onChange={(e) => apply({ want: e.target.value })}>
            {['3', '6', '10', '15'].map((n) => <option key={n} value={n}>want at least {n}</option>)}
          </select>
          {busy && <span style={{ color: MUTED, fontSize: 13 }}>Looking…</span>}
        </div>
      )}

      {!canSearch && (
        <div className="card" style={{ color: MUTED }}>
          Pick a property to start from — or type the town and state above and press Search.
        </div>
      )}

      {d && <Honesty d={d} />}

      {d && rows.length > 0 && (
        <section style={{ ...S.panel, marginTop: 12 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline',
            flexWrap: 'wrap', gap: 10, marginBottom: 8 }}>
            <h2 style={{ margin: 0, fontSize: 16, color: INK }}>
              {num(rows.length)} comparable{rows.length === 1 ? '' : 's'}
              {d.total > rows.length && <span style={{ color: MUTED, fontWeight: 400 }}> of {num(d.total)} that matched</span>}
            </h2>
            <span style={{ color: MUTED, fontSize: 12 }}>Best match first. The score is advisory — you decide.</span>
          </div>
          {/* WHERE THEY ARE. "0.42 mi NE" cannot answer the question an
              underwriter actually has — are these on the same side of the
              highway, the same school district, across the tracks. Clicking a
              pin picks that comparable, so the map and the list are one
              selection rather than two. */}
          <CompMap
            subject={subject}
            comps={rows}
            radiusMi={d.applied_filters && d.applied_filters.radius_mi}
            selectedId={mapPick}
            onSelect={(id) => {
              setMapPick(id);
              const r = rows.find((x) => String(x.id) === String(id));
              if (r) toggle(r);
            }}
          />
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {rows.map((r) => (
              <CompRow key={r.id} r={r} checked={picked.has(r.id)} onToggle={() => toggle(r)} />
            ))}
          </div>
        </section>
      )}

      {picked.size > 0 && (
        <div style={{ position: 'sticky', bottom: 0, marginTop: 12, ...S.panel,
          display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap',
          boxShadow: '0 -2px 10px rgba(20,27,34,0.08)' }}>
          <strong style={{ color: INK }}>{picked.size} picked</strong>
          <button className="btn btn-gold small" disabled={sending} onClick={buildValuation}>
            {sending ? 'Starting…' : 'Build a valuation from these →'}
          </button>
          <button className="btn ghost small" onClick={() => setPicked(new Map())}>Clear</button>
        </div>
      )}
    </div>
  );
}

/* WHAT WE ARE COMPARING AGAINST. When the subject came from a property or a loan
   file it is shown as a fact; otherwise it is a small form, so a brand-new deal
   with no appraisal can still be searched. */
function SubjectBar({ anchored, subject, form, setForm, onSearch, onClear }) {
  if (anchored) {
    return (
      <section style={{ ...S.panel, marginBottom: 12 }}>
        <div style={{ display: 'flex', gap: 14, alignItems: 'baseline', flexWrap: 'wrap' }}>
          <span style={S.tag}>Subject</span>
          <strong style={{ color: INK, fontSize: 16 }}>
            {(subject && subject.display_address) || 'Loading…'}
          </strong>
          {subject && (
            <span style={{ color: MUTED, fontSize: 13 }}>
              {[subject.city, subject.state].filter(Boolean).join(', ')}
              {subject.gla ? ` · ${sqft(subject.gla)}` : ''}
              {subject.beds != null ? ` · ${subject.beds} bed` : ''}
              {subject.year_built ? ` · built ${subject.year_built}` : ''}
              {subject.condition_uad ? ` · ${conditionLabel(subject.condition_uad, subject.condition_text)}` : ''}
            </span>
          )}
          <button className="btn ghost small" style={{ marginLeft: 'auto' }} onClick={onClear}>
            Search a different property
          </button>
        </div>
      </section>
    );
  }
  const set = (k) => (e) => setForm({ ...form, [k]: e.target.value });
  return (
    <section style={{ ...S.panel, marginBottom: 12 }}>
      <div style={{ marginBottom: 8, color: INK, fontWeight: 600 }}>Describe the property you are valuing</div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(130px, 1fr))', gap: 10 }}>
        <Field label="Address"><input style={S.input} value={form.address} onChange={set('address')} placeholder="26 S 10th St" /></Field>
        <Field label="Town"><input style={S.input} value={form.city} onChange={set('city')} placeholder="Piscataway" /></Field>
        <Field label="State"><input style={S.input} maxLength={2} value={form.state} onChange={set('state')} placeholder="NJ" /></Field>
        <Field label="ZIP"><input style={S.input} value={form.zip} onChange={set('zip')} placeholder="08854" /></Field>
        <Field label="Living area"><input style={S.input} inputMode="numeric" value={form.gla} onChange={set('gla')} placeholder="1500" /></Field>
        <Field label="Bedrooms"><input style={S.input} inputMode="numeric" value={form.beds} onChange={set('beds')} placeholder="3" /></Field>
        <Field label="Year built"><input style={S.input} inputMode="numeric" value={form.year_built} onChange={set('year_built')} placeholder="1962" /></Field>
        <Field label="Condition">
          <select style={S.input} value={form.condition_uad} onChange={set('condition_uad')}>
            <option value="">—</option>
            {CONDITION_CODES.map((c) => <option key={c} value={c}>{conditionLabel(c)}</option>)}
          </select>
        </Field>
      </div>
      <div style={{ marginTop: 10, display: 'flex', gap: 10, alignItems: 'center' }}>
        <button className="btn btn-gold small" onClick={onSearch}>Search</button>
        <span style={{ color: MUTED, fontSize: 12 }}>A town and state (or a ZIP) is the least it needs.</span>
      </div>
    </section>
  );
}

/* HOW HARD IT HAD TO LOOK, AND WHAT WE HOLD. This is the part that stops a thin
   answer reading as a confident one. */
function Honesty({ d }) {
  const ladder = d.ladder || [];
  const relaxed = d.relaxed_to && d.relaxed_to !== 'as_asked';
  const cov = d.coverage;
  const none = !(d.rows || []).length;

  return (
    <section style={{ ...S.panel, borderColor: none ? '#B4423A' : (relaxed ? GOLD : '#E4DECF') }}>
      {none ? (
        <div>
          <strong style={{ color: INK }}>Nothing found — and here is why.</strong>
          {d.subject_located === false && (
            <div style={{ color: GOLD, fontSize: 13, marginTop: 6 }}>
              We have not placed this property on the map yet, so distance was not used at all.
            </div>
          )}
          <p style={{ margin: '6px 0 0', color: MUTED, fontSize: 13 }}>
            {cov && cov.properties === 0
              ? <>We hold <b style={{ color: INK }}>no properties at all</b> in {cov.where || 'that area'} yet.
                This database only knows houses that appeared in an appraisal we paid for, so a town we have not
                lent in is simply empty. Nothing you change in the filters will find anything here.</>
              : <>We searched as far as the settings allow and still found nothing that matched.
                {cov && <> We hold {num(cov.properties)} propert{cov.properties === 1 ? 'y' : 'ies'} in {cov.where},
                  {' '}{num(cov.with_sale)} of them with a recorded sale price.</>}</>}
          </p>
        </div>
      ) : (
        <div style={{ display: 'flex', gap: 18, flexWrap: 'wrap', alignItems: 'baseline' }}>
          {relaxed && (
            <span style={{ color: INK, fontSize: 13 }}>
              <b>Had to look wider.</b>{' '}
              {ladder.filter((s) => s.found === 0).length > 0 && (
                <>{ladder.filter((s) => s.found === 0).map((s) => s.label).join(', then ')} found nothing — </>
              )}
              these came from {(ladder[ladder.length - 1] || {}).label}.
            </span>
          )}
          {cov && (
            <span style={{ color: MUTED, fontSize: 13 }}>
              We hold <b style={{ color: INK }}>{num(cov.properties)}</b> propert{cov.properties === 1 ? 'y' : 'ies'} in
              {' '}{cov.where} in total, {num(cov.with_sale)} with a sale price — all from our own appraisals.
            </span>
          )}
          {d.subject_located === false && (
            <span style={{ color: GOLD, fontSize: 13 }}>
              We have not placed this property on the map yet, so distances are not shown.
            </span>
          )}
        </div>
      )}
    </section>
  );
}

function CompRow({ r, checked, onToggle }) {
  return (
    <div style={{ display: 'flex', gap: 12, alignItems: 'flex-start',
      border: '1px solid ' + (checked ? GOLD : '#E4DECF'), borderRadius: 8, padding: 10,
      background: checked ? '#FCFAF4' : '#fff' }}>
      <input type="checkbox" checked={checked} onChange={onToggle} style={{ marginTop: 4 }}
        aria-label={`Pick ${r.display_address}`} />
      {r.primary_photo_document_id
        ? <ResearchPhoto documentId={r.primary_photo_document_id} alt={r.display_address}
          style={{ width: 92, height: 68, objectFit: 'cover', borderRadius: 6, border: '1px solid #E4DECF' }} />
        : <div style={{ width: 92, height: 68, borderRadius: 6, background: '#F4F1EA' }} />}
      <div style={{ flex: '1 1 260px', minWidth: 0 }}>
        <Link to={`/internal/research/property/${r.id}`} style={{ color: INK, fontWeight: 600, textDecoration: 'none' }}>
          {r.display_address}
        </Link>
        <div style={{ color: MUTED, fontSize: 12, marginTop: 2 }}>
          {[r.city, r.state].filter(Boolean).join(', ')}
          {/* THE DISTANCE, AND WHERE IT WAS MEASURED FROM (db/446). The coordinate
              underneath can be a rooftop lookup, a position worked out from the
              comparables (about 20 feet), or the appraiser's own — and db/412's
              own comment says those are "frequently the centre of the ZIP". A
              ZIP centroid is a mile from the house, so that distance is not a
              worse answer, it is an answer to a different question. It used to
              be rendered in exactly the same font as a rooftop measurement. */}
          {r.distance_miles != null && (() => {
            const b = geoBasisInfo(r.eff_geo_source);
            return (
              <> · <b style={{ color: b && !b.trusted ? '#8A5A00' : INK }} title={b ? b.detail : undefined}>
                {Number(r.distance_miles).toFixed(2)} mi away
              </b>
              {b && !b.trusted && <span style={{ color: '#8A5A00' }} title={b.detail}> (rough — {b.label})</span>}
              </>
            );
          })()}
          {/* How OUR appraisers have used this house before — the thing no MLS
              can tell you. These are per-property totals on the roll-up, not a
              per-observation field. */}
          {r.arv_comp_count > 0 && <> · used as {compSetShort.arv} {r.arv_comp_count}×</>}
          {r.asis_comp_count > 0 && <> · as {compSetShort.as_is} {r.asis_comp_count}×</>}
        </div>
        {/* WHAT KIND OF BUILDING, AND HOW MANY DOORS — first, before the size and
            the beds, because they are what decide whether this is a comparable at
            all. Both were selected by the search and rendered by nothing, so the
            one screen where an officer picks comps showed a duplex and a house
            identically. An UNKNOWN says so out loud rather than being left off:
            a missing unit count that looks like an absent field reads as "one",
            and picking a 3-family as a comp for a house is the mistake this
            line exists to prevent. */}
        <div style={{ fontSize: 12, marginTop: 4, display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
          <span style={{ ...S.tag, borderColor: r.property_type ? GOLD : '#B4423A',
            color: r.property_type ? INK : '#B4423A', fontWeight: 600 }}>
            {r.property_type || 'type not stated'}
          </span>
          <span style={{ ...S.tag, borderColor: r.units != null ? GOLD : '#B4423A',
            color: r.units != null ? INK : '#B4423A', fontWeight: 600 }}>
            {r.units != null ? `${r.units} unit${Number(r.units) === 1 ? '' : 's'}` : 'units not stated'}
          </span>
        </div>
        <div style={{ color: MUTED, fontSize: 12, marginTop: 4, display: 'flex', gap: 10, flexWrap: 'wrap' }}>
          <span>{sqft(r.gla)}</span>
          <span>{r.beds ?? '—'} bed / {baths(r)} bath</span>
          <span>built {r.year_built || '—'}</span>
          <span>{conditionRead(r)}</span>
          {/* WHICH GRID AN APPRAISER PUT IT ON. A sale used to support an
              after-repair value is a FINISHED house, said so by the person who
              stood in it — the fact this whole feature rests on, so the row
              states it whether or not the filter was used. */}
          {r.arv_comp_count > 0 && (
            <span style={{ color: '#2F7F86', fontWeight: 600 }}>
              renovated — used on an after-repair grid
              {r.asis_comp_count > 0 ? ' and an as-is one' : ''}
            </span>
          )}
        </div>
      </div>
      <div style={{ textAlign: 'right', minWidth: 130 }}>
        <div style={{ color: INK, fontWeight: 700, fontSize: 16 }}>{money(r.last_sale_price)}</div>
        <div style={{ color: MUTED, fontSize: 12 }}>{saleMonth(r.last_sale_date)}</div>
        <div style={{ marginTop: 5 }}>
          <span style={S.tag} title="How well it matches on what we know about both properties">
            match {Math.round(r.match_score)}
          </span>
          {/* Coverage travels WITH the score, always — a comp scored on half the
              facts must say so, or the number overstates itself. */}
          {/* ALREADY A PERCENTAGE — scoreComp returns round((possible/total)*100,1).
              Multiplying again rendered "on 6100% of the facts" on every row.
              Hidden at full coverage: "on 100% of the facts" is noise. */}
          {r.match_coverage != null && Math.round(r.match_coverage) < 100 && (
            <div style={{ color: MUTED, fontSize: 11, marginTop: 3 }}>
              on {Math.round(r.match_coverage)}% of the facts
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function Field({ label, children }) {
  return <label style={{ display: 'block' }}><span style={S.label}>{label}</span>{children}</label>;
}
