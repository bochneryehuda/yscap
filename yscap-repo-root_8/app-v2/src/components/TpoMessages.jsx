import React, { useEffect, useState } from 'react';
import { api } from '../lib/api.js';
import ChatThread from './ChatThread.jsx';

/* Phase 6e — the broker's Messages panel: the "Broker ↔ Team" conversation on this file. Reuses the
   SAME shared ChatThread the borrower/staff use, with surface='tpo' — firm-scoped and borrower-safe
   (a capital-partner name a staffer types is scrubbed server-side before the broker sees it). The
   conversation id + the broker's own identity both come from the firm-scoped list endpoint, which
   lazily creates the conversation on first open. All text dark on the white canvas. */
export default function TpoMessages({ appId }) {
  const [cid, setCid] = useState(null);
  const [me, setMe] = useState(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState('');

  useEffect(() => {
    let alive = true;
    setLoading(true);
    api.tpoConversations(appId)
      .then((r) => { if (!alive) return; const c = ((r && r.conversations) || [])[0]; setCid(c ? c.id : null); setMe((r && r.me) || null); })
      .catch(() => { if (alive) setErr('Messages are unavailable right now — please try again.'); })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [appId]);

  if (loading) return <div className="muted small">Loading messages…</div>;
  if (err) return <div className="small" style={{ color: 'var(--danger)', fontWeight: 600 }}>{err}</div>;
  if (!cid || !me) return <div className="muted small">Your conversation with the team will appear here once the file is set up.</div>;

  return (
    <div style={{ border: '1px solid var(--line)', borderRadius: 12, overflow: 'hidden' }}>
      <ChatThread conversationId={cid} surface="tpo" me={me} height="58vh" />
    </div>
  );
}
