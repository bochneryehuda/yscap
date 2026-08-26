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
const KEYS = ['markupStdPct', 'markupGoldPct', 'markupSilverPct', 'origStdPct', 'origGoldPct', 'origSilverPct', 'lenderFee', 'creditFee', 'appraisalFee', 'titleFee'];

// Per-experience-tier markup (item 15). Company defaults shaped
// { standard:{1,2,3}, gold, silver } of percents — Tier 1 = the MOST-experienced
// tier. A blank cell keeps that program/tier's normal markup (for Gold the top
// tier is normally 0). Programs/tiers listed here drive both the form + save.
const PROGRAMS = [
  { key: 'standard', label: 'Standard' },
  { key: 'gold', label: 'Gold Standard' },
  { key: 'silver', label: 'Silver' },
];
const TIERS = ['1', '2', '3'];

// ── Program ON/OFF switches (owner-directed 2026-08-18) ──────────────────────
// "we should have the option to turn on and turn off certain programs … right
// now we're discontinuing the gold program". Stored on the same settings row
// (program_availability jsonb, db/583) shaped { gold:{active:false, note} } —
// only switched-OFF programs are stored; the note pre-fills the discontinued
// wording shown wherever the program resurfaces by super-admin exception. The
// rules live in src/lib/program-availability.js; this screen only edits them.
const defaultDiscNote = (label) => `The ${label} program has been discontinued and is not being offered on new deals right now.`;
// Editable per-program form: { standard: { on:true, note:'' }, … }
const availToForm = (o) => {
  const pa = (o && o.programAvailability) || {};
  const out = {};
  for (const p of PROGRAMS) {
    const row = pa[p.key];
    const off = !!(row && row.active === false);
    out[p.key] = { on: !off, note: off ? String(row.note || '') : '' };
  }
  return out;
};
// Reduce to the stored map: only switched-OFF programs, note only when typed.
// All-on → {} (server stores NULL = every program offered).
const availToBody = (f) => {
  const out = {};
  for (const p of PROGRAMS) {
    const row = f[p.key];
    if (!row || row.on) continue;
    const note = String(row.note || '').trim();
    out[p.key] = note ? { active: false, note } : { active: false };
  }
  return out;
};

const toForm = (o) => {
  const f = {};
  for (const k of KEYS) f[k] = (o && o[k] != null) ? String(o[k]) : '';
  return f;
};
/* OUR FEE'S TWO PARTS AND THE NEW YORK LEGAL LADDER (owner-directed 2026-08-26).
   The KEY LIST is the RULE MODULE's own shape, restated here only as labels — a
   rung added there and forgotten in a hand-typed list would silently become
   un-editable, which is the one thing a settings screen must never be. */
const LENDER_FEE_FIELDS = [
  ['underwriting', 'Underwriting & processing ($)', 'Every file'],
  ['legal', 'Legal fee — general ($)', 'Every file outside New York'],
  ['legalGroundUp', 'Legal fee — ground-up ($)', 'Ground-up construction, outside New York'],
  ['legalNy', 'Legal fee — New York ($)', 'New York, outside the five boroughs'],
  ['legalNyHigh', 'Legal fee — New York City / heavy ($)', 'The five boroughs, a $100,000+ construction budget, a heavy rehab, or a New York ground-up'],
  ['settlementNy', 'New York settlement agent — optional ($)', 'Pre-filled on a New York file; the officer can change or decline it'],
  ['cemaNy', 'New York CEMA ($)', 'Pre-filled on a New York refinance, and only charged when the officer answers that it IS a CEMA'],
];
const lfToForm = (o) => {
  const src = (o && o.lenderFees) || {};
  const out = {};
  for (const [k] of LENDER_FEE_FIELDS) out[k] = src[k] == null ? '' : String(src[k]);
  return out;
};
const lfToBody = (f) => {
  const out = {};
  for (const [k] of LENDER_FEE_FIELDS) {
    const n = Number(f[k]);
    if (f[k] !== '' && isFinite(n) && n >= 0) out[k] = n;
  }
  return out;
};
// Build the editable per-tier grid from a settings object's markupTiers map.
const tiersToForm = (o) => {
  const mt = (o && o.markupTiers) || {};
  const out = {};
  for (const p of PROGRAMS) {
    out[p.key] = {};
    for (const t of TIERS) {
      const v = mt[p.key] && mt[p.key][t];
      out[p.key][t] = (v != null && v !== '') ? String(v) : '';
    }
  }
  return out;
};
// Reduce the grid to the map the API stores: only filled, valid (>=0) cells; a
// program with no filled cell is dropped; all-empty → {} (server stores NULL =
// feature off, so every tier keeps its historic markup).
const tiersToBody = (t) => {
  const out = {};
  for (const p of PROGRAMS) {
    const row = {};
    for (const tk of TIERS) {
      const v = t[p.key] && t[p.key][tk];
      if (v != null && v !== '' && isFinite(Number(v)) && Number(v) >= 0) row[tk] = Number(v);
    }
    if (Object.keys(row).length) out[p.key] = row;
  }
  return out;
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

// ── TPO (broker/wholesale) channel pricing controls (owner-directed 2026-08-06) ──
// A SEPARATE markup + origination control set for the broker channel, in the same
// Pricing Center. Every box is OPTIONAL: blank = the same number as retail above.
// Brokers never see these controls (manage_pricing-gated). Their own broker fee is
// set per firm by each firm — not here.
const TPO_KEYS = ['markupStdPct', 'markupGoldPct', 'markupSilverPct', 'origStdPct', 'origGoldPct', 'origSilverPct'];
const toTpoForm = (o) => { const f = {}; for (const k of TPO_KEYS) f[k] = (o && o[k] != null) ? String(o[k]) : ''; return f; };

function TpoField({ form, set, k, label, retailVal }) {
  const rv = (retailVal == null || retailVal === '') ? null : Number(retailVal);
  return (
    <div className="field">
      <label>{label}</label>
      <input className="input" inputMode="decimal" value={form[k]}
        placeholder={rv != null ? `same as retail (${rv}%)` : 'same as retail'}
        onChange={(e) => set(k, e.target.value)} />
      {rv != null && <div className="hint">Blank = same as retail ({rv}%)</div>}
    </div>
  );
}

function TpoChannelPricing({ isAdmin }) {
  const [data, setData] = useState(null);       // { tpo, retail }
  const [form, setForm] = useState(toTpoForm(null));
  const [tiers, setTiers] = useState(tiersToForm(null));
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState(null);
  const flash = (ok, text) => { setMsg({ ok, text }); setTimeout(() => setMsg(null), 7000); };
  const load = () => api.adminTpoPricingGet()
    .then((d) => { setData(d); setForm(toTpoForm(d.tpo)); setTiers(tiersToForm(d.tpo)); })
    .catch((e) => flash(false, e.message || 'could not load TPO pricing'));
  useEffect(() => { if (isAdmin) load(); /* eslint-disable-next-line */ }, [isAdmin]);
  if (!isAdmin || !data) return null;
  const tpo = data.tpo || {};
  const retail = data.retail || {};
  const set = (k, v) => setForm((f) => ({ ...f, [k]: String(v).replace(/[^0-9.]/g, '') }));
  const setTier = (prog, t, v) => setTiers((tt) => ({ ...tt, [prog]: { ...tt[prog], [t]: String(v).replace(/[^0-9.]/g, '') } }));
  const tiersDirty = JSON.stringify(tiersToBody(tiers)) !== JSON.stringify(tiersToBody(tiersToForm(tpo)));
  const dirty = tiersDirty || TPO_KEYS.some((k) => String(tpo[k] == null ? '' : tpo[k]) !== String(form[k] == null ? '' : form[k]));
  async function save() {
    setBusy(true);
    try {
      const body = { markupTiers: tiersToBody(tiers) };
      for (const k of TPO_KEYS) body[k] = form[k] === '' ? null : Number(form[k]);
      await api.adminTpoPricingPut(body);
      await load();
      flash(true, 'TPO (broker) pricing updated. Broker files now use these numbers; a blank box uses the retail default.');
    } catch (e) { flash(false, e.message || 'could not save TPO pricing'); }
    setBusy(false);
  }
  return (
    <div className="panel">
      <h2 style={{ margin: '0 0 4px' }}>TPO (broker) pricing controls</h2>
      <p className="muted small" style={{ maxWidth: 640, margin: 0 }}>
        Separate markup and origination for the <strong>broker (TPO) channel</strong> — our wholesale
        side. Leave a box <strong>blank</strong> to use the same number as retail above. Brokers never
        see these controls; each broker firm sets their own broker fee separately.
      </p>
      {msg && <div className={`notice ${msg.ok ? 'ok' : 'err'}`} role="alert" style={{ marginTop: 12 }}>{msg.text}</div>}

      <h3 style={{ margin: '18px 0 0' }}>Broker markup over the note-buyer rate</h3>
      <p className="muted small" style={{ margin: '2px 0 8px' }}>The spread on a broker file, per program.</p>
      <div className="grid cols-2">
        <TpoField form={form} set={set} k="markupStdPct" label="Standard markup (%)" retailVal={retail.markupStdPct} />
        <TpoField form={form} set={set} k="markupGoldPct" label="Gold Standard markup (%)" retailVal={retail.markupGoldPct} />
        <TpoField form={form} set={set} k="markupSilverPct" label="Silver markup (%, max 1.00)" retailVal={retail.markupSilverPct} />
      </div>

      <h3 style={{ margin: '18px 0 0' }}>Broker markup by experience tier (optional)</h3>
      <p className="muted small" style={{ margin: '2px 0 8px', maxWidth: 640 }}>
        Fine-tune the broker markup per tier. <strong>Tier 1 is the most-experienced tier.</strong>
        {' '}Leave a cell blank to use the broker per-program markup above (or retail if that is blank too).
      </p>
      <div className="tbl-scroll">
        <table className="tbl">
          <thead><tr><th>Program</th><th>Tier 1 (top)</th><th>Tier 2</th><th>Tier 3</th></tr></thead>
          <tbody>
            {PROGRAMS.map((p) => (
              <tr key={p.key}>
                <td style={{ whiteSpace: 'nowrap' }}>{p.label}</td>
                {TIERS.map((t) => (
                  <td key={t}>
                    <input className="input" inputMode="decimal" style={{ maxWidth: 120 }}
                      value={tiers[p.key][t]} placeholder="—"
                      onChange={(e) => setTier(p.key, t, e.target.value)} />
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <h3 style={{ margin: '18px 0 0' }}>Broker origination points</h3>
      <p className="muted small" style={{ margin: '2px 0 8px' }}>Origination on a broker file, per program. Cut this to leave room for the broker’s own fee.</p>
      <div className="grid cols-2">
        <TpoField form={form} set={set} k="origStdPct" label="Standard origination (%)" retailVal={retail.origStdPct} />
        <TpoField form={form} set={set} k="origGoldPct" label="Gold Standard origination (%)" retailVal={retail.origGoldPct} />
        <TpoField form={form} set={set} k="origSilverPct" label="Silver origination (%)" retailVal={retail.origSilverPct} />
      </div>

      <div className="row" style={{ gap: 8, marginTop: 14, alignItems: 'center' }}>
        <button className="btn primary" disabled={busy || !dirty} onClick={save}>{busy ? 'Saving…' : 'Save TPO pricing'}</button>
        {dirty && <span className="muted small">Unsaved changes</span>}
      </div>
    </div>
  );
}

export default function StaffCompanyPricing() {
  const { can } = useAuth();
  const isAdmin = can('manage_pricing');
  const [data, setData] = useState(null);       // { current, systemDefaults, history }
  const [form, setForm] = useState(toForm(null));
  const [tiers, setTiers] = useState(tiersToForm(null));   // per-tier markup grid
  const [fees, setFees] = useState([]);         // extra fees: [{ name, amount, state }]
  const [avail, setAvail] = useState(availToForm(null));   // program ON/OFF switches
  const [lf, setLf] = useState(lfToForm(null));            // our fee's parts + the New York legal ladder
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState(null);         // { ok, text }

  const flash = (ok, text) => { setMsg({ ok, text }); setTimeout(() => setMsg(null), 7000); };

  const feesFrom = (o) => (Array.isArray(o && o.extraFees) ? o.extraFees : [])
    .map((f) => ({ name: String(f.name || ''), amount: String(f.amount == null ? '' : f.amount), state: String(f.state || '') }));

  const load = () => api.adminPricingGet()
    .then((d) => { setData(d); setForm(toForm(d.current)); setTiers(tiersToForm(d.current)); setFees(feesFrom(d.current)); setAvail(availToForm(d.current)); setLf(lfToForm(d.current)); })
    .catch((e) => flash(false, e.message || 'could not load pricing settings'));
  useEffect(() => { if (isAdmin) load(); /* eslint-disable-next-line */ }, [isAdmin]);

  if (!isAdmin) return <div className="panel">You don’t have access to the Pricing Admin Center.</div>;
  if (!data) return <div className="panel">Loading pricing…</div>;

  const set = (k, v) => setForm((f) => ({ ...f, [k]: String(v).replace(/[^0-9.]/g, '') }));
  /* The live value of one fee box, falling back to the system number so the sentence above never
     reads NaN while somebody is mid-edit or has cleared a box. */
  const lfNum = (k) => {
    const n = Number(lf[k]);
    if (lf[k] !== '' && isFinite(n) && n >= 0) return n;
    const sys = (data.systemDefaults && data.systemDefaults.lenderFees) || {};
    return Number(sys[k]) || 0;
  };
  const cur = data.current || {};
  // Fee-list editing (name / amount / state). state '' = every file; a 2-letter
  // code = that state only. The seeded NY settlement fee is just the first row.
  const setFee = (i, k, v) => setFees((fs) => fs.map((f, j) => j === i ? {
    ...f, [k]: k === 'amount' ? String(v).replace(/[^0-9.]/g, '') : k === 'state' ? String(v).toUpperCase().replace(/[^A-Z]/g, '').slice(0, 2) : v,
  } : f));
  const addFee = () => setFees((fs) => [...fs, { name: '', amount: '', state: '' }]);
  const removeFee = (i) => setFees((fs) => fs.filter((_, j) => j !== i));
  const cleanFees = (arr) => arr.map((f) => ({ name: (f.name || '').trim(), amount: Number(f.amount), state: (f.state || '').toUpperCase() }))
    .filter((f) => f.name && isFinite(f.amount) && f.amount > 0);
  const setTier = (prog, t, v) => setTiers((tt) => ({ ...tt, [prog]: { ...tt[prog], [t]: String(v).replace(/[^0-9.]/g, '') } }));
  // Program switches: flipping one OFF pre-fills the discontinued note so the
  // wording is ready the moment the program resurfaces by exception (owner:
  // "Pre-fill the saying that the gold program is discontinued").
  const setProgOn = (key, on) => setAvail((a) => ({
    ...a,
    [key]: { on, note: on ? '' : (a[key].note || defaultDiscNote((PROGRAMS.find((p) => p.key === key) || {}).label || key)) },
  }));
  const setProgNote = (key, v) => setAvail((a) => ({ ...a, [key]: { ...a[key], note: String(v).slice(0, 300) } }));
  const feesDirty = JSON.stringify(cleanFees(fees)) !== JSON.stringify(cleanFees(feesFrom(cur)));
  const tiersDirty = JSON.stringify(tiersToBody(tiers)) !== JSON.stringify(tiersToBody(tiersToForm(cur)));
  const availDirty = JSON.stringify(availToBody(avail)) !== JSON.stringify(availToBody(availToForm(cur)));
  const lfDirty = JSON.stringify(lfToBody(lf)) !== JSON.stringify(lfToBody(lfToForm(cur)));
  const dirty = feesDirty || tiersDirty || availDirty || lfDirty || KEYS.some((k) => String(cur[k] == null ? '' : cur[k]) !== String(form[k] == null ? '' : form[k]));

  async function save() {
    setBusy(true);
    try {
      const body = { note: note.trim() || undefined, extraFees: cleanFees(fees), markupTiers: tiersToBody(tiers), programAvailability: availToBody(avail), lenderFees: lfToBody(lf) };
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
    setTiers(tiersToForm(data.systemDefaults));
    setFees(feesFrom(data.systemDefaults));
    setAvail(availToForm(data.systemDefaults));
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

        <h3 style={{ margin: '18px 0 0' }}>Programs offered</h3>
        <p className="muted small" style={{ margin: '2px 0 8px', maxWidth: 640 }}>
          Turn a whole program <strong>on or off</strong> — any program, any time. A discontinued
          program’s box <strong>disappears</strong> from Products &amp; Pricing and the public
          term-sheet generator, and nobody can register a new deal into it. For a deal already in
          process, a <strong>super admin</strong> can turn the program back on for that one file from
          the file’s Products &amp; Pricing panel — the note below (pre-filled) is what shows on that
          file’s program box. Files already registered on the program keep their locked-in terms.
        </p>
        {PROGRAMS.map((p) => (
          <div key={p.key} style={{ border: '1px solid var(--line, #E5E0D5)', borderRadius: 10, padding: '10px 12px', marginBottom: 8 }}>
            <div className="row" style={{ gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
              <strong style={{ color: '#141B22', minWidth: 130 }}>{p.label}</strong>
              <label className="row small" style={{ gap: 6, alignItems: 'center', color: '#141B22' }}>
                <input type="radio" name={`prog-${p.key}`} checked={avail[p.key].on} onChange={() => setProgOn(p.key, true)} />
                <span>Offered</span>
              </label>
              <label className="row small" style={{ gap: 6, alignItems: 'center', color: '#141B22' }}>
                <input type="radio" name={`prog-${p.key}`} checked={!avail[p.key].on} onChange={() => setProgOn(p.key, false)} />
                <span>Discontinued (turned off)</span>
              </label>
              {!avail[p.key].on && <span className="pill" style={{ color: '#8a5b00', borderColor: '#d9b26a' }}>OFF — not offered</span>}
            </div>
            {!avail[p.key].on && (
              <div className="field" style={{ marginTop: 8 }}>
                <label>Discontinued note (shows on the program box when a super admin turns it back on for one file)</label>
                <input className="input" value={avail[p.key].note} maxLength={300}
                  onChange={(e) => setProgNote(p.key, e.target.value)} />
                <div className="hint">Plain language, borrower-safe — never name a capital partner here.</div>
              </div>
            )}
          </div>
        ))}

        <h3 style={{ margin: '18px 0 0' }}>Markup over the note-buyer rate</h3>
        <p className="muted small" style={{ margin: '2px 0 8px' }}>The spread added on top of the wholesale rate for each program.</p>
        <div className="grid cols-2">
          <Field form={form} set={set} k="markupStdPct" label="Standard program markup (%)" />
          <Field form={form} set={set} k="markupGoldPct" label="Gold Standard program markup (%)" />
          <Field form={form} set={set} k="markupSilverPct" label="Silver program markup (%, max 1.00)" />
        </div>

        <h3 style={{ margin: '18px 0 0' }}>Markup by experience tier (optional)</h3>
        <p className="muted small" style={{ margin: '2px 0 8px', maxWidth: 640 }}>
          Set the markup separately for each experience tier of each program.
          {' '}<strong>Tier 1 is the most-experienced tier.</strong> Leave a cell blank to keep
          that program’s normal markup for that tier — for the <strong>Gold Standard</strong> program
          the top tier normally carries <strong>no markup (0%)</strong>. Type a percent to set that
          exact tier’s markup (Silver stays capped at 1.00%). This is a fine-tune on top of the
          per-program markup above.
        </p>
        <div className="tbl-scroll">
          <table className="tbl">
            <thead>
              <tr><th>Program</th><th>Tier 1 (top)</th><th>Tier 2</th><th>Tier 3</th></tr>
            </thead>
            <tbody>
              {PROGRAMS.map((p) => (
                <tr key={p.key}>
                  <td style={{ whiteSpace: 'nowrap' }}>{p.label}</td>
                  {TIERS.map((t) => (
                    <td key={t}>
                      <input className="input" inputMode="decimal" style={{ maxWidth: 120 }}
                        value={tiers[p.key][t]} placeholder="normal"
                        onChange={(e) => setTier(p.key, t, e.target.value)} />
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <h3 style={{ margin: '18px 0 0' }}>Origination points</h3>
        <p className="muted small" style={{ margin: '2px 0 8px' }}>Origination fee as a percent of the loan amount.</p>
        <div className="grid cols-2">
          <Field form={form} set={set} k="origStdPct" label="Standard origination (%)" />
          <Field form={form} set={set} k="origGoldPct" label="Gold Standard origination (%)" />
          <Field form={form} set={set} k="origSilverPct" label="Silver origination (%)" />
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

        <h3 style={{ margin: '18px 0 0' }}>Our fee — the two parts, and the New York ladder</h3>
        <p className="muted small" style={{ margin: '2px 0 10px' }}>
          Our own fee is quoted as <strong>underwriting &amp; processing</strong> plus a
          <strong> legal fee</strong>, and the legal fee depends on the deal. A general file is
          ${'{'}fmtMoney(lf.underwriting){'}'} + ${'{'}fmtMoney(lf.legal){'}'} = <strong>${'{'}fmtMoney(lfTotal){'}'}</strong>.
          Every number here is a <em>pre-fill</em> — an officer can change it on any single file from
          the manual section of Products &amp; Pricing.
        </p>
        <div className="grid cols-2">
          {LENDER_FEE_FIELDS.map(([k, label, hint]) => (
            <label key={k} className="field">
              <span>{label}</span>
              <input className="input" inputMode="decimal" value={lf[k]}
                placeholder={String((data.systemDefaults && data.systemDefaults.lenderFees && data.systemDefaults.lenderFees[k]) ?? '')}
                onChange={(e) => setLf((o) => ({ ...o, [k]: String(e.target.value).replace(/[^0-9.]/g, '') }))} />
              <small className="muted">{hint}</small>
            </label>
          ))}
        </div>

        <h3 style={{ margin: '18px 0 0' }}>Additional fees</h3>
        <p className="muted small" style={{ margin: '2px 0 8px' }}>
          Extra closing fees added to cash-to-close and the liquidity to show — on the
          term sheet, Products &amp; Pricing, and the public tools. Leave <em>State</em> blank
          to apply to every file, or enter a 2-letter code (e.g. <strong>NY</strong>) to apply
          it only in that state. (The New York settlement-agent fee is seeded here — edit or
          remove it like any other.)
        </p>
        {fees.map((f, i) => (
          <div className="row" key={i} style={{ gap: 8, marginBottom: 8, alignItems: 'flex-end' }}>
            <div className="field" style={{ flex: 2 }}>
              <label>Fee name</label>
              <input className="input" value={f.name} onChange={(e) => setFee(i, 'name', e.target.value)} placeholder="e.g. Settlement agent fee" />
            </div>
            <div className="field" style={{ flex: 1 }}>
              <label>Amount ($)</label>
              <input className="input" inputMode="decimal" value={f.amount} onChange={(e) => setFee(i, 'amount', e.target.value)} placeholder="0" />
            </div>
            <div className="field" style={{ width: 96 }}>
              <label>State</label>
              <input className="input" value={f.state} onChange={(e) => setFee(i, 'state', e.target.value)} placeholder="all" maxLength={2} />
            </div>
            <button className="btn link" type="button" onClick={() => removeFee(i)} title="Remove this fee" style={{ marginBottom: 6 }}>Remove</button>
          </div>
        ))}
        {!fees.length && <p className="muted small" style={{ margin: '0 0 8px' }}>No extra fees. Add one below.</p>}
        <button className="btn" type="button" onClick={addFee}>+ Add a fee</button>

        <div className="field" style={{ marginTop: 14 }}>
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
                <th>Markup (Std / Gold / Silver)</th><th>Orig (Std / Gold / Silver)</th>
                <th>UW</th><th>Credit</th><th>Appraisal</th><th>Title</th><th>Programs off</th><th>Note</th>
              </tr>
            </thead>
            <tbody>
              {(data.history || []).map((h) => (
                <tr key={h.id} style={h.is_current ? { fontWeight: 600 } : undefined}>
                  <td>{new Date(h.created_at).toLocaleString()}{h.is_current ? ' · live' : ''}</td>
                  <td>{h.updated_by_name || 'System'}</td>
                  <td>{pct(h.markup_std_pct)} / {pct(h.markup_gold_pct)} / {pct(h.markup_silver_pct)}</td>
                  <td>{pct(h.orig_std_pct)} / {pct(h.orig_gold_pct)} / {pct(h.orig_silver_pct)}</td>
                  <td>{money(h.lender_fee)}</td>
                  <td>{money(h.credit_fee)}</td>
                  <td>{money(h.appraisal_fee)}</td>
                  <td>{h.title_fee == null ? 'auto' : money(h.title_fee)}</td>
                  <td className="muted small">{(() => {
                    const pa = h.program_availability || {};
                    const off = PROGRAMS.filter((p) => pa[p.key] && pa[p.key].active === false).map((p) => p.label);
                    return off.length ? off.join(', ') : '—';
                  })()}</td>
                  <td className="muted small">{h.note || ''}</td>
                </tr>
              ))}
              {!(data.history || []).length && <tr><td colSpan={10} className="muted small">No changes yet.</td></tr>}
            </tbody>
          </table>
        </div>
      </div>

      <TpoChannelPricing isAdmin={isAdmin} />
    </div>
  );
}
