import React, { useCallback, useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { api } from '../lib/api.js';
import CompMap from '../components/CompMap.jsx';
import { INK, MUTED, GOLD, TEAL, S } from '../lib/research.js';

/* DRAW THE NEIGHBOURHOOD — because a radius is a bad model of one.
 *
 * A mile in one direction crosses a river, a rail line, a school-district
 * boundary or a town line; a mile in another is the same houses on the same
 * streets. The 1004MC form itself asks the appraiser to define the
 * neighbourhood and then report on it, so the boundary is a JUDGEMENT a person
 * makes — and the only honest way to capture a judgement is to let them draw it
 * and record whose it was.
 *
 * The shape decides which comparables an officer is later shown, so this screen
 * shows the CONSEQUENCE before it saves: how many of the properties we hold in
 * that market fall inside it, against how many were in its bounding box. "12 of
 * the 40 nearby" is a boundary doing real work; "40 of the 40" is a rectangle.
 */

export default function StaffMarketAreas() {
  const [sp, setSp] = useSearchParams();
  const qState = (sp.get('state') || '').toUpperCase();
  const qCity = sp.get('city') || '';

  const [state, setState] = useState(qState);
  const [city, setCity] = useState(qCity);
  const [areas, setAreas] = useState([]);
  const [props, setProps] = useState([]);
  const [drawing, setDrawing] = useState(false);
  const [polygon, setPolygon] = useState([]);
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [msg, setMsg] = useState('');
  const [showing, setShowing] = useState(null);

  useEffect(() => { setState(qState); setCity(qCity); }, [qState, qCity]);

  const load = useCallback(() => {
    if (!qState && !qCity) { setAreas([]); setProps([]); return; }
    setErr('');
    api.marketAreas({ state: qState, city: qCity })
      .then((d) => setAreas(d.rows || []))
      .catch((e) => setErr(e.message || 'Could not read the saved areas'));
    // The properties we hold there, so there is something to draw around.
    api.researchSearch({ state: qState, city: qCity, limit: 200 })
      .then((d) => setProps((d.rows || []).filter((p) => p.eff_latitude != null)))
      .catch(() => setProps([]));
  }, [qState, qCity]);
  useEffect(() => { load(); }, [load]);

  function search(e) {
    e.preventDefault();
    const next = {};
    if (state) next.state = state;
    if (city) next.city = city;
    setSp(next, { replace: true });
  }

  async function save() {
    setBusy(true); setErr(''); setMsg('');
    try {
      const d = await api.marketAreaCreate({
        name, city: qCity || null, state: qState || null, ring: polygon,
      });
      setMsg(`Saved “${d.area.name}” — about ${d.shape.areaSqMi} square miles.`
        + (d.shape.note ? ` ${d.shape.note}` : ''));
      setPolygon([]); setName(''); setDrawing(false);
      load();
    } catch (e) { setErr(e.message || 'That did not save'); }
    setBusy(false);
  }

  async function inspect(a) {
    setErr('');
    try {
      const d = await api.marketAreaProperties(a.id);
      setShowing({ area: a, ...d });
    } catch (e) { setErr(e.message || 'Could not read that area'); }
  }

  // What the shape being drawn would contain, worked out here so the number is
  // live as corners go down rather than only after it is saved.
  const corners = polygon.length;

  return (
    <div>
      <h1 style={{ margin: '0 0 4px', color: INK, fontSize: 24 }}>Market areas</h1>
      <p style={{ margin: '0 0 14px', color: MUTED, fontSize: 14, maxWidth: 760 }}>
        Draw the neighbourhood the way an appraiser would. A circle cannot say
        <b style={{ color: INK }}> this side of the highway</b> — a drawn boundary can, and every one
        of these records who drew it.
      </p>

      <form onSubmit={search} style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 14, alignItems: 'flex-end' }}>
        <label style={{ fontSize: 12, color: MUTED }}>State<br />
          <input value={state} onChange={(e) => setState(e.target.value.toUpperCase().slice(0, 2))}
            placeholder="NJ" style={{ ...S.input, width: 80 }} /></label>
        <label style={{ fontSize: 12, color: MUTED }}>Town<br />
          <input value={city} onChange={(e) => setCity(e.target.value)} placeholder="Trenton"
            style={{ ...S.input, width: 180 }} /></label>
        <button className="btn btn-gold small" type="submit">Show</button>
      </form>

      {err && <div className="card" style={{ borderColor: '#B4423A', color: '#B4423A' }}>{err}</div>}
      {msg && <div className="card" style={{ borderColor: TEAL, color: INK }}>{msg}</div>}

      {!qState && !qCity && (
        <div className="card" style={{ color: MUTED }}>
          Name a town to see what we hold there and draw a boundary around it.
        </div>
      )}

      {(qState || qCity) && (
        <>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center', marginBottom: 10 }}>
            <button type="button" className={`btn small ${drawing ? 'btn-gold' : 'ghost'}`}
              onClick={() => { setDrawing((v) => !v); setPolygon([]); }}>
              {drawing ? 'Stop drawing' : 'Draw an area'}
            </button>
            {drawing && (
              <>
                <span style={{ fontSize: 12.5, color: MUTED }}>
                  Click the map to drop a corner. {corners} placed
                  {corners < 3 ? ' — three is the least a shape can have' : ''}.
                </span>
                <button type="button" className="btn ghost small" disabled={!corners}
                  onClick={() => setPolygon(polygon.slice(0, -1))}>Undo the last corner</button>
                <button type="button" className="btn ghost small" disabled={!corners}
                  onClick={() => setPolygon([])}>Start again</button>
              </>
            )}
          </div>

          <CompMap
            subject={null}
            comps={showing ? showing.rows : props}
            height={460}
            drawing={drawing}
            polygon={polygon}
            onPolygon={setPolygon}
          />

          {drawing && corners >= 3 && (
            <div style={{ ...S.panel, marginBottom: 14, display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'flex-end' }}>
              <label style={{ fontSize: 12, color: MUTED }}>Name this area<br />
                <input value={name} onChange={(e) => setName(e.target.value.slice(0, 80))}
                  placeholder="e.g. North of the tracks" style={{ ...S.input, width: 260 }} /></label>
              <button className="btn btn-gold small" disabled={busy || !name.trim()} onClick={save}>
                {busy ? 'Saving…' : 'Save this area'}
              </button>
              <span style={{ fontSize: 12, color: MUTED }}>{corners} corners</span>
            </div>
          )}

          <section style={{ ...S.panel }}>
            <h2 style={{ margin: '0 0 8px', fontSize: 15, color: INK }}>
              Saved areas{areas.length ? ` (${areas.length})` : ''}
            </h2>
            {areas.length === 0 && (
              <div style={{ color: MUTED, fontSize: 13 }}>
                Nothing drawn here yet. Nobody has had to say where this neighbourhood ends.
              </div>
            )}
            {areas.map((a) => (
              <div key={a.id} style={{ borderTop: '1px solid #F0EBE0', padding: '8px 0',
                display: 'flex', justifyContent: 'space-between', gap: 10, flexWrap: 'wrap', alignItems: 'baseline' }}>
                <div>
                  <div style={{ color: INK, fontSize: 13.5, fontWeight: 600 }}>{a.name}</div>
                  <div style={{ color: MUTED, fontSize: 12 }}>
                    {[a.city, a.state].filter(Boolean).join(', ')}
                    {a.area_sq_mi ? ` · about ${Number(a.area_sq_mi).toFixed(1)} square miles` : ''}
                    {/* WHOSE JUDGEMENT IT IS. A boundary with no author is one
                        nobody can ask about, and it decides what an officer sees. */}
                    {a.created_by_name ? ` · drawn by ${a.created_by_name}` : ' · author not recorded'}
                  </div>
                </div>
                <div style={{ display: 'flex', gap: 6 }}>
                  <button type="button" className="btn ghost small" onClick={() => inspect(a)}>
                    What is inside
                  </button>
                  <button type="button" className="btn ghost small"
                    onClick={async () => {
                      try { await api.marketAreaArchive(a.id); setShowing(null); load(); }
                      catch (e) { setErr(e.message || 'Could not archive that'); }
                    }}>Archive</button>
                </div>
              </div>
            ))}
          </section>

          {showing && (
            <section style={{ ...S.panel, marginTop: 14, borderLeft: `3px solid ${GOLD}` }}>
              <h2 style={{ margin: '0 0 4px', fontSize: 15, color: INK }}>
                Inside “{showing.area.name}”
              </h2>
              {/* BOTH NUMBERS. "12 of the 40 nearby" is a boundary doing real
                  work; "40 of the 40" means the shape is a rectangle and is not
                  cutting anything, which the drawer should know. */}
              <div style={{ fontSize: 13.5, color: INK }}>
                <b>{showing.inArea}</b> of the <b>{showing.inBox}</b> properties in its bounding box —
                the boundary itself set aside {showing.inBox - showing.inArea}.
              </div>
              {showing.truncated && (
                <div style={{ color: '#8A5A00', fontSize: 12.5, marginTop: 4 }}>
                  There were more properties in that box than one reading holds, so this is a large
                  sample rather than all of them.
                </div>
              )}
              <button type="button" className="btn ghost small" style={{ marginTop: 8 }}
                onClick={() => setShowing(null)}>Show the whole town again</button>
            </section>
          )}
        </>
      )}
    </div>
  );
}
