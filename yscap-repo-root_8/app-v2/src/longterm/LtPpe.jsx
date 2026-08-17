import React, { useCallback, useEffect, useState } from 'react';
import LtLayout from './LtLayout.jsx';
import { ltApi } from './api.js';
// `day` reads an epoch instant here, not a calendar-date column: a parity cell stores the canary's
// own `dayMs` verbatim (db/575), which is the moment the run happened. The helper's date-string
// branch — the one that exists because a DATE column parses as UTC midnight and prints the day
// before — never applies to it, so the shared helper is the right reading and not a second one.
import { rate, day } from './format.js';

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

const INK = '#141B22';
const MUTED = '#4B585C';
const SLATE = '#3A4550';
const GOLD = '#AE8746';
const PAPER = '#F4F1EA';

const card = {
  border: '1px solid rgba(20,27,34,.12)', borderRadius: 12, padding: 16,
  background: '#fff', marginBottom: 14,
};
const h2 = { margin: '0 0 4px', fontSize: 16, color: INK };
const sub = { margin: '0 0 12px', fontSize: 13, color: MUTED };
const eyebrow = {
  fontSize: 11, letterSpacing: '.09em', textTransform: 'uppercase',
  color: MUTED, fontWeight: 700,
};

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

function Figure({ label, value, hint }) {
  return (
    <div style={{ minWidth: 128 }}>
      <div style={eyebrow}>{label}</div>
      <div style={{ fontSize: 22, color: INK, fontWeight: 600, fontVariantNumeric: 'tabular-nums' }}>{value}</div>
      {hint && <div style={{ fontSize: 12, color: MUTED, marginTop: 2 }}>{hint}</div>}
    </div>
  );
}

export default function LtPpe() {
  const [health, setHealth] = useState(null);
  const [investors, setInvestors] = useState(null);
  const [queue, setQueue] = useState(null);
  const [board, setBoard] = useState(null);
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
    } else {
      setBoard(null);
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

        {queue && items.length === 0 && (
          <p style={{ ...sub, marginBottom: 0 }}>
            Nothing is waiting. Either the two engines agreed on everything measured so far, or nothing has
            been measured yet — the scoreboard below says which.
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
            "Live" means our engine answers for this investor and Lender Price is no longer called. Nobody
            is promoted automatically — this is the picture a person would decide on.
          </p>
          {board && board.scoreboard ? (
            <>
              <div style={{ display: 'flex', gap: 28, flexWrap: 'wrap', marginBottom: 12 }}>
                <Figure label="Agreement" value={rate(board.scoreboard.canaryAgreementRate)}
                  hint={board.scoreboard.canaryAgreementRate == null ? 'not measured yet' : undefined} />
                <Figure label="Still open" value={board.scoreboard.openFindings} />
                <Figure label="Oldest open" value={board.scoreboard.oldestOpenFindingDays == null ? '—' : `${board.scoreboard.oldestOpenFindingDays}d`} />
                <Figure label="Clean days" value={board.scoreboard.consecutiveCleanDays} hint="in a row" />
              </div>
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
        </div>
      )}

      <p style={{ fontSize: 12, color: MUTED, marginTop: 4 }}>
        Promotion and rate-sheet loading are deliberately not on this screen yet — a decision this page
        cannot record durably would be worse than no button. See <code>src/longterm/ppe/README.md</code>.
      </p>
    </LtLayout>
  );
}
