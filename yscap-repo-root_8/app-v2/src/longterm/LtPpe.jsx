import React, { useCallback, useEffect, useState } from 'react';
import LtLayout from './LtLayout.jsx';
import { ltApi } from './api.js';

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

function Figure({ label, value, hint }) {
  return (
    <div style={{ minWidth: 128 }}>
      <div style={eyebrow}>{label}</div>
      <div style={{ fontSize: 22, color: INK, fontWeight: 600, fontVariantNumeric: 'tabular-nums' }}>{value}</div>
      {hint && <div style={{ fontSize: 12, color: MUTED, marginTop: 2 }}>{hint}</div>}
    </div>
  );
}

const pct = (v) => (typeof v === 'number' && Number.isFinite(v) ? `${(v * 100).toFixed(1)}%` : '—');

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
                <Figure label="Agreement" value={pct(board.scoreboard.canaryAgreementRate)}
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
