import React, { useEffect, useState, useCallback, useRef } from 'react';
import { useLocation } from 'react-router-dom';
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
// Who a finding can be escalated to — the super-admin workload, or a processor / underwriter.
const ESCALATE_TARGETS = [
  { key: 'super_admin', label: 'Super-admin' },
  { key: 'processor', label: 'Processor' },
  { key: 'underwriter', label: 'Underwriter' },
];
function Finding({ appId, f, onChange, resolvable, canWaive = true, canEscalate = false, escalated = null, highlighted = false, cardRef = null }) {
  const [busy, setBusy] = useState(false);
  const [pending, setPending] = useState(null); // the action awaiting its note/value
  const [text, setText] = useState('');
  const [escOpen, setEscOpen] = useState(false);
  const [escRole, setEscRole] = useState('super_admin');
  const [escNote, setEscNote] = useState('');
  const [committeeBusy, setCommitteeBusy] = useState(false);
  const [committeeOpinion, setCommitteeOpinion] = useState(null);
  const runCommittee = async () => {
    if (!f.id) return;
    setCommitteeBusy(true);
    try {
      const r = await api.runCommitteeReview(appId, f.id, false);
      setCommitteeOpinion(r.opinion || null);
      onChange && onChange();
    } catch (e) { alert(e.message || 'The panel could not be reached'); }
    finally { setCommitteeBusy(false); }
  };
  const s = SEV[f.severity] || SEV.info;
  // The document this finding was raised from — used for the "open the source document" link and
  // the (optional) page-number hint. `page_number` starts flowing once db/226 + the docint.js
  // prebuilt-layout switch land and a document is re-analyzed; existing rows are NULL and the link
  // just says "Open source document" without the page hint.
  const docId = f.document_id || f.documentId || null;
  const pageNumber = f.page_number != null ? f.page_number : (f.pageNumber != null ? f.pageNumber : null);
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
  // Escalate this finding into the super-admin / processor / underwriter workload — carrying a
  // snapshot of the finding, its explanation, and the framed options — so a staffer who can't
  // decide it can hand it off instead of guessing ("don't make up things — ask").
  const submitEscalation = async () => {
    setBusy(true);
    try {
      await api.underwritingEscalateFinding(appId, {
        findingId: f.id || null,
        finding: { code: f.code, severity: f.severity, field: f.field, title: f.title,
          howTo, docValue: docVal, fileValue: fileVal, documentId: f.document_id || f.documentId,
          availableActions: allActions },
        targetRole: escRole, note: escNote,
      });
      setEscOpen(false); setEscNote('');
      onChange && onChange();
    } catch (e) { alert(e.message || 'Could not escalate the finding'); }
    finally { setBusy(false); }
  };

  // Open the source document (the one the finding was raised from) in a new tab. The download
  // endpoint uses Bearer auth, so it goes through the existing authenticated downloader — same
  // pattern the file's Documents section uses.
  const openSourceDoc = async (e) => {
    if (e && e.preventDefault) e.preventDefault();
    if (!docId) return;
    try {
      const res = await api.staffDownloadDoc(docId);
      const blob = res && res.blob;
      const filename = res && res.filename;
      if (!blob) return;
      const url = URL.createObjectURL(blob);
      const w = window.open(url, '_blank');
      if (!w) { const a = document.createElement('a'); a.href = url; a.download = filename || 'document'; document.body.appendChild(a); a.click(); a.remove(); }
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
    } catch (err) { alert(err.message || 'Could not open the source document'); }
  };
  return (
    <div ref={cardRef} style={{
      border: '1px solid var(--line,#E7E1D3)', borderLeft: `4px solid ${s.fg}`, borderRadius: 12,
      background: 'var(--card,#fff)', padding: '14px 16px', marginBottom: 12,
      transition: 'box-shadow 0.4s ease, border-color 0.4s ease',
      boxShadow: highlighted ? '0 0 0 3px #AE8746' : 'none',
      borderLeftColor: highlighted ? '#AE8746' : s.fg,
    }}>
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
      {docId && (
        <div style={{ fontSize: 12, margin: '4px 0 6px' }}>
          <a href="#" onClick={openSourceDoc} style={{ color: 'var(--teal-deep,#256168)', textDecoration: 'underline' }}>
            Open the source document{pageNumber ? ` (page ${pageNumber})` : ''}
          </a>
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
      {/* Escalate — hand a finding you can't decide to the super-admin / processor / underwriter
          workload. Available on EVERY finding (owner-directed 2026-07-21), even for a staffer who
          can't resolve it. Once escalated, we show it's in someone's queue instead of a button. */}
      {canEscalate && escalated && (
        <div style={{ marginTop: 10, fontSize: 12, color: 'var(--teal-deep,#256168)' }}>
          ↗ Escalated to {(ESCALATE_TARGETS.find((t) => t.key === escalated.targetRole) || {}).label || 'a reviewer'} — awaiting their review.
        </div>
      )}
      {canEscalate && !escalated && !escOpen && (
        <div style={{ marginTop: 10, display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <button disabled={busy} onClick={() => setEscOpen(true)} title="Send this finding to a super-admin, processor, or underwriter to decide"
            style={{ ...btn(), fontSize: 12, padding: '5px 10px' }}>↗ Escalate for review</button>
          {resolvable && f.id && (
            <button disabled={busy || committeeBusy} onClick={runCommittee}
              title="Ask the multi-model reasoning committee (7 specialist reviewers) to independently confirm or REFUTE this finding"
              style={{ ...btn(), fontSize: 12, padding: '5px 10px' }}>
              {committeeBusy ? 'Panel reviewing…' : (committeeOpinion ? '↻ Re-run panel review' : '👥 Ask the panel')}
            </button>
          )}
        </div>
      )}
      {committeeOpinion && committeeOpinion.committee && (
        <div style={{ marginTop: 10, padding: 10, background: 'rgba(174,135,70,0.08)', border: '1px solid #AE8746', borderRadius: 8 }}>
          <div style={{ fontSize: 11, fontWeight: 800, textTransform: 'uppercase', letterSpacing: '.06em', color: '#AE8746', marginBottom: 4 }}>Panel review</div>
          <div style={{ fontSize: 13, color: 'var(--ivory,#141B22)', marginBottom: 6 }}>
            <b>{String(committeeOpinion.committee.action).toUpperCase()}</b> at <b>{committeeOpinion.committee.adjudicated_severity}</b> — {committeeOpinion.committee.reasoning}
          </div>
          {Array.isArray(committeeOpinion.committee.votes) && committeeOpinion.committee.votes.length > 0 && (
            <ul style={{ margin: 0, padding: 0, listStyle: 'none', fontSize: 12 }}>
              {committeeOpinion.committee.votes.map((v, i) => (
                <li key={i} style={{ color: 'var(--muted,#4B585C)' }}>
                  {v.specialist}: {v.ok ? `${v.verdict.verdict} (${Math.round(Number(v.verdict.confidence || 0) * 100)}%) — ${v.verdict.reason}` : `failed (${v.reason})`}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
      {canEscalate && !escalated && escOpen && (
        <div style={{ marginTop: 10, padding: 10, border: '1px solid var(--line,#E7E1D3)', borderRadius: 10, background: 'var(--ink-2,#F4F1EA)' }}>
          <div style={{ fontSize: 12, fontWeight: 700, marginBottom: 6, color: 'var(--ivory,#141B22)' }}>Escalate this finding — who should review it?</div>
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 8 }}>
            {ESCALATE_TARGETS.map((t) => (
              <button key={t.key} onClick={() => setEscRole(t.key)} disabled={busy}
                style={btn(escRole === t.key)}>{t.label}</button>
            ))}
          </div>
          <textarea value={escNote} onChange={(e) => setEscNote(e.target.value)} rows={2}
            placeholder="What do you need decided? (e.g. which guideline applies, is this a real issue, how should we condition it)"
            style={{ width: '100%', boxSizing: 'border-box', padding: '7px 10px', border: '1px solid var(--line,#E7E1D3)', borderRadius: 8, fontSize: 13, color: 'var(--ivory,#141B22)', background: 'var(--card,#fff)' }} />
          <div style={{ display: 'flex', gap: 8, marginTop: 8, flexWrap: 'wrap' }}>
            <button disabled={busy} onClick={submitEscalation} style={btn(true)}>Send to {(ESCALATE_TARGETS.find((t) => t.key === escRole) || {}).label}</button>
            <button disabled={busy} onClick={() => { setEscOpen(false); setEscNote(''); }} style={btn()}>Cancel</button>
          </div>
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
  // Exception-first: a "Show only mismatches" focus toggle (owner-directed 2026-07-21 — the
  // research's exception-first pattern). Default shows every fact (the owner wants "every fact,
  // every document"); one click narrows to just the rows that disagree so an underwriter can
  // triage. Hooks must run before any early return.
  const [onlyIssues, setOnlyIssues] = useState(false);
  if (!tieout || !tieout.matrix || !tieout.matrix.length) return null;
  const { columns, matrix, summary } = tieout;
  const shown = matrix.filter((r) => r.status !== 'none'); // hide facts nothing in the file speaks to
  if (!shown.length) return null;
  const mismatchCount = shown.filter((r) => r.status === 'mismatch').length;
  // Per-category mismatch tally for the section-header badges.
  const catMismatch = {};
  for (const r of shown) if (r.status === 'mismatch') catMismatch[r.category] = (catMismatch[r.category] || 0) + 1;
  const visible = onlyIssues ? shown.filter((r) => r.status === 'mismatch') : shown;
  const th = { padding: '7px 10px', fontSize: 10.5, fontWeight: 700, letterSpacing: '.04em', textTransform: 'uppercase', color: 'var(--muted,#4B585C)', textAlign: 'left', whiteSpace: 'nowrap', borderBottom: '1px solid var(--line,#E7E1D3)' };
  const cellStyle = (s) => ({ padding: '7px 10px', fontSize: 12.5, borderBottom: '1px solid var(--line-soft,#EFEADD)', background: (CELL[s] || CELL.noref).bg, color: (CELL[s] || CELL.noref).fg, verticalAlign: 'top' });
  let lastCat = null;
  return (
    <div style={{ marginBottom: 22 }}>
      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 10, flexWrap: 'wrap' }}>
        <h4 style={{ fontFamily: 'var(--serif,Georgia,serif)', margin: '0 0 4px' }}>Data comparison — every fact, every document</h4>
        {mismatchCount > 0 && (
          <button onClick={() => setOnlyIssues((v) => !v)}
            title={onlyIssues ? 'Show every fact again' : 'Show only the facts that disagree'}
            style={{ fontSize: 12, fontWeight: 600, borderRadius: 8, padding: '5px 11px', cursor: 'pointer',
              border: '1px solid ' + (onlyIssues ? 'var(--crit,#B4483C)' : 'var(--line,#D9D4C8)'),
              background: onlyIssues ? 'var(--crit,#B4483C)' : 'var(--ink-2,#F4F1EA)',
              color: onlyIssues ? '#fff' : 'var(--ivory,#141B22)' }}>
            {onlyIssues ? `Showing ${mismatchCount} issue${mismatchCount === 1 ? '' : 's'} — show all` : `Show only issues (${mismatchCount})`}
          </button>
        )}
      </div>
      <div style={{ fontSize: 12, color: 'var(--muted,#4B585C)', marginBottom: 10 }}>
        {summary ? `${summary.matched} of ${summary.facts} facts tie out${mismatchCount ? ` · ${mismatchCount} disagree` : ' · everything agrees'} · ` : ''}
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
            {visible.map((row) => {
              const catHeader = ROWCAT[row.category] && row.category !== lastCat ? (lastCat = row.category, ROWCAT[row.category]) : null;
              const catBad = catHeader ? (catMismatch[row.category] || 0) : 0;
              return (
                <React.Fragment key={row.key}>
                  {catHeader && (
                    <tr><td colSpan={columns.length + 1} style={{ padding: '8px 10px 3px', fontSize: 10, fontWeight: 800, letterSpacing: '.08em', textTransform: 'uppercase', color: 'var(--gold,#AE8746)' }}>
                      {catHeader}
                      {catBad > 0 && <span style={{ marginLeft: 8, color: 'var(--crit,#B4483C)', fontWeight: 800 }}>● {catBad} {catBad === 1 ? 'mismatch' : 'mismatches'}</span>}
                    </td></tr>
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
// The Sovereign cockpit — collapsible summary of canonical facts (from the
// loan digital twin, db/232) and per-condition cure proofs (db/233).
// Read-only presentation of what the underlying Sovereign engines produced.
// Both sections start collapsed so the classic findings list stays the
// default view; a reviewer opens them when they want the evidence trail.
function SovereignCockpit({ twinFacts, cureProofs, appId, canIssueCerts }) {
  const [openTwin, setOpenTwin] = useState(false);
  const [openCures, setOpenCures] = useState(false);
  const [expandedFact, setExpandedFact] = useState(null);
  const [factHistory, setFactHistory] = useState({});   // fact_key → { loading, canonical, observations, events }
  const toggleFact = async (factKey) => {
    if (expandedFact === factKey) { setExpandedFact(null); return; }
    setExpandedFact(factKey);
    if (factHistory[factKey]) return;   // cached
    setFactHistory((h) => ({ ...h, [factKey]: { loading: true } }));
    try {
      const d = await api.factHistory(appId, factKey);
      setFactHistory((h) => ({ ...h, [factKey]: { loading: false, ...d } }));
    } catch (e) { setFactHistory((h) => ({ ...h, [factKey]: { loading: false, error: e.message || 'could not load' } })); }
  };
  const twinCount = (twinFacts || []).length;
  const cureCount = (cureProofs || []).length;
  if (twinCount === 0 && cureCount === 0) return null;
  const STATUS_STYLES = {
    verified:            { fg: 'var(--good,#3F7A5B)',      bg: 'rgba(63,122,91,.12)',    label: 'Verified' },
    corroborated:        { fg: 'var(--good,#3F7A5B)',      bg: 'rgba(63,122,91,.10)',    label: 'Corroborated' },
    observed:            { fg: 'var(--muted,#4B585C)',     bg: 'var(--paper,#F6F3EC)',   label: 'Observed' },
    disputed:            { fg: 'var(--crit,#B4483C)',      bg: 'var(--crit-bg,#F6E7E4)', label: 'Disputed' },
    human_confirmed:     { fg: 'var(--teal-deep,#256168)', bg: 'rgba(47,127,134,.12)',   label: 'Confirmed by staff' },
    superseded:          { fg: 'var(--muted,#4B585C)',     bg: 'var(--paper,#F6F3EC)',   label: 'Superseded' },
    unable_to_determine: { fg: 'var(--amber,#B7791F)',     bg: 'var(--amber-bg,#F6EEDD)',label: 'Unable to determine' },
  };
  const RESULT_STYLES = {
    satisfied:           { fg: 'var(--good,#3F7A5B)',      bg: 'rgba(63,122,91,.12)',    label: 'Satisfied' },
    partially_satisfied: { fg: 'var(--amber,#B7791F)',     bg: 'var(--amber-bg,#F6EEDD)',label: 'Partial' },
    not_satisfied:       { fg: 'var(--crit,#B4483C)',      bg: 'var(--crit-bg,#F6E7E4)', label: 'Not satisfied' },
    creates_new_finding: { fg: 'var(--crit,#B4483C)',      bg: 'var(--crit-bg,#F6E7E4)', label: 'New finding surfaced' },
    unable_to_determine: { fg: 'var(--muted,#4B585C)',     bg: 'var(--paper,#F6F3EC)',   label: 'Unable to determine' },
  };
  const REQ_STYLES = {
    satisfied:           { color: 'var(--good,#3F7A5B)',  mark: '✓' },
    not_satisfied:       { color: 'var(--crit,#B4483C)',  mark: '✕' },
    unable_to_determine: { color: 'var(--muted,#4B585C)', mark: '?' },
  };
  const stringifyValue = (v) => {
    if (v == null) return '—';
    if (typeof v === 'string') return v.length > 90 ? v.slice(0, 90) + '…' : v;
    try { return JSON.stringify(v).slice(0, 90); } catch (_) { return '—'; }
  };
  return (
    <div style={{ marginBottom: 22, border: '1px solid var(--line,#E7E1D3)', borderRadius: 12, background: 'var(--card,#fff)', overflow: 'hidden' }}>
      <div style={{ padding: '10px 14px', borderBottom: '1px solid var(--line,#E7E1D3)', background: 'rgba(174,135,70,0.05)' }}>
        <div style={{ fontSize: 10.5, fontWeight: 800, letterSpacing: '.08em', textTransform: 'uppercase', color: '#AE8746', marginBottom: 2 }}>Sovereign evidence</div>
        <div style={{ fontSize: 12.5, color: 'var(--muted,#4B585C)' }}>
          Canonical facts and per-condition cure proofs — the underlying evidence layer PILOT computes on.
        </div>
      </div>
      {twinCount > 0 && (
        <div style={{ padding: '10px 14px', borderBottom: '1px solid var(--line,#E7E1D3)' }}>
          <button onClick={() => setOpenTwin((v) => !v)} style={{ display: 'flex', alignItems: 'center', gap: 8, background: 'none', border: 'none', cursor: 'pointer', padding: 0, textAlign: 'left', width: '100%' }}>
            <span style={{ fontSize: 14, fontWeight: 700 }}>Canonical facts ({twinCount})</span>
            <span style={{ marginLeft: 'auto', fontSize: 12, color: 'var(--muted,#4B585C)' }}>{openTwin ? 'hide' : 'show'}</span>
          </button>
          {openTwin && (
            <table style={{ width: '100%', marginTop: 10, borderCollapse: 'collapse', fontSize: 12.5 }}>
              <thead>
                <tr style={{ textAlign: 'left', color: 'var(--muted,#4B585C)' }}>
                  <th style={{ padding: '4px 6px' }}>Fact</th>
                  <th style={{ padding: '4px 6px' }}>Accepted value</th>
                  <th style={{ padding: '4px 6px' }}>Status</th>
                </tr>
              </thead>
              <tbody>
                {twinFacts.map((f) => {
                  const st = STATUS_STYLES[f.status] || STATUS_STYLES.observed;
                  const isOpen = expandedFact === f.fact_key;
                  const hist = factHistory[f.fact_key];
                  return (
                    <React.Fragment key={f.fact_key}>
                      <tr onClick={() => appId && toggleFact(f.fact_key)}
                          style={{ borderTop: '1px solid var(--line,#E7E1D3)', cursor: appId ? 'pointer' : 'default', background: isOpen ? 'rgba(174,135,70,0.05)' : 'transparent' }}
                          title={appId ? 'Click to see every source that reported this' : ''}>
                        <td style={{ padding: '5px 6px', color: 'var(--muted,#4B585C)' }}>
                          {appId && <span style={{ marginRight: 4, color: '#AE8746' }}>{isOpen ? '▾' : '▸'}</span>}
                          {String(f.fact_key || '').replace(/_/g, ' ')}
                        </td>
                        <td style={{ padding: '5px 6px', overflowWrap: 'anywhere' }}>{stringifyValue(f.value_json && (f.value_json.value != null ? f.value_json.value : f.value_json))}</td>
                        <td style={{ padding: '5px 6px' }}>
                          <span style={{ fontSize: 10.5, fontWeight: 800, letterSpacing: '.04em', textTransform: 'uppercase', color: st.fg, background: st.bg, padding: '2px 7px', borderRadius: 6 }}>{st.label}</span>
                        </td>
                      </tr>
                      {isOpen && (
                        <tr style={{ background: 'rgba(174,135,70,0.03)' }}>
                          <td colSpan={3} style={{ padding: '10px 14px' }}>
                            {(!hist || hist.loading) && <div className="muted" style={{ fontSize: 12 }}>Loading…</div>}
                            {hist && hist.error && <div style={{ fontSize: 12, color: 'var(--crit,#B4483C)' }}>{hist.error}</div>}
                            {hist && !hist.loading && !hist.error && (
                              <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                                <div>
                                  <div style={{ fontSize: 11, fontWeight: 800, textTransform: 'uppercase', letterSpacing: '.06em', color: 'var(--muted,#4B585C)', marginBottom: 4 }}>
                                    Every source that reported this ({(hist.observations || []).length})
                                  </div>
                                  {(hist.observations || []).length === 0 && <div className="muted" style={{ fontSize: 12 }}>No source has reported this yet.</div>}
                                  <ul style={{ listStyle: 'none', margin: 0, padding: 0, fontSize: 12 }}>
                                    {(hist.observations || []).map((o) => (
                                      <li key={o.id} style={{ padding: '4px 0', borderTop: '1px dotted var(--line,#E7E1D3)' }}>
                                        <span style={{ color: o.agrees_with_canonical === false ? 'var(--crit,#B4483C)' : 'var(--good,#3F7A5B)', fontWeight: 700, marginRight: 6 }}>
                                          {o.agrees_with_canonical === false ? '✕' : '✓'}
                                        </span>
                                        <b>{o.source_type === 'document' ? String(o.source_id || 'document').replace(/_/g, ' ') : (o.source_type === 'los_field' ? 'the loan file (LOS)' : o.source_type === 'api_verification' ? `${o.source_id || 'an outside API'} (verified)` : String(o.source_type).replace(/_/g, ' '))}</b>
                                        {' said '}
                                        <span style={{ overflowWrap: 'anywhere' }}>{stringifyValue(o.value_json && (o.value_json.value != null ? o.value_json.value : o.value_json)) || o.raw_value || '—'}</span>
                                        <span className="muted"> · {new Date(o.created_at).toLocaleString()}</span>
                                      </li>
                                    ))}
                                  </ul>
                                </div>
                                {(hist.events || []).length > 0 && (
                                  <div>
                                    <div style={{ fontSize: 11, fontWeight: 800, textTransform: 'uppercase', letterSpacing: '.06em', color: 'var(--muted,#4B585C)', marginBottom: 4 }}>Recent changes</div>
                                    <ul style={{ listStyle: 'none', margin: 0, padding: 0, fontSize: 12 }}>
                                      {hist.events.slice(0, 8).map((ev) => (
                                        <li key={ev.id} style={{ padding: '3px 0', color: 'var(--muted,#4B585C)' }}>
                                          {String(ev.event_type).replace(/_/g, ' ')}
                                          {ev.reason ? ` — ${ev.reason}` : ''}
                                          <span className="muted"> · {new Date(ev.created_at).toLocaleString()}</span>
                                        </li>
                                      ))}
                                    </ul>
                                  </div>
                                )}
                              </div>
                            )}
                          </td>
                        </tr>
                      )}
                    </React.Fragment>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>
      )}
      {cureCount > 0 && (
        <div style={{ padding: '10px 14px' }}>
          <button onClick={() => setOpenCures((v) => !v)} style={{ display: 'flex', alignItems: 'center', gap: 8, background: 'none', border: 'none', cursor: 'pointer', padding: 0, textAlign: 'left', width: '100%' }}>
            <span style={{ fontSize: 14, fontWeight: 700 }}>Condition cure proofs ({cureCount})</span>
            <span style={{ marginLeft: 'auto', fontSize: 12, color: 'var(--muted,#4B585C)' }}>{openCures ? 'hide' : 'show'}</span>
          </button>
          {openCures && (
            <div style={{ marginTop: 10 }}>
              {cureProofs.map((p) => {
                const rs = RESULT_STYLES[p.result] || RESULT_STYLES.unable_to_determine;
                const reqs = Array.isArray(p.requirements_json) ? p.requirements_json : [];
                return (
                  <div key={p.id} style={{ border: '1px solid var(--line,#E7E1D3)', borderRadius: 8, padding: 10, marginBottom: 8 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginBottom: 6 }}>
                      <span style={{ fontSize: 10.5, fontWeight: 800, letterSpacing: '.04em', textTransform: 'uppercase', color: rs.fg, background: rs.bg, padding: '2px 7px', borderRadius: 6 }}>{rs.label}</span>
                      {p.recommended_action && (
                        <span style={{ fontSize: 11.5, color: 'var(--muted,#4B585C)' }}>· recommended: {String(p.recommended_action).replace(/_/g, ' ')}</span>
                      )}
                    </div>
                    {p.reviewer_summary && (
                      <div style={{ fontSize: 12.5, color: 'var(--ivory,#141B22)', marginBottom: 6 }}>{p.reviewer_summary}</div>
                    )}
                    {reqs.length > 0 && (
                      <ul style={{ margin: 0, padding: 0, listStyle: 'none' }}>
                        {reqs.map((r, idx) => {
                          const s = REQ_STYLES[r.status] || REQ_STYLES.unable_to_determine;
                          return (
                            <li key={idx} style={{ fontSize: 12.5, padding: '2px 0', color: 'var(--ivory,#141B22)' }}>
                              <span style={{ color: s.color, fontWeight: 700, marginRight: 6 }}>{s.mark}</span>
                              <span>{r.label || r.id}</span>
                              {r.reason && <span style={{ color: 'var(--muted,#4B585C)' }}> — {r.reason}</span>}
                            </li>
                          );
                        })}
                      </ul>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}
      {appId && <SovereignCertificatesSection appId={appId} canIssue={canIssueCerts} />}
      {appId && <SovereignStructuringSection appId={appId} />}
    </div>
  );
}

// Decision Certificates section (Sovereign — blueprint sec. 18/19). Fetches on
// mount; shows one row per milestone with the current signed snapshot's
// surveillance state + an "Issue" button for the milestones that haven't been
// stamped yet. Read-only for non-underwriters.
const MILESTONES = [
  { key: 'initial_review',        label: 'Initial review' },
  { key: 'conditional_approval',  label: 'Conditional approval' },
  { key: 'resubmission',          label: 'Resubmission review' },
  { key: 'clear_to_close',        label: 'Clear to close' },
  { key: 'pre_funding',           label: 'Pre-funding QC' },
  { key: 'purchase_review',       label: 'Purchase review' },
  { key: 'post_closing_qc',       label: 'Post-closing QC' },
];
const CERT_STATE_STYLES = {
  valid:                { fg: 'var(--good,#3F7A5B)',  bg: 'rgba(63,122,91,.12)',   label: 'Valid' },
  validation_required:  { fg: 'var(--crit,#B4483C)',  bg: 'var(--crit-bg,#F6E7E4)', label: 'Needs re-verification' },
  suspended:            { fg: 'var(--amber,#B7791F)', bg: 'var(--amber-bg,#F6EEDD)',label: 'Suspended' },
  revoked:              { fg: 'var(--crit,#B4483C)',  bg: 'var(--crit-bg,#F6E7E4)', label: 'Revoked' },
  superseded:           { fg: 'var(--muted,#4B585C)', bg: 'var(--paper,#F6F3EC)',   label: 'Superseded' },
};
function SovereignCertificatesSection({ appId, canIssue }) {
  const [open, setOpen] = useState(false);
  const [certs, setCerts] = useState([]);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState(null);
  const load = () => api.fileCertificates(appId)
    .then((d) => setCerts(d.certificates || []))
    .catch(() => setCerts([]));
  useEffect(() => { if (open && appId) load(); /* eslint-disable-next-line */ }, [open, appId]);
  const latestFor = (mkey) => certs.filter((c) => c.milestone === mkey).sort((a, b) => new Date(b.issued_at) - new Date(a.issued_at))[0] || null;
  async function issue(mkey) {
    setBusy(true); setMsg(null);
    try { await api.fileCertificateIssue(appId, mkey); setMsg({ ok: true, text: 'Signed snapshot recorded.' }); await load(); }
    catch (e) { setMsg({ ok: false, text: e.message || 'Could not record the signed snapshot.' }); }
    finally { setBusy(false); setTimeout(() => setMsg(null), 8000); }
  }
  async function survey() {
    setBusy(true); setMsg(null);
    try { const r = await api.fileCertificateSurvey(appId);
      const flagged = (r.results || []).filter((x) => x.transitioned).length;
      setMsg({ ok: true, text: flagged > 0 ? `${flagged} signed snapshot(s) need a re-verification.` : 'Every signed snapshot is still valid.' });
      await load();
    } catch (e) { setMsg({ ok: false, text: e.message || 'Could not re-check.' }); }
    finally { setBusy(false); setTimeout(() => setMsg(null), 8000); }
  }
  return (
    <div style={{ padding: '10px 14px', borderTop: '1px solid var(--line,#E7E1D3)' }}>
      <button onClick={() => setOpen((v) => !v)} style={{ display: 'flex', alignItems: 'center', gap: 8, background: 'none', border: 'none', cursor: 'pointer', padding: 0, textAlign: 'left', width: '100%' }}>
        <span style={{ fontSize: 14, fontWeight: 700 }}>Signed snapshots at each milestone</span>
        <span style={{ marginLeft: 'auto', fontSize: 12, color: 'var(--muted,#4B585C)' }}>{open ? 'hide' : 'show'}</span>
      </button>
      {open && (
        <div style={{ marginTop: 10 }}>
          <p style={{ fontSize: 12, color: 'var(--muted,#4B585C)', margin: '0 0 10px' }}>
            At every big step (initial review, clear-to-close, before funding, after closing), PILOT saves an unchangeable copy of what the file said at that moment — the numbers, the findings, the exceptions granted, and what version of the rules was in use. If anything on the file changes later, the snapshot flags itself so you know to re-verify.
          </p>
          {msg && <div className={`notice ${msg.ok ? 'ok' : 'err'}`} style={{ marginBottom: 8, fontSize: 12.5 }}>{msg.text}</div>}
          <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 8 }}>
            <button disabled={busy || !canIssue} onClick={survey} style={{ fontSize: 12, padding: '5px 10px', border: '1px solid var(--line,#E7E1D3)', borderRadius: 6, background: 'var(--paper,#F6F3EC)', cursor: 'pointer' }}>
              Re-check every snapshot on this file
            </button>
          </div>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12.5 }}>
            <thead>
              <tr style={{ textAlign: 'left', color: 'var(--muted,#4B585C)' }}>
                <th style={{ padding: '4px 6px' }}>Milestone</th>
                <th style={{ padding: '4px 6px' }}>Stamped</th>
                <th style={{ padding: '4px 6px' }}>State</th>
                <th style={{ padding: '4px 6px' }}>Integrity</th>
                {canIssue && <th style={{ padding: '4px 6px' }}></th>}
              </tr>
            </thead>
            <tbody>
              {MILESTONES.map((m) => {
                const cur = latestFor(m.key);
                const st = cur ? (CERT_STATE_STYLES[cur.surveillance_state] || CERT_STATE_STYLES.valid) : null;
                return (
                  <tr key={m.key} style={{ borderTop: '1px solid var(--line,#E7E1D3)' }}>
                    <td style={{ padding: '5px 6px' }}>{m.label}</td>
                    <td style={{ padding: '5px 6px', color: 'var(--muted,#4B585C)' }}>
                      {cur ? new Date(cur.issued_at).toLocaleString() : '—'}
                    </td>
                    <td style={{ padding: '5px 6px' }}>
                      {cur ? (
                        <span style={{ fontSize: 10.5, fontWeight: 800, letterSpacing: '.04em', textTransform: 'uppercase', color: st.fg, background: st.bg, padding: '2px 7px', borderRadius: 6 }}>{st.label}</span>
                      ) : <span style={{ color: 'var(--muted,#4B585C)' }}>not stamped yet</span>}
                    </td>
                    <td style={{ padding: '5px 6px', color: cur && cur.integrity && cur.integrity.ok === false ? 'var(--crit,#B4483C)' : 'var(--good,#3F7A5B)' }}>
                      {cur ? (cur.integrity && cur.integrity.ok === false ? 'FAILED' : 'ok') : ''}
                    </td>
                    {canIssue && (
                      <td style={{ padding: '5px 6px', textAlign: 'right' }}>
                        <button disabled={busy} onClick={() => issue(m.key)} style={{ fontSize: 12, padding: '4px 10px', border: '1px solid #AE8746', borderRadius: 6, background: '#AE8746', color: '#fff', cursor: 'pointer' }}>
                          {cur ? 'Stamp a fresh snapshot' : 'Stamp this milestone'}
                        </button>
                      </td>
                    )}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// Counterfactual structuring section (Sovereign — blueprint sec. 12). Shows
// alternative structures that would move the file to ELIGIBLE — reduce loan
// by 1/2/5/10%, switch program, longer term, interest-only. Read-only.
function SovereignStructuringSection({ appId }) {
  const [open, setOpen] = useState(false);
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  useEffect(() => {
    if (!open || !appId) return;
    setLoading(true);
    api.fileStructuring(appId)
      .then((d) => setData(d && d.ok !== false ? d : { ok: false, reason: (d && d.reason) || 'no data' }))
      .catch(() => setData({ ok: false, reason: 'could not load alternatives' }))
      .finally(() => setLoading(false));
  }, [open, appId]);
  const dollars = (n) => n == null ? '—' : `$${Math.round(Number(n) || 0).toLocaleString('en-US')}`;
  const rate = (r) => r == null ? '—' : `${(Number(r) * 100).toFixed(3)}%`;
  const STATUS_STYLES = {
    ELIGIBLE:   { fg: 'var(--good,#3F7A5B)',  bg: 'rgba(63,122,91,.12)',    label: 'Would qualify' },
    MANUAL:     { fg: 'var(--amber,#B7791F)', bg: 'var(--amber-bg,#F6EEDD)',label: 'Manual review' },
    INELIGIBLE: { fg: 'var(--crit,#B4483C)',  bg: 'var(--crit-bg,#F6E7E4)', label: 'Would not qualify' },
    ERROR:      { fg: 'var(--muted,#4B585C)', bg: 'var(--paper,#F6F3EC)',   label: 'Could not size' },
  };
  return (
    <div style={{ padding: '10px 14px', borderTop: '1px solid var(--line,#E7E1D3)' }}>
      <button onClick={() => setOpen((v) => !v)} style={{ display: 'flex', alignItems: 'center', gap: 8, background: 'none', border: 'none', cursor: 'pointer', padding: 0, textAlign: 'left', width: '100%' }}>
        <span style={{ fontSize: 14, fontWeight: 700 }}>What would make this deal work?</span>
        <span style={{ marginLeft: 'auto', fontSize: 12, color: 'var(--muted,#4B585C)' }}>{open ? 'hide' : 'show'}</span>
      </button>
      {open && (
        <div style={{ marginTop: 10 }}>
          <p style={{ fontSize: 12, color: 'var(--muted,#4B585C)', margin: '0 0 10px' }}>
            Alternative structures for this file. Each row is the same deal with one thing changed — a smaller loan, the other program, a longer term. The math uses the same pricing engine the file was registered against; nothing here changes the file.
          </p>
          {loading && <div className="muted" style={{ fontSize: 12 }}>Working it out…</div>}
          {!loading && data && data.ok === false && <div className="muted" style={{ fontSize: 12 }}>{data.reason || 'Nothing to show yet — register the file first, then come back.'}</div>}
          {!loading && data && data.ok && Array.isArray(data.alternatives) && data.alternatives.length > 0 && (
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12.5 }}>
              <thead>
                <tr style={{ textAlign: 'left', color: 'var(--muted,#4B585C)' }}>
                  <th style={{ padding: '4px 6px' }}>Change</th>
                  <th style={{ padding: '4px 6px' }}>Would qualify?</th>
                  <th style={{ padding: '4px 6px' }}>Loan</th>
                  <th style={{ padding: '4px 6px' }}>Rate</th>
                  <th style={{ padding: '4px 6px' }}>vs current</th>
                </tr>
              </thead>
              <tbody>
                {data.alternatives.map((alt) => {
                  const st = STATUS_STYLES[alt.status] || STATUS_STYLES.ERROR;
                  const dTotal = alt.delta && Number.isFinite(alt.delta.totalLoan) ? alt.delta.totalLoan : null;
                  const dBps = alt.delta && Number.isFinite(alt.delta.noteRateBps) ? alt.delta.noteRateBps : null;
                  return (
                    <tr key={alt.key} style={{ borderTop: '1px solid var(--line,#E7E1D3)' }}>
                      <td style={{ padding: '5px 6px' }}>{alt.label}</td>
                      <td style={{ padding: '5px 6px' }}>
                        <span style={{ fontSize: 10.5, fontWeight: 800, letterSpacing: '.04em', textTransform: 'uppercase', color: st.fg, background: st.bg, padding: '2px 7px', borderRadius: 6 }}>{st.label}</span>
                      </td>
                      <td style={{ padding: '5px 6px' }}>{dollars(alt.quote && alt.quote.totalLoan)}</td>
                      <td style={{ padding: '5px 6px' }}>{rate(alt.quote && alt.quote.noteRate)}</td>
                      <td style={{ padding: '5px 6px', color: 'var(--muted,#4B585C)' }}>
                        {dTotal != null ? `${dTotal >= 0 ? '+' : ''}${dollars(dTotal).replace('$', '$')}` : '—'}
                        {dBps != null ? ` · ${dBps >= 0 ? '+' : ''}${dBps} bps` : ''}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>
      )}
    </div>
  );
}

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
  // Deep-link support (owner-directed 2026-07-21): arriving here with ?finding=<id> in the URL
  // scrolls the panel to that specific finding and pulses its border gold for a few seconds so a
  // reviewer coming from the "Findings to review" queue sees exactly which finding to act on. The
  // ?finding= reader supports both the browser query and the HashRouter query-in-hash form.
  const location = useLocation();
  const focusFindingId = (() => {
    const q = new URLSearchParams(location.search).get('finding');
    if (q) return q;
    // HashRouter puts query params AFTER the # (e.g. /portal/#/internal/app/X?finding=Y).
    const h = String(location.hash || '');
    const qIdx = h.indexOf('?');
    if (qIdx >= 0) { try { return new URLSearchParams(h.slice(qIdx + 1)).get('finding') || ''; } catch (_) {} }
    return '';
  })();
  const findingRefs = useRef({});
  const [highlightPulse, setHighlightPulse] = useState(false);

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

  // Deep-link scroll (Rules of Hooks — must run every render, so it stays ABOVE the early return).
  // When we arrive with ?finding=<id> AND the findings have loaded, scroll the matching card into
  // view and pulse it for ~3s. Re-runs after each load so a resolve → re-load lands on the right card.
  const _allFindingsForFocus = (data && data.allFindings) || [];
  useEffect(() => {
    if (!focusFindingId || !_allFindingsForFocus.length) return;
    const el = findingRefs.current[focusFindingId];
    if (el && typeof el.scrollIntoView === 'function') {
      try { el.scrollIntoView({ behavior: 'smooth', block: 'center' }); } catch (_) {}
    }
    setHighlightPulse(true);
    const t = setTimeout(() => setHighlightPulse(false), 3200);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusFindingId, _allFindingsForFocus.length]);

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

      {/* Sovereign Cockpit — Canonical facts (twin) + Condition cure proofs
          (Sovereign 1/4 + 2/4, owner-directed 2026-07-21). These two collapsible
          sections surface the underlying evidence layer PILOT computes on:
          canonical facts show WHICH source won on each underwriting value and
          what the status is (verified / disputed / observed / human-confirmed);
          cure proofs show, per condition, exactly which satisfaction
          requirements a submitted document met and which it didn't. Both are
          additive read-only — the classic findings list below still works. */}
      <SovereignCockpit twinFacts={(data && data.twinFacts) || []} cureProofs={(data && data.cureProofs) || []}
        appId={appId} canIssueCerts={canResolve} />

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
          {allFindings.map((f, i) => {
            const key = f.id || `${f.source || 'f'}-${f.code || 'x'}-${i}`;
            const isFocused = focusFindingId && f.id === focusFindingId;
            return (
              <Finding key={key} appId={appId} f={f}
                cardRef={(el) => { if (f.id) findingRefs.current[f.id] = el; }}
                highlighted={isFocused && highlightPulse}
                onChange={load} resolvable={!readOnly && canResolve && !!f.id} canWaive={canWaive}
                canEscalate={!readOnly} escalated={f.id ? (data && data.escalatedFindings && data.escalatedFindings[f.id]) : null} />
            );
          })}
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
