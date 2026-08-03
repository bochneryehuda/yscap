import React from 'react';
import { LAYOUTS, LAYOUT_KEYS, buildReport } from '../lib/compReport.js';

/* THE BRANDED PILOT COMPARABLE REPORT.
 *
 * Twelve sections, four layouts, one data model (`lib/compReport.js`). Every
 * decision about WHAT appears is made there and proved by
 * `scripts/test-comp-report-pure.mjs`; this file only decides how it looks, so
 * a layout can never quietly drop the confidence label, the range, the comp
 * count, the blank-adjustment sentences or the legal line.
 *
 * PRINTS THROUGH THE BROWSER, not through jsPDF. The vendored jsPDF is a
 * UMD global loaded by the static tool pages and would have to be re-plumbed
 * into the SPA; more to the point, hand-positioned PDF text cannot reflow, so
 * every long address and every extra comparable becomes a layout bug found by
 * the reader. The browser's own print engine paginates, hyphenates, embeds the
 * brand fonts and produces a PDF through "Save as PDF" — and it is verifiable,
 * because Chromium can render this page to a real PDF in a test and the pages
 * can be counted.
 *
 * THE PAGE BREAKS ARE THE FEATURE in the `full` layout — "one full page per
 * comp" — and `break-inside: avoid` on every card is what stops a comparable
 * being split across two sheets, which is the failure that makes a printed grid
 * unreadable.
 */

const INK = '#141B22';
const MUTED = '#4B585C';
const GOLD = '#AE8746';
const TEAL = '#2F7F86';
const LINE = '#E7E1D3';

const PRINT_CSS = `
@media print {
  @page { margin: 14mm; }
  html, body { background: #fff !important; }
  .app-sidebar, .app-topbar, .btn, .rpt-controls { display: none !important; }
  [style*="overflow"] { overflow: visible !important; }
  .rpt { font-size: 10.5px !important; }
  .rpt table { width: 100% !important; table-layout: fixed !important; font-size: 9px !important; }
  .rpt td, .rpt th { padding: 3px 4px !important; overflow-wrap: anywhere !important; }
  /* A comparable must never be split across two sheets. */
  .rpt-card { break-inside: avoid; page-break-inside: avoid; }
  .rpt-pagebreak { break-before: page; page-break-before: always; }
  .rpt h1, .rpt h2, .rpt h3 { break-after: avoid; page-break-after: avoid; }
  /* Colour carries meaning here — a negative adjustment is red. Browsers drop
     backgrounds when printing unless told not to. */
  * { -webkit-print-color-adjust: exact !important; print-color-adjust: exact !important; }
}
`;

const S = {
  section: { marginBottom: 18, breakInside: 'avoid' },
  h2: { margin: '0 0 6px', fontSize: 15, color: INK, borderBottom: `2px solid ${GOLD}`, paddingBottom: 3 },
  p: { margin: '0 0 6px', fontSize: 12.5, color: MUTED, lineHeight: 1.45 },
  card: { border: `1px solid ${LINE}`, borderRadius: 8, padding: 10, marginBottom: 10, background: '#fff' },
  th: { textAlign: 'left', padding: '5px 6px', fontSize: 11, color: MUTED, borderBottom: `1px solid ${LINE}`, fontWeight: 700 },
  td: { padding: '5px 6px', fontSize: 12, color: INK, borderBottom: `1px solid #F2EEE3` },
};

const dash = (v) => (v == null || v === '' ? '—' : v);

/** One fact, labelled. A missing fact says so rather than leaving a gap. */
const Fact = ({ k, v }) => (
  <div style={{ display: 'flex', gap: 6, fontSize: 12, padding: '1px 0' }}>
    <span style={{ color: MUTED, minWidth: 96 }}>{k}</span>
    <span style={{ color: INK, fontWeight: 600 }}>{dash(v)}</span>
  </div>
);

export default function CompReport({ data, layout = 'standard', onLayout = null }) {
  const r = buildReport(data, layout);
  const money = (v) => dash(v);

  return (
    <div className="rpt" style={{ maxWidth: 880, margin: '0 auto', color: INK }}>
      <style>{PRINT_CSS}</style>

      {onLayout && (
        <div className="rpt-controls" style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 14, alignItems: 'center' }}>
          <span style={{ color: MUTED, fontSize: 13 }}>Layout</span>
          {LAYOUT_KEYS.map((k) => (
            <button key={k} type="button" onClick={() => onLayout(k)}
              className={`btn small ${k === r.layout.key ? 'btn-gold' : 'ghost'}`}
              title={LAYOUTS[k].blurb}>{LAYOUTS[k].label}</button>
          ))}
          <button type="button" className="btn ghost small"
            onClick={() => { setTimeout(() => { try { window.print(); } catch (e) { /* */ } }, 40); }}>
            Print / save as PDF
          </button>
          <span style={{ color: MUTED, fontSize: 12 }}>{r.layout.blurb}</span>
        </div>
      )}

      {/* 1 — THE BRANDED HEADER */}
      <header style={{ borderBottom: `3px solid ${GOLD}`, paddingBottom: 8, marginBottom: 14 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end', gap: 12, flexWrap: 'wrap' }}>
          <div>
            <div style={{ font: '700 20px/1.1 Fraunces, Georgia, serif', color: INK, letterSpacing: '.02em' }}>
              PILOT<span style={{ color: MUTED, fontSize: 12, fontWeight: 400 }}> by YS Capital</span>
            </div>
            <h1 style={{ margin: '6px 0 0', fontSize: 19, color: INK }}>{r.reportName}</h1>
          </div>
          <div style={{ textAlign: 'right', fontSize: 12, color: MUTED }}>
            <div style={{ color: INK, fontWeight: 700, fontSize: 14 }}>{dash(r.subjectAddress)}</div>
            <div>as of {dash(r.effectiveDate)}</div>
            {r.preparedBy && <div>prepared by {r.preparedBy}</div>}
            {r.status && <div>{r.status === 'final' ? 'finished' : 'working draft'}</div>}
          </div>
        </div>
      </header>

      {/* 2 — THE VALUE, WITH ITS RANGE. Never the number on its own. */}
      <section style={S.section}>
        <h2 style={S.h2}>What our own files indicate</h2>
        <div style={{ display: 'flex', gap: 18, alignItems: 'baseline', flexWrap: 'wrap' }}>
          <div style={{ font: '700 30px/1 Fraunces, Georgia, serif', color: TEAL }}>{money(r.value.indicated)}</div>
          {r.value.hasRange && (
            <div style={{ fontSize: 14, color: INK }}>
              likely between <b>{money(r.value.low)}</b> and <b>{money(r.value.high)}</b>
            </div>
          )}
        </div>
        <p style={S.p}>
          A range, not a point. A single figure invites a reader to treat it as precise, and nothing
          here supports that{r.value.method ? ` — reconciled by the ${r.value.method} method` : ''}.
        </p>
      </section>

      {/* 3 — HOW MUCH TO TRUST IT */}
      <section style={S.section}>
        <h2 style={S.h2}>How much to trust it</h2>
        <div style={{ fontSize: 14, color: INK, marginBottom: 4 }}>
          Confidence: <b style={{ color: GOLD }}>{dash(r.confidence.label)}</b>
        </div>
        {r.confidence.reasons.length > 0 && (
          <ul style={{ margin: '0 0 6px 18px', padding: 0, color: MUTED, fontSize: 12.5 }}>
            {r.confidence.reasons.map((x, i) => <li key={i}>{x}</li>)}
          </ul>
        )}
        {r.confidence.basis && <p style={S.p}>Worked out by {r.confidence.basis}.</p>}
      </section>

      {/* 4 — WHAT IT RESTS ON, AND WHAT WE HOLD */}
      <section style={S.section}>
        <h2 style={S.h2}>What it rests on</h2>
        <div style={{ fontSize: 13.5, color: INK, marginBottom: 4 }}>{r.coverage.sentence}.</div>
        <p style={S.p}>{r.coverage.note}</p>
      </section>

      {/* 5 — THE SUBJECT'S OWN FACTS */}
      {r.showSubjectDetail ? (
      <section style={S.section}>
        <h2 style={S.h2}>The subject</h2>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(190px,1fr))', gap: '0 18px' }}>
          <Fact k="Address" v={r.subjectAddress} />
          <Fact k="Property type" v={r.subject.property_type} />
          <Fact k="Units" v={r.subject.units} />
          <Fact k="Living area" v={r.subject.gla ? `${Number(r.subject.gla).toLocaleString('en-US')} sqft` : null} />
          <Fact k="Beds / baths" v={[r.subject.beds, r.subject.baths].some((x) => x != null)
            ? `${dash(r.subject.beds)} / ${dash(r.subject.baths)}` : null} />
          <Fact k="Year built" v={r.subject.year_built} />
          <Fact k="Condition" v={r.subject.condition_uad || r.subject.condition_text} />
          <Fact k="Purpose" v={r.purpose === 'arv' ? 'After repair' : r.purpose === 'as_is' ? 'As is' : r.purpose} />
        </div>
      </section>
      ) : (
        <div style={{ ...S.p, marginBottom: 12 }}>
          Subject: <b style={{ color: INK }}>{dash(r.subjectAddress)}</b>
          {r.subject.gla ? ` · ${Number(r.subject.gla).toLocaleString('en-US')} sqft` : ''}
          {r.subject.beds != null ? ` · ${r.subject.beds} bed` : ''}
          {r.purpose ? ` · ${r.purpose === 'arv' ? 'after repair' : 'as is'}` : ''}
        </div>
      )}

      {/* 6 — THE ADJUSTMENT GRID */}
      <section style={S.section}>
        <h2 style={S.h2}>The adjustment grid</h2>
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 520 }}>
            <thead>
              <tr>
                <th style={S.th}>Comparable</th>
                <th style={{ ...S.th, textAlign: 'right' }}>Sold for</th>
                <th style={{ ...S.th, textAlign: 'right' }}>After adjustments</th>
                <th style={{ ...S.th, textAlign: 'right' }}>Distance</th>
                <th style={{ ...S.th, textAlign: 'right' }}>Sold</th>
                <th style={S.th}>Used</th>
              </tr>
            </thead>
            <tbody>
              {r.comps.map((c) => (
                <tr key={c.id}>
                  <td style={S.td}>{c.n}. {c.address}</td>
                  <td style={{ ...S.td, textAlign: 'right' }}>{dash(c.salePrice)}</td>
                  <td style={{ ...S.td, textAlign: 'right', fontWeight: 700 }}>{dash(c.adjustedPrice)}</td>
                  <td style={{ ...S.td, textAlign: 'right' }}>{c.distanceMiles != null ? `${c.distanceMiles.toFixed(2)} mi` : '—'}</td>
                  <td style={{ ...S.td, textAlign: 'right' }}>{dash(c.saleDate)}</td>
                  <td style={{ ...S.td, color: c.included ? TEAL : MUTED }}>{c.included ? 'yes' : 'set aside'}</td>
                </tr>
              ))}
              {r.comps.length === 0 && (
                <tr><td style={{ ...S.td, color: MUTED }} colSpan={6}>
                  No comparables on this report yet — so there is no value to state, and none is stated.
                </td></tr>
              )}
            </tbody>
          </table>
        </div>
      </section>

      {/* 7 — EACH COMPARABLE, at the depth this layout calls for */}
      {r.showComps && r.comps.map((c, i) => (
        <section
          key={c.id}
          className={`rpt-card${r.compPresentation === 'page' && i > 0 ? ' rpt-pagebreak' : ''}`}
          style={{ ...S.card, ...(r.compPresentation === 'row' ? { padding: 8 } : {}) }}
        >
          <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10, flexWrap: 'wrap', alignItems: 'baseline' }}>
            <h3 style={{ margin: 0, fontSize: 14, color: INK }}>
              {c.n}. {c.address}
              {!c.included && <span style={{ color: MUTED, fontWeight: 400 }}> — set aside, not counted</span>}
            </h3>
            <div style={{ fontSize: 13 }}>
              <span style={{ color: MUTED }}>{dash(c.salePrice)} → </span>
              <b style={{ color: TEAL }}>{dash(c.adjustedPrice)}</b>
            </div>
          </div>

          {r.compPresentation !== 'row' && (
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(170px,1fr))', gap: '0 16px', marginTop: 6 }}>
              <Fact k="Property type" v={c.propertyType} />
              <Fact k="Units" v={c.units} />
              <Fact k="Living area" v={c.gla ? `${c.gla.toLocaleString('en-US')} sqft` : null} />
              <Fact k="Beds / baths" v={[c.beds, c.baths].some((x) => x != null) ? `${dash(c.beds)} / ${dash(c.baths)}` : null} />
              <Fact k="Year built" v={c.yearBuilt} />
              <Fact k="Condition" v={c.condition} />
              <Fact k="Quality" v={c.quality} />
              <Fact k="Distance" v={c.distanceMiles != null ? `${c.distanceMiles.toFixed(2)} mi` : null} />
            </div>
          )}

          {c.lines.length > 0 && (
            <div style={{ marginTop: 6, fontSize: 12 }}>
              <span style={{ color: MUTED }}>Adjusted for: </span>
              {c.lines.map((l, j) => (
                <span key={j} style={{ marginRight: 10 }}>
                  {l.label || l.key}{' '}
                  <b style={{ color: Number(l.amount) < 0 ? '#B4483C' : TEAL }}>
                    {Number(l.amount) < 0 ? '−' : '+'}${Math.abs(Math.round(Number(l.amount))).toLocaleString('en-US')}
                  </b>
                </span>
              ))}
            </div>
          )}

          {/* 8 — EVERY BLANK LINE, AND WHY. Never an empty cell. */}
          {r.showBlankDetail && c.blanks.length > 0 && (
            <div style={{ marginTop: 8, background: '#FBF9F4', border: `1px solid ${LINE}`, borderRadius: 6, padding: 8 }}>
              <div style={{ fontSize: 11.5, color: MUTED, fontWeight: 700, marginBottom: 3 }}>
                Lines with no adjustment, and why
              </div>
              <ul style={{ margin: '0 0 0 16px', padding: 0, fontSize: 11.5, color: MUTED }}>
                {c.blanks.map((b) => <li key={b.key}><b style={{ color: INK }}>{b.label}</b> — {b.why}</li>)}
              </ul>
            </div>
          )}

          {r.showWarnings && c.warnings.length > 0 && (
            <ul style={{ margin: '6px 0 0 16px', padding: 0, fontSize: 11.5, color: '#8A5A00' }}>
              {c.warnings.map((w, j) => <li key={j}>{w.message || w.code || String(w)}</li>)}
            </ul>
          )}

          {/* 10 — PHOTOS. An honest placeholder beats a broken box. */}
          {r.showPhotos && (
            <div style={{ marginTop: 8, fontSize: 11.5, color: MUTED }}>
              {c.photoCount > 0
                ? `${c.photoCount} photograph${c.photoCount === 1 ? '' : 's'} on file for this property — open it in Property Research to see them.`
                : 'No photographs on file for this property. Our records hold pictures only where the appraisal we paid for carried them.'}
            </div>
          )}

          {c.note && <div style={{ marginTop: 6, fontSize: 12, color: INK }}><i>{c.note}</i></div>}
        </section>
      ))}

      {/* 8b — THE BLANKS, SUMMARISED, on the layouts that do not show them per comp */}
      {!r.showBlankDetail && r.blanks.total > 0 && (
        <section style={S.section}>
          <h2 style={S.h2}>Lines with no adjustment</h2>
          <p style={S.p}>
            {r.blanks.total} grid line{r.blanks.total === 1 ? '' : 's'} across these comparables carry no
            adjustment. An empty cell can mean the two were the same, that a difference was judged not to
            matter, or that nobody has worked the line yet — the fuller layouts state which, line by line.
          </p>
        </section>
      )}

      {/* 9 — WHAT TO LOOK AT BEFORE USING THIS */}
      {r.showWarnings && r.warnings.length > 0 && (
        <section style={S.section}>
          <h2 style={S.h2}>Worth a look before using this</h2>
          <ul style={{ margin: '0 0 0 18px', padding: 0, fontSize: 12.5, color: '#8A5A00' }}>
            {r.warnings.map((w, i) => <li key={i}>{w.message || w.code || String(w)}</li>)}
          </ul>
        </section>
      )}

      {/* 11 — HOW THIS WAS WORKED OUT. Explanation, so it scales away. */}
      {r.showMethod && (
      <section style={S.section}>
        <h2 style={S.h2}>How this was worked out</h2>
        <p style={S.p}>
          Each comparable&apos;s sale price is adjusted for the ways it differs from the subject, and the
          adjusted prices are reconciled{r.value.method ? ` by the ${r.value.method} method` : ''}. Every
          rate behind an adjustment came from our own reports — what appraisers in this market actually
          wrote — never from a rule of thumb.
        </p>
      </section>
      )}

      {/* 12 — THE LEGAL LINE, EXACTLY. Never dropped, on any layout. */}
      <section style={{ ...S.section, border: `1px solid ${GOLD}`, borderRadius: 8, padding: 10, background: '#FBF8F1' }}>
        <h2 style={{ ...S.h2, borderBottom: 'none', marginBottom: 4 }}>What this is, and what it is not</h2>
        {r.legalDetail === 'full' && <p style={{ ...S.p, color: INK }}>{r.legal.what}</p>}
        <p style={{ ...S.p, color: INK, fontWeight: 700 }}>{r.legal.notAnAppraisal}</p>
        {r.legalDetail === 'full' && <p style={S.p}>{r.legal.whoMayRun}</p>}
        <p style={{ ...S.p, color: '#B4483C', fontWeight: 700 }}>{r.legal.neverSizes}</p>
        <div style={{ marginTop: 8, fontSize: 11, color: MUTED, borderTop: `1px solid ${LINE}`, paddingTop: 6 }}>
          YS Capital Group · NMLS #2609746 · Internal document — business-purpose lending only.
        </div>
      </section>
    </div>
  );
}
