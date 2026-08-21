import React, { useCallback, useEffect, useState } from 'react';
import { api } from '../lib/api.js';
import { showMessage } from '../lib/dialog.js';
import { fmtDay, dayInputValue } from '../lib/dates.js';

/* THE GENERAL CONTRACTOR'S RECORD, ON ITS OWN CONDITION (db/605, owner-directed
   2026-08-21: "The GC information condition now only has an upload document slot. Keep
   that slot as an optional slot … You need to add that condition to be informational, to
   put in: the name / the phone number / the email address / license information …
   Don't make all the fields required. Maybe business name is optional.")

   IT SITS ON THE CONDITION, not on a settings page, because that is where somebody is
   standing when the builder's certificate arrives.

   THE IDENTITY IS NOT EDITED HERE, DELIBERATELY. The contractor's name, phone, email and
   address are a FILE CONTACT — the one record this system already keeps of a company —
   and this card shows them and points at the contacts section to change them. A second
   box for the same phone number is how two records of one company start disagreeing.
   What IS edited here is the part that is specific to a contractor and would be
   meaningless on a title company: the license, the two policies, the tax id.

   NOTHING IS REQUIRED. Saving with three boxes filled and nine empty is the ordinary
   case: a builder hands over a phone number today and an insurance certificate next
   week. A blank field simply does not print on the sheet. */
export default function GcRecordCard({ appId, onChanged }) {
  const [state, setState] = useState(null);
  const [draft, setDraft] = useState({});
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');

  const load = useCallback(() => api.staffGcRecord(appId).then((d) => {
    setState(d);
    const c = (d && d.contact) || {};
    const next = {};
    for (const f of (d && d.fields) || []) next[f.key] = c[f.key] == null ? '' : String(c[f.key]).slice(0, f.kind === 'date' ? 10 : 4000);
    setDraft(next);
  }).catch(() => setState({ error: true })), [appId]);
  useEffect(() => { load(); }, [load]);

  if (!state) return <div className="muted small" style={{ paddingLeft: 20 }}>Loading the contractor record…</div>;
  if (state.error) return null;

  const c = state.contact;
  const fields = state.fields || [];
  const set = (k, v) => setDraft((d) => ({ ...d, [k]: v }));

  const save = async () => {
    setBusy(true); setMsg('');
    try {
      const r = await api.staffGcRecordSave(appId, draft);
      // Say what happened to the SHEET too — it is the half that leaves the building.
      const s = r && r.sheet;
      setMsg(s && s.made ? 'Saved — the contractor sheet was redrawn for the investor package and the team site.'
        : s && s.reason === 'unchanged' ? 'Saved. Nothing on the sheet changed, so it was not redrawn.'
        : s && s.reason === 'nothing_recorded' ? 'Saved. There is nothing recorded yet, so no sheet was made.'
        : s && s.reason === 'sheet_failed' ? 'Saved — but the contractor sheet could not be redrawn just now. It will be redrawn on the next save.'
        : 'Saved.');
      await load();
      if (onChanged) await onChanged();
    } catch (e) {
      await showMessage(((e && e.data && e.data.error) || (e && e.message)) || 'Could not save the contractor record.');
    } finally { setBusy(false); }
  };

  return (
    <div className="gcrec">
      <div className="gcrec-h">General contractor</div>
      {!c ? (
        <div className="small" style={{ color: '#4B585C' }}>
          No general contractor is on this file yet. Add them as a <b>contractor</b> file contact
          (in the file&rsquo;s contacts) and their license and insurance can be recorded here.
        </div>
      ) : (<>
        {/* The identity, read-only — one record of a company, edited where companies are edited. */}
        <div className="gcrec-who">
          <b>{c.company_name || c.contact_name || '(no name yet)'}</b>
          {c.company_name && c.contact_name ? <span className="small" style={{ color: '#4B585C' }}> · {c.contact_name}</span> : null}
          <div className="small" style={{ color: '#4B585C', marginTop: 2 }}>
            {[c.phone, c.email, c.address].filter(Boolean).join('  ·  ') || 'No phone or email recorded yet — add it on the file contact.'}
          </div>
        </div>
        <div className="gcrec-grid">
          {fields.map((f) => (
            <label key={f.key} className="gcrec-f">
              <span className="gcrec-l">{f.label}</span>
              {f.kind === 'date' ? (
                <input className="input" type="date" value={dayInputValue(draft[f.key]) || ''}
                  onChange={(e) => set(f.key, e.target.value)} />
              ) : f.key === 'notes' ? (
                <textarea className="input" rows={2} value={draft[f.key] || ''} onChange={(e) => set(f.key, e.target.value)} />
              ) : (
                <input className="input" value={draft[f.key] || ''} maxLength={f.max || 200}
                  onChange={(e) => set(f.key, e.target.value)} />
              )}
            </label>
          ))}
        </div>
        <div className="row" style={{ gap: 8, marginTop: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <button className="btn primary small" disabled={busy} onClick={save}>{busy ? 'Saving…' : 'Save contractor record'}</button>
          <span className="small" style={{ color: '#4B585C' }}>
            Nothing here is required. What is filled in prints on the &ldquo;General Contractor Information&rdquo;
            sheet that goes out with the investor package and into SharePoint.
          </span>
        </div>
        {msg && <div className="small" style={{ marginTop: 6, color: '#256168' }}>{msg}</div>}
        {state.sheet && (
          <div className="small" style={{ marginTop: 6, color: '#4B585C' }}>
            Current sheet: <b>{state.sheet.filename}</b>{state.sheet.created_at ? ` · ${fmtDay(state.sheet.created_at) || ''}` : ''}
          </div>
        )}
      </>)}
    </div>
  );
}
