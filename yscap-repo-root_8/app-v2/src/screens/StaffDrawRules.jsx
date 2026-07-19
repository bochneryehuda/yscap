import React, { useEffect, useState } from 'react';
import { api } from '../lib/api.js';
import { useAuth } from '../lib/auth.jsx';
import { InfoTip } from '../components/FileSections.jsx';

/* Inspection & fee rules (admin/setup). Per capital partner (with an optional program
   override) decide virtual vs. on-site inspection, whether a Sitewire inspector and/or
   capital-partner approval is required, whether reallocations are allowed, and the fee
   schedule. A blank capital partner is the global default. Gated by platform_setup. */

const dollars = (c) => (Number(c || 0) / 100).toFixed(0);
const toCents = (v) => Math.round(Number(String(v).replace(/[^0-9.]/g, '')) * 100);

/* Small inline icon set (feather-style, stroke = currentColor) — matches StaffDraws. */
function Icon({ name }) {
  const p = {
    sliders: <><path d="M4 6h10" /><path d="M18 6h2" /><circle cx="16" cy="6" r="2" /><path d="M4 12h4" /><path d="M12 12h8" /><circle cx="10" cy="12" r="2" /><path d="M4 18h10" /><path d="M18 18h2" /><circle cx="16" cy="18" r="2" /></>,
    shield: <><path d="M12 3l7 3v5c0 4.5-3 7.5-7 9-4-1.5-7-4.5-7-9V6z" /><path d="M9 12l2 2 4-4" /></>,
    plus: <><circle cx="12" cy="12" r="9" /><path d="M12 8v8" /><path d="M8 12h8" /></>,
    link: <><path d="M9 15l6-6" /><path d="M11 6l1-1a4 4 0 015.6 5.6l-1.6 1.6" /><path d="M13 18l-1 1A4 4 0 016.4 13.4L8 11.8" /></>,
    list: <><path d="M8 6h12" /><path d="M8 12h12" /><path d="M8 18h12" /><path d="M4 6h.01" /><path d="M4 12h.01" /><path d="M4 18h.01" /></>,
  }[name] || null;
  return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{p}</svg>;
}

function CardHead({ icon, tone, title, right }) {
  return (
    <div className="dd-card-h" style={{ justifyContent: 'space-between' }}>
      <div className="row" style={{ gap: 10, alignItems: 'center' }}>
        <span className={'dd-card-ic' + (tone ? ' ' + tone : '')}><Icon name={icon} /></span>
        <h3>{title}</h3>
      </div>
      {right || null}
    </div>
  );
}

function SettingField({ label, k, settings, onSave, info }) {
  const [v, setV] = useState('');
  const [saved, setSaved] = useState(false);
  useEffect(() => { const cur = settings[k]; if (cur != null) setV(String(cur)); }, [settings, k]);
  return (
    <div className="dd-field">
      <span className="dd-field-l">{label}{info ? <InfoTip tip={info} /> : null}</span>
      <div className="row" style={{ gap: 6 }}>
        <input className="input" style={{ maxWidth: 90 }} value={v} onChange={(e) => { setV(e.target.value); setSaved(false); }} />
        <button className="btn btn-sm ghost" onClick={() => { const n = Number(v); if (Number.isFinite(n) && n >= 0) { onSave(k, n); setSaved(true); } }}>{saved ? 'Saved ✓' : 'Save'}</button>
      </div>
    </div>
  );
}

/* Plain-language help for each setting, shown behind the little ⓘ. */
const HELP = {
  wire_turnaround: 'How long, in hours, a wire should take to go out after a draw is approved. Used only to flag draws that are sitting too long — it never blocks anything.',
  variance: 'A borrower can ask to shift money from one Scope-of-Work line to another (a “reallocation”). This sets how much a single line is allowed to move on its own before the capital partner has to approve it. Example: set to 10% — a line can go up or down by up to 10% of its budgeted amount automatically; anything bigger waits for sign-off. This is only a threshold — it never moves money by itself.',
  stale: 'A draw with no update for this many days is flagged as “stale” on the portfolio, so nothing slips.',
  no_draw: 'A funded file with no draw activity for this many days is flagged, so an idle project gets a nudge.',
  partner: 'Which capital partner (note buyer) this rule applies to — the list is every note buyer we use, matched to the file\'s note-buyer field. “Global default” covers every file that doesn\'t have its own rule.',
  handled: 'Turn this on for a capital partner that runs its OWN draw process (in their system, not Sitewire). PILOT will never send those files to Sitewire — it just records them here. Use this for note buyers who don\'t want us managing their draws.',
  program: 'Optional — apply this rule only to one loan program (for example, gold). Leave blank to apply to all.',
  auto_method: 'How a new file is set up automatically: Virtual (a phone-guided inspection) or On-site (an inspector visits).',
  fee: 'What we charge the borrower per draw for each inspection method.',
  allowed: 'Which inspection methods this program may use. Turn on both to let the coordinator switch method per file; turn on one to lock it.',
  inspector: 'Whether a Sitewire inspector must sign off each draw before it can be approved.',
  cp_approval: 'Whether approved draws route to the capital partner for their own sign-off before release.',
  realloc: 'Whether the borrower may move money between Scope-of-Work lines (a reallocation request).',
  retainage: 'Money you hold back from each approved draw and release at the very end, so the last piece isn\'t paid until the work is fully finished. Example: set to 10% — a $10,000 approved draw pays the borrower $9,000 now and keeps $1,000 until the project is done and signed off. Leave it at 0 for no hold-back (most files).',
  lien: 'Blocks a draw from being released until every required lien waiver is received or waived. Off unless this project uses lien waivers.',
  advanced: 'These aren\'t part of the standard draw workflow, so they stay hidden on the draw desk. Turn them on here — globally, or for one specific project — and they\'ll appear on that file\'s desk.',
  link: 'Match a note buyer to its record in Sitewire\'s capital-partner directory even when the names are spelled differently (e.g. “Fidelis” → “Fidelis Investments LLC”). Once linked, a rule for that note buyer pushes to the right Sitewire partner automatically. Nothing is guessed — you confirm each match.',
};

export default function StaffDrawRules() {
  const { can } = useAuth();
  const [rules, setRules] = useState([]);
  const [partners, setPartners] = useState([]);
  const [msg, setMsg] = useState('');
  const [err, setErr] = useState('');
  const [draft, setDraft] = useState(blankDraft());

  function blankDraft() { return { partner_label: '', program: '', handled_externally: false, inspection_method: 'mobile', allow_virtual: true, allow_physical: true, require_sitewire_inspector: true, require_capital_partner_approval: false, allow_reallocation: false, fee_cents_virtual: '299', fee_cents_physical: '499' }; }

  const [settings, setSettings] = useState({});
  const [status, setStatus] = useState(null);
  const [syncing, setSyncing] = useState(false);

  function load() {
    api.get('/api/sitewire/rules').then((d) => { setRules(d.rules || []); setPartners(d.partners || []); }).catch((e) => setErr(e?.data?.error || e.message));
    api.get('/api/sitewire/settings').then((d) => setSettings(d.settings || {})).catch(() => {});
    api.get('/api/sitewire/status').then(setStatus).catch(() => {});
  }
  useEffect(() => { if (can('platform_setup')) load(); }, [can]);

  async function syncDirectory() {
    setSyncing(true); setMsg(''); setErr('');
    try { const r = await api.post('/api/sitewire/sync-directory', {}); setMsg(`Directory synced — ${r.capital_partners} partners, ${r.staff_matched} staff matched.`); load(); }
    catch (e) { setErr(e?.data?.error || e.message || 'Could not sync.'); } finally { setSyncing(false); }
  }
  async function saveSetting(key, value) {
    setMsg(''); setErr('');
    try { await api.patch('/api/sitewire/settings', { [key]: value }); setMsg('Setting saved.'); }
    catch (e) { setErr(e?.data?.error || e.message || 'Could not save.'); }
  }

  async function save() {
    setMsg(''); setErr('');
    try {
      await api.post('/api/sitewire/rules', {
        partner_label: draft.partner_label || null, program: draft.program || null,
        handled_externally: draft.handled_externally,
        inspection_method: draft.inspection_method, allow_virtual: draft.allow_virtual, allow_physical: draft.allow_physical,
        require_sitewire_inspector: draft.require_sitewire_inspector,
        require_capital_partner_approval: draft.require_capital_partner_approval, allow_reallocation: draft.allow_reallocation,
        fee_cents_virtual: toCents(draft.fee_cents_virtual), fee_cents_physical: draft.fee_cents_physical === '' ? null : toCents(draft.fee_cents_physical),
      });
      setMsg('Rule saved.'); setDraft(blankDraft()); load();
    } catch (e) { setErr(e?.data?.error || e.message || 'Could not save.'); }
  }
  function edit(r) {
    setDraft({ partner_label: r.partner_label || r.capital_partner_name || '', program: r.program || '', handled_externally: !!r.handled_externally, inspection_method: r.inspection_method, allow_virtual: r.allow_virtual !== false, allow_physical: r.allow_physical !== false, require_sitewire_inspector: r.require_sitewire_inspector, require_capital_partner_approval: r.require_capital_partner_approval, allow_reallocation: r.allow_reallocation, fee_cents_virtual: dollars(r.fee_cents_virtual), fee_cents_physical: r.fee_cents_physical == null ? '' : dollars(r.fee_cents_physical) });
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  if (!can('platform_setup')) return <div className="wrap"><div className="panel">You don't have access to draw settings.</div></div>;

  return (
    <div className="wrap">
      <div className="dd-wrap">
        <div className="dd-head">
          <div>
            <h1 className="dd-title">Inspection &amp; fee rules</h1>
            <div className="dd-sub">How each capital partner's files are inspected and what we charge per draw. Everything still records in Sitewire.</div>
          </div>
          {status && (
            <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
              <span className={'dd-chip ' + (status.enabled ? 'on' : 'off')}><span className="dot" />{status.enabled ? 'Connected' : 'Turned off'}</span>
              {status.enabled && <span className={'dd-chip ' + (status.outbound ? 'on' : 'warn')}><span className="dot" />{status.outbound ? 'Writing on' : 'Read-only'}</span>}
              {status.dryrun && <span className="dd-chip warn"><span className="dot" />Dry-run</span>}
            </div>
          )}
        </div>

        {/* Connection & settings */}
        <div className="dd-card">
          <CardHead icon="sliders" title="Connection &amp; settings"
            right={<button className="btn btn-sm ghost" disabled={syncing} onClick={syncDirectory}>{syncing ? 'Syncing…' : 'Sync capital-partner directory'}</button>} />
          {status && <div className="dd-sub" style={{ marginTop: -2 }}>{status.enabled ? 'Connected' : 'Turned off'}{status.enabled ? (status.outbound ? ' · writing on' : ' · read-only') : ''}{status.dryrun ? ' · dry-run' : ''} · {status.linked_files} files · {status.mirrored_draws} draws · {status.open_reviews} need review</div>}
          <div className="dd-fieldgrid">
            <SettingField label="Wire turnaround (hours)" k="wire_turnaround_hours" settings={settings} onSave={saveSetting} info={HELP.wire_turnaround} />
            <SettingField label="Reallocation variance %" k="variance_pct" settings={settings} onSave={saveSetting} info={HELP.variance} />
            <SettingField label="Stale after (days)" k="stale_days" settings={settings} onSave={saveSetting} info={HELP.stale} />
            <SettingField label="No-draw alert (days)" k="no_draw_days" settings={settings} onSave={saveSetting} info={HELP.no_draw} />
          </div>
        </div>

        <AdvancedFeatures settings={settings} saveSetting={saveSetting} />

        {/* Sitewire partner linking (smart-link) */}
        <PartnerLinks partners={partners} onChanged={load} />

        {/* Add / update a rule */}
        <div className="dd-card">
          <CardHead icon="plus" title="Add / update a rule" />
          <div className="grid cols-3" style={{ gap: 12, marginTop: 6 }}>
            <label className="small">Capital partner (note buyer)<InfoTip tip={HELP.partner} />
              <select className="input" value={draft.partner_label} onChange={(e) => { const v = e.target.value; setDraft({ ...draft, partner_label: v, handled_externally: v ? draft.handled_externally : false }); }}>
                <option value="">Global default (all partners)</option>
                {partners.map((p) => <option key={p.label} value={p.label}>{p.label}{!p.in_directory && !p.linked_sitewire_id ? ' (not in Sitewire)' : ''}</option>)}
                {draft.partner_label && !partners.some((p) => p.label === draft.partner_label) && <option value={draft.partner_label}>{draft.partner_label}</option>}
              </select>
            </label>
            <label className="small">Program (optional)<InfoTip tip={HELP.program} />
              <input className="input" placeholder="e.g. gold" value={draft.program} onChange={(e) => setDraft({ ...draft, program: e.target.value })} />
            </label>
            <label className="small">Set up automatically as<InfoTip tip={HELP.auto_method} />
              <select className="input" value={draft.inspection_method} onChange={(e) => setDraft({ ...draft, inspection_method: e.target.value })} disabled={draft.handled_externally}>
                <option value="mobile">Virtual (mobile)</option>
                <option value="traditional">On-site (traditional)</option>
              </select>
            </label>
            <label className="small row" style={{ gridColumn: '1 / -1', gap: 8, alignItems: 'center', padding: '10px 12px', borderRadius: 8, background: draft.handled_externally ? 'var(--gold-soft)' : 'var(--ink-2)', border: '1px solid var(--line)', opacity: draft.partner_label ? 1 : 0.55 }}>
              <input type="checkbox" checked={draft.handled_externally} disabled={!draft.partner_label} onChange={(e) => setDraft({ ...draft, handled_externally: e.target.checked })} />
              <span><b>Handled externally</b> — this capital partner runs its own draws; never push these files to Sitewire<InfoTip tip={HELP.handled} />
                {!draft.partner_label && <span className="muted"> Pick a specific capital partner above to use this.</span>}
                {draft.handled_externally && !!draft.partner_label && <span className="muted"> The inspection &amp; fee settings below are ignored for this partner.</span>}
              </span>
            </label>
            <label className="small">Virtual fee $<InfoTip tip={HELP.fee} /><input className="input" value={draft.fee_cents_virtual} onChange={(e) => setDraft({ ...draft, fee_cents_virtual: e.target.value })} disabled={draft.handled_externally} /></label>
            <label className="small">On-site fee $<input className="input" value={draft.fee_cents_physical} onChange={(e) => setDraft({ ...draft, fee_cents_physical: e.target.value })} disabled={draft.handled_externally} /></label>
            <div />
            <label className="small row" style={{ gap: 6, alignItems: 'center' }}><input type="checkbox" checked={draft.allow_virtual} disabled={draft.handled_externally} onChange={(e) => setDraft({ ...draft, allow_virtual: e.target.checked })} /> Virtual allowed<InfoTip tip={HELP.allowed} /></label>
            <label className="small row" style={{ gap: 6, alignItems: 'center' }}><input type="checkbox" checked={draft.allow_physical} disabled={draft.handled_externally} onChange={(e) => setDraft({ ...draft, allow_physical: e.target.checked })} /> On-site allowed</label>
            <div className="small muted" style={{ alignSelf: 'center' }}>Allow both to let the coordinator switch method per file.</div>
            <label className="small row" style={{ gap: 6, alignItems: 'center' }}><input type="checkbox" checked={draft.require_sitewire_inspector} disabled={draft.handled_externally} onChange={(e) => setDraft({ ...draft, require_sitewire_inspector: e.target.checked })} /> Require Sitewire inspector<InfoTip tip={HELP.inspector} /></label>
            <label className="small row" style={{ gap: 6, alignItems: 'center' }}><input type="checkbox" checked={draft.require_capital_partner_approval} disabled={draft.handled_externally} onChange={(e) => setDraft({ ...draft, require_capital_partner_approval: e.target.checked })} /> Require capital-partner approval<InfoTip tip={HELP.cp_approval} /></label>
            <label className="small row" style={{ gap: 6, alignItems: 'center' }}><input type="checkbox" checked={draft.allow_reallocation} disabled={draft.handled_externally} onChange={(e) => setDraft({ ...draft, allow_reallocation: e.target.checked })} /> Allow reallocations<InfoTip tip={HELP.realloc} /></label>
          </div>
          <div className="row" style={{ gap: 8, marginTop: 14 }}>
            <button className="btn btn-sm primary" onClick={save}>Save rule</button>
            {msg && <span className="small" style={{ color: 'var(--success)', alignSelf: 'center', fontWeight: 600 }}>{msg}</span>}
            {err && <span className="small" style={{ color: 'var(--danger)', alignSelf: 'center', fontWeight: 600 }}>{err}</span>}
          </div>
        </div>

        {/* Rules table */}
        <div className="dd-tablecard" style={{ overflowX: 'auto' }}>
          <table className="dd-table" style={{ minWidth: 760 }}>
            <thead><tr><th>Capital partner</th><th>Program</th><th>Auto method</th><th>Allowed</th><th>Inspector</th><th>CP approval</th><th>Reallocations</th><th className="num">Virtual</th><th className="num">On-site</th><th></th></tr></thead>
            <tbody>
              {rules.length === 0 && <tr><td colSpan={10} className="muted" style={{ textAlign: 'center', padding: '22px' }}>No rules yet — the global default applies to every file.</td></tr>}
              {rules.map((r) => {
                const av = r.allow_virtual !== false, ap = r.allow_physical !== false;
                const allowed = av && ap ? 'Both (can switch)' : av ? 'Virtual only' : ap ? 'On-site only' : '—';
                const ext = !!r.handled_externally;
                return (
                <tr key={r.id}>
                  <td style={{ fontWeight: 600 }}>{r.partner_label || r.capital_partner_name || (r.capital_partner_id ? '#' + r.capital_partner_id : 'Global default')}
                    {ext && <span className="pill sw-insp" style={{ marginLeft: 6 }}>Handled externally</span>}
                  </td>
                  <td className="muted">{r.program || '—'}</td>
                  {ext ? (
                    <td colSpan={7} className="muted small">Runs in the partner's own system — not pushed to Sitewire.</td>
                  ) : (<>
                    <td>{r.inspection_method === 'mobile' ? 'Virtual' : 'On-site'}</td>
                    <td className="small">{allowed}</td>
                    <td>{r.require_sitewire_inspector ? 'Yes' : 'No'}</td>
                    <td>{r.require_capital_partner_approval ? 'Yes' : 'No'}</td>
                    <td>{r.allow_reallocation ? 'Yes' : 'No'}</td>
                    <td className="num">${dollars(r.fee_cents_virtual)}</td>
                    <td className="num">{r.fee_cents_physical == null ? '—' : '$' + dollars(r.fee_cents_physical)}</td>
                  </>)}
                  <td><button className="btn btn-sm ghost" onClick={() => edit(r)}>Edit</button></td>
                </tr>
              ); })}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

/* Smart-link: match our free-text note-buyer labels to Sitewire's capital-partner directory,
   tolerant of spelling differences ("Fidelis" → "Fidelis Investments LLC"). Nothing is guessed —
   an admin confirms each link. The backend resolveCapitalPartnerId consults these confirmed links
   first, so a rule for a note buyer pushes to the right Sitewire partner. */
function PartnerLinks({ partners, onChanged }) {
  const [dir, setDir] = useState([]);
  const [busy, setBusy] = useState('');
  const [err, setErr] = useState('');
  const [note, setNote] = useState('');

  useEffect(() => {
    api.get('/api/sitewire/capital-partners').then((d) => setDir(d.partners || [])).catch(() => {});
  }, [partners]);

  async function setLink(label, sitewireId) {
    setBusy(label); setErr(''); setNote('');
    try {
      await api.post('/api/sitewire/partner-links', { label, sitewire_id: sitewireId === '' ? null : Number(sitewireId) });
      setNote(`Linked ${label}.`); onChanged && onChanged();
    } catch (e) { setErr(e?.data?.error || e.message || 'Could not link.'); } finally { setBusy(''); }
  }

  // note buyers we actually use (from the rules endpoint's partners union), minus the global default
  const buyers = (partners || []).filter((p) => p.label);
  if (buyers.length === 0) return null;

  return (
    <div className="dd-card">
      <CardHead icon="link" title="Match note buyers to Sitewire" />
      <div className="dd-sub" style={{ marginTop: -2, marginBottom: 4 }}>
        Point each note buyer at its record in Sitewire's directory — even when the name is spelled a little differently. Files for a linked note buyer push to the right Sitewire partner automatically.<InfoTip tip={HELP.link} />
      </div>
      <div className="dd-tablecard" style={{ overflowX: 'auto', boxShadow: 'none', border: 'none' }}>
        <table className="dd-table" style={{ minWidth: 560 }}>
          <thead><tr><th>Note buyer (our name)</th><th>Sitewire capital partner</th><th>Status</th></tr></thead>
          <tbody>
            {buyers.map((p) => {
              // What the dropdown shows selected: an explicit human link wins (including an explicit
              // "no partner" = blank); otherwise fall back to an exact directory match if there is one.
              const cur = p.has_link ? (p.linked_sitewire_id != null ? String(p.linked_sitewire_id) : '')
                : (p.directory_id != null ? String(p.directory_id) : '');
              return (
                <tr key={p.label}>
                  <td style={{ fontWeight: 600 }}>{p.label}</td>
                  <td>
                    <select className="input" style={{ maxWidth: 320 }} disabled={busy === p.label} value={cur}
                      onChange={(e) => setLink(p.label, e.target.value)}>
                      <option value="">— not in Sitewire (handled externally) —</option>
                      {dir.map((d) => <option key={d.sitewire_id} value={d.sitewire_id}>{d.name}{d.on_our_lender ? '' : ' (directory)'}</option>)}
                    </select>
                  </td>
                  <td>
                    {p.has_link
                      ? (p.linked_sitewire_id != null ? <span className="pill sw-approved">Linked ✓</span> : <span className="pill sw-insp">No Sitewire partner</span>)
                      : p.in_directory
                        ? <span className="pill sw-approved">Exact match</span>
                        : p.suggested_sitewire_id != null
                          ? <span className="pill sw-pending" title={p.suggested_name || ''}>Suggested: {p.suggested_name}</span>
                          : <span className="pill sw-insp">Not linked</span>}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <div className="row" style={{ gap: 8, marginTop: 8 }}>
        {note && <span className="small" style={{ color: 'var(--success)', fontWeight: 600 }}>{note}</span>}
        {err && <span className="small" style={{ color: 'var(--danger)', fontWeight: 600 }}>{err}</span>}
      </div>
    </div>
  );
}

/* Advanced draw features — retainage + lien waivers. OFF by default and NOT part of the standard
   draw workflow, so they stay hidden on the draw desk until turned on here: globally, or for one
   specific project (which is the common case). Gated by platform_setup like the rest of this screen. */
function AdvancedFeatures({ settings, saveSetting }) {
  const [loan, setLoan] = useState('');
  const [proj, setProj] = useState(null);      // { application_id, ys_loan_number, address, retainage_pct, require_lien_waivers }
  const [pRet, setPRet] = useState('');
  const [pLien, setPLien] = useState(false);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState('');
  const [err, setErr] = useState('');

  async function lookup() {
    setErr(''); setNote(''); setProj(null);
    const q = loan.trim();
    if (!q) { setErr('Enter a loan number.'); return; }
    setBusy(true);
    try {
      const p = await api.get(`/api/sitewire/project?loan=${encodeURIComponent(q)}`);
      setProj(p);
      setPRet(p.retainage_pct != null ? String(p.retainage_pct) : '');
      setPLien(p.require_lien_waivers === true);
    } catch (e) { setErr(e?.data?.error || e.message || 'Not found.'); } finally { setBusy(false); }
  }
  async function saveProject() {
    if (!proj) return;
    setErr(''); setNote('');
    // validate retainage client-side (blank = inherit; else a real 0..100 number) so a typo can't
    // silently become "inherit" on the wire.
    let ret = null;
    if (pRet.trim() !== '') {
      const n = Number(pRet);
      if (!Number.isFinite(n) || n < 0 || n > 100) { setErr('Retainage % must be a number between 0 and 100 (or blank to inherit).'); return; }
      ret = n;
    }
    setBusy(true);
    try {
      await api.post(`/api/sitewire/files/${proj.application_id}/advanced-settings`, { require_lien_waivers: pLien, retainage_pct: ret });
      setNote(`Saved for ${proj.ys_loan_number}.`);
    } catch (e) { setErr(e?.data?.error || e.message || 'Could not save.'); } finally { setBusy(false); }
  }

  const lienOn = settings.require_lien_waivers === true || settings.require_lien_waivers === 'true';
  return (
    <div className="dd-card">
      <CardHead icon="shield" title="Advanced features" right={<InfoTip tip={HELP.advanced} />} />
      <div className="dd-sub" style={{ marginTop: -2, marginBottom: 12 }}>
        Retainage and lien waivers aren't part of the standard draw workflow, so they stay hidden on the draw desk. Turn them on globally, or just for one project — and they'll appear on that file's desk.
      </div>

      <div className="small" style={{ fontWeight: 700, marginBottom: 8, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '.05em', fontSize: 11 }}>Global default</div>
      <div className="row" style={{ gap: 22, flexWrap: 'wrap', alignItems: 'flex-end' }}>
        <SettingField label="Retainage held %" k="retainage_pct" settings={settings} onSave={saveSetting} info={HELP.retainage} />
        <label className="small row" style={{ gap: 6, alignItems: 'center' }}>
          <input type="checkbox" checked={lienOn} onChange={(e) => saveSetting('require_lien_waivers', e.target.checked)} />
          Require lien waivers before a draw is released<InfoTip tip={HELP.lien} />
        </label>
      </div>

      <div className="small" style={{ fontWeight: 700, margin: '20px 0 8px', color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '.05em', fontSize: 11 }}>Turn on for one project</div>
      <div className="row" style={{ gap: 8, alignItems: 'flex-end', flexWrap: 'wrap' }}>
        <label className="small">Loan number
          <input className="input" style={{ width: 180 }} placeholder="e.g. YSCAP258134628" value={loan}
            onChange={(e) => setLoan(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') lookup(); }} />
        </label>
        <button className="btn btn-sm ghost" disabled={busy} onClick={lookup}>Look up</button>
      </div>
      {proj && (
        <div style={{ marginTop: 12, padding: '14px 16px', borderRadius: 10, background: 'var(--ink-2)', border: '1px solid var(--line)' }}>
          <div className="small"><b>{proj.ys_loan_number}</b>{proj.address ? ` · ${proj.address}` : ''} <span className="muted">· {proj.status}</span></div>
          <div className="row" style={{ gap: 22, flexWrap: 'wrap', alignItems: 'flex-end', marginTop: 10 }}>
            <label className="small">Retainage %<InfoTip tip={HELP.retainage} />
              <input className="input" style={{ width: 80 }} placeholder="0" value={pRet} onChange={(e) => setPRet(e.target.value)} />
            </label>
            <label className="small row" style={{ gap: 6, alignItems: 'center' }}>
              <input type="checkbox" checked={pLien} onChange={(e) => setPLien(e.target.checked)} />
              Require lien waivers<InfoTip tip={HELP.lien} />
            </label>
            <button className="btn btn-sm primary" disabled={busy} onClick={saveProject}>Save for this project</button>
          </div>
          <div className="muted small" style={{ marginTop: 8 }}>Leave retainage blank to inherit the global default. These appear on this file's draw desk once set.</div>
        </div>
      )}
      {note && <div className="small" style={{ color: 'var(--success)', marginTop: 10, fontWeight: 600 }}>{note}</div>}
      {err && <div className="small" style={{ color: 'var(--danger)', marginTop: 10, fontWeight: 600 }}>{err}</div>}
    </div>
  );
}
