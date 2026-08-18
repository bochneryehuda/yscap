import React, { useCallback, useEffect, useState } from 'react';
import LtLayout from './LtLayout.jsx';
import { ltApi } from './api.js';
// `day` reads an epoch instant here, not a calendar-date column: a parity cell stores the canary's
// own `dayMs` verbatim (db/575), which is the moment the run happened. The helper's date-string
// branch — the one that exists because a DATE column parses as UTC midnight and prints the day
// before — never applies to it, so the shared helper is the right reading and not a second one.
import { rate, day } from './format.js';
// The tokens live in ppeStyles.js so this screen and the rate-sheet console cannot drift into two
// slightly different cards. Same values, one definition.
import { INK, MUTED, SLATE, GOLD, PAPER, card, h2, sub, eyebrow } from './ppeStyles.js';
import RateSheetConsole from './RateSheetConsole.jsx';
import CanaryConsole from './CanaryConsole.jsx';
import RuleBoard from './RuleBoard.jsx';

// ---------------------------------------------------------------------------
// The Product & Pricing Engine, made visible.
//
// The engine runs in SHADOW: Lender Price answers, ours prices the same scenario
// beside it, and every disagreement becomes a finding. So this screen's job is
// not to show prices — it is to show DISAGREEMENTS, in the order worth working,
// and to be honest about how far from ready the engine is.
//
// Three rules this screen keeps:
//   · It NEVER re-ranks. The server's review queue owns severity and ordering
//     (`review-queue.buildQueue`); a second ordering here would be a second
//     definition of "what to work on first" and the two would drift.
//   · It never hides a control a person may not use. Deciding a finding is
//     admin-only on the server, so a non-admin sees the button and is told why
//     it was refused — a hidden button is indistinguishable from a broken one.
//   · It settles a finding through an INLINE form, not a modal. Two reasons, and
//     the first is structural: the shared dialog helper lives in RTL's folders
//     (`app-v2/src/lib/dialog.js`), and Long-Term may not import RTL code without
//     the owner's written authorization — the separation gate refused it, which
//     is the gate doing its job. A second Long-Term copy of a dialog would be a
//     duplicate of a solved problem, so the better answer is not to need one.
//     The second reason is that it is simply better here: the reason a finding
//     was settled is worth typing WHILE looking at the finding, and the refusal
//     belongs next to the row that was refused, not in a box over it.
//   · It shows "not proven" as "not proven". The go-live gate cannot pass while
//     no canary has run, and that is the honest state rather than a failure, so
//     it is worded that way instead of as a red error.
//
// Dark text on the white PILOT canvas throughout — never a `--ink*` token, which
// is a LIGHT paper colour in this palette and renders white-on-white.
// ---------------------------------------------------------------------------

function Pill({ tone, children }) {
  const tones = {
    good: { bg: 'rgba(47,127,134,.10)', fg: '#256168', bd: 'rgba(47,127,134,.35)' },
    warn: { bg: 'rgba(174,135,70,.12)', fg: '#7A5C25', bd: 'rgba(174,135,70,.40)' },
    bad: { bg: 'rgba(158,58,58,.10)', fg: '#8A2F2F', bd: 'rgba(158,58,58,.32)' },
    flat: { bg: PAPER, fg: SLATE, bd: 'rgba(20,27,34,.14)' },
  };
  const t = tones[tone] || tones.flat;
  return (
    <span style={{
      display: 'inline-block', padding: '2px 8px', borderRadius: 999, fontSize: 12,
      fontWeight: 600, background: t.bg, color: t.fg, border: `1px solid ${t.bd}`,
    }}>{children}</span>
  );
}

// Severity comes from the server (`review-queue.SEVERITY`); this only chooses a colour.
const SEV_TONE = { critical: 'bad', high: 'bad', medium: 'warn', low: 'flat', unknown: 'warn' };

/**
 * A price gap, written in POINTS.
 *
 * The parity measurements are canonical integer MILLI-points (`parity-detectors`: 1000 milli = 1
 * point), because a comparison that rounds cannot tell a real one-thousandth disagreement from a
 * tolerance. Printing the raw milli on a screen would report a 1.25-point gap as "1250", which reads
 * as a catastrophe on a rate sheet quoted in points. Missing stays a dash — a band nobody priced has
 * no gap, and a 0 there would say the two engines agreed exactly.
 */
const points = (milli) => (typeof milli === 'number' && Number.isFinite(milli)
  ? `${(milli / 1000).toFixed(3).replace(/0+$/, '').replace(/\.$/, '')} pts`
  : '—');

// The direction comes from `scoreboard.trend` — the ONE definition of "improving" in this codebase.
// Colour only; the word is the server's.
const TREND_TONE = { improving: 'good', worsening: 'bad', flat: 'flat', unknown: 'flat' };

// Lifecycle buttons. Explicit DARK text on a white surface — never an `--ink*` token, which is a
// LIGHT paper colour in this palette and renders white on white. `btnOff` is the same control with
// its unavailability shown rather than the control hidden: a person must be able to see that "Take
// live" exists and that the bar is not met, which a missing button cannot say.
const btnQuiet = {
  border: `1px solid ${GOLD}66`, background: '#fff', color: INK,
  borderRadius: 8, padding: '6px 12px', fontSize: 13, fontWeight: 550, cursor: 'pointer',
};
const btnOff = { ...btnQuiet, color: MUTED, borderColor: 'rgba(20,27,34,.14)', cursor: 'not-allowed' };

function Figure({ label, value, hint }) {
  return (
    <div style={{ minWidth: 128 }}>
      <div style={eyebrow}>{label}</div>
      <div style={{ fontSize: 22, color: INK, fontWeight: 600, fontVariantNumeric: 'tabular-nums' }}>{value}</div>
      {hint && <div style={{ fontSize: 12, color: MUTED, marginTop: 2 }}>{hint}</div>}
    </div>
  );
}

/**
 * WHERE THE REST OF THE RUN WENT (§2.79).
 *
 * "Compared 196" beside a 300-scenario battery is a true number a person cannot reconcile, and the only
 * remedy it suggests — run more scenarios — is the one that cannot help. Every scenario lands in exactly
 * one bucket, so every bucket is shown and the line adds up out loud.
 *
 * It renders NOTHING when the run did not record its split (an older persisted run), rather than
 * printing zeros that would claim a partition nobody measured.
 */
function CoverageSplit({ sb }) {
  const n = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
  const total = n(sb.canaryScenarios);
  const compared = n(sb.canaryScenarioCount);
  if (total == null || compared == null) return null;
  const parts = [`${compared} compared`];
  const add = (v, word) => { const x = n(v); if (x) parts.push(`${x} ${word}`); };
  add(sb.canaryOverlay, 'reasoned overrides (not scored against Lender Price)');
  add(sb.canaryErrors, 'hit an engine error');
  add(sb.canaryIncomparable, 'could not be compared');
  const off = n(sb.canaryUnaccounted);
  return (
    <div style={{ fontSize: 12, color: SLATE, marginBottom: 10 }}>
      {`The last run priced ${total} scenario(s): ${parts.join(', ')}.`}
      {!!off && (
        <span style={{ color: INK, fontWeight: 600 }}>
          {` ${Math.abs(off)} scenario(s) are in no bucket — this run's own tally does not add up, so it is not proof of anything.`}
        </span>
      )}
    </div>
  );
}

export default function LtPpe() {
  const [health, setHealth] = useState(null);
  const [investors, setInvestors] = useState(null);
  const [queue, setQueue] = useState(null);
  const [board, setBoard] = useState(null);
  const [life, setLife] = useState(null);
  const [investor, setInvestor] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    ltApi.ppeHealth().then(setHealth).catch((e) => setNote(e.message || 'Could not read the pricing engine.'));
    ltApi.ppeInvestors().then(setInvestors).catch(() => setInvestors(null));
  }, []);
  useEffect(load, [load]);

  const loadQueue = useCallback(() => {
    ltApi.ppeFindings(investor ? { investor } : {})
      .then(setQueue)
      .catch((e) => setNote(e.message || 'Could not read the findings.'));
    if (investor) {
      ltApi.ppeScoreboard(investor).then(setBoard).catch(() => setBoard(null));
      // The lifecycle is admin-gated on the server, so a plain viewer gets a 403 here and simply sees
      // no lifecycle card — which is right: they cannot act on it either.
      ltApi.ppeCutover(investor).then(setLife).catch(() => setLife(null));
    } else {
      setBoard(null);
      setLife(null);
    }
  }, [investor]);
  useEffect(loadQueue, [loadQueue]);

  // Per-row state: which finding is being settled, the reason typed for it, and
  // any refusal the server gave for THAT row. Keyed by finding key so two rows can
  // never share a half-typed reason.
  const [settling, setSettling] = useState(null);
  const [reason, setReason] = useState('');
  const [rowError, setRowError] = useState({});

  const openSettle = (item) => {
    setSettling(settling === item.key ? null : item.key);
    setReason('');
    setRowError((e) => ({ ...e, [item.key]: null }));
  };

  const decide = async (item, status) => {
    setBusy(true);
    setRowError((e) => ({ ...e, [item.key]: null }));
    try {
      await ltApi.ppeDecideFinding(item.key, { status, reason });
      setSettling(null);
      setReason('');
      loadQueue();
    } catch (e) {
      // The server refuses a non-admin AND a too-short reason, and its wording
      // names WHICH rule was broken. A generic "that didn't work" would not, and
      // the person could not tell "you may not do this" from "say more".
      setRowError((prev) => ({ ...prev, [item.key]: e.message || 'That decision was refused.' }));
    } finally { setBusy(false); }
  };

  // ---- the cutover lifecycle (§11 / P10) -------------------------------------------------------
  //
  // A promotion changes which engine answers a real borrower, so this is the most consequential
  // control on the screen and it is written to behave like one. THREE rules it keeps:
  //
  //   · The REASON is typed inline, beside the action, not in a dialog. Long-Term may not import
  //     RTL's shared dialog helper (the product-separation gate refuses it, correctly), and the
  //     reason for taking an investor live is worth typing while looking at the gate that allowed it.
  //     Same pattern as settling a finding above.
  //   · It never hides a control a person may not use. Deciding is super-admin-only on the SERVER;
  //     a plain admin sees the buttons and is told, in the server's own words, why they were refused.
  //   · PROMOTE is only offered when the gate says yes, and the gate's verdict comes from the server.
  //     There is no override here because there is none there — the go-live bar is a measurement, and
  //     a button that could wave it through would make every number above it decorative.
  const [lifeAction, setLifeAction] = useState(null);
  const [lifeReason, setLifeReason] = useState('');
  const [lifeError, setLifeError] = useState('');

  const openLifeAction = (action) => {
    setLifeAction(lifeAction === action ? null : action);
    setLifeReason('');
    setLifeError('');
  };

  const decideLifecycle = async (action) => {
    setBusy(true);
    setLifeError('');
    try {
      await ltApi.ppeCutoverDecide({ investor, action, reason: lifeReason });
      setLifeAction(null);
      setLifeReason('');
      loadQueue();
    } catch (e) {
      // The server refuses a non-super-admin, a short reason, an illegal move and an unmet gate, and
      // its wording names WHICH of those it was. A generic failure would leave a person unable to
      // tell "you may not" from "not yet" from "say more".
      setLifeError(e.message || 'That decision was refused.');
    } finally { setBusy(false); }
  };

  // ---- the suggested-rule loop (P5 → P7) --------------------------------------------------------
  // Deliberately NOT filtered by the investor picker above: that picker carries OUR investor code
  // while a suggestion carries Lender Price's verbatim name for the same investor, and the two are
  // different strings. Filtering on the code would return an empty list that reads exactly like
  // "nothing to do" — so every open suggestion is listed and each row names its own investor.
  const [suggestions, setSuggestions] = useState(null);
  const [sugError, setSugError] = useState('');
  const [deciding, setDeciding] = useState(null);
  const [sugNote, setSugNote] = useState('');
  const [sugRowError, setSugRowError] = useState({});

  const loadSuggestions = useCallback(() => {
    ltApi.ppeSuggestions({ status: 'open' })
      .then((r) => { setSuggestions(r); setSugError(''); })
      // A read failure is SAID. Falling back to an empty list would render as "nothing is waiting",
      // which is the one thing it must never be mistaken for.
      .catch((e) => { setSuggestions(null); setSugError(e.message || 'Could not read the suggested rules.'); });
  }, []);
  useEffect(loadSuggestions, [loadSuggestions]);

  const openDecide = (s) => {
    setDeciding(deciding === s.id ? null : s.id);
    setSugNote('');
    setSugRowError((e) => ({ ...e, [s.id]: null }));
  };

  const decideSuggestion = async (s, action) => {
    setBusy(true);
    setSugRowError((e) => ({ ...e, [s.id]: null }));
    try {
      if (action === 'accept') await ltApi.ppeAcceptSuggestion(s.id, { note: sugNote });
      else await ltApi.ppeDismissSuggestion(s.id, { note: sugNote });
      setDeciding(null);
      setSugNote('');
      loadSuggestions();
      // An accepted suggestion becomes a rule our engine enforces, so the differences it explains can
      // change. Re-read the queue rather than leaving a stale picture beside a fresh decision.
      loadQueue();
    } catch (e) {
      // The server refuses a non-admin AND an unmappable suggestion, with different wording for each.
      // Showing its own message is what tells the person which of the two happened.
      setSugRowError((prev) => ({ ...prev, [s.id]: e.message || 'That decision was refused.' }));
    } finally { setBusy(false); }
  };

  // ---- which Lender Price programs each of our sheets is measured against (db/574) ---------------
  // The scope decides what our engine is compared TO. Without one the comparison abstains — on
  // purpose, because Lender Price answers with every program it sells and ours prices one — and an
  // abstention looks exactly like agreement on the list above. So this card leads with what is
  // UNSCOPED, and the write shows the pattern's own preview before it is trusted.
  const [programs, setPrograms] = useState(null);
  const [programsError, setProgramsError] = useState('');
  const [scoping, setScoping] = useState(null);
  const [scopeLike, setScopeLike] = useState('');
  const [scopeExact, setScopeExact] = useState('');
  const [scopeNames, setScopeNames] = useState('');
  const [scopeResult, setScopeResult] = useState(null);
  const [scopeRowError, setScopeRowError] = useState({});

  const loadPrograms = useCallback(() => {
    ltApi.ppePrograms()
      .then((r) => { setPrograms(r); setProgramsError(''); })
      // Said, never swallowed: an empty list here would read as "there is nothing to scope", which is
      // the same picture a fully-scoped book shows.
      .catch((e) => { setPrograms(null); setProgramsError(e.message || 'Could not read the programs.'); });
  }, []);
  useEffect(loadPrograms, [loadPrograms]);

  const openScope = (p) => {
    if (scoping === p.id) { setScoping(null); return; }
    setScoping(p.id);
    setScopeLike((p.lpScope && p.lpScope.programLike) || '');
    setScopeExact((p.lpScope && p.lpScope.program) || '');
    setScopeNames('');
    setScopeResult(null);
    setScopeRowError((e) => ({ ...e, [p.id]: null }));
  };

  const saveScope = async (p, clear) => {
    setBusy(true);
    setScopeRowError((e) => ({ ...e, [p.id]: null }));
    try {
      // The names are pasted from a capture, one per line. They are sent so the SERVER can say which
      // ones this scope actually selects — the silent failure of a scope is a pattern one character
      // wrong, which matches nothing and abstains politely forever.
      const lpProgramNames = scopeNames.split('\n').map((s) => s.trim()).filter(Boolean);
      const scope = clear ? null : {
        programLike: scopeLike.trim() || undefined,
        program: scopeExact.trim() || undefined,
      };
      const r = await ltApi.ppeSetProgramLpScope(p.id, { scope, lpProgramNames });
      setScopeResult({ id: p.id, ...r });
      if (clear) setScoping(null);
      loadPrograms();
    } catch (e) {
      // The server refuses a non-admin, a pattern it will not run (a repeated group that itself
      // repeats), and a body with no `scope` key at all — each with its own wording, which is what
      // tells the person which of the three happened.
      setScopeRowError((prev) => ({ ...prev, [p.id]: e.message || 'That scope was refused.' }));
    } finally { setBusy(false); }
  };

  // ---- WHERE the two engines disagree, run after run (P9) ---------------------------------------
  // The scoreboard below carries ONE agreement rate per day; this is the same measurement per band,
  // which is what turns "we disagree" into "we disagree HERE, and have for three weeks".
  //
  // The series is keyed EXACTLY on (investor, program) as the canary recorded it, so this screen must
  // never invent a key: asking for one nobody wrote returns an empty list, and an empty list drawn as
  // "nothing has been measured" beside a table full of measurements is the one lie a parity screen
  // must not tell. So the picker is built from the server's OWN list of series that hold rows.
  const [parityDays, setParityDays] = useState(30);
  const [paritySel, setParitySel] = useState(''); // JSON ["investor","program"], '' = the no-investor series
  const [parity, setParity] = useState(null);
  const [parityError, setParityError] = useState('');
  const [openCell, setOpenCell] = useState(null);
  const [cellHist, setCellHist] = useState(null);
  const [cellHistError, setCellHistError] = useState('');

  const parityKey = (inv, prog) => JSON.stringify([inv || '', prog || '']);
  const parityFilter = useCallback(() => {
    if (!paritySel) return { investor: '', program: '' };
    try {
      const [inv, prog] = JSON.parse(paritySel);
      return { investor: inv || '', program: prog || '' };
    } catch (_) { return { investor: '', program: '' }; }
  }, [paritySel]);

  const loadParity = useCallback(() => {
    const f = parityFilter();
    ltApi.ppeParityCells({ days: parityDays, investor: f.investor, program: f.program })
      .then((r) => { setParity(r); setParityError(''); })
      // A read failure is SAID. Falling back to an empty list would render as "the engines have never
      // disagreed", which is the most reassuring possible way to show a broken query.
      .catch((e) => { setParity(null); setParityError(e.message || 'Could not read the parity measurements.'); });
    setOpenCell(null);
    setCellHist(null);
    setCellHistError('');
  }, [parityDays, parityFilter]);
  useEffect(loadParity, [loadParity]);

  const openCellHistory = (row) => {
    const key = `${row.dimension}|${row.cellKey}`;
    if (openCell === key) { setOpenCell(null); setCellHist(null); setCellHistError(''); return; }
    setOpenCell(key);
    setCellHist(null);
    setCellHistError('');
    const f = parityFilter();
    ltApi.ppeParityCells({
      days: parityDays, investor: f.investor, program: f.program,
      dimension: row.dimension, cellKey: row.cellKey,
    })
      .then((r) => setCellHist(r && r.history ? r.history : null))
      .catch((e) => setCellHistError(e.message || 'Could not read that cell\'s history.'));
  };

  const openSuggestions = (suggestions && Array.isArray(suggestions.suggestions) ? suggestions.suggestions : []);
  const parityRows = (parity && Array.isArray(parity.persistentlyWorst) ? parity.persistentlyWorst : []);
  const paritySeries = (parity && Array.isArray(parity.series) ? parity.series : []);
  // A series the picker is NOT currently on, that does hold rows. This is what stops an empty view
  // being read as "nothing measured" — it names where the measurements actually are.
  const otherSeries = paritySeries.filter((s) => parityKey(s.investor, s.program) !== (paritySel || parityKey('', '')));

  const items = (queue && queue.items) || [];

  return (
    <LtLayout title="Pricing engine">
      {note && (
        <div style={{ ...card, borderColor: 'rgba(158,58,58,.32)', color: '#8A2F2F' }}>{note}</div>
      )}

      {/* ---- what the engine IS right now ---- */}
      <div style={card}>
        <h2 style={h2}>Where the engine stands</h2>
        <p style={sub}>
          Lender Price answers every quote. Our engine prices the same deal beside it and we work the
          differences — it does not decide anything for a borrower or an officer.
        </p>
        <div style={{ display: 'flex', gap: 28, flexWrap: 'wrap', alignItems: 'flex-start' }}>
          <Figure
            label="Answering"
            value={health ? (health.authoritative === 'lp' ? 'Lender Price' : String(health.authoritative)) : '—'}
            hint="ours runs alongside"
          />
          <Figure
            label="Investors set up"
            value={health && typeof health.investors === 'number' ? health.investors : '—'}
            hint={health && health.configured === null ? 'could not read the database' : undefined}
          />
          <Figure label="Open differences" value={queue ? queue.total : '—'} hint="across every investor" />
        </div>
        {health && health.configured === false && (
          <p style={{ ...sub, marginTop: 12, marginBottom: 0 }}>
            No investors are configured yet, so there is nothing for our engine to price against. That is
            a setup step, not a fault.
          </p>
        )}
        {health && health.configured === null && (
          <p style={{ ...sub, marginTop: 12, marginBottom: 0, color: '#8A2F2F' }}>
            The engine could not read its own tables, so this page cannot say whether anything is set up.
            ({health.dbError})
          </p>
        )}
      </div>

      {/* ---- the review queue ---- */}
      <div style={card}>
        <div style={{ display: 'flex', gap: 12, alignItems: 'baseline', flexWrap: 'wrap' }}>
          <div style={{ flex: 1, minWidth: 220 }}>
            <h2 style={h2}>Differences to work</h2>
            <p style={sub}>
              Where our engine and Lender Price disagreed, hardest first. The order comes from the server —
              this page never re-sorts it, so what you see is what the engine says matters most.
            </p>
          </div>
          {investors && investors.investors && investors.investors.length > 0 && (
            <select
              className="input"
              style={{ maxWidth: 220 }}
              value={investor}
              onChange={(e) => setInvestor(e.target.value)}
            >
              <option value="">Every investor</option>
              {investors.investors.map((i) => (
                <option key={i.id} value={i.code}>{i.name || i.code}</option>
              ))}
            </select>
          )}
        </div>

        {/*
          AN EMPTY LIST IS NOT A CLEAN ONE, and this board cannot tell the two apart on its own.
          Findings are written by exactly two producers — a canary battery, and the shadow
          comparison on the pricing-transparency screen — so "nothing is waiting" means either
          "everything measured agreed" or "nothing has been measured", and until this page is
          told which it must say both. The scoreboard answers it for ONE investor and only
          renders once an investor is chosen, so it cannot be the whole answer here.
        */}
        {queue && items.length === 0 && (
          <p style={{ ...sub, marginBottom: 0 }}>
            Nothing is waiting — and that is two different things this list cannot tell apart. Either the two
            engines agreed on everything measured so far, or nothing has been measured yet. Differences only
            arrive here when somebody runs a comparison: pick an investor above to see whether that one has
            ever been measured, or run one deal against Lender Price on the pricing-transparency screen.
          </p>
        )}

        {items.map((it) => (
          <div key={it.key} style={{
            borderTop: '1px solid rgba(20,27,34,.10)', padding: '12px 0',
            display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'flex-start',
          }}>
            <div style={{ flex: 1, minWidth: 240 }}>
              <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', marginBottom: 4 }}>
                <Pill tone={SEV_TONE[it.severity] || 'flat'}>{it.severity}</Pill>
                <span style={{ fontSize: 13, color: INK, fontWeight: 600 }}>{it.kind}</span>
                {it.regressed && <Pill tone="bad">came back</Pill>}
                {it.recurrence > 1 && <Pill tone="flat">seen {it.recurrence}×</Pill>}
              </div>
              <div style={{ fontSize: 13, color: SLATE, wordBreak: 'break-word' }}>{it.scenario}</div>
              {it.investor && <div style={{ fontSize: 12, color: MUTED, marginTop: 2 }}>{it.investor}</div>}
              {/* WHY it disagreed, diagnosed when the comparison was made and stored on the row. It is
                  a HYPOTHESIS ranked by numeric proximity — Lender Price publishes no breakdown of its
                  own — so the confidence is shown beside it rather than folded into the sentence, and a
                  row recorded before this was wired simply has none. */}
              {it.diff && it.diff.explanation && it.diff.explanation.summary && (
                <div style={{ fontSize: 12, color: SLATE, marginTop: 4 }}>
                  {it.diff.explanation.summary}
                  {it.diff.explanation.confidence && it.diff.explanation.confidence !== 'none' && (
                    <span style={{ color: MUTED }}> ({it.diff.explanation.confidence} match — a place to look, not a verdict)</span>
                  )}
                </div>
              )}
            </div>
            <div style={{ display: 'flex', gap: 8, alignItems: 'flex-start' }}>
              <button className="btn ghost" disabled={busy} onClick={() => openSettle(it)}>
                {settling === it.key ? 'Cancel' : 'Settle'}
              </button>
            </div>

            {settling === it.key && (
              <div style={{ flexBasis: '100%', marginTop: 8 }}>
                <label style={{ ...eyebrow, display: 'block', marginBottom: 4 }}>Why</label>
                <textarea
                  className="input"
                  rows={2}
                  style={{ width: '100%', marginBottom: 8 }}
                  placeholder="A settled difference is never re-opened, so this note is the record of why."
                  value={reason}
                  onChange={(e) => setReason(e.target.value)}
                />
                <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                  <button className="btn" disabled={busy} onClick={() => decide(it, 'fixed')}>Fixed</button>
                  <button className="btn ghost" disabled={busy} onClick={() => decide(it, 'wontfix')}>Won't fix</button>
                </div>
                {rowError[it.key] && (
                  <div style={{ marginTop: 8, fontSize: 13, color: '#8A2F2F' }}>{rowError[it.key]}</div>
                )}
              </div>
            )}
          </div>
        ))}

        {queue && queue.truncated && (
          <p style={{ ...sub, marginTop: 12, marginBottom: 0 }}>
            Showing {queue.returned} of {queue.total}. The rest are further down the same order.
          </p>
        )}
      </div>

      {/* ---- the rules Lender Price's own refusals suggest (P5 → P7) ---- */}
      <div style={card}>
        <h2 style={h2}>Rules Lender Price's refusals suggest</h2>
        <p style={sub}>
          When Lender Price turns a loan down for a reason our engine does not carry, that refusal is
          written down here as a SUGGESTION. Nothing is applied on its own — you accept one and it becomes
          a real rule for that investor, so our engine turns down exactly what they turn down.
        </p>

        {sugError && <p style={{ ...sub, color: '#8A2F2F' }}>{sugError}</p>}

        {suggestions && openSuggestions.length === 0 && !sugError && (
          <p style={{ ...sub, marginBottom: 0 }}>
            Nothing is waiting. Either every refusal Lender Price has shown us is already a rule, or no
            refusals have been read yet.
          </p>
        )}

        {openSuggestions.map((s) => (
          <div key={s.id} style={{
            borderTop: '1px solid rgba(20,27,34,.10)', padding: '12px 0',
            display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'flex-start',
          }}>
            <div style={{ flex: 1, minWidth: 240 }}>
              <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', marginBottom: 4 }}>
                {/* A suggestion nobody could map is the one that must NOT look ready to accept: the
                    server refuses it, so the row says why before the button is pressed. */}
                {s.needs_human
                  ? <Pill tone="warn">needs a person to map it</Pill>
                  : <Pill tone={s.confidence === 'strong' ? 'good' : 'flat'}>{s.confidence || 'suggested'}</Pill>}
                {s.occurrences > 1 && <Pill tone="flat">seen {s.occurrences}×</Pill>}
                {s.fact && <Pill tone="flat">{s.fact}</Pill>}
              </div>
              {/* The investor's VERBATIM label, shown on every row rather than filtered on. The picker
                  above carries our investor CODE while a suggestion carries Lender Price's own name for
                  the investor, and the two are not the same string — filtering by the code would quietly
                  return an empty list, which is indistinguishable from "nothing to do". */}
              <div style={{ fontSize: 12, color: MUTED, marginBottom: 2 }}>{s.investor_label}</div>
              {/* Lender Price's own words, never paraphrased — this is what the rule will carry as its
                  decline reason, so the person accepting it should read exactly that. */}
              <div style={{ fontSize: 13, color: INK, wordBreak: 'break-word' }}>“{s.decline_reason}”</div>
              {s.needs_human && (
                <div style={{ fontSize: 12, color: MUTED, marginTop: 4 }}>
                  We could not turn that sentence into a rule automatically, and a guess here would refuse
                  real loans. It is kept so a person can map it, never applied.
                </div>
              )}
            </div>
            <div style={{ display: 'flex', gap: 8, alignItems: 'flex-start' }}>
              <button className="btn ghost" disabled={busy} onClick={() => openDecide(s)}>
                {deciding === s.id ? 'Cancel' : 'Decide'}
              </button>
            </div>

            {deciding === s.id && (
              <div style={{ flexBasis: '100%', marginTop: 8 }}>
                <label style={{ ...eyebrow, display: 'block', marginBottom: 4 }}>Why</label>
                <textarea
                  className="input"
                  rows={2}
                  style={{ width: '100%', marginBottom: 8 }}
                  placeholder="Accepting writes a real rule for this investor. This note is the record of the decision."
                  value={sugNote}
                  onChange={(e) => setSugNote(e.target.value)}
                />
                <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                  {/* The button is shown even when the server will refuse it — a hidden control is
                      indistinguishable from a broken one, and the refusal below says which rule was
                      broken (not an admin, or a reason nobody has mapped yet). */}
                  <button className="btn" disabled={busy} onClick={() => decideSuggestion(s, 'accept')}>
                    Accept — make it a rule
                  </button>
                  <button className="btn ghost" disabled={busy} onClick={() => decideSuggestion(s, 'dismiss')}>
                    Dismiss
                  </button>
                </div>
                {sugRowError[s.id] && (
                  <div style={{ marginTop: 8, fontSize: 13, color: '#8A2F2F' }}>{sugRowError[s.id]}</div>
                )}
              </div>
            )}
          </div>
        ))}
      </div>

      {/* ---- onboard an investor and load its rate sheet ---- */}
      <RateSheetConsole />

      {/* ---- THE CANARY: the only thing that writes the two lists above ----
          Both the differences queue and the per-band series are READS of a ledger a canary run
          writes, and the run route had no caller in the product at all — so an empty queue meant
          "nobody has run a curl", which on this page is indistinguishable from "the two engines
          agree". The investors already read above are passed down rather than fetched a second
          time; one screen asking the same route twice is how two halves of a page come to disagree
          about which investors exist. */}
      <CanaryConsole investors={(investors && investors.investors) || []} />

      {/* ---- the rules our engine enforces, and a place to draft one ----
          Five routes and a whole authoring service were reachable by nothing a person can press until
          this board existed. It is mounted UNCONDITIONALLY: a guarded mount renders nothing and they
          all go back to being unreachable. */}
      <RuleBoard />

      {/* ---- what each sheet is compared AGAINST (db/574) ---- */}
      <div style={card}>
        <h2 style={h2}>What each rate sheet is compared against</h2>
        <p style={sub}>
          Lender Price answers one request with every program it sells; our engine prices one. Until a
          sheet says which of their programs it belongs beside, the comparison stands down rather than
          measure ours against a family it was never built for — and a comparison that stood down looks
          exactly like two engines agreeing. This is where that is set, and where you can see what a
          pattern actually picks before trusting it.
        </p>

        {programsError && <p style={{ ...sub, color: '#8A2F2F' }}>{programsError}</p>}
        {programs && programs.note && <p style={{ ...sub, color: '#7A5C25' }}>{programs.note}</p>}
        {programs && programs.programs.length === 0 && !programsError && (
          <p style={{ ...sub, marginBottom: 0 }}>No programs are set up yet, so there is nothing to compare.</p>
        )}

        {programs && programs.programs.map((p) => (
          <div key={p.id} style={{ borderTop: '1px solid rgba(20,27,34,.10)', padding: '12px 0' }}>
            <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'flex-start' }}>
              <div style={{ flex: 1, minWidth: 240 }}>
                <div style={eyebrow}>{p.investorName || p.investorCode || 'no investor'}</div>
                <div style={{ fontSize: 14, color: INK, fontWeight: 600 }}>{p.name || p.code || p.id}</div>
                <div style={{ marginTop: 6 }}>
                  {p.lpScope
                    ? <Pill tone="good">{p.describe}</Pill>
                    : <Pill tone="warn">not scoped — its comparison stands down</Pill>}
                </div>
              </div>
              <button className="btn ghost" disabled={busy} onClick={() => openScope(p)}>
                {scoping === p.id ? 'Cancel' : (p.lpScope ? 'Change' : 'Set')}
              </button>
            </div>

            {scoping === p.id && (
              <div style={{ marginTop: 10 }}>
                <label style={{ ...eyebrow, display: 'block', marginBottom: 4 }}>Family pattern</label>
                <input
                  className="input"
                  style={{ width: '100%', marginBottom: 8 }}
                  placeholder="^dscr — matches every program whose name starts that way"
                  value={scopeLike}
                  onChange={(e) => setScopeLike(e.target.value)}
                />
                <label style={{ ...eyebrow, display: 'block', marginBottom: 4 }}>Or one exact program name</label>
                <input
                  className="input"
                  style={{ width: '100%', marginBottom: 8 }}
                  placeholder="Leave blank unless it really is a single named program"
                  value={scopeExact}
                  onChange={(e) => setScopeExact(e.target.value)}
                />
                <label style={{ ...eyebrow, display: 'block', marginBottom: 4 }}>
                  Program names from a capture, one per line (optional)
                </label>
                <textarea
                  className="input"
                  rows={3}
                  style={{ width: '100%', marginBottom: 8 }}
                  placeholder="Paste the program names Lender Price returned. Saving then says which of them this scope picks — a pattern one character wrong picks nothing and says nothing."
                  value={scopeNames}
                  onChange={(e) => setScopeNames(e.target.value)}
                />
                <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                  <button className="btn" disabled={busy} onClick={() => saveScope(p, false)}>Save the scope</button>
                  {p.lpScope && (
                    <button className="btn ghost" disabled={busy} onClick={() => saveScope(p, true)}>
                      Clear it — stand the comparison down
                    </button>
                  )}
                </div>
                {scopeRowError[p.id] && (
                  <div style={{ marginTop: 8, fontSize: 13, color: '#8A2F2F' }}>{scopeRowError[p.id]}</div>
                )}
                {scopeResult && scopeResult.id === p.id && (
                  <div style={{ marginTop: 10, fontSize: 13, color: SLATE }}>
                    <div style={{ marginBottom: 4 }}>Saved: {scopeResult.describe}</div>
                    {/* THE POINT OF THE PREVIEW: a scope that picks nothing is the silent failure this
                        whole card exists to prevent, so zero matches is called out rather than shown
                        as an empty list. */}
                    {scopeResult.preview && (
                      scopeResult.preview.matched.length === 0
                        ? (
                          <div style={{ color: '#8A2F2F' }}>
                            This scope picks NONE of the {scopeResult.preview.matched.length + scopeResult.preview.unmatched.length} names
                            you pasted, so the comparison will still stand down. Check the pattern.
                          </div>
                        )
                        : (
                          <div>
                            Picks {scopeResult.preview.matched.length} of{' '}
                            {scopeResult.preview.matched.length + scopeResult.preview.unmatched.length}:{' '}
                            {scopeResult.preview.matched.join(', ')}
                          </div>
                        )
                    )}
                  </div>
                )}
              </div>
            )}
          </div>
        ))}
      </div>

      {/* ---- WHERE it disagrees, run after run (P9) ---- */}
      <div style={card}>
        <div style={{ display: 'flex', gap: 12, alignItems: 'baseline', flexWrap: 'wrap' }}>
          <div style={{ flex: 1, minWidth: 240 }}>
            <h2 style={h2}>Where it disagrees</h2>
            <p style={sub}>
              One agreement rate says the two engines disagree and never where — so one bad credit band
              and a rate sheet that is wrong everywhere read exactly the same. This is the same
              measurement per band, kept run after run, so a band that has been off for three weeks
              looks different from one bad afternoon. It ranks; it sets no pass mark.
            </p>
          </div>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <select
              className="input"
              style={{ maxWidth: 260 }}
              value={paritySel}
              onChange={(e) => setParitySel(e.target.value)}
            >
              {/* The default is the series a canary run with no investor writes into — named for what
                  it is, never as "everything", because the read matches one series exactly. */}
              <option value="">Runs recorded against no investor</option>
              {paritySeries.filter((s) => s.investor || s.program).map((s) => (
                <option key={parityKey(s.investor, s.program)} value={parityKey(s.investor, s.program)}>
                  {s.investor || 'no investor'}{s.program ? ` · ${s.program}` : ''} — {s.days} day{s.days === 1 ? '' : 's'} measured
                </option>
              ))}
            </select>
            <select
              className="input"
              style={{ maxWidth: 150 }}
              value={String(parityDays)}
              onChange={(e) => setParityDays(Number(e.target.value))}
            >
              <option value="7">Last 7 days</option>
              <option value="30">Last 30 days</option>
              <option value="90">Last 90 days</option>
            </select>
          </div>
        </div>

        {parityError && <p style={{ ...sub, color: '#8A2F2F' }}>{parityError}</p>}

        {parity && parityRows.length === 0 && !parityError && (
          <>
            {/* The server's own wording for an empty window: this series starts at the first canary
                run after it was built, and nothing before it can be recovered. */}
            <p style={{ ...sub, marginBottom: otherSeries.length ? 8 : 0 }}>
              {parity.note || 'Nothing to show for this series in this window.'}
            </p>
            {otherSeries.length > 0 && (
              <p style={{ ...sub, marginBottom: 0 }}>
                Measurements do exist elsewhere — {otherSeries.map((s, i) => (
                  <span key={parityKey(s.investor, s.program)}>
                    {i > 0 ? ', ' : ''}
                    <button
                      className="btn ghost"
                      style={{ padding: '1px 8px', fontSize: 12 }}
                      onClick={() => setParitySel(parityKey(s.investor, s.program))}
                    >
                      {s.investor || 'no investor'}{s.program ? ` · ${s.program}` : ''} ({s.days}d)
                    </button>
                  </span>
                ))}. This view is one series at a time, so an empty list here is not an empty table.
              </p>
            )}
          </>
        )}

        {parity && parityRows.length > 0 && (
          <p style={{ ...sub }}>
            {parity.measurements} measurement{parity.measurements === 1 ? '' : 's'} in the last{' '}
            {parity.windowDays} days. Ordered by how many days a band was seen disagreeing — not by how
            bad the worst day was, because a band that is off every day is the one worth a morning.
          </p>
        )}

        {parityRows.map((row) => {
          const key = `${row.dimension}|${row.cellKey}`;
          return (
            <div key={key} style={{ borderTop: '1px solid rgba(20,27,34,.10)', padding: '12px 0' }}>
              <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'flex-start' }}>
                <div style={{ flex: 1, minWidth: 220 }}>
                  <div style={eyebrow}>{row.dimension}</div>
                  <div style={{ fontSize: 14, color: INK, fontWeight: 600 }}>{row.cellLabel || row.cellKey}</div>
                  <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 6 }}>
                    <Pill tone={row.daysWithDisagreement > 0 ? 'warn' : 'good'}>
                      disagreed on {row.daysWithDisagreement} of {row.daysMeasured} measured day{row.daysMeasured === 1 ? '' : 's'}
                    </Pill>
                    {row.trend && <Pill tone={TREND_TONE[row.trend.direction] || 'flat'}>{row.trend.direction}</Pill>}
                  </div>
                </div>
                <div style={{ display: 'flex', gap: 24, flexWrap: 'wrap' }}>
                  <Figure
                    label="Latest agreement"
                    value={rate(row.latestAgreementRate)}
                    hint={row.latestAgreementRate == null ? 'no rate measured' : undefined}
                  />
                  <Figure label="Worst gap" value={points(row.worstAbsMilli)} hint="absolute, any direction" />
                  {/* Measured-vs-asked is the honest half: a band measured on two of thirty days has a
                      direction computed from two points, and showing it beside one measured on all
                      thirty as though they weigh the same is how a dashboard talks somebody into a
                      cutover. The gap is never filled in — a day with no loans in a band is an absence
                      of evidence about that band, not a zero. */}
                  <Figure
                    label="Days measured"
                    value={`${row.daysMeasured}${row.windowDays ? ` of ${row.windowDays}` : ''}`}
                    hint={row.windowDays && row.daysMeasured < row.windowDays ? 'the rest were not measured' : undefined}
                  />
                </div>
                <button className="btn ghost" onClick={() => openCellHistory(row)}>
                  {openCell === key ? 'Hide' : 'Day by day'}
                </button>
              </div>

              {openCell === key && (
                <div style={{ marginTop: 10 }}>
                  {cellHistError && <div style={{ fontSize: 13, color: '#8A2F2F' }}>{cellHistError}</div>}
                  {!cellHistError && !cellHist && <div style={{ fontSize: 13, color: MUTED }}>Reading…</div>}
                  {cellHist && (
                    <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                      {/* Only the days this band was actually measured on appear. There is deliberately
                          no row for a day in between: it would have to be drawn as something, and
                          anything drawn is a measurement nobody made. */}
                      {(cellHist.days || []).map((d) => (
                        <div key={d.dayMs} style={{
                          border: '1px solid rgba(20,27,34,.12)', borderRadius: 8, padding: '6px 10px',
                          background: PAPER, minWidth: 96,
                        }}>
                          <div style={{ fontSize: 11, color: MUTED }}>{day(d.dayMs)}</div>
                          <div style={{ fontSize: 14, color: INK, fontWeight: 600, fontVariantNumeric: 'tabular-nums' }}>
                            {rate(d.agreementRate)}
                          </div>
                        </div>
                      ))}
                      {(cellHist.days || []).length === 0 && (
                        <div style={{ fontSize: 13, color: MUTED }}>No measured days in this window.</div>
                      )}
                    </div>
                  )}
                </div>
              )}
            </div>
          );
        })}

        {parity && parity.seriesTruncated && (
          <p style={{ ...sub, marginTop: 12, marginBottom: 0 }}>
            More series exist than this list shows, so one may be missing from the picker above.
          </p>
        )}
      </div>

      {/* ---- the go-live picture ---- */}
      {investor && (
        <div style={card}>
          <h2 style={h2}>Could this investor go live?</h2>
          <p style={sub}>
            "Live" means our engine gives the answer for this investor instead of Lender Price. Lender
            Price is still called on every quote alongside it, so a live investor keeps being measured.
            Nobody is promoted automatically — this is the picture a person decides on.
          </p>
          {board && board.scoreboard ? (
            <>
              <div style={{ display: 'flex', gap: 28, flexWrap: 'wrap', marginBottom: 12 }}>
                <Figure label="Agreement" value={rate(board.scoreboard.canaryAgreementRate)}
                  hint={board.scoreboard.canaryAgreementRate == null ? 'not measured yet' : undefined} />
                <Figure label="Still open" value={board.scoreboard.openFindings} />
                <Figure label="Oldest open" value={board.scoreboard.oldestOpenFindingDays == null ? '—' : `${board.scoreboard.oldestOpenFindingDays}d`} />
                <Figure label="Clean days" value={board.scoreboard.consecutiveCleanDays} hint="in a row" />
                <Figure
                  label="Compared"
                  value={board.scoreboard.canaryScenarioCount == null ? '—' : board.scoreboard.canaryScenarioCount}
                  hint={board.scoreboard.canaryScenarios == null ? 'in the last run' : `of ${board.scoreboard.canaryScenarios} in the last run`}
                />
              </div>
              <CoverageSplit sb={board.scoreboard} />
              <div style={{ marginBottom: 8 }}>
                {board.gate && board.gate.eligible
                  ? <Pill tone="good">Meets the bar</Pill>
                  : <Pill tone="warn">Not yet</Pill>}
              </div>
              {board.gate && Array.isArray(board.gate.reasons) && board.gate.reasons.length > 0 && (
                <ul style={{ margin: '0 0 8px', paddingLeft: 18, fontSize: 13, color: SLATE }}>
                  {board.gate.reasons.map((r, n) => <li key={n}>{String(r)}</li>)}
                </ul>
              )}
              {board.note && <p style={{ ...sub, marginBottom: 0 }}>{board.note}</p>}
            </>
          ) : (
            <p style={{ ...sub, marginBottom: 0 }}>Nothing recorded for this investor yet.</p>
          )}

          {/* ---- the lifecycle itself: where this investor is, and how it moves ---- */}
          {life && (
            <div style={{ borderTop: `1px solid ${GOLD}33`, marginTop: 16, paddingTop: 14 }}>
              <div style={eyebrow}>Lifecycle</div>
              <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap', margin: '6px 0 10px' }}>
                <Pill tone={life.mode === 'live' ? 'good' : 'plain'}>{String(life.mode || 'draft')}</Pill>
                <span style={{ fontSize: 13, color: SLATE }}>
                  {life.mode === 'live'
                    ? 'Our engine answers for this investor. Lender Price still runs alongside on every quote.'
                    : 'Lender Price answers for this investor. Ours prices beside it and every disagreement becomes a finding.'}
                </span>
              </div>

              {/* A TAMPERED OR PARTLY-RESTORED LEDGER IS SAID OUT LOUD, never rendered as a tidy
                  history. The server replays every recorded step from draft; this shows what it found. */}
              {life.integrity && life.integrity.ok === false && (
                <p style={{ fontSize: 13, color: '#8a2a2a', margin: '0 0 10px' }}>
                  This lifecycle history does not replay cleanly{life.integrity.brokenAt != null ? ` (first problem at step ${life.integrity.brokenAt})` : ''}
                  {life.integrity.error ? `: ${String(life.integrity.error)}` : '.'} Nothing here should be trusted until that is explained.
                </p>
              )}

              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 8 }}>
                {(life.mode === 'draft') && (
                  <button type="button" style={btnQuiet} disabled={busy} onClick={() => openLifeAction('activate')}>Start shadowing</button>
                )}
                {(life.mode === 'shadow') && (
                  <button
                    type="button"
                    style={life.gate && life.gate.eligible ? btnQuiet : btnOff}
                    disabled={busy || !(life.gate && life.gate.eligible)}
                    title={life.gate && life.gate.eligible ? undefined : 'The go-live bar is a measurement, not an opinion — the reasons are listed above.'}
                    onClick={() => openLifeAction('promote')}
                  >Take live</button>
                )}
                {(life.mode === 'live') && (
                  <button type="button" style={btnQuiet} disabled={busy} onClick={() => openLifeAction('rollback')}>Roll back to shadowing</button>
                )}
                {(life.mode !== 'retired') && (
                  <button type="button" style={btnQuiet} disabled={busy} onClick={() => openLifeAction('retire')}>Retire</button>
                )}
                {(life.mode === 'retired') && (
                  <button type="button" style={btnQuiet} disabled={busy} onClick={() => openLifeAction('reopen')}>Reopen</button>
                )}
              </div>

              {lifeAction && (
                <div style={{ background: PAPER, border: `1px solid ${GOLD}33`, borderRadius: 8, padding: 12, marginBottom: 8 }}>
                  <label style={{ display: 'block', fontSize: 13, color: INK, marginBottom: 6 }}>
                    Why are you doing this? This ledger is append-only, so this note is the permanent record.
                  </label>
                  <textarea
                    value={lifeReason}
                    onChange={(e) => setLifeReason(e.target.value)}
                    rows={2}
                    style={{ width: '100%', fontSize: 14, color: INK, padding: 8, borderRadius: 6, border: `1px solid ${GOLD}55` }}
                  />
                  <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
                    <button type="button" style={btnQuiet} disabled={busy} onClick={() => decideLifecycle(lifeAction)}>
                      Record “{lifeAction}”
                    </button>
                    <button type="button" style={btnQuiet} disabled={busy} onClick={() => openLifeAction(lifeAction)}>Cancel</button>
                  </div>
                </div>
              )}

              {lifeError && <p style={{ fontSize: 13, color: '#8a2a2a', margin: '0 0 8px' }}>{lifeError}</p>}

              {Array.isArray(life.summary && life.summary.history) && life.summary.history.length > 0 ? (
                <ul style={{ margin: 0, paddingLeft: 18, fontSize: 13, color: SLATE }}>
                  {life.summary.history.slice().reverse().map((h) => (
                    <li key={h.seq} style={{ marginBottom: 2 }}>
                      <strong style={{ color: INK }}>{h.action}</strong> — {h.from} → {h.to}, {day(h.atMs)}
                      {h.reason ? ` · ${h.reason}` : ''}
                    </li>
                  ))}
                </ul>
              ) : (
                <p style={{ ...sub, marginBottom: 0 }}>No lifecycle decision has ever been recorded for this investor.</p>
              )}
            </div>
          )}
        </div>
      )}

      <p style={{ fontSize: 13, color: MUTED, marginTop: 4 }}>
        The numbers this engine runs on — how close our price has to be to Lender Price before we call
        it a disagreement, the rounding, the lowest price we quote, and the margin per investor — are on
        the <a href="#/internal/lt/ppe/settings" style={{ color: '#256168' }}>Pricing settings</a> screen.
      </p>

      <p style={{ fontSize: 12, color: MUTED, marginTop: 4 }}>
        Rate-sheet loading is on this screen now (the card at the top), and so is promotion — every
        move is written to an append-only ledger that survives a restart, which is what it was waiting
        for. See <code>src/longterm/ppe/README.md</code>.
      </p>
    </LtLayout>
  );
}
