import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../lib/api.js';

/* ════════════════════════════════════════════════════════════════════════════
   EMAIL CENTER — a modern Gmail/Outlook-style history of every email +
   notification that went out (or came in) for a loan file. Two modes:
     · mode="file"   — one file's whole thread history, with a reply box
     · mode="global" — every email across the files the viewer can see
   Opening a message shows the ENTIRE email: the full designed body (in a
   sandboxed iframe, scripts disabled), every recipient it reached with each
   one's delivery status, attachments, and the inbound replies — with a
   conversation view, avatars, date grouping, search highlight, and reply.
   ════════════════════════════════════════════════════════════════════════════ */

/* ---- small helpers ---- */
function when(ts, long) {
  if (!ts) return '';
  const d = new Date(ts);
  if (long) return d.toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' });
  const now = new Date();
  if (d.toDateString() === now.toDateString()) return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  const sameYear = d.getFullYear() === now.getFullYear();
  return d.toLocaleDateString([], sameYear ? { month: 'short', day: 'numeric' } : { month: 'short', day: 'numeric', year: 'numeric' });
}
function dateBucket(ts) {
  if (!ts) return 'Earlier';
  const d = new Date(ts); const now = new Date();
  const day = (x) => new Date(x.getFullYear(), x.getMonth(), x.getDate());
  const diffDays = Math.round((day(now) - day(d)) / 86400000);
  if (diffDays <= 0) return 'Today';
  if (diffDays === 1) return 'Yesterday';
  if (diffDays <= 7) return 'This week';
  if (d.getFullYear() === now.getFullYear()) return d.toLocaleDateString([], { month: 'long' });
  return String(d.getFullYear());
}
const AV_COLORS = ['#2F7F86', '#AE8746', '#5B6B7A', '#7A5C8E', '#4F8A6B', '#B5683E', '#3E6FB5'];
function hashStr(s) { let h = 0; for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0; return Math.abs(h); }
function initialsOf(name, email) {
  const s = String(name || email || '?').trim();
  const parts = s.split(/[\s@._-]+/).filter(Boolean);
  if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
  return s.slice(0, 2).toUpperCase();
}
function Avatar({ name, email, size = 34, inbound }) {
  const key = String(name || email || '?');
  const color = inbound ? '#8A6D2F' : AV_COLORS[hashStr(key) % AV_COLORS.length];
  return <span className="ec-avatar" style={{ width: size, height: size, minWidth: size, background: color, fontSize: Math.round(size * 0.4) }}>{initialsOf(name, email)}</span>;
}
function highlight(text, q) {
  const s = String(text || '');
  if (!q) return s;
  const i = s.toLowerCase().indexOf(q.toLowerCase());
  if (i < 0) return s;
  return <>{s.slice(0, i)}<mark className="ec-hl">{s.slice(i, i + q.length)}</mark>{s.slice(i + q.length)}</>;
}
function recipStatus(s) {
  if (s === 'sent') return { tone: 'ok', label: 'Emailed' };
  if (s === 'error') return { tone: 'danger', label: 'Email failed' };
  if (s === 'skipped') return { tone: 'muted', label: 'In-app only' };
  return { tone: 'muted', label: 'Pending' };
}

function StatusPill({ row }) {
  if (row.direction === 'inbound') {
    const map = {
      forwarded: ['Forwarded to the team', 'ok'], chat_posted: ['Posted to chat', 'ok'], received: ['Received', 'ok'],
      auto_reply: ['Auto-reply', 'muted'], no_recipients: ['No one to receive it', 'danger'], failed_permanent: ['Could not process', 'danger'],
      rate_limited: ['Rate limited', 'muted'], archived_app: ['Archived file', 'muted'],
    };
    const [label, tone] = map[row.status] || (['retrieval_failed', 'forward_failed', 'lookup_failed', 'error'].includes(row.status)
      ? ['Delivery issue — retrying', 'muted'] : ['Processing', 'muted']);
    return <span className={`ec-pill ec-pill-${tone}`}>{label}</span>;
  }
  const s = row.status;
  const label = s === 'sent' ? 'Emailed' : s === 'error' ? 'Email failed' : s === 'skipped' ? 'In-app only' : 'Pending';
  const tone = s === 'sent' ? 'ok' : s === 'error' ? 'danger' : 'muted';
  return <span className={`ec-pill ec-pill-${tone}`}>{label}</span>;
}

function recipientsOf(row) {
  if (Array.isArray(row.recipients) && row.recipients.length) return row.recipients;
  if (Array.isArray(row.to) && row.to.length) return row.to.map((t) => ({ email: t.email, name: t.name, kind: row.recipient_kind, status: row.status }));
  return [];
}
function partyList(row) {
  if (row.direction === 'inbound') return row.from_name || row.from_email || 'Unknown sender';
  const recips = recipientsOf(row);
  const names = recips.map((r) => r.name || r.email).filter(Boolean);
  if (!names.length) return recips.length ? `${recips.length} recipient${recips.length === 1 ? '' : 's'}` : '—';
  if (names.length <= 2) return names.join(', ');
  return `${names.slice(0, 2).join(', ')} +${names.length - 2}`;
}
function RecipientRoster({ row }) {
  const recips = recipientsOf(row);
  if (!recips.length) return <span className="muted small">—</span>;
  return (
    <span className="ec-recips">
      {recips.map((r, i) => {
        const st = recipStatus(r.status);
        const label = r.name && r.email ? `${r.name} <${r.email}>` : (r.name || r.email || 'recipient');
        return (
          <span className="ec-recip" key={i} title={`${label} — ${st.label}`}>
            <span className={`ec-recip-dot ec-pill-${st.tone}`} />
            {r.name || r.email}
          </span>
        );
      })}
    </span>
  );
}

/* ---- one message in the conversation (collapsible) ---- */
function MessageCard({ appId, row, globalMode, expanded, onToggle }) {
  const [full, setFull] = useState(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState('');
  const frameRef = useRef(null);
  const loadedFor = useRef(null);

  useEffect(() => {
    if (!expanded || loadedFor.current === row.id) return;
    loadedFor.current = row.id;
    let alive = true;
    setLoading(true); setErr('');
    const p = globalMode ? api.staffEmailMsg(row.id) : api.staffAppEmailMsg(appId, row.id);
    p.then((d) => { if (alive) { setFull(d); setLoading(false); } })
      .catch((e) => { if (alive) { setErr(e.message || 'Could not load this message'); setLoading(false); } });
    return () => { alive = false; };
  }, [expanded, row.id, appId, globalMode]);

  const html = full && full.body_html;
  const text = full && full.body_text;
  const onFrameLoad = () => {
    try {
      const doc = frameRef.current && frameRef.current.contentDocument;
      if (doc) frameRef.current.style.height = Math.min(3200, Math.max(120, doc.body.scrollHeight + 24)) + 'px';
    } catch (_) { /* ignore */ }
  };
  const printFrame = () => { try { frameRef.current && frameRef.current.contentWindow && frameRef.current.contentWindow.print(); } catch (_) { /* ignore */ } };

  const inbound = row.direction === 'inbound';
  const senderName = inbound ? (row.from_name || row.from_email) : 'YS Capital';

  return (
    <div className={`ec-msg${expanded ? ' open' : ''}`}>
      <button className="ec-msg-head" onClick={onToggle} aria-expanded={expanded}>
        <Avatar name={senderName} email={inbound ? row.from_email : null} inbound={inbound} size={36} />
        <div className="ec-msg-headmain">
          <div className="ec-msg-headtop">
            <span className="ec-msg-sender">{inbound ? senderName : partyList(row)}</span>
            <span className="ec-msg-when">{when(row.occurred_at, true)}</span>
          </div>
          <div className="ec-msg-headsub">
            <span className={`ec-dir ec-dir-${row.direction}`}>{inbound ? 'Received' : 'Sent'}</span>
            <StatusPill row={row} />
            {!expanded ? <span className="ec-msg-preview">{row.preview}</span> : null}
          </div>
        </div>
        <span className={`ec-chev${expanded ? ' up' : ''}`} aria-hidden="true">⌄</span>
      </button>
      {expanded ? (
        <div className="ec-msg-open">
          <div className="ec-msg-meta">
            {inbound
              ? <div className="ec-metarow"><span className="ec-metalabel">From</span> <span>{row.from_name ? `${row.from_name} · ` : ''}{row.from_email || 'unknown'}</span></div>
              : <div className="ec-metarow"><span className="ec-metalabel">To</span> <RecipientRoster row={row} /></div>}
            {row.file_label && globalMode ? <div className="ec-metarow"><span className="ec-metalabel">File</span> <span className="ec-file-chip">{row.file_label}</span></div> : null}
            {row.error ? <div className="ec-reader-error">Delivery error: {row.error}</div> : null}
            {Array.isArray(row.attachments) && row.attachments.length
              ? <div className="ec-attachments">
                  <span className="ec-attach-label">{row.attachments.length} attachment{row.attachments.length === 1 ? '' : 's'}:</span>
                  {row.attachments.map((a, i) => (
                    <span className="ec-attach" key={i}>📎 {a.filename}{a.size ? <span className="muted"> · {Math.max(1, Math.round(a.size / 1024))} KB</span> : null}</span>))}
                </div>
              : null}
          </div>
          <div className="ec-msg-body">
            {loading ? <div className="ec-skel" />
              : err ? <div className="notice err" style={{ margin: 12 }}>{err}</div>
              : html
                ? <iframe ref={frameRef} title="email" className="ec-frame" sandbox="allow-same-origin" srcDoc={html} onLoad={onFrameLoad} />
                : text ? <pre className="ec-plain">{text}</pre>
                  : <p className="muted small" style={{ padding: 16 }}>{(full && full.body_unavailable) || 'No body was stored for this message.'}</p>}
          </div>
          {html ? <div className="ec-msg-actions"><button className="btn ghost small" onClick={printFrame}>🖨 Print</button></div> : null}
        </div>
      ) : null}
    </div>
  );
}

/* ---- reply composer (shows who it reaches) ---- */
function Composer({ appId, subject, onSent }) {
  const [open, setOpen] = useState(false);
  const [body, setBody] = useState('');
  const [subj, setSubj] = useState(subject && /^\s*re:/i.test(subject) ? subject : `Re: ${subject || 'your loan file'}`);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  const [recips, setRecips] = useState(null);
  useEffect(() => { setSubj(subject && /^\s*re:/i.test(subject) ? subject : `Re: ${subject || 'your loan file'}`); }, [subject]);
  useEffect(() => {
    if (!open) return;
    api.staffAppReplyRecipients(appId).then((r) => setRecips(Array.isArray(r) ? r : [])).catch(() => setRecips([]));
  }, [open, appId]);
  const send = async () => {
    if (!body.trim()) return;
    setBusy(true); setMsg('');
    try {
      const r = await api.staffAppEmailReply(appId, { body, subject: subj });
      setMsg(`Sent to ${(r.sent_to || []).length} recipient${(r.sent_to || []).length === 1 ? '' : 's'}.`);
      setBody(''); setOpen(false);
      onSent && onSent();
    } catch (e) { setMsg(e.message || 'Could not send.'); }
    finally { setBusy(false); }
  };
  const onKey = (e) => { if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') send(); };
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
      <div className="ec-reply-to">
        <span className="ec-metalabel">To</span>
        {recips === null ? <span className="muted small">loading…</span>
          : recips.length ? recips.map((r, i) => (
              <span className="ec-chip" key={i}><Avatar name={r.name} email={r.email} size={20} inbound={r.kind === 'borrower'} />{r.name || r.email}</span>))
            : <span className="muted small">the borrower and everyone assigned to this file</span>}
      </div>
      <input className="ec-reply-subject" value={subj} onChange={(e) => setSubj(e.target.value)} placeholder="Subject" />
      <textarea className="ec-reply-text" rows={5} placeholder="Type your reply…  (⌘/Ctrl + Enter to send)" value={body}
        onChange={(e) => setBody(e.target.value)} onKeyDown={onKey} autoFocus />
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
  const [filter, setFilter] = useState('all');
  const [selId, setSelId] = useState(null);
  const [stats, setStats] = useState(null);
  const [expanded, setExpanded] = useState(() => new Set());
  const [mobileReader, setMobileReader] = useState(false);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(() => {
    setErr(''); setRefreshing(true);
    const p = globalMode
      ? api.staffEmails({ q: debouncedQ || undefined, status: filter === 'all' || filter === 'inbound' ? undefined : filter, direction: filter === 'inbound' ? 'inbound' : undefined, limit: 150 })
      : api.staffAppEmails(appId);
    p.then((r) => setRows(Array.isArray(r) ? r : [])).catch((e) => setErr(e.message || 'Could not load the emails')).finally(() => setRefreshing(false));
    if (globalMode) api.staffEmailStats().then(setStats).catch(() => {});
  }, [globalMode, appId, debouncedQ, filter]);

  useEffect(() => { load(); }, [load]);
  useEffect(() => { const t = setTimeout(() => setDebouncedQ(q.trim()), 300); return () => clearTimeout(t); }, [q]);

  const filtered = useMemo(() => {
    let list = rows || [];
    if (!globalMode) {
      if (filter === 'sent') list = list.filter((r) => r.direction === 'outbound' && r.status === 'sent');
      else if (filter === 'issues') list = list.filter((r) => r.status === 'error' || r.status === 'no_recipients' || r.status === 'failed_permanent');
      else if (filter === 'inbound') list = list.filter((r) => r.direction === 'inbound');
      if (q.trim()) {
        const s = q.trim().toLowerCase();
        list = list.filter((r) => (r.subject || '').toLowerCase().includes(s) || (r.preview || '').toLowerCase().includes(s)
          || partyList(r).toLowerCase().includes(s) || (r.from_email || '').toLowerCase().includes(s)
          || recipientsOf(r).some((t) => (t.email || '').toLowerCase().includes(s)));
      }
    }
    return list;
  }, [rows, filter, q, globalMode]);

  const threads = useMemo(() => {
    const map = new Map();
    for (const r of filtered) {
      const k = r.thread_key || r.id;
      if (!map.has(k)) map.set(k, { key: k, subject: r.subject, rows: [], lastAt: r.occurred_at, file_label: r.file_label, application_id: r.application_id });
      const t = map.get(k);
      t.rows.push(r);
      if (new Date(r.occurred_at) > new Date(t.lastAt)) { t.lastAt = r.occurred_at; t.subject = r.subject; t.file_label = r.file_label; t.application_id = r.application_id; }
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

  // when the selected thread changes, expand its latest message by default
  useEffect(() => {
    if (!selectedThread) return;
    const last = selectedThread.rows[selectedThread.rows.length - 1];
    setExpanded(new Set(last ? [last.id] : []));
  }, [selectedThread && selectedThread.key]);

  const openThread = (key) => { setSelId(key); setMobileReader(true); };
  const toggleMsg = (id) => setExpanded((prev) => { const n = new Set(prev); if (n.has(id)) n.delete(id); else n.add(id); return n; });

  if (err) return <div className="notice err">{err}</div>;
  if (!rows) return <div className="ec-wrap"><div className="ec-skel" style={{ height: 200 }} /></div>;

  const FILTERS = [
    { k: 'all', label: 'All' }, { k: 'sent', label: 'Emailed' }, { k: 'inbound', label: 'Replies' }, { k: 'issues', label: 'Needs attention' },
  ];

  // date-grouped thread list
  const listGroups = [];
  let curBucket = null;
  for (const t of threads) {
    const b = dateBucket(t.lastAt);
    if (b !== curBucket) { listGroups.push({ bucket: b, items: [] }); curBucket = b; }
    listGroups[listGroups.length - 1].items.push(t);
  }

  return (
    <div className={`ec-wrap${mobileReader ? ' mobile-reader' : ''}`}>
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
          {FILTERS.map((f) => (<button key={f.k} className={`ec-filter${filter === f.k ? ' active' : ''}`} onClick={() => setFilter(f.k)}>{f.label}</button>))}
        </div>
        <button className="ec-refresh" onClick={load} title="Refresh" aria-label="Refresh">{refreshing ? '…' : '⟳'}</button>
      </div>

      <div className="ec-split">
        <div className="ec-list">
          {threads.length === 0 ? <p className="muted small" style={{ padding: 16 }}>No emails match.</p> : null}
          {listGroups.map((grp) => (
            <React.Fragment key={grp.bucket}>
              <div className="ec-datehdr">{grp.bucket}</div>
              {grp.items.map((t) => {
                const last = t.rows[t.rows.length - 1];
                const active = selectedThread && selectedThread.key === t.key;
                const hasIssue = t.rows.some((r) => r.status === 'error' || r.status === 'no_recipients' || r.status === 'failed_permanent');
                const inbound = last.direction === 'inbound';
                return (
                  <button key={t.key} className={`ec-item${active ? ' active' : ''}`} onClick={() => openThread(t.key)}>
                    <Avatar name={inbound ? (last.from_name || last.from_email) : partyList(last)} email={inbound ? last.from_email : null} inbound={inbound} size={38} />
                    <div className="ec-item-main">
                      <div className="ec-item-top">
                        <span className="ec-item-who">{highlight(inbound ? (last.from_name || last.from_email || 'Reply') : partyList(last), q)}</span>
                        <span className="ec-item-when">{when(t.lastAt)}</span>
                      </div>
                      <div className="ec-item-subject">
                        {hasIssue ? <span className="ec-issue-dot" title="A delivery issue on this thread" /> : null}
                        {highlight(t.subject, q)}{t.rows.length > 1 ? <span className="ec-count">{t.rows.length}</span> : null}
                      </div>
                      <div className="ec-item-preview">{highlight(last.preview || '', q)}</div>
                      {globalMode && t.file_label ? <div className="ec-item-file">{t.file_label}</div> : null}
                    </div>
                  </button>
                );
              })}
            </React.Fragment>
          ))}
        </div>

        <div className="ec-pane">
          {!selectedThread ? <p className="muted small" style={{ padding: 24 }}>Select a message to read the full email.</p> : (
            <>
              <div className="ec-pane-head">
                <button className="ec-back" onClick={() => setMobileReader(false)} aria-label="Back to list">←</button>
                <div className="ec-pane-subject">{selectedThread.subject}</div>
              </div>
              <div className="ec-conv">
                {selectedThread.rows.map((r) => (
                  <MessageCard key={r.id} appId={globalMode ? r.application_id : appId} row={r} globalMode={globalMode}
                    expanded={expanded.has(r.id)} onToggle={() => toggleMsg(r.id)} />
                ))}
              </div>
              {(!globalMode || selectedThread.application_id)
                ? <Composer appId={globalMode ? selectedThread.application_id : appId} subject={selectedThread.subject} onSent={load} />
                : null}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
