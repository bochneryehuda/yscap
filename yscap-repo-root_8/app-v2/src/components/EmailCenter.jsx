import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api, saveBlob } from '../lib/api.js';

/* ════════════════════════════════════════════════════════════════════════════
   EMAIL CENTER — a modern Gmail/Outlook-style history of every email +
   notification that went out (or came in) for a loan file.
     · mode="file"   — one file's whole thread history, reply + compose
     · mode="global" — every email across the files the viewer can see
   Opening a message shows the ENTIRE email: full designed body (sandboxed
   iframe), every recipient with per-recipient delivery status, downloadable
   attachments, and inbound replies — with a conversation view, avatars, read/
   unread, starring, date grouping, search highlight, keyboard nav, and reply/
   resend/compose. Read + star state is personal (kept in this browser).
   ════════════════════════════════════════════════════════════════════════════ */

/* ---- personal read/star state (localStorage) ---- */
const READ_KEY = 'ec_read_v2';
const STAR_KEY = 'ec_star_v2';
function loadJSON(k, fallback) { try { const v = JSON.parse(localStorage.getItem(k) || ''); return v && typeof v === 'object' ? v : fallback; } catch { return fallback; } }
function saveJSON(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* private mode */ } }

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
        const openedTip = r.opened_at ? `Opened ${new Date(r.opened_at).toLocaleString()}` : 'Not opened yet';
        return (
          <span className={`ec-recip${r.opened_at ? ' opened' : ''}`} key={i} title={`${label} — ${st.label} · ${openedTip}`}>
            <span className={`ec-recip-dot ec-pill-${st.tone}`} />
            {r.name || r.email}
            {r.opened_at ? <span className="ec-opened" title={openedTip}>👁 opened</span> : null}
          </span>
        );
      })}
    </span>
  );
}

/* ---- one message in the conversation (collapsible) ---- */
function MessageCard({ appId, row, globalMode, expanded, onToggle, onChanged }) {
  const [full, setFull] = useState(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState('');
  const frameRef = useRef(null);
  const wrapRef = useRef(null);
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
  const attachments = (full && Array.isArray(full.attachments) && full.attachments.length) ? full.attachments : (Array.isArray(row.attachments) ? row.attachments : []);
  // Fit the email to the available width so a fixed-width (e.g. 600px) design is
  // never cut off — scale it down to the reader's width and reserve the scaled
  // height. Re-fits when the container resizes (e.g. the Open-large popup).
  const fit = useCallback(() => {
    const frame = frameRef.current, wrap = wrapRef.current;
    if (!frame || !wrap) return;
    let doc; try { doc = frame.contentDocument; } catch { return; }
    if (!doc || !doc.body) return;
    const naturalW = Math.max(doc.body.scrollWidth, doc.documentElement.scrollWidth, 1);
    const naturalH = Math.max(doc.body.scrollHeight, doc.documentElement.scrollHeight, 1);
    const containerW = wrap.clientWidth || naturalW;
    const ratio = naturalW > containerW ? containerW / naturalW : 1;
    frame.style.width = naturalW + 'px';
    frame.style.height = naturalH + 'px';
    frame.style.transformOrigin = 'top left';
    frame.style.transform = ratio < 1 ? `scale(${ratio})` : 'none';
    wrap.style.height = Math.min(6000, Math.round(naturalH * ratio) + 4) + 'px';
  }, []);
  // Re-fit when the reader width changes (opening/closing the large popup, window resize).
  useEffect(() => {
    if (!expanded || !html || typeof ResizeObserver === 'undefined') return undefined;
    const wrap = wrapRef.current; if (!wrap) return undefined;
    const ro = new ResizeObserver(() => fit());
    ro.observe(wrap);
    return () => ro.disconnect();
  }, [expanded, html, fit]);
  const printFrame = () => { try { frameRef.current && frameRef.current.contentWindow && frameRef.current.contentWindow.print(); } catch (_) { /* ignore */ } };
  const download = async (i, a) => {
    if (!a.downloadable) return;
    setBusy('att' + i);
    try { const { blob, filename } = await api.staffAppEmailAttachment(appId, row.id, i); saveBlob(blob, filename || a.filename); }
    catch (e) { setErr(e.message || 'Could not download this attachment.'); }
    finally { setBusy(''); }
  };
  const resend = async () => {
    setBusy('resend');
    try { await api.staffAppEmailResend(appId, row.id); onChanged && onChanged(); }
    catch (e) { setErr(e.message || 'Could not resend.'); }
    finally { setBusy(''); }
  };

  const inbound = row.direction === 'inbound';
  const senderName = inbound ? (row.from_name || row.from_email) : 'YS Capital';
  const canResend = !globalMode && row.direction === 'outbound' && (row.status === 'error' || row.status === 'skipped');

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
            {!inbound && recipientsOf(row).some((r) => r.opened_at)
              ? <span className="ec-opened" title="At least one recipient opened this email">👁 opened</span> : null}
            {!expanded ? <span className="ec-msg-preview">{row.preview}</span> : null}
          </div>
        </div>
        <span className={`ec-chev${expanded ? ' up' : ''}`} aria-hidden="true">⌄</span>
      </button>
      <div className="ec-msg-collapse" style={{ maxHeight: expanded ? 3600 : 0 }}>
        {expanded ? (
          <div className="ec-msg-open">
            <div className="ec-msg-meta">
              {inbound
                ? <div className="ec-metarow"><span className="ec-metalabel">From</span> <span>{row.from_name ? `${row.from_name} · ` : ''}{row.from_email || 'unknown'}</span></div>
                : <div className="ec-metarow"><span className="ec-metalabel">To</span> <RecipientRoster row={row} /></div>}
              {!inbound && full && Array.isArray(full.cc) && full.cc.length
                ? <div className="ec-metarow"><span className="ec-metalabel">Cc</span> <span className="ec-recips">{full.cc.map((c, i) => <span className="ec-recip" key={i}>{c.name || c.email}</span>)}</span></div>
                : null}
              {row.file_label && globalMode ? <div className="ec-metarow"><span className="ec-metalabel">File</span> <span className="ec-file-chip">{row.file_label}</span></div> : null}
              {row.error ? <div className="ec-reader-error">Delivery error: {row.error}</div> : null}
              {attachments.length
                ? <div className="ec-attachments">
                    <span className="ec-attach-label">{attachments.length} attachment{attachments.length === 1 ? '' : 's'}:</span>
                    {attachments.map((a, i) => (
                      a.downloadable
                        ? <button className="ec-attach ec-attach-dl" key={i} onClick={() => download(i, a)} disabled={busy === 'att' + i} title="Download">
                            📎 {a.filename}{a.size ? <span className="muted"> · {Math.max(1, Math.round(a.size / 1024))} KB</span> : null} ⤓
                          </button>
                        : <span className="ec-attach" key={i}>📎 {a.filename}{a.size ? <span className="muted"> · {Math.max(1, Math.round(a.size / 1024))} KB</span> : null}</span>))}
                  </div>
                : null}
            </div>
            <div className="ec-msg-body">
              {loading ? <div className="ec-skel" />
                : err ? <div className="notice err" style={{ margin: 12 }}>{err}</div>
                : html
                  ? <div className="ec-frame-wrap" ref={wrapRef}><iframe ref={frameRef} title="email" className="ec-frame" sandbox="allow-same-origin" srcDoc={html} onLoad={fit} /></div>
                  : text ? <pre className="ec-plain">{text}</pre>
                    : <p className="muted small" style={{ padding: 16 }}>{(full && full.body_unavailable) || 'No body was stored for this message.'}</p>}
            </div>
            <div className="ec-msg-actions">
              {canResend ? <button className="btn ghost small" onClick={resend} disabled={busy === 'resend'}>{busy === 'resend' ? 'Resending…' : '↻ Resend'}</button> : null}
              {html ? <button className="btn ghost small" onClick={printFrame}>🖨 Print</button> : null}
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
}

/* ---- reply / compose composer (shows who it reaches) ---- */
function Composer({ appId, subject, onSent, isNew, onClose, scope }) {
  const [open, setOpen] = useState(!!isNew);
  const [body, setBody] = useState('');
  const [subj, setSubj] = useState(isNew ? '' : (subject && /^\s*re:/i.test(subject) ? subject : `Re: ${subject || 'your loan file'}`));
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  const [recips, setRecips] = useState(null);
  useEffect(() => { if (!isNew) setSubj(subject && /^\s*re:/i.test(subject) ? subject : `Re: ${subject || 'your loan file'}`); }, [subject, isNew]);
  useEffect(() => {
    if (!open) return;
    api.staffAppReplyRecipients(appId).then((r) => setRecips(Array.isArray(r) ? r : [])).catch(() => setRecips([]));
  }, [open, appId]);
  const send = async () => {
    if (!body.trim()) return;
    setBusy(true); setMsg('');
    try {
      const r = await api.staffAppEmailReply(appId, { body, subject: subj, scope: scope || undefined });
      setMsg(`Sent to ${(r.sent_to || []).length} recipient${(r.sent_to || []).length === 1 ? '' : 's'}.`);
      setBody(''); if (!isNew) setOpen(false); if (isNew && onClose) onClose();
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
      <textarea className="ec-reply-text" rows={5} placeholder="Type your message…  (⌘/Ctrl + Enter to send)" value={body}
        onChange={(e) => setBody(e.target.value)} onKeyDown={onKey} autoFocus />
      <div className="row" style={{ gap: 8, marginTop: 8, alignItems: 'center' }}>
        <button className="btn primary small" onClick={send} disabled={busy || !body.trim()}>{busy ? 'Sending…' : (isNew ? 'Send message' : 'Send reply')}</button>
        <button className="btn ghost small" onClick={() => { if (isNew && onClose) onClose(); else setOpen(false); setBody(''); }} disabled={busy}>Cancel</button>
        {msg ? <span className="muted small">{msg}</span> : null}
      </div>
    </div>
  );
}

const PAGE = 120;

export default function EmailCenter({ mode = 'file', appId = null, scope = null }) {
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
  const [composing, setComposing] = useState(false);
  const [big, setBig] = useState(false);
  const [hasMore, setHasMore] = useState(false);
  const [read, setRead] = useState(() => loadJSON(READ_KEY, {}));
  const [stars, setStars] = useState(() => loadJSON(STAR_KEY, {}));
  const searchRef = useRef(null);

  const load = useCallback((append) => {
    setErr(''); setRefreshing(true);
    const offset = append && rows ? rows.length : 0;
    const p = globalMode
      ? api.staffEmails({ q: debouncedQ || undefined, status: filter === 'all' || filter === 'inbound' || filter === 'starred' || filter === 'unread' ? undefined : filter, direction: filter === 'inbound' ? 'inbound' : undefined, limit: PAGE, offset })
      : api.staffAppEmails(appId, scope);
    p.then((r) => {
      const arr = Array.isArray(r) ? r : [];
      if (globalMode) { setHasMore(arr.length >= PAGE); setRows((prev) => append && prev ? prev.concat(arr) : arr); }
      else setRows(arr);
    }).catch((e) => setErr(e.message || 'Could not load the emails')).finally(() => setRefreshing(false));
    if (globalMode && !append) api.staffEmailStats().then(setStats).catch(() => {});
  }, [globalMode, appId, debouncedQ, filter, rows]);

  // reload on filter/search change (not on rows change — that would loop)
  useEffect(() => { load(false); /* eslint-disable-next-line */ }, [globalMode, appId, debouncedQ, filter]);
  useEffect(() => { const t = setTimeout(() => setDebouncedQ(q.trim()), 300); return () => clearTimeout(t); }, [q]);

  const persistRead = (next) => { setRead(next); saveJSON(READ_KEY, next); };
  const toggleStar = (key) => { const next = { ...stars }; if (next[key]) delete next[key]; else next[key] = 1; setStars(next); saveJSON(STAR_KEY, next); };

  const filtered = useMemo(() => {
    let list = rows || [];
    if (!globalMode) {
      if (filter === 'sent') list = list.filter((r) => r.direction === 'outbound' && r.status === 'sent');
      else if (filter === 'issues') list = list.filter((r) => r.status === 'error' || r.status === 'no_recipients' || r.status === 'failed_permanent');
      else if (filter === 'inbound') list = list.filter((r) => r.direction === 'inbound');
    }
    if (q.trim() && !globalMode) {
      const s = q.trim().toLowerCase();
      list = list.filter((r) => (r.subject || '').toLowerCase().includes(s) || (r.preview || '').toLowerCase().includes(s)
        || partyList(r).toLowerCase().includes(s) || (r.from_email || '').toLowerCase().includes(s)
        || recipientsOf(r).some((t) => (t.email || '').toLowerCase().includes(s)));
    }
    return list;
  }, [rows, filter, q, globalMode]);

  const isUnread = useCallback((t) => !read[t.key] || new Date(t.lastAt) > new Date(read[t.key]), [read]);

  const threads = useMemo(() => {
    const map = new Map();
    for (const r of filtered) {
      const k = r.thread_key || r.id;
      if (!map.has(k)) map.set(k, { key: k, subject: r.subject, rows: [], lastAt: r.occurred_at, file_label: r.file_label, application_id: r.application_id });
      const t = map.get(k);
      t.rows.push(r);
      if (new Date(r.occurred_at) > new Date(t.lastAt)) { t.lastAt = r.occurred_at; t.subject = r.subject; t.file_label = r.file_label; t.application_id = r.application_id; }
    }
    let arr = [...map.values()];
    arr.forEach((t) => t.rows.sort((a, b) => new Date(a.occurred_at) - new Date(b.occurred_at)));
    arr.sort((a, b) => new Date(b.lastAt) - new Date(a.lastAt));
    if (filter === 'starred') arr = arr.filter((t) => stars[t.key]);
    if (filter === 'unread') arr = arr.filter((t) => isUnread(t));
    return arr;
  }, [filtered, filter, stars, isUnread]);

  const unreadCount = useMemo(() => threads.reduce((n, t) => n + (isUnread(t) ? 1 : 0), 0), [threads, isUnread]);

  const selectedThread = useMemo(() => {
    if (!selId) return threads[0] || null;
    return threads.find((t) => t.key === selId) || threads[0] || null;
  }, [threads, selId]);

  // Expand the latest message when the selection changes (VISUAL only). Marking a
  // thread read happens ONLY on a genuine user open (openThread) — never on the
  // auto-default selection, or the Unread filter would mark-read-cascade itself
  // empty and the newest thread would be marked read on mobile without being seen.
  useEffect(() => {
    if (!selectedThread) return;
    const last = selectedThread.rows[selectedThread.rows.length - 1];
    setExpanded(new Set(last ? [last.id] : []));
    // eslint-disable-next-line
  }, [selectedThread && selectedThread.key]);

  const openThread = (key) => {
    setSelId(key); setMobileReader(true); setComposing(false);
    const t = threads.find((x) => x.key === key);
    if (t && isUnread(t)) persistRead({ ...read, [t.key]: t.lastAt });
  };
  const toggleMsg = (id) => setExpanded((prev) => { const n = new Set(prev); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  const markAllRead = () => { const next = { ...read }; for (const t of threads) next[t.key] = t.lastAt; persistRead(next); };

  // keyboard navigation
  useEffect(() => {
    const onKey = (e) => {
      const tag = (e.target && e.target.tagName) || '';
      const typing = tag === 'INPUT' || tag === 'TEXTAREA' || (e.target && e.target.isContentEditable);
      if (e.key === 'Escape') { if (big) { setBig(false); return; } if (mobileReader) setMobileReader(false); return; }
      if (typing) return;
      if (e.key === '/') { e.preventDefault(); searchRef.current && searchRef.current.focus(); return; }
      if ((e.key === 'j' || e.key === 'k') && threads.length) {
        e.preventDefault();
        const idx = Math.max(0, threads.findIndex((t) => selectedThread && t.key === selectedThread.key));
        const ni = e.key === 'j' ? Math.min(threads.length - 1, idx + 1) : Math.max(0, idx - 1);
        openThread(threads[ni].key);
      }
      if (e.key === 'c' && !globalMode) { setComposing(true); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [threads, selectedThread, mobileReader, globalMode, big]);

  if (err) return <div className="notice err">{err}</div>;
  if (!rows) return <div className="ec-wrap"><div className="ec-skel" style={{ height: 220 }} /></div>;

  const FILTERS = [
    { k: 'all', label: 'All' },
    { k: 'unread', label: `Unread${unreadCount ? ` (${unreadCount})` : ''}` },
    { k: 'starred', label: '★ Starred' },
    { k: 'sent', label: 'Emailed' },
    { k: 'inbound', label: 'Replies' },
    { k: 'issues', label: 'Needs attention' },
  ];

  // date-grouped thread list
  const listGroups = [];
  let curBucket = null;
  for (const t of threads) {
    const b = dateBucket(t.lastAt);
    if (b !== curBucket) { listGroups.push({ bucket: b, items: [] }); curBucket = b; }
    listGroups[listGroups.length - 1].items.push(t);
  }

  const main = (
    <div className={`ec-wrap${mobileReader ? ' mobile-reader' : ''}${big ? ' big' : ''}`}>
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
        <input ref={searchRef} className="ec-search" placeholder={globalMode ? 'Search all emails — subject, person, address…  ( / )' : (scope === 'draw' ? 'Search this file’s draw emails…  ( / )' : 'Search this file’s emails…  ( / )')}
          value={q} onChange={(e) => setQ(e.target.value)} />
        <div className="ec-filters">
          {FILTERS.map((f) => (<button key={f.k} className={`ec-filter${filter === f.k ? ' active' : ''}`} onClick={() => setFilter(f.k)}>{f.label}</button>))}
        </div>
        {unreadCount ? <button className="ec-textbtn" onClick={markAllRead} title="Mark all as read">Mark all read</button> : null}
        {!globalMode ? <button className="btn primary small" onClick={() => { setComposing(true); setMobileReader(true); }}>＋ New email</button> : null}
        {!globalMode && !big ? <button className="ec-refresh" onClick={() => setBig(true)} title="Open the Email Center in a large window" aria-label="Open large">⤢</button> : null}
        <button className="ec-refresh" onClick={() => load(false)} title="Refresh" aria-label="Refresh">{refreshing ? '…' : '⟳'}</button>
      </div>

      {composing && !globalMode ? (
        <div className="ec-compose-panel">
          <div className="ec-compose-head">{scope === 'draw' ? 'New draw message to this file' : 'New email to this file'}</div>
          <Composer appId={appId} subject="" isNew onSent={() => load(false)} onClose={() => setComposing(false)} scope={scope} />
        </div>
      ) : null}

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
                const unread = isUnread(t);
                return (
                  <div key={t.key} className={`ec-item${active ? ' active' : ''}${unread ? ' unread' : ''}`} onClick={() => openThread(t.key)}>
                    <Avatar name={inbound ? (last.from_name || last.from_email) : partyList(last)} email={inbound ? last.from_email : null} inbound={inbound} size={38} />
                    <div className="ec-item-main">
                      <div className="ec-item-top">
                        {unread ? <span className="ec-unread-dot" title="Unread" /> : null}
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
                    <button className={`ec-star${stars[t.key] ? ' on' : ''}`} title={stars[t.key] ? 'Unstar' : 'Star'}
                      onClick={(e) => { e.stopPropagation(); toggleStar(t.key); }}>{stars[t.key] ? '★' : '☆'}</button>
                  </div>
                );
              })}
            </React.Fragment>
          ))}
          {globalMode && hasMore ? <button className="ec-loadmore" onClick={() => load(true)} disabled={refreshing}>{refreshing ? 'Loading…' : 'Load more'}</button> : null}
        </div>

        <div className="ec-pane">
          {!selectedThread ? <p className="muted small" style={{ padding: 24 }}>Select a message to read the full email.</p> : (
            <>
              <div className="ec-pane-head">
                <button className="ec-back" onClick={() => setMobileReader(false)} aria-label="Back to list">←</button>
                <div className="ec-pane-subject">{selectedThread.subject}</div>
                <button className={`ec-star lg${stars[selectedThread.key] ? ' on' : ''}`} title={stars[selectedThread.key] ? 'Unstar' : 'Star'}
                  onClick={() => toggleStar(selectedThread.key)}>{stars[selectedThread.key] ? '★' : '☆'}</button>
              </div>
              <div className="ec-conv">
                {selectedThread.rows.map((r) => (
                  <MessageCard key={r.id} appId={globalMode ? r.application_id : appId} row={r} globalMode={globalMode}
                    expanded={expanded.has(r.id)} onToggle={() => toggleMsg(r.id)} onChanged={() => load(false)} />
                ))}
              </div>
              {(!globalMode || selectedThread.application_id)
                ? <Composer appId={globalMode ? selectedThread.application_id : appId} subject={selectedThread.subject} onSent={() => load(false)} scope={scope} />
                : null}
            </>
          )}
        </div>
      </div>
    </div>
  );

  if (big) {
    return (
      <div className="ec-modal-back" role="dialog" aria-modal="true" onMouseDown={(e) => { if (e.target === e.currentTarget) setBig(false); }}>
        <div className="ec-modal-card">
          <div className="ec-modal-head">
            <b>Email Center</b>
            <button className="btn ghost small" onClick={() => setBig(false)}>✕ Close</button>
          </div>
          <div className="ec-modal-body">{main}</div>
        </div>
      </div>
    );
  }
  return main;
}
