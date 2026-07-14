import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useAuth } from '../lib/auth.jsx';
import { api } from '../lib/api.js';
import RuleBuilder, { emptyGroup, summarize } from '../components/RuleBuilder.jsx';

/**
 * The Condition Center studio (admin + super admin).
 *
 * Every condition definition on the platform lives here — the built-in seeded
 * workflow conditions AND admin-authored ones — with full authoring power:
 * wording (internal vs borrower-facing), type (document / information field /
 * form-tool / e-sign / internal), external vs internal visibility, category,
 * and WHEN it applies: every file, only while a rule matches (visual rule
 * builder with live "matches N of M open files" preview), or manual attach.
 */

const AUDIENCE_LABEL = { borrower: 'External', staff: 'Internal', both: 'External + internal' };
const APPLY_LABEL = {
  always: 'Every file (automatic)',
  rules: 'Rule-based (automatic)',
  manual: 'Manual — staff attach it per file',
  legacy: 'Legacy workflow (added when a file is created)',
};

function blankForm() {
  return {
    id: null, conditionType: 'document', label: '', borrowerLabel: '', hint: '', borrowerHint: '',
    audience: 'borrower', category: '', fieldKey: '', toolKey: '', esignDoc: '',
    autoApply: 'rules', ruleLogic: null, isRequired: true, runNow: true,
    origin: 'admin', scope: 'application', instanceCount: 0, version: 1,
  };
}
function formFromDef(d) {
  return {
    id: d.id, conditionType: d.conditionType, label: d.label || '', borrowerLabel: d.borrowerLabel || '',
    hint: d.hint || '', borrowerHint: d.borrowerHint || '',
    audience: d.audience || 'borrower', category: d.category || '',
    fieldKey: d.fieldKey || '', toolKey: d.toolKey || '', esignDoc: d.esignDoc || '',
    autoApply: d.autoApply || 'legacy', ruleLogic: d.ruleLogic || null, isRequired: d.isRequired !== false,
    runNow: true, origin: d.origin, scope: d.scope, instanceCount: d.instanceCount, version: d.version,
    code: d.code, isActive: d.isActive,
  };
}

function blankField() {
  return { label: '', type: 'text', optionsText: '', borrowerLabel: '', borrowerHint: '' };
}

const TYPE_HELP = {
  document: 'The borrower (or staff) uploads a file. It shows in the Documents space and counts in the TPR clean-file export.',
  info_field: 'Asks for a piece of information. The answer is written straight into the real field on the file — no side copies.',
  tool: 'Opens one of the built-in forms (scope of work, track record, title/insurance contact, pricing, appraisal card).',
  esign: 'A “sign this document” condition. When the e-sign integration goes live it opens the signing ceremony and files the signed PDF automatically.',
  internal_task: 'A staff to-do on the file. Never visible to the borrower.',
  internal_condition: 'An internal underwriting checkpoint (sign-off driven). Never visible to the borrower.',
};

export default function StaffConditionStudio() {
  const { can } = useAuth();
  const isAdmin = can('manage_conditions');
  const [meta, setMeta] = useState(null);
  const [defs, setDefs] = useState([]);
  const [view, setView] = useState('list');           // list | edit
  const [form, setForm] = useState(blankForm());
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState(null);               // {ok, text}
  const [q, setQ] = useState('');
  const [fType, setFType] = useState('all');
  const [fAud, setFAud] = useState('all');
  const [showInactive, setShowInactive] = useState(false);
  const [preview, setPreview] = useState(null);       // {matches,total,sample} | {error}
  const [newField, setNewField] = useState(null);     // inline "create a new field" form | null
  const previewTimer = useRef(null);

  const flash = (ok, text) => { setMsg({ ok, text }); setTimeout(() => setMsg(null), 6000); };

  const load = () => Promise.all([api.adminConditionFields(), api.adminConditionDefs()])
    .then(([m, d]) => { setMeta(m); setDefs(d); })
    .catch((e) => flash(false, e.message || 'could not load the condition library'));
  useEffect(() => { if (isAdmin) load(); }, [isAdmin]);

  // Create a brand-new fillable field inline and select it for this condition.
  async function createField() {
    if (!newField.label.trim()) return flash(false, 'Give the new field a name.');
    const body = {
      label: newField.label.trim(), type: newField.type,
      borrowerLabel: newField.borrowerLabel.trim() || undefined,
      borrowerHint: newField.borrowerHint.trim() || undefined,
    };
    if (newField.type === 'enum') {
      const opts = newField.optionsText.split('\n').map((s) => s.trim()).filter(Boolean);
      if (opts.length < 2) return flash(false, 'A dropdown field needs at least two choices.');
      body.options = opts.map((label) => ({ label }));
    }
    setBusy(true);
    try {
      const r = await api.adminCreateCustomField(body);
      // Refresh the field list so the picker + rule builder see the new field,
      // then select it for this condition.
      const m = await api.adminConditionFields();
      setMeta(m);
      setForm((f) => ({ ...f, fieldKey: r.field.key }));
      setNewField(null);
      flash(true, `Field “${r.field.label}” created and selected.`);
    } catch (e) { flash(false, e.message || 'could not create the field'); }
    setBusy(false);
  }

  // Live rule preview while editing (debounced).
  useEffect(() => {
    if (view !== 'edit' || form.autoApply !== 'rules' || !form.ruleLogic) { setPreview(null); return; }
    clearTimeout(previewTimer.current);
    previewTimer.current = setTimeout(() => {
      api.adminPreviewRule(form.ruleLogic)
        .then((r) => setPreview(r))
        .catch((e) => setPreview({ error: e.message || 'rule is not valid yet' }));
    }, 600);
    return () => clearTimeout(previewTimer.current);
  }, [view, form.autoApply, form.ruleLogic]);

  const typeLabel = useMemo(() => Object.fromEntries(((meta && meta.types) || []).map((t) => [t.v, t.label])), [meta]);
  const catLabel = useMemo(() => Object.fromEntries(((meta && meta.categories) || []).map((c) => [c.v, c.label])), [meta]);
  const writableFields = useMemo(() => ((meta && meta.fields) || []).filter((f) => f.writable), [meta]);

  if (!isAdmin) return <div role="alert" className="notice err">You do not have permission to manage the Condition Center.</div>;

  const filtered = defs.filter((d) => {
    if (!showInactive && !d.isActive) return false;
    if (fType !== 'all' && d.conditionType !== fType) return false;
    if (fAud !== 'all' && d.audience !== fAud) return false;
    if (q && !(`${d.label} ${d.borrowerLabel || ''} ${d.code}`.toLowerCase().includes(q.toLowerCase()))) return false;
    return true;
  });
  const groups = [
    { key: 'always', title: 'On every file — automatic', items: filtered.filter((d) => d.autoApply === 'always' && d.isActive) },
    { key: 'rules', title: 'Rule-based — automatic while the rule matches', items: filtered.filter((d) => d.autoApply === 'rules' && d.isActive) },
    { key: 'manual', title: 'Manual library — staff attach per file', items: filtered.filter((d) => d.autoApply === 'manual' && d.isActive) },
    { key: 'legacy', title: 'Built-in workflow — added when a file is created', items: filtered.filter((d) => !d.autoApply && d.isActive) },
    { key: 'inactive', title: 'Inactive / retired', items: filtered.filter((d) => !d.isActive) },
  ].filter((g) => g.items.length);

  const startNew = () => { setForm(blankForm()); setPreview(null); setNewField(null); setView('edit'); };
  const startEdit = (d) => { setForm(formFromDef(d)); setPreview(null); setNewField(null); setView('edit'); };

  const save = async () => {
    if (!form.label.trim()) return flash(false, 'Give the condition a name.');
    if (form.conditionType === 'info_field' && !form.fieldKey) return flash(false, 'Pick which field the borrower fills in.');
    if (form.conditionType === 'tool' && !form.toolKey) return flash(false, 'Pick which form/tool this condition opens.');
    if (form.autoApply === 'rules' && !(form.ruleLogic && form.ruleLogic.rules && form.ruleLogic.rules.length))
      return flash(false, 'Add at least one rule, or choose a different apply mode.');
    setBusy(true);
    const body = {
      label: form.label, borrowerLabel: form.borrowerLabel, hint: form.hint, borrowerHint: form.borrowerHint,
      conditionType: form.conditionType, audience: form.audience, category: form.category || null,
      fieldKey: form.conditionType === 'info_field' ? form.fieldKey : undefined,
      toolKey: form.conditionType === 'tool' ? form.toolKey : undefined,
      esignDoc: form.conditionType === 'esign' ? form.esignDoc : undefined,
      autoApply: form.autoApply === 'legacy' ? null : form.autoApply,
      ruleLogic: form.ruleLogic, isRequired: form.isRequired, runNow: form.runNow,
    };
    try {
      const r = form.id
        ? await api.adminUpdateConditionDef(form.id, body)
        : await api.adminCreateConditionDef(body);
      const ran = r.run ? ` Rules ran across ${r.run.files} open file${r.run.files === 1 ? '' : 's'}: ${r.run.added} added, ${r.run.removed} retracted.` : '';
      flash(true, `${form.id ? 'Saved' : 'Created'} “${form.label}”.${ran}`);
      setView('list'); await load();
    } catch (e) { flash(false, e.message || 'could not save'); }
    setBusy(false);
  };

  const toggleActive = async (d) => {
    setBusy(true);
    try {
      await api.adminUpdateConditionDef(d.id, { isActive: !d.isActive });
      flash(true, `${d.label} is now ${d.isActive ? 'inactive' : 'active'}.`);
      await load();
    } catch (e) { flash(false, e.message || 'could not update'); }
    setBusy(false);
  };

  const remove = async (d) => {
    let removeFromFiles = false;
    if (d.instanceCount > 0) {
      // Ask whether to also strip it off the files it's on, or just retire it.
      const both = window.confirm(
        `“${d.label}” is on ${d.instanceCount} file(s).\n\n` +
        `• OK = DELETE it everywhere: remove it from those ${d.instanceCount} file(s) AND delete the definition. (Uploaded documents stay in each file's history, just unlinked.)\n` +
        `• Cancel = choose to only retire it (kept on existing files, never added again).`);
      if (both) {
        removeFromFiles = true;
      } else {
        if (!window.confirm(`Retire “${d.label}” instead? It stays on the ${d.instanceCount} existing file(s) but is never added anywhere new.`)) return;
      }
    } else {
      if (!window.confirm(`Delete “${d.label}”? It has never been used, so it will be removed completely.`)) return;
    }
    setBusy(true);
    try {
      const r = await api.adminDeleteConditionDef(d.id, removeFromFiles);
      flash(true, r.removedFromFiles != null
        ? `Deleted — removed from ${r.removedFromFiles} file(s) and the library.`
        : r.deleted ? 'Deleted.' : 'Retired — existing files keep it; it will not be added anywhere new.');
      await load();
    } catch (e) { flash(false, e.message || 'could not delete'); }
    setBusy(false);
  };

  const runAll = async () => {
    setBusy(true);
    try {
      const r = await api.adminRunAllConditions();
      flash(true, `Rules ran across ${r.files} open files — ${r.added} conditions added, ${r.removed} retracted (${r.filesTouched} files touched).`);
      await load();
    } catch (e) { flash(false, e.message || 'run failed'); }
    setBusy(false);
  };

  if (!meta) return <div className="muted">Loading the condition library…</div>;

  // ---------------- editor ----------------
  if (view === 'edit') {
    const external = form.audience !== 'staff';
    const isLegacyScope = form.scope && form.scope !== 'application';
    return (
      <div>
        <div className="page-head">
          <div><h1>{form.id ? 'Edit condition' : 'New condition'}</h1></div>
          <div className="page-head-actions">
            <button className="btn btn-ghost btn-sm" onClick={() => setView('list')}>← Back to the library</button>
          </div>
        </div>
        {msg && <div className={`notice ${msg.ok ? 'ok' : 'err'}`} role="alert">{msg.text}</div>}
        {form.id && (
          <p className="muted small">
            {form.origin === 'system' ? 'Built-in condition' : 'Custom condition'} · code <code>{form.code}</code> · v{form.version}
            {form.instanceCount > 0 && <> · on {form.instanceCount} file(s) — files keep the wording they were issued with; your edits apply to new placements.</>}
          </p>
        )}

        <div className="panel" style={{ marginBottom: 16 }}>
          <h3 style={{ marginTop: 0 }}>1 · What kind of condition is this?</h3>
          <div className="cc-typegrid">
            {meta.types.map((t) => (
              <button key={t.v} type="button"
                className={'cc-typecard' + (form.conditionType === t.v ? ' on' : '')}
                onClick={() => setForm((f) => ({
                  ...f, conditionType: t.v,
                  audience: (t.v === 'internal_task' || t.v === 'internal_condition') ? 'staff'
                    : (t.v === 'info_field' && f.audience === 'staff') ? 'borrower' : f.audience,
                }))}>
                <strong>{t.label}</strong>
                <span className="muted small">{TYPE_HELP[t.v]}</span>
              </button>
            ))}
          </div>
          {form.conditionType === 'info_field' && (
            <div style={{ marginTop: 14, maxWidth: 560 }}>
              <div className="field" style={{ marginBottom: 8 }}>
                <label>Which field should the borrower fill in?</label>
                <div className="row" style={{ gap: 8 }}>
                  <select className="input" style={{ flex: 1 }} value={newField ? '' : form.fieldKey}
                    disabled={!!newField}
                    onChange={(e) => setForm((f) => ({ ...f, fieldKey: e.target.value }))}>
                    <option value="" disabled>Choose an existing field…</option>
                    <optgroup label="Built-in fields">
                      {writableFields.filter((f) => !f.custom).map((f) => <option key={f.key} value={f.key}>{f.group} — {f.label}</option>)}
                    </optgroup>
                    {writableFields.some((f) => f.custom) && (
                      <optgroup label="Custom fields you created">
                        {writableFields.filter((f) => f.custom).map((f) => <option key={f.key} value={f.key}>{f.label}</option>)}
                      </optgroup>
                    )}
                  </select>
                  {!newField && (
                    <button type="button" className="btn ghost small" onClick={() => setNewField(blankField())}>+ Create a new field</button>
                  )}
                </div>
                <span className="muted small">
                  Existing fields can be filled elsewhere too. Create a NEW field when you want a piece of information that only this condition collects.
                </span>
                {form.fieldKey && !newField && (
                  <span className="muted small">The answer writes straight into “{(writableFields.find((f) => f.key === form.fieldKey) || {}).label}”.</span>
                )}
              </div>
              {newField && (
                <div className="panel" style={{ background: 'var(--ink-2)', borderColor: 'var(--teal-dp)' }}>
                  <div className="row" style={{ justifyContent: 'space-between', marginBottom: 8 }}>
                    <strong className="small">New field</strong>
                    <button type="button" className="btn link small" onClick={() => setNewField(null)}>Cancel — use an existing field</button>
                  </div>
                  <div className="grid cols-2">
                    <div className="field">
                      <label>Field name (staff)</label>
                      <input className="input" value={newField.label} placeholder="e.g. Number of contractors"
                        onChange={(e) => setNewField((n) => ({ ...n, label: e.target.value }))} />
                    </div>
                    <div className="field">
                      <label>Answer type</label>
                      <select className="input" value={newField.type} onChange={(e) => setNewField((n) => ({ ...n, type: e.target.value }))}>
                        <option value="text">Text</option>
                        <option value="number">Number</option>
                        <option value="money">Money ($)</option>
                        <option value="percent">Percent (%)</option>
                        <option value="date">Date</option>
                        <option value="boolean">Yes / No</option>
                        <option value="enum">Dropdown (choices)</option>
                      </select>
                    </div>
                  </div>
                  {newField.type === 'enum' && (
                    <div className="field">
                      <label>Dropdown choices (one per line)</label>
                      <textarea className="input" rows={3} value={newField.optionsText}
                        placeholder={'Option A\nOption B\nOption C'}
                        onChange={(e) => setNewField((n) => ({ ...n, optionsText: e.target.value }))} />
                    </div>
                  )}
                  <div className="grid cols-2">
                    <div className="field">
                      <label>Borrower-facing name (optional)</label>
                      <input className="input" value={newField.borrowerLabel} placeholder="Defaults to the field name"
                        onChange={(e) => setNewField((n) => ({ ...n, borrowerLabel: e.target.value }))} />
                    </div>
                    <div className="field">
                      <label>Borrower instructions (optional)</label>
                      <input className="input" value={newField.borrowerHint} placeholder="One sentence on what to enter"
                        onChange={(e) => setNewField((n) => ({ ...n, borrowerHint: e.target.value }))} />
                    </div>
                  </div>
                  <button type="button" className="btn primary small" disabled={busy} onClick={createField}>
                    {busy ? 'Creating…' : 'Create field & use it'}
                  </button>
                </div>
              )}
            </div>
          )}
          {form.conditionType === 'tool' && (
            <div className="field" style={{ marginTop: 14, maxWidth: 460 }}>
              <label>Which form / tool does it open?</label>
              <select className="input" value={form.toolKey} onChange={(e) => setForm((f) => ({ ...f, toolKey: e.target.value }))}>
                <option value="" disabled>Choose a form…</option>
                {meta.tools.map((t) => <option key={t.v} value={t.v}>{t.label}</option>)}
              </select>
            </div>
          )}
          {form.conditionType === 'esign' && (
            <div className="field" style={{ marginTop: 14, maxWidth: 460 }}>
              <label>Document to be signed</label>
              <input className="input" value={form.esignDoc} placeholder="e.g. Personal Guaranty"
                onChange={(e) => setForm((f) => ({ ...f, esignDoc: e.target.value }))} />
              <span className="muted small">Shows on the condition now; the e-sign ceremony activates when the integration goes live.</span>
            </div>
          )}
        </div>

        <div className="panel" style={{ marginBottom: 16 }}>
          <h3 style={{ marginTop: 0 }}>2 · Wording & visibility</h3>
          <div className="grid cols-2">
            <div className="field">
              <label>Internal name (staff see this)</label>
              <input className="input" value={form.label} onChange={(e) => setForm((f) => ({ ...f, label: e.target.value }))}
                placeholder="e.g. Feasibility study — NJ/NY mid-size rehab" />
            </div>
            <div className="field">
              <label>Visibility</label>
              {(() => {
                const internalOnly = form.conditionType === 'internal_task' || form.conditionType === 'internal_condition';
                const opts = internalOnly
                  ? [['staff', 'Internal — staff only']]
                  : form.conditionType === 'info_field'
                    ? [['borrower', 'External — borrower sees & completes it'], ['both', 'External + internal — both work it']]
                    : [['borrower', 'External — borrower sees & completes it'], ['both', 'External + internal — both work it'], ['staff', 'Internal — staff only']];
                return (
                  <select className="input" value={form.audience} disabled={internalOnly}
                    onChange={(e) => setForm((f) => ({ ...f, audience: e.target.value }))}>
                    {opts.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
                  </select>
                );
              })()}
            </div>
          </div>
          {external && (
            <div className="grid cols-2">
              <div className="field">
                <label>Borrower-facing name {form.audience !== 'staff' ? '' : '(unused)'}</label>
                <input className="input" value={form.borrowerLabel} onChange={(e) => setForm((f) => ({ ...f, borrowerLabel: e.target.value }))}
                  placeholder="What the borrower sees (never mention capital partners)" />
              </div>
              <div className="field">
                <label>Borrower-facing instructions</label>
                <input className="input" value={form.borrowerHint} onChange={(e) => setForm((f) => ({ ...f, borrowerHint: e.target.value }))}
                  placeholder="One sentence telling them exactly what you need" />
              </div>
            </div>
          )}
          <div className="grid cols-2">
            <div className="field">
              <label>Internal note / hint</label>
              <input className="input" value={form.hint} onChange={(e) => setForm((f) => ({ ...f, hint: e.target.value }))}
                placeholder="Context for the team (borrowers never see this)" />
            </div>
            <div className="field">
              <label>Category (when it must clear)</label>
              <select className="input" value={form.category} onChange={(e) => setForm((f) => ({ ...f, category: e.target.value }))}>
                <option value="">No category</option>
                {meta.categories.map((c) => <option key={c.v} value={c.v}>{c.label}</option>)}
              </select>
            </div>
          </div>
          <label className="small" style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <input type="checkbox" checked={form.isRequired} onChange={(e) => setForm((f) => ({ ...f, isRequired: e.target.checked }))} />
            Required to close (unchecked = optional / nice-to-have)
          </label>
        </div>

        <div className="panel" style={{ marginBottom: 16 }}>
          <h3 style={{ marginTop: 0 }}>3 · When does it apply?</h3>
          {isLegacyScope && <div className="notice info">This is a {form.scope === 'llc' ? 'per-entity document slot' : 'borrower-profile item'} — it is placed by the {form.scope === 'llc' ? 'entity workflow' : 'profile workflow'}, so automatic rules are not available here.</div>}
          <div className="cc-applyrow">
            {['always', 'rules', 'manual'].concat(form.origin === 'system' && form.id ? ['legacy'] : []).map((mode) => (
              <label key={mode} className={'cc-apply' + (form.autoApply === mode ? ' on' : '')}>
                <input type="radio" name="autoApply" checked={form.autoApply === mode} disabled={isLegacyScope && mode !== 'legacy'}
                  onChange={() => setForm((f) => ({ ...f, autoApply: mode, ruleLogic: mode === 'rules' ? (f.ruleLogic || emptyGroup(meta.fields)) : f.ruleLogic }))} />
                {APPLY_LABEL[mode]}
              </label>
            ))}
          </div>
          {form.autoApply === 'rules' && (
            <>
              <RuleBuilder meta={meta} value={form.ruleLogic || emptyGroup(meta.fields)}
                onChange={(tree) => setForm((f) => ({ ...f, ruleLogic: tree }))} />
              <div className="cc-preview" aria-live="polite">
                {preview && preview.error && <span className="muted small">⚠ {preview.error}</span>}
                {preview && !preview.error && (
                  <span className="small">
                    <strong>{preview.matches}</strong> of {preview.total} open files match right now
                    {preview.sample && preview.sample.length > 0 && (
                      <span className="muted"> — e.g. {preview.sample.map((s) => s.ysLoanNumber || s.borrower || s.address).filter(Boolean).slice(0, 4).join(' · ')}</span>
                    )}
                  </span>
                )}
              </div>
            </>
          )}
          {form.autoApply === 'legacy' && (
            <p className="muted small">Legacy behavior: added once when a file is created{form.id ? '' : ''} (program/loan-type filters from the original workflow). Switch to “Rule-based” to manage it with the rule engine instead.</p>
          )}
          {(form.autoApply === 'always' || form.autoApply === 'rules') && (
            <label className="small" style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 10 }}>
              <input type="checkbox" checked={form.runNow} onChange={(e) => setForm((f) => ({ ...f, runNow: e.target.checked }))} />
              Apply to matching open files immediately after saving
            </label>
          )}
        </div>

        <div className="row" style={{ gap: 10 }}>
          <button className="btn primary" disabled={busy} onClick={save}>{busy ? 'Saving…' : (form.id ? 'Save condition' : 'Create condition')}</button>
          <button className="btn ghost" disabled={busy} onClick={() => setView('list')}>Cancel</button>
        </div>
      </div>
    );
  }

  // ---------------- list ----------------
  const active = defs.filter((d) => d.isActive);
  return (
    <div>
      <div className="page-head">
        <div>
          <h1>Condition Center</h1>
          <div className="sub">Every condition on the platform — built-in and custom — with the logic that places it on files. Edits never rewrite conditions already issued to files; they shape what goes out from now on.</div>
        </div>
        <div className="page-head-actions">
          <button className="btn btn-ghost btn-sm" disabled={busy} onClick={runAll} title="Re-run every automatic rule across all open files">Re-run all rules</button>
          <button className="btn primary" onClick={startNew}>+ New condition</button>
        </div>
      </div>
      {msg && <div className={`notice ${msg.ok ? 'ok' : 'err'}`} role="alert">{msg.text}</div>}

      <div className="kpi-grid" style={{ marginBottom: 14 }}>
        <div className="kpi"><div className="v">{active.length}</div><div className="k">Active conditions</div></div>
        <div className="kpi"><div className="v">{active.filter((d) => d.autoApply === 'always').length}</div><div className="k">On every file</div></div>
        <div className="kpi"><div className="v">{active.filter((d) => d.autoApply === 'rules').length}</div><div className="k">Rule-based</div></div>
        <div className="kpi"><div className="v">{active.filter((d) => d.autoApply === 'manual').length}</div><div className="k">Manual library</div></div>
        <div className="kpi"><div className="v">{active.filter((d) => !d.autoApply).length}</div><div className="k">Built-in workflow</div></div>
      </div>

      <div className="row" style={{ gap: 8, flexWrap: 'wrap', marginBottom: 12 }}>
        <input className="input" style={{ maxWidth: 260 }} placeholder="Search conditions…" value={q} onChange={(e) => setQ(e.target.value)} />
        <select className="input" style={{ maxWidth: 210 }} value={fType} onChange={(e) => setFType(e.target.value)}>
          <option value="all">All types</option>
          {meta.types.map((t) => <option key={t.v} value={t.v}>{t.label}</option>)}
        </select>
        <select className="input" style={{ maxWidth: 210 }} value={fAud} onChange={(e) => setFAud(e.target.value)}>
          <option value="all">Internal + external</option>
          <option value="borrower">External (borrower)</option>
          <option value="both">External + internal</option>
          <option value="staff">Internal only</option>
        </select>
        <label className="small muted" style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <input type="checkbox" checked={showInactive} onChange={(e) => setShowInactive(e.target.checked)} /> Show inactive
        </label>
      </div>

      {groups.map((g) => (
        <div className="panel" key={g.key} style={{ marginBottom: 14 }}>
          <div className="panel-h"><h3>{g.title}</h3><span className="pill mut">{g.items.length}</span></div>
          <div className="panel-b">
          {g.items.map((d) => (
            <div className="checkitem cc-defrow" key={d.id}>
              <span className={'dot ' + (d.isActive ? 'done' : 'outstanding')} aria-hidden />
              <div style={{ flex: 1, minWidth: 0 }}>
                <div className="cc-defline">
                  <strong className="cc-def-title">{d.label}</strong>
                  <span className={`pill cc-type cc-type-${d.conditionType}`}>{typeLabel[d.conditionType] || d.conditionType}</span>
                  <span className={'pill cc-aud-' + d.audience}>{AUDIENCE_LABEL[d.audience] || d.audience}</span>
                  {d.category && <span className="pill">{catLabel[d.category] || d.category}</span>}
                  {d.origin === 'system' && <span className="pill" style={{ borderColor: 'var(--gold)', color: 'var(--gold)' }}>Built-in</span>}
                  {d.fieldKey && <span className="pill">→ {d.fieldKey}</span>}
                </div>
                {d.borrowerLabel && d.borrowerLabel !== d.label && <div className="muted small">Borrower sees: “{d.borrowerLabel}”</div>}
                {d.autoApply === 'rules' && d.ruleSummary && <div className="muted small">Applies when: {d.ruleSummary}</div>}
                {!d.autoApply && (d.appliesProgram || d.appliesLoanType) && (
                  <div className="muted small">Legacy filter: {[d.appliesProgram, d.appliesLoanType].filter(Boolean).join(' · ')}</div>
                )}
                <div className="muted small">
                  On {d.instanceCount} file(s){d.openCount > 0 && <>, {d.openCount} open</>} · v{d.version}
                  {d.updatedByName && <> · last edited by {d.updatedByName}</>}
                </div>
              </div>
              <div className="row" style={{ gap: 6, flexShrink: 0 }}>
                <button className="btn ghost small" onClick={() => startEdit(d)}>Edit</button>
                <button className="btn ghost small" disabled={busy} onClick={() => toggleActive(d)}>{d.isActive ? 'Deactivate' : 'Activate'}</button>
                <button className="btn link small" disabled={busy} onClick={() => remove(d)}>Delete</button>
              </div>
            </div>
          ))}
          </div>
        </div>
      ))}
      {!groups.length && <div className="empty-state"><h3>Nothing matches your filters</h3><p>Try clearing the search box or the type / visibility filters.</p></div>}
    </div>
  );
}
