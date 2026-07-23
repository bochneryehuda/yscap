import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { NavLink } from 'react-router-dom';
import { api } from '../lib/api.js';

/* ═══════════════════════════════════════════════════════════════════════════
   LOAN OFFICER — NOTIFICATION CENTER (major product)

   Four tabs, all one screen so the LO can hop between them in a session:
     · Catalog   — every notification the system can send, grouped, three-state
                   switch (Off / Automatic / Manual), info dots, search, bulk.
     · Drafts    — Gmail-style inbox of everything parked; live HTML preview;
                   bulk-select toolbar (send / discard / snooze / schedule);
                   per-row snooze, schedule-send, edit subject + body + note.
     · Rules     — quiet hours, work-days, timezone, learning mode, auto-send
                   safety SLA, undo-window, compose default (send vs draft).
     · Analytics — last 30 days: fired, emailed, opened, drafted, sent-from-
                   draft, discarded — with per-key drilldown.

   Bonus: Compose button (top-right) opens a modal for the LO to write and
   send an ad-hoc notification on any of their files. Undo toast on send.
   ═════════════════════════════════════════════════════════════════════════ */

/* ---- ICONS (inline SVG so no dep + they inherit currentColor) ---- */
const Icon = ({ name, size = 16 }) => {
  const s = size;
  const stroke = 'currentColor', sw = 1.75;
  const wrap = (paths) => (
    <svg width={s} height={s} viewBox="0 0 24 24" fill="none" stroke={stroke} strokeWidth={sw}
      strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0, verticalAlign: '-2px' }}>{paths}</svg>
  );
  switch (name) {
    case 'send':      return wrap(<><path d="M4 12l16-8-6 16-3-7-7-1z" /></>);
    case 'snooze':    return wrap(<><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></>);
    case 'clock':     return wrap(<><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></>);
    case 'schedule':  return wrap(<><rect x="3" y="5" width="18" height="16" rx="2" /><path d="M3 10h18M8 3v4M16 3v4M12 14v3M9 17h6" /></>);
    case 'discard':   return wrap(<><path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13" /></>);
    case 'edit':      return wrap(<><path d="M4 20h4l11-11-4-4L4 16v4z" /></>);
    case 'preview':   return wrap(<><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z" /><circle cx="12" cy="12" r="3" /></>);
    case 'mail':      return wrap(<><rect x="3" y="5" width="18" height="14" rx="2" /><path d="M3 7l9 6 9-6" /></>);
    case 'compose':   return wrap(<><path d="M12 20h9M4 20V13l10-10 4 4L8 17H4z" /></>);
    case 'search':    return wrap(<><circle cx="11" cy="11" r="7" /><path d="M20 20l-3.5-3.5" /></>);
    case 'refresh':   return wrap(<><path d="M4 12a8 8 0 0114-5l2-2M20 4v5h-5M20 12a8 8 0 01-14 5l-2 2M4 20v-5h5" /></>);
    case 'check':     return wrap(<><path d="M5 12l4 4 10-10" /></>);
    case 'x':         return wrap(<><path d="M6 6l12 12M6 18L18 6" /></>);
    case 'bell':      return wrap(<><path d="M6 8a6 6 0 0112 0v5l2 2H4l2-2V8z" /><path d="M9 19a3 3 0 006 0" /></>);
    case 'file':      return wrap(<><path d="M6 3h9l5 5v13a1 1 0 01-1 1H6a1 1 0 01-1-1V4a1 1 0 011-1z" /><path d="M15 3v5h5" /></>);
    case 'user':      return wrap(<><circle cx="12" cy="8" r="4" /><path d="M4 21c1.5-4 5-6 8-6s6.5 2 8 6" /></>);
    case 'sparkle':   return wrap(<><path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8L12 3z" /></>);
    case 'chevron':   return wrap(<><path d="M9 6l6 6-6 6" /></>);
    case 'help':      return wrap(<><circle cx="12" cy="12" r="9" /><path d="M9 9a3 3 0 016 0c0 2-3 2-3 4M12 17.5v.1" /></>);
    default:          return null;
  }
};

/* ---- avatars (initials, deterministic gold/teal from a hash) ---- */
const AVATAR_TINTS = ['#2F7F86', '#AE8746', '#5B6B7A', '#7A5C8E', '#4F8A6B', '#B5683E', '#3E6FB5'];
function _hash(s) { let h = 0; for (let i = 0; i < String(s).length; i++) h = (h * 31 + s.charCodeAt(i)) | 0; return Math.abs(h); }
function initials(name) {
  const parts = String(name || '?').trim().split(/[\s@._-]+/).filter(Boolean);
  if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
  return String(name || '?').slice(0, 2).toUpperCase();
}
function Avatar({ name, size = 32, kind }) {
  const tint = kind === 'staff' ? '#5B6B7A' : AVATAR_TINTS[_hash(name || '?') % AVATAR_TINTS.length];
  return (
    <span style={{ width: size, height: size, minWidth: size, borderRadius: '50%',
      background: tint, color: 'white', display: 'inline-flex', alignItems: 'center',
      justifyContent: 'center', fontSize: Math.round(size * 0.38), fontWeight: 600,
      letterSpacing: '.02em' }}>{initials(name)}</span>
  );
}

/* ---- icon-only button with tooltip (accessible) ---- */
function IconBtn({ name, title, onClick, disabled, tone, size = 30 }) {
  const color = tone === 'danger' ? 'var(--danger)' : tone === 'gold' ? 'var(--gold)' : 'var(--ivory)';
  return (
    <button onClick={onClick} disabled={disabled} title={title} aria-label={title}
      style={{ width: size, height: size, borderRadius: 6, border: '1px solid var(--line)',
        background: 'transparent', color, cursor: disabled ? 'default' : 'pointer',
        display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
        opacity: disabled ? 0.4 : 1, transition: 'background .12s ease' }}
      onMouseEnter={(e) => { if (!disabled) e.currentTarget.style.background = 'var(--ink-2)'; }}
      onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }}>
      <Icon name={name} size={16} />
    </button>
  );
}

/* ---- tiny helpers ---- */
const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
function maskDay(mask, i)  { return (mask & (1 << i)) !== 0; }
function toggleDay(mask, i){ return mask ^ (1 << i); }
function fmtWhen(ts, long) {
  if (!ts) return '';
  const d = new Date(ts);
  if (long) return d.toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' });
  const now = new Date();
  if (d.toDateString() === now.toDateString()) return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  const sameYear = d.getFullYear() === now.getFullYear();
  return d.toLocaleDateString([], sameYear ? { month: 'short', day: 'numeric' } : { month: 'short', day: 'numeric', year: 'numeric' });
}
function humanCountdown(ts) {
  if (!ts) return '';
  const d = new Date(ts).getTime() - Date.now();
  if (d < 0) return 'now';
  const m = Math.round(d / 60000);
  if (m < 60) return `in ${m} min`;
  const h = Math.round(m / 60); if (h < 48) return `in ${h}h`;
  return `in ${Math.round(h / 24)}d`;
}

/* ---- shared UI primitives ---- */
function InfoDot({ text }) {
  return (
    <span className="nc-info" title={text} aria-label={text}
      style={{ display: 'inline-flex', width: 16, height: 16, borderRadius: '50%',
        background: 'var(--ink-2)', color: 'var(--ivory)', border: '1px solid var(--line)',
        alignItems: 'center', justifyContent: 'center', fontSize: 11, marginLeft: 6,
        cursor: 'help', flexShrink: 0 }}>i</span>
  );
}
function Tab({ active, onClick, children, badge }) {
  return (
    <button onClick={onClick} className="btn"
      style={{ background: active ? 'var(--ivory)' : 'transparent', color: active ? 'white' : 'var(--ivory)',
        border: '1px solid var(--line)', padding: '6px 14px', marginRight: 6, position: 'relative' }}>
      {children}
      {badge ? <span className="sb-badge" style={{ marginLeft: 8 }}>{badge > 99 ? '99+' : badge}</span> : null}
    </button>
  );
}
function ModeSwitch({ enabled, mode, forced, onChange, size = 'md' }) {
  if (forced) return <span className="ec-pill ec-pill-ok" title="Required — this notification can’t be turned off">Always on</span>;
  const opts = [
    { id: 'off',       label: 'Off',   state: !enabled, hint: 'Do not send this notification at all' },
    { id: 'automatic', label: 'Auto',  state: enabled && mode === 'automatic', hint: 'Send automatically as soon as the event fires' },
    { id: 'manual',    label: 'Manual',state: enabled && mode === 'manual', hint: 'Do NOT send automatically — park in Drafts so I review it' },
  ];
  const pick = (id) => id === 'off' ? onChange({ enabled: false, mode: mode || 'automatic' }) : onChange({ enabled: true, mode: id });
  const padX = size === 'sm' ? 8 : 12;
  return (
    <div style={{ display: 'inline-flex', border: '1px solid var(--line)', borderRadius: 6, overflow: 'hidden' }}>
      {opts.map((o) => (
        <button key={o.id} onClick={() => pick(o.id)} title={o.hint}
          style={{ padding: `4px ${padX}px`, border: 'none', fontSize: 12,
            background: o.state ? 'var(--ivory)' : 'transparent',
            color: o.state ? 'white' : 'var(--ivory)', cursor: 'pointer',
            borderRight: '1px solid var(--line)' }}>
          {o.label}
        </button>
      ))}
    </div>
  );
}
function Toast({ show, children, onDismiss }) {
  if (!show) return null;
  return (
    <div style={{ position: 'fixed', bottom: 24, left: '50%', transform: 'translateX(-50%)',
      background: 'var(--ivory)', color: 'white', padding: '10px 16px', borderRadius: 6,
      display: 'flex', alignItems: 'center', gap: 12, zIndex: 999, boxShadow: '0 4px 20px rgba(0,0,0,0.2)' }}>
      {children}
      {onDismiss && (
        <button onClick={onDismiss} style={{ background: 'transparent', color: 'white', border: '1px solid rgba(255,255,255,0.4)', padding: '2px 10px', cursor: 'pointer', borderRadius: 3 }}>Dismiss</button>
      )}
    </div>
  );
}

/* ---- CATALOG TAB ---- */
function CatalogTab() {
  const [data, setData] = useState(null);
  const [prefs, setPrefs] = useState({});
  const [err, setErr] = useState('');
  const [msg, setMsg] = useState('');
  const [busy, setBusy] = useState(null);
  const [query, setQuery] = useState('');
  const [showForced, setShowForced] = useState(true);

  useEffect(() => {
    Promise.all([api.loNotifCatalog(), api.loNotifPrefs()])
      .then(([cat, p]) => {
        setData(cat);
        const m = {};
        for (const r of p.prefs || []) m[r.notif_key] = { enabled: r.enabled, mode: r.mode };
        setPrefs(m);
      })
      .catch((e) => setErr(e.message));
  }, []);

  const stateFor = (item) => {
    if (item.forced) return { enabled: true, mode: 'automatic' };
    if (prefs[item.key]) return prefs[item.key];
    return { enabled: item.defaultEnabled !== false, mode: item.defaultMode || 'automatic' };
  };

  const flash = (t) => { setMsg(t); setTimeout(() => setMsg(''), 1500); };

  const savePref = useCallback(async (item, nextState) => {
    if (item.forced) return;
    const before = prefs[item.key];
    setBusy(item.key);
    setPrefs((m) => ({ ...m, [item.key]: nextState }));
    try {
      await api.loNotifSavePref(item.key, nextState);
      flash('Saved');
    } catch (e) {
      setPrefs((m) => { const n = { ...m }; if (before) n[item.key] = before; else delete n[item.key]; return n; });
      setErr(e.message || 'Could not save');
    } finally { setBusy(null); }
  }, [prefs]);

  const bulkSet = useCallback(async (kind) => {
    if (!data) return;
    if (kind === 'all-off' && !window.confirm('Turn off every non-required notification for every borrower on your files? DocuSign, security and account emails will still send.')) return;
    const changes = data.items
      .filter((i) => !i.forced)
      .map((i) => ({ key: i.key, enabled: kind !== 'all-off', mode: kind === 'all-on-manual' ? 'manual' : 'automatic' }));
    setBusy('*');
    try {
      await api.loNotifBulkSave(changes);
      const p = await api.loNotifPrefs();
      const m = {}; for (const r of p.prefs || []) m[r.notif_key] = { enabled: r.enabled, mode: r.mode };
      setPrefs(m); flash('Applied');
    } catch (e) { setErr(e.message || 'Bulk update failed'); }
    finally { setBusy(null); }
  }, [data]);

  if (err && !data) return <div role="alert" className="notice err">{err}</div>;
  if (!data) return <div className="panel muted">Loading…</div>;

  const q = query.trim().toLowerCase();
  const filterItem = (it) => (showForced || !it.forced) && (!q
    || it.label.toLowerCase().includes(q)
    || it.description.toLowerCase().includes(q)
    || it.key.toLowerCase().includes(q));
  const groups = data.categories.map((c) => ({
    ...c, items: data.items.filter((i) => i.category === c.id).filter(filterItem),
  })).filter((g) => g.items.length);

  const counts = {
    total: data.items.length,
    off: data.items.filter((i) => !i.forced && !stateFor(i).enabled).length,
    manual: data.items.filter((i) => !i.forced && stateFor(i).enabled && stateFor(i).mode === 'manual').length,
    auto: data.items.filter((i) => !i.forced && stateFor(i).enabled && stateFor(i).mode === 'automatic').length,
    forced: data.items.filter((i) => i.forced).length,
  };

  return (
    <>
      <div className="panel" style={{ marginBottom: 14 }}>
        <div className="row" style={{ gap: 10, flexWrap: 'wrap', alignItems: 'center' }}>
          <div style={{ flex: 1, minWidth: 240 }}>
            <div style={{ fontWeight: 600, marginBottom: 2 }}>Every notification your borrowers can receive</div>
            <div className="muted small">
              {counts.auto} automatic · {counts.manual} manual · {counts.off} off · {counts.forced} always on
            </div>
          </div>
          <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search…"
            style={{ padding: '6px 10px', border: '1px solid var(--line)', borderRadius: 4, minWidth: 200 }} />
          <label className="muted small" style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
            <input type="checkbox" checked={showForced} onChange={(e) => setShowForced(e.target.checked)} />
            Show required
          </label>
          {msg && <span className="muted small">{msg} ✓</span>}
        </div>
        <div className="row" style={{ marginTop: 10, gap: 6, flexWrap: 'wrap' }}>
          <button className="btn ghost small" disabled={busy === '*'} onClick={() => bulkSet('all-on-auto')}>Everything automatic</button>
          <button className="btn ghost small" disabled={busy === '*'} onClick={() => bulkSet('all-on-manual')}>Everything manual (draft)</button>
          <button className="btn ghost small" disabled={busy === '*'} onClick={() => bulkSet('all-off')}>Turn everything off</button>
        </div>
      </div>

      {err && <div role="alert" className="notice err">{err}</div>}

      {groups.map((g) => (
        <div className="panel" key={g.id} style={{ marginBottom: 14 }}>
          <div style={{ fontWeight: 600, textTransform: 'uppercase', letterSpacing: '.06em',
            fontSize: 12, color: 'var(--muted)', paddingBottom: 8, borderBottom: '1px solid var(--line)' }}>{g.label}</div>
          {g.items.map((it) => {
            const st = stateFor(it);
            return (
              <div key={it.key} className="row" style={{ padding: '10px 0', borderBottom: '1px solid var(--line)',
                alignItems: 'flex-start', flexWrap: 'nowrap', gap: 10 }}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap' }}>
                    <span style={{ fontWeight: 500 }}>{it.label}</span>
                    <InfoDot text={it.description} />
                    <span className="muted small" style={{ marginLeft: 10 }}>
                      {it.audience === 'borrower' ? 'to borrower'
                        : it.audience === 'staff' ? 'to team'
                        : it.audience === 'admin' ? 'to admins' : 'to file'}
                    </span>
                  </div>
                  <div className="muted small" style={{ marginTop: 2 }}>{it.description}</div>
                </div>
                <div style={{ flexShrink: 0, paddingTop: 4 }}>
                  <ModeSwitch enabled={st.enabled} mode={st.mode} forced={it.forced}
                    onChange={(next) => savePref(it, next)} />
                </div>
              </div>
            );
          })}
        </div>
      ))}
      <p className="muted small">
        Everything starts on. Turn a notification off to silence it. Set it to Manual to route it to
        the Drafts tab — nothing sends automatically; you review each one and click Send. DocuSign,
        security and account notifications are required and always send.
      </p>
    </>
  );
}

/* ---- DRAFT PREVIEW (live HTML in iframe) ---- */
function LiveEmailPreview({ draftId }) {
  const [html, setHtml] = useState(null);
  const [err, setErr] = useState('');
  useEffect(() => {
    if (!draftId) return;
    setHtml(null); setErr('');
    api.loNotifDraftPreview(draftId)
      .then((r) => setHtml(r.html || ''))
      .catch((e) => setErr(e.message || 'Could not render preview'));
  }, [draftId]);
  if (err) return <div className="notice err">{err}</div>;
  if (html == null) return <div className="muted small">Loading preview…</div>;
  // srcDoc renders reliably into a fully-sandboxed iframe (unique origin) —
  // writing via `contentDocument.write` on a sandbox="" iframe silently fails
  // in some browsers because the parent can't reach the sandboxed doc.
  return (
    <iframe title="Email preview" sandbox="" srcDoc={html}
      style={{ width: '100%', height: 560, border: '1px solid var(--line)', borderRadius: 4, background: 'white' }} />
  );
}

/* ---- SCHEDULE PICKER ---- */
function SchedulePicker({ open, onClose, onPick }) {
  const [when, setWhen] = useState(() => {
    const d = new Date(Date.now() + 3600 * 1000);
    const off = d.getTimezoneOffset() * 60000;
    return new Date(d.getTime() - off).toISOString().slice(0, 16);
  });
  const [err, setErr] = useState('');
  useEffect(() => {
    if (!open) return undefined;
    setErr('');
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);
  if (!open) return null;
  const confirm = () => {
    const d = new Date(when);
    if (Number.isNaN(d.getTime())) return setErr('Pick a valid date and time.');
    if (d.getTime() < Date.now() + 60_000) return setErr('Pick a time at least a minute from now.');
    onPick(d.toISOString());
  };
  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.35)', display: 'flex',
      alignItems: 'center', justifyContent: 'center', zIndex: 500 }} onClick={onClose}>
      <div className="panel" onClick={(e) => e.stopPropagation()}
        role="dialog" aria-modal="true" aria-labelledby="sched-title"
        style={{ minWidth: 320, background: 'white' }}>
        <h3 id="sched-title" style={{ marginBottom: 8 }}>Schedule to send</h3>
        <p className="muted small">Pick when this notification should go out.</p>
        <input type="datetime-local" value={when} onChange={(e) => setWhen(e.target.value)}
          autoFocus
          style={{ padding: '6px 10px', border: '1px solid var(--line)', borderRadius: 4, width: '100%' }} />
        {err && <div className="notice err" style={{ marginTop: 8 }}>{err}</div>}
        <div className="row" style={{ gap: 8, marginTop: 14, justifyContent: 'flex-end' }}>
          <button className="btn ghost" onClick={onClose}>Cancel</button>
          <button className="btn btn-gold" onClick={confirm}>Schedule</button>
        </div>
      </div>
    </div>
  );
}

/* ---- COMPOSE MODAL ---- */
function ComposeModal({ open, onClose, onSent }) {
  const [subject, setSubject] = useState('');
  const [body, setBody] = useState('');
  const [appId, setAppId] = useState('');
  const [recipientId, setRecipientId] = useState('');
  const [recipientKind, setRecipientKind] = useState('borrower');
  const [mode, setMode] = useState('send');
  const [files, setFiles] = useState([]);
  const [team, setTeam] = useState({ loanOfficer: null, processor: null });
  const [borrower, setBorrower] = useState(null);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const dialogRef = useRef(null);
  const firstFieldRef = useRef(null);

  useEffect(() => {
    if (!open) return;
    setErr(''); setBusy(false); setSubject(''); setBody(''); setRecipientId(''); setAppId(''); setMode('send');
    // Endpoint returns a bare array; guard against either shape so a schema
    // change never leaves the picker empty.
    api.staffApplications({ mine: 1 })
      .then((r) => setFiles(Array.isArray(r) ? r : (r && r.applications) || []))
      .catch(() => setFiles([]));
    setTimeout(() => firstFieldRef.current && firstFieldRef.current.focus(), 30);
  }, [open]);

  useEffect(() => {
    // When file changes: fetch the full detail (borrower_id + team). The list
    // endpoint doesn't return borrower_id, so the picker relies entirely on
    // the detail call to know who the borrower is.
    if (!appId) { setBorrower(null); setTeam({ loanOfficer: null, processor: null }); setRecipientId(''); return; }
    api.staffApplication(appId).then((detail) => {
      if (!detail) return;
      const bName = [detail.first_name, detail.last_name].filter(Boolean).join(' ')
        || detail.borrower_name || detail.email || 'borrower';
      if (detail.borrower_id) {
        setBorrower({ id: detail.borrower_id, name: bName });
        if (recipientKind === 'borrower') setRecipientId(detail.borrower_id);
      }
      const loName = detail.loan_officer_name || detail.loan_officer || null;
      const prName = detail.processor_name || detail.processor || null;
      setTeam({
        loanOfficer: detail.loan_officer_id ? { id: detail.loan_officer_id, name: loName || 'Loan officer' } : null,
        processor:   detail.processor_id    ? { id: detail.processor_id,    name: prName || 'Processor' } : null,
      });
    }).catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [appId]);

  // When switching recipient kind, blank recipient so the LO picks intentionally.
  useEffect(() => {
    if (recipientKind === 'borrower' && borrower) setRecipientId(borrower.id);
    else setRecipientId('');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [recipientKind]);

  // Escape closes; focus stays inside the dialog.
  useEffect(() => {
    if (!open) return undefined;
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open) return null;

  const submit = async () => {
    setBusy(true); setErr('');
    try {
      await api.loNotifCompose({ applicationId: appId, recipientKind, recipientId, subject, body, mode });
      onSent && onSent(mode);
      onClose();
    } catch (e) { setErr(e.message || 'Could not send'); }
    finally { setBusy(false); }
  };

  const staffOptions = [team.loanOfficer, team.processor].filter(Boolean);
  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.4)', display: 'flex',
      alignItems: 'center', justifyContent: 'center', zIndex: 500 }} onClick={onClose}>
      <div className="panel" onClick={(e) => e.stopPropagation()} ref={dialogRef}
        role="dialog" aria-modal="true" aria-labelledby="compose-title"
        style={{ minWidth: 520, maxWidth: 620, background: 'white' }}>
        <h3 id="compose-title" style={{ marginBottom: 4 }}>Compose a notification</h3>
        <p className="muted small" style={{ marginTop: 0 }}>Write your own message to a borrower on one of your files. Delivered as a PILOT-branded email + in-app notification.</p>
        {err && <div className="notice err">{err}</div>}
        <label className="muted small" htmlFor="compose-file">File</label>
        <select id="compose-file" ref={firstFieldRef} value={appId} onChange={(e) => setAppId(e.target.value)}
          style={{ padding: '6px 10px', border: '1px solid var(--line)', borderRadius: 4, width: '100%', marginBottom: 10 }}>
          <option value="">— Pick a file —</option>
          {files.map((f) => (
            <option key={f.id} value={f.id}>
              {f.ys_loan_number ? String(f.ys_loan_number).toUpperCase() + ' · ' : ''}
              {f.borrower_name || f.borrower_email}
              {f.property_address ? ' · ' + (f.property_address.oneLine || f.property_address.street || '') : ''}
            </option>
          ))}
        </select>
        <label className="muted small">Send to</label>
        <div className="row" style={{ gap: 6, marginBottom: 10 }}>
          <select value={recipientKind} onChange={(e) => setRecipientKind(e.target.value)}
            style={{ padding: '6px 10px', border: '1px solid var(--line)', borderRadius: 4 }}>
            <option value="borrower">Borrower</option>
            <option value="staff">Team member</option>
          </select>
          {recipientKind === 'borrower' ? (
            <div style={{ padding: '6px 10px', border: '1px solid var(--line)', borderRadius: 4, flex: 1,
              background: 'var(--ink-2)', color: borrower ? 'var(--ivory)' : 'var(--muted)' }}>
              {borrower ? borrower.name : (appId ? '(no borrower on this file)' : 'Pick a file first')}
            </div>
          ) : (
            <select value={recipientId} onChange={(e) => setRecipientId(e.target.value)}
              disabled={!staffOptions.length}
              style={{ padding: '6px 10px', border: '1px solid var(--line)', borderRadius: 4, flex: 1 }}>
              <option value="">{staffOptions.length ? '— Pick a team member —' : (appId ? 'No team on this file' : 'Pick a file first')}</option>
              {staffOptions.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
            </select>
          )}
        </div>
        <label className="muted small">Subject</label>
        <input value={subject} onChange={(e) => setSubject(e.target.value)}
          style={{ padding: '6px 10px', border: '1px solid var(--line)', borderRadius: 4, width: '100%', marginBottom: 10 }} />
        <label className="muted small">Message</label>
        <textarea value={body} onChange={(e) => setBody(e.target.value)} rows={8}
          style={{ padding: '8px 10px', border: '1px solid var(--line)', borderRadius: 4, width: '100%', fontFamily: 'inherit', marginBottom: 12 }} />
        <div className="row" style={{ gap: 8, alignItems: 'center' }}>
          <label className="muted small" style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
            <input type="radio" checked={mode === 'send'} onChange={() => setMode('send')} /> Send now
          </label>
          <label className="muted small" style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
            <input type="radio" checked={mode === 'draft'} onChange={() => setMode('draft')} /> Save to drafts
          </label>
          <div className="spacer" />
          <button className="btn ghost" onClick={onClose} disabled={busy}>Cancel</button>
          <button className="btn btn-gold" onClick={submit} disabled={busy || !appId || !recipientId || !subject || !body}>
            {busy ? '…' : (mode === 'draft' ? 'Save draft' : 'Send now')}
          </button>
        </div>
      </div>
    </div>
  );
}

/* ---- DRAFT PREVIEW PANE ---- */
function DraftPreview({ draft, subject, body, note, setSubject, setBody, setNote,
                        onSend, onDiscard, onSnooze, onSchedule, busy }) {
  const [tab, setTab] = useState('preview');
  const [openSched, setOpenSched] = useState(false);
  const [snoozeOpen, setSnoozeOpen] = useState(false);
  const snoozeRef = useRef(null);
  useEffect(() => { setTab('preview'); setSnoozeOpen(false); }, [draft.id]);
  // Close the snooze dropdown on outside click OR Escape (audit finding #4).
  useEffect(() => {
    if (!snoozeOpen) return undefined;
    const onDown = (e) => { if (snoozeRef.current && !snoozeRef.current.contains(e.target)) setSnoozeOpen(false); };
    const onKey = (e) => { if (e.key === 'Escape') setSnoozeOpen(false); };
    document.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('mousedown', onDown); window.removeEventListener('keydown', onKey); };
  }, [snoozeOpen]);
  const canEdit = draft.status === 'pending';
  const dirty = subject !== (draft.subject || '') || body !== (draft.body || '') || note.trim() !== '';
  const send = () => onSend(draft, { title: subject, body, note });
  const who = draft.recipientLabel || (draft.recipientKind === 'borrower' ? 'Borrower' : 'Team member');

  return (
    <div className="panel" style={{ padding: 0, overflow: 'hidden' }}>
      {/* HEADER — Gmail-style with recipient + subject + action bar */}
      <div style={{ padding: '14px 18px', borderBottom: '1px solid var(--line)',
        background: 'linear-gradient(180deg, var(--ink-1) 0%, var(--ink-2) 100%)' }}>
        <div className="row" style={{ gap: 12, alignItems: 'center' }}>
          <Avatar name={who} kind={draft.recipientKind} size={38} />
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontWeight: 600, fontSize: 15 }}>
              To {who}
              {draft.recipientKind === 'staff' && <span className="muted small" style={{ marginLeft: 6 }}>(team)</span>}
            </div>
            <div className="muted small" style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {subject || <em>(no subject)</em>}
            </div>
          </div>
          {canEdit && (
            <div style={{ display: 'inline-flex', gap: 4 }}>
              <IconBtn name="send"     title="Send now"         onClick={send}                     disabled={busy} tone="gold" size={34} />
              <IconBtn name="schedule" title="Schedule for later" onClick={() => setOpenSched(true)} disabled={busy} size={34} />
              <div style={{ position: 'relative' }} ref={snoozeRef}>
                <IconBtn name="snooze" title="Snooze"           onClick={() => setSnoozeOpen((v) => !v)} disabled={busy} size={34} />
                {snoozeOpen && (
                  <div className="panel" style={{ position: 'absolute', top: 40, right: 0, zIndex: 10, padding: 4, minWidth: 120 }}>
                    {[[60, '1 hour'], [60 * 4, '4 hours'], [60 * 24, '1 day'], [60 * 24 * 3, '3 days'], [60 * 24 * 7, '1 week']].map(([m, l]) => (
                      <button key={m} className="btn ghost small" style={{ display: 'block', width: '100%', textAlign: 'left', border: 'none', padding: '6px 10px' }}
                        onClick={() => { setSnoozeOpen(false); onSnooze(draft, m); }}>
                        <Icon name="snooze" size={13} /> {l}
                      </button>
                    ))}
                  </div>
                )}
              </div>
              <IconBtn name="discard"  title="Discard"          onClick={() => onDiscard(draft)}   disabled={busy} tone="danger" size={34} />
            </div>
          )}
        </div>
        {/* CHIPS: notification kind + status + timing */}
        <div style={{ display: 'flex', gap: 6, marginTop: 10, flexWrap: 'wrap', alignItems: 'center' }}>
          <span className="ec-pill ec-pill-muted"><Icon name="mail" size={12} /> {draft.entry ? draft.entry.label : draft.notifType}</span>
          {draft.priority === 'high' && <span className="ec-pill ec-pill-danger">High priority</span>}
          {draft.composeSource === 'compose' && <span className="ec-pill ec-pill-ok"><Icon name="compose" size={12} /> Composed by you</span>}
          {draft.scheduledFor && <span className="ec-pill ec-pill-muted"><Icon name="schedule" size={12} /> Scheduled {humanCountdown(draft.scheduledFor)}</span>}
          {draft.snoozedUntil && new Date(draft.snoozedUntil) > new Date() && <span className="ec-pill ec-pill-muted"><Icon name="snooze" size={12} /> Snoozed {humanCountdown(draft.snoozedUntil)}</span>}
          {draft.autoSendAt && !draft.scheduledFor && (
            <span className="ec-pill ec-pill-muted" title="If you don't act on this, it will auto-send at this time so nothing important gets stuck">
              <Icon name="clock" size={12} /> Auto-sends {humanCountdown(draft.autoSendAt)}
            </span>
          )}
          {draft.loanNumber && <span className="muted small" style={{ marginLeft: 'auto' }}><Icon name="file" size={12} /> {draft.loanNumber}</span>}
          {draft.address && <span className="muted small">· {draft.address}</span>}
        </div>
      </div>

      {/* PREVIEW / EDIT SWITCH */}
      <div style={{ display: 'flex', gap: 0, borderBottom: '1px solid var(--line)', background: 'var(--ink-2)' }}>
        {[{ id: 'preview', label: 'Preview', icon: 'preview' }, { id: 'edit', label: 'Edit', icon: 'edit' }].map((t) => (
          <button key={t.id} onClick={() => setTab(t.id)}
            style={{ padding: '10px 16px', border: 'none', background: tab === t.id ? 'var(--ink-1)' : 'transparent',
              borderRight: '1px solid var(--line)', cursor: 'pointer', fontSize: 13,
              color: tab === t.id ? 'var(--ivory)' : 'var(--muted)', fontWeight: tab === t.id ? 600 : 400,
              display: 'inline-flex', gap: 6, alignItems: 'center' }}>
            <Icon name={t.icon} size={14} /> {t.label}
          </button>
        ))}
        {dirty && canEdit && (
          <div style={{ marginLeft: 'auto', padding: '10px 14px', fontSize: 12, color: 'var(--gold)', fontStyle: 'italic' }}>
            You have unsaved edits — they apply when you Send.
          </div>
        )}
      </div>

      <div style={{ padding: 16 }}>
        {tab === 'preview' ? (
          <LiveEmailPreview draftId={draft.id} />
        ) : (
          <>
            <label style={{ fontSize: 12, textTransform: 'uppercase', letterSpacing: '.06em', color: 'var(--muted)', display: 'block', marginBottom: 4 }}>Subject</label>
            <input value={subject} disabled={!canEdit} onChange={(e) => setSubject(e.target.value)}
              style={{ width: '100%', padding: '8px 12px', border: '1px solid var(--line)', borderRadius: 6, marginBottom: 14, fontSize: 14 }} />
            <label style={{ fontSize: 12, textTransform: 'uppercase', letterSpacing: '.06em', color: 'var(--muted)', display: 'block', marginBottom: 4 }}>Body</label>
            <textarea value={body} disabled={!canEdit} onChange={(e) => setBody(e.target.value)}
              rows={10} style={{ width: '100%', padding: '10px 12px', border: '1px solid var(--line)', borderRadius: 6, marginBottom: 14, fontFamily: 'inherit', fontSize: 14, resize: 'vertical' }} />
            {canEdit && (
              <>
                <label style={{ fontSize: 12, textTransform: 'uppercase', letterSpacing: '.06em', color: 'var(--muted)', display: 'block', marginBottom: 4 }}>Personal note (optional)</label>
                <textarea value={note} onChange={(e) => setNote(e.target.value)} rows={3}
                  placeholder="Add a note that will appear in the email body…"
                  style={{ width: '100%', padding: '10px 12px', border: '1px solid var(--line)', borderRadius: 6, marginBottom: 14, fontFamily: 'inherit', fontSize: 14, resize: 'vertical' }} />
              </>
            )}
          </>
        )}
      </div>

      {/* FOOTER — status line + link to file */}
      <div style={{ padding: '10px 18px', borderTop: '1px solid var(--line)', display: 'flex', alignItems: 'center', gap: 10, background: 'var(--ink-2)' }}>
        {canEdit ? (
          <span className="muted small">Parked {fmtWhen(draft.createdAt, true)}</span>
        ) : (
          <span className="muted small" style={{ display: 'inline-flex', gap: 4, alignItems: 'center' }}>
            {draft.status === 'sent'
              ? <><Icon name="check" size={13} /> Sent {draft.sentAt ? fmtWhen(draft.sentAt, true) : ''}</>
              : <><Icon name="x" size={13} /> Discarded {draft.discardedAt ? fmtWhen(draft.discardedAt, true) : ''}</>}
          </span>
        )}
        <div className="spacer" />
        {draft.applicationId && (
          <NavLink to={`/internal/app/${draft.applicationId}`} className="btn ghost small">
            <Icon name="file" size={13} /> Open the file
          </NavLink>
        )}
      </div>
      <SchedulePicker open={openSched} onClose={() => setOpenSched(false)}
        onPick={(iso) => { setOpenSched(false); onSchedule(draft, iso); }} />
    </div>
  );
}

/* ---- DRAFT CARD (row in the left rail) — modern card with hover actions ---- */
function DraftCard({ draft, selected, showCheckbox, checked, onCheck, onSelect, onQuickSend, onQuickSnooze, onQuickDiscard, busy }) {
  const priorityStrip = draft.priority === 'high' ? 'var(--danger)' : draft.composeSource === 'compose' ? 'var(--gold)' : 'transparent';
  const who = draft.recipientLabel || (draft.recipientKind === 'borrower' ? 'Borrower' : 'Team');
  return (
    <div
      className={`lo-draft-row${selected ? ' is-selected' : ''}`}
      onClick={onSelect}
      style={{ display: 'flex', gap: 8, padding: '12px 14px 12px 10px',
        background: selected ? 'var(--gold-soft)' : 'transparent',
        borderLeft: `3px solid ${selected ? 'var(--gold)' : priorityStrip}`,
        borderBottom: '1px solid var(--line)', cursor: 'pointer', position: 'relative',
        transition: 'background .1s ease' }}>
      {showCheckbox && (
        <label onClick={(e) => e.stopPropagation()} style={{ alignSelf: 'flex-start', paddingTop: 2 }}>
          <input type="checkbox" checked={checked} onChange={onCheck} />
        </label>
      )}
      <Avatar name={who} kind={draft.recipientKind} size={32} />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <span style={{ fontSize: 12, color: 'var(--muted)', fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1 }}>
            {who}
          </span>
          <span style={{ fontSize: 11, color: 'var(--muted)' }}>{fmtWhen(draft.createdAt)}</span>
        </div>
        <div style={{ fontWeight: 600, fontSize: 14, marginTop: 2,
          whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
          {draft.subject || <em style={{ color: 'var(--muted)', fontWeight: 400 }}>(no subject)</em>}
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 4, flexWrap: 'wrap' }}>
          <span className="ec-pill ec-pill-muted" style={{ fontSize: 10 }}>
            <Icon name="mail" size={10} /> {(draft.entry && draft.entry.label) || draft.notifType}
          </span>
          {draft.priority === 'high' && <span className="ec-pill ec-pill-danger" style={{ fontSize: 10 }}>High</span>}
          {draft.composeSource === 'compose' && <span className="ec-pill ec-pill-ok" style={{ fontSize: 10 }}><Icon name="compose" size={10} /> yours</span>}
          {draft.scheduledFor && <span className="ec-pill ec-pill-muted" style={{ fontSize: 10 }}><Icon name="schedule" size={10} /> {humanCountdown(draft.scheduledFor)}</span>}
          {draft.snoozedUntil && new Date(draft.snoozedUntil) > new Date() && <span className="ec-pill ec-pill-muted" style={{ fontSize: 10 }}><Icon name="snooze" size={10} /> {humanCountdown(draft.snoozedUntil)}</span>}
          {draft.loanNumber && <span className="muted" style={{ fontSize: 11, marginLeft: 'auto' }}>{draft.loanNumber}</span>}
        </div>
      </div>
      {/* Hover-reveal quick actions on Pending only. Rendered via CSS :hover
          in a `@media (hover: hover)` block so touch devices don't get stuck
          with the box permanently shown (audit finding #7). Also hidden on
          the currently-selected row — the preview pane's action bar is
          canonical there, avoids two ways to fire the same action. */}
      {onQuickSend && !selected && (
        <div className="lo-draft-actions" onClick={(e) => e.stopPropagation()}
          style={{ position: 'absolute', right: 6, top: 6, display: 'inline-flex', gap: 2,
            background: 'var(--ink-1)', border: '1px solid var(--line)', borderRadius: 6, padding: 2,
            boxShadow: '0 2px 6px rgba(0,0,0,0.06)' }}>
          <IconBtn name="send"    title="Send now"  onClick={onQuickSend}     disabled={busy} tone="gold"   size={26} />
          <IconBtn name="snooze"  title="Snooze 1h" onClick={onQuickSnooze}   disabled={busy}               size={26} />
          <IconBtn name="discard" title="Discard"   onClick={onQuickDiscard}  disabled={busy} tone="danger" size={26} />
        </div>
      )}
    </div>
  );
}

/* ---- LIVE INDICATOR — pulses when the auto-refresh timer is running ----
   The @keyframes lo-pulse rule lives in app-v2/src/styles.css. */
function LiveDot({ on, label }) {
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12, color: 'var(--muted)' }}>
      <span style={{ width: 8, height: 8, borderRadius: '50%',
        background: on ? 'var(--ok)' : 'var(--muted)',
        boxShadow: on ? '0 0 0 0 rgba(46,122,94,0.6)' : 'none',
        animation: on ? 'lo-pulse 2s infinite' : 'none' }} />
      {label}
    </span>
  );
}

/* ---- EMPTY STATE — designed for each sub-tab ---- */
function EmptyState({ kind }) {
  const cfg = kind === 'pending'
    ? { icon: 'mail', title: 'Your drafts are empty', body: <>Any notification you flip to <strong>Manual</strong> in the Catalog lands here — plus anything parked by quiet hours or learning mode. You review each one and click <strong>Send</strong>.</> }
    : kind === 'sent'
    ? { icon: 'check', title: 'No sent drafts yet', body: 'Drafts you review + send show up here as a searchable history.' }
    : { icon: 'discard', title: 'No discarded drafts', body: 'Drafts you drop show up here.' };
  return (
    <div className="panel" style={{ textAlign: 'center', padding: '48px 24px' }}>
      <div style={{ width: 56, height: 56, margin: '0 auto 14px', borderRadius: '50%',
        background: 'var(--gold-soft)', color: 'var(--gold)',
        display: 'inline-flex', alignItems: 'center', justifyContent: 'center' }}>
        <Icon name={cfg.icon} size={26} />
      </div>
      <div style={{ fontSize: 16, fontWeight: 600, marginBottom: 6 }}>{cfg.title}</div>
      <div className="muted small" style={{ maxWidth: 420, margin: '0 auto' }}>{cfg.body}</div>
    </div>
  );
}

/* ---- DRAFTS TAB — modern Gmail-style inbox with live refresh ---- */
function DraftsTab({ onCountChange, showToast }) {
  const [tab, setTab] = useState('pending');
  const [items, setItems] = useState(null);
  const [selectedId, setSelectedId] = useState(null);
  const [checked, setChecked] = useState(new Set());
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const [q, setQ] = useState('');
  const [bulkScheduleOpen, setBulkScheduleOpen] = useState(false);
  const [lastRefreshed, setLastRefreshed] = useState(null);
  const [autoRefresh, setAutoRefresh] = useState(true);

  // Selection ref — the load() effect uses this to preserve selection across a
  // soft refresh WITHOUT re-creating itself every time the LO j/k-navigates
  // (audit finding #3: the 30s auto-refresh interval was being torn down and
  // rebuilt on every arrow-key press, so a fast-scrolling LO never saw new
  // drafts arrive).
  const selectedIdRef = useRef(null);
  useEffect(() => { selectedIdRef.current = selectedId; }, [selectedId]);

  // EDIT STATE for the currently-selected draft — LIFTED here so both the
  // keyboard-send (`e`) and the row hover-Send can use the LO's local edits
  // instead of silently discarding them (audit findings #1 + #2). Reset when
  // the selection moves.
  const [editSubject, setEditSubject] = useState('');
  const [editBody, setEditBody] = useState('');
  const [editNote, setEditNote] = useState('');
  const selected = items && items.find((i) => i.id === selectedId);
  useEffect(() => {
    setEditSubject((selected && selected.subject) || '');
    setEditBody((selected && selected.body) || '');
    setEditNote('');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedId]);
  // Effective edits — used by every send path (button, keyboard, hover) for
  // the CURRENTLY-selected draft; a non-selected row's quick-send uses the row's
  // own (server) copy (there's nothing to lose).
  const hasEdits = !!selected && (
    editSubject !== (selected.subject || '') || editBody !== (selected.body || '') || editNote.trim() !== ''
  );
  const effectiveEdits = (row) => (selected && row.id === selected.id)
    ? { title: editSubject, body: editBody, note: editNote }
    : { title: row.subject, body: row.body, note: '' };

  const load = useCallback(async (opts) => {
    const soft = opts && opts.soft;
    if (!soft) { setItems(null); setSelectedId(null); setChecked(new Set()); }
    setErr('');
    try {
      const r = await api.loNotifDrafts({ status: tab, q });
      setItems(r.items || []);
      setLastRefreshed(new Date());
      const currentSel = selectedIdRef.current;
      if (soft) {
        if (r.items && !r.items.some((i) => i.id === currentSel) && r.items[0]) setSelectedId(r.items[0].id);
      } else if (r.items && r.items[0]) setSelectedId(r.items[0].id);
      if (tab === 'pending' && onCountChange) onCountChange((r.items || []).length);
    } catch (e) { setErr(e.message || 'Could not load drafts'); }
  }, [tab, q, onCountChange]);   // deliberately no selectedId — the ref carries it

  useEffect(() => { load(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [tab, q]);

  // LIVE — auto-refresh every 30s, and on window focus. Off when the tab isn't
  // Pending (Sent + Discarded rarely change) and off when the LO opted out.
  useEffect(() => {
    if (!autoRefresh || tab !== 'pending') return undefined;
    const iv = setInterval(() => load({ soft: true }), 30_000);
    const onFocus = () => load({ soft: true });
    window.addEventListener('focus', onFocus);
    return () => { clearInterval(iv); window.removeEventListener('focus', onFocus); };
  }, [autoRefresh, tab, load]);

  // Countdown ticker — only Pending has time-sensitive labels worth re-rendering.
  const [, setTick] = useState(0);
  useEffect(() => {
    if (tab !== 'pending') return undefined;
    const t = setInterval(() => setTick((n) => n + 1), 30_000);
    return () => clearInterval(t);
  }, [tab]);

  const handleSend = async (draft, edits) => {
    setBusy(true); setErr('');
    try { await api.loNotifDraftSend(draft.id, edits); showToast && showToast('Sent — it went out via PILOT.'); await load({ soft: true }); }
    catch (e) { setErr(e.message || 'Send failed'); }
    finally { setBusy(false); }
  };
  const handleDiscard = async (draft) => {
    if (!window.confirm('Discard this notification? The borrower will never see it.')) return;
    setBusy(true); setErr('');
    try { await api.loNotifDraftDiscard(draft.id); await load({ soft: true }); }
    catch (e) { setErr(e.message || 'Discard failed'); }
    finally { setBusy(false); }
  };
  const handleSnooze = async (draft, minutes) => {
    setBusy(true); setErr('');
    try { await api.loNotifDraftSnooze(draft.id, minutes); showToast && showToast('Snoozed.'); await load({ soft: true }); }
    catch (e) { setErr(e.message || 'Snooze failed'); }
    finally { setBusy(false); }
  };
  const handleSchedule = async (draft, iso) => {
    setBusy(true); setErr('');
    try { await api.loNotifDraftSchedule(draft.id, iso); showToast && showToast('Scheduled.'); await load({ soft: true }); }
    catch (e) { setErr(e.message || 'Schedule failed'); }
    finally { setBusy(false); }
  };

  const toggleChecked = (id) => setChecked((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  const selectAll = () => setChecked(new Set((items || []).map((i) => i.id)));
  const clearChecks = () => setChecked(new Set());

  const bulk = async (action, extra) => {
    if (!checked.size) return;
    if (action === 'discard' && !window.confirm(`Discard ${checked.size} drafts?`)) return;
    setBusy(true);
    try {
      const r = await api.loNotifDraftsBulk([...checked], action, extra);
      showToast && showToast(`${r.applied} updated${r.failed ? ` · ${r.failed} skipped` : ''}.`);
      await load({ soft: false });
    } catch (e) { setErr(e.message || 'Bulk action failed'); }
    finally { setBusy(false); }
  };

  // KEYBOARD SHORTCUTS — Gmail-style j/k/e/d/s/enter, only on Pending.
  useEffect(() => {
    if (tab !== 'pending' || !items || !items.length) return undefined;
    const onKey = (e) => {
      if (e.target && ['INPUT', 'TEXTAREA', 'SELECT'].includes(e.target.tagName)) return;
      const idx = items.findIndex((i) => i.id === selectedId);
      if (e.key === 'j' || e.key === 'ArrowDown') { e.preventDefault(); setSelectedId(items[Math.min(idx + 1, items.length - 1)].id); }
      else if (e.key === 'k' || e.key === 'ArrowUp') { e.preventDefault(); setSelectedId(items[Math.max(idx - 1, 0)].id); }
      // Keyboard send/snooze/discard use effectiveEdits so unsaved edits are
      // included, not silently discarded (audit finding #1).
      else if (selected && e.key === 'e') { e.preventDefault(); handleSend(selected, effectiveEdits(selected)); }
      else if (selected && e.key === '#') { e.preventDefault(); handleDiscard(selected); }
      else if (selected && e.key === 's') { e.preventDefault(); handleSnooze(selected, 60); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [tab, items, selectedId, selected]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <>
      {/* SUB-TAB BAR — with live counters on Pending */}
      <div className="row" style={{ marginBottom: 12, gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
        <div style={{ display: 'inline-flex', border: '1px solid var(--line)', borderRadius: 6, overflow: 'hidden' }}>
          {[{ id: 'pending', label: 'Pending', icon: 'mail' },
            { id: 'sent',    label: 'Sent',    icon: 'check' },
            { id: 'discarded', label: 'Discarded', icon: 'discard' }].map((t) => (
            <button key={t.id} onClick={() => setTab(t.id)}
              style={{ padding: '8px 14px', border: 'none', borderRight: '1px solid var(--line)',
                background: tab === t.id ? 'var(--ivory)' : 'transparent',
                color: tab === t.id ? 'white' : 'var(--ivory)', cursor: 'pointer',
                display: 'inline-flex', gap: 6, alignItems: 'center', fontSize: 13 }}>
              <Icon name={t.icon} size={14} /> {t.label}
              {tab === t.id && items && ` (${items.length})`}
            </button>
          ))}
        </div>
        <div style={{ display: 'inline-flex', alignItems: 'center', gap: 6, marginLeft: 6 }}>
          <Icon name="search" size={14} />
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search subject or recipient"
            style={{ padding: '6px 10px', border: '1px solid var(--line)', borderRadius: 6, minWidth: 220, fontSize: 13 }} />
        </div>
        <div className="spacer" />
        {tab === 'pending' && <LiveDot on={autoRefresh} label={autoRefresh ? 'Live · updates every 30s' : 'Live off'} />}
        <IconBtn name="refresh" title="Refresh now" onClick={() => load({ soft: true })} disabled={busy} />
        {tab === 'pending' && (
          <label className="muted small" style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
            <input type="checkbox" checked={autoRefresh} onChange={(e) => setAutoRefresh(e.target.checked)} />
            Auto
          </label>
        )}
      </div>

      {/* BULK TOOLBAR */}
      {checked.size > 0 && tab === 'pending' && (
        <div className="panel" style={{ marginBottom: 10, padding: 10,
          display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap',
          borderColor: 'var(--gold)', background: 'var(--gold-soft)' }}>
          <span style={{ fontWeight: 600, fontSize: 13 }}>{checked.size} selected</span>
          <div className="spacer" />
          <button className="btn btn-gold small" disabled={busy} onClick={() => bulk('send')}>
            <Icon name="send" size={13} /> Send all
          </button>
          <button className="btn ghost small" disabled={busy} onClick={() => bulk('snooze', { minutes: 60 })}>
            <Icon name="snooze" size={13} /> 1h
          </button>
          <button className="btn ghost small" disabled={busy} onClick={() => bulk('snooze', { minutes: 60 * 24 })}>
            <Icon name="snooze" size={13} /> 1d
          </button>
          <button className="btn ghost small" disabled={busy} onClick={() => setBulkScheduleOpen(true)}>
            <Icon name="schedule" size={13} /> Schedule
          </button>
          <button className="btn ghost small" disabled={busy} onClick={() => bulk('discard')} style={{ color: 'var(--danger)' }}>
            <Icon name="discard" size={13} /> Discard all
          </button>
          <button className="btn ghost small" onClick={clearChecks} title="Clear selection">
            <Icon name="x" size={13} />
          </button>
        </div>
      )}

      {err && <div role="alert" className="notice err">{err}</div>}

      {items === null ? (
        <div className="panel muted" style={{ textAlign: 'center', padding: 40 }}>Loading drafts…</div>
      ) : items.length === 0 ? (
        <EmptyState kind={tab} />
      ) : (
        <div className="row" style={{ gap: 14, alignItems: 'flex-start' }}>
          {/* LEFT RAIL */}
          <div style={{ flex: '0 0 380px', maxWidth: 380 }}>
            <div className="panel" style={{ padding: 0, maxHeight: '76vh', overflowY: 'auto' }}>
              {tab === 'pending' && items.length > 0 && (
                <div style={{ padding: '8px 12px', borderBottom: '1px solid var(--line)',
                  display: 'flex', alignItems: 'center', gap: 8, background: 'var(--ink-2)', position: 'sticky', top: 0 }}>
                  <input type="checkbox" checked={checked.size === items.length}
                    onChange={(e) => e.target.checked ? selectAll() : clearChecks()}
                    title="Select all" />
                  <span className="muted small">{items.length} draft{items.length === 1 ? '' : 's'} waiting</span>
                </div>
              )}
              {items.map((it) => (
                <DraftCard key={it.id} draft={it}
                  selected={it.id === selectedId}
                  showCheckbox={tab === 'pending'}
                  checked={checked.has(it.id)}
                  onCheck={() => toggleChecked(it.id)}
                  onSelect={() => setSelectedId(it.id)}
                  onQuickSend={tab === 'pending' ? () => handleSend(it, effectiveEdits(it)) : null}
                  onQuickSnooze={tab === 'pending' ? () => handleSnooze(it, 60) : null}
                  onQuickDiscard={tab === 'pending' ? () => handleDiscard(it) : null}
                  busy={busy}
                />
              ))}
              {tab === 'pending' && (
                <div style={{ padding: '10px 12px', borderTop: '1px solid var(--line)',
                  background: 'var(--ink-2)', color: 'var(--muted)', fontSize: 11, display: 'flex', gap: 10, flexWrap: 'wrap' }}>
                  <span><kbd style={{ padding: '1px 6px', border: '1px solid var(--line)', borderRadius: 3, fontFamily: 'monospace' }}>j</kbd>/<kbd style={{ padding: '1px 6px', border: '1px solid var(--line)', borderRadius: 3, fontFamily: 'monospace' }}>k</kbd> nav</span>
                  <span><kbd style={{ padding: '1px 6px', border: '1px solid var(--line)', borderRadius: 3, fontFamily: 'monospace' }}>e</kbd> send</span>
                  <span><kbd style={{ padding: '1px 6px', border: '1px solid var(--line)', borderRadius: 3, fontFamily: 'monospace' }}>s</kbd> snooze</span>
                  <span><kbd style={{ padding: '1px 6px', border: '1px solid var(--line)', borderRadius: 3, fontFamily: 'monospace' }}>#</kbd> discard</span>
                </div>
              )}
            </div>
          </div>
          {/* RIGHT PANE */}
          <div style={{ flex: 1, minWidth: 0 }}>
            {selected ? (
              <DraftPreview draft={selected}
                subject={editSubject} body={editBody} note={editNote}
                setSubject={setEditSubject} setBody={setEditBody} setNote={setEditNote}
                onSend={handleSend} onDiscard={handleDiscard}
                onSnooze={handleSnooze} onSchedule={handleSchedule} busy={busy} />
            ) : (
              <div className="panel" style={{ padding: 40, textAlign: 'center', color: 'var(--muted)' }}>
                Pick a draft on the left to preview and send.
              </div>
            )}
          </div>
        </div>
      )}
      <SchedulePicker open={bulkScheduleOpen} onClose={() => setBulkScheduleOpen(false)}
        onPick={(iso) => { setBulkScheduleOpen(false); bulk('schedule', { at: iso }); }} />
    </>
  );
}

/* ---- RULES TAB ---- */
function RulesTab({ showToast }) {
  const [r, setR] = useState(null);
  const [err, setErr] = useState('');
  const [saving, setSaving] = useState(false);
  useEffect(() => { api.loNotifRulesGet().then((x) => setR(x.rules)).catch((e) => setErr(e.message)); }, []);
  if (err && !r) return <div className="notice err">{err}</div>;
  if (!r) return <div className="panel muted">Loading…</div>;

  const save = async (patch) => {
    const prev = r;
    const next = { ...r, ...patch };
    setR(next);
    setSaving(true); setErr('');
    try {
      await api.loNotifRulesPut(next);
      showToast && showToast('Saved.');
    } catch (e) { setR(prev); setErr(e.message || 'Save failed'); }
    finally { setSaving(false); }
  };
  const startLearning = async () => {
    if (!window.confirm('Start Learning Mode for the next 72 hours? EVERY notification will be parked as a draft so you can watch what would go out — nothing sends automatically. You can leave it early from this page.')) return;
    setSaving(true);
    try { await api.loNotifRulesPut({ ...r, learning_mode_hours: 72 }); const x = await api.loNotifRulesGet(); setR(x.rules); showToast && showToast('Learning mode on for 72 hours.'); }
    catch (e) { setErr(e.message || 'Save failed'); }
    finally { setSaving(false); }
  };
  const stopLearning = async () => {
    setSaving(true);
    try { await api.loNotifRulesPut({ ...r, learning_mode_until: null, learning_mode_hours: 0 }); const x = await api.loNotifRulesGet(); setR(x.rules); showToast && showToast('Learning mode off.'); }
    catch (e) { setErr(e.message || 'Save failed'); }
    finally { setSaving(false); }
  };

  const inLearning = r.learning_mode_until && new Date(r.learning_mode_until) > new Date();
  const workMask = r.work_days_mask || 127;

  return (
    <>
      <div className="panel" style={{ marginBottom: 14 }}>
        <h3 style={{ marginBottom: 4 }}>Learning mode</h3>
        <p className="muted small" style={{ marginTop: 0 }}>
          Route every non-required notification to Drafts for a few days. Perfect if you're new here — you'll
          see exactly what would go out and turn the noisy ones off before you leave shadow mode.
        </p>
        {inLearning ? (
          <div className="row" style={{ gap: 10, alignItems: 'center' }}>
            <span className="ec-pill ec-pill-ok">Learning until {fmtWhen(r.learning_mode_until, true)}</span>
            <button className="btn ghost" disabled={saving} onClick={stopLearning}>End learning mode</button>
          </div>
        ) : (
          <button className="btn btn-gold" disabled={saving} onClick={startLearning}>Start 72-hour learning mode</button>
        )}
      </div>

      <div className="panel" style={{ marginBottom: 14 }}>
        <h3 style={{ marginBottom: 4 }}>Quiet hours</h3>
        <p className="muted small" style={{ marginTop: 0 }}>
          Any notification firing outside these hours goes to Drafts (never lost — you review + send, or the
          worker sends it once the window opens). Blank on both = 24/7 sending.
        </p>
        <div className="row" style={{ gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
          <label className="muted small">Quiet from</label>
          <input type="time" value={r.quiet_hours_start || ''} onChange={(e) => save({ quiet_hours_start: e.target.value || null })}
            style={{ padding: '4px 8px', border: '1px solid var(--line)', borderRadius: 4 }} />
          <label className="muted small">to</label>
          <input type="time" value={r.quiet_hours_end || ''} onChange={(e) => save({ quiet_hours_end: e.target.value || null })}
            style={{ padding: '4px 8px', border: '1px solid var(--line)', borderRadius: 4 }} />
          <span className="muted small">
            {r.quiet_hours_start && r.quiet_hours_end ? `— ${r.quiet_hours_start} to ${r.quiet_hours_end} in ${r.timezone || 'America/New_York'}` : '— (no quiet hours)'}
          </span>
        </div>
      </div>

      <div className="panel" style={{ marginBottom: 14 }}>
        <h3 style={{ marginBottom: 4 }}>Work days</h3>
        <p className="muted small" style={{ marginTop: 0 }}>Send on these days automatically. Others route to Drafts.</p>
        <div className="row" style={{ gap: 4 }}>
          {WEEKDAYS.map((d, i) => (
            <button key={d}
              onClick={() => save({ work_days_mask: toggleDay(workMask, i) })}
              style={{ padding: '6px 12px', border: '1px solid var(--line)', borderRadius: 4,
                background: maskDay(workMask, i) ? 'var(--ivory)' : 'transparent',
                color: maskDay(workMask, i) ? 'white' : 'var(--ivory)', cursor: 'pointer' }}>{d}</button>
          ))}
        </div>
      </div>

      <div className="panel" style={{ marginBottom: 14 }}>
        <h3 style={{ marginBottom: 4 }}>Safety fallback</h3>
        <p className="muted small" style={{ marginTop: 0 }}>
          If a draft sits untouched for this long, PILOT auto-sends it so nothing important gets stuck.
          Set to 0 to turn off (drafts wait forever).
        </p>
        <div className="row" style={{ gap: 6, alignItems: 'center' }}>
          <input type="number" min="0" max="720" value={r.auto_send_after_hours || 0}
            onChange={(e) => save({ auto_send_after_hours: parseInt(e.target.value, 10) || 0 })}
            style={{ padding: '4px 8px', border: '1px solid var(--line)', borderRadius: 4, width: 80 }} />
          <span className="muted small">hours</span>
        </div>
      </div>

      <div className="panel" style={{ marginBottom: 14 }}>
        <h3 style={{ marginBottom: 4 }}>Compose default</h3>
        <p className="muted small" style={{ marginTop: 0 }}>
          When you write your own notification (top-right ✎ Compose), do you want it to go out right away
          or land in Drafts so you double-check?
        </p>
        <div className="row" style={{ gap: 10 }}>
          <label className="muted small" style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
            <input type="radio" checked={r.compose_default === 'send'} onChange={() => save({ compose_default: 'send' })} /> Send right away
          </label>
          <label className="muted small" style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
            <input type="radio" checked={r.compose_default === 'draft'} onChange={() => save({ compose_default: 'draft' })} /> Save to drafts first
          </label>
        </div>
      </div>

      <div className="panel">
        <h3 style={{ marginBottom: 4 }}>Timezone</h3>
        <p className="muted small" style={{ marginTop: 0 }}>The clock quiet hours and work days follow.</p>
        <select value={r.timezone} onChange={(e) => save({ timezone: e.target.value })}
          style={{ padding: '4px 8px', border: '1px solid var(--line)', borderRadius: 4 }}>
          {['America/New_York', 'America/Chicago', 'America/Denver', 'America/Los_Angeles', 'America/Phoenix'].map((tz) => (
            <option key={tz} value={tz}>{tz}</option>
          ))}
        </select>
      </div>
    </>
  );
}

/* ---- ANALYTICS TAB ---- */
function AnalyticsTab() {
  const [days, setDays] = useState(30);
  const [data, setData] = useState(null);
  const [err, setErr] = useState('');
  useEffect(() => { api.loNotifAnalytics(days).then(setData).catch((e) => setErr(e.message)); }, [days]);
  if (err) return <div className="notice err">{err}</div>;
  if (!data) return <div className="panel muted">Loading…</div>;
  const top = [...data.byKey].sort((a, b) => (b.fired + b.pending) - (a.fired + a.pending)).slice(0, 20);
  const openRate = data.totals.emailed ? Math.round(100 * data.totals.opened / data.totals.emailed) : 0;
  return (
    <>
      <div className="row" style={{ gap: 8, marginBottom: 12, alignItems: 'center' }}>
        <label className="muted small">Window</label>
        <select value={days} onChange={(e) => setDays(parseInt(e.target.value, 10))}
          style={{ padding: '4px 8px', border: '1px solid var(--line)', borderRadius: 4 }}>
          <option value={7}>Last 7 days</option>
          <option value={30}>Last 30 days</option>
          <option value={60}>Last 60 days</option>
          <option value={90}>Last 90 days</option>
        </select>
      </div>
      <div className="panel" style={{ marginBottom: 14, display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', gap: 12 }}>
        <Stat label="Fired" value={data.totals.fired} sub="on your files" />
        <Stat label="Emailed" value={data.totals.emailed} sub="delivered" />
        <Stat label="Open rate" value={openRate + '%'} sub={`${data.totals.opened} opens`} />
        <Stat label="Failed" value={data.totals.emailFailed} sub="email errors" tone={data.totals.emailFailed ? 'danger' : 'muted'} />
        <Stat label="Drafted" value={data.totals.sentFromDraft + data.totals.pending + data.totals.discarded} sub="parked for review" />
        <Stat label="Discarded" value={data.totals.discarded} sub="you dropped" />
      </div>
      <div className="panel">
        <div style={{ fontWeight: 600, marginBottom: 8 }}>Top notifications</div>
        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <thead>
            <tr style={{ borderBottom: '1px solid var(--line)', textAlign: 'left' }}>
              <th style={{ padding: 8 }}>Notification</th>
              <th style={{ padding: 8, textAlign: 'right' }}>Fired</th>
              <th style={{ padding: 8, textAlign: 'right' }}>Emailed</th>
              <th style={{ padding: 8, textAlign: 'right' }}>Opened</th>
              <th style={{ padding: 8, textAlign: 'right' }}>Drafted</th>
              <th style={{ padding: 8, textAlign: 'right' }}>Sent from draft</th>
              <th style={{ padding: 8, textAlign: 'right' }}>Discarded</th>
            </tr>
          </thead>
          <tbody>
            {top.map((r) => (
              <tr key={r.key} style={{ borderBottom: '1px solid var(--line)' }}>
                <td style={{ padding: 8 }}>{r.label}{r.forced ? <span className="ec-pill ec-pill-ok" style={{ marginLeft: 6, fontSize: 10 }}>required</span> : null}</td>
                <td style={{ padding: 8, textAlign: 'right' }}>{r.fired}</td>
                <td style={{ padding: 8, textAlign: 'right' }}>{r.emailed}</td>
                <td style={{ padding: 8, textAlign: 'right' }}>{r.opened}</td>
                <td style={{ padding: 8, textAlign: 'right' }}>{r.pending}</td>
                <td style={{ padding: 8, textAlign: 'right' }}>{r.sentFromDraft}</td>
                <td style={{ padding: 8, textAlign: 'right' }}>{r.discarded}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}
function Stat({ label, value, sub, tone }) {
  const color = tone === 'danger' ? 'var(--danger, #b3261e)' : 'var(--ivory)';
  return (
    <div style={{ padding: 10 }}>
      <div className="muted small" style={{ textTransform: 'uppercase', letterSpacing: '.06em' }}>{label}</div>
      <div style={{ fontSize: 24, fontWeight: 600, color }}>{value}</div>
      {sub && <div className="muted small">{sub}</div>}
    </div>
  );
}

/* ---- ROOT ---- */
export default function StaffNotificationCenter() {
  const [tab, setTab] = useState('catalog');
  const [pendingCount, setPendingCount] = useState(0);
  const [composeOpen, setComposeOpen] = useState(false);
  const [toast, setToast] = useState('');
  const [toastTimer, setToastTimer] = useState(null);

  useEffect(() => {
    // Live tab badge — poll every 30s + on focus. When the Drafts tab is open
    // its own load() already updates via onCountChange, so this is mostly for
    // the Catalog/Rules/Analytics tabs where the LO can see fresh drafts arrive.
    let alive = true;
    const poll = () => api.loNotifDraftCount().then((r) => { if (alive) setPendingCount(r.pending || 0); }).catch(() => {});
    poll();
    const t = setInterval(poll, 30_000);
    const onFocus = () => poll();
    window.addEventListener('focus', onFocus);
    return () => { alive = false; clearInterval(t); window.removeEventListener('focus', onFocus); };
  }, []);

  const showToast = useCallback((t) => {
    setToast(t);
    if (toastTimer) clearTimeout(toastTimer);
    setToastTimer(setTimeout(() => setToast(''), 3500));
  }, [toastTimer]);

  return (
    <>
      <div className="row" style={{ marginBottom: 14, alignItems: 'flex-start' }}>
        <div style={{ flex: 1 }}>
          <h1>Notification Center</h1>
          <p className="muted small">
            The master control for every notification your borrowers receive. Turn any one off, keep it
            Automatic, or park it as a Draft so you review it before it goes. DocuSign, security and
            account notifications always send.
          </p>
        </div>
        <button className="btn btn-gold" onClick={() => setComposeOpen(true)}>✎ Compose</button>
      </div>

      <div className="row" style={{ marginBottom: 14, gap: 6, flexWrap: 'wrap' }}>
        <Tab active={tab === 'catalog'} onClick={() => setTab('catalog')}>Catalog</Tab>
        <Tab active={tab === 'drafts'} onClick={() => setTab('drafts')} badge={pendingCount}>Drafts</Tab>
        <Tab active={tab === 'rules'} onClick={() => setTab('rules')}>Rules</Tab>
        <Tab active={tab === 'analytics'} onClick={() => setTab('analytics')}>Analytics</Tab>
      </div>

      {tab === 'catalog'   && <CatalogTab />}
      {tab === 'drafts'    && <DraftsTab onCountChange={setPendingCount} showToast={showToast} />}
      {tab === 'rules'     && <RulesTab showToast={showToast} />}
      {tab === 'analytics' && <AnalyticsTab />}

      <ComposeModal open={composeOpen} onClose={() => setComposeOpen(false)}
        onSent={(mode) => showToast(mode === 'draft' ? 'Saved to Drafts.' : 'Sent.')} />
      <Toast show={!!toast} onDismiss={() => setToast('')}>{toast}</Toast>
    </>
  );
}
