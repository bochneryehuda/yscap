import React, { useEffect, useMemo, useRef, useState, useCallback } from 'react';
import { api } from '../lib/api.js';
import { subscribeChat, getConnId } from '../lib/chatEvents.js';
import DocPreview from './DocPreview.jsx';

/* ChatThread — the conversation view (staff + borrower share it).
   Realtime over SSE: live messages, WHO-is-typing, presence, per-member
   read/delivered watermarks (WhatsApp-style ticks + Google-Chat-style
   avatar read markers), unread divider, reply/quote with jump+flash,
   optimistic sends with retry, drafts, pins banner, Message Info, roster. */

const QUICK_EMOJI = ['👍', '❤️', '✅', '👀', '🎉', '❓'];
const REF_ICON = { task: '☑', document: '⎙', application: '🏠', borrower: '👤' };

/* Clean line-icon set for the chat's interactive controls. Replaces the
   emoji-glyph buttons (📎🎤🙂↩📌⋯📁🔔) so the borrower chat reads as a
   professional business tool, not a consumer social app. Reaction emoji stay
   (they're content). Inherits currentColor + sizes to the button's font-size. */
const CI_PATHS = {
  attach: 'M21.44 11.05 12.25 20.24a5 5 0 0 1-7.07-7.07l9.19-9.19a3 3 0 0 1 4.24 4.24l-9.2 9.19a1 1 0 0 1-1.41-1.41l8.48-8.49',
  mic: 'M12 15a3 3 0 0 0 3-3V6a3 3 0 0 0-6 0v6a3 3 0 0 0 3 3zM19 10v2a7 7 0 0 1-14 0v-2M12 19v4',
  stop: 'M6 6h12v12H6z',
  reply: 'M9 17 4 12l5-5M4 12h11a5 5 0 0 1 5 5v2',
  pin: 'M12 17v5M9 3h6l-1 6 3 3v2H7v-2l3-3-1-6z',
  more: 'M5 12h.01M12 12h.01M19 12h.01',
  smile: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM8.5 14a4 4 0 0 0 7 0M9 9.5h.01M15 9.5h.01',
  folder: 'M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z',
  bell: 'M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9M13.7 21a2 2 0 0 1-3.4 0',
  bellOff: 'M13.7 21a2 2 0 0 1-3.4 0M18 8a6 6 0 0 0-9.3-5M6 8c0 7-3 9-3 9h13M3 3l18 18',
  eye: 'M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7zM12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z',
  clock: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM12 7v5l3 2',
  info: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM12 11v5M12 8h.01',
  trash: 'M4 7h16M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2M6 7l1 13a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1l1-13',
  pencil: 'M4 20h4L18.5 9.5a2.12 2.12 0 0 0-3-3L5 17v3zM13.5 6.5l3 3',
  unread: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM12 12h.01',
  search: 'M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14zM20 20l-3.4-3.4',
  close: 'M6 6l12 12M18 6 6 18',
};
function CI({ name, className }) {
  const d = CI_PATHS[name];
  if (!d) return null;
  return (
    <svg className={`ci ${className || ''}`} viewBox="0 0 24 24" width="1em" height="1em" fill="none"
      stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {d.split('M').filter(Boolean).map((seg, i) => <path key={i} d={'M' + seg} />)}
    </svg>
  );
}
const fmtSize = (n) => n == null ? '' : (n < 1024 ? n + ' B' : n < 1048576 ? (n / 1024).toFixed(0) + ' KB' : (n / 1048576).toFixed(1) + ' MB');
const readFileAsBase64 = (file) => new Promise((res, rej) => {
  const r = new FileReader();
  r.onload = () => res(String(r.result).split(',')[1] || '');
  r.onerror = rej; r.readAsDataURL(file);
});
const initials = (name) => String(name || '?').split(/\s+/).map(w => w[0]).filter(Boolean).slice(0, 2).join('').toUpperCase();
const ago = (t) => {
  if (!t) return '';
  const s = (Date.now() - new Date(t).getTime()) / 1000;
  if (s < 90) return 'just now';
  if (s < 3600) return Math.floor(s / 60) + 'm ago';
  if (s < 86400) return Math.floor(s / 3600) + 'h ago';
  return Math.floor(s / 86400) + 'd ago';
};
const dayLabel = (t) => {
  const d = new Date(t), now = new Date();
  const midnight = (x) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diff = (midnight(now) - midnight(d)) / 86400000;
  if (diff === 0) return 'Today';
  if (diff === 1) return 'Yesterday';
  return d.toLocaleDateString([], { month: 'long', day: 'numeric', year: d.getFullYear() !== now.getFullYear() ? 'numeric' : undefined });
};
const timeShort = (t) => new Date(t).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });

/* Body renderer: entity chips (#Label) + @mention highlights. */
function renderBody(text, refs, onRef) {
  let nodes = [String(text)];
  (refs || []).forEach((ref, ri) => {
    const tag = '#' + ref.label;
    nodes = nodes.flatMap(n => {
      if (typeof n !== 'string') return [n];
      const segs = n.split(tag);
      return segs.flatMap((seg, i) => i < segs.length - 1
        ? [seg, <button key={`r${ri}-${i}`} className="entity-chip" title={ref.type} onClick={() => onRef && onRef(ref)}>
            <span>{REF_ICON[ref.type] || '#'}</span>{ref.label}
          </button>]
        : [seg]);
    });
  });
  return nodes.flatMap((n, i) => {
    if (typeof n !== 'string') return [n];
    const parts = n.split(/(@[A-Za-z][\w.'-]*(?:\s[A-Z][\w.'-]*)?)/g);
    return parts.map((p, k) => p && p.startsWith('@') ? <span key={`m${i}-${k}`} className="mention">{p}</span> : p);
  });
}

function groupReactions(list, me) {
  const map = new Map();
  (list || []).forEach(r => {
    const g = map.get(r.emoji) || { emoji: r.emoji, count: 0, mine: false, names: [] };
    g.count++;
    if (r.kind === me.kind && r.actor === me.id) g.mine = true;
    if (r.name) g.names.push(r.name);
    map.set(r.emoji, g);
  });
  return [...map.values()];
}

function Attachment({ m, download }) {
  const [url, setUrl] = useState(null);
  const [err, setErr] = useState(false);
  const [busy, setBusy] = useState(false);
  const [preview, setPreview] = useState(false);
  const auto = m.attachment_kind === 'image' || m.attachment_kind === 'audio' || m.attachment_kind === 'video';
  // Previewable, non-inline attachments (PDFs, plus any doc/text file) get a
  // "see it without downloading" affordance — same modal used everywhere else.
  const nm = String(m.attachment_name || '').toLowerCase();
  const canPreview = m.attachment_kind === 'pdf' || /\.(pdf|txt|csv|html?|json|png|jpe?g|gif|webp)$/.test(nm);
  useEffect(() => {
    let alive = true, obj = null;
    if (auto && m.attachment_document_id) {
      download(m.attachment_document_id)
        .then(({ blob }) => { if (!alive) return; obj = URL.createObjectURL(blob); setUrl(obj); })
        .catch(() => alive && setErr(true));
    }
    return () => { alive = false; if (obj) URL.revokeObjectURL(obj); };
    // eslint-disable-next-line
  }, [m.attachment_document_id]);
  async function saveIt() {
    setBusy(true);
    try {
      const { blob, filename } = await download(m.attachment_document_id);
      const u = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = u; a.download = filename || m.attachment_name || 'attachment';
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(u), 1500);
    } catch { setErr(true); }
    finally { setBusy(false); }
  }
  if (!m.attachment_document_id) return null;
  if (err) return <div className="msg-att-file">Attachment unavailable</div>;
  if (m.attachment_kind === 'image' && url)
    return <img className="msg-att-img" src={url} alt={m.attachment_name || 'photo'} onClick={saveIt} title="Click to download" />;
  if (m.attachment_kind === 'audio' && url) return <audio className="msg-att-audio" controls src={url} />;
  if (m.attachment_kind === 'video' && url) return <video className="msg-att-video" controls src={url} />;
  if (auto && !url) return <div className="msg-att-file">Loading media…</div>;
  return (
    <div className="row" style={{ gap: 4, alignItems: 'center', flexWrap: 'wrap' }}>
      <button className="msg-att-file" onClick={canPreview ? () => setPreview(true) : saveIt} disabled={busy} title={canPreview ? 'Preview' : 'Download'}>
        <span className="ic"><CI name="attach" /></span>
        <span className="nm">{m.attachment_name || 'Attachment'}</span>
        <span className="sz">{fmtSize(m.attachment_size)}{busy ? ' · downloading…' : ''}</span>
      </button>
      {canPreview && <button className="btn ghost small" onClick={saveIt} disabled={busy} title="Download">⤓</button>}
      {preview && (
        <DocPreview title={m.attachment_name || 'Attachment'} filename={m.attachment_name}
          load={() => download(m.attachment_document_id)}
          onDownload={saveIt} onClose={() => setPreview(false)} />
      )}
    </div>
  );
}

export default function ChatThread({ conversationId, surface, me, onChanged, onTaskCreated, onOpenApplication, height = '60vh' }) {
  const isStaff = surface === 'staff';
  const cid = conversationId;

  // API dispatch for the two surfaces (same shapes on both).
  const A = useMemo(() => isStaff ? {
    detail: () => api.staffConversation(cid),
    msgs: (before) => api.staffConvMessages(cid, before),
    send: (b) => api.staffConvSend(cid, b),
    read: (s) => api.staffConvRead(cid, s),
    markUnread: (s) => api.staffConvMarkUnread(cid, s),
    delivered: (s) => api.staffConvDelivered(cid, s),
    typing: () => api.staffConvTyping(cid, getConnId()),
    open: () => api.staffConvOpen(cid, getConnId()),
    draft: (b) => api.staffConvDraft(cid, b),
    react: (mid, e) => api.staffReact(mid, e),
    pin: (mid) => api.staffPinMessage(mid),
    edit: (mid, b) => api.staffEditMessage(mid, b),
    del: (mid) => api.staffDeleteMessage(mid),
    download: (d) => api.staffDownloadDoc(d),
    mentionables: (appId) => api.staffMentionables(appId),
    rename: (b) => api.staffUpdateConversation(cid, b),
    mute: (b) => api.staffConvMute(cid, b),
    shared: () => api.staffConvShared(cid),
    addMember: (sid) => api.staffConvAddMember(cid, sid),
    removeMember: (sid) => api.staffConvRemoveMember(cid, sid),
    search: (q) => api.staffChatSearch(q, cid),
  } : {
    detail: () => api.conversation(cid),
    msgs: (before) => api.convMessages(cid, before),
    send: (b) => api.convSend(cid, b),
    read: (s) => api.convRead(cid, s),
    markUnread: (s) => api.convMarkUnread(cid, s),
    delivered: (s) => api.convDelivered(cid, s),
    typing: () => api.convTyping(cid, getConnId()),
    open: () => api.convOpen(cid, getConnId()),
    draft: (b) => api.convDraft(cid, b),
    react: (mid, e) => api.react(mid, e),
    pin: null,
    edit: (mid, b) => api.editMessage(mid, b),
    del: (mid) => api.deleteMessage(mid),
    download: (d) => api.downloadDoc(d),
    mentionables: (appId) => api.mentionables(appId),
    rename: null, mute: null,
    shared: () => api.convShared(cid),
    addMember: null, removeMember: null, search: null,
  }, [cid, isStaff]);

  const [conv, setConv] = useState(null);
  const [msgs, setMsgs] = useState(null);
  const [members, setMembers] = useState([]);
  const [typers, setTypers] = useState({});          // key -> {name, until}
  const [body, setBody] = useState('');
  const [pending, setPending] = useState(null);      // attachment awaiting send
  const [replyTo, setReplyTo] = useState(null);      // message being quoted
  const [priority, setPriority] = useState('normal');
  const [makeTask, setMakeTask] = useState(false);
  const [editing, setEditing] = useState(null);
  const [reactFor, setReactFor] = useState(null);
  const [infoFor, setInfoFor] = useState(null);      // Message Info popover
  const [menuFor, setMenuFor] = useState(null);      // ⋯ action menu
  const [showRoster, setShowRoster] = useState(false);
  const [showShared, setShowShared] = useState(false);
  const [shared, setShared] = useState(null);
  const [searchQ, setSearchQ] = useState('');
  const [searchHits, setSearchHits] = useState(null);
  const [renaming, setRenaming] = useState(null);
  const [addingMember, setAddingMember] = useState(false);
  const [team, setTeam] = useState(null);
  const [newBelow, setNewBelow] = useState(0);
  const [recState, setRecState] = useState('idle');
  const [mentionables, setMentionables] = useState(null);
  const [picker, setPicker] = useState(null);
  const [pendingRefs, setPendingRefs] = useState([]);
  const [err, setErr] = useState('');
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [flashSeq, setFlashSeq] = useState(null);

  const scrollRef = useRef(null);
  const atBottomRef = useRef(true);
  const fileRef = useRef(null);
  const recRef = useRef(null);
  const myReadRef = useRef(0);            // my read watermark (client copy)
  const dividerRef = useRef(null);        // unread divider snapshot (seq)
  const typingSentRef = useRef(0);
  const draftTimer = useRef(null);
  const sendingRef = useRef(false);
  const msgsRef = useRef(null);
  msgsRef.current = msgs;

  const myKey = `${me.kind}:${me.id}`;
  const others = useMemo(() => members.filter(m => !(m.member_kind === me.kind && m.member_id === me.id)), [members, me]);

  /* ---------- load ---------- */
  const loadAll = useCallback(async () => {
    const [d, mm] = await Promise.all([A.detail(), A.msgs()]);
    setConv(d);
    setMembers(mm.members || d.members || []);
    setMsgs(mm.messages || []);
    const mine = (d.members || []).find(x => x.member_kind === me.kind && x.member_id === me.id);
    const lastRead = mine ? mine.last_read_seq : 0;
    myReadRef.current = lastRead;
    // Snapshot the divider ONCE per open — it must not chase the watermark
    // while the reader catches up.
    if (dividerRef.current == null) dividerRef.current = lastRead;
    if (!body && d.draft) setBody(d.draft);
    // Ack delivery for everything fetched.
    const maxSeq = (mm.messages || []).reduce((n, x) => Math.max(n, x.seq || 0), 0);
    if (maxSeq) A.delivered(maxSeq).catch(() => {});
    // eslint-disable-next-line
  }, [cid]);

  useEffect(() => {
    dividerRef.current = null;
    setMsgs(null); setConv(null); setErr(''); setReplyTo(null); setNewBelow(0);
    setSearchHits(null); setShowShared(false); setBody('');
    loadAll().catch(e => setErr(e.message));
    // Tell the SSE layer which conversation is on screen.
    const t = setTimeout(() => A.open().catch(() => {}), 600);
    return () => clearTimeout(t);
    // eslint-disable-next-line
  }, [cid]);

  useEffect(() => {
    if (mentionables == null && conv) A.mentionables(conv.applicationId).then(setMentionables).catch(() => {});
    // eslint-disable-next-line
  }, [conv]);

  /* ---------- realtime ---------- */
  useEffect(() => {
    const unsub = subscribeChat((event, data) => {
      if (event === 'reconnect') { loadAll().catch(() => {}); A.open().catch(() => {}); return; }
      if (event === 'hello') { A.open().catch(() => {}); return; }
      if (event === 'presence:diff' && data) {
        setMembers(ms => ms.map(m => `${m.member_kind}:${m.member_id}` === data.key
          ? { ...m, online: data.online, last_seen_at: data.lastSeenAt || m.last_seen_at } : m));
        return;
      }
      if (!data || data.conversationId !== cid) return;
      if (event === 'message:new') {
        const msg = data.message;
        setMsgs(list => {
          if (!list) return list;
          if (list.some(x => x.id === msg.id || (msg.client_msg_id && x.client_msg_id === msg.client_msg_id))) {
            return list.map(x => (x.id === msg.id || (msg.client_msg_id && x.client_msg_id === msg.client_msg_id)) ? msg : x);
          }
          return [...list, msg];
        });
        A.delivered(msg.seq).catch(() => {});
        const mineMsg = msg.sender_kind === me.kind && msg.sender_id === me.id;
        if (!mineMsg && !atBottomRef.current) setNewBelow(n => n + 1);
        // Someone spoke → they're no longer "typing".
        setTypers(t => { const c = { ...t }; delete c[`${msg.sender_kind}:${msg.sender_id}`]; return c; });
      } else if (event === 'message:edited') {
        setMsgs(list => list && list.map(x => x.id === data.message.id ? data.message : x));
      } else if (event === 'message:deleted') {
        setMsgs(list => list && list.map(x => x.id === data.messageId
          ? { ...x, deleted_at: new Date().toISOString(), body: '[message removed]', pinned: false, reactions: [] } : x));
      } else if (event === 'reaction:update') {
        setMsgs(list => list && list.map(x => x.id === data.messageId ? { ...x, reactions: data.reactions } : x));
      } else if (event === 'receipt:read' || event === 'receipt:delivered') {
        setMembers(ms => ms.map(m => (m.member_kind === data.memberKind && m.member_id === data.memberId)
          ? { ...m,
              last_read_seq: event === 'receipt:read' ? Math.max(m.last_read_seq, data.seq) : m.last_read_seq,
              last_read_at: event === 'receipt:read' ? (data.at || m.last_read_at) : m.last_read_at,
              last_delivered_seq: Math.max(m.last_delivered_seq, data.seq) }
          : m));
      } else if (event === 'typing') {
        const key = `${data.memberKind}:${data.memberId}`;
        if (key !== myKey) setTypers(t => ({ ...t, [key]: { name: data.name, until: Date.now() + 6000 } }));
      } else if (event === 'conversation:updated') {
        A.detail().then(d => { setConv(d); setMembers(d.members || []); }).catch(() => {});
        onChanged && onChanged();
      }
    });
    return unsub;
    // eslint-disable-next-line
  }, [cid]);

  // Expire stale typing bubbles even if the stop-signal is lost.
  useEffect(() => {
    const t = setInterval(() => setTypers(cur => {
      const now = Date.now();
      const next = Object.fromEntries(Object.entries(cur).filter(([, v]) => v.until > now));
      return Object.keys(next).length === Object.keys(cur).length ? cur : next;
    }), 1500);
    return () => clearInterval(t);
  }, []);

  /* ---------- read marking (only genuine engagement counts) ---------- */
  const maybeMarkRead = useCallback(() => {
    const list = msgsRef.current;
    if (!list || !list.length || !atBottomRef.current || !document.hasFocus()) return;
    const maxSeq = list.reduce((n, x) => Math.max(n, x.seq || 0), 0);
    if (maxSeq > myReadRef.current) {
      myReadRef.current = maxSeq;
      A.read(maxSeq).catch(() => {});
      onChanged && onChanged();
    }
    // eslint-disable-next-line
  }, [cid]);
  useEffect(() => { const t = setTimeout(maybeMarkRead, 400); return () => clearTimeout(t); }, [msgs, maybeMarkRead]);
  useEffect(() => {
    window.addEventListener('focus', maybeMarkRead);
    return () => window.removeEventListener('focus', maybeMarkRead);
  }, [maybeMarkRead]);

  /* ---------- scrolling ---------- */
  const scrollToBottom = useCallback((smooth) => {
    const el = scrollRef.current;
    if (el) el.scrollTo({ top: el.scrollHeight, behavior: smooth ? 'smooth' : 'auto' });
  }, []);
  const lastCount = useRef(-1);
  useEffect(() => {
    const n = msgs ? msgs.length : -1;
    const first = lastCount.current === -1 && n >= 0;
    const grew = n > lastCount.current && lastCount.current !== -1;
    lastCount.current = n;
    if (first) {
      // Land at the unread divider if there is one, else the bottom.
      const div = dividerRef.current;
      const firstUnread = div != null && msgs.find(m => m.seq > div && !(m.sender_kind === me.kind && m.sender_id === me.id));
      if (firstUnread) {
        const el = scrollRef.current && scrollRef.current.querySelector(`[data-seq="${firstUnread.seq}"]`);
        if (el) {
          // Center the first-unread message WITHIN the chat box only. Using
          // el.scrollIntoView() here scrolled every ancestor including the
          // window, dragging the whole loan-file page down to the chat (which
          // renders near the bottom) — the "opens scrolled to the bottom" bug.
          const c = scrollRef.current;
          c.scrollTop = (el.offsetTop - c.offsetTop) - c.clientHeight / 2 + el.clientHeight / 2;
          return;
        }
      }
      scrollToBottom(false);
    } else if (grew && atBottomRef.current) scrollToBottom(true);
    // eslint-disable-next-line
  }, [msgs]);
  function onScroll() {
    const el = scrollRef.current;
    if (!el) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 48;
    atBottomRef.current = atBottom;
    if (atBottom && newBelow) { setNewBelow(0); maybeMarkRead(); }
  }
  async function jumpToSeq(seq) {
    for (let i = 0; i < 6; i++) {
      const el = scrollRef.current && scrollRef.current.querySelector(`[data-seq="${seq}"]`);
      if (el) {
        el.scrollIntoView({ block: 'center', behavior: 'smooth' });
        setFlashSeq(seq); setTimeout(() => setFlashSeq(null), 1800);
        return;
      }
      const first = (msgsRef.current || [])[0];
      if (!first) return;
      // eslint-disable-next-line no-await-in-loop
      const more = await A.msgs(first.seq).catch(() => null);
      if (!more || !more.messages.length) return;
      setMsgs(list => [...more.messages, ...(list || [])]);
      // eslint-disable-next-line no-await-in-loop
      await new Promise(r => setTimeout(r, 60));
    }
  }
  async function loadOlder() {
    const first = (msgs || [])[0];
    if (!first || loadingOlder) return;
    setLoadingOlder(true);
    try {
      const more = await A.msgs(first.seq);
      if (more.messages.length) {
        const el = scrollRef.current; const keep = el ? el.scrollHeight - el.scrollTop : 0;
        setMsgs(list => [...more.messages, ...list]);
        requestAnimationFrame(() => { if (el) el.scrollTop = el.scrollHeight - keep; });
      }
    } finally { setLoadingOlder(false); }
  }

  /* ---------- composer ---------- */
  function onBodyChange(e) {
    const v = e.target.value;
    setBody(v);
    // WHO-is-typing: throttle one signal per 3s while keys are flowing.
    const now = Date.now();
    if (v.trim() && now - typingSentRef.current > 3000) { typingSentRef.current = now; A.typing().catch(() => {}); }
    // Draft sync (debounced) — survives tab close / device switch.
    clearTimeout(draftTimer.current);
    draftTimer.current = setTimeout(() => A.draft(v).catch(() => {}), 1200);
    // @/# picker
    const caret = e.target.selectionStart ?? v.length;
    const upto = v.slice(0, caret);
    const m = /(^|\s)([@#])([^@#\n]{0,40})$/.exec(upto);
    if (m) setPicker({ trigger: m[2], query: m[3], start: caret - m[3].length - 1 });
    else setPicker(null);
  }
  function pickerItems() {
    if (!picker || !mentionables) return [];
    const q = picker.query.toLowerCase();
    const match = (arr, type) => (arr || [])
      .filter(x => !q || String(x.label).toLowerCase().includes(q))
      .slice(0, 6).map(x => ({ ...x, type }));
    if (picker.trigger === '@') return match(mentionables.users, 'user');
    return [
      ...match(mentionables.tasks, 'task'),
      ...match(mentionables.documents, 'document'),
      ...match(mentionables.applications, 'application'),
    ].slice(0, 9);
  }
  function choosePick(item) {
    const label = item.label;
    const before = body.slice(0, picker.start);
    const after = body.slice(picker.start + 1 + picker.query.length);
    setBody(before + (picker.trigger === '@' ? '@' : '#') + label + ' ' + after);
    if (picker.trigger === '#') {
      setPendingRefs(refs => refs.some(r => r.id === item.id && r.type === item.type)
        ? refs : [...refs, { type: item.type, id: item.id, label }]);
    }
    setPicker(null);
  }
  async function onPickFile(e) {
    const f = e.target.files && e.target.files[0];
    if (!f) return;
    try {
      const dataBase64 = await readFileAsBase64(f);
      setPending({ filename: f.name, contentType: f.type || 'application/octet-stream', dataBase64, size: f.size });
      setErr('');
    } catch { setErr('Could not read that file.'); }
    finally { if (fileRef.current) fileRef.current.value = ''; }
  }
  async function toggleRecord() {
    if (recState === 'recording') { recRef.current && recRef.current.stop(); return; }
    if (!navigator.mediaDevices || !window.MediaRecorder) { setErr('Voice notes are not supported in this browser.'); return; }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const rec = new MediaRecorder(stream);
      const chunks = [];
      rec.ondataavailable = (ev) => ev.data.size && chunks.push(ev.data);
      rec.onstop = async () => {
        stream.getTracks().forEach(t => t.stop());
        setRecState('idle');
        const blob = new Blob(chunks, { type: rec.mimeType || 'audio/webm' });
        const dataBase64 = await readFileAsBase64(blob);
        setPending({ filename: 'voice-note.webm', contentType: blob.type, dataBase64, size: blob.size });
      };
      recRef.current = rec; rec.start(); setRecState('recording'); setErr('');
    } catch { setErr('Microphone access was denied.'); }
  }
  useEffect(() => () => {
    try {
      const r = recRef.current;
      if (r) { if (r.state && r.state !== 'inactive') r.stop(); if (r.stream) r.stream.getTracks().forEach(t => t.stop()); }
    } catch { /* ignore */ }
  }, []);

  async function submit(retryOf) {
    const text = retryOf ? retryOf.body : body.trim();
    const att = retryOf ? retryOf._attachment : pending;
    if (!text && !att) return;
    if (sendingRef.current && !retryOf) return;
    sendingRef.current = true;
    setErr('');
    const clientMsgId = retryOf ? retryOf.client_msg_id : `c${Date.now()}${Math.random().toString(36).slice(2, 8)}`;
    const usedRefs = pendingRefs.filter(r => text.includes('#' + r.label));
    const payload = {
      body: text, clientMsgId,
      attachment: att || undefined,
      entityRefs: usedRefs.length ? usedRefs : undefined,
      replyToMessageId: replyTo ? replyTo.id : (retryOf && retryOf.reply_to_message_id) || undefined,
      priority: isStaff && priority !== 'normal' ? priority : undefined,
      makeTask: isStaff && makeTask && conv && !conv.borrowerVisible ? true : undefined,
    };
    // Optimistic bubble (clock icon) — reconciled by ack or the SSE echo.
    const lastSeq = (msgsRef.current || []).reduce((n, x) => Math.max(n, x.seq || 0), 0);
    const local = {
      id: `local-${clientMsgId}`, client_msg_id: clientMsgId, seq: lastSeq + 0.5,
      sender_kind: me.kind, sender_id: me.id, sender_name: 'You',
      body: text, kind: 'text', priority: payload.priority || 'normal',
      created_at: new Date().toISOString(), reactions: [],
      reply_to_message_id: payload.replyToMessageId || null,
      reply_snippet: replyTo ? { sender: replyTo.sender_name, body: String(replyTo.body || '').slice(0, 160) } : (retryOf && retryOf.reply_snippet) || null,
      _status: 'sending', _attachment: att || null,
      attachment_kind: att ? (att.contentType.startsWith('image/') ? 'image' : att.contentType.startsWith('audio/') ? 'audio' : att.contentType.startsWith('video/') ? 'video' : 'file') : null,
      attachment_name: att ? att.filename : null,
    };
    setMsgs(list => retryOf
      ? (list || []).map(x => x.client_msg_id === clientMsgId ? { ...local } : x)
      : [...(list || []), local]);
    if (!retryOf) {
      setBody(''); setPending(null); setReplyTo(null); setPendingRefs([]); setPicker(null);
      setMakeTask(false); setPriority('normal');
      clearTimeout(draftTimer.current);
      A.draft('').catch(() => {});
      requestAnimationFrame(() => scrollToBottom(true));
    }
    try {
      const r = await A.send(payload);
      const serverMsg = r.message;
      myReadRef.current = Math.max(myReadRef.current, serverMsg.seq || 0);
      setMsgs(list => (list || []).map(x => x.client_msg_id === clientMsgId ? serverMsg : x));
      if (r.taskId && onTaskCreated) onTaskCreated(r.taskId);
      onChanged && onChanged();
    } catch (e) {
      setMsgs(list => (list || []).map(x => x.client_msg_id === clientMsgId ? { ...x, _status: 'failed', _error: e.message } : x));
      if (e.status === 400 && /security|social security/i.test(e.message || '')) {
        // PII block: remove the bubble entirely, surface the guidance.
        setMsgs(list => (list || []).filter(x => x.client_msg_id !== clientMsgId));
        setErr(e.message);
      }
    } finally { sendingRef.current = false; }
  }

  /* ---------- message actions ---------- */
  async function doReact(mid, emoji) {
    setReactFor(null);
    try { await A.react(mid, emoji); } catch { /* non-fatal; SSE will correct */ }
  }
  async function doPin(m) {
    if (!A.pin) return;
    try { await A.pin(m.id); const d = await A.detail(); setConv(d); setMembers(d.members || []); } catch { /* ignore */ }
  }
  async function saveEdit() {
    if (!editing || !editing.text.trim()) return;
    try { await A.edit(editing.id, editing.text.trim()); setEditing(null); } catch (e) { setErr(e.message); }
  }
  const [pendingDelete, setPendingDelete] = useState(null);   // {id, timer} — 5s undo window
  function doDelete(m) {
    setMenuFor(null);
    // Undo-able delete: hide locally, commit after 5 seconds unless undone.
    const timer = setTimeout(async () => {
      setPendingDelete(null);
      try { await A.del(m.id); } catch (e) { setErr(e.message); loadAll().catch(() => {}); }
    }, 5000);
    setPendingDelete({ id: m.id, timer });
  }
  function undoDelete() {
    if (pendingDelete) { clearTimeout(pendingDelete.timer); setPendingDelete(null); }
  }
  async function doMarkUnreadHere(m) {
    setMenuFor(null);
    try {
      await A.markUnread(m.seq);
      myReadRef.current = m.seq - 1;
      dividerRef.current = m.seq - 1;
      onChanged && onChanged();
    } catch (e) { setErr(e.message); }
  }
  function onRefClick(ref) {
    if (ref.type === 'document') {
      A.download(ref.id).then(({ blob, filename }) => {
        const u = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = u; a.download = filename || ref.label; document.body.appendChild(a); a.click(); a.remove();
        setTimeout(() => URL.revokeObjectURL(u), 1500);
      }).catch(() => {});
    } else if (ref.type === 'application' && onOpenApplication) onOpenApplication(ref.id);
  }
  async function doRename() {
    if (!A.rename || !renaming || !renaming.trim()) { setRenaming(null); return; }
    try { await A.rename({ name: renaming.trim() }); setRenaming(null); } catch (e) { setErr(e.message); }
  }
  async function toggleShared() {
    if (!showShared) { setShared(null); A.shared().then(setShared).catch(() => {}); }
    setShowShared(!showShared); setShowRoster(false); setSearchHits(null);
  }
  async function runSearch(e) {
    e && e.preventDefault();
    if (!A.search || searchQ.trim().length < 2) return;
    const r = await A.search(searchQ.trim()).catch(() => null);
    setSearchHits(r ? r.results : []);
  }

  /* ---------- derived render data ---------- */
  const sorted = useMemo(() => (msgs || []).slice().sort((a, b) => (a.seq || 0) - (b.seq || 0)), [msgs]);
  const divider = dividerRef.current;
  const firstUnreadSeq = useMemo(() => {
    if (divider == null) return null;
    const m = sorted.find(x => x.seq > divider && x.kind !== 'system' && !(x.sender_kind === me.kind && x.sender_id === me.id));
    return m ? m.seq : null;
  }, [sorted, divider, me]);

  // Ticks for MY messages, from the others' watermarks.
  function tickState(m) {
    const rel = others.filter(o => o.member_kind !== 'system');
    if (!rel.length) return { state: 'sent', readBy: [], total: 0 };
    const readBy = rel.filter(o => o.last_read_seq >= m.seq);
    const delivered = rel.filter(o => o.last_delivered_seq >= m.seq);
    const state = readBy.length === rel.length ? 'read'
      : readBy.length > 0 ? 'partread'
      : delivered.length === rel.length ? 'delivered' : 'sent';
    return { state, readBy, total: rel.length };
  }
  // Google-Chat-style avatar read markers: members sit under the last message
  // they've read and visibly move down as they catch up.
  const markersBySeq = useMemo(() => {
    const map = {};
    for (const o of others) {
      if (!o.last_read_seq) continue;
      (map[o.last_read_seq] = map[o.last_read_seq] || []).push(o);
    }
    return map;
  }, [others]);

  const typingNames = Object.values(typers).map(t => t.name).filter(Boolean);
  const onlineOthers = others.filter(o => o.online);
  const presenceLine = typingNames.length
    ? (typingNames.length === 1 ? `${typingNames[0]} is typing…` : 'Several people are typing…')
    : onlineOthers.length ? `${onlineOthers.map(o => o.name && o.name.split(' ')[0]).filter(Boolean).slice(0, 3).join(', ')} online`
    : (() => {
        const seen = others.map(o => o.last_seen_at).filter(Boolean).sort().pop();
        return seen ? `last seen ${ago(seen)}` : '';
      })();

  const items = pickerItems();
  const pinnedTop = conv && conv.pinned && conv.pinned[0];

  if (err && !conv) return <div role="alert" className="notice err">{err}</div>;
  if (!conv || msgs == null) return <div className="cv-thread muted" style={{ padding: 30 }}>Loading conversation…</div>;

  let lastDay = null, lastSender = null, lastAt = 0;
  const borrowerVisible = isStaff && (conv.borrowerVisible || conv.borrower_visible);

  return (
    <div className="cv-thread" style={{ height }}>
      {/* ---------- header ---------- */}
      <div className="cv-head">
        <div className="cv-head-main">
          <span className="cv-ava cv-head-ava" aria-hidden="true">{initials(conv.name)}</span>
          <div style={{ minWidth: 0 }}>
            {renaming != null ? (
              <form onSubmit={e => { e.preventDefault(); doRename(); }} className="row" style={{ gap: 6 }}>
                <input className="input" autoFocus value={renaming} onChange={e => setRenaming(e.target.value)}
                  onBlur={doRename} style={{ padding: '4px 8px', width: 220 }} />
              </form>
            ) : (
              <div className="cv-title" onClick={() => A.rename && setRenaming(conv.name)}
                title={A.rename ? 'Click to rename this chat' : undefined}
                style={A.rename ? { cursor: 'pointer' } : undefined}>
                {conv.name}{A.rename && <span className="cv-rename-hint">✎</span>}
              </div>
            )}
            <div className="cv-sub">
              {typingNames.length ? <span className="cv-typing-inline">{presenceLine}</span>
                : <>{onlineOthers.length > 0 && <span className="presence-dot inline" />} {presenceLine}</>}
              {conv.topic ? <span className="muted"> · {conv.topic}</span> : null}
            </div>
          </div>
        </div>
        <div className="cv-head-actions">
          <button className="cv-avastack" onClick={() => { setShowRoster(!showRoster); setShowShared(false); }}
            title="Who's in this chat">
            {members.slice(0, 4).map(m => (
              <span key={m.member_kind + m.member_id} className={`cv-ava small ${m.online ? 'online' : ''}`}>{initials(m.name)}</span>
            ))}
            <span className="cv-count">{members.length}</span>
          </button>
          {A.search && (
            <form onSubmit={runSearch}>
              <input className="input cv-search" placeholder="Search…" value={searchQ}
                onChange={e => setSearchQ(e.target.value)} />
            </form>
          )}
          <button className="btn ghost small cv-iconbtn" onClick={toggleShared} title="Files, media & links shared here"><CI name="folder" /></button>
          {A.mute && <MuteButton conv={conv} A={A} members={members} me={me} />}
        </div>
      </div>

      {borrowerVisible && (
        <div className="cv-visible-banner"><CI name="eye" /> Visible to the borrower — everything here is part of their file</div>
      )}
      {pinnedTop && (
        <button className="cv-pinned" onClick={() => jumpToSeq(pinnedTop.seq)} title="Jump to pinned message">
          <CI name="pin" /> <strong>{pinnedTop.sender_name}:</strong>&nbsp;
          <span className="cv-pin-body">{pinnedTop.body ? pinnedTop.body.slice(0, 120) : 'Attachment'}</span>
        </button>
      )}

      {/* ---------- roster / shared / search panels ---------- */}
      {showRoster && (
        <div className="cv-panel">
          <div className="row" style={{ marginBottom: 8 }}>
            <strong>Members ({members.length})</strong>
            <div className="spacer" />
            {A.addMember && (conv.kind === 'custom'
              ? <button className="btn ghost small" onClick={async () => {
                  setAddingMember(!addingMember);
                  if (!team) { try { setTeam(await api.staffTeam()); } catch { /* ignore */ } }
                }}>+ Add</button>
              : <span className="muted small">roster follows the file assignment</span>)}
          </div>
          {addingMember && team && (
            <div className="row" style={{ flexWrap: 'wrap', gap: 6, marginBottom: 10 }}>
              {team.filter(s => !members.some(m => m.member_kind === 'staff' && m.member_id === s.id)).map(s => (
                <button key={s.id} className="btn ghost small"
                  onClick={async () => { try { await A.addMember(s.id); setAddingMember(false); } catch (e) { setErr(e.message); } }}>
                  + {s.full_name}
                </button>
              ))}
            </div>
          )}
          {members.map(m => (
            <div key={m.member_kind + m.member_id} className="cv-member">
              <span className={`cv-ava ${m.online ? 'online' : ''}`}>{initials(m.name)}</span>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div>{m.name} <span className="muted small">· {m.role_label || m.member_kind}</span>
                  {m.status_text && <span className="muted small"> · {m.status_emoji} {m.status_text}</span>}
                </div>
                <div className="muted small">{m.online ? '● online now' : m.last_seen_at ? `last seen ${ago(m.last_seen_at)}` : 'not seen yet'}</div>
              </div>
              {A.removeMember && conv.kind === 'custom' && m.member_kind === 'staff' && m.member_id !== me.id && (
                <button className="btn link small" onClick={async () => { try { await A.removeMember(m.member_id); } catch (e) { setErr(e.message); } }}>Remove</button>
              )}
            </div>
          ))}
        </div>
      )}
      {showShared && (
        <div className="cv-panel">
          <strong>Shared in this chat</strong>
          {!shared ? <p className="muted small">Loading…</p> : (
            <>
              {shared.media.length + shared.files.length + shared.links.length === 0 && <p className="muted small">Nothing shared yet.</p>}
              {[...shared.media, ...shared.files].map(f => (
                <div key={f.document_id} className="cv-member" style={{ cursor: 'pointer' }} onClick={() => jumpToSeq(f.seq)}>
                  <span className="ic">{f.attachment_kind === 'image' ? '🖼' : f.attachment_kind === 'video' ? '🎬' : f.attachment_kind === 'audio' ? '🎤' : f.attachment_kind === 'pdf' ? '⎙' : '📎'}</span>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{f.filename}</div>
                    <div className="muted small">{f.sender_name} · {new Date(f.created_at).toLocaleDateString()} · {fmtSize(f.size_bytes)}</div>
                  </div>
                </div>
              ))}
              {shared.links.map((l, i) => (
                <div key={i} className="cv-member" style={{ cursor: 'pointer' }} onClick={() => jumpToSeq(l.seq)}>
                  <span className="ic">🔗</span>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <a href={l.url} target="_blank" rel="noreferrer" onClick={e => e.stopPropagation()}>{l.url.slice(0, 70)}</a>
                    <div className="muted small">{l.sender_name} · {new Date(l.created_at).toLocaleDateString()}</div>
                  </div>
                </div>
              ))}
            </>
          )}
        </div>
      )}
      {searchHits && (
        <div className="cv-panel">
          <div className="row"><strong>{searchHits.length} result{searchHits.length === 1 ? '' : 's'}</strong>
            <div className="spacer" /><button className="btn link small" onClick={() => setSearchHits(null)}>Close</button></div>
          {searchHits.map(h => (
            <div key={h.id} className="cv-member" style={{ cursor: 'pointer' }} onClick={() => { setSearchHits(null); jumpToSeq(h.seq); }}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div className="muted small">{h.sender_name} · {new Date(h.created_at).toLocaleString()}</div>
                <div style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{h.body}</div>
              </div>
            </div>
          ))}
        </div>
      )}

      {err && <div role="alert" className="notice err" style={{ margin: '8px 12px' }}>{err} <button className="btn link small" onClick={() => setErr('')}>Dismiss</button></div>}

      {/* ---------- messages ---------- */}
      <div className="cv-scroll" ref={scrollRef} onScroll={onScroll}>
        {sorted.length >= 60 && (
          <div style={{ textAlign: 'center', padding: 6 }}>
            <button className="btn ghost small" onClick={loadOlder} disabled={loadingOlder}>
              {loadingOlder ? 'Loading…' : 'Load earlier messages'}
            </button>
          </div>
        )}
        {sorted.length === 0 && <p className="muted small" style={{ textAlign: 'center', marginTop: 30 }}>No messages yet — send the first message.</p>}
        {sorted.map((m) => {
          const isMine = m.sender_kind === me.kind && m.sender_id === me.id;
          const day = dayLabel(m.created_at);
          const showDay = day !== lastDay; lastDay = day;
          const grouped = !showDay && lastSender === `${m.sender_kind}:${m.sender_id}` &&
            (new Date(m.created_at) - lastAt) < 4 * 60 * 1000 && m.kind === 'text';
          lastSender = `${m.sender_kind}:${m.sender_id}`; lastAt = new Date(m.created_at).getTime();
          const rx = groupReactions(m.reactions, me);
          const ticks = isMine && m.kind === 'text' ? tickState(m) : null;
          const markers = markersBySeq[m.seq];
          const isDivider = firstUnreadSeq != null && m.seq === firstUnreadSeq;
          const hiddenByUndo = pendingDelete && pendingDelete.id === m.id;

          if (m.kind === 'system' || m.kind === 'milestone') {
            lastSender = null;
            return (
              <React.Fragment key={m.id}>
                {showDay && <div className="cv-day"><span>{day}</span></div>}
                <div className={`cv-system ${m.kind === 'milestone' ? 'milestone' : ''}`}><span className="cv-sys-dot" aria-hidden="true" />{m.body}</div>
              </React.Fragment>
            );
          }
          return (
            <React.Fragment key={m.id}>
              {showDay && <div className="cv-day"><span>{day}</span></div>}
              {isDivider && <div className="cv-unread-divider"><span>New messages</span></div>}
              {!hiddenByUndo && (
              <div className={`cv-row ${isMine ? 'me' : 'them'} ${grouped ? 'grouped' : ''} ${flashSeq === m.seq ? 'flash' : ''}`}
                data-seq={m.seq}>
                {!isMine && <span className="cv-ava msg" title={m.sender_name}>{grouped ? '' : initials(m.sender_name)}</span>}
                <div className={`cv-bubble ${isMine ? 'me' : 'them'} ${m.priority === 'urgent' ? 'urgent' : m.priority === 'important' ? 'important' : ''}`}>
                  {m.priority === 'urgent' && <div className="cv-priority">Urgent</div>}
                  {m.priority === 'important' && <div className="cv-priority imp">Important</div>}
                  {m.pinned && <div className="cv-pin-flag"><CI name="pin" /> Pinned</div>}
                  {!isMine && !grouped && <div className="msg-from">{m.sender_name || 'Member'}</div>}
                  {m.reply_snippet && (
                    <button className="cv-quote" onClick={() => m.reply_to_message_id && jumpToSeq((sorted.find(x => x.id === m.reply_to_message_id) || {}).seq || m.seq)}>
                      <strong>{m.reply_snippet.sender}</strong>
                      <span>{m.reply_snippet.body || (m.reply_snippet.attachmentKind ? '📎 Attachment' : '')}</span>
                    </button>
                  )}
                  <Attachment m={m} download={A.download} />
                  {editing && editing.id === m.id ? (
                    <div style={{ margin: '4px 0' }}>
                      <textarea className="input" autoFocus rows={2} value={editing.text}
                        style={{ minHeight: 56 }}
                        onChange={e => setEditing({ id: m.id, text: e.target.value })} />
                      <div className="row" style={{ gap: 6, marginTop: 6 }}>
                        <button className="btn primary small" onClick={saveEdit} disabled={!editing.text.trim()}>Save</button>
                        <button className="btn ghost small" onClick={() => setEditing(null)}>Cancel</button>
                      </div>
                    </div>
                  ) : m.body && <div className="msg-body" style={m.deleted_at ? { fontStyle: 'italic', opacity: .6 } : undefined}>
                    {renderBody(m.body, m.entity_refs, onRefClick)}
                  </div>}
                  {m.checklist_item_id && (
                    <div className="msg-task">✦ Saved as task{m.task_label ? `: ${m.task_label.slice(0, 60)}` : ''}{m.task_status ? ` · ${m.task_status}` : ''}</div>
                  )}
                  <div className="msg-time">
                    {timeShort(m.created_at)}
                    {m.edited_at && ' · edited'}
                    {m._status === 'sending' && <span className="cv-tick" title="Sending…"> <CI name="clock" /></span>}
                    {m._status === 'failed' && (
                      <span className="cv-fail"> failed · <button className="btn link small" onClick={() => submit(m)}>retry</button></span>
                    )}
                    {ticks && !m._status && (
                      <span className={`cv-tick ${ticks.state}`}
                        title={ticks.state === 'read' ? 'Read by everyone'
                          : ticks.state === 'partread' ? `Read by ${ticks.readBy.length} of ${ticks.total}`
                          : ticks.state === 'delivered' ? 'Delivered' : 'Sent'}>
                        {ticks.state === 'sent' ? ' ✓' : ' ✓✓'}
                        {ticks.state === 'partread' && <span className="cv-partial"> {ticks.readBy.length}/{ticks.total}</span>}
                      </span>
                    )}
                    {!m.deleted_at && !m._status && (
                      <span className="msg-actions">
                        {/* One-tap quick reactions right on hover (owner-directed
                            2026-07-14): hover a message and thumbs-up it directly,
                            no extra click. 🙂 still opens the full picker. */}
                        {QUICK_EMOJI.slice(0, 3).map(e => (
                          <button key={e} className="msg-quickrx" title={`React ${e}`} aria-label={`React with ${e}`} onClick={() => doReact(m.id, e)}>{e}</button>
                        ))}
                        <button title="More reactions" onClick={() => setReactFor(reactFor === m.id ? null : m.id)}><CI name="smile" /></button>
                        <button title="Reply" onClick={() => setReplyTo(m)}><CI name="reply" /></button>
                        {A.pin && <button title={m.pinned ? 'Unpin' : 'Pin'} onClick={() => doPin(m)}><CI name="pin" /></button>}
                        <button title="More" onClick={() => setMenuFor(menuFor === m.id ? null : m.id)}><CI name="more" /></button>
                      </span>
                    )}
                  </div>
                  {menuFor === m.id && (
                    <div className="cv-menu">
                      {isMine && m.kind === 'text' && <button onClick={() => { setEditing({ id: m.id, text: m.body || '' }); setMenuFor(null); }}><CI name="pencil" /> Edit</button>}
                      {isMine && <button onClick={() => doDelete(m)}><CI name="trash" /> Delete</button>}
                      <button onClick={() => { setInfoFor(infoFor === m.id ? null : m.id); setMenuFor(null); }}><CI name="info" /> Message info</button>
                      <button onClick={() => doMarkUnreadHere(m)}><CI name="unread" /> Mark unread from here</button>
                    </div>
                  )}
                  {infoFor === m.id && (
                    <div className="cv-info">
                      <div className="row"><strong>Message info</strong><div className="spacer" />
                        <button className="btn link small" onClick={() => setInfoFor(null)}>Close</button></div>
                      {others.map(o => (
                        <div key={o.member_kind + o.member_id} className="cv-info-row">
                          <span className="cv-ava small">{initials(o.name)}</span>
                          <span style={{ flex: 1 }}>{o.name}</span>
                          <span className="muted small">
                            {o.last_read_seq >= m.seq ? `✓✓ Read${o.last_read_at ? ' · ' + new Date(o.last_read_at).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : ''}`
                              : o.last_delivered_seq >= m.seq ? '✓✓ Delivered' : '✓ Sent'}
                          </span>
                        </div>
                      ))}
                    </div>
                  )}
                  {(rx.length > 0 || reactFor === m.id) && (
                    <div className="msg-rx-row">
                      {rx.map(g => (
                        <button key={g.emoji} className={`msg-rx ${g.mine ? 'mine' : ''}`}
                          title={g.names.join(', ')} onClick={() => doReact(m.id, g.emoji)}>
                          {g.emoji} {g.count}
                        </button>
                      ))}
                      {reactFor === m.id && (
                        <span className="msg-rx-pick" style={{ position: 'static', display: 'inline-flex' }}>
                          {QUICK_EMOJI.map(e => <button key={e} aria-label={`React with ${e}`} onClick={() => doReact(m.id, e)}>{e}</button>)}
                        </span>
                      )}
                    </div>
                  )}
                </div>
              </div>
              )}
              {markers && markers.length > 0 && (
                <div className={`cv-readmarks ${isMine ? 'me' : ''}`}>
                  {markers.slice(0, 5).map(o => (
                    <span key={o.member_kind + o.member_id} className="cv-ava tiny"
                      title={`${o.name} read up to here${o.last_read_at ? ' · ' + ago(o.last_read_at) : ''}`}>
                      {initials(o.name)}
                    </span>
                  ))}
                  {markers.length > 5 && <span className="cv-ava tiny">+{markers.length - 5}</span>}
                </div>
              )}
            </React.Fragment>
          );
        })}
        {typingNames.length > 0 && (
          <div className="cv-row them">
            <span className="cv-ava msg" title={typingNames.join(', ')}>{initials(typingNames[0])}</span>
            <div className="cv-bubble them cv-typing-bubble" aria-label={`${typingNames.join(', ')} typing`}>
              <span className="cv-dot" /><span className="cv-dot" /><span className="cv-dot" />
            </div>
          </div>
        )}
      </div>

      {newBelow > 0 && (
        <button className="cv-newpill" onClick={() => { scrollToBottom(true); setNewBelow(0); }}>
          {newBelow} new message{newBelow === 1 ? '' : 's'} ↓
        </button>
      )}
      {pendingDelete && (
        <div className="cv-undo">Message deleted · <button className="btn link small" onClick={undoDelete}>Undo</button></div>
      )}

      {/* ---------- composer ---------- */}
      <div className={`cv-composer ${borrowerVisible ? 'borrower-visible' : ''}`}>
        {replyTo && (
          <div className="cv-replying">
            ↩ Replying to <strong>{replyTo.sender_name}</strong>: {String(replyTo.body || 'attachment').slice(0, 80)}
            <button className="btn link small" onClick={() => setReplyTo(null)}>×</button>
          </div>
        )}
        {pending && (
          <div className="msg-pending">
            <span className="ic">{pending.contentType.startsWith('audio/') ? '🎤' : pending.contentType.startsWith('image/') ? '🖼' : pending.contentType.startsWith('video/') ? '🎬' : '📎'}</span>
            <span className="nm">{pending.filename}</span>
            <span className="sz">{fmtSize(pending.size)}</span>
            <button className="btn link small" onClick={() => setPending(null)}>Remove</button>
          </div>
        )}
        <div style={{ position: 'relative' }}>
          {picker && items.length > 0 && (
            <div className="mention-menu">
              {items.map(it => (
                <button key={it.type + it.id} className="mention-item" onMouseDown={e => { e.preventDefault(); choosePick(it); }}>
                  <span className="t">{it.type === 'user' ? '@' : REF_ICON[it.type] || '#'}</span>
                  <span className="l">{it.label}</span>
                  <span className="k">{it.type}{it.status ? ` · ${it.status}` : ''}</span>
                </button>
              ))}
            </div>
          )}
          <div className="row" style={{ gap: 8, alignItems: 'center' }}>
            <input ref={fileRef} type="file" style={{ display: 'none' }}
              accept="image/*,video/*,audio/*,.pdf,.doc,.docx,.xls,.xlsx,.csv,.txt,.zip" onChange={onPickFile} />
            <button className="btn ghost msg-tool" title="Attach a photo, video, PDF or file" onClick={() => fileRef.current && fileRef.current.click()}><CI name="attach" /></button>
            <button className={`btn ghost msg-tool ${recState === 'recording' ? 'rec' : ''}`}
              title={recState === 'recording' ? 'Stop recording' : 'Record a voice note'} onClick={toggleRecord}>
              {recState === 'recording' ? <CI name="stop" /> : <CI name="mic" />}
            </button>
            {isStaff && (
              <button className={`btn ghost msg-tool cv-prio ${priority}`}
                title={priority === 'normal' ? 'Mark as important / urgent' : priority === 'important' ? 'Important — click for urgent' : 'Urgent — re-notifies every 2 min until read'}
                onClick={() => setPriority(p => p === 'normal' ? 'important' : p === 'important' ? 'urgent' : 'normal')}>
                !
              </button>
            )}
            <input className="input" placeholder={recState === 'recording' ? 'Recording voice note…' : `Message ${conv.name}`}
              value={body} onChange={onBodyChange}
              onKeyDown={e => {
                if (picker && items.length && (e.key === 'Tab' || e.key === 'Enter')) { e.preventDefault(); choosePick(items[0]); return; }
                if (e.key === 'Escape') { setPicker(null); setReplyTo(null); }
                if (e.key === 'Enter' && !e.shiftKey && (!picker || !items.length)) submit();
              }} />
            <button className="btn primary" disabled={!body.trim() && !pending} onClick={() => submit()}>Send</button>
          </div>
        </div>
        {isStaff && conv && !(conv.borrowerVisible || conv.borrower_visible) && (
          <label className="muted small" style={{ display: 'flex', gap: 6, alignItems: 'center', marginTop: 6, cursor: 'pointer' }}>
            <input type="checkbox" checked={makeTask} onChange={e => setMakeTask(e.target.checked)} />
            Also save this message as a task on the file
          </label>
        )}
      </div>
    </div>
  );
}

function MuteButton({ conv, A, members, me }) {
  const mine = members.find(m => m.member_kind === me.kind && m.member_id === me.id);
  const muted = mine && mine.muted_until && new Date(mine.muted_until) > new Date();
  const [open, setOpen] = useState(false);
  return (
    <span style={{ position: 'relative' }}>
      <button className="btn ghost small cv-iconbtn" title={muted ? 'Muted — click to change' : 'Mute notifications for this chat'}
        onClick={() => setOpen(!open)}>{muted ? <CI name="bellOff" /> : <CI name="bell" />}</button>
      {open && (
        <div className="cv-menu" style={{ right: 0, top: '110%' }}>
          <button onClick={() => { A.mute({ minutes: 60 }).catch(() => {}); setOpen(false); }}>Mute 1 hour</button>
          <button onClick={() => { A.mute({ minutes: 480 }).catch(() => {}); setOpen(false); }}>Mute 8 hours</button>
          <button onClick={() => { A.mute({ forever: true }).catch(() => {}); setOpen(false); }}>Mute always</button>
          <button onClick={() => { A.mute({}).catch(() => {}); setOpen(false); }}>Unmute</button>
        </div>
      )}
    </span>
  );
}
