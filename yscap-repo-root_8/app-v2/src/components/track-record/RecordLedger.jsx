import React from 'react';

/* THE RECORD, AS A LEDGER (mega-workspace phase B/C, owner-directed
   2026-08-09). One scroll, grouped the way the tool has always grouped it —
   Fix & flip / Fix & hold / Ground-up, each with a count — plus the REO band:
   every line that is NOT currently counting toward experience, each carrying
   the REASON it is not. That band is the structural answer to "nothing should
   get lost" (REO is DERIVED, never a fourth deal type — CLAUDE.md 2026-08-09).

   NOTHING HERE DECIDES ANYTHING. Which lines count, and why one does not, is
   read off the track-record-todo endpoint (`todoLines` — the server's own
   LINE_TODO wording, the same rule the sign-off gate uses); with the todo
   unreadable it degrades to "verified = counting" and a generic reason. Every
   action on a row is the SAME handler the flat list carried (request a
   document / raise an issue / post a condition / accept-reject-delete a
   document) — passed in, so this stays a pure arrangement of what existed. */

const INK = '#141B22';
const MUTED = '#4B585C';

function bucketOf(dealType) {
  const s = String(dealType || '').toLowerCase();
  if (s.indexOf('ground') >= 0 || s.indexOf('construction') >= 0) return 'ground';
  if (s.indexOf('flip') >= 0) return 'flip';
  return 'hold';
}
const GROUPS = [
  { key: 'flip', title: 'Fix & flip', sub: 'exit = sale' },
  { key: 'hold', title: 'Fix & hold / rental', sub: 'exit = lease-up or refinance' },
  { key: 'ground', title: 'Ground-up', sub: 'exit = sale, lease-up or refinance' },
];

/* Why a line is in the REO band, in the SERVER's words when it gave any. The
   exit-problem codes come from track-record-todo (EXIT_PROBLEM_MSG family). */
function reoReason(line, todo) {
  const codes = (todo && todo.map((t) => t.code)) || [];
  if (codes.includes('exit_expired')) return 'exit older than 3 years — outside the experience window';
  if (codes.includes('future_exit')) return 'exit date is in the future — counts once it closes';
  if (codes.includes('no_exit')) return 'no completed exit recorded yet';
  if (!line.is_verified) return (line.verification_status || 'pending') === 'limited'
    ? 'public records only — not verified from documents'
    : 'waiting for review — not verified yet';
  return null; // counting
}

export default function RecordLedger({
  lines, docs, todoByLine, busyId, msg, completer, canDelete,
  onRequestDoc, onRaiseIssue, onPostCondition, onReviewDoc,
}) {
  const all = Array.isArray(lines) ? lines : [];
  if (!all.length) return null;
  const waiting = all.filter((t) => !t.is_verified && (t.verification_status || 'pending') !== 'limited').length;

  const rows = all.map((t) => {
    const todo = (todoByLine && todoByLine[String(t.id)]) || null;
    return { t, todo, reo: reoReason(t, todo) };
  });
  const counting = rows.filter((r) => !r.reo);
  const reo = rows.filter((r) => r.reo);

  const line = (r) => {
    const t = r.t;
    const pa = t.property_address || {};
    const addr = pa.oneLine || [pa.line1 || pa.street || pa.address, pa.city, pa.state].filter(Boolean).join(', ') || 'Past project';
    const itemDocs = (docs && docs[t.id]) || [];
    const openReqs = (t.doc_requests || []).filter((rq) => rq && rq.status !== 'satisfied');
    return (
      <div key={t.id} style={{ padding: '5px 0 5px 10px', borderTop: '1px solid rgba(127,169,176,.15)', borderLeft: `3px solid ${r.reo ? 'var(--gold)' : (t.is_verified ? 'var(--teal, #2F7F86)' : 'rgba(127,169,176,.4)')}` }}>
        <div className="row" style={{ gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <span className="small" style={{ flex: 1, minWidth: 160, color: INK }}>{addr}</span>
          {t.owned_personally
            ? <span className="pill small" title="Held under the borrower's personal name — no LLC">Personal name</span>
            : (t.entity_name ? <span className="pill small" title="Entity on record">{t.entity_name}</span> : null)}
          {t.verification_status && <span className="pill small">{t.verification_status}</span>}
          <button className="btn ghost small" disabled={busyId === t.id}
            title="Ask the borrower for a specific document on this past project — it becomes a condition on this file and files into the project's REO folder"
            onClick={() => onRequestDoc(t, addr)}>Request a document</button>
          <button className="btn ghost small" disabled={busyId === t.id}
            title="Flag an internal issue about this past project for the team to review — the borrower is NOT notified and no borrower condition is posted"
            onClick={() => onRaiseIssue(t, addr)}>Raise an issue</button>
          <button className="btn ghost small" disabled={busyId === t.id}
            title="Post a borrower-facing condition on THIS loan about this past project — the borrower is notified"
            onClick={() => onPostCondition(t, addr)}>Post a condition</button>
        </div>
        {r.reo && (
          <div className="small" style={{ color: '#8A6D3B', padding: '1px 0 0 8px' }}>
            Not counting: {r.reo}
          </div>
        )}
        {(r.todo || []).filter((x) => x.code !== 'open_request').slice(0, 2).map((x, i) => (
          <div className="small" key={i} style={{ color: MUTED, padding: '1px 0 0 8px' }}>→ {x.title}</div>
        ))}
        {openReqs.map((rq) => (
          <div className="row" key={rq.id} style={{ gap: 8, alignItems: 'center', flexWrap: 'wrap', padding: '2px 0 2px 18px' }}>
            <span className="small muted" style={{ flex: 1, minWidth: 140 }}>↳ {rq.label}</span>
            <span className="pill small">{rq.status}</span>
          </div>
        ))}
        {itemDocs.map((d) => {
          const rs = d.review_status || 'pending';
          return (
            <div className="row" key={d.id} style={{ gap: 8, alignItems: 'center', flexWrap: 'wrap', padding: '2px 0 2px 18px' }}>
              <span className="small muted" style={{ flex: 1, minWidth: 140, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{d.filename}</span>
              <span className="pill small" style={rs === 'accepted' ? { borderColor: 'var(--ok)', color: 'var(--ok)' } : rs === 'rejected' ? { borderColor: 'var(--danger)', color: 'var(--danger)' } : undefined}>{rs}</span>
              {completer && rs !== 'accepted' && <button className="btn primary small" disabled={busyId === d.id} onClick={() => onReviewDoc(d, 'accept')}>Accept</button>}
              {rs !== 'rejected' && <button className="btn link small" disabled={busyId === d.id} onClick={() => onReviewDoc(d, 'reject')}>Reject</button>}
              {canDelete && <button className="btn link small" style={{ color: 'var(--danger)' }} disabled={busyId === d.id} title="Permanently delete — for a mistake upload (never synced to SharePoint)" onClick={() => onReviewDoc(d, 'delete')}>Delete</button>}
              {rs === 'rejected' && d.rejection_reason && <span className="small" style={{ color: 'var(--danger)', width: '100%', paddingLeft: 18 }}>{d.rejection_reason}</span>}
            </div>
          );
        })}
      </div>
    );
  };

  return (
    <div className="panel" style={{ marginBottom: 12, padding: 10 }}>
      {waiting > 0 && (
        <div className="small" style={{ marginBottom: 8, padding: '6px 10px', borderRadius: 8,
          border: '1px solid var(--gold)', background: 'rgba(174,135,70,.08)', color: INK }}>
          <strong>{waiting} {waiting === 1 ? 'deal is' : 'deals are'} waiting for review.</strong>{' '}
          Nothing counts toward this file&rsquo;s experience until it is verified — read the closing
          statement, deed or lease on each one, then verify it.{' '}
          <a href="#/internal/approvals?tab=track-record">Every borrower&rsquo;s waiting deals →</a>
        </div>
      )}
      <div className="muted small" style={{ marginBottom: 6 }}>
        The record — raise a request against a specific past project and it becomes a named condition on this file.
      </div>
      {msg && <div className="small" style={{ color: 'var(--ok)', marginBottom: 6 }}>{msg}</div>}
      {GROUPS.map((g) => {
        const inGroup = counting.filter((r) => bucketOf(r.t.deal_type) === g.key);
        if (!inGroup.length) return null;
        return (
          <div key={g.key} style={{ marginBottom: 8 }}>
            <div className="small" style={{ fontWeight: 650, color: INK, margin: '6px 0 2px' }}>
              {g.title} <span style={{ color: MUTED, fontWeight: 400 }}>· {inGroup.length} counting · {g.sub}</span>
            </div>
            {inGroup.map(line)}
          </div>
        );
      })}
      {reo.length > 0 && (
        <div style={{ marginTop: 8 }}>
          <div className="small" style={{ fontWeight: 650, color: INK, margin: '6px 0 2px' }}>
            REO / not currently counting <span style={{ color: MUTED, fontWeight: 400 }}>· {reo.length} — each says why; nothing entered is ever lost</span>
          </div>
          {reo.map(line)}
        </div>
      )}
    </div>
  );
}
