import React from 'react';

/**
 * One card on a dashboard.
 *
 * Three things this component insists on, because a reporting surface that gets any of
 * them wrong quietly stops being believed:
 *
 *  1. A BROKEN CARD SAYS SO. It never renders 0. A zero that actually means "the query
 *     failed" is indistinguishable from a real zero, and it is the worst possible output.
 *  2. EVERY NUMBER IS CLICKABLE, straight into the files behind it. The server hands the
 *     drill-through the identical predicate it counted with, so the list is the number.
 *  3. EVERY CARD EXPLAINS ITSELF. "How is this worked out" shows the exact filter in plain
 *     English, the date it uses, the period, and whether it was scoped to your own files.
 *
 * Charts are hand-rolled inline SVG — the house style (StaffInsightsDashboard, StaffQueue).
 * There is no chart library in this project and adding one for four shapes would be a poor
 * trade against a 2 MB bundle.
 */

const INK = '#141B22';
const MUTED = '#4B585C';
const GOLD = '#AE8746';
const TEAL = '#2F7F86';
const TEAL_SOFT = '#AECFD1';

const nf = new Intl.NumberFormat('en-US');

function fmt(v, format) {
  if (v == null || Number.isNaN(v)) return '—';
  const n = Number(v);
  switch (format) {
    case 'money':
      if (Math.abs(n) >= 1e6) return '$' + (n / 1e6).toFixed(n >= 1e7 ? 0 : 1) + 'M';
      if (Math.abs(n) >= 1e3) return '$' + Math.round(n / 1e3) + 'k';
      return '$' + nf.format(Math.round(n));
    case 'percent': return n.toFixed(n < 10 ? 1 : 0) + '%';
    case 'days': return nf.format(Math.round(n)) + (Math.round(n) === 1 ? ' day' : ' days');
    case 'number': return n.toFixed(1);
    default: return nf.format(Math.round(n));
  }
}
const fmtFull = (v, format) => (v == null ? '—'
  : format === 'money' ? '$' + nf.format(Math.round(Number(v)))
    : format === 'percent' ? Number(v).toFixed(1) + '%'
      : nf.format(Number(v)));

/** Where a number sits against its red line. Presentation only — the target is a setting. */
function tone(value, target) {
  if (!target || value == null) return null;
  const lower = target.direction !== 'higher_is_better';
  const good = Number(target.good);
  const warn = Number(target.warn);
  if (!isFinite(good) || !isFinite(warn)) return null;
  const v = Number(value);
  if (lower) return v <= good ? 'good' : v <= warn ? 'warn' : 'bad';
  return v >= good ? 'good' : v >= warn ? 'warn' : 'bad';
}
const TONE_COLOR = { good: '#2E7A5E', warn: '#B07A1E', bad: '#A32A2A' };

// How many rows a ranked list actually draws. Shared with the note underneath it, so the
// card can never claim a number different from the one on screen.
const ROWS_DRAWN = 12;

/**
 * Colour for a change against the period before. UP IS NOT AUTOMATICALLY GOOD — days-to-fund
 * climbing is bad news, and painting it green would say the opposite of what happened. The
 * card's own "good is higher / lower" setting decides; with no setting the change is stated
 * in plain ink and left for the reader to judge.
 */
function deltaColor(pct, target) {
  if (!target || !target.direction || !isFinite(pct) || pct === 0) return INK;
  const up = pct > 0;
  const higherIsBetter = target.direction === 'higher_is_better';
  return up === higherIsBetter ? TONE_COLOR.good : TONE_COLOR.bad;
}

function Bars({ series, format, onPick }) {
  const max = Math.max(1, ...series.map((s) => Math.abs(s.value || 0)));
  const n = series.length;
  if (!n) return <p className="muted small" style={{ margin: '10px 0 0' }}>Nothing in this period yet.</p>;
  return (
    <div className="dsh-bars" style={{ display: 'flex', alignItems: 'flex-end', gap: n > 20 ? 2 : 6, height: 96, marginTop: 12, overflowX: 'auto' }}>
      {series.map((s, i) => {
        const h = Math.max(3, Math.round((Math.abs(s.value || 0) / max) * 84));
        const last = i === n - 1;
        return (
          <button key={s.key} type="button" className="dsh-bar" onClick={onPick ? () => onPick(s) : undefined}
            title={`${s.key}: ${fmtFull(s.value, format)}${s.matched != null ? ` · ${s.matched} file${s.matched === 1 ? '' : 's'}` : ''}`}
            style={{ flex: '1 0 auto', minWidth: n > 20 ? 8 : 22, border: 0, padding: 0, background: 'none',
              cursor: onPick ? 'pointer' : 'default', display: 'flex', flexDirection: 'column',
              justifyContent: 'flex-end', height: '100%' }}>
            <span style={{ display: 'block', height: h, background: last ? GOLD : TEAL_SOFT, borderRadius: '2px 2px 0 0' }} />
            {n <= 14 && <span style={{ fontSize: 9, color: MUTED, marginTop: 4, whiteSpace: 'nowrap' }}>{String(s.key).slice(-5)}</span>}
          </button>
        );
      })}
    </div>
  );
}

function Rows({ series, format, onPick }) {
  const max = Math.max(1, ...series.map((s) => Math.abs(s.value || 0)));
  if (!series.length) return <p className="muted small" style={{ margin: '10px 0 0' }}>Nothing to show yet.</p>;
  return (
    <div style={{ marginTop: 10, display: 'flex', flexDirection: 'column', gap: 6 }}>
      {series.slice(0, ROWS_DRAWN).map((s) => (
        <button key={s.key} type="button" onClick={onPick ? () => onPick(s) : undefined}
          style={{ border: 0, background: 'none', padding: 0, textAlign: 'left', cursor: onPick ? 'pointer' : 'default' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13, color: INK, marginBottom: 3 }}>
            <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: '65%' }}>{s.key}</span>
            <span style={{ fontVariantNumeric: 'tabular-nums', color: MUTED }}>{fmt(s.value, format)}</span>
          </div>
          <span style={{ display: 'block', height: 5, borderRadius: 3, background: '#EBE6DA' }}>
            <span style={{ display: 'block', height: 5, borderRadius: 3, width: `${Math.max(2, (Math.abs(s.value || 0) / max) * 100)}%`, background: TEAL }} />
          </span>
        </button>
      ))}
    </div>
  );
}

export default function DashboardCard({ answer, onDrill, onEdit, editable }) {
  const [open, setOpen] = React.useState(false);
  if (!answer) return null;

  const hero = answer.band === 'hero';
  const t = tone(answer.value, answer.target);

  // A failed card is a failed card. Never a zero.
  if (!answer.ok) {
    return (
      <div className="panel dsh-card dsh-card-bad">
        <div className="dsh-card-h"><b>{answer.title}</b></div>
        <p className="small" style={{ color: '#A32A2A', margin: '6px 0 0' }}>{answer.error}</p>
        {editable && <button className="btn ghost small" style={{ marginTop: 8 }} onClick={onEdit}>Fix this card</button>}
      </div>
    );
  }

  const body = () => {
    if (answer.series) {
      const Chart = answer.viz === 'trend' ? Bars : Rows;
      return (
        <>
          <Chart series={answer.series} format={answer.format} onPick={onDrill ? (s) => onDrill(s) : undefined} />
          {/* Describe WHAT IS DRAWN, not what was fetched. A ranked list draws 12 rows
              however many buckets came back, and a trend keeps the EARLIEST periods
              (ORDER BY bucket ASC) — so "showing the biggest 20" over 12 rows of oldest
              months was wrong twice over. The note also has to appear when the list is
              merely longer than the 12 it draws, cap or no cap. */}
          {/* TWO different things decide this sentence, and they do not always travel
              together, so they are read separately:
                · HOW MANY ARE DRAWN is decided by the chart — Bars draws every bucket,
                  Rows draws ROWS_DRAWN of them.
                · HOW THEY WERE CHOSEN is decided by `grain` — the compiler orders time
                  buckets ascending and everything else by size.
              Keying the whole sentence on `viz` called a by-city chart "the first N
              periods"; keying it all on `grain` would have miscounted the rows drawn. */}
          {(() => {
            const drawn = answer.viz === 'trend' ? answer.series.length
              : Math.min(ROWS_DRAWN, answer.series.length);
            if (!answer.truncated && drawn >= answer.series.length) return null;
            return (
              <p className="small" style={{ color: MUTED, margin: '8px 0 0' }}>
                {/* Both wordings state the TOTAL as well as the drawn count — a note whose
                    only job is to say what is hidden must not omit how much. */}
                {answer.grain
                  ? `Showing the first ${drawn} of ${answer.series.length}${answer.truncated ? '+' : ''} periods.`
                  : `Showing the top ${drawn} of ${answer.series.length}${answer.truncated ? '+' : ''}.`}
              </p>
            );
          })()}
        </>
      );
    }
    return (
      <button type="button" onClick={onDrill ? () => onDrill(null) : undefined}
        style={{ border: 0, background: 'none', padding: 0, textAlign: 'left', cursor: onDrill ? 'pointer' : 'default', width: '100%' }}>
        <div style={{ fontSize: hero ? 34 : 27, fontWeight: 600, lineHeight: 1.05, letterSpacing: '-.02em',
          color: t ? TONE_COLOR[t] : INK, fontVariantNumeric: 'tabular-nums', marginTop: 6 }}>
          {fmt(answer.value, answer.format)}
          {answer.target && answer.target.unit && answer.value != null
            && <span style={{ fontSize: 13, color: MUTED, fontWeight: 400 }}>{answer.target.unit === '%' ? '' : answer.target.unit}</span>}
        </div>
        {answer.denominator != null && (
          <div className="small" style={{ color: MUTED, marginTop: 2 }}>
            {nf.format(answer.numerator)} of {nf.format(answer.denominator)}
          </div>
        )}
        {answer.matched != null && answer.denominator == null && (
          <div className="small" style={{ color: MUTED, marginTop: 2 }}>
            {nf.format(answer.matched)} file{answer.matched === 1 ? '' : 's'}
          </div>
        )}
        {answer.compare && answer.compare.value != null && (
          // Both figures, always — the percentage is the summary, the old number is the
          // evidence. Green/red is deliberately read off the card's own "good is higher /
          // lower" setting rather than assuming up is good: rising days-to-fund is bad.
          <div className="small" style={{ color: MUTED, marginTop: 4 }}>
            {answer.compare.deltaPct == null ? null : (
              <b style={{ color: deltaColor(answer.compare.deltaPct, answer.target) }}>
                {answer.compare.deltaPct >= 0 ? '▲' : '▼'}{' '}
                {Math.abs(answer.compare.deltaPct).toFixed(answer.compare.deltaPct >= 10 ? 0 : 1)}%{' '}
              </b>
            )}
            vs {fmt(answer.compare.value, answer.format)} {answer.compare.label}
          </div>
        )}
      </button>
    );
  };

  return (
    <div className={`panel dsh-card${hero ? ' dsh-hero' : ''}`}>
      <div className="dsh-card-h">
        <b style={{ color: INK }}>{answer.title}</b>
        <span className="spacer" />
        {editable && <button className="btn link small" onClick={onEdit} title="Change this card">Edit</button>}
      </div>
      {answer.subtitle && <div className="small" style={{ color: MUTED, marginTop: -2 }}>{answer.subtitle}</div>}
      {body()}

      {/* A partly-populated column says so on its face rather than passing off half the
          book as the whole of it. */}
      {answer.coverage && answer.coverage.partial && (
        <div className="small" style={{ color: '#B07A1E', marginTop: 8 }}>
          Based on {nf.format(answer.coverage.covered)} of {nf.format(answer.coverage.of)} files — the rest have no value recorded.
        </div>
      )}
      {answer.explain && answer.explain.cohort && (
        <div className="small" style={{ color: MUTED, marginTop: 6 }}>
          Counted from when each file came in, so a recent period is still settling.
        </div>
      )}

      <button type="button" className="btn link small dsh-explain-t" onClick={() => setOpen((v) => !v)}
        style={{ marginTop: 10, padding: 0 }}>
        {open ? 'Hide' : 'How is this worked out?'}
      </button>
      {open && answer.explain && (
        <div className="dsh-explain">
          <div><span className="dsh-k">Measures</span><span>{answer.explain.measure}</span></div>
          <div><span className="dsh-k">Files</span><span>{answer.explain.filter}</span></div>
          {answer.explain.dateField && <div><span className="dsh-k">Using the date</span><span>{answer.explain.dateField}</span></div>}
          <div><span className="dsh-k">Period</span><span>{answer.explain.period}</span></div>
          {answer.explain.groupedBy && <div><span className="dsh-k">Broken down by</span><span>{answer.explain.groupedBy}</span></div>}
          {answer.explain.comparisonStored && (
            // The reason comes from the server, which owns the branches — a sentence written
            // here could only ever be one of them, and would contradict the rows above it.
            <div><span className="dsh-k">Compared with</span>
              <span>{answer.explain.compared || answer.explain.comparisonBlocked || 'nothing'}</span></div>
          )}
          <div><span className="dsh-k">Whose files</span>
            <span>{answer.explain.scoped ? 'only the files you can see' : 'every file in the company'}</span></div>
          {answer.explain.measureNote && <div><span className="dsh-k">Note</span><span>{answer.explain.measureNote}</span></div>}
          {answer.explain.sql && (
            <details style={{ marginTop: 6 }}>
              <summary className="small" style={{ cursor: 'pointer', color: MUTED }}>Show the exact query</summary>
              <pre style={{ fontSize: 10.5, overflowX: 'auto', background: '#F4F1EA', padding: 8, borderRadius: 3, marginTop: 6 }}>{answer.explain.sql}</pre>
            </details>
          )}
        </div>
      )}
    </div>
  );
}
