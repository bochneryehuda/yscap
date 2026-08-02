import React, { useEffect, useMemo, useState } from 'react';

/* THE FILE'S AUDIT LOG.

   Owner-directed 2026-08-02: "File activity should be much more enhanced. You
   should see who uploaded that document, where he uploaded it, what happened
   with it, and every single activity — who did it, what was changed,
   timestamps. It should be your source of auditing when you want to see what
   went wrong. Every communication, every notification, every log, everything
   that happens in that file should be logged in that activity."

   The server (src/lib/activity.js) merges every trail the file leaves. This is
   the reading surface: filter by kind of activity, filter by person, search the
   text, and expand any row to the exact recorded detail — the before/after
   values, the entity touched, the IP it came from, and the real human behind an
   action taken inside a borrower-view session.

   BACK-COMPAT: a row only needs {at, kind, actor, actor_name, verb, label}. The
   audit fields (cat, source, entity_type, entity_id, detail, ip, actor_role,
   impersonator) are optional, so the borrower feed still renders unchanged.

   TEXT COLOR RULE (session rule): never a `--ink*` token for text — every one
   of them is LIGHT. Primary #141B22, secondary #4B585C. */
const INK = '#141B22';
const MUTED = '#4B585C';
const DANGER = 'var(--danger,#B3261E)';

const ICON = {
  message: '💬', document: '📄', condition: '❗', status: '📈',
  product: '🏷️', edit: '✏️', llc: '🏢', card: '💳',
  notification: '🔔', email: '✉️', sync: '🔗', security: '🔐',
  workflow: '🔀', request: '🌐', borrower: '👤', vendor: '🏬',
  track: '🏗️', setup: '⚙️', other: '•',
};

/* The filter chips. `cat` comes from the shared audit catalog, so an action
   added tomorrow lands in an existing bucket instead of vanishing. */
const CATS = [
  { k: 'all', label: 'Everything' },
  { k: 'document', label: 'Documents' },
  { k: 'condition', label: 'Conditions' },
  { k: 'file', label: 'The loan file' },
  { k: 'message', label: 'Messages' },
  { k: 'email', label: 'Email' },
  { k: 'notification', label: 'Notifications' },
  { k: 'pricing', label: 'Pricing' },
  { k: 'sync', label: 'Integrations' },
  { k: 'security', label: 'Access & security' },
  { k: 'request', label: 'Requests' },
];
// Audit categories that belong under the "Access & security" chip.
const SECURITY_CATS = new Set(['pii', 'auth', 'security']);
const catOf = (e) => (SECURITY_CATS.has(e.cat) ? 'security' : (e.cat || 'other'));

function ago(ts) {
  if (!ts) return '';
  const s = Math.max(0, (Date.now() - new Date(ts).getTime()) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return new Date(ts).toLocaleDateString();
}
const exact = (ts) => (ts ? new Date(ts).toLocaleString(undefined, {
  year: 'numeric', month: 'short', day: 'numeric',
  hour: 'numeric', minute: '2-digit', second: '2-digit',
}) : 'time not recorded');

const who = (e) => e.actor_name
  || (e.actor === 'borrower' ? 'The borrower'
    : e.actor === 'staff' ? 'A staff member'
    : e.actor === 'external' ? 'Someone outside' : 'PILOT');

const dayKey = (ts) => {
  const d = ts ? new Date(ts) : null;
  return d && !isNaN(d.getTime())
    ? d.toLocaleDateString(undefined, { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })
    : 'Not timestamped';
};

/** The recorded detail blob, as a readable table rather than raw JSON. */
function DetailTable({ detail }) {
  if (!detail || typeof detail !== 'object') return null;
  const entries = Object.entries(detail).filter(([, v]) => v != null && v !== '');
  if (!entries.length) return null;
  return (
    <table style={{ width: '100%', borderCollapse: 'collapse', marginTop: 6, fontSize: 12 }}>
      <tbody>
        {entries.map(([k, v]) => (
          <tr key={k}>
            <td style={{ color: MUTED, padding: '2px 10px 2px 0', verticalAlign: 'top', whiteSpace: 'nowrap' }}>
              {k.replace(/_/g, ' ')}
            </td>
            <td style={{ color: INK, padding: '2px 0', overflowWrap: 'anywhere' }}>
              {typeof v === 'object'
                ? <pre style={{ margin: 0, whiteSpace: 'pre-wrap', fontSize: 11 }}>{JSON.stringify(v, null, 1)}</pre>
                : String(v)}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function EventRow({ e, expanded, onToggle, last }) {
  const hasMore = !!(e.detail || e.ip || e.entity_id || e.user_agent || e.source);
  const alarming = e.kind === 'security' || e.impersonator;
  return (
    <div style={{ padding: '8px 0', borderBottom: last ? 'none' : '1px solid var(--line,#EAE4D7)' }}>
      <div className="row" style={{ gap: 10, alignItems: 'baseline', flexWrap: 'nowrap' }}>
        <span aria-hidden style={{ flex: 'none' }}>{ICON[e.kind] || '•'}</span>
        <div style={{ flex: 1, minWidth: 0 }}>
          <span style={{ color: INK }}>
            <strong>{who(e)}</strong>
            {e.actor_role && <span style={{ color: MUTED, fontSize: 12 }}> ({String(e.actor_role).replace(/_/g, ' ')})</span>}
            {/* ON-BEHALF-OF. Without this line, everything a staffer does inside
                a borrower-view session reads as the borrower having done it. */}
            {e.impersonator && (
              <span style={{ color: DANGER, fontSize: 12 }}> — actually {e.impersonator}, signed in as them</span>
            )}
            {' '}{e.verb}
          </span>
          {e.label && (
            <div style={{ color: alarming ? INK : MUTED, fontSize: 12, marginTop: 2, whiteSpace: 'pre-line', overflowWrap: 'anywhere' }}>{e.label}</div>
          )}
          {hasMore && (
            <button type="button" className="btn link small" style={{ padding: 0, marginTop: 2 }} onClick={onToggle}>
              {expanded ? 'Hide the recorded detail' : 'Show the recorded detail'}
            </button>
          )}
          {expanded && (
            <div style={{ marginTop: 4, padding: '8px 10px', background: 'var(--paper,#F6F3EC)', borderRadius: 8, border: '1px solid var(--line,#EAE4D7)' }}>
              <div style={{ color: MUTED, fontSize: 12 }}>
                {exact(e.at)}
                {e.source ? ` · recorded by: ${e.source}` : ''}
                {e.entity_type ? ` · ${e.entity_type}` : ''}
                {e.entity_id ? ` ${String(e.entity_id).slice(0, 8)}…` : ''}
                {e.ip ? ` · from ${e.ip}` : ''}
              </div>
              {e.user_agent && (
                <div style={{ color: MUTED, fontSize: 11, marginTop: 2, overflowWrap: 'anywhere' }}>{e.user_agent}</div>
              )}
              <DetailTable detail={e.detail} />
            </div>
          )}
        </div>
        <span style={{ color: MUTED, fontSize: 12, whiteSpace: 'nowrap', flex: 'none' }} title={exact(e.at)}>{ago(e.at)}</span>
      </div>
    </div>
  );
}

/* Hand the reader the whole thing as a file. An audit log you cannot take away
   with you is not much use to an auditor. */
function exportCsv(rows, title) {
  const cell = (v) => `"${String(v == null ? '' : v).replace(/"/g, '""').replace(/\r?\n/g, ' ⏎ ')}"`;
  const head = ['When (exact)', 'Who', 'Role', 'Acting for', 'What happened', 'Detail', 'Category', 'Recorded by', 'Entity', 'Entity id', 'IP'];
  const body = rows.map((e) => [exact(e.at), who(e), e.actor_role || '', e.impersonator || '',
    e.verb || '', e.label || '', catOf(e), e.source || '', e.entity_type || '', e.entity_id || '', e.ip || ''].map(cell).join(','));
  const blob = new Blob([[head.map(cell).join(','), ...body].join('\r\n')], { type: 'text/csv;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `${String(title || 'activity').toLowerCase().replace(/[^a-z0-9]+/g, '-')}-${new Date().toISOString().slice(0, 10)}.csv`;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}

/**
 * `fetcher` is an async () => rows, so one component serves the borrower-safe
 * feed and the full staff audit log.
 *  - `compact` → the terse one-line-per-event rendering the borrower file uses.
 *  - `audit`   → filtering, search, day headers, expandable detail, export.
 *  - `onDepth` → called with true/false when the reader asks for the
 *    request-level layer, so the screen can re-fetch with `requests=1`.
 */
export default function ActivityFeed({ fetcher, title = 'Activity', limit = 15, compact = false, audit = false, onDepth = null, deep = false }) {
  const [rows, setRows] = useState(null);
  const [showAll, setShowAll] = useState(false);
  const [cat, setCat] = useState('all');
  const [actor, setActor] = useState('all');
  const [q, setQ] = useState('');
  const [openRow, setOpenRow] = useState(null);

  useEffect(() => {
    let a = true;
    setRows(null);
    fetcher().then((r) => a && setRows(r || [])).catch(() => a && setRows([]));
    return () => { a = false; };
  }, [fetcher]);

  const people = useMemo(() => {
    const seen = new Set();
    for (const e of rows || []) if (e.actor_name) seen.add(e.actor_name);
    return [...seen].sort();
  }, [rows]);

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return (rows || []).filter((e) => {
      if (cat !== 'all' && catOf(e) !== cat) return false;
      if (actor !== 'all' && (e.actor_name || '') !== actor) return false;
      if (!needle) return true;
      return [e.verb, e.label, e.actor_name, e.impersonator, e.entity_type, e.source]
        .some((v) => String(v || '').toLowerCase().includes(needle));
    });
  }, [rows, cat, actor, q]);

  // The server puts an un-timestamped row at the top when a trail could not be
  // read. Surfacing it as a banner is what lets a reader trust the rest.
  const gap = useMemo(() => (rows || []).find((e) => e.source === 'meta'), [rows]);

  if (!rows) return null;

  const shown = (showAll || audit) ? filtered : filtered.slice(0, limit);

  // ── the borrower / terse rendering, unchanged ────────────────────────────
  if (compact) {
    return (
      <div className="panel" style={{ marginTop: 18, padding: 16 }}>
        <div className="row" style={{ marginBottom: 6 }}>
          <h3>{title}</h3><div className="spacer" />
          <span className="muted small">{rows.length} event{rows.length === 1 ? '' : 's'}</span>
        </div>
        {rows.length === 0 ? <p className="muted small">Nothing yet.</p> : (
          <ul className="auditlog">
            {(showAll ? rows : rows.slice(0, limit)).map((e, i) => (
              <li key={i} className="auditlog-row">
                <span className="al-time" title={exact(e.at)}>{ago(e.at)}</span>
                <span className="al-text">
                  <strong>{who(e)}</strong> {e.verb}
                  {e.label ? <span className="muted"> — {String(e.label).replace(/\n/g, '; ')}</span> : null}
                </span>
              </li>
            ))}
          </ul>
        )}
        {rows.length > limit && (
          <button className="btn link small" style={{ marginTop: 8 }} onClick={() => setShowAll((s) => !s)}>
            {showAll ? 'Show recent only' : `Show all ${rows.length} events`}
          </button>
        )}
      </div>
    );
  }

  // ── the full audit log ───────────────────────────────────────────────────
  let lastDay = null;
  return (
    <div className="panel" style={{ marginTop: 18 }}>
      <div className="row" style={{ marginBottom: audit ? 8 : 10, flexWrap: 'wrap', gap: 8 }}>
        <h3>{title}</h3>
        <div className="spacer" />
        <span style={{ color: MUTED, fontSize: 12 }}>
          {filtered.length === rows.length
            ? `${rows.length} event${rows.length === 1 ? '' : 's'}`
            : `${filtered.length} of ${rows.length} events`}
        </span>
        {audit && rows.length > 0 && (
          <button type="button" className="btn ghost small" title="Download exactly what is shown, as a spreadsheet"
            onClick={() => exportCsv(filtered, title)}>Export</button>
        )}
      </div>

      {audit && gap && (
        <div style={{ padding: '8px 10px', marginBottom: 8, borderRadius: 8, border: `1px solid ${DANGER}`, background: 'var(--paper,#F6F3EC)' }}>
          <div style={{ color: DANGER, fontWeight: 600, fontSize: 13 }}>This log is incomplete</div>
          <div style={{ color: INK, fontSize: 12, whiteSpace: 'pre-line', marginTop: 2 }}>{gap.label}</div>
        </div>
      )}

      {audit && (
        <>
          <div className="row" style={{ gap: 6, flexWrap: 'wrap', marginBottom: 6 }}>
            {CATS.map((c) => {
              const n = c.k === 'all' ? rows.length : rows.filter((e) => catOf(e) === c.k).length;
              if (c.k !== 'all' && !n) return null;
              return (
                <button key={c.k} type="button" className={`btn small ${cat === c.k ? 'primary' : 'ghost'}`} onClick={() => setCat(c.k)}>
                  {c.label}{c.k === 'all' ? '' : ` (${n})`}
                </button>
              );
            })}
          </div>
          <div className="row" style={{ gap: 8, flexWrap: 'wrap', marginBottom: 8, alignItems: 'center' }}>
            <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search everything that happened on this file"
              style={{ minWidth: 240, flex: '1 1 280px' }} />
            {people.length > 0 && (
              <select value={actor} onChange={(e) => setActor(e.target.value)} style={{ flex: '0 0 auto' }}>
                <option value="all">Anyone</option>
                {people.map((p) => <option key={p} value={p}>{p}</option>)}
              </select>
            )}
            {onDepth && (
              <label style={{ color: MUTED, fontSize: 12, display: 'inline-flex', gap: 5, alignItems: 'center' }}
                title="Adds one line per page load / API call that touched this file. Verbose — turn it on when the trail above doesn't explain what happened.">
                <input type="checkbox" checked={deep} onChange={(e) => onDepth(e.target.checked)} />
                Include every request
              </label>
            )}
          </div>
        </>
      )}

      {filtered.length === 0
        ? <p style={{ color: MUTED, fontSize: 13 }}>{rows.length ? 'Nothing matches that.' : 'Nothing yet.'}</p>
        : shown.map((e, i) => {
          const dk = audit ? dayKey(e.at) : null;
          const header = audit && dk !== lastDay ? dk : null;
          if (audit) lastDay = dk;
          return (
            <React.Fragment key={i}>
              {header && (
                <div style={{ color: MUTED, fontSize: 11, textTransform: 'uppercase', letterSpacing: '.04em', margin: '12px 0 2px' }}>{header}</div>
              )}
              <EventRow e={e} last={i === shown.length - 1}
                expanded={openRow === i} onToggle={() => setOpenRow((p) => (p === i ? null : i))} />
            </React.Fragment>
          );
        })}

      {!audit && rows.length > limit && (
        <button className="btn link small" style={{ marginTop: 8 }} onClick={() => setShowAll((s) => !s)}>
          {showAll ? 'Show recent only' : `Show all ${rows.length} events`}
        </button>
      )}
    </div>
  );
}
