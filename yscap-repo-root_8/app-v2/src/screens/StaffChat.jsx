import React, { useEffect, useMemo, useRef, useState, useCallback } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { api } from '../lib/api.js';
import { useSubmitGate } from '../lib/useSubmitGate.js';
import { useAuth } from '../lib/auth.jsx';
import { subscribeChat } from '../lib/chatEvents.js';
import ChatThread from '../components/ChatThread.jsx';

/* Chat hub — a real two-pane chat app. Left: every conversation I can see,
   grouped by loan file (each file carries its Borrower chat, Loan Team chat,
   Officer ↔ Processor chat, and any custom group chats). Right: the open
   thread. Live over SSE: unread badges, presence dots, previews. */

const addrLine = (a) => !a ? '' : (a.oneLine || [a.street, a.city, a.state].filter(Boolean).join(', ') || '');
const ago = (t) => {
  if (!t) return '';
  const s = (Date.now() - new Date(t).getTime()) / 1000;
  if (s < 60) return 'now';
  if (s < 3600) return Math.floor(s / 60) + 'm';
  if (s < 86400) return Math.floor(s / 3600) + 'h';
  return Math.floor(s / 86400) + 'd';
};
const initials = (name) => String(name || '?').split(/\s+/).map(w => w[0]).filter(Boolean).slice(0, 2).join('').toUpperCase();
const MEDIA_LABEL = { image: '🖼 Photo', video: '🎬 Video', audio: '🎤 Voice note', pdf: '⎙ PDF', file: '📎 File' };

function preview(c) {
  if (c.draft_body) return { draft: true, text: `Draft: ${c.draft_body.slice(0, 70)}` };
  if (!c.last_body && !c.last_attachment_kind) return { text: 'No messages yet' };
  if (c.last_kind === 'system') return { text: c.last_body.slice(0, 80), system: true };
  const who = c.last_sender_name ? `${c.last_sender_name.split(' ')[0]}: ` : '';
  return { text: who + (c.last_body ? c.last_body.slice(0, 70) : MEDIA_LABEL[c.last_attachment_kind] || '…') };
}

const KIND_FILTERS = [
  ['all', 'All'], ['unread', 'Unread'], ['borrower', 'Borrower'], ['internal', 'Internal'],
];

export default function StaffChat() {
  const nav = useNavigate();
  const { search } = useLocation();
  const { actor } = useAuth();
  const me = { kind: 'staff', id: actor?.id };
  const openId = new URLSearchParams(search).get('c');

  const [rows, setRows] = useState(null);
  const [err, setErr] = useState('');
  const [filter, setFilter] = useState('all');
  const [q, setQ] = useState('');
  const [creating, setCreating] = useState(null);      // appId for the new-chat modal
  const [statusOpen, setStatusOpen] = useState(false);

  const refetchTimer = useRef(null);
  const load = useCallback(() => api.staffConversations()
    .then(r => setRows(r.conversations || []))
    .catch(e => setErr(e.message)), []);
  useEffect(() => { load(); }, [load]);

  // Live updates: any chat event re-syncs the list (debounced — SSE bursts on
  // busy mornings shouldn't hammer the API).
  useEffect(() => {
    const unsub = subscribeChat((event, data) => {
      if (event === 'presence:diff' && data) {
        setRows(rs => rs && rs.map(c => ({
          ...c,
          members: (c.members || []).map(m => `${m.kind}:${m.id}` === data.key ? { ...m, online: data.online } : m),
        })));
        return;
      }
      if (['message:new', 'unread:update', 'conversation:updated', 'reconnect'].includes(event)) {
        clearTimeout(refetchTimer.current);
        refetchTimer.current = setTimeout(load, 700);
      }
    });
    return () => { unsub(); clearTimeout(refetchTimer.current); };
  }, [load]);

  /* Group conversations under their loan file, newest activity first. */
  const groups = useMemo(() => {
    if (!rows) return [];
    const needle = q.trim().toLowerCase();
    const byApp = new Map();
    for (const c of rows) {
      if (filter === 'unread' && !c.unread) continue;
      if (filter === 'borrower' && !c.borrower_visible) continue;
      if (filter === 'internal' && c.borrower_visible) continue;
      if (needle) {
        const hay = `${c.name} ${c.borrower_first || ''} ${c.borrower_last || ''} ${addrLine(c.property_address)} ${c.ys_loan_number || ''} ${c.last_body || ''}`.toLowerCase();
        if (!hay.includes(needle)) continue;
      }
      const g = byApp.get(c.application_id) || {
        appId: c.application_id, loanNo: c.ys_loan_number, status: c.app_status,
        borrower: `${c.borrower_first || ''} ${c.borrower_last || ''}`.trim(),
        address: addrLine(c.property_address), convs: [], lastAt: 0, unread: 0,
      };
      g.convs.push(c);
      g.unread += c.unread || 0;
      g.lastAt = Math.max(g.lastAt, c.last_at ? new Date(c.last_at).getTime() : 0);
      byApp.set(c.application_id, g);
    }
    const KIND_ORDER = { borrower: 0, internal: 1, lo_processor: 2, custom: 3 };
    for (const g of byApp.values())
      g.convs.sort((a, b) => (KIND_ORDER[a.kind] ?? 9) - (KIND_ORDER[b.kind] ?? 9) || new Date(a.created_at || 0) - new Date(b.created_at || 0));
    return [...byApp.values()].sort((a, b) => (b.unread > 0) - (a.unread > 0) || b.lastAt - a.lastAt);
  }, [rows, filter, q]);

  const openConv = useMemo(() => rows && rows.find(c => c.id === openId), [rows, openId]);
  const totalUnread = (rows || []).reduce((n, c) => n + (c.unread || 0), 0);

  function openChat(cid) { nav(`/internal/chat?c=${cid}`, { replace: false }); }

  if (err && !rows) return <div role="alert" className="notice err">{err}</div>;

  return (
    <div className={`cv-hub ${openId ? 'thread-open' : ''}`}>
      {/* ------------ left: conversation list ------------ */}
      <div className="cv-list">
        <div className="row" style={{ alignItems: 'center', marginBottom: 10 }}>
          <h1 style={{ margin: 0, fontSize: 22 }}>Chats</h1>
          {totalUnread > 0 && <span className="chat-badge" style={{ marginLeft: 8 }}>{totalUnread}</span>}
          <div className="spacer" />
          <span style={{ position: 'relative' }}>
            <button className="btn ghost small" title="Set your status" onClick={() => setStatusOpen(!statusOpen)}>Status</button>
            {statusOpen && <StatusPicker onClose={() => setStatusOpen(false)} />}
          </span>
        </div>
        <input className="input" style={{ marginBottom: 8 }} value={q} onChange={e => setQ(e.target.value)}
          placeholder="Search chats, borrowers, addresses…" />
        <div className="tabs" style={{ marginBottom: 10 }}>
          {KIND_FILTERS.map(([k, label]) => (
            <button key={k} className={`tab ${filter === k ? 'on' : ''}`} onClick={() => setFilter(k)}>{label}</button>
          ))}
        </div>

        <div className="cv-list-scroll">
          {rows == null && <p className="muted small" style={{ padding: 12 }}>Loading conversations…</p>}
          {rows != null && groups.length === 0 && (
            <p className="muted small" style={{ padding: 12 }}>
              {filter === 'unread' ? "You're all caught up." : 'No conversations match.'}
            </p>
          )}
          {groups.map(g => (
            <div key={g.appId} className="cv-group">
              <div className="cv-group-head">
                <span className="cv-group-name">{g.borrower || 'Borrower'}</span>
                <span className="muted small cv-group-addr">{g.address}{g.loanNo ? ` · ${g.loanNo}` : ''}</span>
                <div className="spacer" />
                <button className="btn link small" title="New group chat on this file" onClick={() => setCreating(g.appId)}>＋</button>
              </div>
              {g.convs.map(c => {
                const p = preview(c);
                const muted = c.muted_until && new Date(c.muted_until) > new Date();
                return (
                  <button key={c.id} className={`cv-item ${c.id === openId ? 'active' : ''} ${c.unread ? 'unread' : ''}`}
                    onClick={() => openChat(c.id)}>
                    <span className="cv-item-ava" aria-hidden="true">{c.borrower_visible ? initials(c.name) : '#'}</span>
                    <div className="cv-item-main">
                      <div className="cv-item-top">
                        <span className="cv-item-name">{c.name}</span>
                        <span className="cv-item-avas">
                          {(c.members || []).slice(0, 3).map(m => (
                            <span key={m.kind + m.id} className={`cv-ava tiny ${m.online ? 'online' : ''}`} title={`${m.name}${m.online ? ' · online' : ''}`}>
                              {initials(m.name)}
                            </span>
                          ))}
                          {(c.members || []).length > 3 && <span className="muted small">+{c.members.length - 3}</span>}
                        </span>
                        <div className="spacer" />
                        <span className="muted small">{ago(c.last_at)}</span>
                      </div>
                      <div className="cv-item-prev">
                        {c.borrower_visible && <span className="cv-eye" title="Visible to the borrower" aria-hidden="true" />}
                        <span className={p.draft ? 'cv-draft' : p.system ? 'muted' : ''} style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{p.text}</span>
                        <div className="spacer" />
                        {muted && <span className="cv-muted-tag" title="Muted">Muted</span>}
                        {c.unread > 0 && <span className={`chat-badge ${c.borrower_visible ? '' : 'gold'}`}>{c.unread}</span>}
                      </div>
                    </div>
                  </button>
                );
              })}
            </div>
          ))}
        </div>
      </div>

      {/* ------------ right: open thread ------------ */}
      <div className="cv-pane">
        {openId ? (
          <>
            <button className="btn ghost small cv-back" onClick={() => nav('/internal/chat')}>← All chats</button>
            {openConv && (
              <div className="cv-pane-context">
                <a href={`#/internal/app/${openConv.application_id}`} title="Open the loan file">
                  📂 {openConv.borrower_first} {openConv.borrower_last} — {addrLine(openConv.property_address)}{openConv.ys_loan_number ? ` · ${openConv.ys_loan_number}` : ''}
                </a>
              </div>
            )}
            <ChatThread key={openId} conversationId={openId} surface="staff" me={me}
              height="calc(100vh - 260px)"
              onChanged={() => { clearTimeout(refetchTimer.current); refetchTimer.current = setTimeout(load, 500); }}
              onOpenApplication={(aid) => { window.location.hash = '#/internal/app/' + aid; }} />
          </>
        ) : (
          <div className="cv-empty">
            <div className="cv-empty-mark" aria-hidden="true" />
            <h3>Pick a conversation</h3>
            <p className="muted small">Every loan file has a borrower chat, a Loan Team chat, and an Officer ↔ Processor chat —
              plus any group chats you create. Unread rises to the top.</p>
          </div>
        )}
      </div>

      {creating && <NewChatModal appId={creating} onClose={() => setCreating(null)}
        onCreated={(cid) => { setCreating(null); load().then(() => openChat(cid)); }} />}
    </div>
  );
}

/* Quick custom-status picker (Slack/Teams-style, with auto-expiry). */
function StatusPicker({ onClose }) {
  const [emoji, setEmoji] = useState('🏠');
  const [text, setText] = useState('');
  const [hours, setHours] = useState(4);
  const PRESETS = [
    ['🏠', 'Touring properties'], ['📞', 'On a borrower call'], ['✍️', 'In a closing'],
    ['🍽', 'Lunch'], ['🌴', 'Out of office'], ['🎯', 'Heads down'],
  ];
  async function save() {
    try {
      await api.staffSetChatStatus({ emoji, text: text.trim(), expiresAt: hours ? new Date(Date.now() + hours * 3600000).toISOString() : null });
      onClose();
    } catch { onClose(); }
  }
  return (
    <div className="cv-menu" style={{ right: 0, top: '110%', width: 260, padding: 10 }}>
      <div className="row" style={{ gap: 4, flexWrap: 'wrap', marginBottom: 8 }}>
        {PRESETS.map(([e, t]) => (
          <button key={t} className="btn ghost small" onClick={() => { setEmoji(e); setText(t); }}>{e} {t}</button>
        ))}
      </div>
      <div className="row" style={{ gap: 6 }}>
        <input className="input" style={{ width: 44, textAlign: 'center' }} value={emoji} onChange={e => setEmoji(e.target.value.slice(0, 4))} />
        <input className="input" placeholder="What's your status?" value={text} onChange={e => setText(e.target.value)} />
      </div>
      <div className="row" style={{ gap: 6, marginTop: 8, alignItems: 'center' }}>
        <span className="muted small">Clear after</span>
        <select className="input" style={{ width: 110 }} value={hours} onChange={e => setHours(Number(e.target.value))}>
          <option value={1}>1 hour</option><option value={4}>4 hours</option>
          <option value={24}>Today</option><option value={0}>Never</option>
        </select>
        <div className="spacer" />
        <button className="btn link small" onClick={async () => { await api.staffClearChatStatus().catch(() => {}); onClose(); }}>Clear</button>
        <button className="btn primary small" onClick={save}>Set</button>
      </div>
    </div>
  );
}

/* Create a custom group chat on a loan file: name + emoji + teammates.
   Exported — the loan-file Conversations panel opens the same modal. */
export function NewChatModal({ appId, onClose, onCreated }) {
  const [name, setName] = useState('');
  const [emoji, setEmoji] = useState('👥');
  const [team, setTeam] = useState(null);
  const [picked, setPicked] = useState(new Set());
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  useEffect(() => { api.staffTeam().then(setTeam).catch(e => setErr(e.message)); }, []);
  const gate = useSubmitGate();
  async function create() {
    if (!name.trim()) { setErr('Give the chat a name.'); return; }
    if (!gate.enter()) return;             // a create is already in flight (Enter + click)
    setBusy(true); setErr('');
    try {
      const r = await api.staffCreateConversation(appId, { name: name.trim(), emoji, memberStaffIds: [...picked] });
      onCreated(r.conversationId);
    } catch (e) { setErr(e.message); setBusy(false); gate.leave(); }
  }
  return (
    <div className="cv-modal-back" onClick={onClose}>
      <div className="cv-modal panel" onClick={e => e.stopPropagation()}>
        <h3 style={{ marginBottom: 10 }}>New group chat</h3>
        <p className="muted small" style={{ marginBottom: 10 }}>
          A private team chat on this loan file — internal only, the borrower never sees it. Rename it or add people any time.
        </p>
        {err && <div role="alert" className="notice err" style={{ marginBottom: 8 }}>{err}</div>}
        <div className="row" style={{ gap: 8, marginBottom: 10 }}>
          <input className="input" style={{ width: 52, textAlign: 'center' }} value={emoji} onChange={e => setEmoji(e.target.value.slice(0, 4))} />
          <input className="input" autoFocus placeholder="Chat name — e.g. Title & Closing" value={name}
            onChange={e => setName(e.target.value)} onKeyDown={e => e.key === 'Enter' && create()} />
        </div>
        <div style={{ maxHeight: 220, overflowY: 'auto', marginBottom: 12 }}>
          {!team ? <p className="muted small">Loading team…</p> : team.map(s => (
            <label key={s.id} className="cv-member" style={{ cursor: 'pointer' }}>
              <input type="checkbox" checked={picked.has(s.id)}
                onChange={e => setPicked(p => { const n = new Set(p); e.target.checked ? n.add(s.id) : n.delete(s.id); return n; })} />
              <span className="cv-ava">{initials(s.full_name)}</span>
              <div style={{ flex: 1 }}>
                <div>{s.full_name}</div>
                <div className="muted small">{s.role.replace('_', ' ')}{s.title ? ` · ${s.title}` : ''}</div>
              </div>
            </label>
          ))}
        </div>
        <div className="row" style={{ gap: 8 }}>
          <div className="spacer" />
          <button className="btn ghost" onClick={onClose}>Cancel</button>
          <button className="btn primary" disabled={busy || !name.trim()} onClick={create}>{busy ? 'Creating…' : 'Create chat'}</button>
        </div>
      </div>
    </div>
  );
}
