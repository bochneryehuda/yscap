import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ltApi } from './api.js';

/**
 * WHAT WE STILL NEED FROM A LONG-TERM BORROWER, on their own screen.
 *
 * Until this existed a long-term borrower signed in and saw a card with a loan
 * amount on it and nothing else — no conditions, no upload, no way to learn what
 * was outstanding. Every document had to be chased by telephone and email.
 *
 * IT DRAWS ONLY WHAT THE SERVER SENDS. The payload is built FOR a client from a
 * named whitelist (conditions-center/read.js), so there is nothing here that
 * decides what a borrower may see — this file cannot leak a fact it is never
 * handed. In particular there is deliberately NO document list: which copies we
 * hold and who reviewed them is the team's view of their file. What a borrower
 * gets is the count, the state, and — when we send something back — the reason.
 *
 * THE REASON IS THE POINT OF THE REJECTED STATE. A condition that re-opens with
 * no explanation gets the same wrong document uploaded again.
 */

const INK = '#141B22';
const MUTED = '#4B585C';
const GOLD = '#AE8746';
const TEAL = '#2F7F86';

/** Done is done: a satisfied, waived or not-applicable condition needs nothing. */
const DONE = new Set(['satisfied', 'waived', 'not_applicable']);

function StatusPill({ status, needsAttention }) {
  /* SHAPE AND WORD BOTH CHANGE, never colour alone — a borrower reading this on a
     phone in bright sun, or colour-blind, has to be able to tell these apart. */
  const map = {
    satisfied: { text: '✓ Done', bg: '#E6F0F0', fg: '#1F5C62', bd: TEAL },
    waived: { text: '✓ Not needed', bg: '#E6F0F0', fg: '#1F5C62', bd: TEAL },
    not_applicable: { text: '— Not applicable', bg: '#ECEEF0', fg: MUTED, bd: '#D7DBDF' },
    received: { text: '⏳ With us', bg: '#F4F1EA', fg: '#8A6A33', bd: GOLD },
  };
  const fallback = needsAttention
    ? { text: '! Needs your attention', bg: '#FBEDE6', fg: '#8A3A16', bd: '#C4653A' }
    : { text: '○ Still needed', bg: '#F4F1EA', fg: '#8A6A33', bd: GOLD };
  const s = map[status] || fallback;
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center', whiteSpace: 'nowrap',
      background: s.bg, color: s.fg, border: `1px solid ${s.bd}`,
      borderRadius: 999, padding: '3px 10px', fontSize: 12, fontWeight: 600,
    }}>{s.text}</span>
  );
}

function ConditionRow({ loanId, cond, onChanged }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const fileRef = useRef(null);
  const done = DONE.has(String(cond.status));
  const rejected = !!cond.rejectionReason;

  const send = useCallback(async (files) => {
    if (!files || !files.length) return;
    setErr(null);
    setBusy(true);
    let failed = 0;
    for (const file of Array.from(files)) {
      try {
        // THE FILE ITSELF goes on the wire — never a base64 copy of it inside
        // JSON, which is capped far below the size of a phone photograph.
        await ltApi.myConditionDocUpload(loanId, cond.id, {
          file, filename: file.name,
          contentType: file.type || 'application/octet-stream',
        });
      } catch (e) {
        failed += 1;
        setErr((e && e.message) || `Could not send “${file.name}”.`);
      }
    }
    setBusy(false);
    if (failed < Array.from(files).length) onChanged();
  }, [loanId, cond.id, onChanged]);

  return (
    <div className="panel" style={{ marginBottom: 12 }}>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10, alignItems: 'baseline' }}>
        <div style={{ flex: '1 1 18rem', minWidth: 0, fontWeight: 700, color: INK }}>
          {cond.label}
        </div>
        <StatusPill status={cond.status} needsAttention={rejected} />
      </div>

      {cond.hint && (
        <div style={{ color: MUTED, fontSize: 14, marginTop: 6, lineHeight: 1.5 }}>{cond.hint}</div>
      )}

      {rejected && (
        /* WHY IT CAME BACK. Without this the condition simply re-opens and the
           same document is sent again — which is the whole reason this is on a
           client screen at all. */
        <div style={{
          marginTop: 10, padding: '10px 12px', borderRadius: 8,
          background: '#FBEDE6', border: '1px solid #C4653A', color: '#7A3313',
          fontSize: 14, lineHeight: 1.5,
        }}>
          <strong style={{ display: 'block', marginBottom: 2 }}>Please send this again</strong>
          {cond.rejectionReason}
        </div>
      )}

      {cond.documents && cond.documents.total > 0 && (
        <div style={{ color: MUTED, fontSize: 13, marginTop: 8 }}>
          {cond.documents.total === 1 ? '1 document sent' : `${cond.documents.total} documents sent`}
          {cond.documents.accepted > 0 && ` · ${cond.documents.accepted} accepted`}
        </div>
      )}

      {err && (
        <div style={{ marginTop: 8, color: '#8A3A16', fontSize: 13 }}>{err}</div>
      )}

      {!done && (
        <div style={{ marginTop: 12 }}>
          <input
            ref={fileRef} type="file" multiple style={{ display: 'none' }}
            onChange={(e) => { const f = e.target.files; e.target.value = ''; send(f); }}
          />
          <button
            type="button" className="btn"
            disabled={busy}
            onClick={() => fileRef.current && fileRef.current.click()}
          >
            {busy ? 'Sending…' : (cond.documents && cond.documents.total > 0 ? 'Send another' : 'Send a document')}
          </button>
        </div>
      )}
    </div>
  );
}

export default function BorrowerLtConditions({ loanId, onClose }) {
  const [data, setData] = useState(null);
  const [err, setErr] = useState(null);
  const [showDone, setShowDone] = useState(false);

  const load = useCallback(() => {
    if (!loanId) return;
    ltApi.myConditions(loanId)
      .then((d) => { setData(d); setErr(null); })
      /* A FAILED LOAD SAYS SO. Falling back to an empty list would render
         identically to "you have nothing outstanding", which is the one wrong
         thing this screen could tell somebody. */
      .catch((e) => setErr((e && e.message) || 'Could not load this loan just now.'));
  }, [loanId]);

  useEffect(() => { load(); }, [load]);

  const buckets = (data && data.buckets) || [];
  const all = [].concat(...buckets.map((b) => b.conditions || []));
  const open = all.filter((c) => !DONE.has(String(c.status)));
  const shown = showDone ? all : open;

  return (
    <div>
      <div className="row" style={{ marginBottom: 16, flexWrap: 'wrap', gap: 8 }}>
        <div>
          <h2 style={{ margin: 0, color: INK }}>What we still need</h2>
          <p className="muted small" style={{ margin: '4px 0 0' }}>
            {data && data.loan ? `Loan ${data.loan.file}` : 'Your loan'}
          </p>
        </div>
        <div className="spacer" />
        {onClose && (
          <button type="button" className="btn ghost" onClick={onClose}>← All my loans</button>
        )}
      </div>

      {err && <div className="panel" style={{ color: '#8A3A16' }}>{err}</div>}

      {!data && !err && <div className="panel muted">Loading…</div>}

      {data && !err && !all.length && (
        <div className="panel">
          <h3 style={{ marginTop: 0, color: INK }}>Nothing outstanding</h3>
          <p style={{ color: MUTED, margin: 0, lineHeight: 1.55 }}>
            There is nothing for you to send on this loan right now. If we need
            something we will ask for it here.
          </p>
        </div>
      )}

      {data && !err && all.length > 0 && !open.length && !showDone && (
        <div className="panel">
          <h3 style={{ marginTop: 0, color: INK }}>You are all caught up</h3>
          <p style={{ color: MUTED, margin: '0 0 12px', lineHeight: 1.55 }}>
            Everything we asked for is in. Nothing needs your attention.
          </p>
          <button type="button" className="btn ghost" onClick={() => setShowDone(true)}>
            Show what has been sent
          </button>
        </div>
      )}

      {shown.map((c) => (
        <ConditionRow key={c.id} loanId={loanId} cond={c} onChanged={load} />
      ))}

      {data && !err && open.length > 0 && all.length > open.length && (
        <button
          type="button" className="btn ghost" style={{ marginTop: 4 }}
          onClick={() => setShowDone((v) => !v)}
        >
          {showDone ? 'Hide what is already done' : `Show ${all.length - open.length} already done`}
        </button>
      )}
    </div>
  );
}
