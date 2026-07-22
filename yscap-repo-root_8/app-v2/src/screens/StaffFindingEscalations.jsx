import React, { useEffect, useState } from 'react';
import { api, saveBlob } from '../lib/api.js';
import { useAuth } from '../lib/auth.jsx';
import DocPreview from '../components/DocPreview.jsx';

/* The finding-escalation WORKLOAD (owner-directed 2026-07-21, Items 7 + 12).
 *
 * When a staffer reviewing PILOT's underwriting findings can't decide one, they
 * ESCALATE it — to a super-admin, a processor, or an underwriter. Each escalation
 * lands here as a work item carrying a direct link to the FILE, the FINDING it's
 * about, the finding's plain-language explanation, and the framed options the
 * underwriter would normally choose from. The reviewer reads it, advises how to
 * proceed (resolve) or waves it off (dismiss), and it clears.
 *
 * The list is scoped server-side: you see items routed to YOUR role, assigned to
 * YOU, or that YOU raised. A super-admin sees everything and can decide anything.
 */

const money = (v) => (v == null || v === '' || isNaN(Number(v))) ? '—' : '$' + Number(v).toLocaleString('en-US');
const TARGET_LABEL = { super_admin: 'Super-admin', processor: 'Processor', underwriter: 'Underwriter' };
const SEV = {
  fatal: { fg: 'var(--crit,#B4483C)', bg: 'var(--crit-bg,#F6E7E4)', label: 'Dealbreaker' },
  warning: { fg: 'var(--amber,#B7791F)', bg: 'var(--amber-bg,#F6EEDD)', label: 'Warning' },
  info: { fg: 'var(--teal,#2F7F86)', bg: 'rgba(47,127,134,.12)', label: 'Info' },
};
// The framed option verbs → plain labels (mirrors the underwriter action menu).
const ACTION_LABEL = {
  post_condition: 'Post a condition', request_document: 'Request a document', fix_file: 'Fix the file',
  clear: 'Clear (OK)', grant_exception: 'Grant an exception', dismiss: 'Dismiss', decline: 'Decline the file',
  keep: 'Clear (OK)', acknowledge: 'Dismiss', open_condition: 'Post a condition', request_revision: 'Request a document',
};

function fmtAddr(a) {
  if (!a) return '';
  if (typeof a === 'string') return a;
  return [a.line1 || a.address, a.city, a.state].filter(Boolean).join(', ');
}
function actionLabel(a) {
  if (a == null) return null;
  const key = typeof a === 'string' ? a : (a.key || a.label);
  return ACTION_LABEL[key] || (typeof a === 'object' && a.label) || key;
}

export default function StaffFindingEscalations() {
  const { role, actor } = useAuth();
  const myId = actor && actor.id;
  const [rows, setRows] = useState([]);
  const [statusFilter, setStatusFilter] = useState('open');
  const [pendingCount, setPendingCount] = useState(0);
  const [canDecideAll, setCanDecideAll] = useState(false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState(null);
  const [notes, setNotes] = useState({});
  const [preview, setPreview] = useState(null);   // { documentId, page, title } — in-app source-PDF preview

  const flash = (ok, text) => { setMsg({ ok, text }); setTimeout(() => setMsg(null), 7000); };

  const load = () => api.findingEscalations(statusFilter)
    .then((d) => { setRows(d.escalations || []); setPendingCount(d.pendingCount || 0); setCanDecideAll(!!d.canDecideAll); })
    .catch((e) => flash(false, e.message || 'could not load the workload'));

  useEffect(() => { load(); /* eslint-disable-next-line */ }, [statusFilter]);

  async function decide(row, decision) {
    setBusy(true);
    try {
      await api.decideFindingEscalation(row.id, decision, notes[row.id] || '');
      flash(true, decision === 'dismissed' ? 'Marked no action needed.' : 'Marked resolved — the person who raised it was notified.');
      await load();
    } catch (e) { flash(false, e.message || 'could not record the decision'); }
    finally { setBusy(false); }
  }

  // Take one of the FRAMED underwriting actions (Post condition / Grant exception / Request document /
  // Fix file / Dismiss / Clear / Decline) directly from the escalation — the same actions available
  // on the file's own finding card. On success we ALSO mark the escalation resolved so it clears
  // from the queue. Falls back to the file view when the finding has no stored id (a derived / cross-
  // document advisory) — those aren't resolvable via the resolve endpoint.
  async function resolveFinding(row, action) {
    if (!row.finding_id) {
      // Derived finding — cannot be resolved directly. Take the reviewer to the file view instead.
      window.location.hash = `#/internal/app/${row.application_id}?finding=${row.finding_id || ''}`;
      return;
    }
    setBusy(true);
    try {
      const note = notes[row.id] || '';
      const extra = { action };
      // Post-condition / request-document need a note; others accept the reviewer note as advisory.
      if (note) extra.note = note;
      // Two-call sequence, made RETRY-SAFE (owner-directed fix after pre-merge audit 2026-07-21):
      // if a previous attempt already resolved the finding OR closed the escalation, don't error
      // out and leave the queue row stranded — treat those "already done" cases as success and
      // move on to whatever step remains. The endpoints return 404 (finding: not found / already
      // resolved) and 409 (escalation: already decided).
      let alreadyResolved = false;
      try {
        await api.underwritingResolveFinding(row.application_id, row.finding_id, extra);
      } catch (err) {
        const msg = String((err && err.message) || '').toLowerCase();
        const status = err && (err.status || err.statusCode);
        if (status === 404 || /not found|already/i.test(msg)) { alreadyResolved = true; }
        else { throw err; }
      }
      let alreadyDecided = false;
      try {
        await api.decideFindingEscalation(row.id, 'resolved', note || `Applied "${action}" from the queue${alreadyResolved ? ' (finding was already resolved)' : ''}`);
      } catch (err) {
        const msg = String((err && err.message) || '').toLowerCase();
        const status = err && (err.status || err.statusCode);
        if (status === 409 || /already/i.test(msg)) { alreadyDecided = true; }
        else { throw err; }
      }
      flash(true, alreadyResolved
        ? 'The finding was already resolved — queue item closed.'
        : (alreadyDecided
          ? `Applied ${action.replace(/_/g, ' ')} — queue item was already closed.`
          : `Applied ${action.replace(/_/g, ' ')} — the finding is resolved and the person who raised it was notified.`));
      await load();
    } catch (e) { flash(false, e.message || 'could not apply the action'); }
    finally { setBusy(false); }
  }

  // Open the source document (the one the finding was raised from) IN-APP, jumped
  // to the page the finding was raised from — no new tab, no download. DocPreview
  // renders the PDF with PDF.js; the reviewer sees exactly the page in question.
  function openSourceDoc(row) {
    if (!row.document_id) return;
    const base = row.title || row.code || 'Source document';
    setPreview({
      documentId: row.document_id,
      page: row.page_number != null ? Number(row.page_number) : undefined,
      title: `${base}${row.page_number != null ? ` — page ${row.page_number}` : ''}`,
    });
  }

  // May THIS user decide THIS row? A super-admin always; otherwise the person it was routed to
  // (their role or assigned to them) — but NEVER the person who raised it (mirrors the server).
  const canDecide = (r) => canDecideAll || ((r.target_role === role || r.assigned_to === myId) && r.requested_by !== myId);

  return (
    <div>
      <div className="page-head"><h1>Findings to review</h1></div>
      <p className="muted small" style={{ marginTop: -6 }}>
        Underwriting findings a colleague couldn’t decide and sent to you. Each one links to the file and the finding,
        explains what’s wrong, and lists the options — advise how to proceed, then mark it resolved.
      </p>
      {msg && <div className={`notice ${msg.ok ? 'ok' : 'err'}`} style={{ marginBottom: 12 }}>{msg.text}</div>}

      <div className="panel">
        <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center' }}>
          <h3 style={{ margin: 0 }}>Workload {pendingCount > 0 && <span className="ts-badge warn">{pendingCount} open</span>}</h3>
          <div className="row" style={{ gap: 6 }}>
            {['open', 'resolved', 'dismissed', 'all'].map((s) => (
              <button key={s} className={`btn small ${statusFilter === s ? 'primary' : 'ghost'}`} onClick={() => setStatusFilter(s)}>
                {s[0].toUpperCase() + s.slice(1)}
              </button>
            ))}
          </div>
        </div>

        {!rows.length && <p className="muted" style={{ marginTop: 12 }}>No {statusFilter === 'all' ? '' : statusFilter} escalations routed to you.</p>}

        {rows.map((r) => {
          const sev = SEV[r.severity] || SEV.info;
          const actions = Array.isArray(r.suggested_actions) ? r.suggested_actions : [];
          // Deep-link straight to the finding on the file view: the file page reads ?finding=<id>
          // and scrolls / highlights it. Without a finding_id (derived finding) we fall back to
          // linking to the file overview.
          const fileDeepLink = r.finding_id
            ? `#/internal/app/${r.application_id}?finding=${r.finding_id}`
            : `#/internal/app/${r.application_id}`;
          const pageHint = r.page_number != null ? ` (page ${r.page_number})` : '';
          return (
            <div key={r.id} className="card" style={{ border: '1px solid var(--hairline,#e5e0d5)', borderRadius: 10, padding: 12, marginTop: 12 }}>
              <div className="row" style={{ justifyContent: 'space-between', alignItems: 'flex-start', gap: 10 }}>
                <div style={{ minWidth: 0 }}>
                  <div>
                    <a href={fileDeepLink}><strong>{r.ys_loan_number || 'File'}</strong></a>
                    {' · '}{[r.first_name, r.last_name].filter(Boolean).join(' ')}
                    {r.property_address ? ` · ${fmtAddr(r.property_address)}` : ''}
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 6, flexWrap: 'wrap' }}>
                    <span style={{ fontSize: 10.5, fontWeight: 800, letterSpacing: '.04em', textTransform: 'uppercase', color: sev.fg, background: sev.bg, padding: '2px 7px', borderRadius: 6 }}>{sev.label}</span>
                    <strong style={{ fontSize: 14 }}>{r.title || r.code || 'Finding'}</strong>
                  </div>
                  {(r.doc_value != null || r.file_value != null) && (
                    <div style={{ display: 'flex', gap: 20, fontSize: 13, margin: '6px 0', flexWrap: 'wrap' }}>
                      {r.doc_value != null && <span>Document: <b style={{ color: 'var(--teal-deep,#256168)' }}>{String(r.doc_value)}</b></span>}
                      {r.file_value != null && <span>Our file: <b>{String(r.file_value)}</b></span>}
                    </div>
                  )}
                  <div className="row" style={{ gap: 6, margin: '8px 0 2px', flexWrap: 'wrap' }}>
                    {/* Straight to the loan file (no finding anchor) — the owner's
                        "open the loan file directly". */}
                    <a className="btn ghost small" href={`#/internal/app/${r.application_id}`}>Open loan file</a>
                    {/* Straight to THIS finding on the file (scrolls + highlights it).
                        Only when there's a stored finding to anchor to — otherwise the
                        link is identical to "Open loan file" (derived findings). */}
                    {r.finding_id && (
                      <a className="btn ghost small" href={fileDeepLink}>Open the finding on the file</a>
                    )}
                    {/* The source PDF, IN-APP, jumped to the page it was raised from. */}
                    {r.document_id && (
                      <button className="btn ghost small" type="button" onClick={() => openSourceDoc(r)}>
                        Open the source document{pageHint}
                      </button>
                    )}
                  </div>
                  {r.how_to && <div style={{ fontSize: 12.5, color: 'var(--muted,#4B585C)', marginTop: 4 }}>{r.how_to}</div>}
                  {r.question && (
                    <div style={{ fontSize: 12.5, marginTop: 6, padding: '7px 10px', background: 'var(--ink-2,#F4F1EA)', borderRadius: 8, color: 'var(--ivory,#141B22)' }}>
                      <b>What they need:</b> {r.question}
                    </div>
                  )}
                  <div className="muted small" style={{ marginTop: 6 }}>
                    Sent to {TARGET_LABEL[r.target_role] || r.target_role}
                    {r.assigned_to_name ? ` (${r.assigned_to_name})` : ''}
                    {r.requested_by_name ? ` · raised by ${r.requested_by_name}` : ''}
                    {r.loan_amount != null ? ` · ${money(r.loan_amount)} loan` : ''}
                  </div>
                </div>
                <span className={`ts-badge ${r.status === 'open' ? 'warn' : r.status === 'resolved' ? 'ok' : ''}`}>{r.status}</span>
              </div>

              {r.status === 'open' && canDecide(r) && (
                <>
                  <div className="row" style={{ gap: 8, alignItems: 'center', marginTop: 10, flexWrap: 'wrap' }}>
                    <input className="input" style={{ flex: 1, minWidth: 200 }} placeholder="How to proceed / your advice (optional)"
                      value={notes[r.id] || ''} onChange={(e) => setNotes((n) => ({ ...n, [r.id]: e.target.value }))} />
                    <button className="btn primary small" disabled={busy} onClick={() => decide(r, 'resolved')}>Mark resolved</button>
                    <button className="btn ghost small" disabled={busy} onClick={() => decide(r, 'dismissed')}>No action needed</button>
                  </div>
                  {actions.length > 0 && r.finding_id && (
                    <div style={{ marginTop: 10, padding: 10, background: 'var(--paper,#F6F3EC)', borderRadius: 8 }}>
                      <div className="small" style={{ fontWeight: 600, marginBottom: 6 }}>Or take the action directly:</div>
                      <div className="row" style={{ gap: 6, flexWrap: 'wrap' }}>
                        {actions.map((a) => {
                          const key = typeof a === 'string' ? a : (a.key || a.label);
                          const isPrimary = key === 'post_condition' || key === 'request_document' || key === 'open_condition' || key === 'request_revision';
                          const isDanger = key === 'decline';
                          return (
                            <button key={key} className={`btn small ${isPrimary ? 'primary' : (isDanger ? 'ghost' : 'ghost')}`}
                              disabled={busy} onClick={() => {
                                if (isDanger && !window.confirm('Decline this file on this finding?')) return;
                                resolveFinding(r, key);
                              }}>{actionLabel(a)}</button>
                          );
                        })}
                      </div>
                      <div className="muted small" style={{ marginTop: 6 }}>
                        Applying an action here resolves the finding on the file AND closes this queue item — your advice note above is recorded as the decision.
                      </div>
                    </div>
                  )}
                  {actions.length > 0 && !r.finding_id && (
                    <div className="muted small" style={{ marginTop: 8 }}>
                      Options on the desk: {actions.map((a) => actionLabel(a)).filter(Boolean).join(' · ')} — open the file to take one (derived finding, no direct resolve here).
                    </div>
                  )}
                </>
              )}
              {r.status === 'open' && !canDecide(r) && (
                <div className="muted small" style={{ marginTop: 8 }}>Waiting on the {TARGET_LABEL[r.target_role] || r.target_role} to review.</div>
              )}
              {r.status !== 'open' && (
                <div className="muted small" style={{ marginTop: 8 }}>
                  {r.status === 'resolved' ? 'Resolved' : 'Dismissed'}{r.decided_by_name ? ` by ${r.decided_by_name}` : ''}
                  {r.decision_note ? ` — ${r.decision_note}` : ''}
                </div>
              )}
            </div>
          );
        })}
      </div>

      {/* In-app source-PDF preview, opened to the finding's page. Uses the same
          authenticated downloader as the file view; DocPreview handles
          non-PDF/unpreviewable types with its own download card. */}
      {preview && (
        <DocPreview
          key={preview.documentId}
          title={preview.title}
          initialPage={preview.page}
          load={() => api.staffDownloadDoc(preview.documentId)}
          onDownload={async () => {
            try { const { blob, filename } = await api.staffDownloadDoc(preview.documentId); saveBlob(blob, filename); }
            catch (e) { flash(false, e.message || 'could not download the document'); }
          }}
          onClose={() => setPreview(null)}
        />
      )}
    </div>
  );
}
