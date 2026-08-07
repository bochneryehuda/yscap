import React, { useEffect, useState, useCallback, useMemo } from 'react';
import { api } from '../lib/api';

/**
 * Class Valuation appraisal ordering — the staff order desk. STAFF-ONLY.
 *
 * THE PREVIEW IS THE POINT. The owner's standing rule for this desk:
 *   "we need to make sure that we see all the fields that he's filling
 *    automatically before he's sending those over"
 * so this screen lists EVERY field that would be sent — not a chosen handful —
 * and colours each one by WHERE ITS VALUE CAME FROM: read straight off the file,
 * worked out by PILOT, typed by a person, or missing and blocking the order.
 *
 * THE FIELD LIST IS NOT WRITTEN HERE. It comes from the server, which walks the
 * built order body, so a field added to the builder appears on this screen with
 * no change to this file. Re-listing the fields in JSX would reproduce exactly
 * the defect the audit found on the AMC panel — a screen quietly one field
 * behind what is actually being sent. Same for the dropdown options: they are
 * Class's own closed value lists, served from the one place the builder reads
 * them, never retyped here.
 *
 * NOTHING HERE CHOOSES BETWEEN VENDORS. The owner has not picked a default and
 * asked to leave it until one is actually ready, so this panel answers only for
 * Class and the AMC panel answers only for the AMC.
 *
 * All colors are EXPLICIT dark hex on the white canvas (never a var(--ink*)
 * token, which resolves LIGHT in this portal) — per the white-first HARD RULE.
 */

const INK = '#141B22', MUTED = '#4B585C', LINE = '#E7E1D4', GOLD = '#AE8746', TEAL = '#2F7F86';
const BAD = '#B4453B', GOOD = '#1E7B4F';

// How each provenance reads on screen. The server decides the state; this is
// only its wording and colour.
const STATE = {
  read:       { label: 'From the file', color: MUTED, dot: '#C9C2B2' },
  derived:    { label: 'PILOT worked this out', color: GOLD, dot: GOLD },
  overridden: { label: 'You changed this', color: TEAL, dot: TEAL },
  missing:    { label: 'Still needed', color: BAD, dot: BAD },
};

// Which rows a staffer may type over. Mirrors the server's own allowlist — the
// server is the one that enforces it; this only decides what gets an input box.
// The key is the LAST segment of the field path, which is how the builder names
// its overrides (`property.street` -> `street`).
const EDITABLE = new Set([
  'apiVersion',
  'productId', 'propertyTypeEnum', 'purpose', 'loanType', 'occupancy',
  'referenceNumber', 'street', 'city', 'state', 'zip', 'dueDate', 'instructions',
]);
// The property type is the one field the two UAD versions RENAME (`propertyTypeEnum`
// on 2.6, `propertyType` on 3.6). Its override key stays the 2.6 name on both, so a
// staffer's correction keeps applying when the version changes under them.
const PATH_TO_KEY = { propertyType: 'propertyTypeEnum' };
const overrideKeyFor = (path) => {
  const last = String(path || '').split('.').pop();
  const k = PATH_TO_KEY[last] || last;
  return EDITABLE.has(k) ? k : null;
};
// Which of those are a pick-from-their-list rather than free text. `occupancy` is
// only a list on 3.6 — the server says which, per version.
const ENUM_FOR = { propertyTypeEnum: 'propertyTypeEnum', purpose: 'purpose', loanType: 'loanType' };

export default function ClassAppraisalPanel({ appId }) {
  const [config, setConfig] = useState(null);
  const [preview, setPreview] = useState(null);
  const [overrides, setOverrides] = useState({});
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [notice, setNotice] = useState('');
  const [showAll, setShowAll] = useState(false);
  const [picking, setPicking] = useState(false);

  // The preview is re-fetched with the overrides, so what is on screen is always
  // what the SERVER would build — never a value this component patched locally.
  const load = useCallback(async (ov) => {
    setErr('');
    try {
      const pv = await api.classPreview(appId, ov || {});
      setPreview(pv || null);
    } catch (e) { setErr(e.message || 'Could not load the order preview.'); }
  }, [appId]);

  useEffect(() => {
    let alive = true;
    (async () => {
      setLoading(true);
      try {
        const cfg = await api.classConfig().catch(() => null);
        if (!alive) return;
        setConfig(cfg || null);
      } catch (_) { /* the preview still renders */ }
      await load({});
      if (alive) setLoading(false);
    })();
    return () => { alive = false; };
  }, [appId, load]);

  const setOverride = useCallback((key, value) => {
    setOverrides((prev) => {
      const next = { ...prev };
      if (value == null || value === '') delete next[key]; else next[key] = value;
      load(next);
      return next;
    });
  }, [load]);

  const clearOverrides = useCallback(() => { setOverrides({}); load({}); }, [load]);

  const place = useCallback(async () => {
    setBusy(true); setErr(''); setNotice('');
    try {
      const out = await api.classPlaceOrder(appId, { confirm: true, overrides });
      if (out && out.ok) {
        setNotice(out.dryrun
          ? 'Test mode — the order was built and written to the log. Nothing was sent to Class.'
          : `Order placed with Class Valuation.${out.orderId ? ' Their order number is ' + out.orderId + '.' : ''}`);
        await load(overrides);
      } else {
        setErr((out && out.message) || 'Could not place the order.');
      }
    } catch (e) {
      setErr(e.message || 'Could not place the order.');
    }
    setBusy(false);
  }, [appId, overrides, load]);

  const cfg = config && config.class ? config.class : null;
  // The option lists come from the PREVIEW, because the preview knows which UAD
  // version it was built for. Taking them from the config would offer 2.6's values
  // on a 3.6 order — two lists that genuinely differ, so the picker would hand the
  // builder a value that version does not accept.
  const options = (preview && preview.options) || {};
  const enums = options.enums || {};
  const occSuggestions = options.occupancySuggestions || [];
  const occIsList = !!options.occupancyIsEnum;

  const fields = (preview && preview.fields) || [];
  const notable = useMemo(
    () => fields.filter((f) => f.state === 'missing' || f.state === 'derived' || f.state === 'overridden'),
    [fields]);
  const shown = showAll ? fields : notable;

  if (loading) return <div style={{ color: MUTED, padding: 12 }}>Loading the Class Valuation order screen…</div>;

  const notOn = !cfg || !cfg.enabled;
  const missing = (preview && preview.missing) || [];
  const canPlace = !!(preview && preview.canPlace);

  return (
    <div style={{ color: INK }}>
      {err ? <Banner tone="bad">{err}</Banner> : null}
      {notice ? <Banner tone="good">{notice}</Banner> : null}

      <ConnectionLine cfg={cfg} hosts={config && config.hosts} notOn={notOn} />

      {preview ? (
        <>
          <VersionRow
            preview={preview}
            chosen={overrides.apiVersion}
            onPick={(v) => setOverride('apiVersion', v)}
          />

          <ProductRow
            preview={preview}
            chosen={overrides.productId}
            enabled={!!(cfg && cfg.enabled)}
            open={picking}
            onOpen={() => setPicking((v) => !v)}
            onPick={(id) => { setPicking(false); setOverride('productId', String(id)); }}
          />

          <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, marginTop: 16, flexWrap: 'wrap' }}>
            <SectionTitle>What we will send to Class</SectionTitle>
            <button type="button" onClick={() => setShowAll((v) => !v)}
              style={linkBtn}>
              {showAll ? `Show only what needs a look (${notable.length})` : `Show every field (${fields.length})`}
            </button>
            {Object.keys(overrides).length ? (
              <button type="button" onClick={clearOverrides} style={linkBtn}>Undo my changes</button>
            ) : null}
          </div>
          <div style={{ fontSize: 12, color: MUTED, marginBottom: 8 }}>
            Every line below is a value that goes to the appraiser. Anything PILOT worked out for you, or that is
            still missing, is called out — the rest came straight off the loan file.
          </div>

          <Legend />

          <div style={{ border: `1px solid ${LINE}`, borderRadius: 10, overflow: 'hidden' }}>
            {shown.length ? shown.map((f) => (
              <FieldRow
                key={f.path}
                field={f}
                enums={enums}
                occSuggestions={occSuggestions}
                occIsList={occIsList}
                value={overrides[overrideKeyFor(f.path)]}
                onChange={(v) => { const k = overrideKeyFor(f.path); if (k) setOverride(k, v); }}
              />
            )) : (
              <div style={{ padding: 12, color: MUTED, fontSize: 13 }}>
                Nothing needs a second look — every value came straight off the loan file.
              </div>
            )}
          </div>

          <Contacts contacts={(preview.body && preview.body.contacts) || []} />

          {missing.length ? (
            <div style={{ marginTop: 12, color: '#8A2F27', fontSize: 13 }}>
              <strong>Still needed before this can be ordered:</strong>
              <ul style={{ margin: '6px 0 0 18px', padding: 0 }}>
                {missing.map((m) => <li key={m.field} style={{ marginBottom: 2 }}>{m.why || m.field}</li>)}
              </ul>
            </div>
          ) : (
            <div style={{ marginTop: 12, color: GOOD, fontSize: 13 }}>Everything Class needs is filled in.</div>
          )}

          <PlaceOrder
            cfg={cfg} canPlace={canPlace} busy={busy} onPlace={place}
            uad={preview.uad}
            derivedCount={fields.filter((f) => f.state === 'derived').length}
          />
        </>
      ) : (
        <div style={{ color: MUTED, fontSize: 13, padding: 12 }}>
          This file could not be loaded for a Class Valuation order.
        </div>
      )}
    </div>
  );
}

/* ---------------------------------------------------------------- pieces --- */

function ConnectionLine({ cfg, hosts, notOn }) {
  if (!cfg) {
    return (
      <div style={{ border: `1px dashed ${LINE}`, borderRadius: 10, padding: 12, marginBottom: 12, color: MUTED, background: '#FBF9F4' }}>
        <strong style={{ color: INK }}>Class Valuation isn’t set up yet.</strong>{' '}
        Once their four sign-in details are in place, you’ll be able to order the appraisal from here.
      </div>
    );
  }
  const bits = [];
  bits.push(cfg.ready ? 'sign-in details are in' : 'waiting on their sign-in details');
  bits.push(cfg.enabled ? 'connection on' : 'connection off');
  bits.push(cfg.outbound ? 'ordering on' : 'ordering off');
  if (cfg.dryrun) bits.push('TEST MODE — nothing is really sent');
  return (
    <div style={{
      border: `1px ${notOn ? 'dashed' : 'solid'} ${LINE}`, borderRadius: 10, padding: 12,
      marginBottom: 12, background: notOn ? '#FBF9F4' : '#fff',
    }}>
      {notOn ? (
        <div style={{ color: MUTED }}>
          <strong style={{ color: INK }}>Ordering through Class Valuation isn’t turned on yet.</strong>{' '}
          You can still see below exactly what would be sent, so it can be checked in advance.
        </div>
      ) : null}
      <div style={{ fontSize: 12, color: MUTED, marginTop: notOn ? 6 : 0 }}>
        Class Valuation · {bits.join(' · ')}
        {hosts && hosts.environment ? ` · their ${String(hosts.environment).toUpperCase()} system` : ''}
      </div>
      {hosts && hosts.tokenConfirmed === false ? (
        <div style={{ fontSize: 12, color: GOLD, marginTop: 4 }}>
          Their sign-in address for this system is our best guess — worth confirming with Class before a real order.
        </div>
      ) : null}
    </div>
  );
}

// WHICH OF CLASS'S TWO FORMS THIS ORDER USES. The industry is moving from UAD 2.6
// to UAD 3.6, so both are built; 2.6 is the default until that shift happens, and
// this row lets one file be sent on 3.6 to try it before anything is switched over.
// It is FIRST on the screen on purpose: the version decides what the rest of the
// fields even are, so choosing it after filling them in would be backwards.
function VersionRow({ preview, chosen, onPick }) {
  const versions = preview.versions || [];
  const current = preview.apiVersion;
  const isDefault = !chosen && current === preview.defaultVersion;
  if (versions.length < 2) return null;
  return (
    <div style={{ border: `1px solid ${chosen ? TEAL : LINE}`, borderRadius: 10, padding: 12, marginTop: 12, background: '#fff' }}>
      <div style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
        <div style={{ flex: 1, minWidth: 200 }}>
          <div style={{ fontSize: 11, color: MUTED, textTransform: 'uppercase', letterSpacing: '.03em' }}>Which of their forms</div>
          <div style={{ color: INK, fontWeight: 600 }}>{preview.versionLabel}</div>
          <div style={{ fontSize: 12, color: MUTED, marginTop: 2 }}>
            {isDefault
              ? 'This is the normal one. The industry is moving to the newer form over the next few months — you can try it on this file without changing anything for anyone else.'
              : 'You picked this for this order only. Everyone else still gets the normal one.'}
          </div>
        </div>
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          {versions.map((v) => (
            <button type="button" key={v.version} onClick={() => onPick(v.version === preview.defaultVersion ? '' : v.version)}
              style={{
                border: `1px solid ${current === v.version ? TEAL : LINE}`,
                background: current === v.version ? '#EAF3F3' : '#fff',
                color: INK, borderRadius: 8, padding: '5px 10px', fontWeight: 550, cursor: 'pointer',
              }}>
              UAD {v.uad}{v.version === preview.defaultVersion ? ' (normal)' : ''}
            </button>
          ))}
        </div>
      </div>
      {current !== preview.defaultVersion ? (
        <div style={{ fontSize: 12, color: GOLD, marginTop: 8 }}>
          Heads up: this sends the newer form. Some values below are written differently on it — read them before ordering.
        </div>
      ) : null}
    </div>
  );
}

function ProductRow({ preview, chosen, enabled, open, onOpen, onPick }) {
  const row = (preview.fields || []).find((f) => f.path === 'productId');
  const value = row ? row.value : null;
  return (
    <div style={{ border: `1px solid ${value ? LINE : BAD}`, borderRadius: 10, padding: 12, marginTop: 12, background: '#fff' }}>
      <div style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
        <div style={{ flex: 1, minWidth: 200 }}>
          <div style={{ fontSize: 11, color: MUTED, textTransform: 'uppercase', letterSpacing: '.03em' }}>Which report to order</div>
          <div style={{ color: value ? INK : BAD, fontWeight: 600 }}>
            {value ? `Class product #${value}` : 'Not chosen yet'}
          </div>
          <div style={{ fontSize: 12, color: MUTED, marginTop: 2 }}>
            {chosen ? 'You picked this one.' : 'Class hasn’t given us a standard report to default to, so this is picked by hand for now.'}
          </div>
        </div>
        <button type="button" className="btn soft" onClick={onOpen} disabled={!enabled}
          title={enabled ? '' : 'Turn the Class Valuation connection on to see their list of reports'}>
          {open ? 'Close the list' : 'Choose from their list'}
        </button>
      </div>
      {open ? <ProductPicker onPick={onPick} /> : null}
    </div>
  );
}

function ProductPicker({ onPick }) {
  const [rows, setRows] = useState(null);
  const [q, setQ] = useState('');
  const [err, setErr] = useState('');
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const r = await api.classProducts({ limit: 200 });
        if (!alive) return;
        if (r && r.available) setRows(r.products || []);
        else { setRows([]); setErr('Their list of reports could not be read right now.'); }
      } catch (e) {
        if (alive) { setRows([]); setErr(e.message || 'Their list of reports could not be read right now.'); }
      }
    })();
    return () => { alive = false; };
  }, []);
  const filtered = (rows || []).filter((p) => {
    const t = `${p.title || ''} ${p.id || ''}`.toLowerCase();
    return !q.trim() || t.includes(q.trim().toLowerCase());
  });
  return (
    <div style={{ marginTop: 10, borderTop: `1px solid ${LINE}`, paddingTop: 10 }}>
      {rows === null ? <div style={{ color: MUTED, fontSize: 13 }}>Reading their list of reports…</div> : null}
      {err ? <div style={{ color: BAD, fontSize: 13, marginBottom: 6 }}>{err}</div> : null}
      {rows && rows.length ? (
        <>
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search their reports…"
            style={{ ...inputStyle, width: '100%', marginBottom: 8 }} />
          <div style={{ maxHeight: 260, overflowY: 'auto', border: `1px solid ${LINE}`, borderRadius: 8 }}>
            {filtered.map((p) => (
              <button type="button" key={p.id} onClick={() => onPick(p.id)}
                style={{
                  display: 'block', width: '100%', textAlign: 'left', background: '#fff', color: INK,
                  border: 'none', borderTop: `1px solid ${LINE}`, padding: '8px 10px', cursor: 'pointer',
                }}>
                <span style={{ fontWeight: 550 }}>{p.title || `Product ${p.id}`}</span>
                <span style={{ color: MUTED, fontSize: 12 }}> · #{p.id}</span>
              </button>
            ))}
            {!filtered.length ? <div style={{ padding: 10, color: MUTED, fontSize: 13 }}>Nothing matches that.</div> : null}
          </div>
        </>
      ) : null}
      {rows && !rows.length && !err ? <div style={{ color: MUTED, fontSize: 13 }}>Class hasn’t given us any reports to choose from.</div> : null}
    </div>
  );
}

function FieldRow({ field, enums, occSuggestions, occIsList, value, onChange }) {
  const st = STATE[field.state] || STATE.read;
  const key = overrideKeyFor(field.path);
  const enumName = key ? ENUM_FOR[key] : null;
  const options = enumName ? (enums[enumName] || []) : null;
  const shownValue = field.value == null || field.value === '' ? '—' : String(field.value);
  return (
    <div style={{ borderTop: `1px solid ${LINE}`, padding: '9px 12px', background: field.state === 'missing' ? '#FDF6F5' : '#fff' }}>
      <div style={{ display: 'flex', gap: 12, alignItems: 'flex-start', flexWrap: 'wrap' }}>
        <div style={{ minWidth: 170, flex: '0 0 auto' }}>
          <div style={{ color: INK, fontWeight: 550 }}>{field.label}</div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 5, marginTop: 2 }}>
            <span style={{ width: 7, height: 7, borderRadius: 99, background: st.dot, display: 'inline-block' }} />
            <span style={{ fontSize: 11, color: st.color }}>{st.label}</span>
          </div>
        </div>
        <div style={{ flex: 1, minWidth: 200 }}>
          {key ? (
            options ? (
              <select value={value != null ? value : (field.value == null ? '' : String(field.value))}
                onChange={(e) => onChange(e.target.value)} style={{ ...inputStyle, width: '100%' }}>
                <option value="">— not set —</option>
                {options.map((o) => <option key={o} value={o}>{o}</option>)}
              </select>
            ) : key === 'occupancy' ? (
              occIsList ? (
                <select value={value != null ? value : (field.value == null ? '' : String(field.value))}
                  onChange={(e) => onChange(e.target.value)} style={{ ...inputStyle, width: '100%' }}>
                  <option value="">— not set —</option>
                  {occSuggestions.map((o) => <option key={o} value={o}>{o}</option>)}
                </select>
              ) : (
                <>
                  <input list="class-occ-list" value={value != null ? value : (field.value == null ? '' : String(field.value))}
                    onChange={(e) => onChange(e.target.value)} style={{ ...inputStyle, width: '100%' }} />
                  <datalist id="class-occ-list">
                    {occSuggestions.map((o) => <option key={o} value={o} />)}
                  </datalist>
                </>
              )
            ) : (
              <input value={value != null ? value : (field.value == null ? '' : String(field.value))}
                onChange={(e) => onChange(e.target.value)}
                placeholder={field.state === 'missing' ? 'Needed before ordering' : ''}
                style={{ ...inputStyle, width: '100%' }} />
            )
          ) : (
            <div style={{ color: shownValue === '—' ? MUTED : INK, wordBreak: 'break-word' }}>{shownValue}</div>
          )}
          {field.why ? <div style={{ fontSize: 12, color: st.color, marginTop: 4 }}>{field.why}</div> : null}
        </div>
      </div>
    </div>
  );
}

function Contacts({ contacts }) {
  if (!contacts.length) return null;
  const NAME = {
    Borrower: 'Borrower', Coborrower: 'Co-borrower',
    PropertyAccess: 'Who lets the appraiser in', LoanOfficer: 'Loan officer',
  };
  return (
    <div style={{ marginTop: 14 }}>
      <SectionTitle>Who Class will contact</SectionTitle>
      <div style={{ border: `1px solid ${LINE}`, borderRadius: 10, overflow: 'hidden' }}>
        {contacts.map((c, i) => (
          <div key={`${c.Type}-${i}`} style={{ borderTop: i ? `1px solid ${LINE}` : 'none', padding: '9px 12px' }}>
            <div style={{ color: INK, fontWeight: 550 }}>
              {[c.firstName, c.lastName].filter(Boolean).join(' ') || '(no name on file)'}
              {c.primaryContact ? <span style={{ color: TEAL, fontSize: 12, fontWeight: 600 }}> · main contact</span> : null}
            </div>
            <div style={{ fontSize: 12, color: MUTED }}>
              {NAME[c.Type] || c.Type}
              {(c.contactMethods || []).length ? ' · ' + c.contactMethods.map((m) => m.value).join(' · ') : ' · no phone or email on file'}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function PlaceOrder({ cfg, canPlace, busy, onPlace, uad, derivedCount }) {
  const on = !!(cfg && cfg.enabled);
  const outbound = !!(cfg && cfg.outbound);
  const dry = !!(cfg && cfg.dryrun);
  // Why the button is unavailable, in the order a person would fix it.
  const blocked = !canPlace ? 'Fill in what’s still needed above first.'
    : !on ? 'The Class Valuation connection is switched off.'
    : !outbound ? 'Sending orders to Class is switched off.'
    : '';
  return (
    <div style={{ marginTop: 14, borderTop: `1px solid ${LINE}`, paddingTop: 12 }}>
      {derivedCount ? (
        <div style={{ fontSize: 13, color: GOLD, marginBottom: 8 }}>
          {derivedCount === 1 ? 'One value was' : `${derivedCount} values were`} worked out by PILOT rather than read
          off the file. Please read {derivedCount === 1 ? 'it' : 'them'} above before ordering — you can change
          {derivedCount === 1 ? ' it' : ' them'} on the spot.
        </div>
      ) : null}
      <button className="btn primary" disabled={busy || !!blocked} onClick={onPlace} title={blocked}>
        {busy ? 'Working…' : dry ? 'Build the order (test mode — nothing is sent)' : 'Order this appraisal from Class'}
      </button>
      <div style={{ marginTop: 6, fontSize: 12, color: MUTED }}>Goes out on their {uad} form.</div>
      {blocked ? <div style={{ marginTop: 6, fontSize: 12, color: MUTED }}>{blocked}</div> : null}
      {!blocked && !dry ? (
        <div style={{ marginTop: 6, fontSize: 12, color: MUTED }}>
          This costs money and sends an appraiser to the property.
        </div>
      ) : null}
    </div>
  );
}

/* ---- little shared bits ---- */
const inputStyle = {
  border: `1px solid ${LINE}`, borderRadius: 8, padding: '6px 8px', color: INK, background: '#fff', fontSize: 14,
};
const linkBtn = {
  border: 'none', background: 'none', color: TEAL, cursor: 'pointer', padding: 0, fontSize: 12, fontWeight: 550,
};

function Legend() {
  return (
    <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap', marginBottom: 6 }}>
      {['read', 'derived', 'overridden', 'missing'].map((k) => (
        <span key={k} style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 11, color: STATE[k].color }}>
          <span style={{ width: 7, height: 7, borderRadius: 99, background: STATE[k].dot, display: 'inline-block' }} />
          {STATE[k].label}
        </span>
      ))}
    </div>
  );
}
function Banner({ tone, children }) {
  const bad = tone === 'bad';
  return <div style={{ border: `1px solid ${bad ? '#E4B4AE' : '#B7D8C4'}`, background: bad ? '#FBEEEC' : '#EEF7F1', color: bad ? '#8A2F27' : '#1E5E3C', borderRadius: 8, padding: '8px 10px', marginBottom: 10, fontSize: 13 }}>{children}</div>;
}
function SectionTitle({ children }) {
  return <div style={{ fontSize: 12, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '.04em', color: MUTED, marginBottom: 6 }}>{children}</div>;
}
