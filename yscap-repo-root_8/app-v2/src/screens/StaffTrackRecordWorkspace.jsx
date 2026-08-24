import React, { useEffect, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { api } from '../lib/api.js';
import { useAuth } from '../lib/auth.jsx';
import { canDeleteDoc } from '../lib/condition-actions.js';
import LineDetail from '../components/track-record/LineDetail.jsx';
import StaffPropertyWorkbench from './StaffPropertyWorkbench.jsx';
import ExportRecord from '../components/track-record/ExportRecord.jsx';
import SpreadsheetEditor from '../components/track-record/SpreadsheetEditor.jsx';

/* THE TRACK-RECORD WORKSPACE — ONE screen: the queue of every borrower with
   unfinished track-record work on the left, and one line's whole story on the
   right. The right pane is the SHARED <LineDetail> component — the SAME thing
   the inline Track Record Center (loan file + borrower profile) now renders,
   so the full screen and the default screen can never drift (owner-directed
   2026-08-09: "everything on the full screen should be on the default screen").
   This screen owns only the queue + J/K navigation; every per-line action lives
   in LineDetail, and every verdict comes from the server.

   COLOURS: explicit darks. Every `--ink*` token is a LIGHT paper colour in this
   palette, so text is #141B22 / #4B585C, never a token. */

const INK = '#141B22';
const MUTED = '#4B585C';

const day = (d) => (d ? String(d).slice(0, 10) : null);

const dealLabel = (t) => {
  const s = String(t || '').toLowerCase();
  if (s.includes('ground')) return 'Ground-up';
  if (s.includes('hold') || s.includes('rental')) return 'Fix & Hold';
  return 'Fix & Flip';
};

const TONE_STYLE = {
  good: { mark: '✓', color: '#1F6B3F' },
  bad: { mark: '✗', color: '#8A2B2B' },
  neutral: { mark: '–', color: '#4B585C' },
  unknown: { mark: '?', color: '#4B585C' },
};
const PILLAR_TITLE = { recency: 'Finished in the last 3 years', ownership: 'They owned it', exit: 'The exit really happened' };

export default function StaffTrackRecordWorkspace() {
  const { can, actor } = useAuth();
  const maySignOff = can('sign_off_conditions');
  const role = (actor && actor.role) || '';

  const [queue, setQueue] = useState(null);
  const [selected, setSelected] = useState(null);
  const [rowErr, setRowErr] = useState({});
  const [showAll, setShowAll] = useState(false);
  /* The same workspace serves the approvals tab AND the full-screen route;
     `?borrower=` narrows the queue to one person (the profile links here). */
  const [params, setParams] = useSearchParams();
  const borrowerFilter = params.get('borrower') || '';

  const rowError = (id, text) => {
    setRowErr((m) => ({ ...m, [id]: text }));
    setTimeout(() => setRowErr((m) => { const n = { ...m }; delete n[id]; return n; }), 12000);
  };

  /* The borrower narrowing is sent to the SERVER (the queue is capped, so
     filtering one page client-side showed NOTHING for any borrower outside the
     cap — the full-screen link off a loan file landed on a false "nothing is
     waiting"). The client-side filter below stays as a belt-and-suspenders on
     the render + the J/K walk. */
  const loadQueue = () => api.staffTrackRecordWorkspace({
    filter: showAll ? 'all' : 'open',
    borrowerId: borrowerFilter || undefined,
  })
    .then((d) => setQueue(d && Array.isArray(d.groups) ? d : { groups: [], totals: {} }))
    .catch((e) => { setQueue({ groups: [], totals: {} }); rowError('queue', (e && e.message) || 'could not load the queue'); });

  useEffect(() => { loadQueue(); }, [showAll, borrowerFilter]);   // eslint-disable-line

  /* The borrower filter narrows BOTH the render and the J/K walk, so the keys
     never move the selection onto a row the screen is not showing. */
  const groups = useMemo(() => {
    const all = (queue && queue.groups) || [];
    return borrowerFilter ? all.filter((g) => String(g.borrowerId) === borrowerFilter) : all;
  }, [queue, borrowerFilter]);
  const flatLines = useMemo(() => groups.flatMap((g) => g.lines), [groups]);

  // Pick the first thing worth looking at, once.
  useEffect(() => {
    if (!selected && flatLines.length) setSelected(flatLines[0].id);
  }, [flatLines, selected]);

  /* J / K move through the queue. The pillar keys (1/2/3/C/X/D) live in
     LineDetail, which owns the pillar cards. */
  useEffect(() => {
    const onKey = (e) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const tag = (e.target && e.target.tagName) || '';
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
      const k = e.key.toLowerCase();
      if (k !== 'j' && k !== 'k') return;
      const i = flatLines.findIndex((l) => l.id === selected);
      const next = k === 'j' ? Math.min(i + 1, flatLines.length - 1) : Math.max(i - 1, 0);
      if (flatLines[next]) { setSelected(flatLines[next].id); e.preventDefault(); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [flatLines, selected]);

  if (queue == null) return <div className="wrap"><p className="muted">Loading…</p></div>;

  const totals = queue.totals || {};

  return (
    <div className="wrap" style={{ maxWidth: 1240 }}>
      <div className="row" style={{ alignItems: 'baseline', justifyContent: 'space-between', flexWrap: 'wrap', gap: 8 }}>
        <h1 style={{ margin: 0, color: INK }}>Track record verification</h1>
        <div className="row" style={{ gap: 6, alignItems: 'center' }}>
          {totals.contradicted > 0 && <span className="ts-badge warn">{totals.contradicted} disagree with the records</span>}
          {totals.waiting > 0 && <span className="pill small">{totals.waiting} waiting</span>}
          <button className="btn ghost small" onClick={() => setShowAll((v) => !v)}>
            {showAll ? 'Only unfinished' : 'Show everything'}
          </button>
        </div>
      </div>
      <p className="muted" style={{ marginTop: 6 }}>
        Every past project has three checks: it finished in the last 3&nbsp;years, they really owned it, and the exit
        really happened. All three have to be confirmed by a person before a project counts toward experience.
        Press <strong>J</strong> and <strong>K</strong> to move down and up the list, and <strong>?</strong> on a
        project for its keyboard shortcuts.
      </p>
      {borrowerFilter && (
        <div className="notice" style={{ marginTop: 8, background: 'rgba(47,127,134,.08)' }}>
          <span style={{ color: INK }}>Showing ONE borrower&rsquo;s projects.</span>{' '}
          <button className="btn link small" onClick={() => setParams({}, { replace: true })}>Show every borrower</button>
        </div>
      )}
      {rowErr.queue && <div className="notice err" style={{ marginTop: 8 }}>{rowErr.queue}</div>}

      <div className="ec-split" style={{ marginTop: 12 }}>
        {/* ── THE QUEUE, GROUPED BY PERSON ─────────────────────────────── */}
        <div>
          {!groups.length && (
            <div className="panel"><p className="muted small" style={{ margin: 0 }}>
              {borrowerFilter && !showAll
                /* Scoped to one person with the default "unfinished" filter, an
                   empty list usually means their projects are all VERIFIED —
                   saying "nothing is waiting" there reads as "this borrower has
                   no record", which is a different and often false claim. */
                ? <>Nothing unfinished for this borrower. <button className="btn link small" onClick={() => setShowAll(true)}>Show everything</button> to see their verified projects.</>
                : 'Nothing is waiting. A project appears here the moment somebody adds one to a borrower’s record.'}
            </p></div>
          )}
          {groups.map((g) => (
            <div className="panel" key={g.borrowerId} style={{ marginBottom: 10, padding: 10 }}>
              <div className="row" style={{ gap: 8, alignItems: 'baseline', flexWrap: 'wrap' }}>
                <strong style={{ color: INK }}>{g.borrowerName}</strong>
                <span className="pill small">{g.lines.length}</span>
                {g.contradicted > 0 && <span className="ts-badge warn small">{g.contradicted} disagree</span>}
                <div className="spacer" />
                <Link className="btn ghost small" to={`/internal/borrowers/${g.borrowerId}`}>Profile</Link>
                {/* THE LEGACY TOOL, WITH ITS EXCEL IMPORT (owner-directed 2026-08-24). This screen
                    became the destination of "Open full screen" on 2026-08-19 — correctly, it is
                    the record you read — which left it as a place a person could stand with the
                    whole record in front of them and no way to import a spreadsheet into it. The
                    SAME component the loan file and the profile mount. */}
                <SpreadsheetEditor borrowerId={g.borrowerId} onClosed={loadQueue} />
              </div>
              {/* Hand this borrower's record to somebody (item 7) — the regular
                  export is verified only; "Export all" / "Unverified only" are
                  behind the same control and stamp every unverified line. The
                  SAME component the loan file and the profile mount. */}
              <ExportRecord borrowerId={g.borrowerId} className="tr-export-queue" />
              {g.lines.map((l) => {
                const done = l.readiness && l.readiness.ready;
                return (
                  <div key={l.id}>
                    <button
                      className="btn ghost"
                      onClick={() => setSelected(l.id)}
                      style={{
                        display: 'block', width: '100%', textAlign: 'left', marginTop: 6,
                        borderLeft: `3px solid ${l.urgency === 0 ? '#8A2B2B' : done ? '#1F6B3F' : '#AE8746'}`,
                        background: l.id === selected ? 'rgba(47,127,134,.10)' : undefined,
                      }}>
                      <span style={{ color: INK, fontWeight: 600 }}>{l.address || 'A past project'}</span>
                      <span style={{ display: 'block', color: MUTED, fontSize: 12, marginTop: 2 }}>
                        {[dealLabel(l.dealType), l.countsFrom ? `exit ${day(l.countsFrom)}` : 'no exit yet',
                          l.entityName || null].filter(Boolean).join(' · ')}
                      </span>
                      <span style={{ display: 'block', color: MUTED, fontSize: 12, marginTop: 2 }}>
                        {(l.pillars || []).map((p) => {
                          const tone = p.human_verdict === 'confirmed' ? 'good'
                            : p.human_verdict === 'rejected' ? 'bad'
                              : p.auto_verdict === 'proved' ? 'good'
                                : p.auto_verdict === 'contradicted' ? 'bad'
                                  : p.auto_verdict ? 'neutral' : 'unknown';
                          return (
                            <span key={p.pillar} title={`${PILLAR_TITLE[p.pillar]} — ${p.human_verdict || p.auto_verdict || 'not checked'}`}
                              style={{ color: TONE_STYLE[tone].color, marginRight: 6, fontWeight: 700 }}>
                              {TONE_STYLE[tone].mark}
                            </span>
                          );
                        })}
                        {l.openRequests > 0 && <span style={{ color: '#8A6D3B' }}>· {l.openRequests} asked</span>}
                        {l.isVerified && <span style={{ color: '#1F6B3F' }}>· verified</span>}
                      </span>
                    </button>
                    {rowErr[l.id] && <div className="notice err small" style={{ marginTop: 4 }}>{rowErr[l.id]}</div>}
                  </div>
                );
              })}
            </div>
          ))}
        </div>

        {/* ── THE PROJECT — the shared per-line detail, keyboard on ─────── */}
        <div>
          {!selected
            ? <div className="panel"><p className="muted small" style={{ margin: 0 }}>Pick a project on the left.</p></div>
            : <LineDetail trackRecordId={selected} keyboard maySignOff={maySignOff}
                canDelete={canDeleteDoc(role)} role={role} onChanged={loadQueue}
                onDeleted={() => setSelected(null)} />}
        </div>
      </div>

      {/* ── THE PUBLIC-RECORDS SEARCH — available here too (owner-directed
          2026-08-19: "the option to pull in their public records should be
          available in all places"). It needs ONE person to search for, so it
          renders only when the screen is narrowed to one borrower; the search
          + import land on the record and loadQueue picks them up. The SAME
          shared workbench the loan file and the profile mount — never a copy. */}
      {borrowerFilter && (
        <div style={{ marginTop: 12 }}>
          <StaffPropertyWorkbench key={`wb-${borrowerFilter}`} borrowerId={borrowerFilter} />
        </div>
      )}
    </div>
  );
}
