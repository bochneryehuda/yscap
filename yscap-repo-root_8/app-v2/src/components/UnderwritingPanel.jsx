import React, { useEffect, useState, useCallback, useRef } from 'react';
import { api } from '../lib/api.js';
import { AppraisalFinding } from './AppraisalPanel.jsx';

/* The PILOT document-underwriting desk. For each uploaded document PILOT reads it (best-in-class
   OCR), understands it (AI, constrained to the document type's fields), and checks it against the
   loan file — raising per-document findings (ID vs file, contract vs file, bank-account ownership,
   balance math) and cross-document findings (the seller / price / property address must AGREE
   across the contract, title, and appraisal). The underwriter resolves each finding: post a
   condition, request a document, fix the file, clear it, grant an exception, dismiss, or decline.
   Staff-only actions; nothing is ever written onto the loan file from a document read. */

const DOC_LABEL = {
  government_id: 'Government ID', purchase_contract: 'Purchase contract', title: 'Title report',
  bank_statement: 'Bank statement', appraisal: 'Appraisal', operating_agreement: 'Operating agreement',
  assignment: 'Assignment of contract', ein_letter: 'EIN letter', good_standing: 'Good standing',
  llc_formation: 'LLC formation', insurance: 'Insurance', flood: 'Flood cert',
  settlement: 'Settlement statement', credit_report: 'Credit report', background_report: 'Background / OFAC',
  contract_amendment: 'Contract amendment', scope_of_work: 'Scope of work', payoff_statement: 'Payoff statement',
  voided_check: 'Voided check', plans_permits: 'Plans & permits', signed_term_sheet: 'Signed term sheet',
  signed_application: 'Signed application', investor_structure: 'Investor structure',
};
const label = (t) => DOC_LABEL[t] || String(t || '').replace(/_/g, ' ');

const SEV = {
  fatal: { bg: 'var(--crit-bg,#F6E7E4)', fg: 'var(--crit,#B4483C)', label: 'Fatal' },
  warning: { bg: 'var(--amber-bg,#F6EEDD)', fg: 'var(--amber,#B7791F)', label: 'Warning' },
  info: { bg: 'rgba(47,127,134,.14)', fg: 'var(--teal-deep,#256168)', label: 'Info' },
};

function btn(primary, danger) {
  return {
    fontSize: 12.5, fontWeight: 600, borderRadius: 8, padding: '7px 13px', cursor: 'pointer',
    border: '1px solid ' + (primary ? 'var(--teal,#2F7F86)' : danger ? 'color-mix(in srgb,var(--crit,#B4483C) 45%,var(--line,#D9D4C8))' : 'var(--line,#D9D4C8)'),
    // A plain (non-primary, non-danger) action gets a subtle solid fill + dark text so it clearly
    // reads as a clickable button (transparent-on-white read as faint/disabled). Primary stays teal,
    // danger stays an outline in crit red.
    background: primary ? 'var(--teal,#2F7F86)' : danger ? 'transparent' : 'var(--ink-2,#F4F1EA)',
    color: primary ? '#fff' : danger ? 'var(--crit,#B4483C)' : 'var(--ivory,#141B22)',
  };
}

// One finding card — its own action menu comes from the server (availableActions), so the UI
// never hard-codes which actions a finding allows. An action that needs a note or a corrected
// value reveals an inline input before it will submit.
// Clearing a hard, clear-to-close-BLOCKING dealbreaker (grant an exception / clear / fix the
// file / dismiss) needs senior authority (waive_conditions) — mirrors the server gate in
// src/lib/underwriting/exceptions.js. A signer WITHOUT waive (processor / coordinator / closer)
// must not be shown those buttons on a fatal blocking finding: they would 403.
const GATE_CLEARING_ACTIONS = new Set(['grant_exception', 'clear', 'fix_file', 'dismiss']);
function Finding({ appId, f, onChange, resolvable, canWaive = true }) {
  const [busy, setBusy] = useState(false);
  const [pending, setPending] = useState(null); // the action awaiting its note/value
  const [text, setText] = useState('');
  const s = SEV[f.severity] || SEV.info;
  const allActions = Array.isArray(f.availableActions) ? f.availableActions : [];
  const isFatalBlocking = f.severity === 'fatal' && (f.blocks_ctc != null ? f.blocks_ctc : (f.blocksCtc != null ? f.blocksCtc : false));
  const actions = allActions.filter((a) => !(isFatalBlocking && !canWaive && GATE_CLEARING_ACTIONS.has(a.key)));
  const docVal = f.doc_value != null ? f.doc_value : f.docValue;
  const fileVal = f.file_value != null ? f.file_value : f.fileValue;
  const howTo = f.how_to != null ? f.how_to : f.howTo;

  const submit = async (action, extra = {}) => {
    setBusy(true);
    try { await api.underwritingResolveFinding(appId, f.id, { action, ...extra }); onChange && onChange(); }
    catch (e) { alert(e.message || 'Could not resolve the finding'); }
    finally { setBusy(false); }
  };
  const click = (a) => {
    if (a.needs === 'note' || a.needs === 'value') { setPending(a); setText(''); return; }
    if (a.key === 'decline' && !window.confirm('Decline this file on this finding?')) return;
    submit(a.key);
  };
  const confirmPending = () => {
    if (!pending) return;
    const extra = pending.needs === 'value' ? { value: text } : { note: text };
    submit(pending.key, extra); setPending(null);
  };

  return (
    <div style={{ border: '1px solid var(--line,#E7E1D3)', borderLeft: `4px solid ${s.fg}`, borderRadius: 12, background: 'var(--card,#fff)', padding: '14px 16px', marginBottom: 12 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 6, flexWrap: 'wrap' }}>
        <span style={{ fontSize: 11, fontWeight: 800, textTransform: 'uppercase', letterSpacing: '.06em', color: s.fg, background: s.bg, padding: '3px 8px', borderRadius: 6 }}>{s.label}</span>
        <strong style={{ fontSize: 14 }}>{f.title}</strong>
        {(f.source || f.doc_type) && <span style={{ fontSize: 11, color: 'var(--muted,#4B585C)' }}>· {label(f.source || f.doc_type)}</span>}
      </div>
      {(docVal != null || fileVal != null) && (
        <div style={{ display: 'flex', gap: 24, fontSize: 13, margin: '6px 0', flexWrap: 'wrap' }}>
          {docVal != null && <span>Document: <b style={{ color: 'var(--teal-deep,#256168)' }}>{String(docVal)}</b></span>}
          {fileVal != null && <span>Our file: <b>{String(fileVal)}</b></span>}
        </div>
      )}
      {howTo && <div style={{ fontSize: 12.5, color: 'var(--muted,#4B585C)', marginBottom: resolvable ? 10 : 0 }}>{howTo}</div>}
      {resolvable && actions.length > 0 && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
          {actions.map((a) => (
            <button key={a.key} disabled={busy} onClick={() => click(a)} title={a.desc}
              style={btn(a.key === 'post_condition' || a.key === 'request_document', a.key === 'decline')}>{a.label}</button>
          ))}
        </div>
      )}
      {resolvable && actions.length === 0 && allActions.length > 0 && (
        <div style={{ fontSize: 12, color: 'var(--muted,#4B585C)' }}>An underwriter or admin can clear this dealbreaker.</div>
      )}
      {resolvable && pending && (
        <div style={{ display: 'flex', gap: 8, marginTop: 10, flexWrap: 'wrap' }}>
          <input autoFocus value={text} onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') confirmPending(); }}
            placeholder={pending.needs === 'value' ? 'corrected value' : `note — ${pending.label.toLowerCase()}`}
            style={{ flex: 1, minWidth: 180, padding: '7px 10px', border: '1px solid var(--line,#E7E1D3)', borderRadius: 8, fontSize: 14 }} />
          <button disabled={busy || !text.trim()} onClick={confirmPending} style={btn(true)}>{pending.label}</button>
          <button disabled={busy} onClick={() => setPending(null)} style={btn()}>Cancel</button>
        </div>
      )}
    </div>
  );
}

// What PILOT read off one document — the extracted fields, shown compact + collapsible so the
// underwriter can confirm the read. Sensitive identifiers are already masked to last-4 server-side.
function ExtractionCard({ e }) {
  const [open, setOpen] = useState(false);
  const fields = e.fields && typeof e.fields === 'object' ? e.fields : {};
  const keys = Object.keys(fields).filter((k) => fields[k] != null && fields[k] !== '' && k !== 'readable' && k !== 'notes');
  const bad = e.status === 'error' || e.confidence === 'unreadable';
  return (
    <div style={{ border: '1px solid var(--line,#E7E1D3)', borderRadius: 10, background: 'var(--card,#fff)', padding: '10px 14px', marginBottom: 8 }}>
      <button onClick={() => setOpen((v) => !v)} style={{ display: 'flex', alignItems: 'center', gap: 8, width: '100%', background: 'none', border: 'none', cursor: 'pointer', padding: 0, textAlign: 'left' }}>
        <span style={{ fontSize: 13, fontWeight: 700 }}>{label(e.doc_type)}</span>
        <span style={{ fontSize: 11, color: bad ? 'var(--amber,#B7791F)' : 'var(--muted,#4B585C)' }}>
          {bad ? 'could not be read — verify by hand' : `read by ${e.ocr_engine || 'AI'}${e.ai_model ? ' + ' + e.ai_model : ''}`}
        </span>
        <span style={{ marginLeft: 'auto', fontSize: 11, color: 'var(--muted,#4B585C)' }}>{open ? 'hide' : `${keys.length} fields`}</span>
      </button>
      {e.purpose && <div style={{ fontSize: 11.5, color: 'var(--muted,#4B585C)', marginTop: 4 }}>{e.purpose}</div>}
      {e.grounding && e.grounding.checked > 0 && (
        <div style={{ fontSize: 11, marginTop: 4, color: e.grounding.unconfirmed > 0 ? 'var(--amber,#B7791F)' : 'var(--good,#3F7A5B)' }}>
          {e.grounding.confirmed}/{e.grounding.checked} read values confirmed in the document’s text{e.grounding.unconfirmed > 0 ? ` · ${e.grounding.unconfirmed} to double-check` : ''}
        </div>
      )}
      {open && (
        <div style={{ marginTop: 10, display: 'grid', gridTemplateColumns: 'repeat(auto-fill,minmax(160px,1fr))', gap: 10 }}>
          {keys.length === 0 && <span style={{ fontSize: 12, color: 'var(--muted,#4B585C)' }}>No fields were read.</span>}
          {keys.map((k) => (
            <div key={k} style={{ minWidth: 0 }}>
              <div style={{ fontSize: 10, fontWeight: 700, letterSpacing: '.05em', textTransform: 'uppercase', color: 'var(--muted,#4B585C)' }}>{k.replace(/([A-Z])/g, ' $1').replace(/_/g, ' ').trim()}</div>
              <div style={{ fontSize: 13, overflowWrap: 'anywhere' }}>{typeof fields[k] === 'object' ? JSON.stringify(fields[k]) : String(fields[k])}</div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// The DATA-COMPARISON matrix — the "stare and compare". Facts down the side, the loan file +
// every document across the top; each cell shows whether that source agrees, disagrees, is
// missing the fact, or doesn't carry it. This is the heart of the underwriting section.
const CELL = {
  agree: { bg: 'rgba(63,122,91,.12)', fg: 'var(--good,#3F7A5B)', mark: '✓' },
  disagree: { bg: 'var(--crit-bg,#F6E7E4)', fg: 'var(--crit,#B4483C)', mark: '✕' },
  missing: { bg: 'var(--amber-bg,#F6EEDD)', fg: 'var(--amber,#B7791F)', mark: '–' },
  source: { bg: 'var(--paper,#F6F3EC)', fg: 'var(--ivory,#141B22)', mark: '' },
  na: { bg: 'transparent', fg: 'var(--muted,#4B585C)', mark: '·' },
  noref: { bg: 'transparent', fg: 'var(--muted,#4B585C)', mark: '' },
  unknown: { bg: 'transparent', fg: 'var(--muted,#4B585C)', mark: '?' },
};
const ROWCAT = { identity: 'Identity', entity: 'Entity', collateral: 'Property', economics: 'Economics', valuation: 'Value', rehab: 'Rehab' };

function TieOutMatrix({ tieout }) {
  if (!tieout || !tieout.matrix || !tieout.matrix.length) return null;
  const { columns, matrix, summary } = tieout;
  const shown = matrix.filter((r) => r.status !== 'none'); // hide facts nothing in the file speaks to
  if (!shown.length) return null;
  const th = { padding: '7px 10px', fontSize: 10.5, fontWeight: 700, letterSpacing: '.04em', textTransform: 'uppercase', color: 'var(--muted,#4B585C)', textAlign: 'left', whiteSpace: 'nowrap', borderBottom: '1px solid var(--line,#E7E1D3)' };
  const cellStyle = (s) => ({ padding: '7px 10px', fontSize: 12.5, borderBottom: '1px solid var(--line-soft,#EFEADD)', background: (CELL[s] || CELL.noref).bg, color: (CELL[s] || CELL.noref).fg, verticalAlign: 'top' });
  let lastCat = null;
  return (
    <div style={{ marginBottom: 22 }}>
      <h4 style={{ fontFamily: 'var(--serif,Georgia,serif)', margin: '0 0 4px' }}>Data comparison — every fact, every document</h4>
      <div style={{ fontSize: 12, color: 'var(--muted,#4B585C)', marginBottom: 10 }}>
        {summary ? `${summary.matched} of ${summary.facts} facts tie out · ` : ''}
        <span style={{ color: 'var(--good,#3F7A5B)' }}>✓ agrees</span> · <span style={{ color: 'var(--crit,#B4483C)' }}>✕ differs</span> · <span style={{ color: 'var(--amber,#B7791F)' }}>– missing</span> · <span style={{ color: 'var(--muted,#4B585C)' }}>· not on this document</span>
      </div>
      <div style={{ overflowX: 'auto', border: '1px solid var(--line,#E7E1D3)', borderRadius: 12 }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 520 }}>
          <thead>
            <tr>
              <th style={{ ...th, position: 'sticky', left: 0, background: 'var(--card,#fff)' }}>Fact</th>
              {columns.map((c) => <th key={c.id} style={th}>{c.label}</th>)}
            </tr>
          </thead>
          <tbody>
            {shown.map((row) => {
              const catHeader = ROWCAT[row.category] && row.category !== lastCat ? (lastCat = row.category, ROWCAT[row.category]) : null;
              return (
                <React.Fragment key={row.key}>
                  {catHeader && (
                    <tr><td colSpan={columns.length + 1} style={{ padding: '8px 10px 3px', fontSize: 10, fontWeight: 800, letterSpacing: '.08em', textTransform: 'uppercase', color: 'var(--gold,#AE8746)' }}>{catHeader}</td></tr>
                  )}
                  <tr>
                    <td style={{ ...cellStyle('noref'), position: 'sticky', left: 0, background: 'var(--card,#fff)', fontWeight: 600, whiteSpace: 'nowrap' }}>
                      {row.label}{row.status === 'mismatch' && <span style={{ color: 'var(--crit,#B4483C)', marginLeft: 6 }}>●</span>}
                    </td>
                    {row.cells.map((cell, i) => {
                      const cfg = CELL[cell.status] || CELL.noref;
                      return (
                        <td key={i} style={cellStyle(cell.status)} title={cell.status}>
                          {cell.value != null
                            ? <span>{cfg.mark && <b style={{ marginRight: 4 }}>{cfg.mark}</b>}{cell.value}</span>
                            : <span style={{ color: cfg.fg }}>{cfg.mark || ''}</span>}
                        </td>
                      );
                    })}
                  </tr>
                </React.Fragment>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// Condition coverage — every document-backed condition on the file: is a document analyzed for it,
// and is it ready to clear (clean) / has issues / is blocked, or not yet analyzed? Ties the
// underwriting engine to the actual checklist so each condition is "underwritten correctly."
const READY = {
  clean: { fg: 'var(--good,#3F7A5B)', bg: 'rgba(63,122,91,.12)', label: 'Ready to clear' },
  issues: { fg: 'var(--amber,#B7791F)', bg: 'var(--amber-bg,#F6EEDD)', label: 'Review' },
  blocked: { fg: 'var(--crit,#B4483C)', bg: 'var(--crit-bg,#F6E7E4)', label: 'Blocked' },
  not_analyzed: { fg: 'var(--muted,#4B585C)', bg: 'var(--paper,#F6F3EC)', label: 'Not read yet' },
};
function ConditionCoverage({ coverage }) {
  if (!coverage || !coverage.length) return null;
  return (
    <div style={{ marginBottom: 22 }}>
      <h4 style={{ fontFamily: 'var(--serif,Georgia,serif)', margin: '0 0 4px' }}>Conditions — is every document underwritten?</h4>
      <div style={{ fontSize: 12, color: 'var(--muted,#4B585C)', marginBottom: 10 }}>Each condition on this file that PILOT reads a document for, and whether that document is in and ties out.</div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill,minmax(230px,1fr))', gap: 8 }}>
        {coverage.map((c) => {
          const r = READY[c.readiness] || READY.not_analyzed;
          return (
            <div key={c.code} style={{ border: '1px solid var(--line,#E7E1D3)', borderLeft: `4px solid ${r.fg}`, borderRadius: 10, background: 'var(--card,#fff)', padding: '9px 12px' }}>
              <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 4, overflowWrap: 'anywhere' }}>{c.label}</div>
              <span style={{ fontSize: 10.5, fontWeight: 800, letterSpacing: '.04em', textTransform: 'uppercase', color: r.fg, background: r.bg, padding: '2px 7px', borderRadius: 6 }}>{r.label}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// Fraud / red-flag risk — one explainable 0-100 score with its ranked reasons.
const RISK_BAND = {
  low: { fg: 'var(--good,#3F7A5B)', bg: 'rgba(63,122,91,.12)', label: 'Low risk' },
  elevated: { fg: 'var(--amber,#B7791F)', bg: 'var(--amber-bg,#F6EEDD)', label: 'Elevated risk' },
  high: { fg: 'var(--crit,#B4483C)', bg: 'var(--crit-bg,#F6E7E4)', label: 'High risk' },
};
function RiskScore({ risk }) {
  if (!risk || !risk.reasons || (!risk.reasons.length && risk.score === 0)) return null;
  const b = RISK_BAND[risk.band] || RISK_BAND.low;
  return (
    <div style={{ marginBottom: 22 }}>
      <h4 style={{ fontFamily: 'var(--serif,Georgia,serif)', margin: '0 0 4px' }}>Fraud / red-flag score</h4>
      <div style={{ fontSize: 12, color: 'var(--muted,#4B585C)', marginBottom: 10 }}>Every open signal, weighted into one score. Higher means more to check before proceeding.</div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 14, marginBottom: risk.reasons.length ? 10 : 0, flexWrap: 'wrap' }}>
        <span style={{ fontSize: 26, fontWeight: 800, color: b.fg }}>{risk.score}<span style={{ fontSize: 13, color: 'var(--muted,#4B585C)' }}>/100</span></span>
        <span style={{ fontSize: 11, fontWeight: 800, letterSpacing: '.05em', textTransform: 'uppercase', color: b.fg, background: b.bg, padding: '3px 9px', borderRadius: 6 }}>{b.label}</span>
        {risk.sarRecommended && <span style={{ fontSize: 12, color: 'var(--crit,#B4483C)' }}>Enhanced review / SAR consideration recommended.</span>}
      </div>
      {risk.reasons.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
          {risk.reasons.map((r) => (
            <div key={r.code} style={{ display: 'flex', gap: 10, alignItems: 'baseline', fontSize: 12.5 }}>
              <span style={{ fontWeight: 700, color: b.fg, minWidth: 34 }}>+{r.weight}</span>
              <span style={{ overflowWrap: 'anywhere' }}><b>{r.label}</b>{r.evidence && r.evidence !== r.label ? <span style={{ color: 'var(--muted,#4B585C)' }}> — {r.evidence}</span> : null}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// File completeness — the required-document matrix vs what's on file: what's still outstanding.
const STIP = {
  cleared: { fg: 'var(--good,#3F7A5B)', bg: 'rgba(63,122,91,.12)', label: 'In & clear' },
  received: { fg: 'var(--amber,#B7791F)', bg: 'var(--amber-bg,#F6EEDD)', label: 'In — review' },
  insufficient: { fg: 'var(--crit,#B4483C)', bg: 'var(--crit-bg,#F6E7E4)', label: 'Not usable' },
  // On file but not yet read — a real document IS uploaded to this condition; the reader picks it
  // up automatically. Distinct (teal, "On file") from the muted, true "Missing — not uploaded".
  on_file: { fg: 'var(--teal-deep,#256168)', bg: 'rgba(47,127,134,.12)', label: 'On file — reading' },
  missing: { fg: 'var(--muted,#4B585C)', bg: 'var(--paper,#F6F3EC)', label: 'Not uploaded' },
};
const OWNER_LABEL = { borrower: 'Borrower', title: 'Title co.', appraiser: 'Appraiser', internal: 'Internal' };
function Completeness({ completeness, documentsOnFile = [] }) {
  if (!completeness || !completeness.stipulations || !completeness.stipulations.length) return null;
  const c = completeness;
  // docType -> the on-file document filename(s), so a stipulation that's "on file" names the actual
  // document linked to its condition (proof the desk found it), not just a status chip.
  const filesByType = {};
  for (const d of documentsOnFile) {
    if (!d || !d.expectedType) continue;
    (filesByType[d.expectedType] = filesByType[d.expectedType] || []).push(d.filename);
  }
  return (
    <div style={{ marginBottom: 22 }}>
      <h4 style={{ fontFamily: 'var(--serif,Georgia,serif)', margin: '0 0 4px' }}>File completeness — what’s still needed</h4>
      <div style={{ fontSize: 12, color: 'var(--muted,#4B585C)', marginBottom: 10 }}>
        {c.completenessPct}% of the required documents are in and clear
        {c.counts.on_file ? <span style={{ color: 'var(--teal-deep,#256168)' }}> · {c.counts.on_file} on file, being read</span> : null}
        {c.counts.received ? <span> · {c.counts.received} in review</span> : null}
        {c.counts.insufficient ? <span> · {c.counts.insufficient} not usable</span> : null}
        {c.counts.missing ? <span> · {c.counts.missing} not uploaded</span> : null}
        {c.ctcBlockers && c.ctcBlockers.length ? <span style={{ color: 'var(--crit,#B4483C)' }}> · {c.ctcBlockers.length} block clear-to-close</span> : null}
      </div>
      <div style={{ height: 7, borderRadius: 999, background: 'var(--paper,#F6F3EC)', overflow: 'hidden', marginBottom: 12 }}>
        <div style={{ width: `${c.completenessPct}%`, height: '100%', background: 'var(--good,#3F7A5B)' }} />
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill,minmax(210px,1fr))', gap: 8 }}>
        {c.stipulations.map((s) => {
          const st = STIP[s.status] || STIP.missing;
          return (
            <div key={s.docType} style={{ border: '1px solid var(--line,#E7E1D3)', borderLeft: `4px solid ${st.fg}`, borderRadius: 10, background: 'var(--card,#fff)', padding: '8px 12px' }}>
              <div style={{ fontSize: 13, fontWeight: 600, overflowWrap: 'anywhere' }}>{s.label}</div>
              <div style={{ display: 'flex', gap: 6, alignItems: 'center', marginTop: 4, flexWrap: 'wrap' }}>
                <span style={{ fontSize: 10, fontWeight: 800, letterSpacing: '.04em', textTransform: 'uppercase', color: st.fg, background: st.bg, padding: '2px 7px', borderRadius: 6 }}>{st.label}</span>
                <span style={{ fontSize: 10.5, color: 'var(--muted,#4B585C)' }}>{OWNER_LABEL[s.owner] || s.owner} · {s.gating}</span>
              </div>
              {(filesByType[s.docType] || []).length > 0 && s.status !== 'missing' && (
                <div style={{ fontSize: 10.5, color: 'var(--muted,#4B585C)', marginTop: 4, overflowWrap: 'anywhere' }} title={filesByType[s.docType].join(', ')}>
                  📎 {filesByType[s.docType][0]}{filesByType[s.docType].length > 1 ? ` +${filesByType[s.docType].length - 1}` : ''}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

// Derived metrics — LTP / LTV / LTC / ARV-LTV vs their caps, with the binding constraint.
function Metrics({ metrics }) {
  if (!metrics || !metrics.rows || !metrics.rows.length) return null;
  const money = (n) => n == null ? '—' : `$${Math.round(n).toLocaleString('en-US')}`;
  const pctOf = (v) => v == null ? '—' : `${Math.round(v * 1000) / 10}%`;
  return (
    <div style={{ marginBottom: 22 }}>
      <h4 style={{ fontFamily: 'var(--serif,Georgia,serif)', margin: '0 0 4px' }}>Loan metrics</h4>
      <div style={{ fontSize: 12, color: 'var(--muted,#4B585C)', marginBottom: 10 }}>
        Recomputed from the file. Max supportable loan {money(metrics.maxLoan)}{metrics.binding ? ` (bound by ${metrics.rows.find((r) => r.key === metrics.binding)?.label || metrics.binding})` : ''}.
      </div>
      <div style={{ overflowX: 'auto', border: '1px solid var(--line,#E7E1D3)', borderRadius: 12 }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 420, fontSize: 12.5 }}>
          <thead><tr>{['Metric', 'Value', 'Cap', 'Cap amount', ''].map((h, i) => <th key={i} style={{ padding: '7px 10px', textAlign: i > 0 && i < 4 ? 'right' : 'left', fontSize: 10.5, fontWeight: 700, letterSpacing: '.04em', textTransform: 'uppercase', color: 'var(--muted,#4B585C)', borderBottom: '1px solid var(--line,#E7E1D3)' }}>{h}</th>)}</tr></thead>
          <tbody>
            {metrics.rows.map((r) => (
              <tr key={r.key} style={{ background: r.pass ? 'transparent' : 'var(--crit-bg,#F6E7E4)' }}>
                <td style={{ padding: '7px 10px', fontWeight: 600 }}>{r.label}{metrics.binding === r.key && <span style={{ fontSize: 10, color: 'var(--gold,#AE8746)', marginLeft: 6 }}>binds</span>}</td>
                <td style={{ padding: '7px 10px', textAlign: 'right', color: r.pass ? 'var(--ivory,#141B22)' : 'var(--crit,#B4483C)', fontWeight: r.pass ? 400 : 700 }}>{pctOf(r.value)}</td>
                <td style={{ padding: '7px 10px', textAlign: 'right', color: 'var(--muted,#4B585C)' }}>{pctOf(r.cap)}</td>
                <td style={{ padding: '7px 10px', textAlign: 'right' }}>{money(r.capAmount)}</td>
                <td style={{ padding: '7px 10px', color: 'var(--crit,#B4483C)', fontSize: 11 }}>{r.over > 0 ? `${money(r.over)} over` : ''}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// Staleness — every dated document's freshness against the projected closing date.
const FRESH = {
  fresh: { fg: 'var(--good,#3F7A5B)', label: 'Fresh' },
  refresh_before_close: { fg: 'var(--amber,#B7791F)', label: 'Refresh before close' },
  stale: { fg: 'var(--crit,#B4483C)', label: 'Stale' },
  expired: { fg: 'var(--crit,#B4483C)', label: 'Expired' },
  unknown: { fg: 'var(--muted,#4B585C)', label: 'Unknown' },
};
function StalenessBoard({ staleness }) {
  if (!staleness || !staleness.board || !staleness.board.length) return null;
  return (
    <div style={{ marginBottom: 22 }}>
      <h4 style={{ fontFamily: 'var(--serif,Georgia,serif)', margin: '0 0 4px' }}>Document freshness</h4>
      <div style={{ fontSize: 12, color: 'var(--muted,#4B585C)', marginBottom: 10 }}>
        Each dated document’s validity{staleness.closingDate ? ` at the projected close (${staleness.closingDate})` : ' as of today'}.
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill,minmax(220px,1fr))', gap: 8 }}>
        {staleness.board.map((d, i) => {
          const f = FRESH[d.status] || FRESH.unknown;
          return (
            <div key={i} style={{ border: '1px solid var(--line,#E7E1D3)', borderLeft: `4px solid ${f.fg}`, borderRadius: 10, background: 'var(--card,#fff)', padding: '8px 12px' }}>
              <div style={{ fontSize: 13, fontWeight: 600 }}>{d.label}</div>
              <div style={{ fontSize: 11, color: 'var(--muted,#4B585C)', marginTop: 2 }}>as of {d.asOf}{d.refreshBy && d.kind === 'freshness' ? ` · good until ${d.refreshBy}` : ''}</div>
              <span style={{ fontSize: 10.5, fontWeight: 800, letterSpacing: '.04em', textTransform: 'uppercase', color: f.fg, marginTop: 4, display: 'inline-block' }}>{f.label}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// Entity-resolution chain — the signing-authority / ownership chain as one status.
const EDGE = { ok: { fg: 'var(--good,#3F7A5B)', mark: '✓' }, broken: { fg: 'var(--crit,#B4483C)', mark: '✕' }, missing: { fg: 'var(--muted,#4B585C)', mark: '–' } };
const CHAIN = { intact: { fg: 'var(--good,#3F7A5B)', label: 'Chain intact' }, broken: { fg: 'var(--crit,#B4483C)', label: 'Chain broken' }, incomplete: { fg: 'var(--amber,#B7791F)', label: 'Chain incomplete' } };
function EntityChain({ entityChain }) {
  if (!entityChain || !entityChain.edges || !entityChain.edges.length) return null;
  const st = CHAIN[entityChain.status] || CHAIN.incomplete;
  return (
    <div style={{ marginBottom: 22 }}>
      <h4 style={{ fontFamily: 'var(--serif,Georgia,serif)', margin: '0 0 4px' }}>Entity chain{entityChain.vestingName ? ` — ${entityChain.vestingName}` : ''}</h4>
      <div style={{ marginBottom: 10 }}>
        <span style={{ fontSize: 11, fontWeight: 800, letterSpacing: '.05em', textTransform: 'uppercase', color: st.fg }}>{st.label}</span>
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
        {entityChain.edges.map((e) => {
          const g = EDGE[e.status] || EDGE.missing;
          return (
            <div key={e.id} style={{ display: 'flex', gap: 10, alignItems: 'baseline', fontSize: 12.5 }}>
              <span style={{ color: g.fg, fontWeight: 800, minWidth: 14 }}>{g.mark}</span>
              <span><b>{e.label}</b>{e.detail ? <span style={{ color: 'var(--muted,#4B585C)' }}> — {e.detail}</span> : null}</span>
            </div>
          );
        })}
      </div>
      {entityChain.owners && entityChain.owners.length > 0 && (
        <div style={{ marginTop: 8, fontSize: 11.5, color: 'var(--muted,#4B585C)' }}>
          Owners: {entityChain.owners.map((o) => `${o.name}${o.ownershipPct != null ? ` ${o.ownershipPct}%` : ''}${o.beneficialOwner && !o.identified ? ' (no ID)' : ''}`).join(' · ')}
        </div>
      )}
    </div>
  );
}

// The seller → buyer OWNERSHIP CHAIN: how the property gets from its owner of record into our
// vesting entity. Each node is a party; the connector between two nodes is colored by whether that
// link is confirmed (match / a legitimate transfer / a broken mismatch / a gap).
const CHAIN_EDGE = {
  match: { fg: 'var(--good,#3F7A5B)', arrow: '→' },
  transfer: { fg: 'var(--muted,#4B585C)', arrow: '⇒' },
  mismatch: { fg: 'var(--crit,#B4483C)', arrow: '⤫' },
  gap: { fg: 'var(--amber,#B7791F)', arrow: '⋯' },
  unknown: { fg: 'var(--muted,#4B585C)', arrow: '→' },
};
function SellerChain({ sellerChain }) {
  if (!sellerChain || !sellerChain.nodes || !sellerChain.nodes.length) return null;
  const st = CHAIN[sellerChain.status] || CHAIN.incomplete;
  const nodes = sellerChain.nodes;
  const edges = sellerChain.edges || [];
  return (
    <div style={{ marginBottom: 22 }}>
      <h4 style={{ fontFamily: 'var(--serif,Georgia,serif)', margin: '0 0 4px' }}>Purchase chain — how the property reaches the borrower</h4>
      <div style={{ marginBottom: 10 }}>
        <span style={{ fontSize: 11, fontWeight: 800, letterSpacing: '.05em', textTransform: 'uppercase', color: st.fg }}>{st.label}</span>
        {sellerChain.reachesVesting === true ? <span style={{ marginLeft: 10, fontSize: 11.5, color: 'var(--good,#3F7A5B)' }}>reaches the vesting entity</span> : null}
      </div>
      <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 4, overflowX: 'auto' }}>
        {nodes.map((n, i) => {
          const edge = i > 0 ? (edges[i - 1] || {}) : null;
          const g = edge ? (CHAIN_EDGE[edge.status] || CHAIN_EDGE.unknown) : null;
          return (
            <div key={n.role} style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
              {i > 0 ? <span title={edge.status} style={{ color: g.fg, fontWeight: 800, fontSize: 17, minWidth: 18, textAlign: 'center' }}>{g.arrow}</span> : null}
              <div style={{ border: '1px solid var(--line,#E4DECF)', borderRadius: 8, padding: '7px 10px', minWidth: 118, background: n.present ? 'var(--card,#fff)' : 'transparent', opacity: n.present ? 1 : 0.5 }}>
                <div style={{ fontSize: 10, fontWeight: 800, letterSpacing: '.04em', textTransform: 'uppercase', color: 'var(--muted,#4B585C)' }}>{n.role}</div>
                <div style={{ fontSize: 13, fontWeight: 700 }}>{n.name || '—'}</div>
                {n.source ? <div style={{ fontSize: 10.5, color: 'var(--muted,#4B585C)' }}>{n.source}</div> : null}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// Bank liquidity — sum every account's ending balance and show it against the cash this deal needs.
// The per-account table makes clear WHAT was counted (and what was excluded because it sits in an
// account that isn't the borrower's / a verified entity's).
function BankLiquidity({ bankLiquidity }) {
  if (!bankLiquidity || !(bankLiquidity.accounts || []).length) return null;
  const money = (n) => n == null ? '—' : `$${Math.round(n).toLocaleString('en-US')}`;
  const req = bankLiquidity.requiredLiquidity;
  const total = bankLiquidity.qualifyingTotal || 0;
  const covered = req != null ? total >= req - 1 : null;
  const accounts = bankLiquidity.accounts || [];
  return (
    <div style={{ marginBottom: 22 }}>
      <h4 style={{ fontFamily: 'var(--serif,Georgia,serif)', margin: '0 0 4px' }}>Bank liquidity — do the accounts cover the cash needed?</h4>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginBottom: 10 }}>
        <div style={{ border: '1px solid var(--line,#E7E1D3)', borderRadius: 10, background: 'var(--card,#fff)', padding: '8px 12px', minWidth: 150 }}>
          <div style={{ fontSize: 10, fontWeight: 700, letterSpacing: '.05em', textTransform: 'uppercase', color: 'var(--muted,#4B585C)' }}>Liquid assets on file</div>
          <div style={{ fontSize: 16, fontWeight: 700 }}>{money(total)}</div>
        </div>
        <div style={{ border: '1px solid var(--line,#E7E1D3)', borderRadius: 10, background: 'var(--card,#fff)', padding: '8px 12px', minWidth: 150 }}>
          <div style={{ fontSize: 10, fontWeight: 700, letterSpacing: '.05em', textTransform: 'uppercase', color: 'var(--muted,#4B585C)' }}>Required liquidity</div>
          <div style={{ fontSize: 16, fontWeight: 700 }}>{req != null ? money(req) : <span style={{ fontSize: 12, fontWeight: 500, color: 'var(--muted,#4B585C)' }}>set once a product is registered</span>}</div>
        </div>
        {covered != null && (
          <div style={{ border: '1px solid var(--line,#E7E1D3)', borderRadius: 10, background: 'var(--card,#fff)', padding: '8px 12px', minWidth: 150 }}>
            <div style={{ fontSize: 10, fontWeight: 700, letterSpacing: '.05em', textTransform: 'uppercase', color: 'var(--muted,#4B585C)' }}>{covered ? 'Covered' : 'Short by'}</div>
            <div style={{ fontSize: 16, fontWeight: 700, color: covered ? 'var(--good,#3F7A5B)' : 'var(--bad,#B4453B)' }}>{covered ? '✓' : money(bankLiquidity.shortfall)}</div>
          </div>
        )}
      </div>
      <div style={{ overflowX: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12.5 }}>
          <thead>
            <tr style={{ textAlign: 'left', color: 'var(--muted,#4B585C)' }}>
              <th style={{ padding: '4px 8px', fontWeight: 700 }}>Account holder</th>
              <th style={{ padding: '4px 8px', fontWeight: 700 }}>Bank</th>
              <th style={{ padding: '4px 8px', fontWeight: 700, textAlign: 'right' }}>Ending balance</th>
              <th style={{ padding: '4px 8px', fontWeight: 700 }}>Counts?</th>
            </tr>
          </thead>
          <tbody>
            {accounts.map((a, i) => (
              <tr key={i} style={{ borderTop: '1px solid var(--line,#EEE8DA)' }}>
                <td style={{ padding: '4px 8px' }}>{a.holder || '—'}{a.statementCount > 1 ? <span style={{ color: 'var(--muted,#4B585C)' }}> · {a.statementCount} statements</span> : null}</td>
                <td style={{ padding: '4px 8px' }}>{a.bankName || '—'}</td>
                <td style={{ padding: '4px 8px', textAlign: 'right' }}>{money(a.ending)}</td>
                <td style={{ padding: '4px 8px', color: a.tied ? 'var(--good,#3F7A5B)' : 'var(--muted,#4B585C)' }}>{a.tied ? 'yes' : 'not counted — needs entity docs'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// Experience — is the borrower's verified track record enough for THIS deal's rehab intensity?
// A heavy-rehab or ground-up deal needs a verified comparable anchor; a light/moderate deal doesn't.
function Experience({ experience, appId, onChange, readOnly }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  if (!experience) return null;
  const findings = experience.findings || [];
  // Nothing to show for an un-gated (light/moderate) deal with no findings — keep the desk quiet.
  if (!experience.gated && !findings.length) return null;
  const ok = experience.hasVerifiedAnchor || !experience.gated;
  const blocking = findings.some((f) => f.severity === 'fatal');

  async function grantException() {
    const note = window.prompt('Reason for the experience exception (recorded on the file):');
    if (!note || !note.trim()) return;
    setBusy(true); setErr('');
    try { await api.underwritingExperienceException(appId, { grant: true, note }); await onChange(); }
    catch (e) { setErr(e && e.message ? e.message : 'Could not grant the exception (senior authority required).'); }
    finally { setBusy(false); }
  }
  async function revokeException() {
    setBusy(true); setErr('');
    try { await api.underwritingExperienceException(appId, { grant: false }); await onChange(); }
    catch (e) { setErr(e && e.message ? e.message : 'Could not revoke the exception.'); }
    finally { setBusy(false); }
  }
  return (
    <div style={{ marginBottom: 22 }}>
      <h4 style={{ fontFamily: 'var(--serif,Georgia,serif)', margin: '0 0 4px' }}>Experience — is the track record enough for this deal?</h4>
      <div style={{ fontSize: 12, color: 'var(--muted,#4B585C)', marginBottom: 10 }}>
        This is a <b>{experience.demandLabel}</b> deal.{experience.gated ? ` It needs at least one verified, comparable project (${experience.requiredLabel} or heavier, about half this deal's size or bigger, completed within the last 3 years).` : ' Prior comparable experience is not required at this rehab level.'}
        {' '}
        <span style={{ fontWeight: 700, color: ok ? 'var(--good,#3F7A5B)' : 'var(--bad,#B4453B)' }}>
          {ok ? (experience.gated ? 'Verified anchor on file ✓' : 'Not gated') : (experience.hasVerifiedAnchor ? '' : 'No verified anchor')}
        </span>
      </div>
      {(experience.anchors || []).length > 0 && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: findings.length ? 12 : 0 }}>
          {experience.anchors.map((a, i) => (
            <span key={i} style={{ fontSize: 11.5, border: '1px solid var(--line,#E7E1D3)', borderRadius: 999, padding: '3px 10px',
              background: a.verified ? 'var(--good-bg,#E8F1EC)' : 'var(--card,#fff)', color: 'var(--ivory,#141B22)' }}>
              {a.label}{a.verified ? ' · verified' : ' · unverified'}
            </span>
          ))}
        </div>
      )}
      {!readOnly && blocking && (
        <div style={{ marginTop: 4 }}>
          <button disabled={busy} onClick={grantException} style={btn(false)}>{busy ? 'Working…' : 'Grant experience exception'}</button>
          <span style={{ fontSize: 11.5, color: 'var(--muted,#4B585C)', marginLeft: 8 }}>Senior underwriter / admin only.</span>
        </div>
      )}
      {!readOnly && experience.exceptionGranted && (
        <div style={{ marginTop: 4 }}>
          <button disabled={busy} onClick={revokeException} style={btn(false)}>{busy ? 'Working…' : 'Revoke experience exception'}</button>
        </div>
      )}
      {err && <p style={{ color: 'var(--crit,#B4483C)', fontSize: 12, marginTop: 6 }}>{err}</p>}
    </div>
  );
}

// Amendments — the GOVERNING contract terms (base overlaid by executed amendments) + their source.
function Amendments({ amendments }) {
  if (!amendments || !amendments.hasAmendments) return null;
  const eff = amendments.effective || {};
  const prov = amendments.provenance || {};
  const rows = [
    ['Purchase price', eff.purchasePrice != null ? `$${Math.round(eff.purchasePrice).toLocaleString('en-US')}` : null, prov.purchasePrice],
    ['Closing date', eff.closingDate || null, prov.closingDate],
    ['Buyer', eff.buyerName || null, prov.buyerName],
    ['Seller', eff.sellerName || null, prov.sellerName],
  ].filter((r) => r[1] != null);
  return (
    <div style={{ marginBottom: 22 }}>
      <h4 style={{ fontFamily: 'var(--serif,Georgia,serif)', margin: '0 0 4px' }}>Governing contract terms</h4>
      <div style={{ fontSize: 12, color: 'var(--muted,#4B585C)', marginBottom: 10 }}>
        The terms that actually govern after amendments{amendments.unexecuted > 0 ? ` · ${amendments.unexecuted} unexecuted amendment(s) do not yet govern` : ''}.
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill,minmax(200px,1fr))', gap: 8 }}>
        {rows.map((r, i) => (
          <div key={i} style={{ border: '1px solid var(--line,#E7E1D3)', borderRadius: 10, background: 'var(--card,#fff)', padding: '8px 12px' }}>
            <div style={{ fontSize: 10, fontWeight: 700, letterSpacing: '.05em', textTransform: 'uppercase', color: 'var(--muted,#4B585C)' }}>{r[0]}</div>
            <div style={{ fontSize: 14, fontWeight: 600 }}>{String(r[1])}</div>
            {r[2] && <div style={{ fontSize: 10.5, color: r[2].source === 'amendment' ? 'var(--gold,#AE8746)' : 'var(--muted,#4B585C)' }}>{r[2].source === 'amendment' ? `by amendment${r[2].date ? ` ${r[2].date}` : ''}` : 'base contract'}</div>}
          </div>
        ))}
      </div>
    </div>
  );
}

// Value-level data-integrity flags (a negative price, a loan bigger than the purchase, an ID that
// expired before it was issued, a credit report dated in the future, a settlement that doesn't
// balance) are advisory findings — they now surface in the single "Open findings" list at the top
// of the panel rather than in their own section, so nothing is listed twice.

// canResolve: whether THIS user may resolve a finding (clear it / request a doc / grant an
// exception). Those actions require sign_off_conditions on the server, so a loan officer —
// who can SEE every finding but not act on it — must not be shown dead resolve buttons that
// 403 with a cryptic alert. Defaults true for back-compat (read-only callers already hide it).
// canWaive: whether this user may CLEAR a clear-to-close-blocking dealbreaker (grant an
// exception / clear / fix the file / dismiss on a fatal finding, or grant an experience
// exception) — those need waive_conditions (underwriter/admin). A signer without it
// (processor / coordinator / closer) sees the non-senior actions but not the gate-clearing
// ones, so no button 403s. Defaults true for back-compat.
export default function UnderwritingPanel({ appId, docs = [], readOnly = false, canResolve = true, canWaive = true, onSummary }) {
  const [data, setData] = useState(null);
  const [appr, setAppr] = useState(null); // appraisal findings folded into this ONE findings section
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState('');
  const [pick, setPick] = useState('');       // documentId to analyze
  const [pickType, setPickType] = useState(''); // docType to analyze it as
  const [analyzing, setAnalyzing] = useState(false);
  const [detecting, setDetecting] = useState(false);
  const [detected, setDetected] = useState(''); // confidence note for the suggested type
  const [autoReading, setAutoReading] = useState(false);
  const [autoReadMsg, setAutoReadMsg] = useState('');
  const [autoReadUnreadable, setAutoReadUnreadable] = useState([]); // filenames the reader couldn't read as expected
  const didAutoRead = useRef(false); // auto-run the reader at most once per mount (idempotent server-side anyway)

  // Auto-detect the document type when a document is chosen (the underwriter confirms it).
  const onPickDoc = useCallback(async (id) => {
    setPick(id); setPickType(''); setDetected('');
    if (!id) return;
    setDetecting(true);
    try {
      const g = await api.underwritingClassify(appId, id);
      if (g && g.suggestedType) { setPickType(g.suggestedType); setDetected(g.confidence); }
    } catch (_) { /* detection is best-effort; the underwriter can still pick */ }
    finally { setDetecting(false); }
  }, [appId]);

  const load = useCallback(async () => {
    setLoading(true); setErr('');
    try {
      const d = await api.underwritingGet(appId);
      setData(d);
      if (onSummary) onSummary(d && d.summary ? d.summary : null);
      // Fold the appraisal's findings (only the findings, not the property-profile report) into
      // this ONE findings section. Best-effort + additive: a file with no appraisal returns an
      // empty list, and a fetch error never blocks the underwriting desk. Staff-only endpoint.
      if (!readOnly) {
        try { const ap = await api.appraisalGet(appId); setAppr(ap || null); }
        catch (_) { setAppr(null); }
      }
    } catch (e) { setErr(e.message || 'Could not load the underwriting review'); }
    finally { setLoading(false); }
  }, [appId, onSummary, readOnly]);

  useEffect(() => { load(); }, [load]);

  // Read + check every on-file-but-unread document automatically, then refresh. Server-side it's
  // idempotent (an unchanged document is never re-read) and dormant-safe (does nothing but count
  // when the reader is off), so this is safe to call on open and to re-run.
  const runAutoRead = useCallback(async () => {
    setAutoReading(true); setAutoReadMsg(''); setAutoReadUnreadable([]);
    try {
      const r = await api.underwritingAutoRead(appId);
      if (r && r.readerOn !== false) {
        const parts = [];
        if (r.read) parts.push(`Read ${r.read} document${r.read === 1 ? '' : 's'}`);
        if (r.pending) parts.push(`${r.pending} more to go`);
        setAutoReadMsg(parts.join(' · '));
        // Documents the reader READ but couldn't read AS the type their condition expects — they may
        // be the wrong document filed there (e.g. not actually a title commitment) or a poor scan.
        // Only `unreadable` (a successful read whose content isn't this type), NOT a transient
        // technical error (those aren't a wrong-document signal and self-retry on the next read).
        setAutoReadUnreadable((r.results || [])
          .filter((x) => x.unreadable)
          .map((x) => x.filename).filter(Boolean));
      }
      await load();
    } catch (_) { /* best-effort; the desk still works and the manual read stays available */ }
    finally { setAutoReading(false); }
  }, [appId, load]);

  // Auto-run the reader ONCE per mount when documents are on file, unread, and the Azure reader is on.
  useEffect(() => {
    if (readOnly || didAutoRead.current || !data) return;
    const on = data.analyzers && data.analyzers.reader && data.analyzers.ai;
    if (on && (data.autoReadPending || 0) > 0) { didAutoRead.current = true; runAutoRead(); }
  }, [data, readOnly, runAutoRead]);

  const analyze = async () => {
    if (!pick || !pickType) return;
    setAnalyzing(true); setErr('');
    try { await api.underwritingAnalyze(appId, pick, { docType: pickType }); setPick(''); setPickType(''); await load(); }
    catch (e) { setErr(e.message || 'Could not analyze the document'); }
    finally { setAnalyzing(false); }
  };

  if (loading) return <p style={{ color: 'var(--muted,#4B585C)' }}>Loading the underwriting review…</p>;

  const sum = (data && data.summary) || { fatal: 0, warning: 0, info: 0, blocksCtc: false };
  const tieout = data && data.tieout;
  const coverage = (data && data.conditionCoverage) || [];
  const staleness = data && data.staleness;
  const metrics = data && data.metrics;
  const entityChain = data && data.entityChain;
  const sellerChain = data && data.sellerChain;
  const bankLiquidity = data && data.bankLiquidity;
  const experience = data && data.experience;
  const completeness = data && data.completeness;
  const risk = data && data.risk;
  const amendments = data && data.amendments;
  const verdict = data && data.verdict;
  const documentsOnFile = (data && data.documentsOnFile) || [];
  // Every open finding across the WHOLE file in one list — the exact set the summary counts, so the
  // "2 warnings" chip maps to two visible items (owner-reported: "it says 2 warnings and I can't see
  // them"). Shown once, at the top; the per-section finding lists below were removed so nothing repeats.
  const allFindings = (data && data.allFindings) || [];
  const apprFindings = (appr && appr.findings) || [];
  const apprSum = (appr && appr.summary) || { fatal: 0, warning: 0, info: 0 };
  const exts = (data && data.extractions) || [];
  const docTypes = (data && data.docTypes) || [];
  const analyzers = (data && data.analyzers) || {};
  const autoReadPending = (data && data.autoReadPending) || 0;
  const readerOn = !!(analyzers.reader && analyzers.ai);
  const currentDocs = (docs || []).filter((d) => d.is_current && d.id && d.source_type !== 'chat_attachment');

  return (
    <div>
      {err && <p style={{ color: 'var(--crit,#B4483C)', fontSize: 13 }}>{err}</p>}

      {/* analyzer availability — plain language if a key is missing */}
      {!readOnly && (!analyzers.reader || !analyzers.ai) && (
        <div style={{ background: 'var(--amber-bg,#F6EEDD)', color: 'var(--amber,#B7791F)', border: '1px solid var(--line,#E7E1D3)', borderRadius: 10, padding: '9px 14px', marginBottom: 14, fontSize: 12.5 }}>
          The automatic document reader is not fully switched on yet{analyzers.reader ? '' : ' (OCR reader)'}{analyzers.ai ? '' : ' (AI analyzer)'}.
          Add the Azure keys in the site settings to turn it on. Until then, documents can be reviewed by hand and findings still recorded.
        </div>
      )}

      {/* Auto-reader — the desk reads the on-file documents itself (no per-document click). */}
      {!readOnly && (autoReading || autoReadPending > 0 || autoReadMsg) && (
        <div style={{ background: 'var(--paper,#F6F3EC)', border: '1px solid var(--line,#E7E1D3)', borderRadius: 10, padding: '9px 14px', marginBottom: 14, fontSize: 12.5, display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
          {autoReading ? (
            <span style={{ color: 'var(--teal-deep,#256168)', fontWeight: 600 }}>Reading your documents…</span>
          ) : (!readerOn && autoReadPending > 0) ? (
            <span style={{ color: 'var(--muted,#4B585C)' }}>{autoReadPending} document{autoReadPending === 1 ? '' : 's'} on file — they’ll be read automatically the moment the reader is switched on.</span>
          ) : autoReadPending > 0 ? (
            <>
              <span style={{ color: 'var(--muted,#4B585C)' }}>{autoReadPending} document{autoReadPending === 1 ? '' : 's'} on file not read yet.</span>
              <button onClick={runAutoRead} style={btn(true)}>Read them all now</button>
            </>
          ) : autoReadMsg ? (
            <span style={{ color: 'var(--good,#3F7A5B)' }}>✓ {autoReadMsg}</span>
          ) : null}
        </div>
      )}

      {/* Documents the reader couldn't read AS the type their condition expects — likely the wrong
          document filed there (not really a title commitment, etc.) or a poor scan. Confirm + re-request. */}
      {!readOnly && !autoReading && autoReadUnreadable.length > 0 && (
        <div style={{ background: 'var(--amber-bg,#F6EEDD)', color: 'var(--amber,#B7791F)', border: '1px solid var(--line,#E7E1D3)', borderRadius: 10, padding: '9px 14px', marginBottom: 14, fontSize: 12.5 }}>
          ⚠ {autoReadUnreadable.length} document{autoReadUnreadable.length === 1 ? '' : 's'} couldn’t be read as expected — please confirm the right document is filed (or ask for a clearer copy): <b>{autoReadUnreadable.join(', ')}</b>
        </div>
      )}

      {/* analyze a document — staff only */}
      {!readOnly && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 18, flexWrap: 'wrap' }}>
          <select value={pick} onChange={(e) => onPickDoc(e.target.value)} style={sel}>
            <option value="">Choose a document…</option>
            {currentDocs.map((d) => <option key={d.id} value={d.id}>{d.filename}</option>)}
          </select>
          <select value={pickType} onChange={(e) => { setPickType(e.target.value); setDetected(''); }} style={sel}>
            <option value="">{detecting ? 'detecting type…' : 'as document type…'}</option>
            {docTypes.map((t) => <option key={t} value={t}>{label(t)}</option>)}
          </select>
          <button disabled={analyzing || !pick || !pickType} onClick={analyze} style={btn(true)}>{analyzing ? 'Reading…' : 'Read & check'}</button>
          {detected && pickType && <span style={{ fontSize: 11.5, color: 'var(--muted,#4B585C)' }}>auto-detected{detected === 'high' ? '' : ` (${detected} confidence — please confirm)`}</span>}
        </div>
      )}

      {/* roll-up */}
      {(sum.fatal > 0 || sum.warning > 0) && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 12, flexWrap: 'wrap' }}>
          {sum.fatal > 0 && <span style={{ fontWeight: 700, color: SEV.fatal.fg, background: SEV.fatal.bg, borderRadius: 999, padding: '4px 12px', fontSize: 12.5 }}>{sum.fatal} fatal</span>}
          {sum.warning > 0 && <span style={{ fontWeight: 700, color: SEV.warning.fg, background: SEV.warning.bg, borderRadius: 999, padding: '4px 12px', fontSize: 12.5 }}>{sum.warning} warning</span>}
          {sum.blocksCtc && <span style={{ fontSize: 12.5, color: SEV.fatal.fg }}>Clear-to-close is blocked until every fatal is resolved.</span>}
        </div>
      )}

      {/* the one-line verdict — the owner's at-a-glance read */}
      {verdict && verdict.headline && (() => {
        const V = {
          clear: { fg: 'var(--good,#3F7A5B)', bg: 'rgba(63,122,91,.10)' },
          review: { fg: 'var(--amber,#B7791F)', bg: 'var(--amber-bg,#F6EEDD)' },
          blocked: { fg: 'var(--crit,#B4483C)', bg: 'var(--crit-bg,#F6E7E4)' },
          pending: { fg: 'var(--muted,#4B585C)', bg: 'var(--paper,#F6F3EC)' },
        }[verdict.status] || { fg: 'var(--muted,#4B585C)', bg: 'var(--paper,#F6F3EC)' };
        return (
          <div style={{ border: `1px solid ${V.fg}33`, borderLeft: `5px solid ${V.fg}`, background: V.bg, borderRadius: 12, padding: '12px 16px', marginBottom: 18 }}>
            <div style={{ fontSize: 10.5, fontWeight: 800, letterSpacing: '.08em', textTransform: 'uppercase', color: V.fg, marginBottom: 3 }}>PILOT verdict</div>
            <div style={{ fontSize: 15, fontWeight: 600, color: 'var(--ivory,#141B22)' }}>{verdict.headline}</div>
          </div>
        );
      })()}

      {/* ALL open findings, in ONE place — exactly the set the roll-up counts, so the "2 warnings"
          chip maps to two visible, actionable items. A persisted per-document finding (has an id) is
          resolvable here; a derived advisory (tie-out / metric / staleness / liquidity / experience /
          entity chain) shows read-only and clears when its underlying data changes. Each finding
          appears once — the old per-section finding lists were removed so nothing is repeated. */}
      {allFindings.length > 0 && (
        <div style={{ marginBottom: 22 }}>
          <h4 style={{ fontFamily: 'var(--serif,Georgia,serif)', margin: '0 0 4px' }}>Open findings ({allFindings.length}) — everything that needs a look</h4>
          <p style={{ fontSize: 12, color: 'var(--muted,#4B585C)', margin: '0 0 12px' }}>
            Every open item across the whole file, in one list — the same items the counts above refer to.
          </p>
          {!readOnly && !canResolve && (
            <div className="notice" style={{ margin: '0 0 12px', fontSize: 12.5 }}>
              You can see every finding and exactly what disagrees. Clearing a dealbreaker (fixing the file,
              requesting a document, or granting an exception) is done by an underwriter or processor.
            </div>
          )}
          {allFindings.map((f, i) => (
            <Finding key={f.id || `${f.source || 'f'}-${f.code || 'x'}-${i}`} appId={appId} f={f}
              onChange={load} resolvable={!readOnly && canResolve && !!f.id} canWaive={canWaive} />
          ))}
        </div>
      )}

      {/* Appraisal findings — a SEPARATE source (the appraisal desk), so they live in their own list
          right beside the open-findings list. Only the FINDINGS (appraisal value vs the loan file),
          never the full property-profile report — that stays in the Appraisal section. Reuses the
          appraisal desk's own Finding component + resolve path, so resolving here updates the
          appraisal review too (and its re-price / replace-with-appraisal actions come along). */}
      {apprFindings.length > 0 && (
        <div style={{ marginBottom: 22 }}>
          <h4 style={{ fontFamily: 'var(--serif,Georgia,serif)', margin: '0 0 4px' }}>Appraisal findings — appraisal vs the loan file</h4>
          <p style={{ fontSize: 12, color: 'var(--muted,#4B585C)', margin: '0 0 10px' }}>
            From the imported appraisal. The full property profile stays in the Appraisal section.
          </p>
          {(apprSum.fatal > 0 || apprSum.warning > 0) && (
            <div style={{ display: 'flex', gap: 8, marginBottom: 10, flexWrap: 'wrap' }}>
              {apprSum.fatal > 0 && <span style={{ fontWeight: 700, color: SEV.fatal.fg, background: SEV.fatal.bg, borderRadius: 999, padding: '3px 11px', fontSize: 12 }}>{apprSum.fatal} fatal</span>}
              {apprSum.warning > 0 && <span style={{ fontWeight: 700, color: SEV.warning.fg, background: SEV.warning.bg, borderRadius: 999, padding: '3px 11px', fontSize: 12 }}>{apprSum.warning} warning</span>}
            </div>
          )}
          {apprFindings.map((f) => <AppraisalFinding key={f.id} appId={appId} f={f} onChange={load} readOnly={readOnly || !canResolve} />)}
        </div>
      )}

      {/* nothing open anywhere — the all-clear */}
      {allFindings.length === 0 && apprFindings.length === 0 && (
        <p style={{ color: 'var(--good,#3F7A5B)', fontSize: 13, marginBottom: 20 }}>✓ No open findings{exts.length ? ' — every analyzed document matches the file.' : ' yet — analyze a document to start the review.'}</p>
      )}

      {/* fraud / red-flag score — the top-of-file risk read */}
      <RiskScore risk={risk} />

      {/* file completeness — what's still needed to close */}
      <Completeness completeness={completeness} documentsOnFile={documentsOnFile} />

      {/* conditions coverage — ties every document back to the checklist */}
      <ConditionCoverage coverage={coverage} />

      {/* governing contract terms after amendments */}
      <Amendments amendments={amendments} />

      {/* loan metrics — LTP/LTV/LTC/ARV vs caps */}
      <Metrics metrics={metrics} />

      {/* entity-resolution chain */}
      <SellerChain sellerChain={sellerChain} />
      <EntityChain entityChain={entityChain} />
      <BankLiquidity bankLiquidity={bankLiquidity} />
      <Experience experience={experience} appId={appId} onChange={load} readOnly={readOnly || !canWaive} />

      {/* document freshness / staleness */}
      <StalenessBoard staleness={staleness} />

      {/* the data-comparison matrix — the full stare-and-compare across the file */}
      <TieOutMatrix tieout={tieout} />

      {/* what was read */}
      {exts.length > 0 && (
        <div style={{ marginTop: 8 }}>
          <h4 style={{ fontFamily: 'var(--serif,Georgia,serif)', margin: '0 0 12px' }}>What PILOT read</h4>
          {exts.map((e) => <ExtractionCard key={e.id} e={e} />)}
        </div>
      )}
    </div>
  );
}

const sel = { padding: '7px 10px', border: '1px solid var(--line,#E7E1D3)', borderRadius: 8, fontSize: 13.5, background: 'var(--card,#fff)', color: 'var(--ivory,#141B22)', maxWidth: 280 };
