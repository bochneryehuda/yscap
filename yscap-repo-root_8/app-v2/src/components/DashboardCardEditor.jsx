import React from 'react';
import RuleBuilder, { emptyGroup } from './RuleBuilder.jsx';
import { api } from '../lib/api.js';

/**
 * Building or changing one card.
 *
 * Four questions, in the order a person actually thinks about them:
 *   what am I measuring · which files · over what time · how should it look
 *
 * The condition builder is the SAME `RuleBuilder` the Condition Center uses. It is fed a
 * dashboard field catalogue from `GET /api/dashboards/meta`, which is why a field added to
 * the server registry shows up here with no front-end change — and why this screen can
 * never offer an operator the server would refuse.
 *
 * The preview runs the REAL query through the REAL endpoint before anything is saved, so
 * "will this work" is answered by the thing that will answer it later, not by a guess.
 */

const MUTED = '#4B585C';
const INK = '#141B22';

const PERIODS = [
  { v: 'all', label: 'All time' },
  { v: 'mtd', label: 'This month so far' },
  { v: 'this_month', label: 'This whole month' },
  { v: 'last_month', label: 'Last month' },
  { v: 'qtd', label: 'This quarter so far' },
  { v: 'ytd', label: 'This year so far' },
  { v: 'last_days', label: 'The last N days' },
  { v: 'last_months', label: 'The last N months' },
  { v: 'fixed', label: 'Between two dates' },
];

// The two periods that carry a "how many", and the number both the box and the draft use.
const NEEDS_N = ['last_days', 'last_months'];
const DEFAULT_N = 12;
// The SAME rule the server validates against (store.validateCard), so "will this save?" and
// "should I seed a default?" can never disagree. Note it deliberately rejects null, '' and 0
// — all three are values a naive Number.isInteger check would wave through.
const nOk = (n) => Number.isInteger(Number(n)) && n !== null && n !== ''
  && Number(n) >= 1 && Number(n) <= 3650;

const VIZ = [
  { v: 'number', label: 'A big number' },
  { v: 'trend', label: 'A trend over time' },
  { v: 'breakdown', label: 'A breakdown by something' },
  { v: 'table', label: 'A ranked list' },
];

export default function DashboardCardEditor({ meta, card, onSave, onCancel, onDelete }) {
  const [draft, setDraft] = React.useState(() => {
    const d = {
      title: '', subtitle: '', viz: 'number', metric_key: 'file_count',
      filter: null, date_field: '', period: { kind: 'all' }, group_by: '', grain: '',
      band: 'body', width: 'one', target: null, ...(card || {}),
    };
    // SEED ON OPEN, for the same reason the dropdown seeds on change: the "How many?" box
    // is about to DISPLAY a number, so the draft has to carry it. A card stored with no
    // "how many" is a legal state (the server defaults it to 30), and such cards already
    // exist — opening one showed 12 in the box over a query that used 30, which is the
    // screen-and-card disagreement this editor was just fixed to stop.
    if (NEEDS_N.includes(d.period && d.period.kind) && !nOk(d.period.n)) {
      d.period = { ...d.period, n: DEFAULT_N };
    }
    return d;
  });
  const [preview, setPreview] = React.useState(null);
  const [busy, setBusy] = React.useState(false);
  const [err, setErr] = React.useState('');
  const seq = React.useRef(0);

  const set = (patch) => setDraft((d) => ({ ...d, ...patch }));

  // Live preview, debounced, last-request-wins.
  React.useEffect(() => {
    const mine = ++seq.current;
    const t = setTimeout(() => {
      const body = { ...draft };
      if (!body.date_field) { delete body.date_field; body.period = { kind: 'all' }; }
      if (!body.group_by) delete body.group_by;
      if (!body.grain) delete body.grain;
      api.dashboardPreview(body)
        .then((r) => { if (seq.current === mine) { setPreview(r); setErr(r && r.ok === false ? r.error : ''); } })
        .catch((e) => { if (seq.current === mine) { setPreview(null); setErr(e.message || 'Could not try that out'); } });
    }, 400);
    return () => clearTimeout(t);
  }, [draft]);

  const isTrend = draft.viz === 'trend';
  const isBreakdown = draft.viz === 'breakdown' || draft.viz === 'table';

  async function save() {
    setBusy(true); setErr('');
    try {
      const body = { ...draft };
      if (!body.date_field) { delete body.date_field; body.period = { kind: 'all' }; }
      if (!body.group_by) body.group_by = null;
      if (!body.grain) body.grain = null;
      await onSave(body);
    } catch (e) {
      setErr(e.message || 'Could not save that card');
    } finally { setBusy(false); }
  }

  return (
    <div className="dsh-editor">
      <div className="dsh-ed-grid">
        <label className="field"><span>What should the card be called?</span>
          <input className="input" value={draft.title} maxLength={120}
            placeholder="Funded this month" onChange={(e) => set({ title: e.target.value })} /></label>
        <label className="field"><span>A line underneath (optional)</span>
          <input className="input" value={draft.subtitle || ''} maxLength={160}
            placeholder="against last year" onChange={(e) => set({ subtitle: e.target.value })} /></label>
      </div>

      <h4 style={{ color: MUTED }}>1 · What are we measuring?</h4>
      <div className="dsh-ed-grid">
        <label className="field"><span>Measure</span>
          <select className="input" value={draft.metric_key} onChange={(e) => set({ metric_key: e.target.value })}>
            {(meta.measures || []).map((m) => <option key={m.key} value={m.key}>{m.label}</option>)}
          </select></label>
        <label className="field"><span>How should it look?</span>
          <select className="input" value={draft.viz}
            onChange={(e) => {
              // CHANGING THE SHAPE CLEARS WHAT THE NEW SHAPE CANNOT USE. Leaving those
              // settings behind is how a card ends up in a state its own editor can no
              // longer reach: switching back to "A big number" kept a group_by, so a card
              // saved as a big number rendered as a ranked list; and switching to a
              // breakdown kept a comparison while hiding the control that could remove it.
              const viz = e.target.value;
              const isTimeline = viz === 'trend';
              const isBuckets = ['trend', 'breakdown', 'table'].includes(viz);
              set({
                viz,
                grain: isTimeline ? (draft.grain || 'month') : '',
                group_by: isTimeline || !isBuckets ? '' : draft.group_by,
                compare: isBuckets ? null : draft.compare,
              });
            }}>
            {VIZ.map((v) => <option key={v.v} value={v.v}>{v.label}</option>)}
          </select></label>
      </div>

      <h4 style={{ color: MUTED }}>2 · Which files should it count?</h4>
      <RuleBuilder meta={meta} value={draft.filter || emptyGroup(meta.fields)}
        onChange={(filter) => set({ filter })} />
      <button type="button" className="btn link small" onClick={() => set({ filter: null })}
        style={{ marginTop: 6 }}>Count every file (clear the conditions)</button>

      <h4 style={{ color: MUTED }}>3 · Over what time?</h4>
      <div className="dsh-ed-grid">
        <label className="field"><span>Which date drives it</span>
          <select className="input" value={draft.date_field || ''}
            onChange={(e) => set({ date_field: e.target.value })}>
            <option value="">No date — count everything</option>
            {(meta.dateFields || []).map((d) => <option key={d.key} value={d.key}>{d.label}</option>)}
          </select></label>
        <label className="field"><span>Period</span>
          <select className="input" disabled={!draft.date_field}
            value={(draft.period && draft.period.kind) || 'all'}
            onChange={(e) => {
              // SEED THE NUMBER THE BOX IS ABOUT TO DISPLAY. Picking "the last N days" used
              // to set only the kind, so the "How many?" box showed 12 while the card
              // carried no number at all — the screen and the draft disagreed, and the save
              // was then refused over a value that visibly read 12.
              const kind = e.target.value;
              const period = { ...(draft.period || {}), kind };
              if (NEEDS_N.includes(kind) && !Number.isInteger(Number(period.n))) period.n = DEFAULT_N;
              set({ period });
            }}>
            {PERIODS.map((p) => <option key={p.v} value={p.v}>{p.label}</option>)}
          </select></label>
        {NEEDS_N.includes(draft.period && draft.period.kind) && (
          <label className="field"><span>How many?</span>
            {/* An emptied box falls back to the same number it then shows, so clearing it
                can never leave the card in a state the screen does not reflect. */}
            {/* NOT `|| DEFAULT_N` — 0 is falsy, so typing a zero left the draft holding 0
                while the box painted 12, and the save was then refused over a number the
                person could not see. Show what the draft actually holds. */}
            <input className="input" type="number" min="1" max="3650"
              value={draft.period && draft.period.n != null && draft.period.n !== ''
                ? draft.period.n : DEFAULT_N}
              onChange={(e) => set({
                period: { ...draft.period, n: e.target.value === '' ? DEFAULT_N : Number(e.target.value) },
              })} /></label>
        )}
        {draft.period && draft.period.kind === 'fixed' && (
          <>
            <label className="field"><span>From</span>
              <input className="input" type="date" value={(draft.period && draft.period.from) || ''}
                onChange={(e) => set({ period: { ...draft.period, from: e.target.value } })} /></label>
            <label className="field"><span>To</span>
              <input className="input" type="date" value={(draft.period && draft.period.to) || ''}
                onChange={(e) => set({ period: { ...draft.period, to: e.target.value } })} /></label>
          </>
        )}
        {/* A comparison is only drawn on a single number over a real period, so the control
            appears exactly when it can do something — and it can always be turned back OFF,
            which the shipped company cards need (they arrive with one already set). */}
        {!isTrend && !isBreakdown && draft.date_field
          && ((draft.period && draft.period.kind) || 'all') !== 'all' && (
          <label className="field"><span>Compare against</span>
            <select className="input" value={(draft.compare && draft.compare.kind) || ''}
              onChange={(e) => set({ compare: e.target.value ? { kind: e.target.value } : null })}>
              <option value="">Don&apos;t compare</option>
              <option value="prior_period">The period before</option>
              <option value="prior_year">The same period a year ago</option>
            </select></label>
        )}
        {isTrend && (
          <label className="field"><span>Group the trend by</span>
            <select className="input" value={draft.grain || 'month'} onChange={(e) => set({ grain: e.target.value })}>
              {(meta.timeGrains || []).map((g) => <option key={g.key} value={g.key}>{g.label}</option>)}
            </select></label>
        )}
        {isBreakdown && (
          <label className="field"><span>Break it down by</span>
            <select className="input" value={draft.group_by || ''} onChange={(e) => set({ group_by: e.target.value })}>
              <option value="">Pick something…</option>
              {(meta.dimensions || []).map((d) => <option key={d.key} value={d.key}>{d.label}</option>)}
            </select></label>
        )}
      </div>

      <h4 style={{ color: MUTED }}>4 · Where does it sit, and what is a good number?</h4>
      <div className="dsh-ed-grid">
        <label className="field"><span>Position</span>
          <select className="input" value={draft.band} onChange={(e) => set({ band: e.target.value })}>
            <option value="hero">Top row (the headline numbers)</option>
            <option value="body">Below the top row</option>
          </select></label>
        <label className="field"><span>Width</span>
          <select className="input" value={draft.width} onChange={(e) => set({ width: e.target.value })}>
            <option value="one">Normal</option><option value="two">Double</option><option value="full">Full width</option>
          </select></label>
        <label className="field"><span>Good is…</span>
          <select className="input" value={(draft.target && draft.target.direction) || ''}
            onChange={(e) => set({ target: e.target.value ? { ...(draft.target || {}), direction: e.target.value } : null })}>
            <option value="">No red line on this card</option>
            <option value="higher_is_better">Higher</option>
            <option value="lower_is_better">Lower</option>
          </select></label>
        {draft.target && draft.target.direction && (
          <>
            <label className="field"><span>Green up to / from</span>
              <input className="input" type="number" value={draft.target.good ?? ''}
                onChange={(e) => set({ target: { ...draft.target, good: Number(e.target.value) } })} /></label>
            <label className="field"><span>Amber up to / from</span>
              <input className="input" type="number" value={draft.target.warn ?? ''}
                onChange={(e) => set({ target: { ...draft.target, warn: Number(e.target.value) } })} /></label>
          </>
        )}
      </div>

      <div className="dsh-ed-preview">
        <div className="small" style={{ color: MUTED, marginBottom: 6 }}>What it will show, on your real numbers right now:</div>
        {err && <div className="notice err small">{err}</div>}
        {!err && preview && preview.ok && (
          <div style={{ color: INK }}>
            <b style={{ fontSize: 22 }}>
              {preview.series ? `${preview.series.length} group${preview.series.length === 1 ? '' : 's'}`
                : preview.value == null ? '—' : String(preview.value)}
            </b>
            <div className="small" style={{ color: MUTED, marginTop: 4 }}>{preview.explain && preview.explain.filter}</div>
          </div>
        )}
        {!err && !preview && <span className="muted small">Working it out…</span>}
      </div>

      <div className="row" style={{ gap: 8, marginTop: 14 }}>
        <button className="btn primary" onClick={save} disabled={busy || !draft.title}>
          {busy ? 'Saving…' : 'Save this card'}
        </button>
        <button className="btn ghost" onClick={onCancel}>Cancel</button>
        <span className="spacer" />
        {onDelete && <button className="btn ghost small" style={{ color: 'var(--danger)' }} onClick={onDelete}>Remove this card</button>}
      </div>
    </div>
  );
}
