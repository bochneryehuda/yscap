import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { NavLink } from 'react-router-dom';
import { api } from '../lib/api.js';

/* ═══════════════════════════════════════════════════════════════════════════
   LOAN OFFICER — NOTIFICATION CENTER
   Two tabs:
     · Catalog — every notification the system can send, grouped by category,
                 with a switch (Off / Auto / Manual) and an info tooltip.
     · Drafts  — the queue of notifications parked in Manual mode: preview +
                 Send / Discard. Also shows a "Sent" and "Discarded" history.
   Everything on by default. DocuSign / security / account are FORCED — the row
   shows "Always on" and is not editable.
   ═════════════════════════════════════════════════════════════════════════ */

function InfoDot({ text }) {
  return (
    <span className="nc-info" title={text} aria-label={text}
      style={{ display: 'inline-flex', width: 16, height: 16, borderRadius: '50%',
        background: 'var(--paper)', color: 'var(--ink)', border: '1px solid var(--line)',
        alignItems: 'center', justifyContent: 'center', fontSize: 11, marginLeft: 6,
        cursor: 'help', flexShrink: 0 }}>i</span>
  );
}

function TabButton({ active, onClick, children, badge }) {
  return (
    <button onClick={onClick} className="btn"
      style={{ background: active ? 'var(--ink)' : 'transparent', color: active ? 'white' : 'var(--ink)',
        border: '1px solid var(--line)', padding: '6px 14px', marginRight: 6, position: 'relative' }}>
      {children}
      {badge ? <span className="sb-badge" style={{ marginLeft: 8 }}>{badge > 99 ? '99+' : badge}</span> : null}
    </button>
  );
}

function ModeSwitch({ enabled, mode, forced, onChange }) {
  // Renders as three segmented buttons: Off | Auto | Manual. Forced entries
  // just show "Always on" with no editable controls.
  if (forced) {
    return <span className="ec-pill ec-pill-ok" title="Required — this notification can’t be turned off">Always on</span>;
  }
  const opts = [
    { id: 'off',       label: 'Off',       state: !enabled },
    { id: 'automatic', label: 'Automatic', state: enabled && mode === 'automatic' },
    { id: 'manual',    label: 'Manual',    state: enabled && mode === 'manual' },
  ];
  const pick = (id) => {
    if (id === 'off') return onChange({ enabled: false, mode });
    return onChange({ enabled: true, mode: id });
  };
  return (
    <div style={{ display: 'inline-flex', border: '1px solid var(--line)', borderRadius: 6, overflow: 'hidden' }}>
      {opts.map((o) => (
        <button key={o.id} onClick={() => pick(o.id)}
          title={o.id === 'off' ? 'Do not send this notification at all'
               : o.id === 'automatic' ? 'Send automatically as soon as the event fires'
               : 'Do NOT send automatically — park in Drafts for me to review and send'}
          style={{
            padding: '4px 10px', border: 'none', fontSize: 12,
            background: o.state ? 'var(--ink)' : 'transparent',
            color: o.state ? 'white' : 'var(--ink)', cursor: 'pointer',
            borderRight: '1px solid var(--line)'
          }}>{o.label}</button>
      ))}
    </div>
  );
}

function CatalogTab() {
  const [data, setData] = useState(null);
  const [prefs, setPrefs] = useState({});   // key -> {enabled, mode}
  const [err, setErr] = useState('');
  const [msg, setMsg] = useState('');
  const [busy, setBusy] = useState(null);
  const [query, setQuery] = useState('');

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
      // Roll back so the UI reflects the true stored state.
      setPrefs((m) => {
        const n = { ...m };
        if (before) n[item.key] = before; else delete n[item.key];
        return n;
      });
      setErr(e.message || 'Could not save');
    } finally { setBusy(null); }
  }, [prefs]);

  const bulkSet = useCallback(async (kind) => {
    // kind: 'all-on-auto' | 'all-on-manual' | 'all-off'
    if (!data) return;
    const changes = data.items
      .filter((i) => !i.forced)
      .map((i) => ({
        key: i.key,
        enabled: kind !== 'all-off',
        mode: kind === 'all-on-manual' ? 'manual' : 'automatic',
      }));
    setBusy('*');
    try {
      await api.loNotifBulkSave(changes);
      const p = await api.loNotifPrefs();
      const m = {};
      for (const r of p.prefs || []) m[r.notif_key] = { enabled: r.enabled, mode: r.mode };
      setPrefs(m);
      flash('Applied');
    } catch (e) { setErr(e.message || 'Bulk update failed'); }
    finally { setBusy(null); }
  }, [data]);

  if (err && !data) return <div role="alert" className="notice err">{err}</div>;
  if (!data) return <div className="panel muted">Loading…</div>;

  const q = query.trim().toLowerCase();
  const filterItem = (it) => !q
    || it.label.toLowerCase().includes(q)
    || it.description.toLowerCase().includes(q)
    || it.key.toLowerCase().includes(q);

  const groups = data.categories.map((c) => ({
    ...c,
    items: data.items.filter((i) => i.category === c.id).filter(filterItem),
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
          <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search notifications…"
            style={{ padding: '6px 10px', border: '1px solid var(--line)', borderRadius: 4, minWidth: 200 }} />
          {msg && <span className="muted small">{msg} ✓</span>}
        </div>
        <div className="row" style={{ marginTop: 10, gap: 6, flexWrap: 'wrap' }}>
          <button className="btn ghost small" disabled={busy === '*'} onClick={() => bulkSet('all-on-auto')}>Everything automatic</button>
          <button className="btn ghost small" disabled={busy === '*'} onClick={() => bulkSet('all-on-manual')}>Everything manual (draft)</button>
          <button className="btn ghost small" disabled={busy === '*'} onClick={() => bulkSet('all-off')}
            title="This will silence every non-required notification for your borrowers. DocuSign, security and account emails still send.">Turn everything off</button>
        </div>
      </div>

      {err && <div role="alert" className="notice err">{err}</div>}

      {groups.map((g) => (
        <div className="panel" key={g.id} style={{ marginBottom: 14 }}>
          <div style={{ fontWeight: 600, textTransform: 'uppercase', letterSpacing: '.06em',
            fontSize: 12, color: 'var(--muted)', paddingBottom: 8, borderBottom: '1px solid var(--line)' }}>
            {g.label}
          </div>
          {g.items.map((it) => {
            const st = stateFor(it);
            return (
              <div key={it.key} className="row" style={{
                padding: '10px 0', borderBottom: '1px solid var(--line)', alignItems: 'flex-start',
                flexWrap: 'nowrap', gap: 10,
              }}>
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
        security and account notifications are required by law/policy and always send.
      </p>
    </>
  );
}

function DraftPreview({ draft, onSend, onDiscard, busy }) {
  const [editTitle, setEditTitle] = useState(draft.subject || '');
  const [editBody, setEditBody] = useState(draft.body || '');
  const [note, setNote] = useState('');
  useEffect(() => { setEditTitle(draft.subject || ''); setEditBody(draft.body || ''); setNote(''); }, [draft.id]);

  const send = () => onSend(draft, { title: editTitle, body: editBody, note });
  const canEdit = draft.status === 'pending';

  return (
    <div className="panel" style={{ padding: 16 }}>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 4 }}>
        <span className="ec-pill ec-pill-muted">{draft.entry ? draft.entry.label : draft.notifType}</span>
        {draft.loanNumber && <span className="muted small">{draft.loanNumber}</span>}
        {draft.address && <span className="muted small">· {draft.address}</span>}
      </div>
      <div className="muted small" style={{ marginBottom: 12 }}>
        To {draft.recipientKind === 'borrower' ? 'borrower' : 'staff'}
        {draft.recipientLabel ? ` — ${draft.recipientLabel}` : ''}
        {' · '}Parked {new Date(draft.createdAt).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })}
      </div>

      <label className="muted small">Subject</label>
      <input value={editTitle} disabled={!canEdit} onChange={(e) => setEditTitle(e.target.value)}
        style={{ width: '100%', padding: '6px 10px', border: '1px solid var(--line)', borderRadius: 4, marginBottom: 10 }} />

      <label className="muted small">Body preview</label>
      <textarea value={editBody} disabled={!canEdit} onChange={(e) => setEditBody(e.target.value)}
        rows={6} style={{ width: '100%', padding: '8px 10px', border: '1px solid var(--line)', borderRadius: 4, marginBottom: 10, fontFamily: 'inherit' }} />

      {canEdit && (
        <>
          <label className="muted small">Add a personal note (optional)</label>
          <textarea value={note} onChange={(e) => setNote(e.target.value)}
            rows={2} placeholder="Anything you want to add to the email…"
            style={{ width: '100%', padding: '8px 10px', border: '1px solid var(--line)', borderRadius: 4, marginBottom: 12, fontFamily: 'inherit' }} />
        </>
      )}

      <div className="row" style={{ gap: 8 }}>
        {canEdit ? (
          <>
            <button className="btn btn-gold" disabled={busy} onClick={send}>{busy ? 'Sending…' : 'Send now'}</button>
            <button className="btn ghost" disabled={busy} onClick={() => onDiscard(draft)}>Discard</button>
          </>
        ) : (
          <span className="muted small">
            {draft.status === 'sent'
              ? `Sent ${draft.sentAt ? new Date(draft.sentAt).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' }) : ''}`
              : `Discarded ${draft.discardedAt ? new Date(draft.discardedAt).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' }) : ''}`}
          </span>
        )}
        {draft.applicationId && (
          <NavLink to={`/internal/app/${draft.applicationId}`} className="btn ghost small" style={{ marginLeft: 'auto' }}>
            Open the file
          </NavLink>
        )}
      </div>
    </div>
  );
}

function DraftsTab({ onCountChange }) {
  const [tab, setTab] = useState('pending');    // 'pending' | 'sent' | 'discarded'
  const [items, setItems] = useState(null);
  const [selectedId, setSelectedId] = useState(null);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);

  const load = useCallback(async (which) => {
    setItems(null); setErr(''); setSelectedId(null);
    try {
      const r = await api.loNotifDrafts(which);
      setItems(r.items || []);
      if (r.items && r.items[0]) setSelectedId(r.items[0].id);
      if (which === 'pending' && onCountChange) onCountChange((r.items || []).length);
    } catch (e) { setErr(e.message || 'Could not load drafts'); }
  }, [onCountChange]);

  useEffect(() => { load(tab); }, [tab, load]);

  const selected = items && items.find((i) => i.id === selectedId);

  const handleSend = async (draft, edits) => {
    setBusy(true); setErr('');
    try {
      await api.loNotifDraftSend(draft.id, edits);
      await load(tab);
    } catch (e) { setErr(e.message || 'Send failed'); }
    finally { setBusy(false); }
  };
  const handleDiscard = async (draft) => {
    if (!window.confirm('Discard this notification? The borrower will never see it.')) return;
    setBusy(true); setErr('');
    try {
      await api.loNotifDraftDiscard(draft.id);
      await load(tab);
    } catch (e) { setErr(e.message || 'Discard failed'); }
    finally { setBusy(false); }
  };

  return (
    <>
      <div className="row" style={{ marginBottom: 12, gap: 6 }}>
        <TabButton active={tab === 'pending'} onClick={() => setTab('pending')}>Pending{items && tab === 'pending' ? ` (${items.length})` : ''}</TabButton>
        <TabButton active={tab === 'sent'} onClick={() => setTab('sent')}>Sent</TabButton>
        <TabButton active={tab === 'discarded'} onClick={() => setTab('discarded')}>Discarded</TabButton>
        <div className="spacer" />
        <button className="btn ghost small" onClick={() => load(tab)}>Refresh</button>
      </div>

      {err && <div role="alert" className="notice err">{err}</div>}

      {items === null ? (
        <div className="panel muted">Loading…</div>
      ) : items.length === 0 ? (
        <div className="panel" style={{ textAlign: 'center', padding: 30 }}>
          <div style={{ fontSize: 15, fontWeight: 500 }}>
            {tab === 'pending' ? 'No drafts waiting.' : tab === 'sent' ? 'No sent drafts yet.' : 'No discarded drafts.'}
          </div>
          {tab === 'pending' && (
            <div className="muted small" style={{ marginTop: 8 }}>
              Any notification you set to <strong>Manual</strong> in the Catalog tab lands here first —
              you review it and click Send.
            </div>
          )}
        </div>
      ) : (
        <div className="row" style={{ gap: 14, alignItems: 'flex-start' }}>
          {/* Left column — inbox-style list */}
          <div style={{ flex: '0 0 340px', maxWidth: 340 }}>
            <div className="panel" style={{ padding: 0, maxHeight: '70vh', overflowY: 'auto' }}>
              {items.map((it) => (
                <button key={it.id}
                  onClick={() => setSelectedId(it.id)}
                  style={{
                    display: 'block', width: '100%', textAlign: 'left',
                    padding: '10px 12px', background: it.id === selectedId ? 'var(--paper)' : 'transparent',
                    border: 'none', borderBottom: '1px solid var(--line)', cursor: 'pointer',
                  }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                    <span className="ec-pill ec-pill-muted" style={{ fontSize: 10 }}>
                      {it.entry ? it.entry.label : it.notifType}
                    </span>
                    {it.loanNumber && <span className="muted small">{it.loanNumber}</span>}
                  </div>
                  <div style={{ fontWeight: 500, marginTop: 2, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                    {it.subject || '(no subject)'}
                  </div>
                  <div className="muted small" style={{ marginTop: 2, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                    To {it.recipientLabel || (it.recipientKind === 'borrower' ? 'borrower' : 'staff')}
                    {' · '}{new Date(it.createdAt).toLocaleDateString([], { month: 'short', day: 'numeric' })}
                  </div>
                </button>
              ))}
            </div>
          </div>
          {/* Right column — full preview */}
          <div style={{ flex: 1, minWidth: 0 }}>
            {selected ? (
              <DraftPreview draft={selected} onSend={handleSend} onDiscard={handleDiscard} busy={busy} />
            ) : (
              <div className="panel muted">Pick a draft to review.</div>
            )}
          </div>
        </div>
      )}
    </>
  );
}

export default function StaffNotificationCenter() {
  const [tab, setTab] = useState('catalog');
  const [pendingCount, setPendingCount] = useState(0);

  useEffect(() => {
    api.loNotifDraftCount().then((r) => setPendingCount(r.pending || 0)).catch(() => {});
  }, []);

  return (
    <>
      <div className="row" style={{ marginBottom: 14 }}>
        <div>
          <h1>Notification Center</h1>
          <p className="muted small">
            Master control for every notification your borrowers and files send out. Turn any single one
            off, keep it Automatic, or park it as a Draft so you review it before it goes.
          </p>
        </div>
      </div>

      <div className="row" style={{ marginBottom: 14, gap: 6 }}>
        <TabButton active={tab === 'catalog'} onClick={() => setTab('catalog')}>Catalog</TabButton>
        <TabButton active={tab === 'drafts'} onClick={() => setTab('drafts')} badge={pendingCount}>Drafts</TabButton>
      </div>

      {tab === 'catalog' ? <CatalogTab /> : <DraftsTab onCountChange={setPendingCount} />}
    </>
  );
}
