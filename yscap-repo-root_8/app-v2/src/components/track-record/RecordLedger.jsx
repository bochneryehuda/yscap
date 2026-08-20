import React, { useState } from 'react';
import LineDetail from './LineDetail.jsx';
import RecordsStamp from './RecordsStamp.jsx';
import { trStatusShort, trIsPendingReview } from '../../lib/trackRecordStatus.js';
import { trackRecordPropertyTypeLabel } from '../../lib/trackRecordPropertyTypes.js';

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

const money = (n) => (n == null || n === '' || !Number.isFinite(Number(n)) ? null : '$' + Math.round(Number(n)).toLocaleString('en-US'));
const day = (d) => (d ? String(d).slice(0, 10) : null);
/* A PARSER, not a formatter — answers `number | null` (money() below formats
   it). Named `readNum` (like the valuation screen's parser) so it never
   collides with the app-v2 `num` FORMATTER the research screens use, which
   test-research-formatters-pure guards against. */
const readNum = (v) => (v == null || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));

/* The line's property type, however the row reached us. The two lenses are fed
   by two different endpoints — the loan file by the staff track-record list
   (snake_case `property_type`), the workspace by `workspace.loadLine`
   (camelCase `propertyType`) — so reading only one shape would leave the type
   silently blank on one lens and nowhere would say why. */
function ptLabel(t) {
  return trackRecordPropertyTypeLabel((t && (t.property_type ?? t.propertyType)) || '');
}

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
   exit-problem codes come from track-record-todo (EXIT_PROBLEM_MSG family). The
   review-OUTCOME reasons (owner-directed 2026-08-10, #40) say plainly what the
   reviewer decided — never the raw stored value. */
function reoReason(line, todo) {
  const codes = (todo && todo.map((t) => t.code)) || [];
  if (codes.includes('exit_expired')) return 'exit older than 3 years — outside the experience window';
  if (codes.includes('future_exit')) return 'exit date is in the future — counts once it closes';
  if (codes.includes('no_exit')) return 'no completed exit recorded yet';
  if (line.is_verified) return null; // fully verified — counting
  switch (line.verification_status) {
    case 'rejected': return 'rejected by your loan team';
    case 'not_verified': return 'reviewed — not verified';
    case 'unable_docs': return 'unable to verify — waiting on documents';
    case 'unable_mismatch': return 'unable to verify — records don’t match what was entered';
    case 'limited': return 'public records only — not verified from documents'; // legacy
    default: return 'waiting for review — not verified yet'; // pending / docs
  }
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
  // Rejected lines are HIDDEN by default (owner-directed 2026-08-10, #40); a
  // "Show rejected" toggle reveals them in their own band. Nothing is lost.
  const [showRejected, setShowRejected] = useState(false);
  if (!all.length) return null;
  const toggle = (id) => setOpen((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });

  // "Waiting for review" = not yet decided (pending). A reviewed-but-not-counting
  // outcome (not verified / rejected / an "unable to verify" reason) is NOT waiting.
  const waiting = all.filter((t) => !t.is_verified && trIsPendingReview(t.verification_status)).length;
  const isRejected = (t) => String(t.verification_status || '') === 'rejected';
  const rows = all.map((t) => {
    const todo = (todoByLine && todoByLine[String(t.id)]) || null;
    return { t, todo, reo: reoReason(t, todo) };
  });
  const counting = rows.filter((r) => !r.reo);
  const rejected = rows.filter((r) => isRejected(r.t));
  const reo = rows.filter((r) => r.reo && !isRejected(r.t)); // REO band excludes rejected

  const line = (r) => {
    const t = r.t;
    // A row stored as a bare one-line string (public-records import before the shape
    // fix / boot heal) still reads as the address, not "Past project".
    const pa = typeof t.property_address === 'string' ? { oneLine: t.property_address } : (t.property_address || {});
    const addr = pa.oneLine || [pa.line1 || pa.street || pa.address, pa.city, pa.state].filter(Boolean).join(', ') || 'Past project';
    const isOpen = open.has(t.id);
    const figs = figures(t);
    const stripe = r.reo ? 'var(--gold)' : (t.is_verified ? '#2F7F86' : 'var(--border-strong)');
    return (
      <div key={t.id} className={`tr-led-row${isOpen ? ' is-open' : ''}`} style={{ borderLeftColor: stripe }}>
        <div className="tr-led-head">
          <button type="button" className="tr-led-toggle" aria-expanded={isOpen} onClick={() => toggle(t.id)}
            title="Open this project — every detail, the Elementix check, the documents, and every action">
            <span className="tr-led-caret">{isOpen ? '▾' : '▸'}</span>{addr}
          </button>
          <div className="tr-led-tags">
            {/* WHAT KIND OF BUILDING IT WAS (owner-directed 2026-08-16). It sits
                with the other IDENTITY chips rather than in the figures line
                because it classifies the deal, it does not measure it — and
                because a reviewer scanning a ledger of twenty houses is asking
                "which of these are the multifamilies?" before asking what any
                of them sold for. A line with no type shows NOTHING, never a
                placeholder: a grey "—" on every row of an untyped record reads
                as a column of errors rather than as a question nobody has
                answered yet. */}
            {ptLabel(t) && <span className="pill small tr-pt" title="Property type">{ptLabel(t)}</span>}
            {t.owned_personally
              ? <span className="pill small" title="Held under the borrower's personal name — no LLC">Personal name</span>
              : (t.entity_name
                ? (onOpenEntity
                  ? <button type="button" className="pill small" style={{ cursor: 'pointer' }} title="Entity on record — open the borrower's entities" onClick={() => onOpenEntity(t)}>{t.entity_name}</button>
                  : <span className="pill small" title="Entity on record">{t.entity_name}</span>)
                : null)}
            {t.is_verified
              ? <span className="ts-badge ok">Verified</span>
              : (t.verification_status && <span className="pill small">{trStatusShort(t.verification_status)}</span>)}
            {/* The records stamp, compact — a scanner asking "which of these did
                the county records back?" reads it off the row (2026-08-19). */}
            <RecordsStamp stamp={t.records_stamp} at={t.records_stamp_at} compact />
            <button type="button" className="btn ghost small" onClick={() => toggle(t.id)}>{isOpen ? 'Close' : 'Open'}</button>
          </div>
        </div>
        {figs && !isOpen && <div className="tr-led-figs">{figs}</div>}
        {r.reo && !isOpen && <div className="tr-led-reo">Not counting: {r.reo}</div>}
        {!isOpen && (r.todo || []).filter((x) => x.code !== 'open_request').slice(0, 2).map((x, i) => (
          <div className="tr-led-todo" key={i}>→ {x.title}</div>
        ))}
        {isOpen && (
          <div className="tr-led-body">
            <LineDetail trackRecordId={t.id} maySignOff={maySignOff} canDelete={canDelete} role={role}
              onChanged={onChanged} onProfileScreen={lens === 'borrower'}
              extraActions={lineActions ? (ln) => lineActions(t, addr, ln) : null} />
          </div>
        )}
      </div>
    );
  };

  const group = (title, sub, rows) => (
    <div className="tr-led-group">
      <div className="tr-led-grouph">
        <span className="tr-led-groupt">{title}</span>
        <span className="tr-led-groups">{sub}</span>
      </div>
      {rows.map(line)}
    </div>
  );

  return (
    <div className="tr-ledger">
      {waiting > 0 && (
        <div className="tr-readi" style={{ background: 'rgba(174,135,70,.08)', borderColor: 'var(--gold)', marginBottom: 12 }}>
          <b>{waiting} {waiting === 1 ? 'deal is' : 'deals are'} waiting for review.</b>{' '}
          <span>Nothing counts toward {lens === 'borrower' ? 'experience' : 'this file’s experience'} until
          it is verified — open each one, check the records, then verify it.</span>{' '}
          <a href="#/internal/approvals?tab=track-record">Every borrower&rsquo;s waiting deals →</a>
        </div>
      )}
      <p className="tr-led-intro">The record — open any project to see every detail, run the Elementix check, review its documents, and verify it.</p>
      {GROUPS.map((g) => {
        const inGroup = counting.filter((r) => bucketOf(r.t.deal_type) === g.key);
        if (!inGroup.length) return null;
        return <React.Fragment key={g.key}>{group(g.title, `${inGroup.length} counting · ${g.sub}`, inGroup)}</React.Fragment>;
      })}
      {reo.length > 0 && group('REO / not currently counting', `${reo.length} — each says why; nothing entered is ever lost`, reo)}
      {/* REJECTED — hidden by default, revealed by a toggle (owner-directed
          2026-08-10, #40: "hide it from the list and make an option to sort and
          see also the rejected ones"). Nothing is deleted; it is out of the way. */}
      {rejected.length > 0 && (
        <div className="tr-led-group">
          <button type="button" className="tr-led-reveal" aria-expanded={showRejected} onClick={() => setShowRejected((v) => !v)}
            title={showRejected ? 'Hide the rejected projects again' : 'Show the projects your team rejected'}>
            <span className="tr-led-caret">{showRejected ? '▾' : '▸'}</span>{showRejected ? 'Hide' : 'Show'} rejected ({rejected.length})
          </button>
          {showRejected && group('Rejected', `${rejected.length} — not counting; kept on the record`, rejected)}
        </div>
      )}
    </div>
  );
}
