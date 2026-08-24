import React, { useCallback, useEffect, useState } from 'react';
import { useNavigate, Link } from 'react-router-dom';
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
 * What to draw when the server did not say — the nine columns this screen carried
 * before the setting was wired up. It is a FALLBACK, not a second definition of the
 * catalog: `src/longterm/pipeline-columns.js` is the one that decides, and this only
 * ever runs against a server too old to answer.
 */
const FALLBACK_COLUMNS = [
  { key: 'loan_number', label: 'Loan #', field: 'loan_number', kind: 'text', sort: 'loan_number', align: 'left', emphasis: true },
  { key: 'borrower', label: 'Borrower', field: 'borrower_name', kind: 'borrower', sort: 'borrower', align: 'left' },
  { key: 'loan_amount', label: 'Amount', field: 'loan_amount', kind: 'money', sort: 'loan_amount', align: 'right' },
  { key: 'stage', label: 'Stage', field: 'stage_key', kind: 'text', sort: 'stage', align: 'left' },
  // `milestone_label` is the server's completed-form wording (owner-directed
  // 2026-08-24: "Funded", never "Funding") — pipeline.js decorates every row.
  { key: 'milestone', label: 'Milestone', field: 'milestone_label', kind: 'text', sort: 'milestone', align: 'left' },
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
  // A healthy ratio needs NO word (owner-directed 2026-08-23: *"after the ratio, it
  // says 'OK.' I don't need that word over there"*): green is the answer, and an
  // "ok" on four hundred healthy rows is what trains eyes to skip the column. The
  // two WARNING words stay — they are the rows a desk has to catch.
  const word = v.level === 'below' ? 'below' : v.level === 'thin' ? 'thin' : null;
  // WHOSE NUMBER. "this company set" is a claim about authorship, and it is false
  // whenever the company has not configured that threshold — we fall back to the
  // shipped one, which is right, but saying they chose it is not. The verdict now
  // says which, so a red mark is never attributed to a rule nobody wrote.
  const whose = (isCompany) => (isCompany ? ' this company set' : ' PILOT ships by default');
  const comfortWhose = (isCompany) => (isCompany ? 'this company calls comfortable' : 'PILOT treats as comfortable by default');
  const why = v.level === 'below'
    ? `Under the ${v.minimum} minimum${whose(v.minimumIsCompany)} — on these figures the property does not cover its own debt service.`
    : v.level === 'thin'
      ? `Over the ${v.minimum} minimum${whose(v.minimumIsCompany)} but under the ${v.comfort} ${comfortWhose(v.comfortIsCompany)}.`
      : `At or over the ${v.comfort} ${comfortWhose(v.comfortIsCompany)}.`;
  return (
    <span style={{ color: tone, fontWeight: 700 }} title={why}>
      {shown}
      {word && <span style={{ color: '#4B585C', fontWeight: 400, fontSize: 11 }}> {word}</span>}
    </span>
  );
}

/**
 * WHAT A CELL SAYS, AS TEXT — the one definition the per-column search filters by.
 *
 * It deliberately mirrors what the CELL RENDERS, not what the row stores: somebody
 * typing "1,050" into the amount box is copying what their eye sees, and a filter
 * that only matched the stored "1050000.00" would tell them the file is not there.
 * Both spellings match — the formatted text and the raw digits — so either habit
 * finds the row. A dash cell yields '', which no non-empty search matches: filtering
 * a column keeps only rows that HAVE that value, which is what a person typing into
 * that column means.
 */
function cellSearchText(col, row, stageLabel) {
  const raw = row[col.field];
  switch (col.kind) {
    case 'money': return raw == null ? '' : `${money(raw)} ${String(raw)}`;
    case 'pct': return raw == null ? '' : `${pct(raw)} ${String(raw)}`;
    case 'ratio': return raw == null ? '' : `${ratio(raw)} ${String(raw)}`;
    case 'dscr': return row.dscr_ratio == null ? '' : `${ratio(row.dscr_ratio)} ${String(row.dscr_ratio)}`;
    case 'milestone_days': return row.milestone_days == null ? '' : `${row.milestone_days} days`;
    case 'lock': return [row.lock_status, row.lock_expiration_date].filter(Boolean).join(' ');
    case 'day': return raw == null ? '' : String(day(raw));
    case 'outstanding': return '';
    case 'contact': {
      const c = (row.contacts || []).find((x) => x.role === col.field);
      return (c && c.name) || '';
    }
    default: return col.key === 'stage' ? String(stageLabel(raw) || '') : (raw == null ? '' : String(raw));
  }
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
/** Plain words for a contact role — the persona chip and the "Mine" label share
 *  them so the two can never call one role two things. */
const ROLE_WORDS = {
  loan_officer: 'loan officer',
  processor: 'processor',
  file_setup: 'file setup',
  underwriter: 'underwriter',
  closer: 'closer',
  funder: 'funder',
  post_closer: 'post-closer',
};
const roleWord = (r) => ROLE_WORDS[r] || String(r || '').replace(/_/g, ' ');
function mineRoleWords(roles) {
  if (!Array.isArray(roles) || !roles.length) return '';
  return roles.map(roleWord).join(' / ');
}

function Cell({ col, row, stageLabel, mineRoles }) {
  const muted = { color: '#4B585C' };

  // WHICH FIELD A COLUMN READS IS THE COLUMN'S OWN BUSINESS (`field`, from the
  // server's catalog) — never a lookup table repeated here, which is how a screen and
  // a server come to disagree about what "LTV" means.
  const raw = row[col.field];

  // TWO ENCOMPASS RECORDS, ONE LOAN NUMBER — said on the row (owner-reported
  // 2026-08-23, YSCAP258134474: a stale second Encompass record read "Started /
  // $202,500" while the real one sat sold — and nothing said there were two). The
  // count comes from the server, against live records only; the fix is deleting
  // the stale record in Encompass, which the hover says.
  if (col.key === 'loan_number') {
    const dups = Number(row.duplicate_records) || 0;
    return (
      <span style={{ whiteSpace: 'nowrap' }}>
        {raw == null || raw === '' ? <span style={muted}>—</span> : String(raw)}
        {dups > 0 && (
          <span title={`Encompass holds ${dups + 1} live records with this loan number \u2014 this row is one of them, and the figures differ between the copies. The extra record should be deleted in Encompass; once it is trashed there, it drops off this screen on the next sync.`}
            style={{ marginLeft: 6, fontSize: 10, fontWeight: 700, letterSpacing: '.04em',
              color: '#8A2D2D', border: '1px solid #E4C7C7', background: '#FBEFEF',
              borderRadius: 999, padding: '1px 7px', verticalAlign: 'middle' }}>
            {dups + 1} RECORDS
          </span>
        )}
        {/* WHY this file is in front of you, when the reason is a hat OTHER than
            your own function (owner-directed 2026-08-23: "for each and every
            person, why they are looped into the file" — a closer-only file must
            never read as an officer's own). Quiet on the ordinary case: a file
            you hold in your own role carries no chip, or every row would. */}
        {(() => {
          const mineList = Array.isArray(mineRoles) ? mineRoles : null;
          const others = (row.my_roles || []).filter((r) => !mineList || !mineList.includes(r));
          if (!others.length) return null;
          return (
            <span title={'You are on this file as: ' + others.map(roleWord).join(', ') + '. It is not one of your own-function files \u2014 that is why it does not sit under \u201CMy files\u201D.'}
              style={{ marginLeft: 6, fontSize: 10, fontWeight: 700, letterSpacing: '.04em',
                color: '#2F7F86', border: '1px solid #BFD9DC', background: '#F0F7F8',
                borderRadius: 999, padding: '1px 7px', verticalAlign: 'middle', whiteSpace: 'nowrap' }}>
              YOU: {others.map(roleWord).join(' + ').toUpperCase()}
            </span>
          );
        })()}
      </span>
    );
  }

  switch (col.kind) {
    case 'money': return <span>{money(raw)}</span>;
    case 'pct': return <span>{pct(raw)}</span>;
    case 'ratio': return <span>{ratio(raw)}</span>;
    case 'dscr': return <DscrCell row={row} />;
    case 'milestone_days': return <MilestoneAge row={row} />;
    case 'lock': return <LockCell row={row} />;
    case 'day': return <span>{day(raw)}</span>;
    case 'outstanding': return <OutstandingCell counts={raw} />;
    // THE BORROWER, AND WHOSE NAME IT IS. The server prefers the linked PILOT
    // profile and falls back to the name Encompass gave us, so this column stopped
    // being a dash on every unlinked loan — but an unconfirmed name must not pass
    // for a confirmed one, so it says which it is drawing. Quiet on purpose: it is
    // the ordinary state of a freshly mirrored book, not a fault, and a loud badge
    // on four hundred rows is a badge nobody reads.
    case 'borrower': {
      if (raw == null || raw === '') return <span style={muted}>—</span>;
      // The name stands ALONE (owner-directed 2026-08-23: the "from Encompass" tag
      // *"doesn't need to be over there"*). Whether it is linked to a PILOT profile
      // still matters to whoever is doing the linking, so that fact survives as the
      // HOVER — visible to the person who asks, invisible to everyone scanning.
      const unlinked = row.borrower_is_linked === false;
      return (
        <span title={unlinked
          ? 'This is the name on the Encompass loan. Nobody has matched it to a PILOT borrower profile yet.'
          : undefined}>
          {String(raw)}
        </span>
      );
    }
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
  // The on-demand Encompass pull, offered on an empty pipeline. Its own two pieces
  // of state so a pull in flight can never be confused with the list loading.
  const [pulling, setPulling] = useState(false);
  const [pullNote, setPullNote] = useState('');
  const [search, setSearch] = useState('');
  const [stage, setStage] = useState('');
  // The second control row: '' (everyone's) | 'mine' | 'unassigned'.
  // Which book: 'live' (the default a desk works out of) | 'closed' | 'withdrawn' | 'all'. The row
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
  // THE DEFAULT IS YOUR OWN FILES (owner-directed 2026-08-23: "It should always
  // default to active files. Into your own files. And this should be like the main
  // thing."). For a scoped officer the flag is the harmless twin of their book; for
  // an admin it is the actual default, one click from Everyone's.
  const [whose, setWhose] = useState('mine');
  // Looking at ONE officer's book — the RTL-style pick. Setting it replaces the
  // mine/everyone choice; clearing it falls back to Everyone's.
  const [officerId, setOfficerId] = useState('');
  // The same pick for an officer whose PILOT link nobody has confirmed yet — keyed
  // on their Encompass login, so a name the rows plainly show is still pickable.
  const [officerLogin, setOfficerLogin] = useState('');
  // One search box PER COLUMN, keyed by the column key. These filter CLIENT-side
  // over the whole fetched book — which the fetch below makes honest by asking for
  // everything the server-side filters allow (the book is a few hundred rows).
  const [colFilters, setColFilters] = useState({});
  const nav = useNavigate();

  const load = useCallback(() => {
    setErr(null);
    ltApi.pipeline({
      search: search.trim(), stage, sort: sortReq, dir: dirReq,
      // "Mine" is asked for as a FLAG. The server resolves whose from the session,
      // so a viewer who sees the whole book cannot ask for somebody else's personal
      // queue by editing a URL.
      mine: !officerId && !officerLogin && (whose === 'mine' || whose === 'mine-any') ? 'true' : '',
      // 'mine' is persona-matched on the server (an admin's book is the files they
      // ORIGINATE — the owner: a file where they were only the closer must not turn
      // up under "files I'm the loan officer on"); 'mine-any' is the deliberate
      // wide reading, every file they hold ANY role on.
      mineRole: !officerId && !officerLogin && whose === 'mine-any' ? 'any' : '',
      unassigned: !officerId && !officerLogin && whose === 'unassigned' ? 'true' : '',
      officer: officerId,
      officerLogin,
      // The whole (filtered) book in one answer, so the per-column search below is
      // filtering over everything rather than over one server page — the old
      // 50-row default page with no pager is exactly the owner's "133 active and
      // I'm not seeing even close to that number".
      limit: 1000,
      book,
    })
      .then(setData)
      .catch((e) => setErr(e.message || 'Could not load the long-term pipeline.'));
  }, [search, stage, whose, officerId, officerLogin, book, sortReq, dirReq]);

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
    const officer = f.officerStaffId || f.officer || '';
    const officerLoginSaved = f.officerLoginId || '';
    setWhose(f.mine ? 'mine' : f.unassigned ? 'unassigned' : ((officer || officerLoginSaved) ? '' : 'mine'));
    setOfficerId(officer);
    setOfficerLogin(officerLoginSaved);
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
    if (!officerId && !officerLogin && whose === 'mine') filters.mine = true;
    if (!officerId && !officerLogin && whose === 'unassigned') filters.unassigned = true;
    // The KEY the server's saved-view validator accepts (views.js FILTER_KEYS) —
    // the old `officer` key was silently dropped there, so an officer pick never
    // actually survived into a saved view.
    if (officerId) filters.officerStaffId = officerId;
    if (officerLogin) filters.officerLoginId = officerLogin;
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

  // The rows after the per-column searches. Every active box must match its own
  // column — a contact select matches exactly, a text box matches anywhere in what
  // the cell shows (case blind, and commas/dollar signs in a typed amount are
  // ignored the same way the eye ignores them).
  const columnsForFilter = (data && data.columns) || [];
  const norm = (v) => String(v || '').toLowerCase().replace(/[$,\s]/g, '');
  const shownLoans = (data ? data.loans : []).filter((row) => columnsForFilter.every((c) => {
    const q = (colFilters[c.key] || '').trim();
    if (!q) return true;
    const text = cellSearchText(c, row, stageLabel);
    if (c.kind === 'contact') return text === q;
    return norm(text).includes(norm(q));
  }));
  const colFiltersActive = Object.values(colFilters).some((v) => String(v || '').trim());

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

      {/* THE BOOK IS THE FIRST CONTROL (owner-directed 2026-08-23: "The main first
          link should be active, closed, withdrawn, and all" — the stage list "should
          not be the main first link"). Segmented like the RTL pipeline's own primary
          lens, each tab carrying its count, counted with the book filter lifted so a
          tab always says what clicking it would show. Drawn only when the tenant has
          named the folders that mean a deal is over — with none named every tab
          would select identical rows, which is not a control. Encompass's TRASH is
          in none of these: deleted files live on the archive screen alone. */}
      {data && data.bookControl && data.bookCounts && (
        <div className="tabs" style={{ marginBottom: 10 }}>
          {[['live', 'Active', 'Everything still in play — a folder nobody has classified always counts as active'],
            ['closed', 'Closed', 'Deals that completed, funded files included'],
            ['withdrawn', 'Withdrawn', 'Deals that died — withdrawn or cancelled, kept apart from the closed book on purpose'],
            ['all', 'All', 'Every book at once']].map(([k, label, note]) => (
              <button key={k} type="button" className={`tab ${book === k ? 'on' : ''}`}
                title={note} onClick={() => setBook(k)}>
                {label}<span className="ct">{data.bookCounts[k]}</span>
              </button>
          ))}
        </div>
      )}

      {/* ONE FILTER ROW, the RTL shape (owner-directed 2026-08-23: "separate
          filters to select the stage of the file … If I want to see only my file,
          everyone's file that doesn't have anyone assigned yet, or pick all
          officers"). The stage moved off the top into a select here; whose-files
          and the officer pick are ONE select, because they are one question — and
          it lists every officer the book itself shows, linked to a PILOT login or
          not, so a name on the rows is never missing from the list that filters
          them. Each option carries its count, counted with its own filter lifted. */}
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 12, alignItems: 'center' }}>
        <input className="input" type="search" placeholder="Search a loan number or borrower" value={search}
          onChange={(e) => setSearch(e.target.value)} style={{ flex: '1 1 260px', minWidth: 220, maxWidth: 420 }} />
        <select className="input" style={{ maxWidth: 230 }} value={stage}
          aria-label="Stage" title="Show one stage of the pipeline"
          onChange={(e) => setStage(e.target.value)}>
          <option value="">
            {`Every stage${data && data.facets && data.facets.allStages != null ? ` (${data.facets.allStages})` : ''}`}
          </option>
          {(data && data.stages ? data.stages : []).map((st) => (
            <option key={st.key} value={st.key}>
              {st.label}{st.count != null ? ` (${st.count})` : ''}{st.undeclared ? ' — not in the settings yet' : ''}
            </option>
          ))}
        </select>
        {data && data.scope === 'all' && (
          <select className="input" style={{ maxWidth: 280 }}
            value={officerId ? `s:${officerId}` : officerLogin ? `e:${officerLogin}` : whose}
            aria-label="Whose files" title="Whose files to show"
            onChange={(e) => {
              const v = e.target.value;
              if (v.startsWith('s:')) { setOfficerId(v.slice(2)); setOfficerLogin(''); setWhose(''); }
              else if (v.startsWith('e:')) { setOfficerLogin(v.slice(2)); setOfficerId(''); setWhose(''); }
              else { setOfficerId(''); setOfficerLogin(''); setWhose(v); }
            }}>
            {/* "My files" says WHAT IT MEANS \u2014 the persona the server matched
                ("as loan officer"), so the narrowing is never silent; the any-role
                reading is its own choice one line below, so a file held in another
                hat is always one click away, with the row badge saying which hat. */}
            <option value="mine">
              {`My files${mineRoleWords(data.mineRoles) ? ` \u2014 as ${mineRoleWords(data.mineRoles)}` : ''}${whose === 'mine' && data.facets && data.facets.mine != null ? ` (${data.facets.mine})` : ''}`}
            </option>
            <option value="mine-any">
              {`Everything I\u2019m on \u2014 any role${whose === 'mine-any' && data.facets && data.facets.mine != null ? ` (${data.facets.mine})` : ''}`}
            </option>
            <option value="">{`Everyone\u2019s${data.facets ? ` (${data.facets.all})` : ''}`}</option>
            <option value="unassigned">{`Nobody\u2019s yet${data.facets ? ` (${data.facets.unassigned})` : ''}`}</option>
            {(data.officers || []).length > 0 && (
              <optgroup label={'One officer\u2019s files'}>
                {data.officers.map((o) => (
                  <option key={o.staff_id || `login:${o.login_id}`}
                    value={o.staff_id ? `s:${o.staff_id}` : `e:${o.login_id}`}>
                    {o.full_name}{o.linked === false ? ' — not connected to a PILOT login yet' : ''}
                  </option>
                ))}
              </optgroup>
            )}
          </select>
        )}
        {data && <span style={{ fontSize: 13, color: '#4B585C' }}>
          {colFiltersActive
            ? `${shownLoans.length} of ${data.total} file${data.total === 1 ? '' : 's'}`
            : `${data.total} file${data.total === 1 ? '' : 's'}`}
          {colFiltersActive && (
            <button type="button" className="btn ghost" style={{ marginLeft: 8, padding: '2px 8px', fontSize: 12 }}
              onClick={() => setColFilters({})}>Clear searches</button>
          )}
        </span>}
        {/* THE ARCHIVE'S ONE QUIET DOOR (owner-directed 2026-08-23: deleted-in-
            Encompass files are "totaled in the archive folder, and you can click
            over there"). Drawn only when it holds anything and only for a viewer
            the server counted it for. */}
        {data && data.archiveCount > 0 && (
          <Link to="/internal/lt/archive" style={{ fontSize: 13, color: '#256168' }}>
            Archive: {data.archiveCount} deleted file{data.archiveCount === 1 ? '' : 's'}
          </Link>
        )}
        {/* An honest cap: the fetch asks for the whole book, and if the book ever
            outgrows it, the difference is SAID rather than silently cut — the exact
            failure the old 50-row page had. */}
        {data && data.total > data.loans.length && (
          <span style={{ fontSize: 13, color: '#8A6A22' }}>
            Showing the first {data.loans.length} of {data.total} — narrow it down to see the rest.
          </span>
        )}
      </div>

      {err && <div className="card" style={{ color: '#141B22' }}>{err}</div>}

      {data && !data.loans.length && (
        <div className="card" style={{ color: '#141B22' }}>
          {data.emptyReason
            || (data.scope === 'all' && whose === 'mine' && !officerId && !officerLogin
              ? (data.viewerLinked === false
                ? (<span>
                    Your PILOT login is not connected to your Encompass login yet — that is why
                    {' '}“My files” is empty even though your name is on files. Open the{' '}
                    <Link to="/internal/lt/people" style={{ color: '#256168' }}>Team screen</Link> and
                    confirm your own row; your files fill in the moment it is confirmed.
                  </span>)
                : 'No files are assigned to you. You are looking at YOUR OWN files \u2014 the default \u2014 so this is not the whole book: pick \u201CEveryone\u2019s\u201D above to see it.')
              : 'No long-term files yet. They appear here once the sync has brought them in from Encompass.')}
          {/* THE ACTION BELONGS WHERE THE PROBLEM IS SEEN. An empty pipeline is
              exactly the moment somebody wants to press "bring them in", and sending
              them off to find another screen is how a working system reads as broken.
              Offered only when there is genuinely nothing here, and only to somebody
              allowed to run it — the button hides itself rather than 403-ing, and the
              server re-checks the permission on the press either way. */}
          {!data.emptyReason && (
            <div style={{ marginTop: 12 }}>
              <button type="button" className="btn primary" disabled={pulling}
                onClick={async () => {
                  setPulling(true); setPullNote('');
                  try {
                    const out = await ltApi.pullFromEncompass();
                    setPullNote(out.note || 'Pulling from Encompass now.');
                    setTimeout(() => load(), 8000);
                  } catch (e) {
                    // A staffer who may not run it is TOLD so, rather than left
                    // pressing a button that appears to do nothing.
                    setPullNote(e.message || 'Could not start the pull.');
                  } finally { setPulling(false); }
                }}>
                {pulling ? 'Starting…' : 'Pull everything from Encompass'}
              </button>
              {pullNote && (
                <div style={{ marginTop: 8, fontSize: 13, color: '#4B585C' }}>{pullNote}</div>
              )}
            </div>
          )}
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
            </tr>
            {/* ONE SEARCH PER COLUMN (owner-directed 2026-08-23: "on every column
                [a] separate search bar"). They filter INSTANTLY over the whole
                fetched book — the fetch above asks for everything the server-side
                filters allow, so narrowing here is honest. A contact column offers
                the people actually on the rows instead of a text box, which is the
                "officer should be like a select" half of the same instruction. */}
            <tr>
              {columns.map((c) => (
                <th key={c.key} style={{ padding: '2px 8px 8px' }}>
                  {c.kind === 'outstanding' ? null : c.kind === 'contact' ? (
                    <select className="input" style={{ width: '100%', fontSize: 12, padding: '3px 6px' }}
                      value={colFilters[c.key] || ''}
                      onChange={(e) => setColFilters((f) => ({ ...f, [c.key]: e.target.value }))}>
                      <option value="">All</option>
                      {[...new Set(data.loans
                        .map((r) => ((r.contacts || []).find((x) => x.role === c.field) || {}).name)
                        .filter(Boolean))].sort().map((n) => <option key={n} value={n}>{n}</option>)}
                    </select>
                  ) : (
                    <input className="input" style={{ width: '100%', fontSize: 12, padding: '3px 6px' }}
                      placeholder="Search" aria-label={`Search ${c.label}`}
                      value={colFilters[c.key] || ''}
                      onChange={(e) => setColFilters((f) => ({ ...f, [c.key]: e.target.value }))} />
                  )}
                </th>
              ))}
            </tr></thead>
            <tbody>
              {shownLoans.map((l) => (
                <tr key={l.id} style={{ cursor: 'pointer' }}
                  onClick={() => nav(`/internal/lt/loan/${l.id}`)}>
                  {columns.map((c, i) => (
                    <td key={c.key}
                      style={{ ...td, textAlign: c.align === 'right' ? 'right' : 'left',
                        fontWeight: c.emphasis ? 600 : 400 }}>
                      {/* NO per-row product stamp here, and that is not a drift from
                          CLAUDE.md §7 — read the rule: the stamp-on-every-row demand is
                          for a COMBINED pipeline listing both products, where a row's
                          product is a fact the eye needs. This screen lists ONE product
                          by construction (its own route, its own tables), says so in
                          its title, and the rule's author directed the per-row copy
                          removed (owner, 2026-08-23: *"This entire pipeline is only
                          long term, so you don't need to stamp every file
                          separately"*). The FILE header keeps its stamp — §7 asks for
                          that one by name, and LtLoan.jsx renders it. A future combined
                          pipeline brings the per-row stamp back with the merge. */}
                      <Cell col={c} row={l} stageLabel={stageLabel} mineRoles={data.mineRoles} />
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
