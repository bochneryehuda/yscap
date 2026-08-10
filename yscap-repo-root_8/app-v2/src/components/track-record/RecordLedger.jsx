import React, { useState } from 'react';
import LineDetail from './LineDetail.jsx';

/* THE RECORD, AS A LEDGER (mega-workspace phase B/C, owner-directed 2026-08-09).
   One scroll, grouped the way the tool has always grouped it — Fix & flip /
   Fix & hold / Ground-up, each with a count — plus the REO band: every line
   that is NOT currently counting toward experience, each carrying the REASON
   it is not (REO is DERIVED, never a fourth deal type — CLAUDE.md 2026-08-09).

   EVERY LINE OPENS IN PLACE (owner-directed 2026-08-09 "one screen, everything"):
   the row shows the deal's headline figures right away, and "Open" expands the
   SHARED <LineDetail> — the exact same component the full-screen workspace
   renders — so the whole job (the Elementix check + the three verdicts +
   override, verify, documents with preview/download/accept/reject/delete, edit,
   notes) is done here without leaving the page. Which lines count, and why one
   does not, is read off the track-record-todo endpoint (the server's own
   LINE_TODO wording, the same rule the sign-off gate uses); with the todo
   unreadable it degrades to "verified = counting" and a generic reason. */

const INK = '#141B22';
const MUTED = '#4B585C';

const money = (n) => (n == null || n === '' || !Number.isFinite(Number(n)) ? null : '$' + Math.round(Number(n)).toLocaleString('en-US'));
const day = (d) => (d ? String(d).slice(0, 10) : null);
/* A PARSER, not a formatter — answers `number | null` (money() below formats
   it). Named `readNum` (like the valuation screen's parser) so it never
   collides with the app-v2 `num` FORMATTER the research screens use, which
   test-research-formatters-pure guards against. */
const readNum = (v) => (v == null || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));

function bucketOf(dealType) {
  const s = String(dealType || '').toLowerCase();
  if (s.indexOf('ground') >= 0 || s.indexOf('construction') >= 0) return 'ground';
  if (s.indexOf('flip') >= 0) return 'flip';
  return 'hold';
}
const GROUPS = [
  { key: 'flip', title: 'Fix & flip', sub: 'exit = sale' },
  { key: 'hold', title: 'Fix & hold / rental', sub: 'exit = lease-up or refinance' },
  { key: 'ground', title: 'Ground-up', sub: 'exit = sale, lease-up or refinance' },
];

/* Why a line is in the REO band, in the SERVER's words when it gave any. The
   exit-problem codes come from track-record-todo (EXIT_PROBLEM_MSG family). */
function reoReason(line, todo) {
  const codes = (todo && todo.map((t) => t.code)) || [];
  if (codes.includes('exit_expired')) return 'exit older than 3 years — outside the experience window';
  if (codes.includes('future_exit')) return 'exit date is in the future — counts once it closes';
  if (codes.includes('no_exit')) return 'no completed exit recorded yet';
  if (!line.is_verified) return (line.verification_status || 'pending') === 'limited'
    ? 'public records only — not verified from documents'
    : 'waiting for review — not verified yet';
  return null; // counting
}

/* The headline figures shown on the collapsed row, so the money the owner
   listed (purchase / exit / gross spread) is visible RIGHT AWAY without opening
   the line. Computed from the row we already have — no fetch. */
function figures(t) {
  const pp = readNum(t.purchase_price);
  const sp = readNum(t.sale_price);
  const rehab = readNum(t.rehab_amount);
  const bucket = bucketOf(t.deal_type);
  const bits = [];
  if (pp != null) bits.push(`Bought ${money(pp)}${day(t.purchase_date) ? ` · ${day(t.purchase_date)}` : ''}`);
  if (bucket === 'hold' && readNum(t.rent_amount) != null) bits.push(`Rents ${money(t.rent_amount)}/mo`);
  else if (bucket === 'hold' && readNum(t.refi_amount) != null) bits.push(`Refi ${money(t.refi_amount)}`);
  else if (sp != null) bits.push(`Sold ${money(sp)}${day(t.sale_date) ? ` · ${day(t.sale_date)}` : ''}`);
  if (sp != null && pp != null) bits.push(`Spread ${money(sp - pp - (rehab || 0))}`);
  return bits.join('  ·  ');
}

/* TWO LENSES, ONE LEDGER: the LOAN FILE passes `lineActions` (its file verbs —
   request/raise/post — injected into the expanded detail) ; the borrower
   PROFILE passes none (LineDetail's own verify/check-records/revoke cover it)
   and passes `onOpenEntity` so the entity pill cross-links to the Entities tab. */
export default function RecordLedger({
  lines, todoByLine, lens = 'file',
  maySignOff, canDelete, role, onChanged,
  onOpenEntity = null, lineActions = null,
}) {
  const all = Array.isArray(lines) ? lines : [];
  const [open, setOpen] = useState(() => new Set());
  if (!all.length) return null;
  const toggle = (id) => setOpen((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });

  const waiting = all.filter((t) => !t.is_verified && (t.verification_status || 'pending') !== 'limited').length;
  const rows = all.map((t) => {
    const todo = (todoByLine && todoByLine[String(t.id)]) || null;
    return { t, todo, reo: reoReason(t, todo) };
  });
  const counting = rows.filter((r) => !r.reo);
  const reo = rows.filter((r) => r.reo);

  const line = (r) => {
    const t = r.t;
    const pa = t.property_address || {};
    const addr = pa.oneLine || [pa.line1 || pa.street || pa.address, pa.city, pa.state].filter(Boolean).join(', ') || 'Past project';
    const isOpen = open.has(t.id);
    const figs = figures(t);
    return (
      <div key={t.id} style={{ padding: '5px 0 5px 10px', borderTop: '1px solid rgba(127,169,176,.15)', borderLeft: `3px solid ${r.reo ? 'var(--gold)' : (t.is_verified ? 'var(--teal, #2F7F86)' : 'rgba(127,169,176,.4)')}` }}>
        <div className="row" style={{ gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <button type="button" className="btn link small" style={{ padding: 0, color: INK, fontWeight: 600, flex: 1, minWidth: 160, textAlign: 'left' }}
            aria-expanded={isOpen} onClick={() => toggle(t.id)} title="Open this project — every detail, the Elementix check, the documents, and every action">
            {isOpen ? '▾ ' : '▸ '}{addr}
          </button>
          {t.owned_personally
            ? <span className="pill small" title="Held under the borrower's personal name — no LLC">Personal name</span>
            : (t.entity_name
              ? (onOpenEntity
                ? <button type="button" className="pill small" style={{ cursor: 'pointer' }} title="Entity on record — open the borrower's entities" onClick={() => onOpenEntity(t)}>{t.entity_name}</button>
                : <span className="pill small" title="Entity on record">{t.entity_name}</span>)
              : null)}
          {t.verification_status && <span className="pill small">{t.verification_status}</span>}
          {!isOpen && <button type="button" className="btn ghost small" onClick={() => toggle(t.id)}>Open</button>}
        </div>
        {figs && <div className="small" style={{ color: MUTED, padding: '2px 0 0 16px' }}>{figs}</div>}
        {r.reo && (
          <div className="small" style={{ color: '#8A6D3B', padding: '1px 0 0 16px' }}>Not counting: {r.reo}</div>
        )}
        {!isOpen && (r.todo || []).filter((x) => x.code !== 'open_request').slice(0, 2).map((x, i) => (
          <div className="small" key={i} style={{ color: MUTED, padding: '1px 0 0 16px' }}>→ {x.title}</div>
        ))}
        {isOpen && (
          <div style={{ padding: '8px 0 4px 0' }}>
            <LineDetail trackRecordId={t.id} maySignOff={maySignOff} canDelete={canDelete} role={role}
              onChanged={onChanged} extraActions={lineActions ? (ln) => lineActions(t, addr, ln) : null} />
          </div>
        )}
      </div>
    );
  };

  return (
    <div className="panel" style={{ marginBottom: 12, padding: 10 }}>
      {waiting > 0 && (
        <div className="small" style={{ marginBottom: 8, padding: '6px 10px', borderRadius: 8,
          border: '1px solid var(--gold)', background: 'rgba(174,135,70,.08)', color: INK }}>
          <strong>{waiting} {waiting === 1 ? 'deal is' : 'deals are'} waiting for review.</strong>{' '}
          Nothing counts toward {lens === 'borrower' ? 'experience' : 'this file’s experience'} until
          it is verified — open each one, check the records, then verify it.{' '}
          <a href="#/internal/approvals?tab=track-record">Every borrower&rsquo;s waiting deals →</a>
        </div>
      )}
      <div className="muted small" style={{ marginBottom: 6 }}>
        The record — open any project to see every detail, run the Elementix check, review its documents, and verify it.
      </div>
      {GROUPS.map((g) => {
        const inGroup = counting.filter((r) => bucketOf(r.t.deal_type) === g.key);
        if (!inGroup.length) return null;
        return (
          <div key={g.key} style={{ marginBottom: 8 }}>
            <div className="small" style={{ fontWeight: 650, color: INK, margin: '6px 0 2px' }}>
              {g.title} <span style={{ color: MUTED, fontWeight: 400 }}>· {inGroup.length} counting · {g.sub}</span>
            </div>
            {inGroup.map(line)}
          </div>
        );
      })}
      {reo.length > 0 && (
        <div style={{ marginTop: 8 }}>
          <div className="small" style={{ fontWeight: 650, color: INK, margin: '6px 0 2px' }}>
            REO / not currently counting <span style={{ color: MUTED, fontWeight: 400 }}>· {reo.length} — each says why; nothing entered is ever lost</span>
          </div>
          {reo.map(line)}
        </div>
      )}
    </div>
  );
}
