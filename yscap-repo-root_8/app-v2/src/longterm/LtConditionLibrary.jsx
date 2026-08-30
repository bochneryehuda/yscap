import React, { useCallback, useEffect, useMemo, useState } from 'react';
import LtLayout from './LtLayout.jsx';
import { ltApi } from './api.js';

/**
 * THE CONDITION LIBRARY — the settings side of the general Condition Center.
 *
 * The owner asked for exactly this (2026-08-30): *"everything should be setup
 * with not setting it on a hard level everything should be able to be configured
 * differently in settings. The system is only prefilled with the rules of the
 * system."*
 *
 * So every condition PILOT ships with is a row somebody can edit here: its
 * wording, which gate it blocks, whether the borrower sees it, whether it is
 * required, whether it applies at all, and the rule that decides which files
 * get it.
 *
 * ── FOUR THINGS ARE DELIBERATE ──────────────────────────────────────────────
 *
 * 1. THE RULE IS SHOWN IN WORDS, always. A rule an administrator cannot READ is
 *    a rule they cannot safely change, and this screen exists to let them change
 *    them. The words come from the SERVER (`ruleInWords`), so the sentence here
 *    and the sentence the engine acts on can never be two different sentences.
 *
 * 2. THE FIELD PICKER IS THE SERVER'S. The rule builder's fields, operators and
 *    labels all come from `GET /condition-center/library`, so this screen can
 *    never offer a field the evaluator would then refuse — and a field added to
 *    the registry appears here with no change to this file.
 *
 * 3. SAVING SAYS WHAT IT DID *NOT* DO. Editing a template does not rewrite the
 *    files that already carry a copy of it — a live file's wording is a snapshot
 *    on purpose — and somebody who does not know that would believe they had
 *    just changed every file in the book. The server's own note says so and this
 *    screen prints it.
 *
 * 4. EVERY COLOUR IS AN EXPLICIT DARK ON WHITE (`--ink*` is a LIGHT paper colour
 *    in this palette).
 */

const INK = '#141B22';
const MUTED = '#4B585C';
const LINE = '#E6E1D6';
const GOLD = '#AE8746';
const AMBER = '#8A6A17';
const RED = '#8A2D2D';

const KIND_LABEL = {
  informational: 'Information — a fact to record; nothing is collected',
  form: 'Form — something filled in inside PILOT',
  order: 'Order — something ordered from an outside party',
  esign: 'Signature — something signed',
  document: 'Document — something uploaded',
};

const AUDIENCE_LABEL = {
  internal: 'Only our team',
  external: 'Only the borrower',
  both: 'Our team and the borrower',
};

const APPLY_LABEL = {
  always: 'Every long-term file',
  rules: 'Files matching a rule',
  manual: 'Only when somebody adds it by hand',
};

export default function LtConditionLibrary() {
  const [data, setData] = useState(null);
  const [err, setErr] = useState(null);
  const [note, setNote] = useState('');
  const [bucket, setBucket] = useState('');
  const [search, setSearch] = useState('');
  const [editing, setEditing] = useState(null);

  const load = useCallback(() => {
    setErr(null);
    ltApi.conditionLibrary()
      .then(setData)
      .catch((e) => setErr(e.message || 'Could not read the condition library.'));
  }, []);
  useEffect(load, [load]);

  const rows = useMemo(() => {
    const list = (data && data.templates) || [];
    const q = search.trim().toLowerCase();
    return list.filter((t) => {
      if (bucket && t.bucket !== bucket) return false;
      if (!q) return true;
      return [t.label, t.code, t.hint, t.borrowerLabel].some((v) => v && String(v).toLowerCase().includes(q));
    });
  }, [data, bucket, search]);

  const save = async (code, patch) => {
    setNote('');
    try {
      const out = await ltApi.conditionTemplateSave(code, patch);
      setNote(out.note || 'Saved.');
      setEditing(null);
      load();
    } catch (e) {
      setNote(e.message || 'Could not save that.');
    }
  };

  if (err) return <LtLayout title="Conditions"><div className="lt-card" style={{ color: RED }}>{err}</div></LtLayout>;
  if (!data) return <LtLayout title="Conditions"><div className="lt-card" style={{ color: MUTED }}>Reading the library…</div></LtLayout>;

  const buckets = data.buckets || [];

  return (
    <LtLayout title="Conditions">
      <p style={{ margin: '0 0 14px', color: MUTED, maxWidth: 800, lineHeight: 1.55 }}>
        Every condition the long-term side can ask for, and the gate it blocks. Nothing here is
        hard-wired — the wording, the rule and whether it applies at all are all settings, pre-filled
        with our own answers.
      </p>

      {!data.canEdit && (
        <div className="lt-card" style={{ marginBottom: 12, color: AMBER, fontSize: 13, lineHeight: 1.55 }}>
          You can read the library. Changing it is an administrator’s — a template is on every file
          in the book, and its wording is what a borrower reads.
        </div>
      )}

      {note && (
        <div className="lt-card" style={{ marginBottom: 12, color: INK, fontSize: 13, lineHeight: 1.55 }}>{note}</div>
      )}

      {/* THE GATES, in their own order. Clicking one narrows the list rather
          than opening a second screen. */}
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 12 }}>
        <button onClick={() => setBucket('')}
          style={chip(bucket === '')}>All gates</button>
        {buckets.map((b) => (
          <button key={b.key} onClick={() => setBucket(b.key === bucket ? '' : b.key)}
            title={b.blurb || ''} style={chip(bucket === b.key)}>
            {b.label}
            <span style={{ color: MUTED, marginLeft: 6 }}>
              {((data.templates || []).filter((t) => t.bucket === b.key)).length}
            </span>
          </button>
        ))}
      </div>

      <div className="lt-card" style={{ marginBottom: 12 }}>
        <input className="input" style={{ width: '100%', maxWidth: 420 }} value={search}
          placeholder="Find a condition…" onChange={(e) => setSearch(e.target.value)} />
      </div>

      <div style={{ display: 'grid', gap: 8 }}>
        {rows.map((t) => (
          <TemplateRow key={t.code} t={t} data={data} open={editing === t.code}
            canEdit={data.canEdit}
            onOpen={() => setEditing(editing === t.code ? null : t.code)}
            onSave={(patch) => save(t.code, patch)} />
        ))}
        {rows.length === 0 && (
          <div className="lt-card" style={{ color: MUTED, fontSize: 13 }}>
            Nothing matches that.
          </div>
        )}
      </div>
    </LtLayout>
  );
}

function chip(on) {
  return {
    cursor: 'pointer', fontSize: 13, padding: '6px 12px', borderRadius: 999,
    border: on ? `1px solid ${GOLD}` : `1px solid ${LINE}`,
    background: on ? '#FBF6EC' : '#FFFFFF', color: INK,
  };
}

function TemplateRow({ t, data, open, canEdit, onOpen, onSave }) {
  const [draft, setDraft] = useState(null);

  const start = () => {
    setDraft({
      label: t.label || '',
      hint: t.hint || '',
      borrowerLabel: t.borrowerLabel || '',
      borrowerHint: t.borrowerHint || '',
      bucket: t.bucket,
      audience: t.audience,
      kind: t.kind,
      autoApply: t.autoApply,
      isRequired: t.isRequired,
      enabled: t.enabled,
      active: t.active,
      // The template's own settings ride along untouched unless a card below edits
      // them — so saving the wording never blanks a buyer's configured forms.
      config: t.config || {},
    });
    onOpen();
  };

  return (
    <div className="lt-card" style={{ padding: 0, overflow: 'hidden' }}>
      <div style={{ display: 'flex', gap: 12, alignItems: 'flex-start', padding: '12px 16px' }}>
        <div style={{ minWidth: 0, flex: 1 }}>
          <div style={{ fontSize: 14, fontWeight: 600, color: INK }}>
            {t.label}
            {!t.active && <span style={{ color: MUTED, fontWeight: 400 }}> — retired</span>}
            {t.active && !t.enabled && <span style={{ color: AMBER, fontWeight: 400 }}> — switched off</span>}
          </div>
          <div style={{ fontSize: 12, color: MUTED, marginTop: 3 }}>
            {(KIND_LABEL[t.kind] || t.kind).split(' — ')[0]}
            {' · '}{AUDIENCE_LABEL[t.audience] || t.audience}
            {t.isRequired ? ' · required' : ' · optional'}
          </div>
          {/* THE RULE, IN THE SERVER'S OWN WORDS. */}
          <div style={{ fontSize: 12, color: MUTED, marginTop: 3 }}>
            <strong style={{ color: INK, fontWeight: 600 }}>Applies to:</strong>{' '}
            {t.autoApply === 'manual' ? APPLY_LABEL.manual : t.ruleInWords}
          </div>
          {t.enabled === false && t.disabledReason && (
            <div style={{ fontSize: 12, color: AMBER, marginTop: 3 }}>{t.disabledReason}</div>
          )}
        </div>
        <button className="btn soft" onClick={open ? onOpen : start}>
          {open ? 'Close' : (canEdit ? 'Change' : 'Look')}
        </button>
      </div>

      {open && draft && (
        <div style={{ borderTop: `1px solid ${LINE}`, padding: '12px 16px', background: '#FBFAF7' }}>
          <div style={{ display: 'grid', gap: 10, maxWidth: 760 }}>
            <Field label="What our team calls it">
              <input className="input" style={{ width: '100%' }} value={draft.label} disabled={!canEdit}
                onChange={(e) => setDraft({ ...draft, label: e.target.value })} />
            </Field>
            <Field label="What our team is told to do">
              <textarea className="input" rows={3} style={{ width: '100%' }} value={draft.hint} disabled={!canEdit}
                onChange={(e) => setDraft({ ...draft, hint: e.target.value })} />
            </Field>
            <Field label="What the borrower sees it called"
              note="Leave this blank and the condition is our team’s only, whatever the audience says — a borrower must never be shown an internal label.">
              <input className="input" style={{ width: '100%' }} value={draft.borrowerLabel} disabled={!canEdit}
                onChange={(e) => setDraft({ ...draft, borrowerLabel: e.target.value })} />
            </Field>
            <Field label="What the borrower is asked for">
              <textarea className="input" rows={2} style={{ width: '100%' }} value={draft.borrowerHint} disabled={!canEdit}
                onChange={(e) => setDraft({ ...draft, borrowerHint: e.target.value })} />
            </Field>

            <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
              <Field label="Which gate it blocks">
                <select className="input" value={draft.bucket} disabled={!canEdit}
                  onChange={(e) => setDraft({ ...draft, bucket: e.target.value })}>
                  {(data.buckets || []).map((b) => <option key={b.key} value={b.key}>{b.label}</option>)}
                </select>
              </Field>
              <Field label="Who sees it">
                <select className="input" value={draft.audience} disabled={!canEdit}
                  onChange={(e) => setDraft({ ...draft, audience: e.target.value })}>
                  {(data.audiences || []).map((a) => <option key={a} value={a}>{AUDIENCE_LABEL[a] || a}</option>)}
                </select>
              </Field>
              <Field label="What kind of thing it is">
                <select className="input" value={draft.kind} disabled={!canEdit}
                  onChange={(e) => setDraft({ ...draft, kind: e.target.value })}>
                  {(data.kinds || []).map((k) => <option key={k} value={k}>{KIND_LABEL[k] || k}</option>)}
                </select>
              </Field>
              <Field label="Which files get it">
                <select className="input" value={draft.autoApply} disabled={!canEdit}
                  onChange={(e) => setDraft({ ...draft, autoApply: e.target.value })}>
                  {['always', 'rules', 'manual'].map((a) => <option key={a} value={a}>{APPLY_LABEL[a]}</option>)}
                </select>
              </Field>
            </div>

            <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', fontSize: 13, color: INK }}>
              <label style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                <input type="checkbox" checked={draft.isRequired} disabled={!canEdit}
                  onChange={(e) => setDraft({ ...draft, isRequired: e.target.checked })} />
                Required
              </label>
              <label style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                <input type="checkbox" checked={draft.enabled} disabled={!canEdit}
                  onChange={(e) => setDraft({ ...draft, enabled: e.target.checked })} />
                Switched on
              </label>
              <label style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                <input type="checkbox" checked={draft.active} disabled={!canEdit}
                  onChange={(e) => setDraft({ ...draft, active: e.target.checked })} />
                In the library
              </label>
            </div>

            {/* THE RULE IS READ-ONLY HERE, ON PURPOSE. Editing a rule tree needs
                its own builder and a way to try it against a real file before it
                changes every file in the book; the API for both is built
                (`/library/preview`) and the builder is the next thing to draw.
                Showing the rule in words meanwhile is what lets an administrator
                see what they would be changing. */}
            <Field label="The rule that decides which files get it">
              <div style={{ fontSize: 13, color: INK, padding: '8px 10px', border: `1px solid ${LINE}`,
                borderRadius: 8, background: '#FFFFFF', lineHeight: 1.5 }}>
                {draft.autoApply === 'manual' ? APPLY_LABEL.manual : t.ruleInWords}
                <div style={{ fontSize: 12, color: MUTED, marginTop: 6 }}>
                  Changing the rule itself is not on this screen yet. Everything else here is.
                </div>
              </div>
            </Field>

            {t.code === 'lt_order_appraisal' && (
              <AppraisalForms draft={draft} setDraft={setDraft} canEdit={canEdit} />
            )}

            {canEdit && (
              <div style={{ display: 'flex', gap: 8 }}>
                <button className="btn" onClick={() => onSave(draft)}>Save</button>
                <button className="btn ghost" onClick={onOpen}>Cancel</button>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * WHICH APPRAISAL FORM EACH KIND OF PROPERTY TAKES.
 *
 * The owner asked for appraisal ordering to ship switched off, from NAN only, and
 * to come back on as *a settings change, not a new release*. The switch is the
 * "Switched on" box above; this is the other half — the forms — on the SAME card,
 * because "turn it on" and "and order the right form" are one job and splitting
 * them across two screens is how one gets done without the other.
 *
 * A blank box means "use ours". The prefilled numbers show as placeholders rather
 * than values, for the reason the pricing studio learned the hard way: a default
 * painted into a box is stored as somebody's deliberate choice, and then the
 * company default can never move it again.
 */
function AppraisalForms({ draft, setDraft, canEdit }) {
  const KINDS = [
    ['sfr', 'Single family (one unit)', '1004', '1007'],
    ['multi_2_4', 'Two to four units', '1025', '216'],
    ['multi_5_plus', 'Five units or more', 'narrative', null],
    ['condo', 'Condominium', '1073', null],
    ['default', 'Anything else', '1004', null],
  ];
  const cfg = draft.config || {};
  const forms = cfg.forms || {};
  const sched = cfg.rentSchedule || {};
  const put = (group, key, value) => setDraft({
    ...draft,
    config: { ...cfg, [group]: { ...(cfg[group] || {}), [key]: value } },
  });

  return (
    <div style={{ border: `1px solid ${LINE}`, borderRadius: 8, padding: 12, background: '#FFFFFF' }}>
      <div style={{ fontSize: 13, fontWeight: 700, color: INK, marginBottom: 2 }}>Which form each property takes</div>
      <div style={{ fontSize: 12, color: MUTED, marginBottom: 10, lineHeight: 1.5 }}>
        Ordered from NAN. Leave a box empty to use ours. The rent schedule is asked for only on a
        rental-exit loan, and only where one is set here.
      </div>
      {KINDS.map(([key, label, formPre, schedPre]) => (
        <div key={key} style={{
          display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(11rem, 100%), 1fr))',
          gap: 8, alignItems: 'end', marginBottom: 8,
        }}>
          <div style={{ fontSize: 13, color: INK, alignSelf: 'center' }}>{label}</div>
          <label style={{ display: 'block' }}>
            <div style={{ fontSize: 11, color: MUTED, marginBottom: 2 }}>Appraisal form</div>
            <input className="input" disabled={!canEdit} placeholder={formPre}
              value={forms[key] || ''} onChange={(e) => put('forms', key, e.target.value)} />
          </label>
          <label style={{ display: 'block', visibility: schedPre ? 'visible' : 'hidden' }}>
            <div style={{ fontSize: 11, color: MUTED, marginBottom: 2 }}>Rent schedule</div>
            <input className="input" disabled={!canEdit} placeholder={schedPre || ''}
              value={sched[key] || ''} onChange={(e) => put('rentSchedule', key, e.target.value)} />
          </label>
        </div>
      ))}
    </div>
  );
}

function Field({ label, note, children }) {
  return (
    <label style={{ display: 'block' }}>
      <div style={{ fontSize: 12, color: MUTED, marginBottom: 4 }}>{label}</div>
      {children}
      {note && <div style={{ fontSize: 12, color: MUTED, marginTop: 4, lineHeight: 1.5 }}>{note}</div>}
    </label>
  );
}
