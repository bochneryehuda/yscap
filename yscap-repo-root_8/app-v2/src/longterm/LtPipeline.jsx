import React, { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import ProductStamp from './ProductStamp.jsx';
import LtLayout from './LtLayout.jsx';
import { ltApi } from './api.js';
// One definition of how a value is written down, shared with the file screen — two
// screens drawing the same loans must not each carry their own idea of a date.
import { money, pct, ratio, day } from './format.js';

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
 * One control chip.
 *
 * THE COUNT IS ABSENT, NEVER ZERO, WHEN WE DO NOT HAVE ONE. The counting is a
 * convenience on top of the list and is allowed to fail without costing anybody their
 * pipeline — but a chip that then reads "0" would tell them the book is empty, which
 * is exactly what the rows underneath it disprove. So `null` draws no number at all.
 *
 * Colours are explicit darks: every `--ink*` token in this palette is a LIGHT paper
 * colour and would render white on white.
 */
function Chip({ on, onClick, label, count, note, group }) {
  return (
    <button type="button" onClick={onClick} title={note || undefined}
      aria-pressed={on} data-chip={group}
      style={{
        display: 'inline-flex', alignItems: 'center', gap: 6, cursor: 'pointer',
        padding: '5px 12px', borderRadius: 999, fontSize: 13, fontWeight: on ? 700 : 550,
        background: on ? '#141B22' : '#FFFFFF',
        color: on ? '#FFFFFF' : '#141B22',
        border: `1px solid ${on ? '#141B22' : '#EAE4D7'}`,
        whiteSpace: 'nowrap',
      }}>
      <span>{label}</span>
      {count != null && (
        <span style={{ fontSize: 11, fontWeight: 700, opacity: on ? 0.85 : 1,
          color: on ? '#FFFFFF' : '#4B585C' }}>{count}</span>
      )}
    </button>
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
 * What is outstanding on this file — the plan's "a red count means a user triages
 * urgency from the list without opening a file".
 *
 * FOUR ANSWERS, AND THEY ARE NOT THE SAME. A file with work shows the number in
 * red. A file that has been read and has nothing left says "Clear" in words. A file
 * PILOT holds nothing about yet says "not read yet" — because a 0 there would be a
 * claim that the file is clear, which is exactly the confident blank this side
 * keeps finding. And a file the sweep has read that genuinely carries neither a
 * condition nor an eFolder document says "none", which is a different fact again.
 *
 * WHICH FEED IT COUNTED IS ON THE FACE OF IT. Every Encompass condition in this
 * tenant sits on a loan that is already sold, while a live file's work is its
 * eFolder needs list — so a column that counted only conditions would read zero
 * down the whole working book. The server decides which feed this file's work is,
 * with the same rule the file screen uses, and the cell says which one it counted
 * rather than leaving "4" to mean either.
 */
function OutstandingCell({ counts }) {
  const muted = { color: '#4B585C' };
  if (!counts) return <span style={muted} title="PILOT could not count this file just now.">—</span>;
  if (!counts.read) return <span style={muted} title="The Condition Center has not read this loan from Encompass yet, so there is nothing to count — which is not the same as nothing being outstanding.">not read yet</span>;

  const conditions = counts.face === 'conditions';
  const open = conditions ? counts.conditionsOpen : counts.documentsOutstanding;
  const total = conditions ? counts.conditionsTotal : counts.documentsTotal;
  const word = conditions ? 'condition' : 'document';

  if (!total) return <span style={muted} title="This loan carries no conditions and no eFolder documents.">none</span>;
  if (!open) return <span style={{ color: '#2C5E3F' }} title={`All ${total} ${word}${total === 1 ? '' : 's'} are done.`}>Clear</span>;
  return (
    <span style={{ color: '#8A2D2D', fontWeight: 700 }}
      title={`${open} of ${total} ${word}${total === 1 ? '' : 's'} still outstanding.`}>
      {open}
      <span style={{ ...muted, fontWeight: 400, fontSize: 11 }}> {conditions ? 'cond' : 'docs'}</span>
    </span>
  );
}

/**
 * The DSCR, and which side of THIS COMPANY'S own lines it fell on.
 *
 * A bare 1.28 down a column tells somebody who works these loans every day exactly
 * what they need and tells everybody else nothing — and the minimum and comfortable
 * thresholds have been settings since the registry was written. The verdict comes
 * from the SERVER, computed by the one rule the file screen reads, so the pipeline
 * and the file can never call the same loan different things.
 *
 * NO VERDICT ON A RATIO NOBODY MEASURED: a loan with no DSCR gets a dash, never a
 * red mark. The word is kept to one short token because this is a table cell — the
 * full sentence, naming the threshold it fell under, is the hover.
 */
function DscrCell({ row }) {
  const v = row.dscrVerdict;
  const shown = ratio(row.dscr_ratio);
  if (!v) return <span>{shown}</span>;
  const tone = v.level === 'below' ? '#8A2D2D' : v.level === 'thin' ? '#8A6A22' : '#2C5E3F';
  const word = v.level === 'below' ? 'below' : v.level === 'thin' ? 'thin' : 'ok';
  const why = v.level === 'below'
    ? `Under the ${v.minimum} minimum this company set — on these figures the property does not cover its own debt service.`
    : v.level === 'thin'
      ? `Over the ${v.minimum} minimum but under the ${v.comfort} this company calls comfortable.`
      : `At or over the ${v.comfort} this company calls comfortable.`;
  return (
    <span style={{ color: tone, fontWeight: 700 }} title={why}>
      {shown}
      <span style={{ color: '#4B585C', fontWeight: 400, fontSize: 11 }}> {word}</span>
    </span>
  );
}

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
    case 'dscr': return <DscrCell row={row} />;
    case 'milestone_days': return <MilestoneAge row={row} />;
    case 'lock': return <LockCell row={row} />;
    case 'day': return <span>{day(raw)}</span>;
    case 'outstanding': return <OutstandingCell counts={raw} />;
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
  // The second control row: '' (everyone's) | 'mine' | 'unassigned'.
  const [whose, setWhose] = useState('');
  // Which book: 'live' (the default a desk works out of) | 'closed' | 'all'. The row
  // is only DRAWN when the tenant has named folders that mean the deal is over — see
  // `data.bookControl`.
  const [book, setBook] = useState('live');
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
    ltApi.pipeline({
      search: search.trim(), stage, sort: sortReq, dir: dirReq,
      // "Mine" is asked for as a FLAG. The server resolves whose from the session,
      // so a viewer who sees the whole book cannot ask for somebody else's personal
      // queue by editing a URL.
      mine: whose === 'mine' ? 'true' : '',
      unassigned: whose === 'unassigned' ? 'true' : '',
      book,
    })
      .then(setData)
      .catch((e) => setErr(e.message || 'Could not load the long-term pipeline.'));
  }, [search, stage, whose, book, sortReq, dirReq]);

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
    // A saved "mine" is a flag, so a SHARED view of it means whoever opens it — which
    // is what makes "Mine, at underwriting" one view the whole desk can use.
    setWhose(f.mine ? 'mine' : f.unassigned ? 'unassigned' : '');
    // A view with no opinion about the book opens on the default, not on whatever the
    // last view left behind.
    setBook(f.book || 'live');
  };

  const reloadViews = () => ltApi.views().then(setViews).catch(() => {});

  // The name is typed INLINE rather than in a dialog. Long-Term may not import RTL's
  // dialog helper (the separation gate refuses it, and rightly — this side starts at
  // zero), and a browser prompt() is banned across this app because it stamps the
  // hosting hostname on the box. An input on the row is better than either.
  const saveCurrent = async (shared) => {
    const name = (viewName || '').trim();
    if (!name) return;
    const filters = { search: search.trim(), stage };
    if (whose === 'mine') filters.mine = true;
    if (whose === 'unassigned') filters.unassigned = true;
    // Only stored when it is NOT the default — a view saved today must not pin the
    // desk to the live book if that default ever moves. The server drops it either way.
    if (book !== 'live') filters.book = book;
    const out = await ltApi.saveView({ name, filters, shared })
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

      {/* TWO INDEPENDENT CONTROL ROWS, plus free-text search (§4.1) — which is the
          arrangement the owner's reference portal uses and the reason it stays simple
          while being exhaustive. They narrow TOGETHER: a stage and a scope are
          different questions about the same book, so neither clears the other.

          Each chip carries its own count, and each count is computed with that chip's
          OWN filter lifted, so it always says what CLICKING it would show. A row of
          chips reading zero because one of them is selected is a row nobody can
          navigate out of. */}
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 8 }}>
        {/* NOT `data.total` — that is counted WITH the stage filter, so with a stage
            selected this chip would read the selected stage's number and nobody could
            see how big the book is. `allStages` is counted stage-lifted, like every
            other chip in this row. */}
        <Chip group="stage" on={!stage} onClick={() => setStage('')} label="Every stage"
          count={data && data.facets ? data.facets.allStages : null} />
        {(data && data.stages ? data.stages : []).map((s) => (
          <Chip key={s.key} group="stage" on={stage === s.key} onClick={() => setStage(s.key)}
            label={s.label} count={s.count}
            // A stage no settings map names still gets a chip — §4.1.1: a milestone
            // with no mapping is shown, not hidden, and a file you cannot filter to
            // is a file people stop seeing.
            note={s.undeclared ? 'Encompass is using this stage and the settings do not name it yet' : null} />
        ))}
      </div>

      {/* The scope row means nothing to somebody who only ever sees their own files —
          every chip would select the same book — so it is not drawn for them. */}
      {data && data.scope === 'all' && data.facets && (
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 10 }}>
          <Chip group="scope" on={!whose} onClick={() => setWhose('')} label="Everyone’s files"
            count={data.facets.all} />
          {data.facets.mine != null && (
            <Chip group="scope" on={whose === 'mine'} onClick={() => setWhose('mine')} label="Mine"
              count={data.facets.mine} />
          )}
          <Chip group="scope" on={whose === 'unassigned'} onClick={() => setWhose('unassigned')}
            label="Nobody yet" count={data.facets.unassigned}
            note="Files with no one on them — a closing or a wire is picked up off the queue, so they have to be findable" />
        </div>
      )}

      {/* THE LIVE BOOK AND THE CLOSED ONE — §4.1's "inactive loans stay in it,
          distinguished by status", so one table and a chip rather than an archive
          screen. Drawn ONLY when the tenant has named folders that mean the deal is
          over: with none named every chip selects identical rows, which is not a
          control — the same reason the scope row above is hidden from somebody who
          only ever sees their own files. */}
      {data && data.bookControl && data.bookCounts && (
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 10 }}>
          <Chip group="book" on={book === 'live'} onClick={() => setBook('live')} label="Live"
            count={data.bookCounts.live}
            note="Everything still in play — a folder nobody has marked as finished always counts as live" />
          <Chip group="book" on={book === 'closed'} onClick={() => setBook('closed')} label="Finished"
            count={data.bookCounts.closed}
            note="Declined, withdrawn or otherwise done — kept in the same table, one click away" />
          <Chip group="book" on={book === 'all'} onClick={() => setBook('all')} label="Both"
            count={data.bookCounts.all} />
        </div>
      )}

      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 12 }}>
        <input className="input" placeholder="Search a loan number or borrower" value={search}
          onChange={(e) => setSearch(e.target.value)} style={{ maxWidth: 300 }} />
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
      {/* A scope filter this viewer's own scope makes meaningless — most likely a
          SHARED saved view written by somebody who sees the whole book. Saying so
          beats a pipeline that quietly shows something other than what was asked. */}
      {data && (data.filtersIgnored || []).length > 0 && (
        <div className="card" style={{ color: '#4B585C', fontSize: 13, marginBottom: 12 }}>
          {data.filtersIgnored.map((f) => <div key={f.key} style={{ marginTop: 2 }}>{f.why}</div>)}
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
