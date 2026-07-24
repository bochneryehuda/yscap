import React, { useEffect, useState, useCallback, useRef } from 'react';
import { useLocation } from 'react-router-dom';
import { api } from '../lib/api.js';
import { AppraisalFinding } from './AppraisalPanel.jsx';
import DocCompare from './DocCompare.jsx';
import { useAuth } from '../lib/auth.jsx';

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
  // Investor-specific guideline findings (folded into this ONE review, owner-directed 2026-07-24)
  // carry these sources — label them clearly so they read as "investor-specific" in the one list.
  investor_guideline: 'Investor-specific guideline', investor_guideline_desk: 'Investor-specific guideline',
  investor_guideline_ai: 'Investor-specific guideline (AI)',
};
const label = (t) => DOC_LABEL[t] || String(t || '').replace(/_/g, ' ');

// R4.16 — small local "N minutes ago" formatter (no dep on dayjs).
function fmtAgo(iso) {
  if (!iso) return '';
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return '';
  const sec = Math.max(0, Math.round((Date.now() - t) / 1000));
  if (sec < 60) return `${sec}s ago`;
  const min = Math.round(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.round(min / 60);
  if (hr < 48) return `${hr}h ago`;
  const d = Math.round(hr / 24);
  return `${d}d ago`;
}

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
  const [compare, setCompare] = useState(null); // the "this document vs. that document" side-by-side
  const [escOpen, setEscOpen] = useState(false);
  const [escRole, setEscRole] = useState('super_admin');
  const [escNote, setEscNote] = useState('');
  const [committeeBusy, setCommitteeBusy] = useState(false);
  const [committeeOpinion, setCommitteeOpinion] = useState(null);
  const [simOpen, setSimOpen] = useState(false);
  const [simBusy, setSimBusy] = useState(false);
  const [simRows, setSimRows] = useState(null);
  const [simPicked, setSimPicked] = useState({});
  const [simAction, setSimAction] = useState('dismiss');
  const [simNote, setSimNote] = useState('');
  const [evidence, setEvidence] = useState(null); // R5.17: { loading, spans } | null — grounded quote(s) behind this finding
  const loadEvidence = async () => {
    if (!f.id) return;
    if (evidence) { setEvidence(null); return; }   // toggle closed
    setEvidence({ loading: true, spans: [] });
    try {
      const r = await api.findingEvidence(appId, f.id);
      setEvidence({ loading: false, spans: (r && r.spans) || [] });
    } catch (_e) { setEvidence({ loading: false, spans: [] }); }
  };
  const loadSimilar = async () => {
    if (!f.id) return;
    setSimBusy(true); setSimOpen(true);
    try {
      const r = await api.similarOpenFindings(appId, f.id);
      const rows = (r && r.similar) || [];
      setSimRows(rows);
      const p = {}; for (const s of rows) p[s.id] = true;
      setSimPicked(p);
    } catch (e) { alert('Could not load similar findings: ' + (e && e.message || 'error')); setSimOpen(false); }
    finally { setSimBusy(false); }
  };
  const runBulk = async () => {
    const ids = Object.keys(simPicked).filter(id => simPicked[id]);
    if (!ids.length) { alert('No findings selected.'); return; }
    if (simAction === 'dismiss' && !simNote.trim()) { alert('Please add a dismissal reason.'); return; }
    if (!window.confirm(`${simAction} ${ids.length} finding${ids.length === 1 ? '' : 's'} across other files?`)) return;
    setSimBusy(true);
    try {
      const r = await api.bulkResolveFindings(appId, ids, simAction, simNote);
      alert(`Bulk ${simAction} complete: ${r.resolved || 0} of ${r.allowed || 0} resolved${r.blocked ? ` (${r.blocked} blocked)` : ''}.`);
      setSimOpen(false); setSimRows(null); setSimNote('');
      onChange && onChange();
    } catch (e) { alert(`Could not bulk ${simAction}: ` + (e && e.message || 'error')); }
    finally { setSimBusy(false); }
  };
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
  // Tie-out discrepancies carry the specific conflicting `sources`; when two of
  // them have a real source PDF, offer the side-by-side "this document vs. that
  // document" compare (a single-doc conflict already has "Open the source doc").
  const compareSources = Array.isArray(f.sources) ? f.sources : [];
  const openableCompare = compareSources.filter((s) => s && s.documentId);
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
    // "Fix the file" (needs a value): pre-fill with what the DOCUMENT says (the
    // suggested correction) so the underwriter just confirms; for price / as-is /
    // ARV / rehab budget the server writes it straight onto the loan file.
    if (a.needs === 'value') { setPending(a); setText(docVal != null ? String(docVal) : ''); return; }
    if (a.needs === 'note') { setPending(a); setText(''); return; }
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
        <div style={{ fontSize: 12, margin: '4px 0 6px', display: 'flex', gap: 14, flexWrap: 'wrap' }}>
          <a href="#" onClick={openSourceDoc} style={{ color: 'var(--teal-deep,#256168)', textDecoration: 'underline' }}>
            Open the source document{pageNumber ? ` (page ${pageNumber})` : ''}
          </a>
          <a href="#" onClick={(e) => { e.preventDefault(); loadEvidence(); }} style={{ color: 'var(--teal-deep,#256168)', textDecoration: 'underline' }}>
            {evidence ? 'Hide where we saw this' : 'Where we saw this'}
          </a>
        </div>
      )}
      {evidence && (
        <div style={{ margin: '2px 0 8px' }}>
          {evidence.loading && <div className="muted" style={{ fontSize: 11.5 }}>Loading…</div>}
          {!evidence.loading && evidence.spans.length === 0 && (
            <div className="muted" style={{ fontSize: 11.5 }}>No exact quote was recorded for this finding.</div>
          )}
          {!evidence.loading && evidence.spans.slice(0, 4).map((sp, i) => (
            <div key={i} style={{ fontSize: 11.5, color: 'var(--muted,#4B585C)', borderLeft: '2px solid var(--gold,#AE8746)', paddingLeft: 8, marginTop: 3 }}>
              <span style={{ fontStyle: 'italic', overflowWrap: 'anywhere' }}>“{sp.quote}”</span>
              {sp.pageNumber != null && (
                <span> · {sp.documentId
                  ? <a href={`#/staff/documents/${sp.documentId}`} style={{ color: 'var(--teal-deep,#256168)' }}>page {sp.pageNumber}</a>
                  : `page ${sp.pageNumber}`}</span>
              )}
            </div>
          ))}
        </div>
      )}
      {openableCompare.length >= 2 && (
        <div style={{ fontSize: 12, margin: '4px 0 6px' }}>
          <a href="#" onClick={(e) => { e.preventDefault(); setCompare(compareSources); }}
            style={{ color: 'var(--teal-deep,#256168)', textDecoration: 'underline' }}>
            ⇆ Compare the documents side by side
          </a>
        </div>
      )}
      {compare && <DocCompare title={f.title} field={f.field} sources={compare} onClose={() => setCompare(null)} />}
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
      {resolvable && pending && pending.needs === 'value' && (
        <div style={{ fontSize: 12, color: 'var(--muted,#4B585C)', marginTop: 4 }}>
          A purchase-price, as-is, ARV or rehab-budget correction is written straight onto the loan file (the pricing conditions reopen so it's re-registered). If the file is locked, clear the term-sheet package or unlock it first.
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
          {resolvable && f.id && (
            <button disabled={busy || simBusy} onClick={loadSimilar}
              title="Find every OTHER open finding with the same code across the pipeline and bulk-dismiss or bulk-resolve them"
              style={{ ...btn(), fontSize: 12, padding: '5px 10px' }}>
              🗂 Similar on other files
            </button>
          )}
        </div>
      )}
      {simOpen && (
        <div style={{ marginTop: 10, padding: 10, border: '1px solid var(--paper,#E9E4D3)', borderRadius: 8, background: 'var(--paper,#F6F3EC)' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 6 }}>
            <b style={{ fontSize: 12 }}>Same finding on other files</b>
            <button onClick={() => { setSimOpen(false); setSimRows(null); }} style={{ ...btn(), fontSize: 11, padding: '2px 8px', marginLeft: 'auto' }}>Close</button>
          </div>
          {simBusy && !simRows && <div style={{ fontSize: 12, color: 'var(--muted,#4B585C)' }}>Searching…</div>}
          {simRows && simRows.length === 0 && (
            <div style={{ fontSize: 12, color: 'var(--muted,#4B585C)' }}>Nothing similar found on the visible files.</div>
          )}
          {simRows && simRows.length > 0 && (
            <>
              <div style={{ fontSize: 11, color: 'var(--muted,#4B585C)', marginBottom: 6 }}>Select the findings to act on:</div>
              <div style={{ maxHeight: 220, overflowY: 'auto' }}>
                {simRows.map((r) => (
                  <label key={r.id} style={{ display: 'flex', gap: 6, alignItems: 'flex-start', padding: '3px 0', fontSize: 12, cursor: 'pointer' }}>
                    <input type="checkbox" checked={!!simPicked[r.id]} onChange={(e) => setSimPicked({ ...simPicked, [r.id]: e.target.checked })} />
                    <span style={{ flex: 1 }}>
                      <span style={{ color: 'var(--muted,#4B585C)' }}>{(r.property_address && (r.property_address.line1 || r.property_address.address)) || r.application_id.slice(0, 8)}</span>
                      {' · '}<b>{r.title || r.code}</b>
                      {r.severity && <span style={{ color: (SEV[r.severity] || {}).fg, marginLeft: 4 }}>({(SEV[r.severity] || {}).label})</span>}
                    </span>
                  </label>
                ))}
              </div>
              <div style={{ display: 'flex', gap: 6, marginTop: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                <select value={simAction} onChange={(e) => setSimAction(e.target.value)} style={{ fontSize: 12, padding: '3px 6px' }}>
                  <option value="dismiss">Dismiss</option>
                  <option value="acknowledge">Acknowledge</option>
                  <option value="post_condition">Post condition</option>
                  <option value="request_document">Request document</option>
                  <option value="clear">Clear</option>
                </select>
                <input type="text" placeholder="Note (required for Dismiss)" value={simNote}
                  onChange={(e) => setSimNote(e.target.value)}
                  style={{ flex: 1, minWidth: 200, fontSize: 12, padding: '4px 6px', border: '1px solid var(--paper,#E9E4D3)', borderRadius: 6 }} />
                <button className="btn primary" disabled={simBusy} onClick={runBulk} style={{ fontSize: 11 }}>Apply to {Object.values(simPicked).filter(Boolean).length}</button>
              </div>
            </>
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
// R2.5 — Sovereign authenticity chip styles per level. Chip shows only when
// the score is present AND the score is meaningfully low (medium/low/unreadable).
// A "high" score adds no visual noise — the absence of a chip means the doc
// is clean.
const AUTH_STYLES = {
  high:        null,   // no chip — clean
  medium:      { color: 'var(--amber,#B7791F)', bg: 'var(--amber-bg,#F6EEDD)', label: 'Some tampering signals' },
  low:         { color: 'var(--crit,#B4483C)', bg: 'var(--crit-bg,#F6E7E4)', label: 'Likely tampered' },
  unreadable:  { color: 'var(--muted,#4B585C)', bg: 'var(--paper,#F6F3EC)', label: 'Not readable as PDF' },
};

// The note-buyer "what to look for on this document" checklist, fetched on demand for
// one document type. Advisory guidance from the investor-guideline specs (CorrFirst /
// Blue Lake) — what this note buyer needs confirmed on that kind of document.
function DocReviewGuide({ appId, docType, label, onClose }) {
  const [state, setState] = useState({ loading: true, items: [], noteBuyer: null });
  useEffect(() => {
    let live = true;
    if (!appId || !docType) return undefined;
    api.documentReviewGuide(appId, docType)
      .then((r) => { if (live) setState({ loading: false, items: (r && r.items) || [], noteBuyer: (r && r.noteBuyer) || null }); })
      .catch(() => { if (live) setState({ loading: false, items: [], noteBuyer: null }); });
    return () => { live = false; };
  }, [appId, docType]);
  return (
    <div style={{ marginTop: 10, border: '1px solid var(--gold,#AE8746)', borderRadius: 10, background: 'rgba(174,135,70,.06)', padding: '10px 14px' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
        <span style={{ fontSize: 12.5, fontWeight: 800 }}>What to look for on the {label || String(docType).replace(/_/g, ' ')}</span>
        {state.noteBuyer && <span style={{ fontSize: 11, color: 'var(--muted,#4B585C)' }}>· {state.noteBuyer}</span>}
        <button className="btn ghost small" style={{ marginLeft: 'auto' }} onClick={onClose}>Hide</button>
      </div>
      {state.loading && <div className="muted" style={{ fontSize: 12 }}>Loading…</div>}
      {!state.loading && state.items.length === 0 && (
        <div className="muted" style={{ fontSize: 12 }}>No note-buyer checklist applies to this document type.</div>
      )}
      {!state.loading && state.items.map((it, i) => (
        <div key={i} style={{ marginBottom: 8 }}>
          <div style={{ fontSize: 12.5, fontWeight: 700 }}>{it.condition}{it.noteBuyerSpecific ? <span style={{ fontSize: 10.5, color: 'var(--gold,#AE8746)', fontWeight: 800 }}> · this buyer</span> : null}</div>
          {it.required_evidence && <div style={{ fontSize: 11.5, color: 'var(--muted,#4B585C)', marginTop: 1 }}>{it.required_evidence}</div>}
          {Array.isArray(it.checks) && it.checks.length > 0 && (
            <ul style={{ margin: '4px 0 0', paddingLeft: 18 }}>
              {it.checks.map((c, j) => <li key={j} style={{ fontSize: 11.5, marginBottom: 2 }}>{c}</li>)}
            </ul>
          )}
        </div>
      ))}
    </div>
  );
}

function Completeness({ completeness, documentsOnFile = [], appId = null }) {
  const [openGuideType, setOpenGuideType] = useState(null);
  if (!completeness || !completeness.stipulations || !completeness.stipulations.length) return null;
  const c = completeness;
  // docType -> full doc rows on file, so a stipulation that's "on file" can
  // both name the linked document AND show its authenticity chip.
  const docsByType = {};
  for (const d of documentsOnFile) {
    if (!d || !d.expectedType) continue;
    (docsByType[d.expectedType] = docsByType[d.expectedType] || []).push(d);
  }
  const filesByType = Object.fromEntries(Object.entries(docsByType).map(([t, arr]) => [t, arr.map((d) => d.filename)]));
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
              {appId && (
                <button onClick={() => setOpenGuideType((t) => t === s.docType ? null : s.docType)}
                  style={{ background: 'none', border: 'none', color: 'var(--teal-deep,#256168)', cursor: 'pointer', fontSize: 10.5, padding: '3px 0 0', textDecoration: 'underline' }}>
                  {openGuideType === s.docType ? 'Hide what to check' : 'What to look for'}
                </button>
              )}
              {(filesByType[s.docType] || []).length > 0 && s.status !== 'missing' && (
                <div style={{ fontSize: 10.5, color: 'var(--muted,#4B585C)', marginTop: 4, overflowWrap: 'anywhere' }} title={filesByType[s.docType].join(', ')}>
                  📎 {filesByType[s.docType][0]}{filesByType[s.docType].length > 1 ? ` +${filesByType[s.docType].length - 1}` : ''}
                </div>
              )}
              {(docsByType[s.docType] || []).map((d) => {
                const style = AUTH_STYLES[d.authenticityLevel];
                if (!style) return null;
                const firedSignals = Array.isArray(d.authenticitySignals)
                  ? d.authenticitySignals.filter((sig) => sig && sig.present && sig.weight > 0).map((sig) => sig.name.replace(/_/g, ' ')).slice(0, 4).join(', ')
                  : '';
                const scorePct = d.authenticityScore != null ? Math.round(d.authenticityScore * 100) : null;
                return (
                  <div key={d.documentId} style={{ fontSize: 10.5, marginTop: 4 }}
                    title={firedSignals ? `Signals: ${firedSignals}${scorePct != null ? ` · score ${scorePct}/100` : ''}` : (scorePct != null ? `Authenticity score ${scorePct}/100` : '')}>
                    <span style={{ fontSize: 10, fontWeight: 800, letterSpacing: '.04em', textTransform: 'uppercase', color: style.color, background: style.bg, padding: '2px 6px', borderRadius: 6 }}>
                      ⚠ {style.label}
                    </span>
                  </div>
                );
              })}
            </div>
          );
        })}
      </div>
      {openGuideType && appId && (
        <DocReviewGuide appId={appId} docType={openGuideType}
          label={(c.stipulations.find((s) => s.docType === openGuideType) || {}).label}
          onClose={() => setOpenGuideType(null)} />
      )}
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
function SovereignCockpit({ twinFacts, cureProofs, appId, canIssueCerts, canConfirmFacts }) {
  const [openTwin, setOpenTwin] = useState(false);
  const [openCures, setOpenCures] = useState(false);
  const [expandedFact, setExpandedFact] = useState(null);
  const [factHistory, setFactHistory] = useState({});   // fact_key → { loading, canonical, observations, events }
  const [confirmInputs, setConfirmInputs] = useState({}); // fact_key → { value, reason }
  const [confirmBusy, setConfirmBusy] = useState(null);
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
  const confirmFact = async (factKey) => {
    const inp = confirmInputs[factKey] || {};
    const value = (inp.value || '').trim();
    if (!value) { alert('Enter the value you want to lock in.'); return; }
    setConfirmBusy(factKey);
    try {
      await api.confirmFact(appId, factKey, value, inp.reason || '');
      // Re-load the drilldown so the new event + status show up.
      const d = await api.factHistory(appId, factKey);
      setFactHistory((h) => ({ ...h, [factKey]: { loading: false, ...d } }));
      setConfirmInputs((i) => ({ ...i, [factKey]: { value: '', reason: '' } }));
    } catch (e) { alert(e.message || 'Could not confirm the value.'); }
    finally { setConfirmBusy(null); }
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
                                        {Array.isArray(o.evidenceSpans) && o.evidenceSpans.filter((s) => s && s.quote).slice(0, 3).map((s, si) => (
                                          <div key={si} style={{ marginTop: 3, marginLeft: 20, fontSize: 11.5, color: 'var(--muted,#4B585C)', borderLeft: '2px solid var(--gold,#AE8746)', paddingLeft: 8 }}>
                                            <span style={{ fontStyle: 'italic', overflowWrap: 'anywhere' }}>“{s.quote}”</span>
                                            {s.pageNumber != null && (
                                              <span> · {s.documentId
                                                ? <a href={`#/staff/documents/${s.documentId}`} onClick={(e) => e.stopPropagation()} style={{ color: 'var(--teal-deep,#256168)' }}>page {s.pageNumber}</a>
                                                : `page ${s.pageNumber}`}</span>
                                            )}
                                          </div>
                                        ))}
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
                                {canConfirmFacts && (
                                  <div style={{ padding: '8px 10px', border: '1px dashed var(--line,#E7E1D3)', borderRadius: 8, background: 'var(--card,#fff)' }}>
                                    <div style={{ fontSize: 11, fontWeight: 800, textTransform: 'uppercase', letterSpacing: '.06em', color: '#AE8746', marginBottom: 6 }}>
                                      Lock in the accepted value
                                    </div>
                                    <div className="muted" style={{ fontSize: 11.5, marginBottom: 6 }}>
                                      Overrides the automatic pick. Records your name + reason and stops the reconciler from flipping this value on new sources (until you retract). Best used when the sources disagree and you know which one is right.
                                    </div>
                                    <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
                                      <input placeholder="the value to lock in" className="input" style={{ flex: '1 1 200px', minWidth: 160, fontSize: 12.5 }}
                                        value={(confirmInputs[f.fact_key] || {}).value || ''}
                                        onChange={(e) => setConfirmInputs((i) => ({ ...i, [f.fact_key]: { ...(i[f.fact_key] || {}), value: e.target.value } }))} />
                                      <input placeholder="short reason (optional)" className="input" style={{ flex: '2 1 260px', minWidth: 200, fontSize: 12.5 }}
                                        value={(confirmInputs[f.fact_key] || {}).reason || ''}
                                        onChange={(e) => setConfirmInputs((i) => ({ ...i, [f.fact_key]: { ...(i[f.fact_key] || {}), reason: e.target.value } }))} />
                                      <button disabled={confirmBusy === f.fact_key} onClick={() => confirmFact(f.fact_key)}
                                        style={{ fontSize: 12, padding: '5px 12px', border: '1px solid #AE8746', borderRadius: 6, background: '#AE8746', color: '#fff', cursor: 'pointer' }}>
                                        {confirmBusy === f.fact_key ? 'Locking…' : 'Lock in this value'}
                                      </button>
                                    </div>
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
      {appId && <SovereignAVMSection appId={appId} canRefresh={canIssueCerts} />}
      {appId && <SovereignCertificatesSection appId={appId} canIssue={canIssueCerts} />}
      {appId && <SovereignStructuringSection appId={appId} />}
      {appId && <SovereignAiRiskSection appId={appId} />}
      {appId && <SimilarLoansSection appId={appId} />}
      {appId && <SovereignAiCostSection appId={appId} />}
      {appId && <SovereignKnowledgeGraphSection appId={appId} />}
      {appId && <SovereignAskAdminSection appId={appId} />}
    </div>
  );
}

// R2.2 — AVM Consensus panel. Reads /avm-consensus (which pulls every live
// appraisal.arv observation on the twin, splits AVMs vs the document
// appraisal, computes consensus). Underwriter can trigger a fresh call to
// every configured AVM provider via /verify (fires the hub with kind='avm'
// → feeds api_verification observations → re-analyzes). Empty when no AVMs
// are configured (all three today are stubs).
// #197 — Whole-loan run cockpit. Reads the latest immutable underwriting run
// (schema db/266) and folds it into ONE at-a-glance panel: the current decision
// (status + the three gates term-sheet / clear-to-close / funding), what CHANGED
// since the previous run, the ordered "what to do next" worklist, and the findings
// rolled up by category. READ-ONLY / advisory — it summarizes an already-computed,
// already-persisted run; it runs nothing, decides nothing, and clears no
// condition. A file that has never been run shows a quiet "not run yet" note.
// #136 (R5.39) — Guideline fit panel. Reads /guideline-evaluation (the advisory
// composition layer over the R5.32–39 knowledge graph): per-rule verdicts + plain
// citations for the registered program and any note-buyer investor, plus the
// investor-fit ranking with an "A vs B" differentiator (the exact rules that
// separate one investor from another). READ-ONLY / advisory — it explains the
// frozen guideline baselines against this file; it changes no decision, clears no
// condition, sizes no loan, and touches no frozen number. An unseeded knowledge
// graph shows a quiet "nothing to compare yet" note.
function GuidelineFitPanel({ appId }) {
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [report, setReport] = useState(null);
  const [showContext, setShowContext] = useState(false);
  const [showAllRules, setShowAllRules] = useState(false);
  const load = useCallback(() => {
    if (!appId) return Promise.resolve();
    setLoading(true);
    return api.fileGuidelineEvaluation(appId)
      .then((d) => setReport((d && d.report) || { empty: true, sets: [], fit: { ranked: [], best: null, anyFit: false, comparison: [] } }))
      .catch(() => setReport({ empty: true, sets: [], fit: { ranked: [], best: null, anyFit: false, comparison: [] } }))
      .finally(() => setLoading(false));
  }, [appId]);
  useEffect(() => { if (open && appId) load(); }, [open, appId, load]);

  // Neutral verdict styling. not_applicable rules are never shown.
  const VERDICT = {
    met:           { fg: 'var(--good,#3F7A5B)', bg: 'rgba(63,122,91,.10)', label: 'Meets' },
    violated:      { fg: 'var(--crit,#B4483C)', bg: 'var(--crit-bg,#F6E7E4)', label: 'Does not meet' },
    indeterminate: { fg: 'var(--amber,#B7791F)', bg: 'var(--amber-bg,#F6EEDD)', label: 'Need more info' },
    noted:         { fg: 'var(--muted,#4B585C)', bg: 'var(--paper,#F6F3EC)', label: 'Noted' },
  };
  const verdictChip = (v, excepted) => {
    const s = VERDICT[v] || VERDICT.noted;
    return (
      <span style={{ fontSize: 10.5, fontWeight: 800, color: s.fg, background: s.bg, border: `1px solid ${s.fg}44`, borderRadius: 999, padding: '2px 9px', whiteSpace: 'nowrap' }}>
        {excepted && v === 'violated' ? 'Exception applies' : s.label}
      </span>
    );
  };
  // one plain line for a rule: its reasons (if it doesn't meet) else its recorded requirement.
  const ruleText = (r) => {
    const cit = r && r.citation;
    const reasons = cit && Array.isArray(cit.reasons) ? cit.reasons.filter(Boolean) : [];
    if (reasons.length) return reasons.join('; ');
    if (r && r.outcome != null && typeof r.outcome !== 'object') return String(r.outcome);
    if (r && r.outcome && typeof r.outcome === 'object') {
      const parts = Object.entries(r.outcome).map(([k, v]) => `${k}: ${v}`);
      if (parts.length) return parts.join(', ');
    }
    return r && r.ruleKey ? r.ruleKey : 'Recorded guideline';
  };

  const rpt = report;
  const sets = (rpt && Array.isArray(rpt.sets)) ? rpt.sets : [];
  const fit = (rpt && rpt.fit) || { ranked: [], best: null, anyFit: false, comparison: [] };
  const ranked = Array.isArray(fit.ranked) ? fit.ranked : [];
  const comparison = Array.isArray(fit.comparison) ? fit.comparison : [];
  const ctx = (rpt && rpt.context) || {};
  const ctxKeys = Object.keys(ctx);
  const isEmpty = !rpt || rpt.empty || sets.length === 0;

  return (
    <div style={{ border: '1px solid var(--line,#E7E1D3)', borderRadius: 12, padding: '12px 16px', marginBottom: 18 }}>
      <button onClick={() => setOpen((v) => !v)} style={{ display: 'flex', alignItems: 'center', gap: 8, background: 'none', border: 'none', cursor: 'pointer', padding: 0, textAlign: 'left', width: '100%' }}>
        <span style={{ fontSize: 14, fontWeight: 700 }}>Guideline fit — which program &amp; investor this loan meets, and why</span>
        <span style={{ marginLeft: 'auto', fontSize: 12, color: 'var(--muted,#4B585C)' }}>{open ? 'hide' : 'show'}</span>
      </button>
      {open && (
        <div style={{ marginTop: 12 }}>
          <p style={{ fontSize: 12, color: 'var(--muted,#4B585C)', margin: '0 0 12px' }}>
            How this file measures up against the program and any note-buyer guidelines — rule by rule,
            in plain terms, with the reasons cited. This is a read-out; it decides nothing on its own.
          </p>
          {loading && <div className="muted" style={{ fontSize: 12 }}>Loading…</div>}
          {!loading && isEmpty && (
            <div className="muted" style={{ fontSize: 12.5 }}>
              There are no guideline sets to compare on this file yet. Fit reasoning appears once a program is
              registered and its guideline rules are on file.
            </div>
          )}
          {!loading && !isEmpty && (
            <>
              {/* investor fit — best fit + the ranking */}
              <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 10, marginBottom: 12 }}>
                {fit.anyFit ? (
                  <span style={{ fontSize: 12.5, fontWeight: 800, color: 'var(--good,#3F7A5B)', background: 'rgba(63,122,91,.10)', border: '1px solid var(--good,#3F7A5B)44', borderRadius: 999, padding: '4px 12px' }}>
                    Best fit: {fit.best}
                  </span>
                ) : (
                  <span style={{ fontSize: 12.5, fontWeight: 800, color: 'var(--amber,#B7791F)', background: 'var(--amber-bg,#F6EEDD)', border: '1px solid var(--amber,#B7791F)44', borderRadius: 999, padding: '4px 12px' }}>
                    No clean fit yet
                  </span>
                )}
                {rpt.generatedAt && (
                  <span style={{ marginLeft: 'auto', fontSize: 11, color: 'var(--muted,#4B585C)' }}>as of {fmtAgo(rpt.generatedAt)}</span>
                )}
              </div>

              {ranked.length > 0 && (
                <div style={{ marginBottom: 14 }}>
                  {ranked.map((r, i) => {
                    const fits = r.eligible;
                    const fg = fits ? 'var(--good,#3F7A5B)' : 'var(--crit,#B4483C)';
                    const blockers = Array.isArray(r.blockers) ? r.blockers : [];
                    const notes = Array.isArray(r.notes) ? r.notes : [];
                    return (
                      <div key={i} style={{ padding: '7px 0', borderTop: i === 0 ? 'none' : '1px solid var(--line,#E7E1D3)' }}>
                        <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
                          <span style={{ fontSize: 10.5, fontWeight: 800, color: fg, minWidth: 34 }}>{fits ? 'FITS' : 'FAILS'}</span>
                          <span style={{ fontSize: 13, fontWeight: 700 }}>{r.investor}</span>
                        </div>
                        {blockers.length > 0 && (
                          <ul style={{ margin: '4px 0 0 42px', padding: 0, listStyle: 'disc' }}>
                            {blockers.slice(0, 6).map((b, j) => (
                              <li key={j} style={{ fontSize: 12, color: 'var(--crit,#B4483C)' }}>{b.reason || b.ruleId}</li>
                            ))}
                          </ul>
                        )}
                        {notes.length > 0 && (
                          <ul style={{ margin: '4px 0 0 42px', padding: 0, listStyle: 'disc' }}>
                            {notes.slice(0, 4).map((n, j) => (
                              <li key={j} style={{ fontSize: 11.5, color: 'var(--muted,#4B585C)' }}>{n}</li>
                            ))}
                          </ul>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}

              {/* A vs B differentiators */}
              {comparison.length > 0 && (
                <div style={{ marginBottom: 14 }}>
                  <div style={{ fontSize: 12, fontWeight: 800, textTransform: 'uppercase', letterSpacing: '.05em', color: 'var(--muted,#4B585C)', marginBottom: 6 }}>What separates them</div>
                  {comparison.map((cmp, i) => {
                    const diffs = Array.isArray(cmp.differentiators) ? cmp.differentiators : [];
                    return (
                      <div key={i} style={{ fontSize: 12.5, marginBottom: 8, padding: '8px 12px', background: 'var(--paper,#F6F3EC)', borderRadius: 8, border: '1px solid var(--line,#E7E1D3)' }}>
                        <div style={{ fontWeight: 700, marginBottom: diffs.length ? 4 : 0 }}>{cmp.a} vs {cmp.b}</div>
                        {diffs.length === 0 ? (
                          <div className="muted" style={{ fontSize: 12 }}>Same guideline outcome on this file — nothing separates them.</div>
                        ) : (
                          <ul style={{ margin: 0, paddingLeft: 18 }}>
                            {diffs.map((d, j) => (
                              <li key={j} style={{ fontSize: 12 }}><strong>Only {d.onlyOn}:</strong> {d.reason || d.ruleId}</li>
                            ))}
                          </ul>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}

              {/* per-set rule verdicts + citations */}
              {sets.map((set, si) => {
                const sm = set.summary || {};
                const rules = Array.isArray(set.rules) ? set.rules : [];
                // applicable rules only; violated + indeterminate first (the ones a human needs).
                const applicable = rules.filter((r) => r.applicable && r.verdict !== 'not_applicable');
                const order = { violated: 0, indeterminate: 1, met: 2, noted: 3 };
                const sorted = applicable.slice().sort((a, b) => (order[a.verdict] ?? 4) - (order[b.verdict] ?? 4));
                const primary = sorted.filter((r) => r.verdict === 'violated' || r.verdict === 'indeterminate');
                const rest = sorted.filter((r) => r.verdict === 'met' || r.verdict === 'noted');
                const shown = showAllRules ? sorted : (primary.length ? primary : sorted.slice(0, 4));
                return (
                  <div key={si} style={{ marginBottom: 14 }}>
                    <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, flexWrap: 'wrap', marginBottom: 6 }}>
                      <span style={{ fontSize: 13, fontWeight: 800 }}>{set.label || 'Guideline set'}</span>
                      <span style={{ fontSize: 11.5, fontWeight: 700, color: set.eligible ? 'var(--good,#3F7A5B)' : 'var(--crit,#B4483C)' }}>
                        {set.eligible ? 'Eligible' : `${sm.blockers || 0} blocking`}
                      </span>
                      <span style={{ fontSize: 11, color: 'var(--muted,#4B585C)' }}>
                        {sm.met || 0} meet · {sm.violated || 0} don't · {sm.indeterminate || 0} need info · {sm.noted || 0} noted
                      </span>
                    </div>
                    {shown.length === 0 && (
                      <div className="muted" style={{ fontSize: 12 }}>No rules apply to this file in this set.</div>
                    )}
                    {shown.map((r, ri) => {
                      const cit = r.citation || {};
                      return (
                        <div key={ri} style={{ display: 'flex', alignItems: 'flex-start', gap: 8, padding: '6px 0', borderTop: ri === 0 ? 'none' : '1px solid var(--line,#E7E1D3)' }}>
                          <span style={{ marginTop: 1 }}>{verdictChip(r.verdict, r.excepted)}</span>
                          <div style={{ flex: 1, minWidth: 0 }}>
                            <div style={{ fontSize: 12.5 }}>{ruleText(r)}</div>
                            {cit.citation && (
                              <div style={{ fontSize: 11, color: 'var(--muted,#4B585C)', marginTop: 2 }}>{cit.citation}</div>
                            )}
                          </div>
                        </div>
                      );
                    })}
                    {rest.length > 0 && primary.length > 0 && !showAllRules && (
                      <button onClick={() => setShowAllRules(true)} style={{ background: 'none', border: 'none', color: 'var(--teal,#2F7F86)', cursor: 'pointer', fontSize: 11.5, padding: '4px 0' }}>
                        Show {rest.length} rule{rest.length === 1 ? '' : 's'} this file already meets
                      </button>
                    )}
                  </div>
                );
              })}

              {/* what the check saw — the exact context values, echoed */}
              {ctxKeys.length > 0 && (
                <div style={{ marginTop: 6 }}>
                  <button onClick={() => setShowContext((v) => !v)} style={{ background: 'none', border: 'none', color: 'var(--teal,#2F7F86)', cursor: 'pointer', fontSize: 11.5, padding: 0 }}>
                    {showContext ? 'Hide' : 'Show'} what the check looked at
                  </button>
                  {showContext && (
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 8 }}>
                      {ctxKeys.map((k) => (
                        <span key={k} style={{ fontSize: 11, color: 'var(--muted,#4B585C)', background: 'var(--paper,#F6F3EC)', border: '1px solid var(--line,#E7E1D3)', borderRadius: 6, padding: '2px 8px' }}>
                          {k.replace(/_/g, ' ')}: <strong>{String(ctx[k])}</strong>
                        </span>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}

function WholeLoanRunPanel({ appId }) {
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [cockpit, setCockpit] = useState(null);
  // #179 — "Why this decision?" explanation + findings CSV export.
  const [whyOpen, setWhyOpen] = useState(false);
  const [whyLoading, setWhyLoading] = useState(false);
  const [why, setWhy] = useState(null);
  const [exporting, setExporting] = useState(false);
  const [exportMsg, setExportMsg] = useState(null);
  const load = useCallback(() => {
    if (!appId) return Promise.resolve();
    setLoading(true);
    return api.fileUnderwritingRun(appId)
      .then((d) => setCockpit((d && d.cockpit) || { hasRun: false }))
      .catch(() => setCockpit({ hasRun: false }))
      .finally(() => setLoading(false));
  }, [appId]);
  useEffect(() => { if (open && appId) load(); }, [open, appId, load]);

  const loadWhy = useCallback(() => {
    if (!appId) return Promise.resolve();
    setWhyLoading(true);
    return api.fileUnderwritingWhy(appId)
      .then((d) => setWhy(d && d.hasRun ? (d.explanation || { headline: 'No explanation available.' }) : { empty: true }))
      .catch(() => setWhy({ empty: true }))
      .finally(() => setWhyLoading(false));
  }, [appId]);
  const toggleWhy = useCallback(() => {
    setWhyOpen((v) => { const nv = !v; if (nv && !why) loadWhy(); return nv; });
  }, [why, loadWhy]);

  async function exportCsv() {
    if (exporting) return;
    setExporting(true); setExportMsg(null);
    try { await api.fileUnderwritingFindingsCsv(appId); }
    catch (_e) { setExportMsg('Could not build the findings file.'); setTimeout(() => setExportMsg(null), 6000); }
    finally { setExporting(false); }
  }

  const STATUS_STYLE = {
    ELIGIBLE: { fg: 'var(--good,#3F7A5B)', bg: 'rgba(63,122,91,.10)', label: 'Eligible' },
    MANUAL_APPROVED: { fg: 'var(--good,#3F7A5B)', bg: 'rgba(63,122,91,.10)', label: 'Manually approved' },
    MANUAL_PENDING: { fg: 'var(--amber,#B7791F)', bg: 'var(--amber-bg,#F6EEDD)', label: 'Manual review' },
    NOT_READY: { fg: 'var(--muted,#4B585C)', bg: 'var(--paper,#F6F3EC)', label: 'Not ready' },
    DATA_CONFLICT: { fg: 'var(--amber,#B7791F)', bg: 'var(--amber-bg,#F6EEDD)', label: 'Data conflict' },
    STALE: { fg: 'var(--amber,#B7791F)', bg: 'var(--amber-bg,#F6EEDD)', label: 'Stale — re-run needed' },
    INELIGIBLE: { fg: 'var(--crit,#B4483C)', bg: 'var(--crit-bg,#F6E7E4)', label: 'Ineligible' },
  };
  const gateChip = (label, on) => (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 11.5, fontWeight: 700,
      color: on ? 'var(--good,#3F7A5B)' : 'var(--muted,#4B585C)',
      background: on ? 'rgba(63,122,91,.10)' : 'var(--paper,#F6F3EC)',
      border: `1px solid ${on ? 'rgba(63,122,91,.35)' : 'var(--line,#E7E1D3)'}`,
      borderRadius: 999, padding: '3px 10px' }}>
      {on ? '✓' : '—'} {label}
    </span>
  );
  const c = cockpit;
  const dec = c && c.decision;
  const st = dec && (STATUS_STYLE[dec.status] || { fg: 'var(--muted,#4B585C)', bg: 'var(--paper,#F6F3EC)', label: dec.status || 'Unknown' });

  return (
    <div style={{ border: '1px solid var(--line,#E7E1D3)', borderRadius: 12, padding: '12px 16px', marginBottom: 18 }}>
      <button onClick={() => setOpen((v) => !v)} style={{ display: 'flex', alignItems: 'center', gap: 8, background: 'none', border: 'none', cursor: 'pointer', padding: 0, textAlign: 'left', width: '100%' }}>
        <span style={{ fontSize: 14, fontWeight: 700 }}>Whole-loan underwriting run — where the whole file stands</span>
        <span style={{ marginLeft: 'auto', fontSize: 12, color: 'var(--muted,#4B585C)' }}>{open ? 'hide' : 'show'}</span>
      </button>
      {open && (
        <div style={{ marginTop: 12 }}>
          <p style={{ fontSize: 12, color: 'var(--muted,#4B585C)', margin: '0 0 12px' }}>
            One snapshot of the loan as a whole — the current standing, what changed since the last check,
            what to work next, and the kinds of issues on file. This is a read-out; it decides nothing on its own.
          </p>
          {loading && <div className="muted" style={{ fontSize: 12 }}>Loading…</div>}
          {!loading && (!c || !c.hasRun) && (
            <div className="muted" style={{ fontSize: 12.5 }}>This file hasn't been run through the whole-loan review yet. It runs on its own as documents and terms come in.</div>
          )}
          {!loading && c && c.hasRun && (
            <>
              {/* current standing + the three gates */}
              <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 10, marginBottom: 12 }}>
                {st && (
                  <span style={{ fontSize: 12.5, fontWeight: 800, color: st.fg, background: st.bg, border: `1px solid ${st.fg}44`, borderRadius: 999, padding: '4px 12px' }}>{st.label}</span>
                )}
                {dec && dec.gates && (
                  <>
                    {gateChip('Term sheet', dec.gates.termSheet)}
                    {gateChip('Clear to close', dec.gates.ctc)}
                    {gateChip('Funding', dec.gates.funding)}
                  </>
                )}
                {c.current && c.current.asOf && (
                  <span style={{ marginLeft: 'auto', fontSize: 11, color: 'var(--muted,#4B585C)' }}>as of {fmtAgo(c.current.asOf)}</span>
                )}
              </div>

              {/* #179 — Why this decision? + Export findings (CSV) */}
              <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8, marginBottom: 12 }}>
                <button className="btn ghost small" onClick={toggleWhy}>{whyOpen ? 'Hide why' : 'Why this decision?'}</button>
                <button className="btn ghost small" disabled={exporting} onClick={exportCsv}>{exporting ? 'Preparing…' : 'Export findings (CSV)'}</button>
                {exportMsg && <span style={{ fontSize: 11.5, color: 'var(--crit,#B4483C)' }}>{exportMsg}</span>}
              </div>

              {whyOpen && (
                <div style={{ marginBottom: 14, padding: '10px 14px', background: 'var(--paper,#F6F3EC)', border: '1px solid var(--line,#E7E1D3)', borderRadius: 10 }}>
                  {whyLoading && <div className="muted" style={{ fontSize: 12 }}>Loading…</div>}
                  {!whyLoading && why && why.empty && (
                    <div className="muted" style={{ fontSize: 12.5 }}>No explanation is available for this file yet.</div>
                  )}
                  {!whyLoading && why && !why.empty && (
                    <>
                      {why.headline && <div style={{ fontSize: 13, fontWeight: 700, marginBottom: 6 }}>{why.headline}</div>}
                      {why.plain && why.plain !== why.headline && (
                        <p style={{ fontSize: 12.5, color: 'var(--muted,#4B585C)', margin: '0 0 8px' }}>{why.plain}</p>
                      )}
                      {Array.isArray(why.blockers) && why.blockers.length > 0 && (
                        <div style={{ marginBottom: 8 }}>
                          <div style={{ fontSize: 11, fontWeight: 800, textTransform: 'uppercase', letterSpacing: '.05em', color: 'var(--muted,#4B585C)', marginBottom: 3 }}>What's blocking</div>
                          <ul style={{ margin: 0, paddingLeft: 18 }}>
                            {why.blockers.map((b, i) => (
                              <li key={i} style={{ fontSize: 12, marginBottom: 3 }}>
                                <span style={{ fontWeight: 600 }}>{b.title}</span>
                                {b.howTo && <span style={{ color: 'var(--muted,#4B585C)' }}> — {b.howTo}</span>}
                              </li>
                            ))}
                          </ul>
                        </div>
                      )}
                      {Array.isArray(why.nextSteps) && why.nextSteps.length > 0 && (
                        <div>
                          <div style={{ fontSize: 11, fontWeight: 800, textTransform: 'uppercase', letterSpacing: '.05em', color: 'var(--muted,#4B585C)', marginBottom: 3 }}>What to do next</div>
                          <ul style={{ margin: 0, paddingLeft: 18 }}>
                            {why.nextSteps.map((s, i) => <li key={i} style={{ fontSize: 12, marginBottom: 3 }}>{s}</li>)}
                          </ul>
                        </div>
                      )}
                    </>
                  )}
                </div>
              )}

              {/* what changed since the previous run */}
              {c.diff && c.diff.changed && (
                <div style={{ fontSize: 12.5, marginBottom: 12, padding: '8px 12px', background: 'var(--paper,#F6F3EC)', borderRadius: 8, border: '1px solid var(--line,#E7E1D3)' }}>
                  <span style={{ fontWeight: 700 }}>Since the last check: </span>{c.diff.headline}
                </div>
              )}

              {/* what to do next — the ordered worklist */}
              {c.nextActions && Array.isArray(c.nextActions.actions) && c.nextActions.actions.length > 0 && (
                <div style={{ marginBottom: 14 }}>
                  <div style={{ fontSize: 12, fontWeight: 800, textTransform: 'uppercase', letterSpacing: '.05em', color: 'var(--muted,#4B585C)', marginBottom: 6 }}>What to work next</div>
                  {c.nextActions.actions.slice(0, 8).map((a, i) => (
                    <div key={i} style={{ display: 'flex', alignItems: 'baseline', gap: 8, padding: '5px 0', borderTop: i === 0 ? 'none' : '1px solid var(--line,#E7E1D3)' }}>
                      <span style={{ fontSize: 10.5, fontWeight: 800, minWidth: 62, color: a.blocking ? 'var(--crit,#B4483C)' : (a.overdue ? 'var(--amber,#B7791F)' : 'var(--muted,#4B585C)') }}>
                        {a.blocking ? 'BLOCKING' : (a.overdue ? 'OVERDUE' : (a.kind === 'condition' ? 'CONDITION' : 'REVIEW'))}
                      </span>
                      <span style={{ fontSize: 13, fontWeight: 600 }}>{a.title}</span>
                      <span style={{ fontSize: 11.5, color: 'var(--muted,#4B585C)' }}>{a.why}</span>
                    </div>
                  ))}
                  {c.nextActions.actions.length > 8 && (
                    <div className="muted" style={{ fontSize: 11.5, marginTop: 4 }}>+{c.nextActions.actions.length - 8} more below.</div>
                  )}
                </div>
              )}

              {/* findings rolled up by category */}
              {c.findingsDigest && Array.isArray(c.findingsDigest.categories) && c.findingsDigest.categories.length > 0 && (
                <div>
                  <div style={{ fontSize: 12, fontWeight: 800, textTransform: 'uppercase', letterSpacing: '.05em', color: 'var(--muted,#4B585C)', marginBottom: 6 }}>Issues by kind</div>
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
                    {c.findingsDigest.categories.map((g, i) => {
                      const crit = g.worstSeverity === 'fatal';
                      const warn = g.worstSeverity === 'warning';
                      const fg = crit ? 'var(--crit,#B4483C)' : (warn ? 'var(--amber,#B7791F)' : 'var(--muted,#4B585C)');
                      const bg = crit ? 'var(--crit-bg,#F6E7E4)' : (warn ? 'var(--amber-bg,#F6EEDD)' : 'var(--paper,#F6F3EC)');
                      return (
                        <span key={i} title={g.blocking ? 'Includes a blocking item' : ''} style={{ fontSize: 12, fontWeight: 700, color: fg, background: bg, border: `1px solid ${fg}33`, borderRadius: 8, padding: '4px 10px' }}>
                          {g.label}: {g.count}{g.blocking ? ' ⛔' : ''}
                        </span>
                      );
                    })}
                  </div>
                </div>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}

function SovereignAVMSection({ appId, canRefresh }) {
  const [open, setOpen] = useState(false);
  const [rpt, setRpt] = useState(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState(null);
  const load = () => { setLoading(true); return api.fileAvmConsensus(appId).then((d) => setRpt(d)).catch(() => setRpt({ ok: false })).finally(() => setLoading(false)); };
  useEffect(() => { if (open && appId) load(); /* eslint-disable-next-line */ }, [open, appId]);
  const dollars = (n) => n == null ? '—' : `$${Math.round(Number(n) || 0).toLocaleString('en-US')}`;
  const pct = (r) => r == null ? '' : `${Math.round(Number(r) * 1000) / 10}%`;
  async function verify() {
    setBusy(true); setMsg(null);
    try {
      const r = await api.fileAvmConsensusVerify(appId);
      const okCount = (r.hubResults || []).filter((x) => x.ok).length;
      const skipCount = (r.hubResults || []).filter((x) => x.skipped).length;
      setMsg({ ok: true, text: okCount > 0 ? `${okCount} AVM(s) reported${r.finding ? ' — ' + (r.finding.message || 'disagreement flagged') : '.'}` : (skipCount === (r.hubResults || []).length ? 'No AVM providers configured yet — set at least one vendor key in Render to start getting AVM opinions.' : 'AVM providers unreachable.') });
      await load();
    } catch (e) { setMsg({ ok: false, text: e.message || 'Could not re-check the AVMs.' }); }
    finally { setBusy(false); setTimeout(() => setMsg(null), 8000); }
  }
  const report = rpt && rpt.report;
  const consensus = report && report.consensus;
  const comparison = report && report.comparison;
  const appraisal = report && report.appraisal;
  return (
    <div style={{ padding: '10px 14px', borderTop: '1px solid var(--line,#E7E1D3)' }}>
      <button onClick={() => setOpen((v) => !v)} style={{ display: 'flex', alignItems: 'center', gap: 8, background: 'none', border: 'none', cursor: 'pointer', padding: 0, textAlign: 'left', width: '100%' }}>
        <span style={{ fontSize: 14, fontWeight: 700 }}>Second opinion — Automated valuations vs. the appraisal</span>
        <span style={{ marginLeft: 'auto', fontSize: 12, color: 'var(--muted,#4B585C)' }}>{open ? 'hide' : 'show'}</span>
      </button>
      {open && (
        <div style={{ marginTop: 10 }}>
          <p style={{ fontSize: 12, color: 'var(--muted,#4B585C)', margin: '0 0 10px' }}>
            Independent property-value estimates from HouseCanary, Clear Capital, and ATTOM checked against the file's appraisal. When two or three of them meaningfully disagree with the appraised ARV, a "Panel review" finding is raised so the underwriter sees it before closing. The check runs only if at least one vendor key is set up in the site settings.
          </p>
          {msg && <div className={`notice ${msg.ok ? 'ok' : 'err'}`} style={{ marginBottom: 8, fontSize: 12.5 }}>{msg.text}</div>}
          <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 8 }}>
            <button disabled={busy || !canRefresh} onClick={verify} style={{ fontSize: 12, padding: '5px 10px', border: '1px solid #AE8746', borderRadius: 6, background: '#AE8746', color: '#fff', cursor: 'pointer' }}>
              {busy ? 'Checking…' : 'Get fresh opinions now'}
            </button>
          </div>
          {loading && <div className="muted" style={{ fontSize: 12 }}>Loading…</div>}
          {!loading && !report && <div className="muted" style={{ fontSize: 12 }}>No data yet — this file has no appraisal ARV recorded on the twin.</div>}
          {!loading && report && (
            <>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 10, marginBottom: 12 }}>
                <div style={{ padding: '8px 10px', border: '1px solid var(--line,#E7E1D3)', borderRadius: 8 }}>
                  <div style={{ fontSize: 10.5, fontWeight: 800, textTransform: 'uppercase', letterSpacing: '.06em', color: 'var(--muted,#4B585C)' }}>Appraisal ARV</div>
                  <div style={{ fontSize: 15, fontWeight: 600 }}>{appraisal ? dollars(appraisal.value) : '—'}</div>
                </div>
                <div style={{ padding: '8px 10px', border: '1px solid var(--line,#E7E1D3)', borderRadius: 8 }}>
                  <div style={{ fontSize: 10.5, fontWeight: 800, textTransform: 'uppercase', letterSpacing: '.06em', color: 'var(--muted,#4B585C)' }}>AVM median ({consensus ? consensus.count : 0})</div>
                  <div style={{ fontSize: 15, fontWeight: 600 }}>{consensus ? dollars(consensus.median) : '—'}</div>
                </div>
                <div style={{ padding: '8px 10px', border: `1px solid ${comparison && comparison.disagrees ? 'var(--crit,#B4483C)' : 'var(--line,#E7E1D3)'}`, borderRadius: 8 }}>
                  <div style={{ fontSize: 10.5, fontWeight: 800, textTransform: 'uppercase', letterSpacing: '.06em', color: 'var(--muted,#4B585C)' }}>Delta vs appraisal</div>
                  <div style={{ fontSize: 15, fontWeight: 600, color: comparison && comparison.disagrees ? 'var(--crit,#B4483C)' : 'var(--ivory,#141B22)' }}>
                    {comparison && comparison.diff != null ? (comparison.diff >= 0 ? '+' : '') + dollars(comparison.diff) : '—'}
                    {comparison && comparison.diffPct != null && <span className="muted" style={{ fontSize: 12 }}> · {(comparison.diff >= 0 ? '+' : '')}{pct(comparison.diffPct)}</span>}
                  </div>
                </div>
              </div>
              {comparison && comparison.message && (
                <div style={{ fontSize: 12.5, marginBottom: 10, color: comparison.disagrees ? 'var(--crit,#B4483C)' : 'var(--muted,#4B585C)' }}>{comparison.message}</div>
              )}
              {consensus && consensus.sources && consensus.sources.length > 0 && (
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12.5 }}>
                  <thead>
                    <tr style={{ textAlign: 'left', color: 'var(--muted,#4B585C)' }}>
                      <th style={{ padding: '4px 6px' }}>AVM provider</th>
                      <th style={{ padding: '4px 6px' }}>Their value</th>
                      <th style={{ padding: '4px 6px' }}>Delta vs appraisal</th>
                    </tr>
                  </thead>
                  <tbody>
                    {consensus.sources.map((s, i) => {
                      const d = appraisal && appraisal.value ? s.value - appraisal.value : null;
                      const p = appraisal && appraisal.value ? d / appraisal.value : null;
                      return (
                        <tr key={i} style={{ borderTop: '1px solid var(--line,#E7E1D3)' }}>
                          <td style={{ padding: '5px 6px' }}>{String(s.source_id || '').replace(/_/g, ' ')}</td>
                          <td style={{ padding: '5px 6px' }}>{dollars(s.value)}</td>
                          <td style={{ padding: '5px 6px', color: 'var(--muted,#4B585C)' }}>
                            {d != null ? (d >= 0 ? '+' : '') + dollars(d) : '—'}
                            {p != null && <span> · {(d >= 0 ? '+' : '')}{pct(p)}</span>}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              )}
            </>
          )}
        </div>
      )}
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

// ---------------------------------------------------------------------------
// AI Risk score tile (R4.1). One 0–100 number summarizing every open AI
// suggestion on the file weighted by severity. Silent when the score is 0.
// ---------------------------------------------------------------------------
function SovereignAiRiskSection({ appId }) {
  const [data, setData] = useState(null);
  useEffect(() => {
    if (!appId) return;
    let live = true;
    api.aiRiskScore(appId).then((r) => { if (live) setData(r || null); }).catch(() => setData(null));
    return () => { live = false; };
  }, [appId]);
  if (!data || !data.ok || !(data.score > 0)) return null;
  const tint = data.bucket === 'critical' ? 'var(--crit,#B4483C)'
    : data.bucket === 'elevated' ? 'var(--amber-strong,#A05F0A)'
    : data.bucket === 'moderate' ? 'var(--amber,#B7791F)'
    : 'var(--teal-deep,#256168)';
  const bd = data.breakdown || {};
  return (
    <div style={{ marginTop: 12, border: `1px solid ${tint}`, borderRadius: 10, background: 'var(--card,#fff)', padding: '10px 12px' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
        <div style={{ minWidth: 0 }}>
          <div style={{ fontSize: 11, textTransform: 'uppercase', letterSpacing: '.06em', color: 'var(--muted,#4B585C)', fontWeight: 700 }}>File AI risk score</div>
          <div style={{ fontSize: 13, color: 'var(--ivory,#141B22)', marginTop: 2 }}>
            {bd.fatal > 0 ? `${bd.fatal} fatal` : ''}
            {bd.fatal > 0 && (bd.warning > 0 || bd.info > 0) ? ' · ' : ''}
            {bd.warning > 0 ? `${bd.warning} warning` : ''}
            {bd.warning > 0 && bd.info > 0 ? ' · ' : ''}
            {bd.info > 0 ? `${bd.info} info` : ''}
            {data.oldestFatalDays >= 1 ? ` · oldest fatal ${Math.floor(data.oldestFatalDays)}d` : ''}
          </div>
          {/* R4.19 — one-line triage: the single worst open finding. */}
          {data.topFinding && data.topFinding.title && (
            <div style={{ fontSize: 12.5, color: 'var(--muted,#4B585C)', marginTop: 4, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
              title={data.topFinding.title}>
              <span style={{ fontWeight: 700, color: tint }}>Worst:</span> {data.topFinding.title}
            </div>
          )}
        </div>
        <div style={{ textAlign: 'right', flexShrink: 0 }}>
          <div style={{ fontSize: 26, fontWeight: 800, color: tint, lineHeight: 1 }}>{data.score}</div>
          <div style={{ fontSize: 10, color: tint, textTransform: 'uppercase', letterSpacing: '.06em', fontWeight: 700 }}>{data.bucket}</div>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// R5.55/R5.56 — Underwriting Memory: how this file compares to similar FUNDED
// loans. Silent until there are similar funded files on record. Read-only.
// ---------------------------------------------------------------------------
function SimilarLoansSection({ appId }) {
  const [data, setData] = useState(null);
  useEffect(() => {
    if (!appId) return;
    let live = true;
    api.similarLoans(appId).then((r) => { if (live) setData((r && r.memory) || null); }).catch(() => setData(null));
    return () => { live = false; };
  }, [appId]);
  const m = data && data.summary;
  if (!m || !(m.count > 0)) return null;
  const money = (n) => (n == null ? '—' : '$' + Math.round(n).toLocaleString('en-US'));
  return (
    <div style={{ marginTop: 12, border: '1px solid var(--teal-deep,#256168)', borderRadius: 10, background: 'var(--card,#fff)', padding: '10px 12px' }}>
      <div style={{ fontSize: 11, textTransform: 'uppercase', letterSpacing: '.06em', color: 'var(--teal-deep,#256168)', fontWeight: 700, marginBottom: 4 }}>
        Underwriting memory
      </div>
      <div style={{ fontSize: 13, color: 'var(--ivory,#141B22)' }}>
        This loan is <b>{m.bestMatchPct}%</b> similar to <b>{m.count}</b> previously funded file{m.count === 1 ? '' : 's'}
        {data.totalFunded ? <span style={{ color: 'var(--muted,#4B585C)' }}> (of {data.totalFunded} funded)</span> : null}.
      </div>
      <div style={{ fontSize: 12, color: 'var(--muted,#4B585C)', marginTop: 4, display: 'flex', gap: 14, flexWrap: 'wrap' }}>
        {m.avgConditions != null && <span>Avg conditions: <b style={{ color: 'var(--ivory,#141B22)' }}>{m.avgConditions}</b></span>}
        {m.avgLtvPct != null && <span>Avg LTV: <b style={{ color: 'var(--ivory,#141B22)' }}>{m.avgLtvPct}%</b></span>}
        {m.avgLoanAmount != null && <span>Avg loan: <b style={{ color: 'var(--ivory,#141B22)' }}>{money(m.avgLoanAmount)}</b></span>}
        {m.topInvestor && <span>Most common investor: <b style={{ color: 'var(--ivory,#141B22)', textTransform: 'capitalize' }}>{m.topInvestor.label}</b> ({m.topInvestor.count})</span>}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// AI Cost widget (R3.21, owner-directed 2026-07-22).
// Per-file AI spend + a near-cap warning when > 80% of the configured
// per-file cap. Silent when the cap isn't set.
// ---------------------------------------------------------------------------
function SovereignAiCostSection({ appId }) {
  const [data, setData] = useState(null);
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (!open || !appId) return;
    api.aiCostForFile(appId).then((r) => setData(r || null)).catch(() => setData(null));
  }, [open, appId]);
  const summary = (data && data.summary) || {};
  const usd = summary.usd || '0.00';
  const cap = summary.capUsd;
  const remaining = summary.remainingCents != null ? (summary.remainingCents / 100).toFixed(2) : null;
  const nearCap = cap != null && (Number(summary.cents || 0) / (cap * 100)) > 0.8;
  return (
    <div style={{ marginTop: 12, border: '1px solid var(--paper,#E9E4D3)', borderRadius: 10, background: 'var(--card,#fff)' }}>
      <div onClick={() => setOpen(!open)} style={{ cursor: 'pointer', padding: '8px 12px', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <div>
          <div style={{ fontSize: 11, textTransform: 'uppercase', letterSpacing: '.06em', color: 'var(--muted,#4B585C)', fontWeight: 700 }}>AI spend on this file</div>
          <div style={{ fontSize: 13, fontWeight: 600, color: nearCap ? 'var(--crit,#B4483C)' : 'var(--ivory,#141B22)', marginTop: 2 }}>
            ${usd}{cap != null ? ` / $${cap.toFixed(2)} cap` : ''}
            {nearCap && ' — near the per-file cap'}
          </div>
        </div>
        <div style={{ fontSize: 12, color: 'var(--muted,#4B585C)' }}>{open ? '▾' : '▸'}</div>
      </div>
      {open && data && (
        <div style={{ padding: '8px 12px', borderTop: '1px solid var(--paper,#E9E4D3)' }}>
          <div style={{ fontSize: 12, color: 'var(--muted,#4B585C)', marginBottom: 6 }}>
            {summary.count || 0} AI calls · {summary.tokens || 0} tokens · last {summary.lastAt ? new Date(summary.lastAt).toLocaleString() : 'never'}
          </div>
          {Array.isArray(data.events) && data.events.length > 0 && (
            <div style={{ maxHeight: 220, overflowY: 'auto' }}>
              {data.events.slice(0, 20).map((e, i) => (
                <div key={i} style={{ fontSize: 11, color: 'var(--muted,#4B585C)', padding: '2px 0', borderBottom: '1px dashed var(--paper,#E9E4D3)' }}>
                  {new Date(e.created_at).toLocaleTimeString()} · <b>{e.op_name}</b> · {e.tokens_total} tok · ${(e.cost_cents / 100).toFixed(3)}{!e.ok ? ` · error: ${e.reason || 'unknown'}` : ''}
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Knowledge Graph tile (R3.34) — collapsible portfolio-context tile showing
// this borrower's file count, entities on the borrower, and other files on
// the same borrower. Pure aggregate from the R3.28 knowledge-graph route.
// ---------------------------------------------------------------------------
function SovereignKnowledgeGraphSection({ appId }) {
  const [open, setOpen] = useState(false);
  const [data, setData] = useState(null);
  useEffect(() => {
    if (!open || !appId) return;
    api.fileKnowledgeGraph(appId).then((r) => setData((r && r.graph) || null)).catch(() => setData(null));
  }, [open, appId]);
  const b = data && data.borrower;
  const entities = (data && data.entities) || [];
  const siblings = (data && data.siblingFiles) || [];
  const shared = (data && data.sharedSignals) || [];
  return (
    <div style={{ marginTop: 12, border: '1px solid var(--paper,#E9E4D3)', borderRadius: 10, background: 'var(--card,#fff)' }}>
      <div onClick={() => setOpen(!open)} style={{ cursor: 'pointer', padding: '8px 12px', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <div>
          <div style={{ fontSize: 11, textTransform: 'uppercase', letterSpacing: '.06em', color: 'var(--muted,#4B585C)', fontWeight: 700 }}>Portfolio context for this borrower</div>
          <div style={{ fontSize: 12, color: 'var(--muted,#4B585C)', marginTop: 2 }}>
            {b ? `${b.files_total || 0} total files · ${b.files_12mo || 0} in the last 12 months · ${b.zips_touched || 0} distinct zips` : 'Loading…'}
          </div>
        </div>
        <div style={{ fontSize: 12, color: 'var(--muted,#4B585C)' }}>{open ? '▾' : '▸'}</div>
      </div>
      {open && (
        <div style={{ padding: '8px 12px', borderTop: '1px solid var(--paper,#E9E4D3)' }}>
          {entities.length > 0 && (
            <div style={{ marginBottom: 8 }}>
              <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--ivory,#141B22)', marginBottom: 4 }}>Entities on this borrower</div>
              {entities.map((e) => (
                <div key={e.id} style={{ fontSize: 12, padding: '2px 0' }}>
                  <b>{e.name}</b>{e.state ? ` (${e.state})` : ''} — {e.files_on_entity} file{e.files_on_entity === 1 ? '' : 's'}
                  {e.is_verified && <span style={{ color: 'var(--good,#3F7A5B)' }}> ✓ verified</span>}
                </div>
              ))}
            </div>
          )}
          {siblings.length > 0 && (
            <div style={{ marginBottom: 8 }}>
              <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--ivory,#141B22)', marginBottom: 4 }}>Other files on this borrower</div>
              {siblings.slice(0, 8).map((s) => (
                <div key={s.id} style={{ fontSize: 12, padding: '2px 0' }}>
                  <a href={`#/staff/applications/${s.id}`} style={{ color: 'var(--teal-deep,#256168)' }}>
                    {(s.property_address && (s.property_address.line1 || s.property_address.address)) || s.id.slice(0, 8)}
                  </a>
                  {' · '}<span style={{ color: 'var(--muted,#4B585C)' }}>{s.program || 'no program'} · {s.status}</span>
                </div>
              ))}
              {siblings.length > 8 && <div style={{ fontSize: 11, color: 'var(--muted,#4B585C)' }}>+ {siblings.length - 8} more</div>}
            </div>
          )}
          {shared.length > 0 && (
            <div>
              <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--amber,#B7791F)', marginBottom: 4 }}>Shared signals</div>
              {shared.map((s, i) => (
                <div key={i} style={{ fontSize: 12, padding: '2px 0', color: 'var(--amber,#B7791F)' }}>
                  {s.signal}: {s.files_on_llc} files on this LLC
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Direct "Ask my super-admin about this file" button (R3.22).
// Creates an ai_admin_question tied to this file — the super-admin sees it
// in /internal/ai-inbox and their answer routes back via the learning loop.
// ---------------------------------------------------------------------------
function SovereignAskAdminSection({ appId }) {
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(false);
  const [xdBusy, setXdBusy] = useState(false);
  const [xdRes, setXdRes] = useState(null);
  const ask = async () => {
    const q = window.prompt('What do you want the super-admin to decide about this file?');
    if (!q || !q.trim()) return;
    setBusy(true); setSent(false);
    try {
      await api.askAdminAboutFile(appId, q.trim());
      setSent(true);
      alert('Sent to the super-admin. Their answer will show on this file (AI Findings panel) and in /internal/ai-inbox.');
    } catch (e) { alert(`Could not send: ${(e && e.message) || 'error'}`); }
    finally { setBusy(false); }
  };
  const runXd = async () => {
    if (!window.confirm('Run the deep AI cross-document consistency check on this file? This costs a small amount per run (~$0.05–$0.20).')) return;
    setXdBusy(true); setXdRes(null);
    try {
      const r = await api.aiCrossDocCheck(appId);
      setXdRes(r);
      if (r && r.findings && r.findings.length) {
        alert(`Cross-doc AI check posted ${r.findings.length} finding${r.findings.length === 1 ? '' : 's'} to the AI Findings panel below.`);
      } else if (r && r.ok) {
        alert('Cross-doc AI check found no contradictions across the file.');
      } else {
        alert(`Cross-doc AI check could not run: ${(r && r.reason) || 'unknown'}`);
      }
    } catch (e) { alert(`Cross-doc AI check failed: ${(e && e.message) || 'error'}`); }
    finally { setXdBusy(false); }
  };
  return (
    <div style={{ marginTop: 12, border: '1px dashed var(--paper,#E9E4D3)', borderRadius: 10, background: 'var(--paper,#F6F3EC)', padding: '8px 12px' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <div>
          <div style={{ fontSize: 11, textTransform: 'uppercase', letterSpacing: '.06em', color: 'var(--muted,#4B585C)', fontWeight: 700 }}>Deep AI checks</div>
          <div style={{ fontSize: 12, color: 'var(--muted,#4B585C)', marginTop: 2 }}>
            Ask the super-admin, or run the deep cross-doc consistency check with GPT-5.
            {sent && <span style={{ color: 'var(--good,#3F7A5B)' }}> · Question sent</span>}
            {xdRes && xdRes.ok && <span style={{ color: 'var(--good,#3F7A5B)' }}> · Cross-doc done ({(xdRes.findings || []).length} found)</span>}
          </div>
        </div>
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          <button className="btn ghost" onClick={ask} disabled={busy} style={{ fontSize: 11 }}>{busy ? 'Sending…' : 'Ask super-admin'}</button>
          <button className="btn ghost" onClick={runXd} disabled={xdBusy} style={{ fontSize: 11 }} title="Run GPT-5 cross-document contradiction check">
            {xdBusy ? 'Analyzing…' : '🔍 Deep cross-doc check'}
          </button>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// AI Suggestions Section (R3.5/R3.6, owner-directed 2026-07-22, HARD RULE).
// The AI never writes on a file — every AI agent lands proposals here as
// suggestion rows. A human clicks one of seven actions on each row:
//   Escalate · Add note · Convert to condition · Convert to task ·
//   Mark important · Dismiss (with reason) · Ask super-admin.
// Non-autonomous by design; nothing on this panel changes the file itself
// without a human click, and every action re-loads the panel.
// ---------------------------------------------------------------------------

const SOURCE_LABEL = {
  cure_analysis: 'Condition cure',
  promoted_rules: 'Promoted rule',
  committee: 'Model committee',
  section_1071: 'Section 1071',
  twin_reconcile: 'Loan twin',
  authenticity: 'Doc authenticity',
  entity_chain: 'Entity chain',
  assignment_fraud: 'Assignment fraud',
  wrong_condition: 'Wrong condition',
  ask_admin: 'Ask super-admin',
  splitter: 'Document splitter',
  party_collusion: 'Party conflict',
  double_pledge: 'Double-pledged',
  public_records: 'Public records',
  identity_chain: 'Identity chain',
  independent_verification: 'Independent check',
};
const SOURCE_TINT = {
  cure_analysis: { fg: 'var(--teal-deep,#256168)', bg: 'rgba(47,127,134,.12)' },
  authenticity:  { fg: 'var(--crit,#B4483C)', bg: 'var(--crit-bg,#F6E7E4)' },
  assignment_fraud: { fg: 'var(--crit,#B4483C)', bg: 'var(--crit-bg,#F6E7E4)' },
  entity_chain:  { fg: 'var(--amber,#B7791F)', bg: 'var(--amber-bg,#F6EEDD)' },
  wrong_condition: { fg: 'var(--amber,#B7791F)', bg: 'var(--amber-bg,#F6EEDD)' },
  ask_admin:     { fg: 'var(--teal-deep,#256168)', bg: 'rgba(47,127,134,.12)' },
  splitter:      { fg: 'var(--gold,#AE8746)', bg: 'rgba(174,135,70,.14)' },
  committee:     { fg: 'var(--teal-deep,#256168)', bg: 'rgba(47,127,134,.12)' },
  party_collusion: { fg: 'var(--crit,#B4483C)', bg: 'var(--crit-bg,#F6E7E4)' },
  double_pledge:   { fg: 'var(--crit,#B4483C)', bg: 'var(--crit-bg,#F6E7E4)' },
};

function AISuggestionsSection({ appId, readOnly = false, canResolve = true }) {
  const [rows, setRows] = React.useState(null);
  const [err, setErr] = React.useState('');
  const [busy, setBusy] = React.useState(false);
  const [showDismissed, setShowDismissed] = React.useState(false);
  const [expanded, setExpanded] = React.useState(true);
  const [sourceFilter, setSourceFilter] = React.useState('all');
  const [sevFilter, setSevFilter] = React.useState('all');
  const [lastRerunAt, setLastRerunAt] = React.useState(null);

  const load = React.useCallback(async () => {
    if (!appId) return;
    setBusy(true); setErr('');
    try {
      const r = await api.aiSuggestionsList(appId, showDismissed ? { include_dismissed: '1' } : {});
      setRows(Array.isArray(r && r.suggestions) ? r.suggestions : []);
      setLastRerunAt((r && r.lastRerunAt) || null);
    } catch (e) { setErr((e && e.message) || 'Could not load AI suggestions.'); }
    finally { setBusy(false); }
  }, [appId, showDismissed]);
  React.useEffect(() => { load(); }, [load]);
  // R3.29 — background workers (upload classifier + file-view auto-sync) drop
  // new suggestions here without a manual reload. Gentle 60s poll + on window
  // focus so the panel picks them up on its own. No SSE (would need an auth
  // shim on the SSE endpoint); a 60s tick per open file is fine.
  React.useEffect(() => {
    if (!appId) return;
    const onFocus = () => load();
    const t = setInterval(load, 60000);
    window.addEventListener('focus', onFocus);
    return () => { clearInterval(t); window.removeEventListener('focus', onFocus); };
  }, [appId, load]);

  if (rows == null && !err) return null;
  const openRows = (rows || []).filter((r) => r.status !== 'dismissed');
  const importantCount = openRows.filter((r) => r.important).length;
  const total = openRows.length;

  return (
    <div id="ai-findings" style={{ marginBottom: 22, border: '1px solid var(--paper,#E9E4D3)', borderRadius: 12, background: 'var(--card,#fff)', scrollMarginTop: 80 }}>
      <div onClick={() => setExpanded(!expanded)} style={{ cursor: 'pointer', padding: '10px 14px', borderBottom: expanded ? '1px solid var(--paper,#E9E4D3)' : 'none', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <div>
          <h4 style={{ fontFamily: 'var(--serif,Georgia,serif)', margin: 0, fontSize: 15 }}>
            AI Findings <span style={{ fontSize: 11, color: 'var(--muted,#4B585C)', fontWeight: 400, marginLeft: 6 }}>
              — suggestions only; the AI never changes the file itself
            </span>
          </h4>
          <div style={{ fontSize: 12, color: 'var(--muted,#4B585C)', marginTop: 3 }}>
            {total === 0 ? 'Nothing to review right now.' : `${total} open${importantCount ? ` · ${importantCount} marked important` : ''}`}
            {/* R4.16 — Last re-run stamp, so a re-audit trail is visible on the header. */}
            {lastRerunAt && (
              <span style={{ marginLeft: 8 }}>· Last re-run: {fmtAgo(lastRerunAt)}</span>
            )}
          </div>
        </div>
        <div style={{ fontSize: 12, color: 'var(--muted,#4B585C)' }}>{expanded ? '▾' : '▸'}</div>
      </div>
      {expanded && (
        <div style={{ padding: '10px 14px' }}>
          {err && <div className="error" style={{ marginBottom: 8 }}>{err}</div>}
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10, fontSize: 12, flexWrap: 'wrap' }}>
            <button className="btn ghost" onClick={load} disabled={busy} style={{ padding: '3px 9px', fontSize: 11 }}>{busy ? '…' : '↻ Refresh'}</button>
            {!readOnly && canResolve && (
              <button className="btn ghost" style={{ padding: '3px 9px', fontSize: 11 }} title="Re-run every free AI check (entity chain, bank, bad-clearance, public records, identity chain) on the file's current extractions"
                onClick={async () => {
                  try {
                    const r = await api.aiRerunChecks(appId);
                    const total = Object.values(r.ran || {}).reduce((a, b) => a + (Number(b) || 0), 0);
                    load();
                    alert(total ? `Re-ran AI checks. ${total} new finding${total === 1 ? '' : 's'} posted.` : 'Re-ran AI checks. Nothing new to flag.');
                  } catch (e) { alert(`Failed: ${(e && e.message) || 'error'}`); }
                }}>▶ Re-run checks</button>
            )}
            <label style={{ display: 'inline-flex', alignItems: 'center', gap: 5, color: 'var(--muted,#4B585C)' }}>
              <input type="checkbox" checked={showDismissed} onChange={(e) => setShowDismissed(e.target.checked)} />
              Show dismissed
            </label>
            {(rows || []).some(r => r.status !== 'dismissed') && !readOnly && canResolve && (
              <button className="btn ghost" style={{ padding: '3px 9px', fontSize: 11, color: 'var(--crit,#B4483C)', borderColor: 'var(--crit,#B4483C)' }}
                onClick={async () => {
                  const n = (rows || []).filter(r => r.status !== 'dismissed').length;
                  const reason = window.prompt(`Dismiss all ${n} open AI suggestion${n === 1 ? '' : 's'} on this file? Type a reason (e.g. "test file", "team already reviewed").`, '');
                  if (reason == null) return;
                  try {
                    const r = await api.aiDismissAllOnFile(appId, reason || 'Bulk-dismissed from file view');
                    load();
                    alert(`Dismissed ${r.dismissed} suggestion${r.dismissed === 1 ? '' : 's'}.`);
                  } catch (e) { alert(`Failed: ${(e && e.message) || 'error'}`); }
                }}>Dismiss all</button>
            )}
            {/* R3.37 — filter chips */}
            {(() => {
              const sources = Array.from(new Set((rows || []).map(r => r.source))).sort();
              const sevs = Array.from(new Set((rows || []).map(r => r.severity).filter(Boolean))).sort();
              if (!sources.length) return null;
              return (
                <>
                  <span style={{ color: 'var(--muted,#4B585C)' }}>Filter:</span>
                  <select value={sourceFilter} onChange={(e) => setSourceFilter(e.target.value)} style={{ fontSize: 11, padding: '2px 4px' }}>
                    <option value="all">Any source</option>
                    {sources.map((s) => <option key={s} value={s}>{SOURCE_LABEL[s] || s}</option>)}
                  </select>
                  <select value={sevFilter} onChange={(e) => setSevFilter(e.target.value)} style={{ fontSize: 11, padding: '2px 4px' }}>
                    <option value="all">Any severity</option>
                    {sevs.map((s) => <option key={s} value={s}>{s}</option>)}
                  </select>
                </>
              );
            })()}
          </div>
          {(() => {
            const filtered = (rows || []).filter((r) => (sourceFilter === 'all' || r.source === sourceFilter) && (sevFilter === 'all' || r.severity === sevFilter));
            if (filtered.length === 0 && !busy) {
              return (
                <div style={{ fontSize: 12.5, color: 'var(--muted,#4B585C)', padding: '10px 0' }}>
                  {(rows || []).length ? 'No suggestions match the current filter.' : 'The AI has no suggestions on this file yet. When it reads a document or spots something odd, you\'ll see it here as a suggestion you can act on.'}
                </div>
              );
            }
            return filtered.map((s) => (
              <AISuggestionCard key={s.id} appId={appId} suggestion={s} onChanged={load}
                disabled={readOnly || !canResolve} />
            ));
          })()}
        </div>
      )}
    </div>
  );
}

function AISuggestionCard({ appId, suggestion, onChanged, disabled }) {
  // R4.14 — read role via a light dynamic hook so we don't disrupt the file's
  // existing prop chain. Only super_admin sees the 'Silence code' action.
  const { role } = useAuth();
  const isSuperAdmin = role === 'super_admin';
  const [busy, setBusy] = React.useState(false);
  const [noteOpen, setNoteOpen] = React.useState(false);
  const [noteText, setNoteText] = React.useState('');
  const [dismissOpen, setDismissOpen] = React.useState(false);
  const [dismissReason, setDismissReason] = React.useState('');
  const tint = SOURCE_TINT[suggestion.source] || { fg: 'var(--muted,#4B585C)', bg: 'var(--paper,#F6F3EC)' };
  const sourceLabel = SOURCE_LABEL[suggestion.source] || suggestion.source;
  const evidence = suggestion.evidence || {};
  const pages = Array.isArray(evidence.pages) ? evidence.pages : null;
  const isClosed = suggestion.status !== 'open' && suggestion.status !== 'asked_admin';

  const doAction = React.useCallback(async (action, extra = {}) => {
    if (disabled) return;
    setBusy(true);
    try {
      await api.aiSuggestionsDecide(appId, suggestion.id, { action, ...extra });
      if (onChanged) await onChanged();
    } catch (e) {
      alert(`Could not ${action.replace(/_/g, ' ')}: ${(e && e.message) || 'error'}`);
    } finally { setBusy(false); }
  }, [appId, suggestion.id, disabled, onChanged]);

  const addNote = async () => {
    if (!noteText.trim()) return;
    setBusy(true);
    try {
      await api.aiSuggestionAddNote(appId, suggestion.id, noteText);
      setNoteText(''); setNoteOpen(false);
      if (onChanged) await onChanged();
    } catch (e) { alert(`Could not add note: ${(e && e.message) || 'error'}`); }
    finally { setBusy(false); }
  };

  const askAdmin = async () => {
    const q = window.prompt('What should the super-admin decide?', suggestion.title);
    if (!q || !q.trim()) return;
    setBusy(true);
    try {
      // Ask-admin here just marks the suggestion status; the agent-created question row already
      // exists when the AI itself asked. For a human-initiated ask, POST a note + mark asked.
      await api.aiSuggestionAddNote(appId, suggestion.id, `[asked super-admin] ${q}`);
      await api.aiSuggestionsDecide(appId, suggestion.id, { action: 'ask_admin', reason: q });
      if (onChanged) await onChanged();
    } catch (e) { alert(`Could not ask super-admin: ${(e && e.message) || 'error'}`); }
    finally { setBusy(false); }
  };

  const convertToCondition = async () => {
    const pa = suggestion.proposed_action || {};
    const tplCode = (pa.fields && pa.fields.opensCondition) || pa.templateCode || null;
    if (!tplCode) {
      alert('This suggestion does not name a condition template — decide it another way or ask the super-admin.');
      return;
    }
    if (!window.confirm(`Create the "${tplCode}" condition on this file from this AI suggestion?`)) return;
    await doAction('convert_to_condition', { templateCode: tplCode });
  };

  const convertToTask = async () => {
    const taskId = window.prompt('ClickUp task URL or id to link this suggestion to:');
    if (!taskId || !taskId.trim()) return;
    await doAction('convert_to_task', { taskId: taskId.trim() });
  };

  return (
    <div style={{ border: `1px solid ${tint.fg}33`, borderLeft: `4px solid ${tint.fg}`, borderRadius: 10, padding: '10px 12px', marginBottom: 10, background: isClosed ? 'var(--paper,#F6F3EC)' : 'var(--card,#fff)', opacity: isClosed ? 0.75 : 1 }}>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', marginBottom: 4 }}>
        <span style={{ background: tint.bg, color: tint.fg, fontSize: 10, fontWeight: 800, padding: '2px 7px', borderRadius: 6, textTransform: 'uppercase', letterSpacing: '.05em' }}>{sourceLabel}</span>
        {suggestion.severity && <span style={{ ...(SEV[suggestion.severity] || {}), fontSize: 10, fontWeight: 800, padding: '2px 7px', borderRadius: 6, background: SEV[suggestion.severity] && SEV[suggestion.severity].bg, color: SEV[suggestion.severity] && SEV[suggestion.severity].fg }}>{SEV[suggestion.severity] ? SEV[suggestion.severity].label : suggestion.severity}</span>}
        {suggestion.important && <span style={{ color: 'var(--amber,#B7791F)' }} title="Marked important">★</span>}
        {typeof suggestion.confidence === 'number' && <span style={{ fontSize: 11, color: 'var(--muted,#4B585C)' }}>{Math.round(suggestion.confidence * 100)}% confident</span>}
        <span style={{ fontSize: 11, color: 'var(--muted,#4B585C)', marginLeft: 'auto' }}>{new Date(suggestion.created_at).toLocaleString()}</span>
      </div>
      <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 3 }}>{suggestion.title}</div>
      {suggestion.body && <div style={{ fontSize: 12.5, color: 'var(--ivory,#141B22)', marginBottom: 6, whiteSpace: 'pre-wrap' }}>{suggestion.body}</div>}
      {(pages || evidence.sourceDocumentId || suggestion.document_id || suggestion.trace_url) && (
        <div style={{ fontSize: 11.5, color: 'var(--muted,#4B585C)', marginBottom: 6 }}>
          {(suggestion.document_id || evidence.sourceDocumentId) && (
            <span>Document: <a href={`#/staff/documents/${suggestion.document_id || evidence.sourceDocumentId}`} style={{ color: 'var(--teal-deep,#256168)' }}>open</a>{pages ? ` · page(s) ${pages.join(', ')}` : ''}</span>
          )}
          {suggestion.trace_url && (
            <> · <a href={suggestion.trace_url} target="_blank" rel="noreferrer" style={{ color: 'var(--teal-deep,#256168)' }}>AI reasoning trace →</a></>
          )}
        </div>
      )}
      {Array.isArray(suggestion.notes) && suggestion.notes.length > 0 && (
        <div style={{ borderTop: '1px dashed var(--paper,#E9E4D3)', marginTop: 6, paddingTop: 6, fontSize: 11.5, color: 'var(--muted,#4B585C)' }}>
          {suggestion.notes.map((n, i) => (
            <div key={i}><b>Note</b> {new Date(n.at).toLocaleString()}: {n.text}</div>
          ))}
        </div>
      )}
      {isClosed && (
        <div style={{ fontSize: 11, color: 'var(--muted,#4B585C)', marginTop: 6, fontStyle: 'italic' }}>
          Closed as {suggestion.status.replace(/_/g, ' ')}{suggestion.status_reason ? ` — ${suggestion.status_reason}` : ''}
        </div>
      )}
      {!isClosed && !disabled && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 8 }}>
          <button className="btn ghost" onClick={() => doAction('escalate')} disabled={busy} style={{ fontSize: 11 }}>Escalate</button>
          <button className="btn ghost" onClick={() => setNoteOpen(true)} disabled={busy} style={{ fontSize: 11 }}>Add note</button>
          <button className="btn ghost" onClick={convertToCondition} disabled={busy} style={{ fontSize: 11 }}>Convert to condition</button>
          <button className="btn ghost" onClick={convertToTask} disabled={busy} style={{ fontSize: 11 }}>Convert to task</button>
          <button className="btn ghost" onClick={() => doAction(suggestion.important ? 'unmark_important' : 'mark_important')} disabled={busy} style={{ fontSize: 11 }}>{suggestion.important ? 'Unmark important' : 'Mark important'}</button>
          <button className="btn ghost" onClick={() => setDismissOpen(true)} disabled={busy} style={{ fontSize: 11 }}>Dismiss</button>
          <button className="btn ghost" onClick={askAdmin} disabled={busy} style={{ fontSize: 11 }}>Ask super-admin</button>
          {isSuperAdmin && (suggestion.evidence && suggestion.evidence.code) && (
            <button className="btn ghost" style={{ fontSize: 11, color: 'var(--crit,#B4483C)', borderColor: 'var(--crit,#B4483C)' }}
              onClick={async () => {
                const code = suggestion.evidence.code;
                const reason = window.prompt(`Silence '${code}' portfolio-wide? Every future finding with this code will be dropped before it reaches any file. Type a reason (audited).`, '');
                if (reason == null || !reason.trim()) return;
                try {
                  await api.aiSilencedCodesAdd(code, reason.trim());
                  alert(`Silenced '${code}'. Manage the mute list at /internal/ai-silenced-codes.`);
                } catch (e) { alert(`Failed: ${(e && e.message) || 'error'}`); }
              }}>🔇 Silence code</button>
          )}
        </div>
      )}
      {noteOpen && (
        <div style={{ marginTop: 8 }}>
          <textarea value={noteText} onChange={(e) => setNoteText(e.target.value)} placeholder="A quick note that stays on this suggestion…"
            style={{ width: '100%', minHeight: 60, fontSize: 12, padding: 6, border: '1px solid var(--paper,#E9E4D3)', borderRadius: 6 }} />
          <div style={{ display: 'flex', gap: 6, marginTop: 6 }}>
            <button className="btn primary" onClick={addNote} disabled={busy || !noteText.trim()} style={{ fontSize: 11 }}>Save note</button>
            <button className="btn ghost" onClick={() => { setNoteOpen(false); setNoteText(''); }} style={{ fontSize: 11 }}>Cancel</button>
          </div>
        </div>
      )}
      {dismissOpen && (
        <div style={{ marginTop: 8 }}>
          <input type="text" value={dismissReason} onChange={(e) => setDismissReason(e.target.value)} placeholder="Why are you dismissing this?"
            style={{ width: '100%', fontSize: 12, padding: 6, border: '1px solid var(--paper,#E9E4D3)', borderRadius: 6 }} />
          <div style={{ display: 'flex', gap: 6, marginTop: 6 }}>
            <button className="btn primary" onClick={async () => { await doAction('dismiss', { reason: dismissReason || 'no reason given' }); setDismissOpen(false); setDismissReason(''); }} disabled={busy} style={{ fontSize: 11 }}>Dismiss</button>
            <button className="btn ghost" onClick={() => { setDismissOpen(false); setDismissReason(''); }} style={{ fontSize: 11 }}>Cancel</button>
          </div>
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
  const rootCauses = (data && data.rootCauses) || [];
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

      {/* Major-fraud alert banner (R3.14, owner-directed 2026-07-22).
          When the AI has surfaced a high-confidence fraud/authenticity signal
          on this file, PILOT pins a red banner + admins are silently emailed
          once per signal. This banner is a NOTICE — the AI never blocks the
          file or changes anything on it (HARD RULE). Human decides. */}
      {data && data.fraudBanner && (() => {
        const b = data.fraudBanner;
        const fg = 'var(--crit,#B4483C)';
        const bg = 'var(--crit-bg,#F6E7E4)';
        return (
          <div style={{ border: `2px solid ${fg}`, background: bg, borderRadius: 12, padding: '12px 16px', marginBottom: 18 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
              <span style={{ fontSize: 20 }}>⚠</span>
              <span style={{ fontSize: 11, fontWeight: 800, textTransform: 'uppercase', letterSpacing: '.08em', color: fg }}>Major-fraud alert</span>
            </div>
            <div style={{ fontSize: 14, fontWeight: 700, color: 'var(--ivory,#141B22)', marginBottom: 4 }}>{b.headline}</div>
            {b.signals && b.signals.length > 1 && (
              <ul style={{ margin: '4px 0 0 16px', padding: 0, fontSize: 12, color: 'var(--ivory,#141B22)' }}>
                {b.signals.map((s) => <li key={s.id}>{s.title}</li>)}
              </ul>
            )}
            <div style={{ fontSize: 11, color: 'var(--muted,#4B585C)', marginTop: 6 }}>
              PILOT did NOT change anything on the file. Open the AI Findings panel below to review or dismiss.
            </div>
            <div style={{ display: 'flex', gap: 6, marginTop: 8 }}>
              <button className="btn ghost" style={{ fontSize: 11 }} onClick={async () => {
                const hours = parseInt(window.prompt('Snooze the fraud banner for how many hours? (1–168)', '24') || '', 10);
                if (!(hours >= 1 && hours <= 168)) return;
                try { await api.fraudBannerSnooze(appId, hours); load(); }
                catch (e) { alert(`Snooze failed: ${(e && e.message) || 'error'}`); }
              }}>Snooze banner</button>
              <button className="btn ghost" style={{ fontSize: 11 }} onClick={() => {
                document.querySelector('h4')?.scrollIntoView({ behavior: 'smooth' });
              }}>Open AI Findings panel</button>
            </div>
          </div>
        );
      })()}

      {/* R5.20/R5.24/R5.25 — Root cause: the smallest set of upstream causes
          behind the open findings, each with ONE likely fix. A hypothesis for
          the underwriter — PILOT organizes the findings, it doesn't clear them. */}
      {rootCauses.length > 0 && (
        <div style={{ border: '1px solid var(--gold,#AE8746)', borderRadius: 12, padding: '12px 16px', marginBottom: 18, background: 'rgba(174,135,70,.06)' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
            <span style={{ fontSize: 16 }}>🎯</span>
            <span style={{ fontSize: 11, fontWeight: 800, textTransform: 'uppercase', letterSpacing: '.08em', color: 'var(--gold-deep,#8A6A30)' }}>
              Likely root cause{rootCauses.length > 1 ? 's' : ''}
            </span>
            <span style={{ fontSize: 11, color: 'var(--muted,#4B585C)' }}>— one fix may clear several findings</span>
          </div>
          {rootCauses.map((rc, i) => {
            const tone = rc.severity === 'fatal' ? 'var(--crit,#B4483C)' : rc.severity === 'warning' ? 'var(--amber,#B7791F)' : 'var(--teal-deep,#256168)';
            return (
              <div key={rc.type} style={{ padding: '8px 0', borderTop: i ? '1px dashed var(--paper,#E9E4D3)' : 'none' }}>
                <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
                  <span style={{ fontSize: 12, fontWeight: 700, color: tone, whiteSpace: 'nowrap' }}>
                    {rc.symptomCount} finding{rc.symptomCount === 1 ? '' : 's'}
                  </span>
                  <span style={{ fontSize: 13.5, fontWeight: 600, color: 'var(--ivory,#141B22)' }}>{rc.label}</span>
                </div>
                <div style={{ fontSize: 12.5, color: 'var(--muted,#4B585C)', marginTop: 3 }}>
                  <b style={{ color: 'var(--gold-deep,#8A6A30)' }}>Likely fix:</b> {rc.fix}
                </div>
                {rc.symptoms && rc.symptoms.length > 0 && (
                  <div style={{ fontSize: 11, color: 'var(--muted,#4B585C)', marginTop: 4 }}>
                    Would address: {rc.symptoms.map((s) => s.title || s.code).filter(Boolean).slice(0, 6).join(' · ')}
                  </div>
                )}
              </div>
            );
          })}
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

      {/* Whole-loan run cockpit (#197) — the latest immutable run folded into one
          read-out: current standing + the three gates, what changed since the last
          run, the ordered worklist, and findings by kind. Read-only / advisory. */}
      <WholeLoanRunPanel appId={appId} />

      {/* Guideline fit (#136 / R5.39) — per-rule verdicts + plain citations for the
          registered program and any note-buyer investor, plus the investor-fit
          ranking with an "Investor A vs B" differentiator. Read-only / advisory —
          it explains the frozen guideline baselines against this file. */}
      <GuidelineFitPanel appId={appId} />

      {/* Sovereign Cockpit — Canonical facts (twin) + Condition cure proofs
          (Sovereign 1/4 + 2/4, owner-directed 2026-07-21). These two collapsible
          sections surface the underlying evidence layer PILOT computes on:
          canonical facts show WHICH source won on each underwriting value and
          what the status is (verified / disputed / observed / human-confirmed);
          cure proofs show, per condition, exactly which satisfaction
          requirements a submitted document met and which it didn't. Both are
          additive read-only — the classic findings list below still works. */}
      <SovereignCockpit twinFacts={(data && data.twinFacts) || []} cureProofs={(data && data.cureProofs) || []}
        appId={appId} canIssueCerts={canResolve} canConfirmFacts={canResolve} />

      {/* AI Findings panel (R3.5/R3.6, owner-directed 2026-07-22, HARD RULE). Every
          AI agent posts here — the AI never writes on the file itself. A human
          clicks Escalate / Add note / Convert to condition / Convert to task /
          Mark important / Dismiss / Ask super-admin. */}
      <AISuggestionsSection appId={appId} readOnly={readOnly} canResolve={canResolve} />


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
      <Completeness completeness={completeness} documentsOnFile={documentsOnFile} appId={appId} />

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

