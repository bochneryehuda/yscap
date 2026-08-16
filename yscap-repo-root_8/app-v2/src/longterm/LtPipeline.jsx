import React, { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import ProductStamp from './ProductStamp.jsx';
import LtLayout from './LtLayout.jsx';
import { ltApi } from './api.js';

const money = (v) => (v == null || v === '' ? '—'
  : Number(v).toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }));

const day = (v) => {
  if (!v) return '—';
  const d = new Date(v);
  return Number.isFinite(d.getTime()) ? d.toLocaleDateString('en-US') : '—';
};

// A percentage the server stated. MISSING IS NOT ZERO: a loan whose rate has not been
// mirrored yet reads as a dash, never as 0.000%.
const pct = (v) => (v == null || v === '' ? '—' : `${Number(v).toFixed(3).replace(/0+$/, '').replace(/\.$/, '')}%`);
const ratio = (v) => (v == null || v === '' ? '—' : Number(v).toFixed(2));

/**
 * A loan's lock, in one cell.
 *
 * The countdown is to the date ENCOMPASS STATED and is never calculated from a lock
 * date plus a day count — an extension moves the expiration without moving the lock
 * date, so a calculated number would show a desk an expiry that has not happened.
 * `lock_days_remaining` comes from the server for exactly that reason.
 *
 * A loan with no lock mirrored reads as a plain dash. "No lock" and "we have not
 * looked yet" are different, and this column may only claim the first when the loan
 * itself says so — the file's own lock section is where that distinction is spelled
 * out, because a pipeline cell has no room for a sentence.
 */
/**
 * Days at the current milestone — or an honest blank.
 *
 * `milestone_days` is NULL whenever the loan was only baselined (the server refuses
 * to age a first sighting), so this renders the reason rather than a dash a reader
 * would take for "no time at all".
 */
function MilestoneAge({ row }) {
  const d = row.milestone_days;
  if (d == null) {
    return (
      <span title={row.milestone_since
        ? 'This is where the loan already was when PILOT started watching it — how long it has been here is not known.'
        : 'PILOT has not read this loan yet.'} style={{ color: '#4B585C' }}>—</span>
    );
  }
  return <span style={{ color: '#141B22' }}>{d} day{d === 1 ? '' : 's'}</span>;
}

function LockCell({ row }) {
  if (!row.lock_status && row.lock_expiration_date == null) {
    return <span style={{ color: '#4B585C' }}>—</span>;
  }
  const left = row.lock_days_remaining == null ? null : Number(row.lock_days_remaining);
  const tone = left == null ? '#4B585C' : left < 0 ? '#8A2D2D' : left <= 7 ? '#8A6A22' : '#1F5F3F';
  return (
    <span style={{ color: tone, whiteSpace: 'nowrap' }}>
      {row.lock_status || 'Lock'}
      {left != null && (
        <span style={{ marginLeft: 6, fontSize: 12 }}>
          {left < 0 ? `expired ${Math.abs(left)}d ago` : left === 0 ? 'expires today' : `${left}d left`}
        </span>
      )}
    </span>
  );
}

/**
 * What to draw when the server did not say — the nine columns this screen carried
 * before the setting was wired up. It is a FALLBACK, not a second definition of the
 * catalog: `src/longterm/pipeline-columns.js` is the one that decides, and this only
 * ever runs against a server too old to answer.
 */
const FALLBACK_COLUMNS = [
  { key: 'loan_number', label: 'Loan #', field: 'loan_number', kind: 'text', sort: 'loan_number', align: 'left', emphasis: true },
  { key: 'borrower', label: 'Borrower', field: 'borrower_name', kind: 'text', sort: 'borrower', align: 'left' },
  { key: 'loan_amount', label: 'Amount', field: 'loan_amount', kind: 'money', sort: 'loan_amount', align: 'right' },
  { key: 'stage', label: 'Stage', field: 'stage_key', kind: 'text', sort: 'stage', align: 'left' },
  { key: 'milestone', label: 'Milestone', field: 'milestone_name', kind: 'text', sort: 'milestone', align: 'left' },
  { key: 'days_in_stage', label: 'At milestone', field: 'milestone_days', kind: 'milestone_days', sort: 'milestone_since', align: 'right' },
  { key: 'loan_officer', label: 'Loan officer', field: 'loan_officer', kind: 'contact', sort: null, align: 'left' },
  { key: 'lock_status', label: 'Lock', field: 'lock_status', kind: 'lock', sort: 'lock_expiration', align: 'left' },
  { key: 'updated', label: 'Updated', field: 'encompass_last_modified', kind: 'day', sort: 'last_modified', align: 'left' },
];

/**
 * One cell, drawn from what the COLUMN says it is.
 *
 * The screen no longer knows which columns exist — the server sends them, in order,
 * each carrying its `kind`, and this renders that kind. So a buyer who changes
 * `pipeline.columns` changes the table, which is the whole point of the setting; and a
 * column added to the catalog appears here without this file being touched.
 *
 * A value the loan does not carry renders as a DASH, never as a zero. "We have not
 * read this yet" and "it is nothing" are different answers, and on money, a rate or a
 * ratio the second one is a lie a desk would act on.
 */
function Cell({ col, row, stageLabel }) {
  const muted = { color: '#4B585C' };

  // WHICH FIELD A COLUMN READS IS THE COLUMN'S OWN BUSINESS (`field`, from the
  // server's catalog) — never a lookup table repeated here, which is how a screen and
  // a server come to disagree about what "LTV" means.
  const raw = row[col.field];

  switch (col.kind) {
    case 'money': return <span>{money(raw)}</span>;
    case 'pct': return <span>{pct(raw)}</span>;
    case 'ratio': return <span>{ratio(raw)}</span>;
    case 'milestone_days': return <MilestoneAge row={row} />;
    case 'lock': return <LockCell row={row} />;
    case 'day': return <span>{day(raw)}</span>;
    case 'contact': {
      // THE ROLE IS THE COLUMN'S `field`, so a third contact column (an underwriter,
      // a closer) needs one catalog entry on the server and nothing here.
      const c = (row.contacts || []).find((x) => x.role === col.field);
      if (!c || !c.name) return <span style={muted}>—</span>;
      return (
        <span>
          {c.name}
          {c.overridden && <span style={{ marginLeft: 6, fontSize: 11, color: '#AE8746' }}>reassigned</span>}
        </span>
      );
    }
    default: {
      const text = col.key === 'stage' ? stageLabel(raw) : raw;
      if (text == null || text === '') return <span style={muted}>—</span>;
      return <span>{String(text)}</span>;
    }
  }
}

/**
 * The long-term pipeline.
 *
 * Every row here is one the server's SCOPE already allowed — this screen does no
 * filtering of its own, so what you see is exactly what you may open.
 *
 * IT EXPLAINS AN EMPTY LIST. "You have no long-term files" and "nobody has linked
 * your Encompass account yet" look identical, and the second is the state every
 * officer is in until an admin confirms their link — so the server sends the reason
 * and this shows it rather than an empty table.
 *
 * Colours are explicit darks: every `--ink*` token in this palette is a LIGHT paper
 * colour and would render white-on-white.
 */
export default function LtPipeline() {
  const [data, setData] = useState(null);
  const [err, setErr] = useState(null);
  const [search, setSearch] = useState('');
  const [stage, setStage] = useState('');
  const [views, setViews] = useState(null);
  const [activeView, setActiveView] = useState('');
  const [naming, setNaming] = useState(false);
  const [viewName, setViewName] = useState('');
  const [confirmRemove, setConfirmRemove] = useState(false);
  // What the SCREEN asked for. What it DRAWS as sorted is what the server says it
  // actually did (`data.sort`/`data.dir`) — the server refuses a sort key it does not
  // accept and falls back, and an arrow pointing at a column the rows are not ordered
  // by is a lie the reader has no way to catch.
  const [sortReq, setSortReq] = useState('');
  const [dirReq, setDirReq] = useState('');
  const nav = useNavigate();

  const load = useCallback(() => {
    setErr(null);
    ltApi.pipeline({ search: search.trim(), stage, sort: sortReq, dir: dirReq })
      .then(setData)
      .catch((e) => setErr(e.message || 'Could not load the long-term pipeline.'));
  }, [search, stage, sortReq, dirReq]);

  useEffect(() => {
    const t = setTimeout(load, search ? 250 : 0);
    return () => clearTimeout(t);
  }, [load, search]);

  // The saved views, and the one this person opens on. A view only ever sets the
  // filters below — the server decides what those filters may reach.
  useEffect(() => {
    let alive = true;
    ltApi.views().then((v) => {
      if (!alive) return;
      setViews(v);
      const first = (v.views || []).find((x) => x.isDefault);
      if (first) { applyView(first); setActiveView(first.id); }
    }).catch(() => { if (alive) setViews({ views: [], canShare: false }); });
    return () => { alive = false; };
    // Runs once: re-applying a default while somebody is typing would fight them.
  }, []);

  const applyView = (v) => {
    const f = (v && v.filters) || {};
    setSearch(f.search || '');
    setStage(f.stage || '');
  };

  const reloadViews = () => ltApi.views().then(setViews).catch(() => {});

  // The name is typed INLINE rather than in a dialog. Long-Term may not import RTL's
  // dialog helper (the separation gate refuses it, and rightly — this side starts at
  // zero), and a browser prompt() is banned across this app because it stamps the
  // hosting hostname on the box. An input on the row is better than either.
  const saveCurrent = async (shared) => {
    const name = (viewName || '').trim();
    if (!name) return;
    const out = await ltApi.saveView({ name, filters: { search: search.trim(), stage }, shared })
      .catch((e) => ({ error: (e && e.message) || 'Could not save that view.' }));
    if (out && out.error) { setErr(out.error); return; }
    setViewName('');
    setNaming(false);
    await reloadViews();
    if (out && out.id) setActiveView(out.id);
  };

  const th = { textAlign: 'left', fontSize: 11, letterSpacing: '.06em', textTransform: 'uppercase',
    color: '#4B585C', fontWeight: 700, padding: '8px 10px', whiteSpace: 'nowrap' };
  const td = { padding: '10px', fontSize: 14, color: '#141B22', borderTop: '1px solid #EAE4D7' };

  // The columns the SERVER resolved from `pipeline.columns`. An older server that does
  // not send them is not a blank table: fall back to the set this screen has always
  // drawn, so a mid-deploy page load still shows somebody their book.
  const columns = (data && data.columns && data.columns.length) ? data.columns : FALLBACK_COLUMNS;
  const sort = (data && data.sort) || '';
  const dir = (data && data.dir) || 'desc';

  // A stage is stored as a key and READ as a label. The list of stages is the
  // tenant's own (Settings), and it rides on the same response.
  const stageLabel = (key) => {
    const s = (data && data.stages ? data.stages : []).find((x) => x.key === key);
    return (s && s.label) || key || '';
  };

  return (
    <LtLayout title="Long-term pipeline">
      {/* Saved views. A shared one is marked as somebody else's, and the control to
          make one is only offered to the people the server says may. */}
      {views && (
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center', marginBottom: 10 }}>
          {(views.views || []).length > 0 && (
            <select className="input" style={{ maxWidth: 260 }} value={activeView}
              onChange={(e) => {
                const v = (views.views || []).find((x) => x.id === e.target.value);
                setActiveView(e.target.value);
                setConfirmRemove(false);
                if (v) applyView(v);
              }}>
              <option value="">No saved view</option>
              {(views.views || []).map((v) => (
                <option key={v.id} value={v.id}>{v.name}{v.shared ? ' (shared)' : ''}</option>
              ))}
            </select>
          )}

          {naming ? (
            <>
              <input className="input" style={{ maxWidth: 220 }} autoFocus placeholder="Name this view"
                value={viewName} onChange={(e) => setViewName(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') saveCurrent(false); if (e.key === 'Escape') setNaming(false); }} />
              <button type="button" className="btn primary" style={{ padding: '4px 12px', fontSize: 13 }}
                disabled={!viewName.trim()} onClick={() => saveCurrent(false)}>Save for me</button>
              {views.canShare && (
                <button type="button" className="btn ghost" style={{ padding: '4px 12px', fontSize: 13 }}
                  disabled={!viewName.trim()} onClick={() => saveCurrent(true)}>Save for everybody</button>
              )}
              <button type="button" className="btn ghost" style={{ padding: '4px 10px', fontSize: 13 }}
                onClick={() => { setNaming(false); setViewName(''); }}>Cancel</button>
            </>
          ) : (
            <button type="button" className="btn ghost" style={{ padding: '4px 12px', fontSize: 13 }}
              onClick={() => setNaming(true)}>Save this view</button>
          )}

          {/* Removing asks once, on the button itself. Two clicks beats a dialog this
              side is not allowed to import — and beats none at all. */}
          {activeView && (views.views || []).some((v) => v.id === activeView && v.mine) && (
            <button type="button" className="btn ghost"
              style={{ padding: '4px 10px', fontSize: 13, color: confirmRemove ? '#8A2D2D' : undefined }}
              onClick={async () => {
                if (!confirmRemove) { setConfirmRemove(true); return; }
                await ltApi.deleteView(activeView).catch(() => {});
                setActiveView('');
                setConfirmRemove(false);
                reloadViews();
              }}>{confirmRemove ? 'Really remove it?' : 'Remove'}</button>
          )}
        </div>
      )}

      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 12 }}>
        <input className="input" placeholder="Search a loan number or borrower" value={search}
          onChange={(e) => setSearch(e.target.value)} style={{ maxWidth: 300 }} />
        <select className="input" value={stage} onChange={(e) => setStage(e.target.value)} style={{ maxWidth: 220 }}>
          <option value="">Every stage</option>
          {(data && data.stages ? data.stages : []).map((s) => (
            <option key={s.key} value={s.key}>{s.label}</option>
          ))}
        </select>
        {data && <span style={{ alignSelf: 'center', fontSize: 13, color: '#4B585C' }}>
          {data.total} file{data.total === 1 ? '' : 's'}
        </span>}
      </div>

      {err && <div className="card" style={{ color: '#141B22' }}>{err}</div>}

      {data && !data.loans.length && (
        <div className="card" style={{ color: '#141B22' }}>
          {data.emptyReason
            || 'No long-term files yet. They appear here once the sync has brought them in from Encompass.'}
        </div>
      )}

      {/* A CONFIGURED COLUMN WE CANNOT DRAW IS EXPLAINED, NEVER SILENTLY MISSING.
          Somebody put it in the setting on purpose; a column that just fails to
          appear reads as "the setting did not save", and the next thing that happens
          is somebody saving it again. */}
      {data && (data.unavailable || []).length > 0 && (
        <div className="card" style={{ color: '#4B585C', fontSize: 13, marginBottom: 12 }}>
          {data.unavailable.map((u) => (
            <div key={u.key} style={{ marginTop: 2 }}>
              <strong style={{ color: '#141B22' }}>{u.label}</strong> is not shown — {u.why}
            </div>
          ))}
        </div>
      )}
      {data && (data.unknown || []).length > 0 && (
        <div className="card" style={{ color: '#4B585C', fontSize: 13, marginBottom: 12 }}>
          The pipeline columns setting names {data.unknown.length === 1 ? 'a column' : 'columns'} nobody
          recognises: <strong style={{ color: '#141B22' }}>{data.unknown.join(', ')}</strong>. Check the
          spelling in Settings — {data.unknown.length === 1 ? 'it has' : 'they have'} been skipped.
        </div>
      )}

      {data && data.loans.length > 0 && columns.length > 0 && (
        <div className="card" style={{ padding: 0, overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 720 }}>
            <thead><tr>
              {columns.map((c) => {
                const active = c.sort && c.sort === sort;
                return (
                  <th key={c.key}
                    style={{ ...th, textAlign: c.align === 'right' ? 'right' : 'left',
                      cursor: c.sort ? 'pointer' : 'default', color: active ? '#141B22' : '#4B585C' }}
                    onClick={() => {
                      if (!c.sort) return;
                      setDirReq(active && dir === 'asc' ? 'desc' : 'asc');
                      setSortReq(c.sort);
                    }}
                    title={c.sort ? 'Sort by this column' : undefined}>
                    {c.label}{active && (dir === 'asc' ? ' ▲' : ' ▼')}
                  </th>
                );
              })}
            </tr></thead>
            <tbody>
              {data.loans.map((l) => (
                <tr key={l.id} style={{ cursor: 'pointer' }}
                  onClick={() => nav(`/internal/lt/loan/${l.id}`)}>
                  {columns.map((c, i) => (
                    <td key={c.key}
                      style={{ ...td, textAlign: c.align === 'right' ? 'right' : 'left',
                        fontWeight: c.emphasis ? 600 : 400 }}>
                      {/* THE PRODUCT STAMP, on every row (CLAUDE.md §7) — on the FIRST
                          column, whichever column that is. Hanging it off the loan
                          number would let a configuration that drops that column drop
                          the stamp with it, and the stamp is not configurable. It is
                          rendered from what the ROW carries, so it stays correct on a
                          combined pipeline instead of labelling everything the same. */}
                      {i === 0 ? (
                        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                          <ProductStamp product={l.product} label={l.productLabel} />
                          <Cell col={c} row={l} stageLabel={stageLabel} />
                        </span>
                      ) : <Cell col={c} row={l} stageLabel={stageLabel} />}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </LtLayout>
  );
}
