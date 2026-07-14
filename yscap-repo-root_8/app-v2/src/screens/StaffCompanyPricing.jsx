import React, { useEffect, useState } from 'react';
import { api } from '../lib/api.js';
import { useAuth } from '../lib/auth.jsx';

/* Pricing Admin Center (super admin / manage_pricing capability).
 *
 * Company-wide markup, origination and fee defaults. A change saved here flows
 * immediately into EVERY not-yet-registered file, the public marketing
 * term-sheet generator, and the in-portal Term Sheet Studio — it re-prices the
 * whole system's defaults. Files that already have a registered product keep
 * their locked-in snapshot (re-register that file to reprice it); this is by
 * design so a live pricing change never silently rewrites a quoted deal.
 *
 * The save is append-only: each save is a new version with a full audit trail,
 * so the history below doubles as a rollback log. The pricing ENGINE math is
 * frozen — this only sets the inputs (markup %, origination %, flat fees) the
 * engine already reads.
 */

// camelCase keys shared by GET .current / .systemDefaults and the PUT body.
const KEYS = ['markupStdPct', 'markupGoldPct', 'origStdPct', 'origGoldPct', 'lenderFee', 'creditFee', 'appraisalFee', 'titleFee'];

const toForm = (o) => {
  const f = {};
  for (const k of KEYS) f[k] = (o && o[k] != null) ? String(o[k]) : '';
  return f;
};
const money = (v) => (v == null || v === '' || isNaN(Number(v))) ? '—' : '$' + Number(v).toLocaleString('en-US', { maximumFractionDigits: 2 });
const pct = (v) => (v == null || v === '' || isNaN(Number(v))) ? '—' : Number(v) + '%';

// Hoisted out of the screen so it keeps a stable identity across renders —
// a component defined inline in render() remounts every keystroke and the
// input loses focus after one character.
function Field({ form, set, k, label, hint }) {
  return (
    <div className="field">
      <label>{label}</label>
      <input className="input" inputMode="decimal" value={form[k]} onChange={(e) => set(k, e.target.value)} />
      {hint && <div className="hint">{hint}</div>}
    </div>
  );
}

export default function StaffCompanyPricing() {
  const { can } = useAuth();
  const isAdmin = can('manage_pricing');
  const [data, setData] = useState(null);       // { current, systemDefaults, history }
  const [form, setForm] = useState(toForm(null));
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState(null);         // { ok, text }

  const flash = (ok, text) => { setMsg({ ok, text }); setTimeout(() => setMsg(null), 7000); };

  const load = () => api.adminPricingGet()
    .then((d) => { setData(d); setForm(toForm(d.current)); })
    .catch((e) => flash(false, e.message || 'could not load pricing settings'));
  useEffect(() => { if (isAdmin) load(); /* eslint-disable-next-line */ }, [isAdmin]);

  if (!isAdmin) return <div className="panel">You don’t have access to the Pricing Admin Center.</div>;
  if (!data) return <div className="panel">Loading pricing…</div>;

  const set = (k, v) => setForm((f) => ({ ...f, [k]: String(v).replace(/[^0-9.]/g, '') }));
  const cur = data.current || {};
  const dirty = KEYS.some((k) => String(cur[k] == null ? '' : cur[k]) !== String(form[k] == null ? '' : form[k]));

  async function save() {
    setBusy(true);
    try {
      const body = { note: note.trim() || undefined };
      for (const k of KEYS) body[k] = form[k] === '' ? null : Number(form[k]);
      await api.adminPricingPut(body);
      setNote('');
      await load();
      flash(true, 'Company pricing updated. New files, the marketing generator and the Term Sheet Studio now use these numbers.');
    } catch (e) { flash(false, e.message || 'could not save pricing settings'); }
    setBusy(false);
  }

  const loadDefaults = () => {
    setForm(toForm(data.systemDefaults));
    flash(true, 'Loaded the original system defaults into the form — review them, then Save to apply.');
  };

  return (
    <div className="stack" style={{ gap: 16 }}>
      <div className="panel">
        <h2 style={{ margin: '0 0 4px' }}>Pricing Admin Center</h2>
        <p className="muted small" style={{ maxWidth: 640, margin: 0 }}>
          Company-wide markup, origination and fee defaults. Saving updates every
          {' '}<strong>not-yet-registered</strong> file, the public term-sheet generator and the
          in-portal Term Sheet Studio right away. Files with a registered product keep their
          locked-in snapshot — re-register that file to reprice it.
        </p>

        {msg && <div className={`notice ${msg.ok ? 'ok' : 'err'}`} role="alert" style={{ marginTop: 12 }}>{msg.text}</div>}

        <h3 style={{ margin: '18px 0 0' }}>Markup over the note-buyer rate</h3>
        <p className="muted small" style={{ margin: '2px 0 8px' }}>The spread added on top of the wholesale rate for each program.</p>
        <div className="grid cols-2">
          <Field form={form} set={set} k="markupStdPct" label="Standard program markup (%)" />
          <Field form={form} set={set} k="markupGoldPct" label="Gold Standard program markup (%)" />
        </div>

        <h3 style={{ margin: '18px 0 0' }}>Origination points</h3>
        <p className="muted small" style={{ margin: '2px 0 8px' }}>Origination fee as a percent of the loan amount.</p>
        <div className="grid cols-2">
          <Field form={form} set={set} k="origStdPct" label="Standard origination (%)" />
          <Field form={form} set={set} k="origGoldPct" label="Gold Standard origination (%)" />
        </div>

        <h3 style={{ margin: '18px 0 0' }}>Flat fees</h3>
        <p className="muted small" style={{ margin: '2px 0 8px' }}>
          Dollar fees applied at closing. Leave <em>Title</em> blank to auto-estimate title per state
          (the frozen title-cost table) instead of a flat number.
        </p>
        <div className="grid cols-2">
          <Field form={form} set={set} k="lenderFee" label="Underwriting / lender fee ($)" />
          <Field form={form} set={set} k="creditFee" label="Credit report fee ($)" />
          <Field form={form} set={set} k="appraisalFee" label="Appraisal fee ($)" />
          <Field form={form} set={set} k="titleFee" label="Title fee ($)" hint="Blank = auto-estimate per state" />
        </div>

        <div className="field" style={{ marginTop: 6 }}>
          <label>Note for the history log (optional)</label>
          <input className="input" value={note} onChange={(e) => setNote(e.target.value)} placeholder="e.g. Q3 rate-sheet update — UW fee to $2,395" />
        </div>

        <div className="row" style={{ gap: 8, marginTop: 14, alignItems: 'center' }}>
          <button className="btn primary" disabled={busy || !dirty} onClick={save}>{busy ? 'Saving…' : 'Save company pricing'}</button>
          <button className="btn link" disabled={busy} onClick={loadDefaults} title="Fill the form with the original system defaults (does not save until you press Save)">Load system defaults</button>
          {dirty && <span className="muted small">Unsaved changes</span>}
        </div>
      </div>

      <div className="panel">
        <h3 style={{ marginTop: 0 }}>Change history</h3>
        <p className="muted small" style={{ marginTop: -4 }}>Every save is a version — the top row is live now.</p>
        <div className="tbl-scroll">
          <table className="tbl">
            <thead>
              <tr>
                <th>When</th><th>By</th>
                <th>Markup (Std / Gold)</th><th>Orig (Std / Gold)</th>
                <th>UW</th><th>Credit</th><th>Appraisal</th><th>Title</th><th>Note</th>
              </tr>
            </thead>
            <tbody>
              {(data.history || []).map((h) => (
                <tr key={h.id} style={h.is_current ? { fontWeight: 600 } : undefined}>
                  <td>{new Date(h.created_at).toLocaleString()}{h.is_current ? ' · live' : ''}</td>
                  <td>{h.updated_by_name || 'System'}</td>
                  <td>{pct(h.markup_std_pct)} / {pct(h.markup_gold_pct)}</td>
                  <td>{pct(h.orig_std_pct)} / {pct(h.orig_gold_pct)}</td>
                  <td>{money(h.lender_fee)}</td>
                  <td>{money(h.credit_fee)}</td>
                  <td>{money(h.appraisal_fee)}</td>
                  <td>{h.title_fee == null ? 'auto' : money(h.title_fee)}</td>
                  <td className="muted small">{h.note || ''}</td>
                </tr>
              ))}
              {!(data.history || []).length && <tr><td colSpan={9} className="muted small">No changes yet.</td></tr>}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
