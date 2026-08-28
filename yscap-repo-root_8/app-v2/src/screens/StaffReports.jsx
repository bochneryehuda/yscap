import React, { useEffect, useMemo, useState } from 'react';
import { api } from '../lib/api.js';
import { showMessage, askConfirm, askPrompt } from '../lib/dialog.js';

/**
 * THE REPORTING DATABASE (owner-directed 2026-08-28): "a reporting database
 * that I can go in like an Encompass … select the fields I want, filter which
 * files should be included, save the report … export to excel. Massive
 * reporting database available for the admin super admin back office."
 *
 * The Encompass Reporting Database shape: a curated FIELD DICTIONARY (served
 * by the server — the screen never invents a field), filter rows
 * (field / operator / value, AND-combined), a column picker, saved report
 * definitions, and a real .xlsx export. Everything the server refuses comes
 * back as a plain sentence and is shown as-is.
 *
 * HARD RULE: dark text on the white canvas — explicit hexes, never --ink*.
 */
const INK = '#141B22';
const MUTED = '#4B585C';

const OP_LABEL = {
  eq: 'is', neq: 'is not', contains: 'contains', not_contains: "doesn't contain",
  starts_with: 'starts with', is_empty: 'is empty', not_empty: 'is not empty',
  in: 'is one of', not_in: 'is none of',
  gt: '>', gte: '≥', lt: '<', lte: '≤', between: 'between',
  on: 'on', before: 'before', after: 'after',
  is_true: 'is yes', is_false: 'is no',
};
const NO_VALUE_OPS = new Set(['is_empty', 'not_empty', 'is_true', 'is_false']);
const NUMY = new Set(['money', 'number', 'pct']);
const DATEY = new Set(['date', 'timestamp']);

function fmtCell(field, v) {
  if (v == null || v === '') return '—';
  if (!field) return String(v);
  if (field.type === 'boolean') return v === true ? 'Yes' : 'No';
  if (field.type === 'money') {
    const n = Number(v);
    return isFinite(n) ? n.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }) : String(v);
  }
  if (field.type === 'pct') { const n = Number(v); return isFinite(n) ? `${n}%` : String(v); }
  if (DATEY.has(field.type)) return String(v).slice(0, 10);
  return String(v);
}

let seq = 1;
const blankFilter = () => ({ _k: seq++, field: '', op: '', value: '', value2: '' });

export default function StaffReports() {
  const [fields, setFields] = useState([]);
  const [saved, setSaved] = useState([]);
  const [filters, setFilters] = useState([blankFilter()]);
  const [columns, setColumns] = useState(['ys_loan_number', 'borrower_name', 'property_address', 'file_status', 'loan_amount', 'loan_officer']);
  const [sortField, setSortField] = useState('');
  const [sortDir, setSortDir] = useState('desc');
  const [result, setResult] = useState(null);
  const [running, setRunning] = useState(false);
  const [err, setErr] = useState('');
  const [openReport, setOpenReport] = useState(null); // the saved report being edited, if any
  const [pickerOpen, setPickerOpen] = useState(false);

  const byKey = useMemo(() => new Map(fields.map((f) => [f.key, f])), [fields]);
  const groups = useMemo(() => {
    const g = new Map();
    for (const f of fields) { if (!g.has(f.group)) g.set(f.group, []); g.get(f.group).push(f); }
    return [...g.entries()];
  }, [fields]);

  useEffect(() => {
    api.reportFields().then((r) => setFields(r.fields || [])).catch((e) => setErr(e.message));
    reloadSaved();
  }, []);
  const reloadSaved = () => api.reportSavedList().then((r) => setSaved(r.reports || [])).catch(() => {});

  // The definition exactly as the server's grammar wants it.
  const definition = () => ({
    filters: filters
      .filter((f) => f.field && f.op)
      .map((f) => ({
        field: f.field, op: f.op,
        value: f.op === 'between' ? [f.value, f.value2]
          : (f.op === 'in' || f.op === 'not_in') ? String(f.value).split(',').map((s) => s.trim()).filter(Boolean)
            : f.value,
      })),
    columns,
    sort: sortField ? { field: sortField, dir: sortDir } : null,
  });

  const run = async () => {
    setErr(''); setRunning(true);
    try { setResult(await api.reportRun(definition())); }
    catch (e) { setErr(e.message); }
    finally { setRunning(false); }
  };

  const exportXlsx = async () => {
    setErr('');
    try { await api.reportExportXlsx({ ...definition(), name: openReport?.name || 'Report' }); }
    catch (e) { setErr(e.message); }
  };

  const save = async (asNew) => {
    const name = await askPrompt(asNew || !openReport ? 'Name this report:' : 'Report name:', {
      defaultValue: openReport && !asNew ? openReport.name : '',
      title: 'Save report',
    });
    if (name == null || !String(name).trim()) return;
    try {
      if (openReport && !asNew) {
        const r = await api.reportUpdate(openReport.id, { name: String(name).trim(), definition: definition() });
        setOpenReport(r.report);
      } else {
        const r = await api.reportSave({ name: String(name).trim(), definition: definition() });
        setOpenReport(r.report);
      }
      reloadSaved();
      showMessage('Report saved. Anyone on the admin team can open it from the Saved reports list.');
    } catch (e) { showMessage(e.message, { title: 'Could not save' }); }
  };

  const openSaved = (r) => {
    const d = r.definition || {};
    setOpenReport(r);
    setFilters(((d.filters && d.filters.length) ? d.filters : [null]).map((f) => f ? ({
      _k: seq++, field: f.field, op: f.op,
      value: Array.isArray(f.value) ? (f.op === 'between' ? String(f.value[0] ?? '') : f.value.join(', ')) : String(f.value ?? ''),
      value2: Array.isArray(f.value) && f.op === 'between' ? String(f.value[1] ?? '') : '',
    }) : blankFilter()));
    setColumns(Array.isArray(d.columns) && d.columns.length ? d.columns : ['ys_loan_number', 'borrower_name', 'file_status']);
    setSortField(d.sort?.field || ''); setSortDir(d.sort?.dir === 'asc' ? 'asc' : 'desc');
    setResult(null); setErr('');
  };

  const removeSaved = async (r) => {
    if (!(await askConfirm(`Delete the saved report "${r.name}"? This does not touch any loan file — only the saved report layout.`))) return;
    try { await api.reportDelete(r.id); if (openReport?.id === r.id) setOpenReport(null); reloadSaved(); }
    catch (e) { showMessage(e.message, { title: 'Could not delete' }); }
  };

  const setF = (k, patch) => setFilters((fs) => fs.map((f) => f._k === k ? { ...f, ...patch } : f));
  const toggleCol = (key) => setColumns((cs) => cs.includes(key) ? cs.filter((c) => c !== key) : [...cs, key]);

  const fieldSelect = (value, onChange, { withBlank = true } = {}) => (
    <select className="input" value={value} onChange={(e) => onChange(e.target.value)} style={{ color: INK }}>
      {withBlank && <option value="">— pick a field —</option>}
      {groups.map(([g, fs]) => (
        <optgroup key={g} label={g}>
          {fs.map((f) => <option key={f.key} value={f.key}>{f.label}</option>)}
        </optgroup>
      ))}
    </select>
  );

  const valueInput = (f, field) => {
    if (!field || NO_VALUE_OPS.has(f.op)) return null;
    const type = DATEY.has(field.type) ? 'date' : NUMY.has(field.type) ? 'number' : 'text';
    const opts = field.options || null;
    const single = opts && (f.op === 'eq' || f.op === 'neq')
      ? (
        <select className="input" value={f.value} onChange={(e) => setF(f._k, { value: e.target.value })} style={{ color: INK }}>
          <option value="">— pick —</option>
          {opts.map((o) => <option key={o} value={o}>{o}</option>)}
        </select>
      )
      : (
        <input className="input" type={type} value={f.value}
          placeholder={(f.op === 'in' || f.op === 'not_in') ? 'value, value, value' : 'value'}
          onChange={(e) => setF(f._k, { value: e.target.value })} style={{ color: INK }} />
      );
    return (
      <>
        {single}
        {f.op === 'between' && (
          <input className="input" type={type} value={f.value2} placeholder="and"
            onChange={(e) => setF(f._k, { value2: e.target.value })} style={{ color: INK }} />
        )}
      </>
    );
  };

  return (
    <div className="wrap" style={{ color: INK }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 12, flexWrap: 'wrap' }}>
        <h1 style={{ margin: '6px 0', color: INK }}>Reports</h1>
        <div style={{ color: MUTED, fontSize: 13 }}>
          Pick the files, pick the columns, run it — then save the report for next time or export it to Excel.
        </div>
      </div>

      {/* Saved reports */}
      <div className="card" style={{ marginTop: 10 }}>
        <div style={{ fontWeight: 700, color: INK, marginBottom: 6 }}>Saved reports</div>
        {!saved.length && <div style={{ color: MUTED, fontSize: 13 }}>Nothing saved yet. Build a report below and press Save.</div>}
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
          {saved.map((r) => (
            <span key={r.id} style={{
              display: 'inline-flex', alignItems: 'center', gap: 6, border: '1px solid #E3DCCB',
              borderRadius: 8, padding: '4px 8px', background: openReport?.id === r.id ? '#FBF7EC' : '#fff',
            }}>
              <button type="button" className="btn ghost" style={{ padding: '2px 6px', color: INK }}
                onClick={() => openSaved(r)} title={r.description || `Saved by ${r.created_by_name || 'the team'}`}>{r.name}</button>
              <button type="button" className="btn ghost" style={{ padding: '2px 6px', color: MUTED }}
                onClick={() => removeSaved(r)} title="Delete this saved report">✕</button>
            </span>
          ))}
        </div>
      </div>

      {/* Filters */}
      <div className="card" style={{ marginTop: 10 }}>
        <div style={{ fontWeight: 700, color: INK, marginBottom: 6 }}>
          Which files{openReport ? <span style={{ color: MUTED, fontWeight: 400 }}> — editing “{openReport.name}”</span> : null}
        </div>
        <div style={{ color: MUTED, fontSize: 12, marginBottom: 8 }}>
          Every line must be true for a file to be included. No lines = every active file.
        </div>
        {filters.map((f) => {
          const field = byKey.get(f.field);
          return (
            <div key={f._k} style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center', marginBottom: 6 }}>
              {fieldSelect(f.field, (v) => {
                const nf = byKey.get(v);
                setF(f._k, { field: v, op: nf ? (nf.ops[0] || '') : '', value: '', value2: '' });
              })}
              {field && (
                <select className="input" value={f.op} onChange={(e) => setF(f._k, { op: e.target.value, value2: '' })} style={{ color: INK, maxWidth: 170 }}>
                  {field.ops.map((o) => <option key={o} value={o}>{OP_LABEL[o] || o}</option>)}
                </select>
              )}
              {valueInput(f, field)}
              <button type="button" className="btn ghost" style={{ color: MUTED }}
                onClick={() => setFilters((fs) => fs.length > 1 ? fs.filter((x) => x._k !== f._k) : [blankFilter()])}>
                Remove
              </button>
            </div>
          );
        })}
        <button type="button" className="btn ghost" style={{ color: INK }} onClick={() => setFilters((fs) => [...fs, blankFilter()])}>
          + Add a filter
        </button>
      </div>

      {/* Columns + sort */}
      <div className="card" style={{ marginTop: 10 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
          <div style={{ fontWeight: 700, color: INK }}>Columns ({columns.length})</div>
          <button type="button" className="btn ghost" style={{ color: INK }} onClick={() => setPickerOpen((o) => !o)}>
            {pickerOpen ? 'Hide the field list' : 'Choose fields'}
          </button>
          <span style={{ color: MUTED, fontSize: 12 }}>Sort by</span>
          {fieldSelect(sortField, setSortField)}
          <select className="input" value={sortDir} onChange={(e) => setSortDir(e.target.value)} style={{ color: INK, maxWidth: 130 }}>
            <option value="desc">high → low / new → old</option>
            <option value="asc">low → high / old → new</option>
          </select>
        </div>
        {!pickerOpen && (
          <div style={{ marginTop: 8, display: 'flex', flexWrap: 'wrap', gap: 6 }}>
            {columns.map((k) => (
              <span key={k} style={{ border: '1px solid #E3DCCB', borderRadius: 8, padding: '2px 8px', fontSize: 12, color: INK, background: '#fff' }}>
                {byKey.get(k)?.label || k}
                <button type="button" onClick={() => toggleCol(k)} style={{ border: 0, background: 'none', color: MUTED, cursor: 'pointer', marginLeft: 4 }}>✕</button>
              </span>
            ))}
          </div>
        )}
        {pickerOpen && groups.map(([g, fs]) => (
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

      {/* Actions */}
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 10, alignItems: 'center' }}>
        <button type="button" className="btn primary" onClick={run} disabled={running}>{running ? 'Running…' : 'Run the report'}</button>
        <button type="button" className="btn ghost" style={{ color: INK }} onClick={() => save(false)}>{openReport ? 'Save changes' : 'Save this report'}</button>
        {openReport && <button type="button" className="btn ghost" style={{ color: INK }} onClick={() => save(true)}>Save as a new report</button>}
        <button type="button" className="btn ghost" style={{ color: INK }} onClick={exportXlsx} disabled={running}>Export to Excel</button>
        {openReport && (
          <button type="button" className="btn ghost" style={{ color: MUTED }} onClick={() => { setOpenReport(null); }}>
            Stop editing “{openReport.name}”
          </button>
        )}
      </div>
      {err && <div style={{ marginTop: 8, color: '#8A2F2F', fontSize: 13 }}>{err}</div>}

      {/* Results */}
      {result && (
        <div className="card" style={{ marginTop: 10 }}>
          <div style={{ color: MUTED, fontSize: 13, marginBottom: 6 }}>
            {result.total.toLocaleString()} file{result.total === 1 ? '' : 's'} match
            {result.capped ? ` — showing the first ${result.rows.length.toLocaleString()} (raise the sort or add filters to narrow it; the Excel export carries up to ${result.limit.toLocaleString()})` : ''}
          </div>
          <div style={{ overflowX: 'auto' }}>
            <table style={{ borderCollapse: 'collapse', width: '100%', fontSize: 13, color: INK }}>
              <thead>
                <tr>
                  {result.columns.map((c) => (
                    <th key={c.key} style={{ textAlign: 'left', padding: '6px 10px', borderBottom: '2px solid #E3DCCB', whiteSpace: 'nowrap', color: INK }}>{c.label}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {result.rows.map((row) => (
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
                  <tr><td colSpan={result.columns.length} style={{ padding: 12, color: MUTED }}>No files match these filters.</td></tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
