import React from 'react';
import { MoneyInput } from './FormattedInputs.jsx';

/**
 * Visual condition-rule builder (Condition Center).
 *
 * Edits a rule tree { combinator: 'and'|'or', rules: [row | group] } where a
 * row is { field, operator, value } and a group is one nested level of the
 * same shape — mirroring the server evaluator in src/lib/conditions/rules.js.
 *
 * UX follows the "ALL of / ANY of" pattern: every row reads
 *   [field] [operator] [value…]  ✕
 * with the value control adapting to the field's type, and OR-groups are one
 * indented level ("…and ANY of these") rather than free-form nesting.
 */

const NO_VALUE_OPS = ['is_empty', 'not_empty', 'is_true', 'is_false'];

export function emptyRule(fields) {
  const f = fields[0];
  return { field: f.key, operator: defaultOperator(f), value: defaultValue(f, defaultOperator(f)) };
}
export function emptyGroup(fields) {
  return { combinator: 'and', rules: [emptyRule(fields)] };
}
function defaultOperator(f) {
  if (!f) return 'eq';
  if (f.type === 'boolean') return 'is_true';
  if (f.type === 'enum') return 'in';
  return 'eq';
}
function defaultValue(f, op) {
  if (NO_VALUE_OPS.includes(op)) return undefined;
  if (op === 'between') return ['', ''];
  if (op === 'in' || op === 'not_in') return [];
  return '';
}

function fmtVal(f, v) {
  if (v === '' || v == null) return '…';
  if (f.type === 'money') return '$' + Math.round(Number(v) || 0).toLocaleString('en-US');
  if (f.type === 'percent') return `${v}%`;
  if (f.type === 'enum') {
    const o = (f.options || []).find((x) => x.v === v);
    return o ? o.label : String(v);
  }
  return String(v);
}

/** Plain-language sentence for a rule tree — mirrors the server summarizer. */
export function summarize(tree, meta, depth = 0) {
  if (!tree || !Array.isArray(tree.rules) || !tree.rules.length) return '';
  const byKey = Object.fromEntries((meta.fields || []).map((f) => [f.key, f]));
  const joiner = tree.combinator === 'or' ? ' OR ' : ' and ';
  return tree.rules.map((n) => {
    if (n && Array.isArray(n.rules)) {
      const inner = summarize(n, meta, depth + 1);
      return inner ? `(${inner})` : '';
    }
    const f = byKey[n.field];
    if (!f) return '';
    const op = (meta.operatorLabels || {})[n.operator] || n.operator;
    if (NO_VALUE_OPS.includes(n.operator)) return `${f.label} ${op}`;
    if (n.operator === 'between') return `${f.label} ${op} ${fmtVal(f, (n.value || [])[0])} and ${fmtVal(f, (n.value || [])[1])}`;
    if (n.operator === 'in' || n.operator === 'not_in') return `${f.label} ${op} ${(n.value || []).map((v) => fmtVal(f, v)).join(', ') || '…'}`;
    return `${f.label} ${op} ${fmtVal(f, n.value)}`;
  }).filter(Boolean).join(joiner);
}

function FieldSelect({ fields, value, onChange }) {
  const groups = [];
  for (const f of fields) {
    let g = groups.find((x) => x.name === f.group);
    if (!g) { g = { name: f.group, items: [] }; groups.push(g); }
    g.items.push(f);
  }
  return (
    <select className="input" value={value} onChange={(e) => onChange(e.target.value)} aria-label="Field">
      {groups.map((g) => (
        <optgroup key={g.name} label={g.name}>
          {g.items.map((f) => <option key={f.key} value={f.key}>{f.label}</option>)}
        </optgroup>
      ))}
    </select>
  );
}

function ValueInput({ field, operator, value, onChange }) {
  if (!field || NO_VALUE_OPS.includes(operator)) return null;
  const t = field.type;
  if (operator === 'between') {
    const v = Array.isArray(value) ? value : ['', ''];
    const One = ({ i }) => (t === 'money'
      ? <MoneyInput value={v[i]} onChange={(x) => onChange(i === 0 ? [x, v[1]] : [v[0], x])} />
      : <input className="input" type={t === 'date' ? 'date' : 'number'} value={v[i] ?? ''}
          onChange={(e) => onChange(i === 0 ? [e.target.value, v[1]] : [v[0], e.target.value])} />);
    return (
      <span className="rb-range">
        <One i={0} /><span className="muted small">and</span><One i={1} />
      </span>
    );
  }
  if (t === 'enum' && (operator === 'in' || operator === 'not_in')) {
    const arr = Array.isArray(value) ? value : [];
    const toggle = (v) => onChange(arr.includes(v) ? arr.filter((x) => x !== v) : [...arr, v]);
    return (
      <span className="rb-chips" role="group" aria-label="Values">
        {(field.options || []).map((o) => (
          <button key={o.v} type="button"
            className={'rb-chip' + (arr.includes(o.v) ? ' on' : '')}
            onClick={() => toggle(o.v)}>{o.label}</button>
        ))}
      </span>
    );
  }
  if (t === 'enum') {
    return (
      <select className="input" value={value ?? ''} onChange={(e) => onChange(e.target.value)} aria-label="Value">
        <option value="" disabled>Choose…</option>
        {(field.options || []).map((o) => <option key={o.v} value={o.v}>{o.label}</option>)}
      </select>
    );
  }
  if (t === 'money') return <MoneyInput value={value ?? ''} onChange={onChange} />;
  if (t === 'date') return <input className="input" type="date" value={value ?? ''} onChange={(e) => onChange(e.target.value)} />;
  if (t === 'number' || t === 'percent') {
    return (
      <span style={{ position: 'relative', display: 'inline-block', width: '100%' }}>
        <input className="input" type="number" value={value ?? ''} onChange={(e) => onChange(e.target.value)} />
        {t === 'percent' && <span className="rb-pct">%</span>}
      </span>
    );
  }
  return <input className="input" value={value ?? ''} onChange={(e) => onChange(e.target.value)} placeholder="Value" />;
}

function Row({ node, meta, byKey, onChange, onRemove }) {
  const f = byKey[node.field] || meta.fields[0];
  const allowed = (meta.operators || {})[f.type] || ['eq'];
  const setField = (key) => {
    const nf = byKey[key];
    const op = allowed.includes(node.operator) && (meta.operators[nf.type] || []).includes(node.operator)
      ? node.operator : defaultOperator(nf);
    onChange({ field: key, operator: op, value: defaultValue(nf, op) });
  };
  const setOp = (op) => {
    const keepShape = (a, b) => (a === 'between') === (b === 'between')
      && ((a === 'in' || a === 'not_in') === (b === 'in' || b === 'not_in'))
      && !NO_VALUE_OPS.includes(a) && !NO_VALUE_OPS.includes(b);
    onChange({ ...node, operator: op, value: keepShape(node.operator, op) ? node.value : defaultValue(f, op) });
  };
  return (
    <div className="rb-row">
      <FieldSelect fields={meta.fields} value={node.field} onChange={setField} />
      <select className="input" value={node.operator} onChange={(e) => setOp(e.target.value)} aria-label="Operator">
        {allowed.map((op) => <option key={op} value={op}>{(meta.operatorLabels || {})[op] || op}</option>)}
      </select>
      <div className="rb-value"><ValueInput field={f} operator={node.operator} value={node.value} onChange={(v) => onChange({ ...node, value: v })} /></div>
      <button type="button" className="btn link small rb-x" onClick={onRemove} aria-label="Remove condition">✕</button>
    </div>
  );
}

function Group({ tree, meta, byKey, onChange, onRemove, depth }) {
  const rules = tree.rules || [];
  const setRule = (i, next) => onChange({ ...tree, rules: rules.map((r, j) => (j === i ? next : r)) });
  const removeRule = (i) => {
    const next = rules.filter((_, j) => j !== i);
    if (!next.length && onRemove) return onRemove();
    onChange({ ...tree, rules: next.length ? next : [emptyRule(meta.fields)] });
  };
  const addRow = () => {
    const last = [...rules].reverse().find((r) => r && !Array.isArray(r.rules));
    const f = last ? byKey[last.field] : null;
    onChange({ ...tree, rules: [...rules, f ? { field: f.key, operator: defaultOperator(f), value: defaultValue(f, defaultOperator(f)) } : emptyRule(meta.fields)] });
  };
  return (
    <div className={'rb-group' + (depth ? ' nested' : '')}>
      <div className="rb-head">
        {depth > 0 && <span className="muted small">…and</span>}
        <select className="input rb-comb" value={tree.combinator}
          onChange={(e) => onChange({ ...tree, combinator: e.target.value })} aria-label="Match mode">
          <option value="and">ALL of the following</option>
          <option value="or">ANY of the following</option>
        </select>
        <span className="muted small">must match</span>
        {depth > 0 && <button type="button" className="btn link small rb-x" onClick={onRemove} aria-label="Remove group">✕ group</button>}
      </div>
      {rules.map((node, i) => (
        node && Array.isArray(node.rules)
          ? <Group key={i} tree={node} meta={meta} byKey={byKey} depth={depth + 1}
              onChange={(next) => setRule(i, next)} onRemove={() => removeRule(i)} />
          : <Row key={i} node={node} meta={meta} byKey={byKey}
              onChange={(next) => setRule(i, next)} onRemove={() => removeRule(i)} />
      ))}
      <div className="rb-actions">
        <button type="button" className="btn ghost small" onClick={addRow}>+ Add condition</button>
        {depth === 0 && (
          <button type="button" className="btn ghost small"
            onClick={() => onChange({ ...tree, rules: [...rules, emptyGroup(meta.fields)] })}>
            + Add a group (ANY/ALL)
          </button>
        )}
      </div>
    </div>
  );
}

export default function RuleBuilder({ meta, value, onChange }) {
  const byKey = React.useMemo(() => Object.fromEntries((meta.fields || []).map((f) => [f.key, f])), [meta.fields]);
  const tree = value && Array.isArray(value.rules) && value.rules.length ? value : emptyGroup(meta.fields);
  const sentence = summarize(tree, meta);
  return (
    <div className="rulebuilder">
      <Group tree={tree} meta={meta} byKey={byKey} onChange={onChange} depth={0} />
      {sentence && (
        <div className="rb-summary">
          <span className="muted small">Applies when:</span> {sentence}
        </div>
      )}
    </div>
  );
}
