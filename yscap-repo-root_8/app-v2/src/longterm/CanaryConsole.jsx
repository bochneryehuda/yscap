// THE CANARY CONSOLE — the button that produces the findings ledger and the parity series, and the
// daily cadence that is supposed to press it for you.
//
// WHAT WAS WRONG. `POST /api/lt/ppe/canary` is the ONLY producer of the two things the pricing-engine
// screen reads: the findings ledger ("what disagreed") and the per-band parity series ("where, run
// after run"). It had no caller anywhere in the product — the HTTP-reachability ledger recorded it as
// reachable by a hand-run curl and nothing else — so both of those screens could only ever show what
// somebody had typed into a terminal, and an empty findings queue was indistinguishable from two
// engines that agree. The three schedule routes were in the same state one layer up: a cadence could
// be stored by curl and read by curl, and no person could see or change one.
//
// A RUN COSTS REAL MONEY, and that shapes this whole screen. Every scenario in the battery is one
// live Lender Price call, so:
//   · NOTHING here fires a canary on load. The screen reads the saved schedules (free) and waits.
//   · The run is ARMED in two steps. The first press only counts the battery and states the cost in
//     calls; the second press is the one that spends it, and it says so on the button itself.
//   · The count shown before the run is INFORMATIONAL — the server owns every refusal (the 500-
//     scenario cap, the missing rate sheet, the admin check) and its own wording is printed verbatim.
//     A second copy of those rules here would be a second definition that drifts, and the one that
//     drifts is the one a person believes.
//
// IT MEASURES; IT DECIDES NOTHING. There is no promote, no publish and no repair on this screen — a
// canary writes three durable records and stops, which is exactly what the route does.
//
// WHAT IT COULD NOT COMPARE IS SHOWN AS LOUDLY AS WHAT IT COULD. An incomparable scenario (one side
// produced no result) is neither agreement nor disagreement and is excluded from the agreement rate
// entirely, so a run of 200 scenarios that compared 4 of them can report a beautiful rate. A screen
// that printed only the rate would be the most reassuring possible way to show a broken measurement.
// The same goes for the three PERSISTS: the findings, the run row and the parity cells are stored
// best-effort and fail independently, and "measured but not stored" must never read as "measured".
//
// Dark text on the white PILOT canvas throughout — never an `--ink*` token, which is a LIGHT paper
// colour in this palette and renders white-on-white.
//
// NO BROWSER DIALOG anywhere: no alert, no confirm, no prompt. Long-Term may not import RTL's shared
// dialog helper (the separation gate refuses it, correctly), so every confirmation here is inline —
// which is better anyway, because the cost of the thing being confirmed is written beside the button.

import React, { useCallback, useEffect, useState } from 'react';
import { ltApi } from './api.js';
import { INK, MUTED, SLATE, PAPER, DANGER, CAUTION, card, h2, sub, eyebrow, input, mono, label } from './ppeStyles.js';
// The agreement RATE is a fraction; `format.rate` is the ONE definition of how this product prints
// one, and a second copy is how a screen comes to show 0.97% where another shows 97%.
import { rate } from './format.js';
// The milli-point → points formatter, imported rather than written again for the same reason. It
// already lives on the agreement panel, which is the sibling screen that prints the same unit.
import { pts } from './AgreementRecord.jsx';

const OK = '#256168';

// ---------------------------------------------------------------------------
// Pure helpers — exported so the render suite can drive every branch without a server.
// ---------------------------------------------------------------------------

/**
 * The DELETE route's own key for a schedule.
 *
 * The company-wide schedule is stored with an empty investor, and an empty path segment would make
 * `DELETE /ppe/canary/schedules/` a different route altogether (a 404), so the route reads '-' as
 * "the one with no investor". This is the single place that translation is made — writing it at the
 * call site is how the company-wide row becomes the one nobody can delete.
 */
export function scheduleTarget(investor) {
  const s = investor == null ? '' : String(investor).trim();
  return s === '' ? '-' : s;
}

/**
 * How many scenarios a pasted battery is, and therefore how many live vendor calls it buys.
 *
 * PURE and deliberately NOT a validator: it counts, and it says when it cannot. The server refuses an
 * oversized battery, an empty one and an unexpandable matrix in its own words; repeating those rules
 * here would be a second definition of them. What this exists for is the sentence in front of the
 * button — "this will call Lender Price 240 times" — which cannot be written without a count.
 *
 * Returns { kind, count, error }. A matrix is the cartesian product of its axes (the same arithmetic
 * `scenario-matrix.fullSizeOf` does on the server); an axis with no values produces nothing at all,
 * which is worth saying before a person presses a paid button rather than after.
 */
export function batteryCount(kind, text) {
  const raw = String(text == null ? '' : text).trim();
  if (!raw) return { kind, count: null, error: 'Paste the battery you want measured — nothing here invents one.' };
  let parsed;
  try { parsed = JSON.parse(raw); } catch (e) {
    return { kind, count: null, error: `That is not readable JSON: ${String((e && e.message) || e).slice(0, 120)}` };
  }
  if (kind === 'scenarios') {
    if (!Array.isArray(parsed)) return { kind, count: null, error: 'A scenario battery is a JSON array of scenario objects.' };
    if (!parsed.length) return { kind, count: 0, error: 'That list is empty, so there is nothing to price.' };
    return { kind, count: parsed.length, error: '', battery: parsed };
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { kind, count: null, error: 'A matrix is a JSON object of axes, e.g. {"fico":[700,720],"ltv":[65,70]}.' };
  }
  const keys = Object.keys(parsed);
  if (!keys.length) return { kind, count: 0, error: 'An empty matrix expands to one scenario carrying no facts, which is a battery nobody chose.' };
  let size = 1;
  for (const k of keys) {
    const vals = parsed[k];
    if (!Array.isArray(vals) || !vals.length) {
      return { kind, count: 0, error: `The axis “${k}” has no values, so this matrix expands to no scenarios at all.` };
    }
    size *= vals.length;
  }
  return { kind, count: size, error: '', battery: parsed };
}

/**
 * A cadence in milliseconds, in words a person reads.
 *
 * A schedule saved as 86400000 is a number nobody can check at a glance, and "is the nightly canary
 * actually nightly?" is a question this list has to answer without arithmetic.
 */
export function cadence(ms) {
  const n = Number(ms);
  if (!Number.isFinite(n) || n <= 0) return 'no cadence';
  const mins = Math.round(n / 60000);
  if (mins % 1440 === 0) { const d = mins / 1440; return `every ${d} day${d === 1 ? '' : 's'}`; }
  if (mins % 60 === 0) { const h = mins / 60; return `every ${h} hour${h === 1 ? '' : 's'}`; }
  return `every ${mins} minute${mins === 1 ? '' : 's'}`;
}

/**
 * WHAT THE RUN COULD NOT COMPARE, AND WHY — as lines, from the run's own numbers.
 *
 * PURE, and the sharpest thing on this screen. `parity.summarize` computes the agreement rate over
 * COMPARABLE scenarios only: an incomparable one is never counted as agreement and never dilutes the
 * rate as a disagreement. That is the right arithmetic and it has a reporting consequence — a battery
 * of 200 in which 196 could not be compared reports the agreement of the remaining 4, and a screen
 * showing only the rate would be showing a number measured on 2% of what was paid for.
 *
 * Returns [] when everything was compared, so the caller renders nothing rather than a reassuring
 * "0 problems" line.
 */
export function unmeasuredLines(summary) {
  const s = summary || {};
  const out = [];
  const scenarios = Number(s.scenarios) || 0;
  const incomparable = Number(s.incomparable) || 0;
  const errors = Number(s.errors) || 0;
  if (incomparable > 0) {
    out.push({
      key: 'incomparable',
      count: incomparable,
      headline: `${incomparable} of ${scenarios} scenario${incomparable === 1 ? '' : 's'} could not be compared at all.`,
      why: 'One side produced no result for them, so they are neither agreement nor disagreement. They '
        + 'are left out of the agreement rate entirely — the rate above is measured over the '
        + `${Number(s.comparable) || 0} that could be compared, not over the ${scenarios} that were paid for.`,
    });
  }
  if (errors > 0) {
    out.push({
      key: 'errors',
      count: errors,
      headline: `${errors} scenario${errors === 1 ? '' : 's'} an engine failed on.`,
      why: 'An engine threw rather than answering. That is a fault to fix, not a disagreement to settle.',
    });
  }
  const overlay = Number(s.byKind && s.byKind.eligibility_overlay) || 0;
  if (overlay > 0) {
    out.push({
      key: 'overlay',
      count: overlay,
      headline: `${overlay} scenario${overlay === 1 ? '' : 's'} declined on an overlay Lender Price cannot see.`,
      why: 'A deliberate, reasoned override of Lender Price rather than a parity defect — scored '
        + 'separately, never as agreement and never as a mismatch.',
    });
  }
  return out;
}

/**
 * Did the run reach all three durable stores, and if not, which one did it lose?
 *
 * PURE. The findings ledger, the run series and the parity cells are persisted best-effort and fail
 * INDEPENDENTLY, and each answers a different question — so "the run landed but the cells did not" is
 * its own problem and must not be flattened into one green tick. A measurement nobody stored is not a
 * measurement the gate can ever read.
 */
export function persistLines(result) {
  const r = result || {};
  return [
    { key: 'findings', name: 'the findings ledger', ok: r.persisted !== false, detail: r.persistError || null },
    {
      key: 'run',
      name: 'the run series the promotion gate reads',
      ok: r.runPersisted !== false,
      detail: r.runPersistError || r.runPersistReason || null,
    },
    {
      key: 'cells',
      name: 'the per-band parity series',
      ok: r.cellsPersisted !== false,
      detail: r.cellPersistError || null,
    },
  ];
}

// ---------------------------------------------------------------------------
// small presentational bits
// ---------------------------------------------------------------------------

function Pill({ tone, children }) {
  const tones = {
    good: { bg: 'rgba(47,127,134,.10)', fg: OK, bd: 'rgba(47,127,134,.35)' },
    warn: { bg: 'rgba(174,135,70,.12)', fg: CAUTION, bd: 'rgba(174,135,70,.40)' },
    bad: { bg: 'rgba(158,58,58,.10)', fg: DANGER, bd: 'rgba(158,58,58,.32)' },
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

function Figure({ label: name, value, hint }) {
  return (
    <div style={{ minWidth: 120 }}>
      <div style={eyebrow}>{name}</div>
      <div style={{ fontSize: 22, color: INK, fontWeight: 600, fontVariantNumeric: 'tabular-nums' }}>{value}</div>
      {hint && <div style={{ fontSize: 12, color: MUTED, marginTop: 2 }}>{hint}</div>}
    </div>
  );
}

/**
 * THE ARMING STEP — the second press, and the only thing on this screen that spends money.
 *
 * Its own exported component for the same reason the result view is: a suite cannot press a button
 * under `renderToString`, so the sentence that states the cost can only be PROVEN to reach a person
 * if the panel can be rendered on its own. It holds no state and decides nothing — the count is
 * handed to it, so it cannot disagree with what the run is about to send.
 */
export function ArmPanel({ count, busy, onFire, onCancel }) {
  const n = Number(count);
  const calls = Number.isFinite(n) ? n : 0;
  return (
    <div style={{
      border: '1px solid rgba(158,58,58,.32)', borderRadius: 10, padding: '10px 12px',
      background: 'rgba(158,58,58,.05)',
    }}>
      <div style={{ fontSize: 14, color: INK, fontWeight: 600 }}>
        This will make {calls} live Lender Price call{calls === 1 ? '' : 's'} right now.
      </div>
      <div style={{ fontSize: 12, color: SLATE, margin: '2px 0 8px' }}>
        Nothing has been sent yet. The bill is one call per scenario, and the run cannot be stopped
        once it starts.
      </div>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        <button type="button" className="btn" disabled={busy} onClick={onFire}>
          Call Lender Price now — {calls} scenario{calls === 1 ? '' : 's'}
        </button>
        <button type="button" className="btn ghost" disabled={busy} onClick={onCancel}>
          Cancel
        </button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// THE RESULT, on its own, so the loaded state can be RENDERED rather than only described.
// ---------------------------------------------------------------------------
//
// `renderToString` never runs an effect and never presses a button, so a component that fetches its
// own data can only be tested in its empty state — and every part worth guarding here is in the
// loaded one. Splitting the presentation off is what lets the suite hand it a real run and assert on
// the text a person actually reads.

export function CanaryRunView({ result, error, running }) {
  if (running) {
    return (
      <div style={{ marginTop: 12, fontSize: 13, color: INK }}>
        Pricing the battery against Lender Price. This is live and it is being billed — leaving the
        page does not stop it.
      </div>
    );
  }
  if (error) {
    return (
      <div style={{ marginTop: 12, fontSize: 13, color: DANGER }}>
        {error}
      </div>
    );
  }
  if (!result) return null;

  const summary = result.summary || {};
  const report = result.report || {};
  const unmeasured = unmeasuredLines(summary);
  const stores = persistLines(result);
  const worst = Array.isArray(result.worstCells) ? result.worstCells : [];
  const gaps = Array.isArray(report.worstPriceGaps) ? report.worstPriceGaps : [];
  const kinds = Array.isArray(report.byKind) ? report.byKind : [];

  return (
    <div style={{ marginTop: 14, borderTop: '1px solid rgba(20,27,34,.10)', paddingTop: 12 }}>
      <div style={eyebrow}>What this run found</div>

      <div style={{ display: 'flex', gap: 26, flexWrap: 'wrap', margin: '8px 0 10px' }}>
        <Figure
          label="Agreement"
          value={rate(result.agreementRate)}
          hint={result.agreementRate == null ? 'nothing could be compared' : 'of what could be compared'}
        />
        <Figure label="Priced" value={result.scenarios == null ? '—' : result.scenarios} hint="scenarios sent" />
        <Figure label="Compared" value={summary.comparable == null ? '—' : summary.comparable} />
        <Figure label="Disagreed" value={summary.disagreed == null ? '—' : summary.disagreed} />
        <Figure label="Findings" value={result.findings == null ? '—' : result.findings} hint="written to the ledger" />
      </div>

      {report.verdict && <p style={{ fontSize: 13, color: INK, margin: '0 0 10px' }}>{report.verdict}</p>}

      {/* WHAT IT COULD NOT COMPARE — never folded into the rate above. */}
      {unmeasured.length > 0 && (
        <div style={{
          border: '1px solid rgba(174,135,70,.40)', borderRadius: 10, padding: '10px 12px',
          background: 'rgba(174,135,70,.08)', marginBottom: 10,
        }}>
          <div style={{ ...eyebrow, color: CAUTION }}>What it could not compare</div>
          {unmeasured.map((u) => (
            <div key={u.key} style={{ marginTop: 6 }}>
              <div style={{ fontSize: 13, color: INK, fontWeight: 600 }}>{u.headline}</div>
              <div style={{ fontSize: 12, color: SLATE }}>{u.why}</div>
            </div>
          ))}
        </div>
      )}
      {unmeasured.length === 0 && summary.scenarios > 0 && (
        <p style={{ fontSize: 12, color: MUTED, margin: '0 0 10px' }}>
          Every scenario in this battery could be compared, so the agreement rate is measured over all
          of them.
        </p>
      )}

      {/* WHERE IT WENT — the three stores fail independently. */}
      <div style={{ marginBottom: 10 }}>
        <div style={eyebrow}>Where the measurement went</div>
        <ul style={{ margin: '6px 0 0 16px', padding: 0, fontSize: 13, color: SLATE }}>
          {stores.map((s) => (
            <li key={s.key} style={{ marginBottom: 2, color: s.ok ? SLATE : DANGER }}>
              {s.ok ? 'Stored in ' : 'NOT stored in '}{s.name}
              {s.detail ? ` — ${String(s.detail)}` : ''}
            </li>
          ))}
        </ul>
        {result.cellsTruncated === true && (
          <p style={{ fontSize: 12, color: CAUTION, margin: '4px 0 0' }}>
            The per-band write was capped, so the newest cells are missing from that series. A series
            missing its tail reads as a clean stretch.
          </p>
        )}
        {typeof result.cellsWritten === 'number' && (
          <p style={{ fontSize: 12, color: MUTED, margin: '4px 0 0' }}>
            {result.cellsWritten} band measurement{result.cellsWritten === 1 ? '' : 's'} written.
          </p>
        )}
      </div>

      {kinds.length > 0 && (
        <div style={{ marginBottom: 10 }}>
          <div style={eyebrow}>Disagreements by type</div>
          <ul style={{ margin: '6px 0 0 16px', padding: 0, fontSize: 13, color: SLATE }}>
            {kinds.map((k) => <li key={k.kind}>{k.label || k.kind}: {k.count}</li>)}
          </ul>
        </div>
      )}

      {gaps.length > 0 && (
        <div style={{ marginBottom: 10 }}>
          <div style={eyebrow}>Widest price gaps</div>
          <ul style={{ margin: '6px 0 0 16px', padding: 0, fontSize: 13, color: SLATE }}>
            {gaps.map((g, i) => (
              <li key={i} style={{ fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: 12 }}>
                coupon {g.rate == null ? '—' : g.rate} · {pts(g.deltaMilli)} apart
                {g.scenario ? ` · ${String(g.scenario)}` : ''}
              </li>
            ))}
          </ul>
          {/* A sample nobody is told is a sample reads as the whole story. */}
          {Number(report.worstPriceGapsOmitted) > 0 && (
            <p style={{ fontSize: 12, color: CAUTION, margin: '4px 0 0' }}>
              …and {report.worstPriceGapsOmitted} further price gap
              {Number(report.worstPriceGapsOmitted) === 1 ? '' : 's'} this list does not show.
            </p>
          )}
        </div>
      )}

      {worst.length > 0 && (
        <div>
          <div style={eyebrow}>Worst bands in this run</div>
          <ul style={{ margin: '6px 0 0 16px', padding: 0, fontSize: 13, color: SLATE }}>
            {worst.map((c, i) => (
              <li key={i}>
                {c.dimension} · {c.label || c.key} — {rate(c.agreementRate)} agreement over {c.total}
                {' '}scenario{c.total === 1 ? '' : 's'}, widest gap {pts(c.worstAbsMilli)}
              </li>
            ))}
          </ul>
          <p style={{ fontSize: 12, color: MUTED, margin: '4px 0 0' }}>
            The same bands are kept run after run on the pricing-engine screen above, which is what
            tells a three-week regression from one bad afternoon.
          </p>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// THE SCHEDULE LIST, on its own, for the same reason.
// ---------------------------------------------------------------------------

export function CanaryScheduleView({ data, error, confirming, onConfirmRemove, onRemove, onCancelRemove, busy }) {
  const rows = (data && Array.isArray(data.schedules)) ? data.schedules : [];

  return (
    <div>
      {error && <p style={{ fontSize: 13, color: DANGER, margin: '0 0 8px' }}>{error}</p>}

      {/* THE RECORDED DEFECT, said on the screen rather than left for somebody to discover from a
          quiet scoreboard. A schedule is stored and honoured by a tick, and nothing in the running
          system calls that tick — no cron, no worker, no timer. Drawing these rows as "armed" without
          saying so would make this screen the thing that hides it. */}
      <div style={{
        border: '1px solid rgba(158,58,58,.32)', borderRadius: 10, padding: '10px 12px',
        background: 'rgba(158,58,58,.06)', marginBottom: 10,
      }}>
        <div style={{ fontSize: 13, color: DANGER, fontWeight: 600 }}>
          Nothing fires these schedules yet.
        </div>
        <div style={{ fontSize: 12, color: SLATE, marginTop: 2 }}>
          A saved cadence is honoured by a tick, and no cron, worker or timer in the running system
          calls it today. Until one does, a schedule here records the battery you want measured and
          the agreement series still only grows when somebody presses Run above.
        </div>
      </div>

      {!error && data && rows.length === 0 && (
        <p style={{ ...sub, marginBottom: 8 }}>
          No canary schedule is saved. Nothing is measured on a cadence, so the clean-day streak the
          promotion gate reads has nothing feeding it.
        </p>
      )}

      {rows.map((s) => {
        const key = scheduleTarget(s.investor);
        return (
          <div key={key} style={{ borderTop: '1px solid rgba(20,27,34,.10)', padding: '10px 0' }}>
            <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'flex-start' }}>
              <div style={{ flex: 1, minWidth: 220 }}>
                <div style={{ fontSize: 14, color: INK, fontWeight: 600 }}>
                  {s.investor || 'Every investor (no investor named)'}
                </div>
                <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', margin: '4px 0' }}>
                  <Pill tone={s.runnable ? 'good' : 'warn'}>{s.runnable ? 'would run' : 'would not run'}</Pill>
                  <Pill tone="flat">{cadence(s.intervalMs)}</Pill>
                  <Pill tone="flat">{s.batteryKind === 'matrix' ? 'a saved matrix' : 'a saved scenario list'}</Pill>
                  {s.enabled !== true && <Pill tone="warn">paused</Pill>}
                </div>
                {/* The SERVER's own wording for why a row would not run — never a paraphrase, because
                    it names which rule stopped it and a paraphrase would name none. */}
                {s.message && <div style={{ fontSize: 12, color: CAUTION }}>{s.message}</div>}
                {s.note && <div style={{ fontSize: 12, color: SLATE, marginTop: 2 }}>{s.note}</div>}
                <div style={{ fontSize: 12, color: MUTED, marginTop: 2 }}>
                  {s.rateSheetVersionId ? `Prices against rate sheet ${s.rateSheetVersionId}. ` : 'No rate sheet named, so a run would be refused. '}
                  {s.updatedBy ? `Armed by ${s.updatedBy}.` : ''}
                </div>
              </div>
              <div style={{ display: 'flex', gap: 8, alignItems: 'flex-start' }}>
                {confirming === key ? (
                  <>
                    <button type="button" className="btn" disabled={busy} onClick={() => onRemove(s)}>
                      Yes, remove it
                    </button>
                    <button type="button" className="btn ghost" disabled={busy} onClick={onCancelRemove}>
                      Keep it
                    </button>
                  </>
                ) : (
                  <button type="button" className="btn ghost" disabled={busy} onClick={() => onConfirmRemove(s)}>
                    Remove
                  </button>
                )}
              </div>
            </div>
          </div>
        );
      })}

      {/* The server's own sentence about a list with nothing runnable in it. */}
      {data && data.note && (
        <p style={{ ...sub, margin: '10px 0 0' }}>{data.note}</p>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// The console: the run form, the arming step, and the schedule editor.
// ---------------------------------------------------------------------------

export default function CanaryConsole({ investors }) {
  const list = Array.isArray(investors) ? investors : [];

  // ---- the run ---------------------------------------------------------------------------------
  const [investor, setInvestor] = useState('');
  const [versionId, setVersionId] = useState('');
  const [kind, setKind] = useState('matrix');
  const [batteryText, setBatteryText] = useState('');
  const [concurrency, setConcurrency] = useState('');
  const [armed, setArmed] = useState(null);      // the counted battery a person is about to pay for
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState(null);
  const [runError, setRunError] = useState('');

  // What sheet the money would be spent against. Read-only, and it is the difference between
  // "priced against the sheet I just edited" and "priced against last month's".
  const [sheet, setSheet] = useState(null);
  const [sheetError, setSheetError] = useState('');
  const checkSheet = async () => {
    setSheet(null);
    setSheetError('');
    const id = versionId.trim();
    if (!id) { setSheetError('Paste the rate-sheet version this battery should be priced against.'); return; }
    try { setSheet(await ltApi.ppeRateSheet(id)); } catch (e) {
      setSheetError(e.message || 'That rate-sheet version could not be read.');
    }
  };

  const arm = () => {
    setResult(null);
    setRunError('');
    const counted = batteryCount(kind, batteryText);
    if (counted.error) { setArmed(null); setRunError(counted.error); return; }
    setArmed(counted);
  };

  const fire = async () => {
    if (!armed || !armed.battery) return;
    setRunning(true);
    setRunError('');
    setResult(null);
    try {
      const body = {
        investor: investor || undefined,
        rateSheetVersionId: versionId.trim() || undefined,
        concurrency: concurrency.trim() ? Number(concurrency.trim()) : undefined,
      };
      if (kind === 'matrix') body.matrix = armed.battery; else body.scenarios = armed.battery;
      setResult(await ltApi.ppeCanary(body));
      setArmed(null);
    } catch (e) {
      // The server refuses a non-admin, a battery over its cap, a missing rate sheet and an
      // unexpandable matrix — each in its own words, which is what tells a person which happened.
      setRunError(e.message || 'That canary run was refused.');
      setArmed(null);
    } finally { setRunning(false); }
  };

  // ---- the schedules ---------------------------------------------------------------------------
  const [schedules, setSchedules] = useState(null);
  const [schedError, setSchedError] = useState('');
  const [confirming, setConfirming] = useState(null);
  const [busy, setBusy] = useState(false);

  const loadSchedules = useCallback(() => {
    ltApi.ppeCanarySchedules()
      .then((r) => { setSchedules(r); setSchedError(''); })
      // Said, never swallowed: an empty list drawn in place of a read failure reads as "nothing is
      // scheduled", which is a different fact and sends a person to a different place.
      .catch((e) => { setSchedules(null); setSchedError(e.message || 'The canary schedules could not be read.'); });
  }, []);
  useEffect(loadSchedules, [loadSchedules]);

  const removeSchedule = async (s) => {
    setBusy(true);
    setSchedError('');
    try {
      await ltApi.ppeDeleteCanarySchedule(scheduleTarget(s.investor));
      setConfirming(null);
      loadSchedules();
    } catch (e) {
      setSchedError(e.message || 'That schedule could not be removed.');
    } finally { setBusy(false); }
  };

  const [newInvestor, setNewInvestor] = useState('');
  const [newMinutes, setNewMinutes] = useState('1440');
  const [newKind, setNewKind] = useState('matrix');
  const [newBattery, setNewBattery] = useState('');
  const [newVersion, setNewVersion] = useState('');
  const [newEnabled, setNewEnabled] = useState(false);
  const [newNote, setNewNote] = useState('');
  const [saveError, setSaveError] = useState('');
  const [saved, setSaved] = useState('');

  const saveSchedule = async () => {
    setBusy(true);
    setSaveError('');
    setSaved('');
    const counted = batteryCount(newKind, newBattery);
    if (counted.error) { setSaveError(counted.error); setBusy(false); return; }
    try {
      // A cadence that cannot be read is left OUT rather than sent as NaN: JSON turns NaN into null,
      // which the server reads as "no interval given" and quietly substitutes its own default — so a
      // typo in this box would arm a vendor loop on a cadence nobody chose. Omitted, the server
      // refuses or defaults in its own words, which is at least a sentence a person can act on.
      const mins = Number(newMinutes);
      const body = {
        investor: newInvestor || null,
        enabled: newEnabled === true,
        rateSheetVersionId: newVersion.trim() || null,
        note: newNote.trim() || null,
      };
      if (Number.isFinite(mins) && mins > 0) body.intervalMinutes = mins;
      if (newKind === 'matrix') body.matrix = counted.battery; else body.scenarios = counted.battery;
      await ltApi.ppeSaveCanarySchedule(body);
      setSaved(`Saved. ${counted.count} scenario${counted.count === 1 ? '' : 's'} would be priced each time it runs.`);
      setNewBattery('');
      loadSchedules();
    } catch (e) {
      // The store returns the DECISION module's own reason and wording, so a person hears exactly what
      // the runner would have said rather than "that did not work".
      setSaveError(e.message || 'That schedule was refused.');
    } finally { setBusy(false); }
  };

  return (
    <>
      <div style={card}>
        <h2 style={h2}>Run a canary</h2>
        <p style={sub}>
          A canary prices a battery of scenarios with our engine and with Lender Price side by side,
          and records every disagreement. It is the only thing that writes the differences list and the
          per-band series on this page — without a run, both of them are empty because nothing has been
          measured, not because the two engines agree.
        </p>
        <p style={{ ...sub, color: CAUTION, fontWeight: 600 }}>
          Every scenario is one live Lender Price call, billed. Nothing on this page runs a canary on
          its own — it fires only when you press the second button below.
        </p>

        <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', marginBottom: 10 }}>
          <div style={{ minWidth: 200, flex: 1 }}>
            <label style={label}>Investor</label>
            <select className="input" value={investor} onChange={(e) => setInvestor(e.target.value)}>
              <option value="">No investor — the company-wide series</option>
              {list.map((i) => <option key={i.id} value={i.code}>{i.name || i.code}</option>)}
            </select>
          </div>
          <div style={{ minWidth: 240, flex: 2 }}>
            <label style={label}>Rate-sheet version to price against</label>
            <div style={{ display: 'flex', gap: 8 }}>
              <input
                style={input}
                value={versionId}
                onChange={(e) => { setVersionId(e.target.value); setSheet(null); setSheetError(''); }}
                placeholder="the rate-sheet version id"
              />
              <button type="button" className="btn ghost" onClick={checkSheet}>Check</button>
            </div>
            {sheetError && <div style={{ fontSize: 12, color: DANGER, marginTop: 4 }}>{sheetError}</div>}
            {sheet && sheet.version && (
              <div style={{ fontSize: 12, color: SLATE, marginTop: 4 }}>
                Version {sheet.version.versionNo} · {sheet.version.status} ·{' '}
                {(sheet.basePrices || []).length} base price rows.
              </div>
            )}
          </div>
          <div style={{ minWidth: 120 }}>
            <label style={label}>Parallel calls</label>
            <input
              style={input}
              value={concurrency}
              onChange={(e) => setConcurrency(e.target.value)}
              placeholder="4"
            />
          </div>
        </div>

        <div style={{ marginBottom: 10 }}>
          <label style={label}>The battery — the scenarios you want measured</label>
          <div style={{ display: 'flex', gap: 12, marginBottom: 6, fontSize: 13, color: SLATE }}>
            <label>
              <input
                type="radio"
                checked={kind === 'matrix'}
                onChange={() => { setKind('matrix'); setArmed(null); }}
              />{' '}
              a matrix of axes
            </label>
            <label>
              <input
                type="radio"
                checked={kind === 'scenarios'}
                onChange={() => { setKind('scenarios'); setArmed(null); }}
              />{' '}
              a list of scenarios
            </label>
          </div>
          <textarea
            style={mono}
            value={batteryText}
            onChange={(e) => { setBatteryText(e.target.value); setArmed(null); }}
            placeholder={kind === 'matrix'
              ? '{"fico": [700, 720, 740], "ltv": [65, 70], "state": ["NJ", "NY"]}'
              : '[{"fico": 720, "ltv": 65, "state": "NJ"}]'}
          />
          <p style={{ fontSize: 12, color: MUTED, margin: '4px 0 0' }}>
            Nothing here invents a battery. Which scenarios are worth measuring is a judgement about
            the investor’s book, and an agreement rate over scenarios nobody chose still feeds the
            promotion gate.
          </p>
        </div>

        {!armed && (
          <button type="button" className="btn ghost" disabled={running} onClick={arm}>
            Count this battery
          </button>
        )}

        {armed && (
          <ArmPanel count={armed.count} busy={running} onFire={fire} onCancel={() => setArmed(null)} />
        )}

        <CanaryRunView result={result} error={runError} running={running} />
      </div>

      <div style={card}>
        <h2 style={h2}>The daily canary schedule</h2>
        <p style={sub}>
          A saved cadence is what turns one afternoon’s measurement into the clean-day streak and the
          agreement trend the promotion gate reads. Each row is reported with what the runner would
          decide about it, so a schedule that can never fire never reads as armed.
        </p>

        <CanaryScheduleView
          data={schedules}
          error={schedError}
          confirming={confirming}
          busy={busy}
          onConfirmRemove={(s) => setConfirming(scheduleTarget(s.investor))}
          onCancelRemove={() => setConfirming(null)}
          onRemove={removeSchedule}
        />

        <div style={{ borderTop: '1px solid rgba(20,27,34,.10)', marginTop: 12, paddingTop: 12 }}>
          <div style={eyebrow}>Save a schedule</div>
          <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', margin: '8px 0' }}>
            <div style={{ minWidth: 190, flex: 1 }}>
              <label style={label}>Investor</label>
              <select className="input" value={newInvestor} onChange={(e) => setNewInvestor(e.target.value)}>
                <option value="">No investor — one company-wide schedule</option>
                {list.map((i) => <option key={i.id} value={i.code}>{i.name || i.code}</option>)}
              </select>
            </div>
            <div style={{ minWidth: 130 }}>
              <label style={label}>Every … minutes</label>
              <input style={input} value={newMinutes} onChange={(e) => setNewMinutes(e.target.value)} />
            </div>
            <div style={{ minWidth: 220, flex: 1 }}>
              <label style={label}>Rate-sheet version</label>
              <input style={input} value={newVersion} onChange={(e) => setNewVersion(e.target.value)} />
            </div>
          </div>

          <label style={label}>The battery this schedule prices</label>
          <div style={{ display: 'flex', gap: 12, marginBottom: 6, fontSize: 13, color: SLATE }}>
            <label>
              <input type="radio" checked={newKind === 'matrix'} onChange={() => setNewKind('matrix')} />{' '}
              a matrix of axes
            </label>
            <label>
              <input type="radio" checked={newKind === 'scenarios'} onChange={() => setNewKind('scenarios')} />{' '}
              a list of scenarios
            </label>
          </div>
          <textarea style={mono} value={newBattery} onChange={(e) => setNewBattery(e.target.value)} />

          <div style={{ margin: '8px 0' }}>
            <label style={{ fontSize: 13, color: SLATE }}>
              <input
                type="checkbox"
                checked={newEnabled}
                onChange={(e) => setNewEnabled(e.target.checked)}
              />{' '}
              Arm it — this schedule may fire live Lender Price calls once something ticks it.
            </label>
          </div>

          <label style={label}>Note</label>
          <input style={input} value={newNote} onChange={(e) => setNewNote(e.target.value)} />

          <div style={{ marginTop: 10 }}>
            <button type="button" className="btn" disabled={busy} onClick={saveSchedule}>
              Save this schedule
            </button>
          </div>
          {saveError && <p style={{ fontSize: 13, color: DANGER, margin: '8px 0 0' }}>{saveError}</p>}
          {saved && <p style={{ fontSize: 13, color: OK, margin: '8px 0 0' }}>{saved}</p>}
        </div>
      </div>
    </>
  );
}
