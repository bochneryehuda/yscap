// THE AGREEMENT RECORD — what the paid Lender Price run actually found, on the screen.
//
// The ≥200-scenario agreement gate decides whether a rate sheet may be published, and everything it
// decides on was already being STORED: the verdict, the counts, and — since §2.37 and §2.41 — WHICH
// scenarios disagreed, WHERE in the price build-up they diverged, and WHY each side declined when the
// two declined differently. Nothing displayed any of it. `ltApi.ppeRateSheetAgreement` existed with no
// caller (the HTTP-reachability gate reported it as an entry with a route and no button), so the only
// way to read a run that costs real vendor calls was to query the database by hand.
//
// A PUBLISH REFUSAL WITHOUT ITS EVIDENCE IS A DEAD END, and that is the defect this closes. "This
// sheet has never been measured" sends somebody to the Measure button; "it was measured and 3 of 214
// scenarios disagreed on the cash-out LLPA at 65% LTV" sends them to the cell that is wrong. The
// second is the whole point of paying for the run.
//
// IT DECIDES NOTHING. This is a READ. The verdict comes from `agreement-store.gateStatus` (the ONE
// definition, which fails closed on an unreadable ledger), the numbers come from the stored summary
// verbatim, and there is no control here that could record, edit or satisfy an agreement — a
// hand-entered result would pass the gate without a single scenario being compared, which the route
// itself says in its own `note`.
//
// EVERY CAP IS SHOWN AS A CAP. The stored sample is bounded (50 scenarios, 12 dimensions each, 8
// decline rows, vendor reasons clipped to 120 characters) and the run's fuller per-coupon digest is
// not stored at all. A reader who is not told that reads the sample as the whole story, which is the
// exact failure this workstream keeps finding — so `disagreementsOmitted`, `dimensionsOmitted`,
// `declineRowsOmitted` and `notStored` are rendered rather than dropped.
//
// Dark text on white throughout, per the hard rule — never an `--ink*` token, which is a LIGHT colour
// in this palette.

import React, { useCallback, useEffect, useState } from 'react';
import { ltApi } from './api.js';
import { INK, MUTED, SLATE, DANGER, CAUTION, sub, eyebrow, mono } from './ppeStyles.js';
// The agreement RATE is a fraction (0.972), and `format.rate` is the ONE definition of how this
// product prints one. Writing a second here is how one screen comes to show 0.97% where another
// shows 97% — `test-lt-pipeline-columns-pure.js` refuses any Long-Term file that defines its own,
// and it caught exactly that in the first cut of this component.
import { rate } from './format.js';

const OK = '#256168';

/** A milli-point delta as points, signed, so a reader sees which way the price moved. */
export function pts(milli) {
  if (milli == null || !Number.isFinite(Number(milli))) return '—';
  const n = Number(milli) / 1000;
  const s = n.toFixed(3).replace(/0+$/, '').replace(/\.$/, '');
  return `${n > 0 ? '+' : ''}${s} pts`;
}

export function whenOf(ms) {
  const n = Number(ms);
  if (!Number.isFinite(n) || n <= 0) return 'an unrecorded time';
  try { return new Date(n).toLocaleString(); } catch { return String(n); }
}

/**
 * The one-line verdict, in words a non-developer can act on.
 *
 * PURE and exported so the render test can assert every branch without a server. Each reason sends the
 * reader somewhere DIFFERENT, which is why they are not collapsed into "not proven": `unreadable` means
 * something else is broken, `overridden` means a human deliberately published without measuring, and
 * `never_measured` means press the button.
 */
export function verdictOf(data) {
  if (!data) return { tone: MUTED, headline: 'The agreement record has not been read yet.', hint: '' };
  if (data.proven) {
    return {
      tone: OK,
      headline: 'Measured against Lender Price, and they agreed.',
      hint: 'This sheet may be published on its measurement rather than on an override.',
    };
  }
  const reason = String(data.reason || '');
  if (reason === 'unreadable') {
    return {
      tone: DANGER,
      headline: 'The agreement record could not be read.',
      hint: 'This is not the same as "never measured" — something else is wrong, and until it is fixed '
        + 'the sheet is treated as unproven rather than assumed fine.',
    };
  }
  if (reason === 'overridden') {
    return {
      tone: CAUTION,
      headline: 'Published on a recorded override — never measured.',
      hint: 'An override is a decision to publish anyway. It proves nothing about agreement, and this '
        + 'sheet still has no measurement behind it.',
    };
  }
  if (reason === 'never_measured' || reason === 'no_version') {
    return {
      tone: CAUTION,
      headline: 'Never measured against Lender Price.',
      hint: 'Press “Measure against Lender Price”. Publishing before that needs a recorded override.',
    };
  }
  return {
    tone: DANGER,
    headline: data.message || 'This sheet is not proven against Lender Price.',
    hint: '',
  };
}

/**
 * WHERE in the price build-up the worst rung diverged, in words.
 *
 * PURE. `worstRungOf` stores a delta per stage (base grid → adjustment stack → margin → final price),
 * and the EARLIEST non-zero one is the answer worth giving: a gap in the base grid explains every
 * downstream number, so naming the final price would send a reader hunting through LLPA cells for a
 * difference that is not there. This is exactly what the itemized dimension list cannot say — a
 * base-grid or margin difference itemizes as NOTHING.
 *
 * Returns null when every stage agrees or nothing was recorded, so the caller renders nothing rather
 * than a confident "diverges at the base grid" about a rung that does not diverge at all.
 */
export function rungStage(w) {
  if (!w || typeof w !== 'object') return null;
  const stages = [
    ['baseDeltaMilli', 'base grid'],
    ['adjustmentTotalDeltaMilli', 'adjustment stack'],
    ['marginDeltaMilli', 'margin'],
    ['finalDeltaMilli', 'final price after the clamp'],
  ];
  for (const [key, name] of stages) {
    const v = Number(w[key]);
    if (Number.isFinite(v) && v !== 0) return { name, deltaMilli: v };
  }
  return null;
}

/** A `disagreements[]` entry as a heading a person can read: which loan, and which way it went. */
export function scenarioLine(d) {
  const s = (d && d.scenario) || {};
  const bits = [];
  if (s.purpose) bits.push(String(s.purpose));
  if (s.state) bits.push(String(s.state));
  if (s.fico != null) bits.push(`FICO ${s.fico}`);
  if (s.ltv != null) bits.push(`LTV ${s.ltv}`);
  if (s.propertyType) bits.push(String(s.propertyType));
  if (s.lockDays != null) bits.push(`${s.lockDays}-day lock`);
  const who = bits.length ? bits.join(' · ') : 'a scenario the record did not name';
  const ours = d && d.ourEligible ? 'we priced it' : 'we declined it';
  const theirs = d && d.lpEligible ? 'they priced it' : 'they declined it';
  return `${who} — ${ours}, ${theirs}`;
}

function Counts({ r }) {
  const cell = { padding: '2px 10px 2px 0', fontSize: 12, color: SLATE, whiteSpace: 'nowrap' };
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0 4px', marginTop: 2 }}>
      <span style={cell}><strong style={{ color: INK }}>{r.scenarios}</strong> scenarios</span>
      <span style={cell}><strong style={{ color: INK }}>{r.comparable}</strong> comparable</span>
      <span style={cell}><strong style={{ color: INK }}>{r.agreed}</strong> agreed</span>
      <span style={{ ...cell, color: r.disagreed ? DANGER : SLATE }}>
        <strong>{r.disagreed}</strong> disagreed
      </span>
      <span style={{ ...cell, color: r.errors ? DANGER : SLATE }}>
        <strong>{r.errors}</strong> could not be priced
      </span>
      <span style={cell}>agreement <strong style={{ color: INK }}>{rate(r.summary && r.summary.agreementRate)}</strong></span>
    </div>
  );
}

/** One disagreeing scenario, with everything the record kept about it. */
function Disagreement({ d }) {
  const dims = Array.isArray(d.dimensions) ? d.dimensions : [];
  const declines = Array.isArray(d.declineMismatch) ? d.declineMismatch : [];
  const cats = Array.isArray(d.categories) ? d.categories : [];
  const stage = rungStage(d.worstRung);
  return (
    <li style={{ marginBottom: 10 }}>
      <div style={{ fontSize: 13, color: INK }}>{scenarioLine(d)}</div>
      <div style={{ fontSize: 12, color: SLATE, marginTop: 2 }}>
        worst gap <strong>{pts(d.worstDeltaMilli)}</strong>
        {cats.length > 0 && <> · on {cats.join(', ')}</>}
        {/* WHERE in the build-up — the half that says a gap is not an LLPA at all. */}
        {stage && <> · diverges at the {stage.name} ({pts(stage.deltaMilli)})</>}
      </div>
      {dims.length > 0 && (
        <ul style={{ margin: '4px 0 0 16px', padding: 0, fontSize: 12, color: SLATE }}>
          {dims.map((x, i) => (
            <li key={i} style={mono}>
              {String(x.dimension || 'an unnamed dimension')}
              {x.rate != null ? ` @ ${x.rate}` : ''} — {pts(x.deltaMilli)} apart
              {x.status ? ` (${x.status})` : ''}
            </li>
          ))}
        </ul>
      )}
      {/* A cap nobody is told about reads as the whole story. */}
      {Number(d.dimensionsOmitted) > 0 && (
        <p style={{ margin: '3px 0 0 16px', fontSize: 12, color: CAUTION }}>
          …and {d.dimensionsOmitted} further dimension{d.dimensionsOmitted === 1 ? '' : 's'} the record
          did not keep for this scenario.
        </p>
      )}
      {d.declineVerdict && (
        <div style={{ fontSize: 12, color: SLATE, marginTop: 3 }}>
          both declined — reasons {String(d.declineVerdict)}
        </div>
      )}
      {declines.length > 0 && (
        <ul style={{ margin: '3px 0 0 16px', padding: 0, fontSize: 12, color: SLATE }}>
          {declines.map((x, i) => (
            <li key={i}>
              {String(x.layer || 'a layer')} · {x.side === 'ours' ? 'only we' : 'only they'} declined
              {x.dimension ? ` on ${String(x.dimension)}` : ''}: “{String(x.reason || '—')}”
            </li>
          ))}
        </ul>
      )}
      {Number(d.declineRowsOmitted) > 0 && (
        <p style={{ margin: '3px 0 0 16px', fontSize: 12, color: CAUTION }}>
          …and {d.declineRowsOmitted} further decline row{d.declineRowsOmitted === 1 ? '' : 's'} not kept.
        </p>
      )}
      {Array.isArray(d.boundsFailed) && d.boundsFailed.length > 0 && (
        <p style={{ margin: '3px 0 0 16px', fontSize: 12, color: DANGER }}>
          bounds not met: {d.boundsFailed.join(', ')}
        </p>
      )}
    </li>
  );
}

/**
 * THE VIEW, on its own, so the loaded states can be RENDERED rather than only described.
 *
 * `renderToString` never runs an effect, so a component that fetches its own data can only ever be
 * tested in its EMPTY state — and the parts worth guarding here are all in the loaded one (the caps,
 * the evidence, the override wording). Splitting the fetch off is what lets the suite hand it a real
 * record and assert on the HTML. It also keeps the presentational half pure: it decides nothing, reads
 * nothing, and cannot fetch.
 */
export function AgreementRecordView({ data, error, open, onToggle }) {
  const v = verdictOf(data);
  const history = (data && Array.isArray(data.history)) ? data.history : [];
  const latest = history[0] || null;
  const summary = (latest && latest.summary) || null;
  const disagreements = (summary && Array.isArray(summary.disagreements)) ? summary.disagreements : [];
  const omitted = Number(summary && summary.disagreementsOmitted) || 0;

  return (
    <div style={{ marginTop: 14 }}>
      <div style={eyebrow}>The Lender Price agreement record</div>

      {error && <p style={{ margin: '6px 0 0', fontSize: 13, color: DANGER }}>{error}</p>}

      {!error && (
        <>
          <p style={{ margin: '6px 0 0', fontSize: 13, color: v.tone, fontWeight: 600 }}>{v.headline}</p>
          {v.hint && <p style={{ margin: '3px 0 0', fontSize: 12, color: MUTED }}>{v.hint}</p>}
          {data && data.minComparableScenarios != null && (
            <p style={{ margin: '3px 0 0', fontSize: 12, color: MUTED }}>
              The gate needs at least {data.minComparableScenarios} comparable scenarios.
            </p>
          )}
        </>
      )}

      {latest && (
        <div style={{ marginTop: 8 }}>
          <div style={{ fontSize: 13, color: INK }}>
            Latest: <strong>{latest.kind === 'override' ? 'an override' : 'a measured run'}</strong>
            {' '}on {whenOf(latest.recordedAt)}
            {latest.recordedBy ? ` by ${latest.recordedBy}` : ''}
          </div>
          {latest.kind === 'override'
            ? (
              <p style={{ margin: '3px 0 0', fontSize: 12, color: CAUTION }}>
                Reason given: {latest.reason || '(none recorded)'} — an override records a decision, not a
                measurement.
              </p>
            )
            : <Counts r={latest} />}
        </div>
      )}

      {disagreements.length > 0 && (
        <div style={{ marginTop: 10 }}>
          <button
            type="button"
            className="btn ghost"
            style={{ fontSize: 12 }}
            onClick={onToggle}
          >
            {open ? 'Hide' : 'Show'} what disagreed ({disagreements.length}
            {omitted > 0 ? ` of ${disagreements.length + omitted}` : ''})
          </button>
          {open && (
            <ul style={{ margin: '8px 0 0 16px', padding: 0 }}>
              {disagreements.map((d, i) => <Disagreement key={i} d={d} />)}
            </ul>
          )}
          {open && omitted > 0 && (
            <p style={{ margin: '4px 0 0', fontSize: 12, color: CAUTION }}>
              {omitted} further disagreeing scenario{omitted === 1 ? '' : 's'} were not kept in this
              record. Re-run the measurement to see them.
            </p>
          )}
        </div>
      )}

      {/* What the row does NOT hold, from the row itself. */}
      {summary && summary.notStored && (
        <p style={{ margin: '8px 0 0', fontSize: 12, color: MUTED }}>{String(summary.notStored)}</p>
      )}

      {history.length > 1 && (
        <details style={{ marginTop: 8 }}>
          <summary style={{ fontSize: 12, color: MUTED, cursor: 'pointer' }}>
            Earlier runs on this version ({history.length - 1})
          </summary>
          <ul style={{ margin: '6px 0 0 16px', padding: 0, fontSize: 12, color: SLATE }}>
            {history.slice(1).map((r) => (
              <li key={r.id} style={{ marginBottom: 4 }}>
                {r.kind === 'override' ? 'override' : 'run'} · {whenOf(r.recordedAt)} ·
                {' '}{r.agreed}/{r.comparable} agreed, {r.disagreed} disagreed, {r.errors} unpriced
              </li>
            ))}
          </ul>
        </details>
      )}

      {data && data.note && (
        <p style={{ ...sub, margin: '8px 0 0', fontSize: 12 }}>{data.note}</p>
      )}
    </div>
  );
}

/**
 * The panel as the console mounts it: reads the record for a version, and renders the view.
 *
 * A read failure is SAID rather than rendered as nothing — an empty panel looks exactly like "never
 * measured", which is a different thing and sends the reader to a different place.
 */
export default function AgreementRecord({ versionId, reloadKey }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [open, setOpen] = useState(false);

  const load = useCallback(() => {
    if (!versionId) { setData(null); setError(''); return; }
    ltApi.ppeRateSheetAgreement(versionId)
      .then((d) => { setData(d); setError(''); })
      .catch((e) => { setData(null); setError(e.message || 'The agreement record could not be read.'); });
  }, [versionId, reloadKey]);

  useEffect(load, [load]);

  if (!versionId) return null;
  return <AgreementRecordView data={data} error={error} open={open} onToggle={() => setOpen((x) => !x)} />;
}
