import React, { useEffect, useState } from 'react';
import { api } from '../lib/api.js';
import { useAuth } from '../lib/auth.jsx';

/* Inspection & fee rules (admin/setup). Per capital partner (with an optional program
   override) decide virtual vs. on-site inspection, whether a Sitewire inspector and/or
   capital-partner approval is required, whether reallocations are allowed, and the fee
   schedule. A blank capital partner is the global default. Gated by platform_setup. */

const dollars = (c) => (Number(c || 0) / 100).toFixed(0);
const toCents = (v) => Math.round(Number(String(v).replace(/[^0-9.]/g, '')) * 100);

export default function StaffDrawRules() {
  const { can } = useAuth();
  const [rules, setRules] = useState([]);
  const [partners, setPartners] = useState([]);
  const [msg, setMsg] = useState('');
  const [err, setErr] = useState('');
  const [draft, setDraft] = useState(blankDraft());

  function blankDraft() { return { capital_partner_id: '', program: '', inspection_method: 'mobile', require_sitewire_inspector: true, require_capital_partner_approval: false, allow_reallocation: false, fee_cents_virtual: '299', fee_cents_physical: '499' }; }

  function load() {
    api.get('/api/sitewire/rules').then((d) => { setRules(d.rules || []); setPartners(d.partners || []); }).catch((e) => setErr(e?.data?.error || e.message));
  }
  useEffect(() => { if (can('platform_setup')) load(); }, [can]);

  async function save() {
    setMsg(''); setErr('');
    try {
      await api.post('/api/sitewire/rules', {
        capital_partner_id: draft.capital_partner_id || null, program: draft.program || null,
        inspection_method: draft.inspection_method, require_sitewire_inspector: draft.require_sitewire_inspector,
        require_capital_partner_approval: draft.require_capital_partner_approval, allow_reallocation: draft.allow_reallocation,
        fee_cents_virtual: toCents(draft.fee_cents_virtual), fee_cents_physical: draft.fee_cents_physical === '' ? null : toCents(draft.fee_cents_physical),
      });
      setMsg('Rule saved.'); setDraft(blankDraft()); load();
    } catch (e) { setErr(e?.data?.error || e.message || 'Could not save.'); }
  }
  function edit(r) {
    setDraft({ capital_partner_id: r.capital_partner_id || '', program: r.program || '', inspection_method: r.inspection_method, require_sitewire_inspector: r.require_sitewire_inspector, require_capital_partner_approval: r.require_capital_partner_approval, allow_reallocation: r.allow_reallocation, fee_cents_virtual: dollars(r.fee_cents_virtual), fee_cents_physical: r.fee_cents_physical == null ? '' : dollars(r.fee_cents_physical) });
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  if (!can('platform_setup')) return <div className="wrap"><div className="panel">You don't have access to draw settings.</div></div>;

  return (
    <div className="wrap">
      <h1 style={{ marginBottom: 2 }}>Inspection & fee rules</h1>
      <div className="muted">How each capital partner's files are inspected and what we charge per draw. Everything still records in Sitewire.</div>

      <div className="panel" style={{ marginTop: 16 }}>
        <h3 style={{ marginTop: 0 }}>Add / update a rule</h3>
        <div className="grid cols-3" style={{ gap: 10 }}>
          <label className="small">Capital partner
            <select className="input" value={draft.capital_partner_id} onChange={(e) => setDraft({ ...draft, capital_partner_id: e.target.value })}>
              <option value="">Global default (all partners)</option>
              {partners.map((p) => <option key={p.sitewire_id} value={p.sitewire_id}>{p.name}{p.on_our_lender ? '' : ' (directory)'}</option>)}
            </select>
          </label>
          <label className="small">Program (optional)
            <input className="input" placeholder="e.g. gold" value={draft.program} onChange={(e) => setDraft({ ...draft, program: e.target.value })} />
          </label>
          <label className="small">Inspection
            <select className="input" value={draft.inspection_method} onChange={(e) => setDraft({ ...draft, inspection_method: e.target.value })}>
              <option value="mobile">Virtual (mobile)</option>
              <option value="traditional">On-site (traditional)</option>
            </select>
          </label>
          <label className="small">Virtual fee $<input className="input" value={draft.fee_cents_virtual} onChange={(e) => setDraft({ ...draft, fee_cents_virtual: e.target.value })} /></label>
          <label className="small">On-site fee $<input className="input" value={draft.fee_cents_physical} onChange={(e) => setDraft({ ...draft, fee_cents_physical: e.target.value })} /></label>
          <div />
          <label className="small row" style={{ gap: 6, alignItems: 'center' }}><input type="checkbox" checked={draft.require_sitewire_inspector} onChange={(e) => setDraft({ ...draft, require_sitewire_inspector: e.target.checked })} /> Require Sitewire inspector</label>
          <label className="small row" style={{ gap: 6, alignItems: 'center' }}><input type="checkbox" checked={draft.require_capital_partner_approval} onChange={(e) => setDraft({ ...draft, require_capital_partner_approval: e.target.checked })} /> Require capital-partner approval</label>
          <label className="small row" style={{ gap: 6, alignItems: 'center' }}><input type="checkbox" checked={draft.allow_reallocation} onChange={(e) => setDraft({ ...draft, allow_reallocation: e.target.checked })} /> Allow reallocations</label>
        </div>
        <div className="row" style={{ gap: 8, marginTop: 10 }}>
          <button className="btn btn-sm primary" onClick={save}>Save rule</button>
          {msg && <span className="small" style={{ color: 'var(--teal,#2f7f86)', alignSelf: 'center' }}>{msg}</span>}
          {err && <span className="small" style={{ color: 'var(--bad,#b04a3f)', alignSelf: 'center' }}>{err}</span>}
        </div>
      </div>

      <div className="panel" style={{ marginTop: 14, overflowX: 'auto', padding: 0 }}>
        <table className="table" style={{ width: '100%', minWidth: 720 }}>
          <thead><tr><th>Capital partner</th><th>Program</th><th>Inspection</th><th>Inspector</th><th>CP approval</th><th>Reallocations</th><th style={{ textAlign: 'right' }}>Virtual</th><th style={{ textAlign: 'right' }}>On-site</th><th></th></tr></thead>
          <tbody>
            {rules.map((r) => (
              <tr key={r.id}>
                <td>{r.capital_partner_name || (r.capital_partner_id ? '#' + r.capital_partner_id : 'Global default')}</td>
                <td className="muted">{r.program || '—'}</td>
                <td>{r.inspection_method === 'mobile' ? 'Virtual' : 'On-site'}</td>
                <td>{r.require_sitewire_inspector ? 'Yes' : 'No'}</td>
                <td>{r.require_capital_partner_approval ? 'Yes' : 'No'}</td>
                <td>{r.allow_reallocation ? 'Yes' : 'No'}</td>
                <td style={{ textAlign: 'right' }}>${dollars(r.fee_cents_virtual)}</td>
                <td style={{ textAlign: 'right' }}>{r.fee_cents_physical == null ? '—' : '$' + dollars(r.fee_cents_physical)}</td>
                <td><button className="btn btn-sm ghost" onClick={() => edit(r)}>Edit</button></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
