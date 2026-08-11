import React, { useMemo, useState } from 'react';
import DocumentDossier from './DocumentDossier.jsx';
import { canComplete, canDeleteDoc } from '../lib/condition-actions.js';

/* DOCUMENTS & EXPORTS — the file's document register.
   Owner-directed 2026-08-02: "It just says everywhere 'General upload'. We need
   more detail: what was uploaded, to which condition, what was the purpose, and
   what happened with that document."

   The list now leads with WHAT the document is and WHERE it landed (both come
   from the server's shared `document-dossier` wording, so the row and the
   opened detail can never disagree), groups by that place, and every row opens
   into its full dossier + history.

   TEXT COLOR RULE (session rule): never a `--ink*` token for text — those are
   LIGHT. Primary #141B22, secondary #4B585C. */
const INK = '#141B22';
const MUTED = '#4B585C';

const kb = (n) => (n == null ? '' : n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(0)} KB` : `${(n / 1048576).toFixed(1)} MB`);
const day = (ts) => { const d = new Date(ts); return isNaN(d.getTime()) ? '' : d.toLocaleDateString(); };

/* A document is in the file's TRASH when it was rejected or replaced: kept for
   the record, out of the working set, never part of the TPR export. */
const inTrash = (d) => d.review_status === 'rejected' || d.review_status === 'superseded' || d.is_current === false;

const STATUS_PILL = {
  accepted: { label: 'accepted', style: { borderColor: 'var(--ok)', color: 'var(--ok)' } },
  rejected: { label: 'rejected', style: { borderColor: 'var(--danger)', color: 'var(--danger)' } },
  superseded: { label: 'replaced', style: { opacity: .6 } },
  pending: { label: 'awaiting review', style: { borderColor: 'var(--gold)', color: 'var(--gold-ink)' } },
};

/* The backup state, in one word. `sharepoint_mirror_status` is the explicit
   state machine (db/220); a row that predates it is read off the timestamp. */
function syncChip(d) {
  const raw = String(d.sharepoint_mirror_status || '').toUpperCase();
  const st = raw || (d.sharepoint_backed_up_at ? 'DONE' : 'PENDING');
  const MAP = {
    DONE: ['☁️ backed up', MUTED], PENDING: ['⏳ waiting to back up', MUTED],
    IN_PROGRESS: ['⏳ backing up', MUTED], FAILED: ['⚠️ backup retrying', 'var(--gold)'],
    DEAD: ['⚠️ backup gave up', 'var(--danger)'], SKIPPED: ['⊘ not mirrored', MUTED],
  };
  const [label, color] = MAP[st] || ['', MUTED];
  return label ? <span style={{ fontSize: 11, color }}>{label}</span> : null;
}

const FILTERS = [
  { k: 'working', label: 'Working set', test: (d) => !inTrash(d) },
  { k: 'review', label: 'Awaiting review', test: (d) => !inTrash(d) && (d.review_status || 'pending') === 'pending' },
  { k: 'accepted', label: 'Accepted', test: (d) => d.review_status === 'accepted' && !inTrash(d) },
  { k: 'trash', label: 'Rejected & replaced', test: inTrash },
  { k: 'all', label: 'Everything', test: () => true },
];

export default function DocumentsPanel({ docs, role, dlBusy, onPreview, onDownload, onReview }) {
  const [filter, setFilter] = useState('working');
  const [q, setQ] = useState('');
  const [open, setOpen] = useState(() => new Set());
  const [grouped, setGrouped] = useState(true);

  const toggle = (docId) => setOpen((prev) => {
    const next = new Set(prev);
    if (next.has(docId)) next.delete(docId); else next.add(docId);
    return next;
  });

  const rows = useMemo(() => {
    const f = FILTERS.find((x) => x.k === filter) || FILTERS[0];
    const needle = q.trim().toLowerCase();
    return (docs || []).filter((d) => {
      if (!f.test(d)) return false;
      if (!needle) return true;
      return [d.title, d.filename, d.item_label, d.slot_label, d.where_label, d.uploaded_by_name, d.doc_kind]
        .some((v) => String(v || '').toLowerCase().includes(needle));
    });
  }, [docs, filter, q]);

  // Grouping by WHERE the document landed is the point of the section: it turns
  // a flat pile into "here is everything that answered this condition".
  const groups = useMemo(() => {
    if (!grouped) return [{ key: '', rows }];
    const m = new Map();
    for (const d of rows) {
      const key = d.where_label || 'Filed on the loan';
      if (!m.has(key)) m.set(key, []);
      m.get(key).push(d);
    }
    return [...m.entries()].map(([key, list]) => ({ key, rows: list }));
  }, [rows, grouped]);

  const counts = useMemo(() => {
    const c = {};
    for (const f of FILTERS) c[f.k] = (docs || []).filter(f.test).length;
    return c;
  }, [docs]);

  if (!docs || docs.length === 0) {
    return (
      <div className="panel" style={{ marginTop: 0 }}>
        <div className="row" style={{ marginBottom: 6 }}><h3>Documents</h3></div>
        <p className="muted small">No documents uploaded yet. Request one below and the borrower will see it on their checklist.</p>
      </div>
    );
  }

  const Row = (d) => {
    const rs = d.review_status || 'pending';
    const pill = STATUS_PILL[rs] || STATUS_PILL.pending;
    const tone = rs === 'accepted' ? 'done' : rs === 'rejected' ? '' : 'outstanding';
    const isOpen = open.has(d.id);
    return (
      <div key={d.id} className="checkitem" style={{ alignItems: 'flex-start', flexWrap: 'wrap', opacity: d.is_current === false ? .65 : 1 }}>
        <span className={`dot ${tone}`} style={{ marginTop: 4 }} />
        <div style={{ flex: 1, minWidth: 220 }}>
          {/* WHAT it is — never the old catch-all "General upload". */}
          <div style={{ fontWeight: 600, color: INK }}>
            {d.title || d.item_label || d.filename}
            {d.slot_label && <span style={{ fontWeight: 400, color: MUTED, fontSize: 12 }}> · {d.slot_label}</span>}
            {d.is_current === false && <span style={{ fontWeight: 400, color: MUTED, fontSize: 12 }}> · old version</span>}
          </div>
          {/* WHY it exists — one line, from the same wording the dossier uses. */}
          {d.purpose_headline && (
            <div style={{ color: MUTED, fontSize: 12, marginTop: 1 }}>{d.purpose_headline}</div>
          )}
          {/* WHAT it is, physically, and who put it there. */}
          <div style={{ color: MUTED, fontSize: 12, marginTop: 2 }}>
            {[d.filename, kb(d.size_bytes),
              d.uploaded_by_name ? `uploaded by ${d.uploaded_by_name}` : `uploaded by ${d.uploaded_by_kind || 'unknown'}`,
              day(d.created_at)].filter(Boolean).join(' · ')}
          </div>
          {rs === 'rejected' && d.rejection_reason && (
            <div style={{ color: 'var(--danger)', fontSize: 12, marginTop: 2 }}>Rejected: {d.rejection_reason}</div>
          )}
          {d.reviewed_by_name && (
            <div style={{ color: MUTED, fontSize: 12 }}>
              {rs === 'rejected' ? 'Rejected' : 'Reviewed'} by {d.reviewed_by_name}
            </div>
          )}
          <div className="row" style={{ gap: 8, marginTop: 3, alignItems: 'center', flexWrap: 'wrap' }}>
            {syncChip(d)}
            {d.authenticity_level === 'low' && (
              <span style={{ fontSize: 11, color: 'var(--danger)' }}>🚨 authenticity concerns</span>
            )}
            {d.visibility && d.visibility !== 'borrower' && (
              <span style={{ fontSize: 11, color: MUTED }}>staff only</span>
            )}
            <button type="button" className="btn link small" style={{ padding: 0 }} onClick={() => toggle(d.id)}>
              {isOpen ? 'Hide details & history' : 'Details & history'}
            </button>
          </div>
        </div>
        <div className="row" style={{ gap: 6, alignItems: 'center' }}>
          <span className="pill" style={pill.style}>{pill.label}</span>
          <button className="btn ghost small" title="Preview without downloading" onClick={() => onPreview(d)}>Preview</button>
          <button className="btn ghost small" disabled={dlBusy === d.id} onClick={() => onDownload(d)}>
            {dlBusy === d.id ? '…' : 'Download'}
          </button>
          {d.is_current && rs !== 'accepted' && canComplete(role) && <button className="btn primary small" onClick={() => onReview(d, 'accept')}>Accept</button>}
          {d.is_current && rs !== 'rejected' && <button className="btn ghost small" onClick={() => onReview(d, 'reject')}>Reject</button>}
          {canDeleteDoc(role) && <button className="btn ghost small" style={{ color: 'var(--danger)' }} title="Permanently delete — for a mistake upload (never synced to SharePoint)" onClick={() => onReview(d, 'delete')}>Delete</button>}
        </div>
        {isOpen && <div style={{ flexBasis: '100%' }}><DocumentDossier docId={d.id} /></div>}
      </div>
    );
  };

  return (
    <div className="panel" style={{ marginTop: 0 }}>
      <div className="row" style={{ marginBottom: 8, flexWrap: 'wrap', gap: 8 }}>
        <h3>Documents</h3>
        <div className="spacer" />
        <span style={{ color: MUTED, fontSize: 12 }}>{docs.length} on this file</span>
      </div>

      <div className="row" style={{ gap: 6, flexWrap: 'wrap', marginBottom: 8, alignItems: 'center' }}>
        {FILTERS.map((f) => (
          <button key={f.k} type="button"
            className={`btn small ${filter === f.k ? 'primary' : 'ghost'}`}
            onClick={() => setFilter(f.k)}>
            {f.label}{counts[f.k] ? ` (${counts[f.k]})` : ''}
          </button>
        ))}
        <div className="spacer" />
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search by name, condition or who uploaded it"
          style={{ minWidth: 240, flex: '0 1 320px' }} />
        <label style={{ color: MUTED, fontSize: 12, display: 'inline-flex', gap: 5, alignItems: 'center' }}>
          <input type="checkbox" checked={grouped} onChange={(e) => setGrouped(e.target.checked)} />
          Group by where it was uploaded
        </label>
      </div>

      {rows.length === 0
        ? <p style={{ color: MUTED, fontSize: 13 }}>Nothing matches that.</p>
        : groups.map((g) => (
          <div key={g.key || '_'} style={{ marginBottom: g.key ? 10 : 0 }}>
            {g.key && (
              <div style={{ color: INK, fontWeight: 600, fontSize: 12, margin: '10px 0 2px', paddingBottom: 3, borderBottom: '1px solid var(--line,#EAE4D7)' }}>
                {g.key} <span style={{ color: MUTED, fontWeight: 400 }}>· {g.rows.length}</span>
              </div>
            )}
            {g.rows.map(Row)}
          </div>
        ))}

      {filter !== 'trash' && filter !== 'all' && counts.trash > 0 && (
        <p style={{ color: MUTED, fontSize: 12, marginTop: 10 }}>
          🗑 {counts.trash} rejected / replaced document{counts.trash === 1 ? '' : 's'} are kept for the record and excluded from the TPR export —
          {' '}<button type="button" className="btn link small" style={{ padding: 0 }} onClick={() => setFilter('trash')}>show them</button>.
        </p>
      )}
    </div>
  );
}
