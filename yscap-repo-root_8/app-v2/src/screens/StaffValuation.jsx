import React, { useCallback, useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api } from '../lib/api.js';
import ValuationQc from '../components/ValuationQc.jsx';
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

/* THE PRINTED REPORT HAS TO BE THE WHOLE REPORT.

   This screen's print rule used to be three `display:none` lines, and the
   valuation is the deliverable — the thing somebody prints and files. Two ways
   it came out incomplete, both of which the appraisal panel already documents
   and solves:

   · THE GRID IS A HORIZONTAL SCROLLER. Comparables are COLUMNS, and the section
     carries `overflow-x:auto` so the screen can scroll to the fourth and fifth.
     On paper an overflow container CLIPS: everything past the fold was simply
     absent, with no sign it had been cut. A grid missing its right-hand comps is
     worse than no printout, because it reads as complete.

   · COLOUR CARRIES MEANING HERE. A negative adjustment is red and the total row
     is shaded; browsers drop background colours when printing unless told not
     to, so the one visual cue distinguishing a subtraction from an addition
     disappeared.

   Also sets a page margin, keeps a comparable's cell from splitting across
   pages, and never breaks a page straight after a heading. */
const PRINT_CSS = `
@media print {
  @page { margin: 14mm; }
  html, body { background: #fff !important; }
  .app-sidebar, .app-topbar, .btn { display: none !important; }
  /* A SELECT HERE IS CONTENT, NOT A CONTROL — hiding it DELETED two facts from
     the report. The valuation method (how the indicated value was derived) and
     the subject's condition are both selects, and condition is the one subject
     fact that is not an input, so it was the only one to vanish while its
     neighbours printed. They are flattened the same way the adjustment inputs
     are: the value, without the box. */
  select { appearance: none; -webkit-appearance: none; border: 0 !important;
    padding: 0 !important; background: transparent !important; color: #141B22 !important; }
  /* The scroll containers, opened out so the full grid reaches the paper. */
  [style*="overflow"] { overflow: visible !important; }
  table { width: 100% !important; table-layout: fixed !important; font-size: 9.5px !important; }
  td, th { padding: 3px 4px !important; overflow-wrap: anywhere !important; }
  /* An input is how an adjustment is typed on screen; on paper it is just the
     number, and a box drawn round every cell makes the grid unreadable. */
  input { border: 0 !important; padding: 0 !important; background: transparent !important;
    font-size: 9.5px !important; }
  /* THE RATE DETAIL REACHES THE PAPER ON EVERY PATH. Making the stylesheet
     unconditional was done precisely because Ctrl+P and "Save as PDF" never run
     our button — and the detail was still gated on that same button through
     React, so those two paths went on printing an adjustment without the rate
     behind it. It is now always in the DOM and merely hidden on screen, so the
     print rule can reveal it however the print was started. */
  .mr-detail { display: block !important; }
  section { break-inside: auto; }
  h1, h2, h3 { break-after: avoid; }
  * { -webkit-print-color-adjust: exact !important; print-color-adjust: exact !important; }
}
`;

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
          {/* THE BRANDED REPORT is its own page, so it prints as a document
              rather than as a printout of this working screen. */}
          <Link className="btn btn-gold small" to={`/internal/research/valuation/${id}/report`}
            style={{ textDecoration: 'none' }}>
            Comparable report
          </Link>
          <button className="btn ghost small" onClick={() => {
            setPrinting(true);
            // `finally`, because a print dialog that throws would otherwise leave
            // the screen in its printing state for good.
            setTimeout(() => { try { window.print(); } finally { setPrinting(false); } }, 50);
          }}>
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

      {/* ---- what the suggestions were worked out from ---- */}
      {/* OPENED FOR THE PRINTOUT. The detail is collapsed on screen because it is
          reference rather than headline — but a printed valuation that states an
          adjustment and not the rate behind it is exactly the document this panel
          exists to prevent. */}
      <MarketRates rates={v.market_rates} forceOpen={printing} />

      {/* DOES THIS SET SUPPORT THE NUMBER? Bracketing, the set-level warnings,
          each comparable's score BROKEN INTO ITS PARTS, and the per-comparable
          weight — all four already existed and none of them reached a screen. */}
      <ValuationQc
        bracketing={d.bracketing}
        comps={comps}
        warnings={g.warnings || []}
        disabled={isFinal}
        onWeight={isFinal ? null : (compId, weight) =>
          act('weight', () => api.valuationEditComp(id, compId, { weight }))}
      />


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
        <CompPicker valuationId={id} subject={v.subject_snapshot} purpose={v.purpose} onClose={() => setPicker(false)}
          onAdded={(next) => { setD(next); setPicker(false); }} />
      )}

      {/* ALWAYS MOUNTED, not only while our own button is held. Everything in it
          is inside `@media print`, so it costs nothing on screen — and the button
          is not the only way a report gets printed: Ctrl+P and the browser's own
          "Save as PDF" never set `printing`, so gating the stylesheet on it meant
          the two most likely ways to produce this document were exactly the ones
          that produced the clipped, colourless version of it. */}
      <style>{PRINT_CSS}</style>
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
        {[s.display_address, s.property_type,
          s.units != null ? `${s.units} unit${Number(s.units) === 1 ? '' : 's'}` : null,
          s.gla && sqft(s.gla), s.beds != null && `${s.beds} bed`,
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

/* WHERE THE SUGGESTED NUMBERS CAME FROM.

   The grid pre-fills itself from rates derived off our own closed sales, and
   `market_rates` is the record of what those were — the column exists so that
   "where did $119 a square foot come from?" stays answerable after the sales
   underneath have moved. Nothing rendered it, so the rates reached a reviewer
   only as the tail of a suggested line's note, which the grid then cut off.

   THE SOURCE LINE MATTERS MORE THAN THE NUMBER. The per-foot adjustment rate is
   either measured from what appraisers around here actually wrote on their
   grids, or it is a national rule of thumb (40% of the average price per foot)
   used because there was not enough local evidence. Those deserve very different
   amounts of trust, and a bare "$40" cannot tell you which one you are looking
   at.

   A REFUSED RATE IS SHOWN, NOT HIDDEN. "We could not read a price per bathroom,
   and here is why" is the honest answer to an empty grid line, and it stops a
   reviewer assuming the tool simply forgot. */
function MarketRates({ rates, forceOpen }) {
  const [open, setOpen] = useState(false);
  // The print pass forces it open WITHOUT touching the user's own choice, so
  // dismissing the browser's print dialog leaves the screen exactly as it was.
  const isOpen = open || !!forceOpen;
  const r = rates && typeof rates === 'object' ? rates : {};
  const keys = Object.keys(r);

  if (!keys.length) {
    return (
      <section style={{ ...S.panel, marginBottom: 14, color: MUTED, fontSize: 13 }}>
        Nothing has been worked out from our own sales yet. Add comparables, or press
        <b style={{ color: INK }}> Suggest adjustments</b>, and what the numbers were derived from is recorded here.
      </section>
    );
  }
  // A top-level `why` is the one refusal the rates object itself cannot carry —
  // no town or state on the subject, so there is no market to read.
  if (r.why && r.pricePerSqft === undefined) {
    return (
      <section style={{ ...S.panel, marginBottom: 14, borderColor: GOLD }}>
        <h2 style={{ margin: 0, fontSize: 16, color: INK }}>No rates could be worked out</h2>
        <div style={{ color: MUTED, fontSize: 13, marginTop: 6 }}>{r.why}</div>
      </section>
    );
  }

  const gla = r.glaAdjustmentPerSqft || {};
  const peer = gla.source === 'peer';
  const rows = [
    ['What a square foot sells for here', r.pricePerSqft, 'psf'],
    ['One bedroom', r.perBedroom, 'group'],
    ['One bathroom', r.perBath, 'group'],
    ['One condition grade', r.perConditionGrade, 'group'],
    ['How the market is moving', r.monthlyMarketChangePct, 'time'],
  ];

  return (
    <section style={{ ...S.panel, marginBottom: 14 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12 }}>
        <h2 style={{ margin: 0, fontSize: 16, color: INK }}>What these suggestions were worked out from</h2>
        <button className="btn ghost small" onClick={() => setOpen((o) => !o)}>{isOpen ? 'Hide the rest' : 'Show the rest'}</button>
      </div>

      {/* The rate the grid leans on hardest, with the thing that decides how much to trust it. */}
      <div style={{ marginTop: 10, display: 'flex', gap: 14, alignItems: 'baseline', flexWrap: 'wrap' }}>
        <div style={{ color: MUTED, fontSize: 12, fontWeight: 700, textTransform: 'uppercase' }}>
          Size adjustment
        </div>
        {gla.value != null ? (
          <>
            <div style={{ fontSize: 24, fontWeight: 700, color: INK }}>${gla.value}<span
              style={{ fontSize: 14, fontWeight: 400, color: MUTED }}> a square foot</span></div>
            {gla.low != null && gla.high != null && (
              <div style={{ color: MUTED, fontSize: 13 }}>most of them between ${gla.low} and ${gla.high}</div>
            )}
            <span style={{ ...S.tag, borderColor: peer ? '#2F7F86' : GOLD, color: peer ? '#2F7F86' : GOLD }}>
              {peer ? 'measured from our own reports' : 'national rule of thumb'}
            </span>
          </>
        ) : (
          <div style={{ fontSize: 15, color: MUTED }}>nothing we can stand behind</div>
        )}
      </div>
      <div style={{ color: MUTED, fontSize: 13, marginTop: 4, maxWidth: 760, lineHeight: 1.5 }}>
        {gla.basis || gla.why}
        {peer
          ? ' This is what appraisers in this market actually did, so it beats the trade convention.'
          : gla.value != null
            ? ' We do not have enough size adjustments from reports in this market yet, so this falls back to the'
              + ' trade habit rather than local evidence — worth a closer look before you rely on it.'
            : ''}
      </div>

      {/* THE 2-4 UNIT RATE, when this market has one. A 1025 grid states gross
          BUILDING area where a 1004 states living area, and they are measured
          and applied separately — several of our own towns hold their evidence
          almost entirely on this side, so hiding it would read as "no local
          evidence" in exactly the markets where we have the most. */}
      {r.glaAdjustmentPerSqftGba && r.glaAdjustmentPerSqftGba.value != null && (
        <div style={{ marginTop: 8, display: 'flex', gap: 14, alignItems: 'baseline', flexWrap: 'wrap' }}>
          <div style={{ color: MUTED, fontSize: 12, fontWeight: 700, textTransform: 'uppercase' }}>
            On 2–4 unit sales
          </div>
          <div style={{ fontSize: 20, fontWeight: 700, color: INK }}>
            ${r.glaAdjustmentPerSqftGba.value}<span style={{ fontSize: 13, fontWeight: 400, color: MUTED }}> a square foot</span>
          </div>
          <span style={{ ...S.tag, borderColor: '#2F7F86', color: '#2F7F86' }}>measured from our own reports</span>
          <div style={{ color: MUTED, fontSize: 13, flexBasis: '100%', lineHeight: 1.5 }}>
            {r.glaAdjustmentPerSqftGba.basis} — used for a sale that states building area rather than living area.
          </div>
        </div>
      )}

      {/* Never a silent filter: a forced sale left out is the most important line here. */}
      {r.distressedNote && (
        <div style={{ marginTop: 10, color: GOLD, fontSize: 13, lineHeight: 1.5 }}>{r.distressedNote}</div>
      )}

      <div className="mr-detail" style={{ display: isOpen ? 'block' : 'none' }}>{(
        <table style={{ width: '100%', borderCollapse: 'collapse', marginTop: 12 }}>
          <tbody>
            {rows.map(([label, rate, kind]) => (
              <tr key={label}>
                <td style={{ ...S.cell, width: 210, fontWeight: 700 }}>{label}</td>
                <td style={{ ...S.cell, width: 150, whiteSpace: 'nowrap' }}>
                  {rateValue(rate, kind)}
                </td>
                <td style={{ ...S.cell, color: MUTED, lineHeight: 1.5 }}>
                  {(rate && (rate.basis || rate.why)) || 'not worked out'}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}</div>

      <div className="mr-detail" style={{ display: isOpen ? 'block' : 'none' }}>{(
        <div style={{ color: MUTED, fontSize: 12, marginTop: 8 }}>
          Worked out from {r.sampleSize == null ? 'our' : r.sampleSize} closed
          {r.sampleSize === 1 ? ' sale' : ' sales'} in this market
          {r.minSample ? `, and a rate is refused below ${r.minSample} of them` : ''}.
        </div>
      )}</div>
    </section>
  );
}

/**
 * READ a number, as a number.
 *
 * `num` from `lib/research` is a FORMATTER — it returns a STRING, and `'—'` for
 * a null, so it never returns null and its output cannot be arithmetic'd or fed
 * back to `money`. `money(num(35250))` is `money('35,250')`, which is
 * `Number('35,250')`, which is **NaN** — so every one of these rows rendered
 * "$NaN", and the "no rate" branch below was unreachable because `'—' == null`
 * is false. The server-side `num` in `lib/research/valuation.js` DOES return
 * `number|null`, and mixing the two up is what produced it.
 */
function readNum(v) {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/** One rate as a number a person can check, or a plain "no" — never a blank. */
function rateValue(rate, kind) {
  if (!rate) return <span style={{ color: MUTED }}>—</span>;
  // A REFUSAL IS A RESULT. `value` and `valuePerSqft` are both absent on a refusal,
  // and `0` is not one — so test for null explicitly rather than truthiness.
  const v = readNum(kind === 'group' ? rate.valuePerSqft : rate.value);
  if (v == null) return <span style={{ color: MUTED }}>no rate</span>;
  // A market trend is TENTHS of a percent a month — rounded to whole numbers a
  // real +0.42%/month (about 5% a year) prints as "0% a month", which reads as a
  // flat market, and -0.5% prints as "-1%".
  if (kind === 'time') return <b style={{ color: INK }}>{v > 0 ? '+' : ''}{num(v, 2)}% a month</b>;
  if (kind === 'group') {
    // The dollars on a typical house here is the figure a human can sanity-check;
    // a per-foot rate for a bedroom is nearly impossible to judge by eye.
    const d = readNum(rate.approxDollarsOnTypicalHouse);
    return d == null
      ? <b style={{ color: INK }}>${num(v, 2)} a sq ft</b>
      : <><b style={{ color: INK }}>{money(d)}</b><div style={{ color: MUTED, fontSize: 11 }}>${num(v, 2)} a sq ft</div></>;
  }
  return <b style={{ color: INK }}>${num(v, 2)}</b>;
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
                {/* WHAT KIND OF BUILDING, AND HOW MANY DOORS — on the one screen
                    where the number is actually made. The comp search shows both
                    and this did not, so an officer could pick correctly and then
                    adjust a three-family against a house without either column
                    saying so. Both facts are already in the frozen snapshot; only
                    the rendering was missing. An unknown says so rather than
                    being left off, because a blank reads as "ordinary". */}
                <div style={{ fontWeight: 600, marginTop: 2,
                  color: (c.property_type && c.units != null) ? INK : '#B4423A' }}>
                  {[c.property_type || 'type not stated',
                    c.units != null ? `${c.units} unit${Number(c.units) === 1 ? '' : 's'}` : 'units not stated',
                  ].join(' · ')}
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
                        // NOT TRUNCATED. The note is where a suggested number says
                        // where it came from, and the reason is always at the END
                        // ("… at about $40/sq ft (what appraisers in this market
                        // actually adjusted, across 468 size adjustments on reports
                        // we paid for)") — so cutting it at 70 characters kept the
                        // arithmetic and threw away the provenance, which is the
                        // half a reviewer needs. A tooltip does not count as shown.
                        <div style={{ fontSize: 10, color: MUTED, marginTop: 2, lineHeight: 1.3 }}>
                          {l.source === 'suggested' ? 'suggested: ' : ''}{l.note}
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
function CompPicker({ valuationId, subject, purpose, onClose, onAdded }) {
  const [rows, setRows] = useState(null);
  const [sel, setSel] = useState(() => new Set());
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [relaxedTo, setRelaxedTo] = useState(null);
  const [relaxedLabel, setRelaxedLabel] = useState(null);
  // AN AFTER-REPAIR VALUE HAS TO REST ON SALES OF FINISHED HOUSES, and we do not
  // have to guess which those are: the appraiser put each comparable on either
  // the as-is grid or the after-repair grid, and the warehouse kept which. Every
  // other tool in this industry leaves you to work out from a photograph whether
  // a sale was renovated. So a valuation whose purpose is the after-repair value
  // starts on renovated sales — and it SAYS so in a control the officer can see
  // and change, because a default nobody can see or lift is how a filter empties
  // a screen and gets blamed on the town.
  const [q, setQ] = useState({ city: subject.city || '', state: subject.state || '',
    sold_within_months: '18', comp_set: purpose === 'arv' ? 'arv' : '' });

  const search = useCallback(() => {
    setRows(null); setErr('');
    const f = { ...q };
    // THE LADDER MAY ONLY RELAX WHAT WE SAY IS OURS. `relaxable` names the values
    // this screen supplied as its own defaults; anything else the server treats
    // as a deliberate instruction and never widens. Without it the "sales of any
    // kind" rung was unreachable from here — measured, 37 of 73 towns hold no
    // after-repair-grid sale at all and 54 of our own lent-on properties sit in
    // one, so an ARV valuation's picker opened EMPTY and advised widening the
    // town or the dates, neither of which is what emptied it.
    const mine = ['sold_within_months'];
    if (purpose === 'arv' && q.comp_set === 'arv') mine.push('comp_set');
    f.relaxable = mine.join(',');
    if (subject.id) f.property_id = subject.id;
    else { f.gla = subject.gla; f.beds = subject.beds; f.condition_uad = subject.condition_uad; }
    api.researchComps(f).then((d) => {
      setRows(d.rows || []);
      setRelaxedTo(d.relaxed_to || null);
      const last = (d.ladder || [])[(d.ladder || []).length - 1];
      setRelaxedLabel(last ? last.label : null);
    }).catch((e) => { setRows([]); setErr(e.message || 'Search failed'); });
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
          <select style={{ ...S.input, width: 'auto' }} value={q.comp_set}
            onChange={(e) => setQ({ ...q, comp_set: e.target.value })}
            aria-label="Which kind of sale">
            <option value="">Any sale</option>
            <option value="arv">Renovated sales only (after-repair grids)</option>
            <option value="as_is">As-is sales only</option>
          </select>
          <select style={{ ...S.input, width: 'auto' }} value={q.sold_within_months}
            onChange={(e) => setQ({ ...q, sold_within_months: e.target.value })}>
            <option value="6">Sold in the last 6 months</option>
            <option value="12">Last 12 months</option>
            <option value="18">Last 18 months</option>
            <option value="36">Last 3 years</option>
            {/* 0, not "" — see NearbyComps: an empty value never reaches the server. */}
            <option value="0">Any time</option>
          </select>
          <button className="btn ghost small" onClick={search}>Search</button>
        </div>
        {err && <div style={{ color: '#B4423A', fontSize: 13, marginBottom: 8 }}>{err}</div>}
        {rows == null && <div style={{ color: MUTED }}>Looking…</div>}
        {rows && rows.length === 0 && <div style={{ color: MUTED }}>Nothing close by. Try widening the town or the date range.</div>}
        {/* AND WHEN THE LADDER HAD TO LEAVE WHAT WAS ASKED FOR, IT SAYS SO. This
            screen shows no ladder, so without this an officer building an
            after-repair value would be handed as-is sales — or a different kind
            of building — with nothing on the screen saying which. */}
        {relaxedTo && relaxedTo !== 'as_asked' && (
          <div style={{ padding: '8px 10px', borderRadius: 8, background: '#FBF6EA',
            border: `1px solid ${GOLD}`, color: INK, fontSize: 12.5, marginBottom: 8 }}>
            Nothing matched as asked. These came from <b>{relaxedLabel || relaxedTo}</b> — each row says what it is.
          </div>
        )}
        <div style={{ display: 'grid', gap: 6 }}>
          {(rows || []).map((r) => (
            <label key={r.id} style={{ display: 'grid', gridTemplateColumns: 'auto 1fr auto auto', gap: 10,
              alignItems: 'center', border: '1px solid #EEE9DD', borderRadius: 8, padding: 8, cursor: 'pointer' }}>
              <input type="checkbox" checked={sel.has(r.id)}
                onChange={() => setSel((s) => { const n = new Set(s); n.has(r.id) ? n.delete(r.id) : n.add(r.id); return n; })} />
              <div>
                <div style={{ color: INK, fontWeight: 600, fontSize: 14 }}>{r.display_address}</div>
                {/* THE OWNER'S FIRST REQUIREMENT, at the moment of CHOOSING. The
                    grid states both facts once a comparable is on it — but this
                    is where the officer decides which ones to put there, and it
                    stated neither, so the choice was made blind. It matters here
                    especially: the search bands to the subject's kind of building
                    and falls back to any kind rather than leave an empty list, so
                    a row here can legitimately be a different kind of building. */}
                <div style={{ fontSize: 12, fontWeight: 600,
                  color: (r.property_type && r.units != null) ? INK : '#B4423A' }}>
                  {[r.property_type || 'type not stated',
                    r.units != null ? `${r.units} unit${Number(r.units) === 1 ? '' : 's'}` : 'units not stated',
                  ].join(' · ')}
                </div>
                {r.arv_comp_count > 0 && (
                  <div style={{ fontSize: 11.5, color: '#2F7F86', fontWeight: 600 }}>
                    used on an after-repair grid{r.arv_comp_count > 1 ? ` in ${r.arv_comp_count} reports` : ''}
                    {r.asis_comp_count > 0 ? ' — and on an as-is grid too' : ''}
                  </div>
                )}
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
