import React, { useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../lib/api.js';
import { useUrlState } from '../lib/useUrlState.js';
import { showMessage, askConfirm, askPrompt } from '../lib/dialog.js';

/**
 * THE REPORTING DATABASE — layer 2 (owner-directed 2026-08-29: "Build the next
 * layer — totals, or-logic, more fields, scheduled reports … it should come up
 * with a dropdown of those fields everywhere … enhance it and make it more
 * user-friendly and simple").
 *
 * The research this layout copies (Encompass RDB + the filter-group builders
 * people already know — HubSpot lists, Metabase questions):
 *  · FILTER GROUPS: rows AND within a group, groups OR'd — "all of these, OR
 *    all of those" reads naturally where free-form parentheses do not.
 *  · VALUE DROPDOWNS: a faceted field's values come from the LIVE data
 *    (busiest first, with counts), typed into a datalist so typing filters
 *    the list — never a value remembered wrong.
 *  · TWO ANSWER SHAPES on one filter set: the LIST of files, or TOTALS
 *    (group by a field, count/sum/average) — same filters, same join, so the
 *    two can never disagree about which files are in the report.
 *  · SORT BY ANY COLUMN by clicking its header.
 *  · QUICK STARTS: one-click starting points for the reports the desk
 *    actually runs, editable after loading.
 *
 * HARD RULE: dark text on the white canvas — explicit hexes, never --ink*.
 */
const INK = '#141B22';
const MUTED = '#4B585C';
const LINE = '#E3DCCB';
const SOFTBG = '#FBF7EC';

const OP_LABEL = {
  eq: 'is', neq: 'is not', contains: 'contains', not_contains: "doesn't contain",
  starts_with: 'starts with', is_empty: 'is empty', not_empty: 'is not empty',
  in: 'is one of', not_in: 'is none of',
  gt: 'more than', gte: 'at least', lt: 'less than', lte: 'at most', between: 'between',
  on: 'on', before: 'before', after: 'after',
  is_true: 'is yes', is_false: 'is no',
};
const NO_VALUE_OPS = new Set(['is_empty', 'not_empty', 'is_true', 'is_false']);
const NUMY = new Set(['money', 'number', 'pct']);
const DATEY = new Set(['date', 'timestamp']);
const FN_LABEL = { count: 'Count of files', sum: 'Total of', avg: 'Average of', min: 'Lowest', max: 'Highest' };

function fmtCell(field, v) {
  if (v == null || v === '') return '—';
  const t = field ? field.type : null;
  if (t === 'boolean') return v === true ? 'Yes' : 'No';
  if (t === 'money') {
    const n = Number(v);
    return isFinite(n) ? n.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }) : String(v);
  }
  if (t === 'pct') { const n = Number(v); return isFinite(n) ? `${n}%` : String(v); }
  if (t === 'number') { const n = Number(v); return isFinite(n) ? n.toLocaleString() : String(v); }
  if (DATEY.has(t)) return String(v).slice(0, 10);
  return String(v);
}

const MODE_VALUES = ['list', 'totals'];   // stable identity — the hook memoizes on `allow`
let seq = 1;
const blankFilter = () => ({ _k: seq++, field: '', op: '', value: '', value2: '' });
const blankGroup = () => ({ _k: seq++, rows: [blankFilter()] });

const QUICK_STARTS = [
  {
    label: 'Funded, not yet sold',
    def: {
      groups: [[{ field: 'file_status', op: 'eq', value: 'funded' }, { field: 'sold_at', op: 'is_empty' }]],
      columns: ['ys_loan_number', 'borrower_name', 'investor', 'loan_amount', 'funded_date', 'loan_officer'],
      sort: { field: 'funded_date', dir: 'asc' },
    },
  },
  {
    label: 'Closing this month',
    def: (() => {
      const d = new Date(); const y = d.getFullYear(); const m = String(d.getMonth() + 1).padStart(2, '0');
      const last = new Date(y, d.getMonth() + 1, 0).getDate();
      return {
        groups: [[{ field: 'expected_closing_any', op: 'between', value: [`${y}-${m}-01`, `${y}-${m}-${last}`] }]],
        columns: ['ys_loan_number', 'borrower_name', 'expected_closing_any', 'file_status', 'loan_amount', 'investor', 'loan_officer'],
        sort: { field: 'expected_closing_any', dir: 'asc' },
      };
    })(),
  },
  {
    label: 'Totals by investor',
    def: {
      groups: [[{ field: 'file_status', op: 'in', value: ['approved', 'clear_to_close', 'funded'] }]],
      summarize: { groupBy: ['investor'], metrics: [{ fn: 'count' }, { fn: 'sum', field: 'loan_amount' }] },
    },
  },
  {
    label: 'Pipeline by status',
    def: { groups: [], summarize: { groupBy: ['file_status'], metrics: [{ fn: 'count' }, { fn: 'sum', field: 'loan_amount' }, { fn: 'avg', field: 'deal_fico' }] } },
  },
];

export default function StaffReports() {
  const [fields, setFields] = useState([]);
  const [saved, setSaved] = useState([]);
  const [groups, setGroups] = useState([blankGroup()]);
  const [columns, setColumns] = useState(['ys_loan_number', 'borrower_name', 'property_address', 'file_status', 'loan_amount', 'loan_officer']);
  const [sortField, setSortField] = useState('');
  const [sortDir, setSortDir] = useState('desc');
  const [mode, setMode] = useUrlState('view', 'list', { remember: 'reports.view', allow: MODE_VALUES });
  const [groupBy, setGroupBy] = useState(['investor']);
  const [metrics, setMetrics] = useState([{ _k: seq++, fn: 'count', field: '' }]);
  const [result, setResult] = useState(null);
  const [running, setRunning] = useState(false);
  const [err, setErr] = useState('');
  const [openReport, setOpenReport] = useState(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [schedFor, setSchedFor] = useState(null);           // report id whose schedule panel is open
  const valueCache = useRef(new Map());                     // fieldKey -> [{v,n}]
  const [, bumpCache] = useState(0);

  const byKey = useMemo(() => new Map(fields.map((f) => [f.key, f])), [fields]);
  const grouped = useMemo(() => {
    const g = new Map();
    for (const f of fields) { if (!g.has(f.group)) g.set(f.group, []); g.get(f.group).push(f); }
    return [...g.entries()];
  }, [fields]);
  const numericFields = useMemo(() => fields.filter((f) => f.numeric), [fields]);

  useEffect(() => {
    api.reportFields().then((r) => setFields(r.fields || [])).catch((e) => setErr(e.message));
    reloadSaved();
  }, []);
  const reloadSaved = () => api.reportSavedList().then((r) => setSaved(r.reports || [])).catch(() => {});

  // Live value dropdown: fetched once per field, cached for the visit.
  const ensureValues = (key) => {
    const f = byKey.get(key);
    if (!f || !f.facet || valueCache.current.has(key)) return;
    valueCache.current.set(key, []);   // in flight
    api.reportFieldValues(key)
      .then((r) => { valueCache.current.set(key, r.values || []); bumpCache((n) => n + 1); })
      .catch(() => { valueCache.current.delete(key); });
  };

  const definition = () => ({
    groups: groups.map((g) => g.rows
      .filter((f) => f.field && f.op)
      .map((f) => ({
        field: f.field, op: f.op,
        value: f.op === 'between' ? [f.value, f.value2]
          : (f.op === 'in' || f.op === 'not_in') ? String(f.value).split(',').map((s) => s.trim()).filter(Boolean)
            : f.value,
      }))).filter((g) => g.length),
    columns,
    sort: sortField ? { field: sortField, dir: sortDir } : null,
    summarize: mode === 'totals'
      ? {
        groupBy: groupBy.filter(Boolean),
        metrics: metrics.map((m) => m.fn === 'count' ? { fn: 'count' } : { fn: m.fn, field: m.field }).filter((m) => m.fn === 'count' || m.field),
      }
      : null,
  });

  const run = async (defOverride) => {
    setErr(''); setRunning(true);
    try { setResult(await api.reportRun(defOverride || definition())); }
    catch (e) { setErr(e.message); }
    finally { setRunning(false); }
  };

  // Clicking a results header sorts by that column and re-runs.
  const sortBy = (key) => {
    const dir = sortField === key && sortDir === 'desc' ? 'asc' : 'desc';
    setSortField(key); setSortDir(dir);
    run({ ...definition(), sort: { field: key, dir } });
  };

  const exportXlsx = async () => {
    setErr('');
    try { await api.reportExportXlsx({ ...definition(), name: openReport?.name || 'Report' }); }
    catch (e) { setErr(e.message); }
  };

  const loadDefinition = (d) => {
    const gs = Array.isArray(d.groups) && d.groups.length
      ? d.groups.map((g) => (Array.isArray(g) ? g : (g?.filters || [])))
      : (Array.isArray(d.filters) && d.filters.length ? [d.filters] : [[]]);
    setGroups(gs.map((g) => ({
      _k: seq++,
      rows: (g.length ? g : [null]).map((f) => f ? ({
        _k: seq++, field: f.field, op: f.op,
        value: Array.isArray(f.value) ? (f.op === 'between' ? String(f.value[0] ?? '') : f.value.join(', ')) : String(f.value ?? ''),
        value2: Array.isArray(f.value) && f.op === 'between' ? String(f.value[1] ?? '') : '',
      }) : blankFilter()),
    })));
    if (Array.isArray(d.columns) && d.columns.length) setColumns(d.columns);
    setSortField(d.sort?.field || ''); setSortDir(d.sort?.dir === 'asc' ? 'asc' : 'desc');
    if (d.summarize && Array.isArray(d.summarize.groupBy) && d.summarize.groupBy.length) {
      setMode('totals');
      setGroupBy(d.summarize.groupBy);
      setMetrics((d.summarize.metrics || [{ fn: 'count' }]).map((m) => ({ _k: seq++, fn: m.fn, field: m.field || '' })));
    } else { setMode('list'); }
    setResult(null); setErr('');
  };

  const save = async (asNew) => {
    const name = await askPrompt('Report name:', {
      defaultValue: openReport && !asNew ? openReport.name : '', title: 'Save report',
    });
    if (name == null || !String(name).trim()) return;
    try {
      const body = { name: String(name).trim(), definition: definition() };
      const r = openReport && !asNew
        ? await api.reportUpdate(openReport.id, body)
        : await api.reportSave(body);
      setOpenReport(r.report); reloadSaved();
      showMessage('Report saved. Anyone on the admin team can open it — and you can put it on an email schedule from the Saved reports list.');
    } catch (e) { showMessage(e.message, { title: 'Could not save' }); }
  };

  const removeSaved = async (r) => {
    if (!(await askConfirm(`Delete the saved report "${r.name}"? Loan files are not touched — only the saved layout${r.schedule ? ' and its email schedule' : ''}.`))) return;
    try { await api.reportDelete(r.id); if (openReport?.id === r.id) setOpenReport(null); reloadSaved(); }
    catch (e) { showMessage(e.message, { title: 'Could not delete' }); }
  };

  const setRow = (gk, k, patch) => setGroups((gs) => gs.map((g) => g._k !== gk ? g
    : { ...g, rows: g.rows.map((f) => f._k === k ? { ...f, ...patch } : f) }));

  const toggleCol = (key) => setColumns((cs) => cs.includes(key) ? cs.filter((c) => c !== key) : [...cs, key]);

  const fieldSelect = (value, onChange, { blank = '— pick a field —', only } = {}) => (
    <select className="input" value={value} onChange={(e) => onChange(e.target.value)} style={{ color: INK, maxWidth: 240 }}>
      <option value="">{blank}</option>
      {grouped.map(([g, fs]) => {
        const list = only ? fs.filter(only) : fs;
        return list.length ? (
          <optgroup key={g} label={g}>
            {list.map((f) => <option key={f.key} value={f.key}>{f.label}</option>)}
          </optgroup>
        ) : null;
      })}
    </select>
  );

  const valueInput = (gk, f, field) => {
    if (!field || NO_VALUE_OPS.has(f.op)) return null;
    const type = DATEY.has(field.type) ? 'date' : NUMY.has(field.type) ? 'number' : 'text';
    const vals = field.facet ? (valueCache.current.get(field.key) || []) : [];
    const listId = field.facet ? `vals-${field.key}` : undefined;
    const inputEl = (val, onCh, placeholder) => (
      <input className="input" type={type} value={val} list={listId} placeholder={placeholder}
        onFocus={() => ensureValues(field.key)}
        onChange={(e) => onCh(e.target.value)} style={{ color: INK, minWidth: 170 }} />
    );
    return (
      <>
        {inputEl(f.value, (v) => setRow(gk, f._k, { value: v }),
          (f.op === 'in' || f.op === 'not_in') ? 'value, value, value' : field.facet ? 'pick or type…' : 'value')}
        {f.op === 'between' && inputEl(f.value2, (v) => setRow(gk, f._k, { value2: v }), 'and')}
        {listId && (
          <datalist id={listId}>
            {vals.map((x) => <option key={x.v} value={x.v}>{x.n != null ? `${x.n} file${x.n === 1 ? '' : 's'}` : ''}</option>)}
          </datalist>
        )}
      </>
    );
  };

  const summaryCols = result?.mode === 'summary' ? [...result.groupBy, ...result.metrics] : null;

  return (
    <div className="wrap" style={{ color: INK }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 12, flexWrap: 'wrap' }}>
        <h1 style={{ margin: '6px 0', color: INK }}>Reports</h1>
        <div style={{ color: MUTED, fontSize: 13 }}>
          Pick the files, pick the columns or the totals, run it — save it, schedule it, export it to Excel.
        </div>
      </div>

      {/* Quick starts */}
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 8 }}>
        <span style={{ fontSize: 11, textTransform: 'uppercase', letterSpacing: '.06em', color: MUTED, alignSelf: 'center' }}>Quick starts</span>
        {QUICK_STARTS.map((q) => (
          <button key={q.label} type="button" className="btn soft" style={{ color: INK }}
            onClick={() => { setOpenReport(null); loadDefinition(q.def); }}>{q.label}</button>
        ))}
      </div>

      {/* Saved reports */}
      <div className="card" style={{ marginTop: 10 }}>
        <div style={{ fontWeight: 700, color: INK, marginBottom: 6 }}>Saved reports</div>
        {!saved.length && <div style={{ color: MUTED, fontSize: 13 }}>Nothing saved yet. Build a report below and press Save.</div>}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          {saved.map((r) => (
            <div key={r.id} style={{ border: `1px solid ${LINE}`, borderRadius: 8, padding: '6px 10px', background: openReport?.id === r.id ? SOFTBG : '#fff' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                <button type="button" className="btn ghost" style={{ padding: '2px 6px', color: INK, fontWeight: 650 }}
                  onClick={() => { setOpenReport(r); loadDefinition(r.definition || {}); }}
                  title={r.description || `Saved by ${r.created_by_name || 'the team'}`}>{r.name}</button>
                {r.schedule && (
                  <span style={{ fontSize: 11, color: '#256168', border: '1px solid #B9D2D5', borderRadius: 6, padding: '1px 6px' }}
                    title={`Emailed ${r.schedule.cadence}; last sent ${r.last_sent_at ? String(r.last_sent_at).slice(0, 10) : 'never'}`}>
                    ⏱ emailed {r.schedule.cadence}
                  </span>
                )}
                <span style={{ flex: 1 }} />
                <button type="button" className="btn ghost" style={{ padding: '2px 6px', color: INK }}
                  onClick={() => setSchedFor(schedFor === r.id ? null : r.id)}>
                  {r.schedule ? 'Edit schedule' : 'Email on a schedule'}
                </button>
                <button type="button" className="btn ghost" style={{ padding: '2px 6px', color: MUTED }}
                  onClick={() => removeSaved(r)} title="Delete this saved report">✕</button>
              </div>
              {schedFor === r.id && <SchedulePanel report={r} onDone={() => { setSchedFor(null); reloadSaved(); }} />}
            </div>
          ))}
        </div>
      </div>

      {/* Which files — filter groups */}
      <div className="card" style={{ marginTop: 10 }}>
        <div style={{ fontWeight: 700, color: INK }}>
          Which files{openReport ? <span style={{ color: MUTED, fontWeight: 400 }}> — editing “{openReport.name}”</span> : null}
        </div>
        <div style={{ color: MUTED, fontSize: 12, margin: '4px 0 10px' }}>
          A file must match <b>every</b> line inside a group. Add an <b>OR</b> group to also include files matching a different set of lines. No lines = every active file.
        </div>
        {groups.map((g, gi) => (
          <React.Fragment key={g._k}>
            {gi > 0 && (
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, margin: '10px 0' }}>
                <div style={{ flex: 1, borderTop: `1px solid ${LINE}` }} />
                <span style={{ fontWeight: 800, fontSize: 12, color: '#8A6D3B', letterSpacing: '.08em' }}>OR</span>
                <div style={{ flex: 1, borderTop: `1px solid ${LINE}` }} />
              </div>
            )}
            <div style={{ border: `1px solid ${LINE}`, borderRadius: 10, padding: 10, background: gi % 2 ? '#fff' : SOFTBG }}>
              {g.rows.map((f) => {
                const field = byKey.get(f.field);
                return (
                  <div key={f._k} style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center', marginBottom: 6 }}>
                    {fieldSelect(f.field, (v) => {
                      const nf = byKey.get(v);
                      if (nf?.facet) ensureValues(v);
                      setRow(g._k, f._k, { field: v, op: nf ? (nf.ops[0] || '') : '', value: '', value2: '' });
                    })}
                    {field && (
                      <select className="input" value={f.op} onChange={(e) => setRow(g._k, f._k, { op: e.target.value, value2: '' })} style={{ color: INK, maxWidth: 160 }}>
                        {field.ops.map((o) => <option key={o} value={o}>{OP_LABEL[o] || o}</option>)}
                      </select>
                    )}
                    {valueInput(g._k, f, field)}
                    <button type="button" className="btn ghost" style={{ color: MUTED }}
                      onClick={() => setGroups((gs) => {
                        const next = gs.map((x) => x._k !== g._k ? x : { ...x, rows: x.rows.filter((y) => y._k !== f._k) });
                        return next.map((x) => x.rows.length ? x : { ...x, rows: [blankFilter()] });
                      })}>✕</button>
                  </div>
                );
              })}
              <button type="button" className="btn ghost" style={{ color: INK }}
                onClick={() => setGroups((gs) => gs.map((x) => x._k === g._k ? { ...x, rows: [...x.rows, blankFilter()] } : x))}>
                + and
              </button>
              {groups.length > 1 && (
                <button type="button" className="btn ghost" style={{ color: MUTED, marginLeft: 6 }}
                  onClick={() => setGroups((gs) => gs.filter((x) => x._k !== g._k))}>Remove this group</button>
              )}
            </div>
          </React.Fragment>
        ))}
        <button type="button" className="btn soft" style={{ color: INK, marginTop: 10 }}
          onClick={() => setGroups((gs) => [...gs, blankGroup()])}>+ Add an OR group</button>
      </div>

      {/* What comes out — list vs totals */}
      <div className="card" style={{ marginTop: 10 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
          <div style={{ fontWeight: 700, color: INK }}>What the report shows</div>
          <div className="seg" role="tablist" style={{ display: 'inline-flex', border: `1px solid ${LINE}`, borderRadius: 8, overflow: 'hidden' }}>
            {[['list', 'List of files'], ['totals', 'Totals']].map(([m, label]) => (
              <button key={m} type="button" onClick={() => { setMode(m); setResult(null); }}
                style={{
                  padding: '6px 14px', border: 0, cursor: 'pointer', fontWeight: 650, fontSize: 13,
                  background: mode === m ? '#2F7F86' : '#fff', color: mode === m ? '#fff' : INK,
                }}>{label}</button>
            ))}
          </div>
        </div>

        {mode === 'list' && (
          <div style={{ marginTop: 10 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
              <span style={{ fontWeight: 650, fontSize: 13 }}>Columns ({columns.length})</span>
              <button type="button" className="btn ghost" style={{ color: INK }} onClick={() => setPickerOpen((o) => !o)}>
                {pickerOpen ? 'Hide the field list' : 'Choose fields'}
              </button>
              <span style={{ color: MUTED, fontSize: 12 }}>Sort by</span>
              {fieldSelect(sortField, setSortField, { blank: '— newest first —' })}
              <select className="input" value={sortDir} onChange={(e) => setSortDir(e.target.value)} style={{ color: INK, maxWidth: 150 }}>
                <option value="desc">high → low / new → old</option>
                <option value="asc">low → high / old → new</option>
              </select>
              <span style={{ color: MUTED, fontSize: 12 }}>…or click any column header in the results.</span>
            </div>
            {!pickerOpen && (
              <div style={{ marginTop: 8, display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                {columns.map((k) => (
                  <span key={k} style={{ border: `1px solid ${LINE}`, borderRadius: 8, padding: '2px 8px', fontSize: 12, color: INK, background: '#fff' }}>
                    {byKey.get(k)?.label || k}
                    <button type="button" onClick={() => toggleCol(k)} style={{ border: 0, background: 'none', color: MUTED, cursor: 'pointer', marginLeft: 4 }}>✕</button>
                  </span>
                ))}
              </div>
            )}
            {pickerOpen && grouped.map(([g, fs]) => (
              <div key={g} style={{ marginTop: 10 }}>
                <div style={{ fontSize: 11, textTransform: 'uppercase', letterSpacing: '.06em', color: MUTED, marginBottom: 4 }}>{g}</div>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: '4px 14px' }}>
                  {fs.map((f) => (
                    <label key={f.key} style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 13, color: INK, cursor: 'pointer' }}>
                      <input type="checkbox" checked={columns.includes(f.key)} onChange={() => toggleCol(f.key)} />
                      {f.label}
                    </label>
                  ))}
                </div>
              </div>
            ))}
          </div>
        )}

        {mode === 'totals' && (
          <div style={{ marginTop: 10, display: 'flex', flexDirection: 'column', gap: 8 }}>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
              <span style={{ fontWeight: 650, fontSize: 13 }}>Group the files by</span>
              {fieldSelect(groupBy[0] || '', (v) => setGroupBy((g) => [v, g[1]].filter(Boolean)))}
              <span style={{ color: MUTED, fontSize: 12 }}>and then by (optional)</span>
              {fieldSelect(groupBy[1] || '', (v) => setGroupBy((g) => v ? [g[0], v] : [g[0]].filter(Boolean)), { blank: '— none —' })}
            </div>
            {metrics.map((m) => (
              <div key={m._k} style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                <select className="input" value={m.fn} style={{ color: INK, maxWidth: 170 }}
                  onChange={(e) => setMetrics((ms) => ms.map((x) => x._k === m._k ? { ...x, fn: e.target.value } : x))}>
                  {Object.entries(FN_LABEL).map(([fn, label]) => <option key={fn} value={fn}>{label}</option>)}
                </select>
                {m.fn !== 'count' && (
                  <select className="input" value={m.field} style={{ color: INK, maxWidth: 220 }}
                    onChange={(e) => setMetrics((ms) => ms.map((x) => x._k === m._k ? { ...x, field: e.target.value } : x))}>
                    <option value="">— pick a money / number field —</option>
                    {numericFields.map((f) => <option key={f.key} value={f.key}>{f.label}</option>)}
                  </select>
                )}
                <button type="button" className="btn ghost" style={{ color: MUTED }}
                  onClick={() => setMetrics((ms) => ms.length > 1 ? ms.filter((x) => x._k !== m._k) : ms)}>✕</button>
              </div>
            ))}
            <div>
              <button type="button" className="btn ghost" style={{ color: INK }}
                onClick={() => setMetrics((ms) => [...ms, { _k: seq++, fn: 'sum', field: 'loan_amount' }])}>+ Add a total</button>
            </div>
          </div>
        )}
      </div>

      {/* Actions */}
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 10, alignItems: 'center' }}>
        <button type="button" className="btn primary" onClick={() => run()} disabled={running}>{running ? 'Running…' : 'Run the report'}</button>
        <button type="button" className="btn ghost" style={{ color: INK }} onClick={() => save(false)}>{openReport ? 'Save changes' : 'Save this report'}</button>
        {openReport && <button type="button" className="btn ghost" style={{ color: INK }} onClick={() => save(true)}>Save as new</button>}
        <button type="button" className="btn ghost" style={{ color: INK }} onClick={exportXlsx} disabled={running}>Export to Excel</button>
        {openReport && (
          <button type="button" className="btn ghost" style={{ color: MUTED }} onClick={() => setOpenReport(null)}>
            Stop editing “{openReport.name}”
          </button>
        )}
      </div>
      {err && <div style={{ marginTop: 8, color: '#8A2F2F', fontSize: 13 }}>{err}</div>}

      {/* Results */}
      {result && (
        <div className="card" style={{ marginTop: 10 }}>
          <div style={{ color: MUTED, fontSize: 13, marginBottom: 6 }}>
            {result.mode === 'summary'
              ? `${result.total.toLocaleString()} group${result.total === 1 ? '' : 's'}`
              : `${result.total.toLocaleString()} file${result.total === 1 ? '' : 's'} match${result.capped ? ` — showing the first ${result.rows.length.toLocaleString()}` : ''}`}
          </div>
          <div style={{ overflowX: 'auto' }}>
            <table style={{ borderCollapse: 'collapse', width: '100%', fontSize: 13, color: INK }}>
              <thead>
                <tr>
                  {(summaryCols || result.columns).map((c) => (
                    <th key={c.key}
                      onClick={result.mode === 'summary' ? undefined : () => sortBy(c.key)}
                      title={result.mode === 'summary' ? undefined : 'Sort by this column'}
                      style={{
                        textAlign: 'left', padding: '6px 10px', borderBottom: `2px solid ${LINE}`, whiteSpace: 'nowrap',
                        color: INK, cursor: result.mode === 'summary' ? 'default' : 'pointer', userSelect: 'none',
                      }}>
                      {c.label}{result.mode !== 'summary' && sortField === c.key ? (sortDir === 'desc' ? ' ↓' : ' ↑') : ''}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {result.mode === 'summary'
                  ? result.rows.map((row, i) => (
                    <tr key={i}>
                      {summaryCols.map((c) => (
                        <td key={c.key} style={{ padding: '5px 10px', borderBottom: '1px solid #F0EADB', whiteSpace: 'nowrap', color: INK }}>
                          {fmtCell(byKey.get(c.field) || { type: c.type }, row[c.key])}
                        </td>
                      ))}
                    </tr>
                  ))
                  : result.rows.map((row) => (
                    <tr key={row._id}>
                      {result.columns.map((c) => (
                        <td key={c.key} style={{ padding: '5px 10px', borderBottom: '1px solid #F0EADB', whiteSpace: 'nowrap', color: INK }}>
                          {c.key === 'ys_loan_number' && row[c.key]
                            ? <a href={`#/internal/app/${row._id}`} style={{ color: '#256168' }}>{row[c.key]}</a>
                            : fmtCell(byKey.get(c.key), row[c.key])}
                        </td>
                      ))}
                    </tr>
                  ))}
                {!result.rows.length && (
                  <tr><td colSpan={(summaryCols || result.columns).length} style={{ padding: 12, color: MUTED }}>No files match these filters.</td></tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}

/** The per-report email schedule editor — cadence, NY hour, internal recipients. */
function SchedulePanel({ report, onDone }) {
  const s = report.schedule || {};
  const [cadence, setCadence] = useState(s.cadence || 'weekly');
  const [dow, setDow] = useState(s.dow || 1);
  const [dom, setDom] = useState(s.dom || 1);
  const [hour, setHour] = useState(s.hour != null ? s.hour : 8);
  const [recipients, setRecipients] = useState((s.recipients || []).join(', '));
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');

  const saveSchedule = async (clear) => {
    setBusy(true); setMsg('');
    try {
      await api.reportSetSchedule(report.id, clear ? null : {
        enabled: true, cadence, hour: Number(hour),
        dow: Number(dow), dom: Number(dom),
        recipients: recipients.split(',').map((x) => x.trim()).filter(Boolean),
      });
      onDone();
    } catch (e) { setMsg(e.message); }
    finally { setBusy(false); }
  };

  return (
    <div style={{ marginTop: 8, paddingTop: 8, borderTop: '1px solid #F0EADB', display: 'flex', flexDirection: 'column', gap: 8 }}>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', fontSize: 13, color: INK }}>
        <span>Email this report</span>
        <select className="input" value={cadence} onChange={(e) => setCadence(e.target.value)} style={{ color: INK, maxWidth: 120 }}>
          <option value="daily">every day</option>
          <option value="weekly">weekly</option>
          <option value="monthly">monthly</option>
        </select>
        {cadence === 'weekly' && (
          <select className="input" value={dow} onChange={(e) => setDow(e.target.value)} style={{ color: INK, maxWidth: 140 }}>
            {['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'].map((d, i) => <option key={d} value={i + 1}>on {d}</option>)}
          </select>
        )}
        {cadence === 'monthly' && (
          <select className="input" value={dom} onChange={(e) => setDom(e.target.value)} style={{ color: INK, maxWidth: 140 }}>
            {Array.from({ length: 28 }, (_, i) => i + 1).map((d) => <option key={d} value={d}>on the {d}{d === 1 ? 'st' : d === 2 ? 'nd' : d === 3 ? 'rd' : 'th'}</option>)}
          </select>
        )}
        <span>at</span>
        <select className="input" value={hour} onChange={(e) => setHour(e.target.value)} style={{ color: INK, maxWidth: 110 }}>
          {Array.from({ length: 24 }, (_, h) => h).map((h) => (
            <option key={h} value={h}>{((h % 12) || 12)}{h < 12 ? 'am' : 'pm'} NY</option>
          ))}
        </select>
      </div>
      <input className="input" value={recipients} onChange={(e) => setRecipients(e.target.value)}
        placeholder="who gets it — internal team emails, comma-separated" style={{ color: INK }} />
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        <button type="button" className="btn primary" disabled={busy} onClick={() => saveSchedule(false)}>
          {report.schedule ? 'Update the schedule' : 'Start the schedule'}
        </button>
        {report.schedule && (
          <button type="button" className="btn ghost" style={{ color: MUTED }} disabled={busy} onClick={() => saveSchedule(true)}>
            Stop emailing it
          </button>
        )}
        {report.last_sent_at && <span style={{ color: MUTED, fontSize: 12 }}>Last sent {String(report.last_sent_at).slice(0, 10)}</span>}
      </div>
      {msg && <div style={{ color: '#8A2F2F', fontSize: 13 }}>{msg}</div>}
    </div>
  );
}
