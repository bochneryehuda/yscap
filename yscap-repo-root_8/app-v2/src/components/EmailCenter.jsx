import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../lib/api.js';

/* ════════════════════════════════════════════════════════════════════════════
   EMAIL CENTER — a Gmail/Outlook-style history of every email + notification that
   went out (or came in) for a loan file. Two modes:
     · mode="file"   — one file's whole thread history, with a reply box
     · mode="global" — every email across the files the viewer can see (admins:
       all; officers/processors: their assigned files), with search + filters
   The full designed email body renders in a sandboxed iframe (scripts disabled)
   exactly like a real mail client, so a branded outbound email looks like the
   real thing and an external reply is safely isolated.
   ════════════════════════════════════════════════════════════════════════════ */

function when(ts, long) {
  if (!ts) return '';
  const d = new Date(ts);
  if (long) return d.toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' });
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  if (sameDay) return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  const sameYear = d.getFullYear() === now.getFullYear();
  return d.toLocaleDateString([], sameYear ? { month: 'short', day: 'numeric' } : { month: 'short', day: 'numeric', year: 'numeric' });
}

// Outbound delivery pill (sent / in-app only / failed) + inbound processing pill.
function StatusPill({ row }) {
  if (row.direction === 'inbound') {
    const s = row.status;
    const map = {
      forwarded: ['Forwarded to the team', 'ok'], chat_posted: ['Posted to chat', 'ok'],
      received: ['Received', 'ok'], auto_reply: ['Auto-reply', 'muted'],
      no_recipients: ['No one to receive it', 'danger'], failed_permanent: ['Could not process', 'danger'],
      rate_limited: ['Rate limited', 'muted'], archived_app: ['Archived file', 'muted'],
    };
    const [label, tone] = map[s] || (['retrieval_failed', 'forward_failed', 'lookup_failed', 'error'].includes(s)
      ? ['Delivery issue — retrying', 'muted'] : ['Processing', 'muted']);
    return <span className={`ec-pill ec-pill-${tone}`}>{label}</span>;
  }
  const s = row.status;
  const label = s === 'sent' ? 'Emailed' : s === 'error' ? 'Email failed' : s === 'skipped' ? 'In-app only' : 'Pending';
  const tone = s === 'sent' ? 'ok' : s === 'error' ? 'danger' : 'muted';
  return <span className={`ec-pill ec-pill-${tone}`}>{label}</span>;
}

function partyList(row) {
  if (row.direction === 'inbound') return row.from_name || row.from_email || 'Unknown sender';
  const to = Array.isArray(row.to) ? row.to : [];
  if (row.recipient_name) return row.recipient_name + (to[0] && to[0].email ? ` · ${to[0].email}` : '');
  if (to.length) return to.map((t) => t.name || t.email).filter(Boolean).join(', ');
  return row.recipient_kind === 'staff' ? 'Staff' : row.recipient_kind === 'borrower' ? 'Borrower' : '—';
}

// The reader pane for a single message: recipients, timestamp, status, and the
// full body in a sandboxed iframe.
function MessageBody({ appId, row, globalMode }) {
  const [full, setFull] = useState(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState('');
  const frameRef = useRef(null);
  useEffect(() => {
    let alive = true;
    setLoading(true); setErr(''); setFull(null);
    const p = globalMode ? api.staffEmailMsg(row.id) : api.staffAppEmailMsg(appId, row.id);
    p.then((d) => { if (alive) { setFull(d); setLoading(false); } })
      .catch((e) => { if (alive) { setErr(e.message || 'Could not load this message'); setLoading(false); } });
    return () => { alive = false; };
  }, [appId, row.id, globalMode]);

  const html = full && full.body_html;
  const text = full && full.body_text;
  // Auto-size the iframe to its content (scripts are disabled by the sandbox, so
  // reading the framed height is safe).
  const onFrameLoad = () => {
    try {
      const doc = frameRef.current && frameRef.current.contentDocument;
      if (doc) frameRef.current.style.height = Math.min(2400, Math.max(120, doc.body.scrollHeight + 24)) + 'px';
    } catch (_) { /* ignore */ }
  };

  return (
    <div className="ec-reader">
      <div className="ec-reader-head">
        <div className="ec-reader-subject">{row.subject}</div>
        <div className="ec-reader-meta">
          <span className={`ec-dir ec-dir-${row.direction}`}>{row.direction === 'inbound' ? 'Received' : 'Sent'}</span>
          <StatusPill row={row} />
          <span className="ec-when">{when(row.occurred_at, true)}</span>
        </div>
        <div className="ec-reader-parties">
          {row.direction === 'inbound'
            ? <><strong>From</strong> {row.from_name ? `${row.from_name} · ` : ''}{row.from_email || 'unknown'}</>
            : <><strong>To</strong> {partyList(row)}</>}
          {row.file_label && globalMode ? <span className="ec-file-chip">{row.file_label}</span> : null}
        </div>
        {row.error ? <div className="ec-reader-error">Delivery error: {row.error}</div> : null}
        {Array.isArray(row.attachments) && row.attachments.length
          ? <div className="ec-attachments">{row.attachments.map((a, i) => (
              <span className="ec-attach" key={i}>📎 {a.filename}</span>))}</div>
          : null}
      </div>
      <div className="ec-reader-body">
        {loading ? <p className="muted small" style={{ padding: 16 }}>Loading the message…</p>
          : err ? <div className="notice err">{err}</div>
          : html
            ? <iframe ref={frameRef} title="email" className="ec-frame" sandbox="allow-same-origin" srcDoc={html} onLoad={onFrameLoad} />
            : text
              ? <pre className="ec-plain">{text}</pre>
              : <p className="muted small" style={{ padding: 16 }}>{(full && full.body_unavailable) || 'No body was stored for this message.'}</p>}
      </div>
    </div>
  );
}

// The reply composer (file mode only).
function ReplyBox({ appId, subject, onSent }) {
  const [open, setOpen] = useState(false);
  const [body, setBody] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  const send = async () => {
    if (!body.trim()) return;
    setBusy(true); setMsg('');
    try {
      const r = await api.staffAppEmailReply(appId, { body, subject });
      setMsg(`Sent to ${(r.sent_to || []).length} recipient${(r.sent_to || []).length === 1 ? '' : 's'}.`);
      setBody(''); setOpen(false);
      onSent && onSent();
    } catch (e) { setMsg(e.message || 'Could not send.'); }
    finally { setBusy(false); }
  };
  if (!open) {
    return (
      <div className="ec-reply-bar">
        <button className="btn primary small" onClick={() => setOpen(true)}>↩ Reply to the file</button>
        {msg ? <span className="muted small" style={{ marginLeft: 10 }}>{msg}</span> : null}
      </div>
    );
  }
  return (
    <div className="ec-reply">
      <div className="muted small" style={{ marginBottom: 6 }}>
        Your reply goes to the borrower and everyone assigned to this file, on the shared file thread.
      </div>
      <textarea className="ec-reply-text" rows={5} placeholder="Type your reply…" value={body}
        onChange={(e) => setBody(e.target.value)} autoFocus />
      <div className="row" style={{ gap: 8, marginTop: 8, alignItems: 'center' }}>
        <button className="btn primary small" onClick={send} disabled={busy || !body.trim()}>{busy ? 'Sending…' : 'Send reply'}</button>
        <button className="btn ghost small" onClick={() => { setOpen(false); setBody(''); }} disabled={busy}>Cancel</button>
        {msg ? <span className="muted small">{msg}</span> : null}
      </div>
    </div>
  );
}

export default function EmailCenter({ mode = 'file', appId = null }) {
  const globalMode = mode === 'global';
  const [rows, setRows] = useState(null);
  const [err, setErr] = useState('');
  const [q, setQ] = useState('');
  const [debouncedQ, setDebouncedQ] = useState('');
  const [filter, setFilter] = useState('all');   // all | sent | issues | inbound
  const [selId, setSelId] = useState(null);
  const [stats, setStats] = useState(null);

  const load = useCallback(() => {
    setErr('');
    const p = globalMode
      ? api.staffEmails({ q: debouncedQ || undefined, status: filter === 'all' ? undefined : filter === 'inbound' ? undefined : filter, direction: filter === 'inbound' ? 'inbound' : undefined, limit: 120 })
      : api.staffAppEmails(appId);
    p.then((r) => setRows(Array.isArray(r) ? r : [])).catch((e) => setErr(e.message || 'Could not load the emails'));
  }, [globalMode, appId, debouncedQ, filter]);

  useEffect(() => { load(); }, [load]);
  useEffect(() => { if (globalMode) api.staffEmailStats().then(setStats).catch(() => {}); }, [globalMode]);
  // debounce the global search box
  useEffect(() => { const t = setTimeout(() => setDebouncedQ(q.trim()), 300); return () => clearTimeout(t); }, [q]);

  // client-side filter for FILE mode (server already filters in global mode)
  const filtered = useMemo(() => {
    let list = rows || [];
    if (!globalMode) {
      if (filter === 'sent') list = list.filter((r) => r.direction === 'outbound' && r.status === 'sent');
      else if (filter === 'issues') list = list.filter((r) => r.status === 'error' || r.status === 'no_recipients' || r.status === 'failed_permanent');
      else if (filter === 'inbound') list = list.filter((r) => r.direction === 'inbound');
      if (q.trim()) {
        const s = q.trim().toLowerCase();
        list = list.filter((r) => (r.subject || '').toLowerCase().includes(s)
          || (r.preview || '').toLowerCase().includes(s)
          || (r.recipient_name || '').toLowerCase().includes(s)
          || (r.from_email || '').toLowerCase().includes(s)
          || (Array.isArray(r.to) && r.to.some((t) => (t.email || '').toLowerCase().includes(s))));
      }
    }
    return list;
  }, [rows, filter, q, globalMode]);

  // group into threads by thread_key (Gmail-style conversations)
  const threads = useMemo(() => {
    const map = new Map();
    for (const r of filtered) {
      const k = r.thread_key || r.id;
      if (!map.has(k)) map.set(k, { key: k, subject: r.subject, rows: [], lastAt: r.occurred_at, file_label: r.file_label, application_id: r.application_id });
      const t = map.get(k);
      t.rows.push(r);
      if (new Date(r.occurred_at) > new Date(t.lastAt)) { t.lastAt = r.occurred_at; t.subject = r.subject; }
    }
    const arr = [...map.values()];
    arr.forEach((t) => t.rows.sort((a, b) => new Date(a.occurred_at) - new Date(b.occurred_at)));
    arr.sort((a, b) => new Date(b.lastAt) - new Date(a.lastAt));
    return arr;
  }, [filtered]);

  const selectedThread = useMemo(() => {
    if (!selId) return threads[0] || null;
    return threads.find((t) => t.key === selId) || threads[0] || null;
  }, [threads, selId]);

  if (err) return <div className="notice err">{err}</div>;
  if (!rows) return <p className="muted small">Loading the Email Center…</p>;

  const FILTERS = [
    { k: 'all', label: 'All' },
    { k: 'sent', label: 'Emailed' },
    { k: 'inbound', label: 'Replies' },
    { k: 'issues', label: 'Needs attention' },
  ];

  return (
    <div className="ec-wrap">
      {globalMode && stats ? (
        <div className="ec-stats">
          <div className="ec-stat"><span className="ec-stat-n">{stats.total}</span><span className="ec-stat-l">total</span></div>
          <div className="ec-stat"><span className="ec-stat-n" style={{ color: 'var(--ok)' }}>{stats.sent}</span><span className="ec-stat-l">emailed</span></div>
          <div className="ec-stat"><span className="ec-stat-n">{stats.in_app_only}</span><span className="ec-stat-l">in-app only</span></div>
          <div className="ec-stat"><span className="ec-stat-n" style={{ color: stats.failed ? 'var(--danger)' : 'inherit' }}>{stats.failed}</span><span className="ec-stat-l">failed</span></div>
          <div className="ec-stat"><span className="ec-stat-n">{stats.inbound}</span><span className="ec-stat-l">replies in</span></div>
        </div>
      ) : null}

      <div className="ec-toolbar">
        <input className="ec-search" placeholder={globalMode ? 'Search all emails — subject, person, address…' : 'Search this file’s emails…'}
          value={q} onChange={(e) => setQ(e.target.value)} />
        <div className="ec-filters">
          {FILTERS.map((f) => (
            <button key={f.k} className={`ec-filter${filter === f.k ? ' active' : ''}`} onClick={() => setFilter(f.k)}>{f.label}</button>
          ))}
        </div>
      </div>

      <div className="ec-split">
        <div className="ec-list">
          {threads.length === 0 ? <p className="muted small" style={{ padding: 14 }}>No emails match.</p> : null}
          {threads.map((t) => {
            const last = t.rows[t.rows.length - 1];
            const active = selectedThread && selectedThread.key === t.key;
            const hasIssue = t.rows.some((r) => r.status === 'error' || r.status === 'no_recipients' || r.status === 'failed_permanent');
            return (
              <button key={t.key} className={`ec-item${active ? ' active' : ''}`} onClick={() => setSelId(t.key)}>
                <div className="ec-item-top">
                  <span className={`ec-dot ec-dot-${last.direction}${hasIssue ? ' issue' : ''}`} />
                  <span className="ec-item-who">{partyList(last)}</span>
                  <span className="ec-item-when">{when(t.lastAt)}</span>
                </div>
                <div className="ec-item-subject">{t.subject}{t.rows.length > 1 ? <span className="ec-count">{t.rows.length}</span> : null}</div>
                <div className="ec-item-preview">{last.preview || ''}</div>
                {globalMode && t.file_label ? <div className="ec-item-file">{t.file_label}</div> : null}
              </button>
            );
          })}
        </div>

        <div className="ec-pane">
          {!selectedThread ? <p className="muted small" style={{ padding: 20 }}>Select a message to read it.</p> : (
            <>
              <div className="ec-conv">
                {selectedThread.rows.map((r) => (
                  <MessageBody key={r.id} appId={globalMode ? r.application_id : appId} row={r} globalMode={globalMode} />
                ))}
              </div>
              {!globalMode
                ? <ReplyBox appId={appId} subject={selectedThread.subject} onSent={load} />
                : (selectedThread.application_id
                    ? <ReplyBox appId={selectedThread.application_id} subject={selectedThread.subject} onSent={load} />
                    : null)}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
