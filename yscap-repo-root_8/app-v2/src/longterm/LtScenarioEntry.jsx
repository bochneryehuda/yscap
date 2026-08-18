import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import LtLayout from './LtLayout.jsx';
import { ltApi } from './api.js';

// ---------------------------------------------------------------------------
// SCENARIO ENTRY — Basic vs Advanced (D28; owner's words: "Basic vs Advanced
// search sections (searchable, unlimited advanced options)").
//
// BASIC   = the manifest's `core` — the everyday pricing anchors.
// ADVANCED = everything else (`advanced` + `overlay`), collapsed by default, with a
//            search box that filters as you type, so the section stays usable at any
//            size the server grows it to.
//
// THE SCREEN IS DRIVEN BY THE MANIFEST, NOT BY A LIST IN THIS FILE. It carries no
// field names at all: it fetches the pricer's own accepted-field manifest and draws
// whatever comes back, so a field added server-side appears here on the next load
// with nothing to remember. That is the whole point of D28 — a hand-kept UI list is
// a list that goes stale silently.
//
// AND IT NEVER INVENTS METADATA. The manifest publishes two DIFFERENT shapes:
//   • `overlay` entries are objects carrying label / type / enumValues / default /
//     category / effect — those are rendered as the typed controls they describe
//     (an enum becomes a picker over its OWN published values).
//   • `core` and `advanced` are bare KEY STRINGS with no label, no type and no unit.
//     Those are drawn under their exact key with a plain box, and the screen SAYS
//     the manifest publishes no type for them. A human label or a unit invented here
//     would be a business fact nobody stated — so it is not invented, it is reported.
//
// Dark text on the white PILOT canvas throughout — never a `--ink*` token, which is a
// LIGHT paper colour in this palette and would render white-on-white. Explicit darks
// (#141B22 / #3A4550 / #4B585C) per the hard rule. Every wide block scrolls inside its
// own container so the page itself never scrolls sideways.
// ---------------------------------------------------------------------------

const INK = '#141B22';
const SLATE = '#3A4550';
const MUTED = '#4B585C';
const GOLD = '#AE8746';
const GOLD_INK = '#856529';
const TEAL = '#256168';
const RED = '#8A2F2F';
const PAPER = '#F4F1EA';
const LINE = 'rgba(20,27,34,.10)';

const card = {
  border: '1px solid rgba(20,27,34,.12)', borderRadius: 14, padding: 18,
  background: '#fff', marginBottom: 16,
};
const h2 = { margin: '0 0 4px', fontSize: 16, color: INK, fontWeight: 600 };
const sub = { margin: '0 0 14px', fontSize: 13, color: MUTED, lineHeight: 1.5 };
const eyebrow = {
  fontSize: 11, letterSpacing: '.1em', textTransform: 'uppercase',
  color: MUTED, fontWeight: 700,
};
const mono = { fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace' };

// The two section names the manifest itself uses. Not field names — the manifest's
// own top-level keys, which is what tells the screen which shape to expect.
const SEC_REGISTRY = 'advanced';
const SEC_OVERLAY = 'overlay';

function Pill({ tone, title, children }) {
  const tones = {
    good: { bg: 'rgba(47,127,134,.10)', fg: TEAL, bd: 'rgba(47,127,134,.35)' },
    warn: { bg: 'rgba(174,135,70,.12)', fg: GOLD_INK, bd: 'rgba(174,135,70,.40)' },
    bad: { bg: 'rgba(158,58,58,.10)', fg: RED, bd: 'rgba(158,58,58,.32)' },
    flat: { bg: PAPER, fg: SLATE, bd: 'rgba(20,27,34,.14)' },
  };
  const t = tones[tone] || tones.flat;
  return (
    <span title={title} style={{
      display: 'inline-block', padding: '1px 8px', borderRadius: 999, fontSize: 11,
      fontWeight: 600, background: t.bg, color: t.fg, border: `1px solid ${t.bd}`,
      whiteSpace: 'nowrap',
    }}>{children}</span>
  );
}

/**
 * One manifest entry, normalized to the shape this screen draws — WITHOUT adding
 * anything the manifest did not publish. A bare string keeps `label`/`type`/`unit`
 * null, and the row below renders that absence honestly instead of guessing.
 */
function normalizeEntry(entry, section) {
  if (entry && typeof entry === 'object') {
    return {
      key: String(entry.key == null ? '' : entry.key),
      label: typeof entry.label === 'string' && entry.label ? entry.label : null,
      kind: typeof entry.type === 'string' && entry.type ? entry.type : null,
      enumValues: Array.isArray(entry.enumValues) && entry.enumValues.length ? entry.enumValues : null,
      hasDefault: Object.prototype.hasOwnProperty.call(entry, 'default'),
      dflt: entry.default,
      category: typeof entry.category === 'string' && entry.category ? entry.category : null,
      effect: typeof entry.effect === 'string' && entry.effect ? entry.effect : null,
      // The manifest publishes no `unit` on any section today. It is read anyway so
      // that the day one is added, it renders — rather than needing this file edited.
      unit: typeof entry.unit === 'string' && entry.unit ? entry.unit : null,
      // TWO INDEPENDENT FLAGS, and reading either for the other is the conflation task #82 removed.
      // `overlayOnly` = OUR engine enforces this fact's eligibility cuts itself. `lpPrices` = Lender
      // Price was MEASURED to itemize a charge for it — `true` only where a live probe said so, and
      // absent everywhere nobody has asked, which is NOT a claim that Lender Price ignores the fact.
      // Only an explicit `true` is honoured, so an older server publishing neither draws neither badge.
      overlayOnly: entry.overlayOnly === true,
      lpPrices: entry.lpPrices === true,
      section,
    };
  }
  return {
    key: String(entry == null ? '' : entry),
    label: null, kind: null, enumValues: null, hasDefault: false, dflt: undefined,
    category: null, effect: null, unit: null, overlayOnly: false, lpPrices: false, section,
  };
}

const listOf = (v, section) => (Array.isArray(v) ? v : []).map((e) => normalizeEntry(e, section)).filter((f) => f.key);

// What this screen KNOWS about a field, said plainly. A field whose type the manifest
// does not publish is drawn as a plain box and labelled as such — never guessed into
// a number or a picker, because the wrong control silently changes what gets entered.
function typeNote(f) {
  if (f.kind === 'enum') return f.enumValues ? `one of ${f.enumValues.length} published values` : 'enum (no values published)';
  if (f.kind) return f.kind;
  return 'no type published';
}

/** One field row. Every control it draws comes from the entry's own metadata. */
function FieldRow({ f, value, onChange }) {
  const stated = value !== undefined && value !== '';
  const idBase = `lt-sc-${f.section}-${f.key}`;

  let control;
  if (f.kind === 'enum' && f.enumValues) {
    control = (
      <select
        id={idBase} className="input" style={{ minWidth: 170, maxWidth: '100%' }}
        value={value === undefined ? '' : String(value)}
        onChange={(e) => onChange(f, e.target.value === '' ? undefined : e.target.value)}
      >
        <option value="">Not stated</option>
        {f.enumValues.map((v) => <option key={String(v)} value={String(v)}>{String(v)}</option>)}
      </select>
    );
  } else if (f.kind === 'boolean') {
    control = (
      <select
        id={idBase} className="input" style={{ minWidth: 170, maxWidth: '100%' }}
        value={value === undefined ? '' : (value ? 'yes' : 'no')}
        onChange={(e) => onChange(f, e.target.value === '' ? undefined : e.target.value === 'yes')}
      >
        <option value="">Not stated</option>
        <option value="yes">Yes</option>
        <option value="no">No</option>
      </select>
    );
  } else {
    control = (
      <input
        id={idBase} className="input" style={{ minWidth: 170, maxWidth: '100%' }}
        inputMode={f.kind === 'number' ? 'decimal' : undefined}
        value={value === undefined ? '' : String(value)}
        onChange={(e) => onChange(f, e.target.value === '' ? undefined : e.target.value)}
        placeholder={f.kind === 'number' ? 'number' : 'not stated'}
      />
    );
  }

  return (
    <div style={{
      padding: '10px 12px', borderRadius: 10,
      border: `1px solid ${stated ? 'rgba(174,135,70,.42)' : LINE}`,
      background: stated ? 'rgba(174,135,70,.05)' : '#fff',
    }}>
      <label htmlFor={idBase} style={{ display: 'block' }}>
        {/* The manifest's own label when it published one; otherwise the exact key,
            which is the only name that actually exists. */}
        <div style={{ fontSize: 13.5, color: INK, fontWeight: 600, wordBreak: 'break-word' }}>
          {f.label || <span style={mono}>{f.key}</span>}
        </div>
        {f.label && (
          <div style={{ ...mono, fontSize: 11, color: MUTED, marginTop: 1, wordBreak: 'break-word' }}>{f.key}</div>
        )}
      </label>

      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', margin: '6px 0 7px' }}>
        <Pill tone={f.kind ? 'flat' : 'warn'} title="published by the field manifest">{typeNote(f)}</Pill>
        {f.unit && <Pill tone="flat" title="unit published by the manifest">{f.unit}</Pill>}
        {f.category && <Pill tone="flat">{f.category}</Pill>}
        {f.hasDefault && f.dflt !== undefined && f.dflt !== null && (
          <Pill tone="flat" title="the manifest's published default when the scenario says nothing">
            default {String(f.dflt)}
          </Pill>
        )}
        {f.overlayOnly && (
          <Pill tone="warn" title="Our engine applies this fact's eligibility rules itself, on top of Lender Price — a disagreement here is deliberate and carries a stated reason">
            overlay only
          </Pill>
        )}
        {f.lpPrices && (
          <Pill tone="good" title="Measured live: Lender Price itemizes a price adjustment for this fact, so it is sent to them as well as applied here">
            Lender Price prices this
          </Pill>
        )}
      </div>

      <div style={{ marginTop: 2 }}>{control}</div>

      {f.effect && (
        <div style={{ fontSize: 11.5, color: MUTED, marginTop: 6, lineHeight: 1.45 }}>{f.effect}</div>
      )}
    </div>
  );
}

const grid = {
  display: 'grid', gap: 10,
  gridTemplateColumns: 'repeat(auto-fill, minmax(240px, 1fr))',
};

export default function LtScenarioEntry() {
  const [manifest, setManifest] = useState(null);
  const [error, setError] = useState('');
  const [values, setValues] = useState({});
  const [openAdvanced, setOpenAdvanced] = useState(false); // collapsed by default
  const [q, setQ] = useState('');
  const searchRef = useRef(null);

  useEffect(() => {
    let alive = true;
    ltApi.dscrFields()
      .then((r) => { if (alive) setManifest((r && r.manifest) || null); })
      .catch((e) => { if (alive) setError(e.message || 'The field manifest could not be loaded.'); });
    return () => { alive = false; };
  }, []);

  const basic = useMemo(() => listOf(manifest && manifest.core, 'core'), [manifest]);
  const registry = useMemo(() => listOf(manifest && manifest.advanced, SEC_REGISTRY), [manifest]);
  const overlay = useMemo(() => listOf(manifest && manifest[SEC_OVERLAY], SEC_OVERLAY), [manifest]);
  // "Everything else" = advanced + overlay. The manifest guarantees the three sections
  // are DISJOINT, so this concatenation can never double-count a field.
  const advanced = useMemo(() => [...registry, ...overlay], [registry, overlay]);

  const needle = q.trim().toLowerCase();
  const filtered = useMemo(() => {
    if (!needle) return advanced;
    return advanced.filter((f) =>
      f.key.toLowerCase().includes(needle)
      || (f.label && f.label.toLowerCase().includes(needle))
      || (f.category && f.category.toLowerCase().includes(needle)));
  }, [advanced, needle]);

  const onChange = useCallback((f, v) => {
    setValues((prev) => {
      const next = { ...prev };
      if (v === undefined) delete next[f.key]; else next[f.key] = v;
      return next;
    });
  }, []);

  // Typing in the search opens the section — a filter that matches nothing visible is
  // a dead end.
  const onSearch = (e) => {
    setQ(e.target.value);
    if (e.target.value && !openAdvanced) setOpenAdvanced(true);
  };

  const statedKeys = Object.keys(values);
  const scenario = useMemo(() => {
    const out = {};
    for (const k of Object.keys(values).sort()) out[k] = values[k];
    return out;
  }, [values]);

  // ---- THE MIRROR: search Lender Price with exactly this scenario ---------------------------
  //
  // ⛔ THE FORM HAD NO SUBMIT. Everything above drew the scenario from the pricer's own manifest and
  // then rendered it as JSON — `POST /api/lt/dscr/price` has been shipping and staff-gated all along,
  // and `LT-ROUTES-UNREACHED.md` recorded in the repo's own words that it was "used by the offline
  // measurement scripts and by hand". The mirror was never a missing integration; it was a missing wire.
  //
  // ⛔ NEVER FROM AN EFFECT. Each search is a paid live vendor call, so it runs only from this button.
  // A search that fired on render would bill us for every mounted screen.
  const [searching, setSearching] = useState(false);
  const [result, setResult] = useState(null);
  const [searchError, setSearchError] = useState(null);
  const [disq, setDisq] = useState(null);
  const [investorFilter, setInvestorFilter] = useState('');

  const runSearch = useCallback(async () => {
    setSearching(true); setSearchError(null); setResult(null); setDisq(null);
    try {
      const r = await ltApi.dscrPrice(scenario);
      setResult(r);
      // The INELIGIBLE side is computed asynchronously on the vendor's side, so it is POLLED by the
      // search key the price handed back — never re-searched, which would be a second paid call and a
      // different key. 202 means still computing; the route asks for a 2s wait and we honour it.
      if (r && r.searchKey) {
        const key = r.searchKey;
        for (let attempt = 0; attempt < 8; attempt += 1) {
          const d = await ltApi.dscrDisqualifications(key).catch((e) => ({ _err: e }));
          if (d && !d._err && d.ok) { setDisq(d); break; }
          if (d && d._err && d._err.status === 409) { setDisq({ expired: true }); break; }
          await new Promise((res) => { setTimeout(res, 2000); });
        }
      }
    } catch (e) {
      setSearchError((e && (e.message || e.error)) || 'The search failed.');
    } finally {
      setSearching(false);
    }
  }, [scenario]);

  // Filtering is CLIENT-SIDE over what came back, so narrowing to one investor costs nothing and
  // never re-prices. Every count below reports the unfiltered total beside the filtered one, so a
  // filter can never read as "this is all there was".
  const programs = useMemo(() => {
    const all = (result && result.programs) || [];
    if (!investorFilter) return all;
    const needle = investorFilter.toLowerCase();
    return all.filter((p) => `${p.lender || ''} ${p.program || ''}`.toLowerCase().includes(needle));
  }, [result, investorFilter]);

  const countOf = (k) => (manifest && manifest.counts && Number.isFinite(manifest.counts[k]) ? manifest.counts[k] : null);

  return (
    <LtLayout title="Scenario entry">
      <div style={card}>
        <h2 style={h2}>Enter a deal — Basic, then Advanced when you need it</h2>
        <p style={sub}>
          Every field on this page comes from the pricer's own accepted-field manifest, so a field added
          on the server shows up here by itself. <strong style={{ color: SLATE }}>Basic</strong> is the
          everyday pricing anchors; <strong style={{ color: SLATE }}>Advanced</strong> is everything else,
          searchable, and folded away until you open it.
        </p>

        {error && (
          <div style={{
            padding: '10px 12px', borderRadius: 10, background: 'rgba(158,58,58,.06)',
            border: '1px solid rgba(158,58,58,.28)', color: RED, fontSize: 13,
          }}>{error}</div>
        )}
        {!manifest && !error && <p style={{ ...sub, marginBottom: 0 }}>Loading the field manifest…</p>}

        {manifest && (
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <Pill tone="flat">{basic.length} basic</Pill>
            <Pill tone="flat">{advanced.length} advanced</Pill>
            <Pill tone={statedKeys.length ? 'good' : 'flat'}>{statedKeys.length} stated</Pill>
            {countOf('supported') != null && (
              <Pill tone="flat" title="the pricer's whole accepted set — core plus advanced plus overlay">
                {countOf('supported')} accepted in total
              </Pill>
            )}
          </div>
        )}
      </div>

      {manifest && (
        <>
          {/* ---------------- BASIC ---------------- */}
          <div style={card}>
            <h2 style={h2}>Basic</h2>
            <p style={sub}>
              The everyday pricing anchors. The manifest publishes these as field names only — no label,
              no type and no unit — so each one is shown under its exact name and takes what you type,
              verbatim.
            </p>
            {basic.length === 0
              ? <p style={{ ...sub, marginBottom: 0 }}>The manifest published no basic fields.</p>
              : (
                <div style={grid}>
                  {basic.map((f) => (
                    <FieldRow key={f.key} f={f} value={values[f.key]} onChange={onChange} />
                  ))}
                </div>
              )}
          </div>

          {/* ---------------- ADVANCED ---------------- */}
          <div style={card}>
            <div style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
              <button
                type="button"
                onClick={() => setOpenAdvanced((v) => !v)}
                aria-expanded={openAdvanced}
                aria-controls="lt-advanced-body"
                style={{
                  border: `1px solid ${GOLD}`, background: openAdvanced ? 'rgba(174,135,70,.10)' : '#fff',
                  color: GOLD_INK, borderRadius: 999, padding: '5px 14px', fontSize: 13,
                  fontWeight: 700, cursor: 'pointer',
                }}
              >
                {openAdvanced ? '▾' : '▸'} Advanced ({advanced.length})
              </button>
              <span style={{ fontSize: 12.5, color: MUTED }}>
                Everything the pricer accepts beyond the basics — folded away until you need it.
              </span>
            </div>

            {openAdvanced && (
              <div id="lt-advanced-body" style={{ marginTop: 14 }}>
                <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap', marginBottom: 10 }}>
                  <label htmlFor="lt-advanced-search" style={{ ...eyebrow }}>Search</label>
                  <input
                    id="lt-advanced-search"
                    ref={searchRef}
                    className="input"
                    style={{ minWidth: 240, flex: '1 1 240px', maxWidth: 420 }}
                    value={q}
                    onChange={onSearch}
                    placeholder="Filter by name or label…"
                    autoComplete="off"
                  />
                  {q && (
                    <button
                      type="button"
                      onClick={() => { setQ(''); if (searchRef.current) searchRef.current.focus(); }}
                      style={{
                        border: `1px solid ${LINE}`, background: '#fff', color: SLATE,
                        borderRadius: 8, padding: '5px 10px', fontSize: 12.5, cursor: 'pointer',
                      }}
                    >Clear</button>
                  )}
                  <span style={{ fontSize: 12.5, color: MUTED }}>
                    Showing {filtered.length} of {advanced.length}
                  </span>
                </div>

                {filtered.length === 0 ? (
                  <p style={{ ...sub, marginBottom: 0 }}>
                    Nothing matches “{q}”. The advanced set holds {advanced.length} fields.
                  </p>
                ) : (
                  // The advanced set is unbounded by design, so it scrolls inside its own
                  // container — the page itself never grows a sideways or endless scroll.
                  <div style={{
                    maxHeight: 560, overflowY: 'auto', overflowX: 'auto',
                    border: `1px solid ${LINE}`, borderRadius: 12, padding: 12,
                    background: '#FCFBF8',
                  }}>
                    <div style={grid}>
                      {filtered.map((f) => (
                        <FieldRow key={`${f.section}:${f.key}`} f={f} value={values[f.key]} onChange={onChange} />
                      ))}
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>

          {/* ---------------- WHAT YOU HAVE STATED ---------------- */}
          <div style={card}>
            <div style={{ display: 'flex', gap: 10, alignItems: 'baseline', flexWrap: 'wrap', marginBottom: 4 }}>
              <h2 style={{ ...h2, margin: 0 }}>The scenario so far</h2>
              {statedKeys.length > 0 && (
                <button
                  type="button"
                  onClick={() => setValues({})}
                  style={{
                    border: `1px solid ${LINE}`, background: '#fff', color: SLATE,
                    borderRadius: 8, padding: '4px 10px', fontSize: 12.5, cursor: 'pointer',
                  }}
                >Clear all</button>
              )}
            </div>
            <p style={sub}>
              Only the fields you have actually stated. A field left blank is <em>not stated</em> — it is
              never sent as an empty value, because a blank and a zero are different answers. Values you
              typed into an untyped field are carried exactly as typed; the manifest publishes no type
              for those, so nothing here converts them.
            </p>
            {statedKeys.length === 0 ? (
              <p style={{ ...sub, marginBottom: 0 }}>Nothing stated yet.</p>
            ) : (
              <div style={{ overflowX: 'auto' }}>
                <pre style={{
                  ...mono, margin: 0, fontSize: 12.5, color: INK, background: PAPER,
                  border: `1px solid ${LINE}`, borderRadius: 10, padding: 12, minWidth: 260,
                }}>{JSON.stringify(scenario, null, 2)}</pre>
              </div>
            )}
          </div>

          {/* ---------------- THE MIRROR ---------------- */}
          <div style={{ ...card, borderColor: 'rgba(37,97,104,.34)' }}>
            <h2 style={h2}>Search Lender Price with this scenario</h2>
            <p style={{ ...sub, marginBottom: 10 }}>
              Sends exactly the scenario above and shows what Lender Price answers — the programs it
              will price, the lenders it declines and why, and its own confirmation of the deal it
              understood. <strong style={{ color: SLATE }}>Each search is a live call</strong>, so it
              runs only when you press the button.
            </p>
            <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center' }}>
              <button
                type="button"
                onClick={runSearch}
                disabled={searching || statedKeys.length === 0}
                style={{
                  border: `1px solid ${TEAL}`, borderRadius: 10, padding: '9px 16px',
                  background: searching || statedKeys.length === 0 ? '#E7ECEC' : TEAL,
                  color: searching || statedKeys.length === 0 ? MUTED : '#FFFFFF',
                  fontWeight: 650, fontSize: 13.5,
                  cursor: searching || statedKeys.length === 0 ? 'not-allowed' : 'pointer',
                }}
              >
                {searching ? 'Searching Lender Price…' : 'Search Lender Price'}
              </button>
              {statedKeys.length === 0 && (
                <span style={{ fontSize: 12.5, color: MUTED }}>State at least one field first.</span>
              )}
              {result && (
                <input
                  value={investorFilter}
                  onChange={(e) => setInvestorFilter(e.target.value)}
                  placeholder="Filter by investor or program…"
                  style={{
                    border: `1px solid ${LINE}`, borderRadius: 8, padding: '8px 10px',
                    fontSize: 13, color: INK, background: '#FFFFFF', minWidth: 220,
                  }}
                />
              )}
            </div>

            {searchError && (
              <p style={{ marginTop: 12, marginBottom: 0, fontSize: 13, color: '#8A2B2B' }}>
                {String(searchError)}
              </p>
            )}

            {result && (
              <>
                {/* ---- DID LENDER PRICE UNDERSTAND US? ---- */}
                {result.understood && (
                  <div style={{
                    marginTop: 14, padding: 12, borderRadius: 10,
                    border: `1px solid ${result.understood.understood ? 'rgba(37,97,104,.34)' : 'rgba(174,135,70,.5)'}`,
                    background: result.understood.understood ? 'rgba(37,97,104,.06)' : 'rgba(174,135,70,.08)',
                  }}>
                    <div style={{ fontWeight: 650, fontSize: 13.5, color: result.understood.understood ? TEAL : GOLD_INK }}>
                      {!result.understood.available
                        ? 'Lender Price did not state the search it ran'
                        : result.understood.understood
                          ? `Lender Price confirms it ran the deal you entered — ${result.understood.checked} fields checked, all agreed`
                          : `Lender Price ran something different on ${result.understood.mismatched.length} field(s)`}
                    </div>
                    {/* A field we sent that they did not echo is NOT agreement, and is reported as its
                        own number so "nobody looked" can never read as "everything matched". */}
                    {result.understood.available && (
                      <p style={{ margin: '6px 0 0', fontSize: 12.5, color: MUTED, lineHeight: 1.6 }}>
                        {result.understood.agreed} of {result.understood.checked} confirmed
                        {result.understood.notEchoed && result.understood.notEchoed.length > 0
                          ? ` · ${result.understood.notEchoed.length} field(s) they did not echo back, so those are unconfirmed rather than agreed`
                          : ' · every field you set came back'}
                        {result.understood.vendorComputed && result.understood.vendorComputed.length > 0
                          ? ` · ${result.understood.vendorComputed.length} vendor-calculated field(s) excluded by name`
                          : ''}
                      </p>
                    )}
                    {!result.understood.available && result.understood.why && (
                      <p style={{ margin: '6px 0 0', fontSize: 12.5, color: MUTED }}>{result.understood.why}</p>
                    )}
                    {result.understood.mismatched && result.understood.mismatched.length > 0 && (
                      <div style={{ overflowX: 'auto', marginTop: 8 }}>
                        <table style={{ borderCollapse: 'collapse', fontSize: 12.5, minWidth: 420 }}>
                          <thead>
                            <tr>
                              {['field', 'you asked for', 'they ran'].map((h) => (
                                <th key={h} style={{ textAlign: 'left', padding: '4px 10px 4px 0', color: SLATE, fontWeight: 650 }}>{h}</th>
                              ))}
                            </tr>
                          </thead>
                          <tbody>
                            {result.understood.mismatched.map((m) => (
                              <tr key={m.field}>
                                <td style={{ ...mono, padding: '3px 10px 3px 0', color: INK }}>{m.field}</td>
                                <td style={{ ...mono, padding: '3px 10px 3px 0', color: INK }}>{JSON.stringify(m.sent)}</td>
                                <td style={{ ...mono, padding: '3px 10px 3px 0', color: GOLD_INK }}>{JSON.stringify(m.ran)}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    )}
                  </div>
                )}

                {/* ---- ELIGIBLE ---- */}
                <h3 style={{ fontSize: 14, color: INK, margin: '16px 0 6px' }}>
                  Programs that will price — {programs.length}
                  {investorFilter ? ` of ${(result.programs || []).length}` : ''}
                  {Number.isFinite(result.lenderCount) ? ` · ${result.lenderCount} lender(s)` : ''}
                </h3>
                {programs.length === 0 ? (
                  <p style={{ ...sub, marginBottom: 0 }}>
                    {investorFilter ? 'No program matches that filter.' : 'Lender Price priced nothing for this scenario.'}
                  </p>
                ) : (
                  <div style={{ overflowX: 'auto' }}>
                    <table style={{ borderCollapse: 'collapse', fontSize: 12.5, minWidth: 560, width: '100%' }}>
                      <thead>
                        <tr>
                          {['lender', 'program', 'best rate', 'best price', 'rungs'].map((h) => (
                            <th key={h} style={{ textAlign: 'left', padding: '5px 12px 5px 0', color: SLATE, fontWeight: 650, borderBottom: `1px solid ${LINE}` }}>{h}</th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {programs.map((p, i) => (
                          <tr key={`${p.lender}|${p.program}|${i}`}>
                            <td style={{ padding: '5px 12px 5px 0', color: INK }}>{p.lender || '—'}</td>
                            <td style={{ padding: '5px 12px 5px 0', color: INK }}>{p.program || '—'}</td>
                            <td style={{ ...mono, padding: '5px 12px 5px 0', color: INK, fontVariantNumeric: 'tabular-nums' }}>
                              {Number.isFinite(p.minRate) ? p.minRate.toFixed(3) : '—'}
                            </td>
                            <td style={{ ...mono, padding: '5px 12px 5px 0', color: INK, fontVariantNumeric: 'tabular-nums' }}>
                              {Number.isFinite(p.maxPrice) ? p.maxPrice.toFixed(3) : '—'}
                            </td>
                            <td style={{ ...mono, padding: '5px 12px 5px 0', color: MUTED, fontVariantNumeric: 'tabular-nums' }}>{p.rungCount}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}

                {/* ---- INELIGIBLE ---- */}
                <h3 style={{ fontSize: 14, color: INK, margin: '16px 0 6px' }}>
                  Declined — {disq && disq.ok ? `${disq.lenderCount || 0} lender(s)` : disq && disq.expired ? 'the search key expired' : 'still computing…'}
                </h3>
                <p style={{ ...sub, marginBottom: 8 }}>
                  Lender Price works the declines out after the prices, so this fills in a moment later.
                  It is polled by the search key, never re-searched — a second search would be a second
                  live call and a different answer.
                </p>
                {disq && disq.ok && Array.isArray(disq.lenders) && disq.lenders.length > 0 && (
                  <div style={{ overflowX: 'auto' }}>
                    <table style={{ borderCollapse: 'collapse', fontSize: 12.5, minWidth: 520, width: '100%' }}>
                      <thead>
                        <tr>
                          {['lender', 'program', 'why it was declined'].map((h) => (
                            <th key={h} style={{ textAlign: 'left', padding: '5px 12px 5px 0', color: SLATE, fontWeight: 650, borderBottom: `1px solid ${LINE}` }}>{h}</th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {disq.lenders
                          .filter((l) => !investorFilter || `${l.lender || ''}`.toLowerCase().includes(investorFilter.toLowerCase()))
                          .flatMap((l, li) => (l.items || []).slice(0, 8).map((it, ii) => (
                            <tr key={`${li}|${ii}`}>
                              <td style={{ padding: '4px 12px 4px 0', color: INK }}>{l.lender || '—'}</td>
                              <td style={{ padding: '4px 12px 4px 0', color: INK }}>{it.program || '—'}</td>
                              <td style={{ padding: '4px 12px 4px 0', color: MUTED }}>
                                {(it.reasons || []).map((r) => r.rule).filter(Boolean).slice(0, 3).join(' · ') || '—'}
                              </td>
                            </tr>
                          )))}
                      </tbody>
                    </table>
                  </div>
                )}
              </>
            )}
          </div>

          {/* ---------------- WHAT THE MANIFEST DOES NOT SAY ---------------- */}
          <div style={{ ...card, borderColor: 'rgba(174,135,70,.34)' }}>
            <h2 style={h2}>What the manifest does not publish</h2>
            <p style={{ ...sub, marginBottom: 8 }}>
              Said out loud rather than papered over. The basic and advanced-registry sections come
              through as field names only, so this screen has no human label, no type and no unit for
              them and does not invent one. The overlay facts carry their own label, type, enum values
              and default, which is why those render as real pickers.
            </p>
            {Array.isArray(manifest.meta) && manifest.meta.length > 0 && (
              <p style={{ fontSize: 12.5, color: MUTED, margin: 0, lineHeight: 1.6 }}>
                The manifest also lists {manifest.meta.length} request-envelope keys that are
                <strong style={{ color: SLATE }}> not pricing inputs</strong> and are deliberately absent
                from both sections above:{' '}
                <span style={{ ...mono, color: SLATE }}>{manifest.meta.join(', ')}</span>
              </p>
            )}
          </div>
        </>
      )}

      <p style={{ fontSize: 12, color: MUTED, marginTop: 4 }}>
        Drawn entirely from the pricer's own field manifest (<code>GET /api/lt/dscr/fields</code>) — this
        page carries no field list of its own, so it cannot drift from what the pricer actually accepts.
      </p>
    </LtLayout>
  );
}
