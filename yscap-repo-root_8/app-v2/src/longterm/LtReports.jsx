import React, { useCallback, useEffect, useMemo, useState } from 'react';
import LtLayout from './LtLayout.jsx';
import { ltApi } from './api.js';
// ONE way to write a value down, shared with every other long-term screen. A report
// and the pipeline show the same loans, so a `money` written twice here would be two
// screens quoting one loan two ways.
import { money, day, stamp, plain, yesNo } from './format.js';

/**
 * THE LONG-TERM REPORTING CENTRE.
 *
 * The owner's words (2026-08-30): *"a full reporting center where I can see for
 * every file how long it took between which and which step and who the processor
 * was in that file, and then reporting per processor … Set up a full reporting
 * database on this so I can start scoring how many files each processor has and
 * her efficiency."*
 *
 * FOUR THINGS ON THIS SCREEN ARE DELIBERATE:
 *
 *   1. THE FIELD LIST COMES FROM THE SERVER, and the browser keeps no second copy.
 *      The column picker, the operator menu and the sort list are all drawn from
 *      `GET /reports/fields`, so this screen can never offer a column the compiler
 *      would then refuse — and a field added to the catalog appears here with no
 *      change to this file.
 *
 *   2. AN UNKNOWN DURATION IS SAID IN WORDS, never printed as a zero. A file PILOT
 *      was already past when it first read the loan has no measurable span, and a
 *      "0 days" in that cell would be a baseline wearing a real number's clothes —
 *      the one thing the whole reporting database was built to avoid.
 *
 *   3. A CAP IS SAID OUT LOUD. The server reports the total its filters match
 *      beside the page it returned, so a report that stops at 500 rows says so
 *      rather than reading as "that is all there is".
 *
 *   4. EVERY COLOUR IS AN EXPLICIT DARK ON WHITE. `--ink*` is a LIGHT paper colour
 *      in this palette — the names are legacy and they lie — so a text colour here
 *      is always a real hex.
 */

const TABS = [
  { key: 'scorecard', label: 'Per person', note: 'How long each step took, by the person who held it.' },
  { key: 'build', label: 'Build a report', note: 'Pick the columns, narrow it, run it.' },
  { key: 'saved', label: 'Saved reports', note: 'Your own, plus the ones saved for everybody.' },
];

const TH = {
  textAlign: 'left', fontSize: 11, letterSpacing: '.06em', textTransform: 'uppercase',
  color: '#4B585C', fontWeight: 700, padding: '8px 10px', whiteSpace: 'nowrap',
};
const TD = {
  padding: '9px 10px', fontSize: 14, color: '#141B22',
  borderTop: '1px solid #EAE4D7', verticalAlign: 'top',
};

/** Days, written the way a person says them. Never a bare number with no unit. */
function days(v) {
  if (v == null || v === '') return '—';
  const n = Number(v);
  if (!Number.isFinite(n)) return '—';
  if (n < 1) return 'same day';
  const r = Math.round(n * 10) / 10;
  return `${r} ${r === 1 ? 'day' : 'days'}`;
}

/**
 * A cell, written by its catalog TYPE.
 *
 * The type travels with the column from the server, so a money column added to the
 * catalog next year is written as money here without anybody touching this list.
 */
function cell(type, v) {
  if (v == null || v === '') return '—';
  switch (type) {
    case 'money': return money(v);
    case 'duration': return days(v);
    case 'pct': return `${Number(v)}%`;
    case 'boolean': return yesNo(v);
    case 'date': return day(v);
    case 'timestamp': return stamp(v);
    default: return plain(v);
  }
}

export default function LtReports() {
  const [tab, setTab] = useState('scorecard');
  const [catalog, setCatalog] = useState(null);
  const [err, setErr] = useState(null);

  useEffect(() => {
    ltApi.reportFields()
      .then(setCatalog)
      .catch((e) => setErr(e.message || 'Could not load the report builder.'));
  }, []);

  const active = TABS.find((t) => t.key === tab) || TABS[0];

  return (
    <LtLayout title="Reporting">
      <p style={{ margin: '0 0 14px', color: '#4B585C', maxWidth: 780, lineHeight: 1.55 }}>
        How long each file took between which and which step, who held it, and the same
        thing added up per person. PILOT measures a step only when it saw <em>both</em> ends
        of it — a file that was already past a step the first time PILOT read the loan is
        counted as unknown, never as a duration.
      </p>

      {err && <div className="lt-card" style={{ color: '#8A2A2A', marginBottom: 12 }}>{err}</div>}

      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginBottom: 14 }}>
        {TABS.map((t) => {
          const on = tab === t.key;
          return (
            <button key={t.key} onClick={() => setTab(t.key)} title={t.note}
              style={{
                textAlign: 'left', cursor: 'pointer', minWidth: 150,
                padding: '10px 14px', borderRadius: 10,
                border: on ? '1px solid #AE8746' : '1px solid #EAE4D7',
                background: on ? '#FBF6EC' : '#FFFFFF',
              }}>
              <div style={{ fontSize: 15, fontWeight: 700, color: '#141B22' }}>{t.label}</div>
              <div style={{ fontSize: 12, color: '#4B585C', marginTop: 2 }}>{t.note}</div>
            </button>
          );
        })}
      </div>

      {tab === 'scorecard' && <Scorecard />}
      {tab === 'build' && <Builder catalog={catalog} />}
      {tab === 'saved' && <Saved />}

      <div style={{ marginTop: 6, fontSize: 12, color: '#4B585C' }}>{active.note}</div>
    </LtLayout>
  );
}

/* ───────────────────────────── Per person ──────────────────────────────── */

/**
 * THE OWNER'S TWO SPANS, per person: loan setup (LO Prep to Submittal) and
 * processing (Submittal to Clear To Close).
 *
 * Every figure is measured over the spans that CLOSED, and the two counts are shown
 * beside each other on purpose — "12 files, 9 measured" is a different statement
 * from "12 files", and reading the average without the second number over-trusts it.
 */
function Scorecard() {
  const [data, setData] = useState(null);
  const [err, setErr] = useState(null);
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');

  const load = useCallback(() => {
    setErr(null);
    ltApi.scorecard({ from, to })
      .then(setData)
      .catch((e) => { setData(null); setErr(e.message || 'Could not build the scorecard.'); });
  }, [from, to]);
  useEffect(load, [load]);

  return (
    <>
      <div className="lt-card" style={{ marginBottom: 12 }}>
        <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'flex-end' }}>
          <label style={{ fontSize: 12, color: '#4B585C' }}>
            <div style={{ marginBottom: 4 }}>Steps finished on or after</div>
            <input className="input" type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
          </label>
          <label style={{ fontSize: 12, color: '#4B585C' }}>
            <div style={{ marginBottom: 4 }}>and on or before</div>
            <input className="input" type="date" value={to} onChange={(e) => setTo(e.target.value)} />
          </label>
          {(from || to) && (
            <button className="btn soft" onClick={() => { setFrom(''); setTo(''); }}>Whole book</button>
          )}
        </div>
        <div style={{ marginTop: 8, fontSize: 12, color: '#4B585C', lineHeight: 1.5 }}>
          A span counts in the window when it <strong>finished</strong> inside it — a step is
          only a fact once it closes.
        </div>
      </div>

      {err && <div className="lt-card" style={{ color: '#8A2A2A' }}>{err}</div>}
      {!data && !err && <div className="lt-card" style={{ color: '#4B585C' }}>Adding it up…</div>}

      {data && data.spans.map((s) => <SpanCard key={s.key} span={s} />)}

      {data && (
        <div className="lt-card" style={{ color: '#4B585C', fontSize: 13, lineHeight: 1.55 }}>
          {data.caveat}
        </div>
      )}
    </>
  );
}

function SpanCard({ span }) {
  const people = span.people || [];
  const total = span.totals || {};
  // The span-level flag is DERIVED from the people rather than sent separately:
  // one fact, one source, so the banner can never disagree with the rows under it.
  const anyFromCurrent = people.some((p) => p.someAttributionIsCurrent);

  return (
    <div className="lt-card lt-card-flush" style={{ marginBottom: 14 }}>
      <div style={{ padding: '14px 18px 12px' }}>
        <div style={{ fontSize: 17, fontWeight: 700, color: '#141B22' }}>{span.label}</div>
        <div style={{ fontSize: 13, color: '#4B585C', marginTop: 3 }}>
          {span.from} &rarr; {span.to}
          {span.ownerLabel ? ` \u00b7 counted against the ${span.ownerLabel.toLowerCase()}` : ''}
        </div>
        {span.blurb && (
          <div style={{ fontSize: 13, color: '#4B585C', marginTop: 6, maxWidth: 720, lineHeight: 1.5 }}>
            {span.blurb}
          </div>
        )}

        {/* THE DESK, weighted by MEASURED spans - never a mean of the per-person
            averages, which would give a person with two files the same weight as
            one with forty. */}
        <div style={{ display: 'flex', gap: 18, flexWrap: 'wrap', marginTop: 12 }}>
          <Figure label="People" value={total.people} />
          <Figure label="Files" value={total.files} />
          <Figure label="Measured" value={total.measured} />
          <Figure label="Unknown" value={total.unknown} />
          <Figure label="Average" value={days(total.avgDays)} />
        </div>

        {span.degraded && (
          <div style={{ marginTop: 10, fontSize: 13, color: '#8A2A2A' }}>
            PILOT could not read this span just now, so the list below is not the answer &mdash;
            it is empty because the read failed, not because nobody did any work.
          </div>
        )}
        {!span.degraded && anyFromCurrent && (
          <div style={{ marginTop: 10, fontSize: 13, color: '#8A6A17' }}>
            Some of these files are attributed to whoever holds the step <em>today</em>, because
            they were finished before PILOT started recording who completed each one. Treat
            those as an indication, not a record.
          </div>
        )}
      </div>

      {people.length > 0 && (
        <div style={{ overflowX: 'auto' }}>
          <table className="lt-rows" style={{ width: '100%', borderCollapse: 'collapse', minWidth: 720 }}>
            <thead>
              <tr>
                <th style={TH}>Person</th>
                <th style={TH}>Files</th>
                <th style={TH}>Measured</th>
                <th style={TH}>Average</th>
                <th style={TH}>Median</th>
                <th style={TH}>Fastest</th>
                <th style={TH}>Slowest</th>
                <th style={TH}>In flight</th>
              </tr>
            </thead>
            <tbody>
              {people.map((p) => (
                <tr key={p.id || p.name}>
                  <td style={{ ...TD, fontWeight: 600 }}>
                    {p.name || 'Nobody recorded'}
                    {p.someAttributionIsCurrent && (
                      <div style={{ fontSize: 11, color: '#8A6A17', fontWeight: 400, marginTop: 2 }}>
                        partly from who holds it today
                      </div>
                    )}
                  </td>
                  <td style={TD}>{p.files}</td>
                  <td style={TD}>
                    {p.measured}
                    {p.baselineFiles > 0 && (
                      <div style={{ fontSize: 11, color: '#4B585C', marginTop: 2 }}>
                        {p.baselineFiles} already past it
                      </div>
                    )}
                  </td>
                  <td style={{ ...TD, fontWeight: 600 }}>{days(p.avgDays)}</td>
                  <td style={TD}>{days(p.medianDays)}</td>
                  <td style={TD}>{days(p.minDays)}</td>
                  <td style={TD}>{days(p.maxDays)}</td>
                  <td style={TD}>{p.inFlightFiles || 0}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {!span.degraded && people.length === 0 && (
        <div style={{ padding: '0 18px 16px', color: '#4B585C', fontSize: 13 }}>
          Nothing has finished this step yet inside the window you picked.
        </div>
      )}
    </div>
  );
}

function Figure({ label, value }) {
  return (
    <div>
      <div style={{ fontSize: 22, fontWeight: 700, color: '#141B22', lineHeight: 1.1 }}>
        {value == null || value === '' ? '—' : value}
      </div>
      <div style={{ fontSize: 12, color: '#4B585C', marginTop: 2 }}>{label}</div>
    </div>
  );
}

/* ─────────────────────────── Build a report ────────────────────────────── */

const DEFAULT_COLUMNS = ['loan_number', 'borrower_name', 'stage', 'loan_amount'];

function Builder({ catalog }) {
  const [columns, setColumns] = useState(DEFAULT_COLUMNS);
  const [rules, setRules] = useState([]);
  const [sort, setSort] = useState('');
  const [dir, setDir] = useState('desc');
  const [limit, setLimit] = useState('');
  const [result, setResult] = useState(null);
  const [err, setErr] = useState(null);
  const [busy, setBusy] = useState(false);
  const [saveName, setSaveName] = useState('');
  const [saveShared, setSaveShared] = useState(false);
  const [note, setNote] = useState('');

  const byKey = useMemo(() => {
    const m = new Map();
    for (const f of (catalog && catalog.fields) || []) m.set(f.key, f);
    return m;
  }, [catalog]);

  const definition = useMemo(() => ({
    columns,
    filter: rules.length ? { combinator: 'and', rules: rules.map(cleanRule).filter(Boolean) } : null,
    sort: sort || null,
    dir,
    limit: limit ? Number(limit) : undefined,
  }), [columns, rules, sort, dir, limit]);

  const run = async () => {
    setBusy(true); setErr(null); setNote('');
    try {
      setResult(await ltApi.runReport(definition));
    } catch (e) {
      setResult(null);
      setErr(e.message || 'Could not run that report.');
    } finally {
      setBusy(false);
    }
  };

  const save = async () => {
    setBusy(true); setErr(null); setNote('');
    try {
      await ltApi.saveReport({
        name: saveName,
        visibility: saveShared ? 'shared' : 'private',
        definition,
      });
      setNote(`Saved “${saveName.trim()}”.`);
      setSaveName('');
    } catch (e) {
      setErr(e.message || 'Could not save that report.');
    } finally {
      setBusy(false);
    }
  };

  if (!catalog) return <div className="lt-card" style={{ color: '#4B585C' }}>Loading the fields…</div>;

  const groups = catalog.groups || [];

  return (
    <>
      {/* THE COLUMNS. Grouped exactly the way the catalog groups them, so the order
          on this screen and the order in the answer are one decision on the server. */}
      <div className="lt-card" style={{ marginBottom: 12 }}>
        <div style={{ fontSize: 15, fontWeight: 700, color: '#141B22', marginBottom: 8 }}>Columns</div>
        {groups.map((g) => {
          const list = (catalog.fields || []).filter((f) => f.group === g);
          if (!list.length) return null;
          return (
            <div key={g} style={{ marginBottom: 10 }}>
              <div style={{ fontSize: 11, letterSpacing: '.06em', textTransform: 'uppercase',
                color: '#4B585C', fontWeight: 700, marginBottom: 5 }}>{g}</div>
              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                {list.map((f) => {
                  const on = columns.includes(f.key);
                  return (
                    <button key={f.key} title={f.note || f.label}
                      onClick={() => setColumns(on
                        ? columns.filter((k) => k !== f.key)
                        : [...columns, f.key])}
                      style={{
                        cursor: 'pointer', fontSize: 13, padding: '5px 10px', borderRadius: 999,
                        border: on ? '1px solid #AE8746' : '1px solid #EAE4D7',
                        background: on ? '#FBF6EC' : '#FFFFFF', color: '#141B22',
                      }}>
                      {f.label}
                    </button>
                  );
                })}
              </div>
            </div>
          );
        })}
        {columns.length === 0 && (
          <div style={{ fontSize: 13, color: '#4B585C' }}>
            With nothing picked the report answers with the file’s own identity, so it is
            never blank.
          </div>
        )}
      </div>

      {/* THE FILTERS. One level, matching the short-term rule builder so the two
          products read the same to somebody moving between them. */}
      <div className="lt-card" style={{ marginBottom: 12 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
          <div style={{ fontSize: 15, fontWeight: 700, color: '#141B22' }}>Narrow it</div>
          <button className="btn soft" onClick={() => setRules([...rules, { field: '', operator: '', value: '' }])}>
            Add a rule
          </button>
        </div>
        {rules.length === 0 && (
          <div style={{ fontSize: 13, color: '#4B585C' }}>No rules — every long-term file you can see.</div>
        )}
        {rules.map((r, i) => (
          <RuleRow key={i} rule={r} catalog={catalog} byKey={byKey}
            onChange={(next) => setRules(rules.map((x, j) => (j === i ? next : x)))}
            onRemove={() => setRules(rules.filter((_, j) => j !== i))} />
        ))}
      </div>

      {/* SORT AND CAP. The cap's ceiling comes from the server, so this screen can
          never offer a number the compiler would silently lower. */}
      <div className="lt-card" style={{ marginBottom: 12 }}>
        <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'flex-end' }}>
          <label style={{ fontSize: 12, color: '#4B585C' }}>
            <div style={{ marginBottom: 4 }}>Sort by</div>
            <select className="input" value={sort} onChange={(e) => setSort(e.target.value)}>
              <option value="">Encompass last touched</option>
              {(catalog.fields || []).map((f) => (
                <option key={f.key} value={f.key}>{f.group} — {f.label}</option>
              ))}
            </select>
          </label>
          <label style={{ fontSize: 12, color: '#4B585C' }}>
            <div style={{ marginBottom: 4 }}>Direction</div>
            <select className="input" value={dir} onChange={(e) => setDir(e.target.value)}>
              <option value="desc">Largest / newest first</option>
              <option value="asc">Smallest / oldest first</option>
            </select>
          </label>
          <label style={{ fontSize: 12, color: '#4B585C' }}>
            <div style={{ marginBottom: 4 }}>Rows (up to {catalog.maxRows})</div>
            <input className="input" type="number" min="1" max={catalog.maxRows}
              placeholder={String(catalog.defaultRows)} value={limit}
              onChange={(e) => setLimit(e.target.value)} />
          </label>
          <button className="btn" onClick={run} disabled={busy}>
            {busy ? 'Running…' : 'Run it'}
          </button>
        </div>
      </div>

      {err && <div className="lt-card" style={{ color: '#8A2A2A', marginBottom: 12 }}>{err}</div>}
      {note && <div className="lt-card" style={{ color: '#141B22', marginBottom: 12 }}>{note}</div>}

      {result && <Results result={result} />}

      {/* SAVING. A shared report is refused by the server rather than downgraded, so
          somebody who meant to give the whole team a report is told they did not. */}
      <div className="lt-card" style={{ marginTop: 12 }}>
        <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'flex-end' }}>
          <label style={{ fontSize: 12, color: '#4B585C', flex: '1 1 240px' }}>
            <div style={{ marginBottom: 4 }}>Save this report as</div>
            <input className="input" style={{ width: '100%' }} value={saveName}
              placeholder="Files sitting at processing over 20 days"
              onChange={(e) => setSaveName(e.target.value)} />
          </label>
          <label style={{ fontSize: 13, color: '#141B22', display: 'flex', gap: 6, alignItems: 'center' }}>
            <input type="checkbox" checked={saveShared} onChange={(e) => setSaveShared(e.target.checked)} />
            For everybody
          </label>
          <button className="btn soft" onClick={save} disabled={busy || !saveName.trim()}>Save</button>
        </div>
      </div>
    </>
  );
}

/** Drop a half-finished rule rather than sending it — the compiler would refuse it. */
function cleanRule(r) {
  if (!r || !r.field || !r.operator) return null;
  return { field: r.field, operator: r.operator, value: r.value };
}

function RuleRow({ rule, catalog, byKey, onChange, onRemove }) {
  const f = byKey.get(rule.field);
  const ops = f ? f.operators || [] : [];
  const needsValue = rule.operator && !(catalog.noValueOperators || []).includes(rule.operator);
  const isRange = (catalog.rangeOperators || []).includes(rule.operator);
  const isList = (catalog.listOperators || []).includes(rule.operator);
  const val = Array.isArray(rule.value) ? rule.value : [rule.value, ''];

  return (
    <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center', marginTop: 8 }}>
      <select className="input" value={rule.field}
        onChange={(e) => onChange({ field: e.target.value, operator: '', value: '' })}>
        <option value="">Pick a field…</option>
        {(catalog.fields || []).map((x) => (
          <option key={x.key} value={x.key}>{x.group} — {x.label}</option>
        ))}
      </select>

      <select className="input" value={rule.operator} disabled={!f}
        onChange={(e) => onChange({ ...rule, operator: e.target.value, value: '' })}>
        <option value="">…</option>
        {ops.map((o) => (
          <option key={o} value={o}>{(catalog.operatorLabels || {})[o] || o}</option>
        ))}
      </select>

      {needsValue && isRange && (
        <>
          <input className="input" style={{ width: 130 }} value={val[0] || ''}
            onChange={(e) => onChange({ ...rule, value: [e.target.value, val[1] || ''] })} />
          <span style={{ color: '#4B585C', fontSize: 13 }}>and</span>
          <input className="input" style={{ width: 130 }} value={val[1] || ''}
            onChange={(e) => onChange({ ...rule, value: [val[0] || '', e.target.value] })} />
        </>
      )}
      {needsValue && !isRange && (
        <input className="input" style={{ width: 220 }}
          value={Array.isArray(rule.value) ? rule.value.join(', ') : (rule.value || '')}
          placeholder={isList ? 'one, two, three' : ''}
          onChange={(e) => onChange({
            ...rule,
            value: isList ? e.target.value.split(',').map((s) => s.trim()).filter(Boolean) : e.target.value,
          })} />
      )}

      <button className="btn ghost" onClick={onRemove}>Remove</button>
    </div>
  );
}

function Results({ result }) {
  return (
    <div className="lt-card lt-card-flush" style={{ marginBottom: 12 }}>
      <div style={{ padding: '12px 18px', fontSize: 13, color: '#4B585C' }}>
        Showing <strong style={{ color: '#141B22' }}>{result.shown}</strong> of{' '}
        <strong style={{ color: '#141B22' }}>{result.total}</strong> files.
        {/* NO SILENT CAPS — the total is measured, so a capped page says so. */}
        {result.capped && (
          <span style={{ color: '#8A6A17' }}>
            {' '}This is the first {result.limit}. Narrow it, or raise the row count, to see the rest.
          </span>
        )}
      </div>
      <div style={{ overflowX: 'auto' }}>
        <table className="lt-rows" style={{ width: '100%', borderCollapse: 'collapse', minWidth: 640 }}>
          <thead>
            <tr>{result.columns.map((c) => <th key={c.key} style={TH}>{c.label}</th>)}</tr>
          </thead>
          <tbody>
            {result.rows.map((r) => (
              <tr key={r.loanId}>
                {result.columns.map((c) => (
                  <td key={c.key} style={TD}>{cell(c.type, r.cells[c.key])}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {result.rows.length === 0 && (
        <div style={{ padding: '0 18px 16px', color: '#4B585C', fontSize: 13 }}>
          No file matches those rules.
        </div>
      )}
    </div>
  );
}

/* ───────────────────────────── Saved reports ───────────────────────────── */

function Saved() {
  const [data, setData] = useState(null);
  const [err, setErr] = useState(null);

  const load = useCallback(() => {
    setErr(null);
    ltApi.savedReports().then(setData)
      .catch((e) => setErr(e.message || 'Could not load your saved reports.'));
  }, []);
  useEffect(load, [load]);

  const remove = async (id) => {
    try { await ltApi.deleteReport(id); load(); }
    catch (e) { setErr(e.message || 'Could not delete that report.'); }
  };

  if (err) return <div className="lt-card" style={{ color: '#8A2A2A' }}>{err}</div>;
  if (!data) return <div className="lt-card" style={{ color: '#4B585C' }}>Reading your reports…</div>;
  if (!data.reports.length) {
    return (
      <div className="lt-card" style={{ color: '#4B585C' }}>
        Nothing saved yet. Build one on the previous tab and give it a name.
      </div>
    );
  }

  return (
    <div className="lt-card lt-card-flush">
      <div style={{ overflowX: 'auto' }}>
        <table className="lt-rows" style={{ width: '100%', borderCollapse: 'collapse', minWidth: 620 }}>
          <thead>
            <tr>
              <th style={TH}>Report</th>
              <th style={TH}>Who can see it</th>
              <th style={TH}>Saved by</th>
              <th style={TH}>Last changed</th>
              <th style={TH} />
            </tr>
          </thead>
          <tbody>
            {data.reports.map((r) => (
              <tr key={r.id}>
                <td style={{ ...TD, fontWeight: 600 }}>
                  {r.name}
                  {r.description && (
                    <div style={{ fontSize: 12, color: '#4B585C', fontWeight: 400, marginTop: 2 }}>
                      {r.description}
                    </div>
                  )}
                </td>
                <td style={TD}>{r.visibility === 'shared' ? 'Everybody' : 'Only you'}</td>
                <td style={TD}>{r.ownerName || '—'}</td>
                <td style={TD}>{stamp(r.updatedAt)}</td>
                <td style={TD}>
                  {(r.mine || (r.visibility === 'shared' && data.canShare)) && (
                    <button className="btn ghost" onClick={() => remove(r.id)}>Delete</button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
