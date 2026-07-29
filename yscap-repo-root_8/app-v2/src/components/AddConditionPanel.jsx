import React, { useEffect, useMemo, useState } from 'react';
import { api } from '../lib/api.js';
import { InfoTip } from './FileSections.jsx';
import { strayConditionReason, strayConfirmText } from '../lib/conditionLabel.js';

/**
 * Per-file "Add a condition" panel (Condition Center) — underwriters, LOs,
 * processors and admins build a one-off condition on THIS file with the same
 * type system the admin studio uses, attach a definition from the global
 * library, or re-run the automatic rules on demand.
 */

const TYPE_CHIPS = [
  { v: 'document', label: 'Document upload' },
  { v: 'info_field', label: 'Information field' },
  { v: 'tool', label: 'Form / tool' },
  { v: 'esign', label: 'E-signature' },
  { v: 'internal_task', label: 'Internal task' },
  { v: 'internal_condition', label: 'Internal checkpoint' },
];

function blank() {
  return { conditionType: 'document', label: '', borrowerLabel: '', borrowerHint: '',
    audience: 'borrower', category: '', fieldKey: '', toolKey: '', esignDoc: '' };
}

export default function AddConditionPanel({ appId, items, onChanged, onError, onFlash }) {
  const [meta, setMeta] = useState(null);
  const [f, setF] = useState(blank());
  const [attachId, setAttachId] = useState('');
  const [busy, setBusy] = useState('');

  useEffect(() => { api.staffConditionMeta().then(setMeta).catch(() => {}); }, []);

  const writable = useMemo(() => ((meta && meta.fields) || []).filter((x) => x.writable), [meta]);
  const onFileCodes = useMemo(() => new Set((items || []).map((it) => it.template_code).filter(Boolean)), [items]);
  const attachable = useMemo(() => ((meta && meta.library) || []).filter((l) => !onFileCodes.has(l.code)), [meta, onFileCodes]);
  const internal = f.conditionType === 'internal_task' || f.conditionType === 'internal_condition';
  const external = !internal && f.audience !== 'staff';

  const setType = (v) => setF((x) => ({
    ...x, conditionType: v,
    audience: (v === 'internal_task' || v === 'internal_condition') ? 'staff'
      : (v === 'info_field' && x.audience === 'staff') ? 'borrower' : x.audience,
  }));

  async function add() {
    if (busy) return;
    if (!f.label.trim()) return onError('Give the condition a name.');
    if (f.conditionType === 'info_field' && !f.fieldKey) return onError('Pick which field the borrower fills in.');
    if (f.conditionType === 'tool' && !f.toolKey) return onError('Pick which form this condition opens.');
    const label = f.label.trim();
    const strayReason = strayConditionReason(label);
    if (strayReason && !window.confirm(strayConfirmText(strayReason, label))) return;
    setBusy('add');
    try {
      await api.staffAddCustomCondition(appId, {
        conditionType: f.conditionType, label,
        borrowerLabel: f.borrowerLabel.trim() || undefined, borrowerHint: f.borrowerHint.trim() || undefined,
        audience: internal ? 'staff' : f.audience, category: f.category || undefined,
        fieldKey: f.conditionType === 'info_field' ? f.fieldKey : undefined,
        toolKey: f.conditionType === 'tool' ? f.toolKey : undefined,
        esignDoc: f.conditionType === 'esign' ? (f.esignDoc.trim() || undefined) : undefined,
        confirmStrayLabel: strayReason ? true : undefined,
      });
      onFlash(external ? 'Condition added ✓ — the borrower was notified.' : 'Internal condition added ✓');
      setF(blank());
      await onChanged();
    } catch (e) { onError(e.message || 'Could not add the condition'); }
    finally { setBusy(''); }
  }

  async function attach() {
    if (!attachId || busy) return;
    setBusy('attach');
    try {
      await api.staffAttachCondition(appId, attachId);
      onFlash('Library condition attached ✓');
      setAttachId('');
      await onChanged();
    } catch (e) { onError(e.message || 'Could not attach'); }
    finally { setBusy(''); }
  }

  async function rerun() {
    if (busy) return;
    setBusy('rerun');
    try {
      const r = await api.staffReevaluateConditions(appId);
      const added = (r.added || []).map((x) => x.label);
      const removed = (r.removed || []).map((x) => x.label);
      onFlash(!added.length && !removed.length
        ? 'Rules re-ran — everything already in sync ✓'
        : `Rules re-ran ✓ ${added.length ? `Added: ${added.join(', ')}. ` : ''}${removed.length ? `Retracted: ${removed.join(', ')}.` : ''}`);
      if (added.length || removed.length) await onChanged();
    } catch (e) { onError(e.message || 'Could not re-run the rules'); }
    finally { setBusy(''); }
  }

  return (
    <div className="panel">
      <h3 style={{ marginBottom: 8 }}>Add a condition <InfoTip tip="Build a one-off condition for THIS file — document, information field, form, e-sign or internal. External conditions appear on the borrower's list and notify them; internal ones stay with the team." /></h3>
      <div className="cc-addgrid" role="group" aria-label="Condition type">
        {TYPE_CHIPS.map((t) => (
          <button key={t.v} type="button" className={'cc-addtype' + (f.conditionType === t.v ? ' on' : '')}
            onClick={() => setType(t.v)}>{t.label}</button>
        ))}
      </div>
      <div className="field">
        <label>{internal ? 'Task / checkpoint' : 'Internal name (staff see this)'}</label>
        <input className="input" value={f.label} placeholder={
          f.conditionType === 'document' ? 'e.g. Updated bank statement'
            : f.conditionType === 'info_field' ? 'e.g. Confirm the after-repair value'
            : f.conditionType === 'esign' ? 'e.g. Sign the personal guaranty'
            : 'What needs to happen?'}
          onChange={(e) => setF((x) => ({ ...x, label: e.target.value }))}
          onKeyDown={(e) => e.key === 'Enter' && add()} />
      </div>
      {f.conditionType === 'info_field' && (
        <div className="field">
          <label>Field the borrower fills in</label>
          <select className="input" value={f.fieldKey} onChange={(e) => setF((x) => ({ ...x, fieldKey: e.target.value }))}>
            <option value="" disabled>Choose a field…</option>
            {writable.map((w) => <option key={w.key} value={w.key}>{w.group} — {w.label}</option>)}
          </select>
        </div>
      )}
      {f.conditionType === 'tool' && meta && (
        <div className="field">
          <label>Form / tool it opens</label>
          <select className="input" value={f.toolKey} onChange={(e) => setF((x) => ({ ...x, toolKey: e.target.value }))}>
            <option value="" disabled>Choose a form…</option>
            {meta.tools.map((t) => <option key={t.v} value={t.v}>{t.label}</option>)}
          </select>
        </div>
      )}
      {f.conditionType === 'esign' && (
        <div className="field">
          <label>Document to be signed</label>
          <input className="input" value={f.esignDoc} placeholder="e.g. Personal Guaranty"
            onChange={(e) => setF((x) => ({ ...x, esignDoc: e.target.value }))} />
        </div>
      )}
      <div className="grid cols-2">
        {!internal && (
          <div className="field">
            <label>Visibility</label>
            <select className="input" value={f.audience} onChange={(e) => setF((x) => ({ ...x, audience: e.target.value }))}>
              <option value="borrower">External — borrower completes it</option>
              <option value="both">External + internal</option>
              {f.conditionType !== 'info_field' && <option value="staff">Internal — staff only</option>}
            </select>
          </div>
        )}
        <div className="field">
          <label>Category</label>
          <select className="input" value={f.category} onChange={(e) => setF((x) => ({ ...x, category: e.target.value }))}>
            <option value="">No category</option>
            {((meta && meta.categories) || []).map((c) => <option key={c.v} value={c.v}>{c.label}</option>)}
          </select>
        </div>
      </div>
      {external && (
        <div className="grid cols-2">
          <div className="field">
            <label>Borrower-facing name (optional)</label>
            <input className="input" value={f.borrowerLabel} placeholder="Defaults to the name above"
              onChange={(e) => setF((x) => ({ ...x, borrowerLabel: e.target.value }))} />
          </div>
          <div className="field">
            <label>Instructions for the borrower (optional)</label>
            <input className="input" value={f.borrowerHint} placeholder="One sentence on exactly what you need"
              onChange={(e) => setF((x) => ({ ...x, borrowerHint: e.target.value }))} />
          </div>
        </div>
      )}
      <div className="row" style={{ gap: 8 }}>
        <button className="btn primary" onClick={add} disabled={busy === 'add'}>{busy === 'add' ? 'Adding…' : 'Add condition'}</button>
      </div>

      <div className="gold-rule" style={{ margin: '14px 0' }} />
      <div className="row" style={{ gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
        <select className="input" style={{ flex: 1, minWidth: 200 }} value={attachId} onChange={(e) => setAttachId(e.target.value)}>
          <option value="">Attach from the condition library…</option>
          {attachable.map((l) => <option key={l.id} value={l.id}>{l.label}{l.autoApply === 'manual' ? '' : ' (auto)'}</option>)}
        </select>
        <button className="btn ghost small" onClick={attach} disabled={!attachId || busy === 'attach'}>Attach</button>
        <button className="btn ghost small" onClick={rerun} disabled={busy === 'rerun'}
          title="Re-check every automatic condition rule against this file's current data">
          {busy === 'rerun' ? 'Running…' : '↻ Re-run rules'}
        </button>
      </div>
    </div>
  );
}
