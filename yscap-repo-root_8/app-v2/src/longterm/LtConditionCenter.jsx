import React, { useEffect, useState } from 'react';
import { ltApi } from './api.js';
import { plain, day } from './format.js';

/**
 * THE CONDITION CENTER, on one loan — READ ONLY.
 *
 * WHY IT SHOWS TWO THINGS AND SAYS WHICH ONE IS REAL. A read-only sweep of 400
 * loans found every Encompass condition in this tenant sitting on a loan that is
 * already closed and sold — not one active long-term loan carries a single
 * condition — while a mature file carries about a hundred eFolder documents in
 * groups including "Needs List - Initial". So a centre built only on conditions
 * would be EMPTY on every file an officer is working. The server answers with
 * `face`: `conditions`, `documents`, or `empty` — and a file with neither SAYS
 * SO rather than rendering an empty list, because an empty list reads as
 * "nothing is outstanding", which is a claim and usually a wrong one.
 *
 * NOTHING HERE IS EDITABLE, and there is no control that implies otherwise. The
 * long-term side reads Encompass; the eFolder upload is a WRITE and stays
 * blocked on docs/ENCOMPASS-WRITE-AUTHORIZATIONS.md. When the write is
 * authorized it arrives as a new control on this screen — not as an edit to one
 * of these rows.
 *
 * THE ORDER IS OPINIONATED, ON PURPOSE: unapproved first, so the system shows
 * you your work before it shows you everything. The server does the sorting, so
 * this file owns no rule about it and the two cannot drift.
 *
 * FRESHNESS IS PART OF THE ANSWER. A condition list is only as trustworthy as
 * its last read, so the "last read" line is always rendered — a screen that
 * cannot say when it last heard from Encompass is asking to be believed on
 * nothing.
 *
 * Colours are explicit darks. Every `--ink*` token in this palette is a LIGHT
 * paper colour, so a body-text `var(--ink)` renders white on white.
 */

const INK = '#141B22';
const MUTED = '#4B585C';
const LINE = '#E6E1D6';
const GOLD = '#AE8746';
const RED = '#8A2D2D';

/** Open / done, in words rather than a colour alone. `null` — Encompass did not
 *  say — is its OWN state and is never drawn as done. */
function StatusPill({ open, stated, status }) {
  const label = stated === false ? 'Done' : stated === true ? 'Outstanding' : 'Not stated';
  const tone = stated === false
    ? { bg: '#EDF3EE', fg: '#2C5E3F' }
    : stated === true
      ? { bg: '#FBF3E4', fg: '#6E5220' }
      : { bg: '#F1EFEA', fg: MUTED };
  return (
    <span title={status ? `Encompass says: ${status}` : ''}
      style={{
        background: tone.bg, color: tone.fg, borderRadius: 999, padding: '2px 9px',
        fontSize: 11, fontWeight: 700, letterSpacing: '.03em', whiteSpace: 'nowrap',
      }}>{label}</span>
  );
}

/** One condition, with the documents that answer it underneath. The documents
 *  come from INVERTING the link — Encompass has no condition→documents endpoint,
 *  so the server builds this and the screen only draws it. */
function ConditionCard({ item }) {
  return (
    <div style={{ border: `1px solid ${LINE}`, borderRadius: 10, padding: '10px 12px', minWidth: 0 }}>
      <div style={{ display: 'flex', gap: 8, alignItems: 'baseline', flexWrap: 'wrap' }}>
        <strong style={{ color: INK, fontSize: 14, overflowWrap: 'anywhere' }}>
          {plain(item.title) === '—' ? 'Untitled condition' : plain(item.title)}
        </strong>
        <StatusPill open={item.open} stated={item.statusStated} status={item.status} />
        {item.category ? (
          <span style={{ fontSize: 11, color: MUTED }}>{plain(item.category)}</span>
        ) : null}
      </div>

      {item.body ? (
        <p style={{ margin: '6px 0 0', color: INK, fontSize: 13, lineHeight: 1.5, overflowWrap: 'anywhere' }}>
          {item.body}
        </p>
      ) : null}

      <div style={{ marginTop: 6, fontSize: 12, color: MUTED, display: 'flex', gap: 14, flexWrap: 'wrap' }}>
        {item.owner ? <span>Owner: {plain(item.owner)}</span> : null}
        {item.assignedTo ? <span>With: {plain(item.assignedTo)}</span> : null}
        <span>Added {day(item.createdAt)}</span>
        {item.comments ? <span>{item.comments} comment{item.comments === 1 ? '' : 's'}</span> : null}
      </div>

      {item.documents && item.documents.length ? (
        <div style={{ marginTop: 8, borderTop: `1px dashed ${LINE}`, paddingTop: 7 }}>
          <div style={{ fontSize: 11, textTransform: 'uppercase', letterSpacing: '.04em', color: MUTED, marginBottom: 4 }}>
            Answered by
          </div>
          <ul style={{ margin: 0, paddingLeft: 16, color: INK, fontSize: 13 }}>
            {item.documents.map((d) => (
              <li key={d.id} style={{ overflowWrap: 'anywhere' }}>
                {plain(d.title)}
                <span style={{ color: MUTED, fontSize: 12 }}>
                  {d.status ? ` · ${plain(d.status)}` : ''}
                  {d.attachments ? ` · ${d.attachments} file${d.attachments === 1 ? '' : 's'}` : ' · no files yet'}
                </span>
              </li>
            ))}
          </ul>
        </div>
      ) : (
        <div style={{ marginTop: 8, fontSize: 12, color: MUTED }}>
          No eFolder document is linked to this condition.
        </div>
      )}
    </div>
  );
}

/** The eFolder needs list — where the work actually is on a live file. */
function DocumentRow({ item }) {
  return (
    <div style={{
      display: 'flex', gap: 10, alignItems: 'baseline', padding: '7px 0',
      borderBottom: `1px solid ${LINE}`, minWidth: 0,
    }}>
      <span style={{
        width: 8, height: 8, borderRadius: 999, flex: '0 0 auto',
        background: item.outstanding ? GOLD : '#BFD3C3', marginTop: 5,
      }} />
      <div style={{ minWidth: 0, flex: 1 }}>
        <div style={{ color: INK, fontSize: 13, overflowWrap: 'anywhere' }}>{plain(item.title)}</div>
        <div style={{ fontSize: 12, color: MUTED, display: 'flex', gap: 12, flexWrap: 'wrap' }}>
          <span>{item.outstanding ? 'Still wanted' : 'In'}</span>
          {item.status ? <span>{plain(item.status)}</span> : null}
          {item.milestone ? <span>{plain(item.milestone)}</span> : null}
          {item.forBorrower ? <span>{plain(item.forBorrower)}</span> : null}
          <span>{item.attachments ? `${item.attachments} file${item.attachments === 1 ? '' : 's'}` : 'no files yet'}</span>
        </div>
      </div>
    </div>
  );
}

/** Conditions, grouped by the gate they block. Encompass's own `prior_to` IS the
 *  grouping — an unstated one gets its own honest bucket rather than being folded
 *  into a real gate it may not belong to. */
function groupConditions(items) {
  const groups = new Map();
  for (const it of items) {
    const g = it.group || 'Not stated';
    if (!groups.has(g)) groups.set(g, []);
    groups.get(g).push(it);
  }
  return [...groups.entries()];
}

export default function LtConditionCenter({ loanId }) {
  const [state, setState] = useState({ loading: true });

  useEffect(() => {
    let alive = true;
    setState({ loading: true });
    ltApi.conditionCenter(loanId)
      .then((d) => { if (alive) setState({ loading: false, data: d }); })
      // A failed read SAYS SO. Rendering an empty centre here would claim this
      // loan has nothing outstanding, which is the one thing it must not do.
      .catch((e) => { if (alive) setState({ loading: false, error: (e && e.message) || 'could not be read' }); });
    return () => { alive = false; };
  }, [loanId]);

  if (state.loading) return <p style={{ margin: 0, color: MUTED, fontSize: 13 }}>Loading…</p>;

  if (state.error) {
    return (
      <p style={{ margin: 0, color: RED, fontSize: 13, lineHeight: 1.55 }}>
        The Condition Center could not be read just now: {state.error}. Nothing is lost —
        this is a read of Encompass, so try again in a moment.
      </p>
    );
  }

  const d = state.data || {};

  // The feature switch answers first. This is a deliberate configuration, not a
  // failure, so it reads as one.
  if (d.enabled === false) {
    return <p style={{ margin: 0, color: MUTED, fontSize: 13 }}>{d.why || 'The Condition Center is coming soon.'}</p>;
  }

  const conditions = d.conditions || { items: [], open: 0, total: 0 };
  const documents = d.documents || { items: [], outstanding: 0, total: 0 };
  const sync = d.sync || {};

  return (
    <div style={{ minWidth: 0 }}>
      <p style={{ margin: '0 0 10px', color: MUTED, fontSize: 13, lineHeight: 1.55 }}>
        Read from Encompass. Nothing here is editable — the long-term side reads
        Encompass and never writes to it, and filing a document into the eFolder from
        PILOT is not switched on.
      </p>

      {/* Freshness, always, and the reason a read failed if one did. */}
      <div style={{ fontSize: 12, color: MUTED, marginBottom: 12 }}>
        Conditions last read {day(sync.conditionsSyncedAt)} · eFolder last read {day(sync.documentsSyncedAt)}
        {sync.error ? (
          <span style={{ color: RED }}> · last read failed: {sync.error}</span>
        ) : null}
      </div>

      {d.face === 'empty' ? (
        <p style={{ margin: 0, color: INK, fontSize: 13, lineHeight: 1.55 }}>
          This loan carries no conditions and no eFolder documents yet. That is what
          Encompass says — not a filter on this screen — so if you expect something
          here, the last read above is the place to look.
        </p>
      ) : null}

      {conditions.total > 0 ? (
        <section style={{ marginBottom: documents.total ? 18 : 0 }}>
          <h3 style={{ margin: '0 0 6px', fontSize: 14, color: INK }}>
            Conditions
            <span style={{ marginLeft: 8, fontWeight: 550, fontSize: 12, color: MUTED }}>
              {conditions.open} of {conditions.total} outstanding
            </span>
          </h3>
          {groupConditions(conditions.items).map(([group, items]) => (
            <div key={group} style={{ marginBottom: 12 }}>
              <div style={{
                fontSize: 11, textTransform: 'uppercase', letterSpacing: '.04em',
                color: MUTED, margin: '6px 0 6px',
              }}>{group}</div>
              <div style={{ display: 'grid', gap: 8, minWidth: 0 }}>
                {items.map((it) => <ConditionCard key={it.id} item={it} />)}
              </div>
            </div>
          ))}
        </section>
      ) : null}

      {documents.total > 0 ? (
        <section>
          <h3 style={{ margin: '0 0 2px', fontSize: 14, color: INK }}>
            eFolder needs list
            <span style={{ marginLeft: 8, fontWeight: 550, fontSize: 12, color: MUTED }}>
              {documents.outstanding} of {documents.total} still wanted
            </span>
          </h3>
          <p style={{ margin: '0 0 6px', color: MUTED, fontSize: 12, lineHeight: 1.5 }}>
            A document is a SLOT and its files are the paper in it — a slot with no
            files is still asking for one.
          </p>
          <div style={{ minWidth: 0 }}>
            {documents.items.map((it) => <DocumentRow key={it.id} item={it} />)}
          </div>
        </section>
      ) : null}
    </div>
  );
}
