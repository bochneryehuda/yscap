import React, { useEffect, useState } from 'react';
import { api, saveBlob } from '../lib/api.js';
import { useAuth } from '../lib/auth.jsx';
import DocPreview from '../components/DocPreview.jsx';
// Severity words + colours: ONE shared map. Three screens each kept a private copy
// and had already drifted — this one said "Dealbreaker" for the same finding the
// escalations screen called something else. See lib/findings-vocab.js.
import { FINDING_SEVERITY as SEV } from '../lib/findings-vocab.js';

/* The finding-escalation WORKLOAD (owner-directed 2026-07-21, Items 7 + 12;
 * reworked into a full action desk 2026-07-26).
 *
 * When a staffer reviewing PILOT's underwriting findings can't decide one, they
 * ESCALATE it — to a super-admin, a processor, or an underwriter. Each escalation
 * lands here as a work item carrying a direct link to the FILE, the FINDING it's
 * about, the finding's plain-language explanation, and EVERY action the file's own
 * finding card offers.
 *
 * The point of the 2026-07-26 rework: taking an action here resolves the FINDING on
 * the loan file, not just the queue item. Previously the only button was "Mark
 * resolved", which closed this row and left the finding sitting open on the file —
 * the reviewer thought they had handled it and they hadn't.
 *
 * The list is scoped server-side, and so is WHO may act: the server sends `canDecide`
 * per row (a super-admin, the person it was routed to, or any admin / processor /
 * underwriter who signs off conditions on that file) plus `canApplyActions` /
 * `canWaive`, so the UI never shows a button that would be refused.
 */

const money = (v) => (v == null || v === '' || isNaN(Number(v))) ? '—' : '$' + Number(v).toLocaleString('en-US');
const TARGET_LABEL = { super_admin: 'Super-admin', processor: 'Processor', underwriter: 'Underwriter' };
// Clearing a hard, clear-to-close-BLOCKING dealbreaker (grant an exception / clear /
// fix the file / dismiss) needs senior authority (waive_conditions) — mirrors the
// server gate in src/lib/underwriting/exceptions.js and the file's finding card.
const GATE_CLEARING_ACTIONS = new Set(['grant_exception', 'clear', 'fix_file', 'dismiss']);

function fmtAddr(a) {
  if (!a) return '';
  if (typeof a === 'string') return a;
  return [a.line1 || a.address, a.city, a.state].filter(Boolean).join(', ');
}

// Same button styling language the file's finding card uses.
function btn(primary = false, danger = false) {
  return {
    padding: '6px 12px', borderRadius: 8, fontSize: 12.5, fontWeight: 600, cursor: 'pointer',
    border: `1px solid ${danger ? 'var(--crit,#B4483C)' : (primary ? 'var(--teal,#2F7F86)' : 'var(--line,#E7E1D3)')}`,
    background: primary ? 'var(--teal,#2F7F86)' : '#fff',
    color: primary ? '#fff' : (danger ? 'var(--crit,#B4483C)' : '#141B22'),
  };
}

export default function StaffFindingEscalations() {
  const { actor } = useAuth();
  const myId = actor && actor.id;
  const [rows, setRows] = useState([]);
  const [statusFilter, setStatusFilter] = useState('open');
  const [pendingCount, setPendingCount] = useState(0);
  const [canApplyActions, setCanApplyActions] = useState(false);
  const [canWaive, setCanWaive] = useState(false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState(null);
  const [notes, setNotes] = useState({});
  const [pending, setPending] = useState({});   // escalationId -> { action, needs, label, text }
  const [preview, setPreview] = useState(null); // { documentId, page, title } — in-app source-PDF preview

  const flash = (ok, text) => { setMsg({ ok, text }); setTimeout(() => setMsg(null), 9000); };

  const load = () => api.findingEscalations(statusFilter)
    .then((d) => {
      setRows(d.escalations || []);
      setPendingCount(d.pendingCount || 0);
      setCanApplyActions(!!d.canApplyActions);
      setCanWaive(!!d.canWaive);
    })
    .catch((e) => flash(false, e.message || 'could not load the workload'));

  useEffect(() => { load(); /* eslint-disable-next-line */ }, [statusFilter]);

  // 'resolved' = "I've advised, this row is done" — the finding is untouched.
  // 'dismissed' = "no action needed" — that IS a decision about the finding, so the
  // server now settles it for good (owner-reported 2026-07-27: a reviewer said it was
  // fine and the finding came straight back). Report exactly what happened, including
  // the rare case where the reviewer can't close the stored row themselves.
  async function decide(row, decision) {
    setBusy(true);
    try {
      const r = await api.decideFindingEscalation(row.id, decision, notes[row.id] || '');
      if (decision !== 'dismissed') {
        flash(true, 'Closed with your advice. The finding itself was not changed — use one of the actions to clear it off the file.');
      } else if (r && r.findingNote) {
        flash(true, `Closed as no action needed, and it will not be raised again on this file. The finding card itself stayed open: ${r.findingNote}`);
      } else {
        flash(true, 'Closed as no action needed. The finding is cleared off the file and will not come back.');
      }
      await load();
    } catch (e) { flash(false, e.message || 'could not record the decision'); }
    finally { setBusy(false); }
  }

  // Take one of the underwriting actions directly from the queue. ONE server call resolves
  // the finding on the loan file AND closes this row (src/routes/underwriting.js
  // POST /escalations/:id/apply) — no two-step sequence that can half-finish.
  async function applyAction(row, action, extra = {}) {
    const note = extra.note != null ? extra.note : (notes[row.id] || '');
    setBusy(true);
    try {
      const r = await api.applyFindingEscalation(row.id, { action, note, value: extra.value });
      const label = String(action).replace(/_/g, ' ');
      const fixMsg = (r.fileFix && r.fileFix.applied)
        ? ` The loan file's ${String(r.fileFix.field).replace(/_/g, ' ')} was updated to ${r.fileFix.value}.`
        : (r.fileFix && r.fileFix.reason === 'bad-value'
          ? ' Note: the loan file was NOT changed — the value entered wasn’t a number.' : '');
      let head;
      if (r.findingResolved) head = `Applied “${label}” — the finding is closed on the loan file and this item is done.`;
      else if (r.reason === 'stays_open') head = `Applied “${label}” — recorded on the finding, which stays open until the follow-up clears. This item is done.`;
      else if (r.reason === 'derived') head = `Applied “${label}” — this was a cross-document advisory with no stored finding to close, so it is recorded here.`;
      else if (r.reason === 'already_resolved') head = `The finding was already closed on the file — this item is done.`;
      else head = `Applied “${label}”.`;
      flash(true, head + fixMsg + (r.escalationClosed === false ? ' (Someone else had already closed this queue item.)' : ''));
      setPending((p) => { const n = { ...p }; delete n[row.id]; return n; });
      await load();
    } catch (e) { flash(false, e.message || 'could not apply the action'); }
    finally { setBusy(false); }
  }

  // An action that needs a note (post a condition / request a document / grant an exception /
  // decline / severity correction) or a corrected VALUE (fix the file) opens an inline input
  // first — exactly like the finding card on the file.
  function clickAction(row, a) {
    if (a.needs === 'value') {
      const suggested = row.doc_value != null ? String(row.doc_value) : (row.file_value != null ? String(row.file_value) : '');
      setPending((p) => ({ ...p, [row.id]: { ...a, text: suggested } }));
      return;
    }
    if (a.needs === 'note') {
      setPending((p) => ({ ...p, [row.id]: { ...a, text: notes[row.id] || '' } }));
      return;
    }
    if (a.key === 'decline' && !window.confirm('Decline this file on this finding?')) return;
    applyAction(row, a.key);
  }
  function confirmPending(row) {
    const p = pending[row.id];
    if (!p || !String(p.text || '').trim()) return;
    if (p.key === 'decline' && !window.confirm('Decline this file on this finding?')) return;
    applyAction(row, p.key, p.needs === 'value' ? { value: p.text } : { note: p.text });
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
      // Highlight the conflicting value from the document on the page it's on.
      highlight: row.doc_value != null ? String(row.doc_value) : undefined,
    });
  }

  return (
    <div>
      <div className="page-head"><h1>Findings to review</h1></div>
      <p className="muted small" style={{ marginTop: -6, color: 'var(--muted,#4B585C)' }}>
        Underwriting findings a colleague couldn’t decide and sent to you. Each one links to the file and the finding,
        explains what’s wrong, and gives you every action the file’s own review screen gives — taking one here closes
        the finding on the loan file too, not just this list.
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
          // The full action menu comes from the SERVER (the same underwriterActions catalog the
          // file's finding card is decorated with), so this screen never hard-codes a menu and
          // never shows fewer options than the desk.
          const allActions = Array.isArray(r.availableActions) ? r.availableActions : [];
          const isFatalBlocking = r.severity === 'fatal' && r.finding_blocks_ctc !== false;
          const actions = allActions.filter((a) => !(isFatalBlocking && !canWaive && GATE_CLEARING_ACTIONS.has(a.key)));
          const hiddenForWaive = allActions.length - actions.length;
          // Deep-link straight to the finding on the file view: the file page reads ?finding=<id>
          // and scrolls / highlights it. Without a finding_id (derived finding) we fall back to
          // linking to the file overview.
          const fileDeepLink = r.finding_id
            ? `#/internal/app/${r.application_id}?finding=${r.finding_id}`
            : `#/internal/app/${r.application_id}`;
          const pageHint = r.page_number != null ? ` (page ${r.page_number})` : '';
          const p = pending[r.id];
          return (
            <div key={r.id} className="card" style={{ border: '1px solid var(--hairline,#e5e0d5)', borderRadius: 10, padding: 12, marginTop: 12, color: '#141B22' }}>
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
                  {r.how_to && <div style={{ fontSize: 12.5, color: 'var(--muted,#4B585C)', marginTop: 4, whiteSpace: 'pre-wrap' }}>{r.how_to}</div>}
                  {r.question && (
                    <div style={{ fontSize: 12.5, marginTop: 6, padding: '7px 10px', background: 'var(--ink-2,#F4F1EA)', borderRadius: 8, color: '#141B22' }}>
                      <b>What they need:</b> {r.question}
                    </div>
                  )}
                  <div className="muted small" style={{ marginTop: 6, color: 'var(--muted,#4B585C)' }}>
                    Sent to {TARGET_LABEL[r.target_role] || r.target_role}
                    {r.assigned_to_name ? ` (${r.assigned_to_name})` : ''}
                    {r.requested_by_name ? ` · raised by ${r.requested_by_name}` : ''}
                    {r.loan_amount != null ? ` · ${money(r.loan_amount)} loan` : ''}
                  </div>
                  {/* Say plainly whether the FINDING itself is still open — the whole point of
                      the rework is that the two are not the same thing. */}
                  {r.status === 'open' && r.finding_id && r.finding_status && r.finding_status !== 'open' && (
                    <div className="small" style={{ marginTop: 4, color: 'var(--teal-deep,#256168)' }}>
                      The finding itself was already {r.finding_status} on the loan file.
                    </div>
                  )}
                  {r.status === 'open' && !r.finding_id && (
                    <div className="small" style={{ marginTop: 4, color: 'var(--muted,#4B585C)' }}>
                      Cross-document advisory — there is no stored finding to close; fixing the file is what clears it.
                    </div>
                  )}
                </div>
                <span className={`ts-badge ${r.status === 'open' ? 'warn' : r.status === 'resolved' ? 'ok' : ''}`}>{r.status}</span>
              </div>

              {r.status === 'open' && r.canDecide && (
                <>
                  {/* THE ACTIONS — the same set the file's finding card offers. Applying one
                      resolves the finding on the loan file AND closes this queue item. */}
                  {canApplyActions && actions.length > 0 && (
                    <div style={{ marginTop: 10, padding: 10, background: 'var(--paper,#F6F3EC)', borderRadius: 8 }}>
                      <div className="small" style={{ fontWeight: 600, marginBottom: 6, color: '#141B22' }}>
                        Decide it — this closes the finding on the loan file and clears this item:
                      </div>
                      <div className="row" style={{ gap: 6, flexWrap: 'wrap' }}>
                        {actions.map((a) => (
                          <button key={a.key} type="button" title={a.desc} disabled={busy}
                            onClick={() => clickAction(r, a)}
                            style={btn(a.key === 'post_condition' || a.key === 'request_document', a.key === 'decline')}>
                            {a.label}
                          </button>
                        ))}
                      </div>
                      {p && (
                        <div className="row" style={{ gap: 8, marginTop: 10, flexWrap: 'wrap' }}>
                          <input autoFocus className="input" style={{ flex: 1, minWidth: 200 }}
                            value={p.text || ''}
                            onChange={(e) => setPending((s) => ({ ...s, [r.id]: { ...s[r.id], text: e.target.value } }))}
                            onKeyDown={(e) => { if (e.key === 'Enter') confirmPending(r); }}
                            placeholder={p.needs === 'value' ? 'corrected value' : `note — ${String(p.label || '').toLowerCase()}`} />
                          <button type="button" disabled={busy || !String(p.text || '').trim()} onClick={() => confirmPending(r)} style={btn(true)}>{p.label}</button>
                          <button type="button" disabled={busy} onClick={() => setPending((s) => { const n = { ...s }; delete n[r.id]; return n; })} style={btn()}>Cancel</button>
                        </div>
                      )}
                      {p && p.needs === 'value' && (
                        <div className="small" style={{ marginTop: 4, color: 'var(--muted,#4B585C)' }}>
                          A purchase-price, as-is, ARV or rehab-budget correction is written straight onto the loan file (the pricing conditions reopen so it’s re-registered). If the file is locked, clear the term-sheet package or unlock it first.
                        </div>
                      )}
                      {hiddenForWaive > 0 && (
                        <div className="small" style={{ marginTop: 6, color: 'var(--muted,#4B585C)' }}>
                          Clearing this dealbreaker needs an underwriter, processor or admin — those options are hidden for you.
                        </div>
                      )}
                    </div>
                  )}
                  {canApplyActions && actions.length === 0 && allActions.length > 0 && (
                    <div className="small" style={{ marginTop: 8, color: 'var(--muted,#4B585C)' }}>
                      An underwriter, processor or admin can clear this dealbreaker.
                    </div>
                  )}

                  {/* Two closes, and they mean different things. "Close with advice only"
                      leaves the finding exactly as it is. "No action needed" is a decision
                      ABOUT the finding, so it settles it for good — the server records it
                      against the finding's identity so no desk re-raises it (owner-reported
                      2026-07-27: a reviewer said it was fine and it kept coming back). */}
                  <div className="row" style={{ gap: 8, alignItems: 'center', marginTop: 10, flexWrap: 'wrap' }}>
                    <input className="input" style={{ flex: 1, minWidth: 200 }} placeholder="How to proceed / your advice (optional — also used as the note on the action above)"
                      value={notes[r.id] || ''} onChange={(e) => setNotes((n) => ({ ...n, [r.id]: e.target.value }))} />
                    <button className="btn ghost small" disabled={busy} title="Close this item and leave the finding as it is"
                      onClick={() => decide(r, 'resolved')}>Close with advice only</button>
                    <button className="btn ghost small" disabled={busy} title="Close this item and clear the finding off the file for good — it will not be raised again"
                      onClick={() => decide(r, 'dismissed')}>No action needed</button>
                  </div>
                </>
              )}
              {r.status === 'open' && !r.canDecide && (
                <div className="small" style={{ marginTop: 8, color: 'var(--muted,#4B585C)' }}>
                  {r.requested_by && r.requested_by === myId
                    ? 'You raised this one — another reviewer decides it.'
                    : `Waiting on the ${TARGET_LABEL[r.target_role] || r.target_role} to review.`}
                </div>
              )}
              {r.status !== 'open' && (
                <div className="small" style={{ marginTop: 8, color: 'var(--muted,#4B585C)' }}>
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
          highlight={preview.highlight}
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
