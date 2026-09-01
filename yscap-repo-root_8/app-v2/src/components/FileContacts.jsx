import React, { useEffect, useMemo, useState } from 'react';
import { PhoneInput, EmailInput } from './FormattedInputs.jsx';
import VendorAutocomplete from './VendorAutocomplete.jsx';
import { api } from '../lib/api.js';
import { useSubmitGate } from '../lib/useSubmitGate.js';
import { askConfirm } from '../lib/dialog.js';

/* General file contacts (#144). Any party can add any kind of vendor to a file;
   every contact flows into the company-wide vendor directory and is shared with
   everyone on the file. Works on the borrower side and the staff side (isStaff).
   Contact TYPES cover the real-estate transaction; "Other" takes a free-text
   label. Minimal requirement to add: any one detail.

   ONE COMPONENT, MORE THAN ONE PRODUCT (owner-directed 2026-08-30, the
   share-the-code directive: "the FileContacts should come directly from the
   short-term side … they should all be built from our Vendor Contact and
   connected always"). What used to be hard-coded here was the pair of api calls
   for each verb, chosen by `isStaff`, and the RTL type vocabulary. Both are now
   INJECTED:

     · `adapter` — { list, add, edit, remove, suggest? } over whatever endpoints
       the caller's product has. Omit it and you get exactly the RTL pair this
       component always used, chosen by `isStaff` (`apiFileContactsAdapter`), so
       the two existing callers pass nothing new and render unchanged.
     · `types`   — [[value, label], …]. Omit it and you get FILE_CONTACT_TYPES,
       the RTL list this file has always carried.

   The adapter's `list()` answers ROWS IN THIS COMPONENT'S SHAPE — link_id,
   contact_id, contact_type, custom_type, company_name, contact_name, email,
   phone, address, notes. A product whose own columns are named differently maps
   them in its adapter; the mapping belongs there, not in a branch here, because
   a branch here is how the second product's rules leak into the first one's. */

/* THE RTL CONTACT TYPES — the default vocabulary, and the only one before
   2026-08-30. Kept in step with FILE_CONTACT_TYPES in routes/staff.js and
   routes/borrower.js (see the note on `settlement_agent` below). */
export const FILE_CONTACT_TYPES = [
  ['realtor', 'Realtor / agent'],
  ['attorney', 'Attorney'],
  ['title_company', 'Title company'],
  // Added 2026-07-28: the attorney closing-prep email shares the settlement agent's
  // details, and there was no contact type that meant it. Keep in step with
  // FILE_CONTACT_TYPES in routes/staff.js and routes/borrower.js.
  ['settlement_agent', 'Settlement agent'],
  ['insurance_agent', 'Insurance company'],
  ['flood_insurance', 'Flood insurance'],
  ['contractor', 'Contractor'],
  ['appraiser', 'Appraiser'],
  ['lender', 'Lender'],
  ['escrow', 'Escrow'],
  ['other', 'Other'],
];

/* What a row's type is CALLED, read out of the same list the picker offers — so a
   product that carries its own vocabulary labels its rows with its own words and
   never with RTL's. An unknown value prints itself rather than disappearing: a
   contact whose type nobody recognises is still a contact, and a blank pill would
   hide it. */
export function contactTypeLabel(c, types = FILE_CONTACT_TYPES) {
  if (c.contact_type === 'other') return (c.custom_type || 'Other');
  const hit = (types || []).find(([v]) => v === c.contact_type);
  return (hit && hit[1]) || c.contact_type;
}

const blankFor = (types) => ({
  contactType: (types && types[0] && types[0][0]) || 'other',
  customType: '', companyName: '', contactName: '', email: '', phone: '', notes: '',
  contactId: null,   // a directory row picked from the type-ahead — linked, never re-inserted
});

/**
 * THE DEFAULT ADAPTER — the RTL pair of endpoints, chosen by `isStaff`.
 *
 * Exactly the calls this component made inline before the seam existed, moved out
 * so "no adapter" is a real object rather than a branch inside every handler.
 * `suggest` is the fifth verb of the contract: this component does not draw a
 * type-ahead (the condition forms do, against the same endpoints), but an adapter
 * shape that leaves it out on one product and carries it on the other is drift on
 * day one.
 */
export function apiFileContactsAdapter(appId, isStaff) {
  return isStaff ? {
    list: () => api.staffFileContacts(appId),
    add: (f) => api.staffAddFileContact(appId, f),
    edit: (linkId, f) => api.staffEditFileContact(linkId, f),
    remove: (linkId) => api.staffDelFileContact(linkId),
    suggest: (type, q) => api.staffVendorSuggest(appId, type, q),
  } : {
    list: () => api.fileContacts(appId),
    add: (f) => api.addFileContact(appId, f),
    edit: (linkId, f) => api.editFileContact(linkId, f),
    remove: (linkId) => api.delFileContact(linkId),
    suggest: (type, q) => api.vendorSuggest(type, q),
  };
}

/* THE RTL WORDING, CHARACTER FOR CHARACTER — including the plain ASCII apostrophe
   the JSX carried. It moved out of the markup so a second product can say what its
   own contacts are, and the two existing callers pass nothing and read exactly what
   they always read. */
const DEFAULT_BLURB = "Realtors, attorneys, title, insurance, flood, contractors and anyone else on this deal. "
  + "Everyone on the file sees them, and they're saved to the company vendor directory.";

export default function FileContacts({
  appId, isStaff, heading = 'File contacts',
  adapter = null, types = FILE_CONTACT_TYPES, blurb = DEFAULT_BLURB,
  /* THE EXPECTED ROWS — OPTIONAL, AND OMITTING IT IS BYTE-IDENTICAL TO BEFORE.
     `[{ key, label, required, applies, whyNot }]`, computed on the SERVER against
     the file's own facts. `applies` is THREE-VALUED and the third value is the
     point: `null` means we could not read the fact yet, which must never render
     as a confident "this file does not need it".

     Owner-directed 2026-08-31: *"On the FileContacts, there should be the same
     logic that we have by New York settlement agents: it's grayed out … I'm
     looking now in a file where a person is renting his primary residence, and I
     don't see in the FileContacts a slot for landlord contact information."* A
     dropdown you have to know to open is not a slot; this is. A row that does not
     apply is KEPT AND GREYED rather than hidden, because seeing that the question
     was asked and answered "not this file" is the reassurance — an absent row is
     indistinguishable from one nobody thought of. */
  slots = null,
}) {
  const [list, setList] = useState(null);
  const [adding, setAdding] = useState(false);
  const [editId, setEditId] = useState(null);   // link_id being edited in place
  const BLANK = useMemo(() => blankFor(types), [types]);
  const [f, setF] = useState(BLANK);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  // No adapter = the RTL pair, which is what both existing callers rely on.
  const io = useMemo(() => adapter || apiFileContactsAdapter(appId, isStaff), [adapter, appId, isStaff]);

  /* WHAT IS ON THE FILE, ARRANGED BY THE JOB IT DOES. Only computed when a caller
     asked for slots; without them `rows` is null and everything below behaves
     exactly as it did. A contact whose type is not one of the slots is NOT lost —
     it falls through to the ordinary list under its own heading, which is what
     keeps "add anyone else" working. */
  const slotRows = useMemo(() => {
    if (!Array.isArray(slots) || !slots.length) return null;
    const byType = new Map();
    for (const c of (list || [])) {
      const k = c.contact_type || 'other';
      if (!byType.has(k)) byType.set(k, []);
      byType.get(k).push(c);
    }
    return slots.map((s) => ({ ...s, cards: byType.get(s.key) || [] }));
  }, [slots, list]);
  const extras = useMemo(() => {
    if (!slotRows) return list;
    const keys = new Set(slotRows.map((s) => s.key));
    return (list || []).filter((c) => !keys.has(c.contact_type || 'other'));
  }, [slotRows, list]);

  /* Open the add form already set to one job, so a slot's own button fills that
     slot rather than dropping somebody into a dropdown they then have to find. */
  function addInto(key) {
    setErr(''); setEditId(null); setF({ ...BLANK, contactType: key }); setAdding(true);
  }
  const load = () => io.list().then(setList).catch(() => setList([]));
  // Keyed on the FILE, not on the adapter: a caller that builds its adapter inline
  // would otherwise re-fetch on every render. A second product passes its own id
  // as `appId` and inherits the same reload rule.
  useEffect(() => { load(); /* eslint-disable-next-line */ }, [appId, isStaff]);

  const gate = useSubmitGate();
  async function add() {
    setErr('');
    if (!f.companyName && !f.contactName && !f.email && !f.phone) { setErr('Enter at least one detail (company, name, email or phone).'); return; }
    if (!gate.enter()) return;             // a contact is already being added
    setBusy(true);
    try {
      await io.add(f);
      setF(BLANK); setAdding(false); await load();
    } catch (e) { setErr((e && e.message) || 'Could not add the contact.'); }
    finally { setBusy(false); gate.leave(); }
  }
  // Open the inline editor prefilled from a contact row.
  function startEdit(c) {
    setErr(''); setAdding(false); setEditId(c.link_id);
    setF({
      contactType: c.contact_type || 'other', customType: c.custom_type || '',
      companyName: c.company_name || '', contactName: c.contact_name || '',
      email: c.email || '', phone: c.phone || '', address: c.address || '', notes: c.notes || '',
    });
  }
  async function saveEdit() {
    setErr('');
    if (!f.companyName && !f.contactName && !f.email && !f.phone) { setErr('Enter at least one detail (company, name, email or phone).'); return; }
    setBusy(true);
    try {
      await io.edit(editId, f);
      setF(BLANK); setEditId(null); await load();
    } catch (e) { setErr((e && e.message) || 'Could not save the contact.'); }
    finally { setBusy(false); }
  }
  async function remove(linkId) {
    if (!(await askConfirm('Remove this contact from the file? (It stays in the company vendor directory.)'))) return;
    try { await io.remove(linkId); await load(); } catch (_) { /* ignore */ }
  }

  return (
    <div className="panel" style={{ marginTop: 18 }}>
      <div className="row" style={{ alignItems: 'center', marginBottom: 6 }}>
        <h3 style={{ margin: 0 }}>{heading}</h3>
        <div className="spacer" />
        {!adding && !editId && <button className="btn ghost small" onClick={() => { setF(BLANK); setErr(''); setEditId(null); setAdding(true); }}>+ Add contact</button>}
      </div>
      <p className="muted small" style={{ marginTop: 0 }}>
        {blurb}
      </p>

      {(adding || editId) && (
        <div className="panel" style={{ background: 'var(--surface-soft, var(--ink-2))', marginBottom: 12 }}>
          <div className="grid cols-2" style={{ gap: 8 }}>
            <div>
              <label className="muted small">Type</label>
              <select className="input" value={f.contactType} onChange={e => setF({ ...f, contactType: e.target.value })}>
                {types.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
              </select>
            </div>
            {f.contactType === 'other' && (
              <div>
                <label className="muted small">What kind?</label>
                <input className="input" placeholder="e.g. Surveyor" value={f.customType} onChange={e => setF({ ...f, customType: e.target.value })} />
              </div>
            )}
            <div><label className="muted small">Company</label>
              {/* THE COMPANY VENDOR DIRECTORY, IN THE FORM (owner-directed 2026-09-01: "they can
                  import the vendor … You don't need to type email. It populates from our vendor
                  database according to the search"). The adapter's `suggest` verb was threaded
                  through for exactly this and unused until now. Picking fills every field and
                  carries the directory row's id, so the server LINKS that row instead of
                  inserting a look-alike. */}
              <VendorAutocomplete className="input" value={f.companyName}
                onChange={(v) => setF((p) => ({ ...p, companyName: v, contactId: null }))}
                onPick={(v) => setF((p) => ({
                  ...p, contactId: v.id || null,
                  companyName: v.companyName || p.companyName || '',
                  contactName: v.contactName || p.contactName || '',
                  email: (v.emails && v.emails[0]) || p.email || '',
                  phone: v.phone || p.phone || '',
                  notes: p.notes,
                }))}
                fetchSuggestions={(q) => io.suggest(f.contactType, q)}
                placeholder="Company — start typing to pick from the vendor directory"
                emptyHint="No match in the vendor directory — type the details in." /></div>
            <div><label className="muted small">Contact name</label><input className="input" value={f.contactName} onChange={e => setF({ ...f, contactName: e.target.value })} /></div>
            <div><label className="muted small">Email</label><EmailInput value={f.email} onChange={v => setF({ ...f, email: v })} /></div>
            <div><label className="muted small">Phone</label><PhoneInput value={f.phone} onChange={v => setF({ ...f, phone: v })} /></div>
            <div style={{ gridColumn: '1 / -1' }}><label className="muted small">Notes</label><input className="input" value={f.notes} onChange={e => setF({ ...f, notes: e.target.value })} /></div>
          </div>
          {err && <div role="alert" className="small" style={{ color: 'var(--danger)', marginTop: 6 }}>{err}</div>}
          <div className="row" style={{ gap: 8, marginTop: 10 }}>
            <button className="btn primary small" disabled={busy} onClick={editId ? saveEdit : add}>{busy ? 'Saving…' : editId ? 'Save changes' : 'Save contact'}</button>
            <button className="btn ghost small" onClick={() => { setAdding(false); setEditId(null); setErr(''); }}>Cancel</button>
          </div>
        </div>
      )}

      {list == null ? <p className="muted small">Loading…</p> : (
        <>
          {slotRows && (
            <div style={{ display: 'grid', gap: 6, marginBottom: extras && extras.length ? 14 : 0 }}>
              {slotRows.map(s => (
                <ContactSlot key={s.key} slot={s} onAdd={() => addInto(s.key)}
                  onEdit={startEdit} onRemove={remove} />
              ))}
            </div>
          )}

          {slotRows && extras && extras.length > 0 && (
            <div className="muted small" style={{ fontWeight: 600, marginBottom: 6 }}>Also on this file</div>
          )}

          {(slotRows ? extras : list).length === 0
            ? (slotRows ? null : <p className="muted small">No contacts on this file yet.</p>)
            : (
              <div style={{ display: 'grid', gap: 6 }}>
                {(slotRows ? extras : list).map(c => (
                  <div key={c.link_id} className="checkitem" style={{ alignItems: 'center' }}>
                    <span className="pill" style={{ marginRight: 8 }}>{contactTypeLabel(c, types)}</span>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontWeight: 600 }}>{c.company_name || c.contact_name || c.email || '—'}</div>
                      <div className="muted small" style={{ wordBreak: 'break-word' }}>
                        {[c.contact_name && c.company_name ? c.contact_name : '', c.email, c.phone].filter(Boolean).join(' · ') || '—'}
                        {c.notes ? ` — ${c.notes}` : ''}
                      </div>
                    </div>
                    <button className="btn ghost small" title="Edit this contact's details" onClick={() => startEdit(c)}>Edit</button>
                    <button className="btn ghost small" title="Remove from this file" onClick={() => remove(c.link_id)}>Remove</button>
                  </div>
                ))}
              </div>
            )}
        </>
      )}
    </div>
  );
}

/**
 * ONE EXPECTED CONTACT — the card if we have it, the reason if this file does not
 * want it, and an Add button if it does.
 *
 * `applies` is three-valued and each value gets its own treatment, because they
 * are three different instructions to the reader:
 *   true  — this file needs it. Add it.
 *   false — this file does not. Greyed, with the reason, and NOT offered: an Add
 *           button beside "only on a condominium" invites somebody to file a
 *           management company on a single-family house.
 *   null  — we cannot tell yet. Greyed with its own wording, and STILL offered,
 *           because refusing on a fact we could not read is the expensive
 *           direction — somebody who knows the answer must be able to act.
 *
 * A card that is already on the file always shows in full, whatever the row says:
 * a landlord recorded before the residence was read is real, and hiding it behind
 * a grey "we cannot tell" would lose work somebody did.
 *
 * Every colour is an explicit dark on the white canvas — `--ink*` is a LIGHT paper
 * token in this palette and renders white-on-white.
 */
function ContactSlot({ slot, onAdd, onEdit, onRemove }) {
  const has = slot.cards.length > 0;
  const off = slot.applies === false;
  const unknown = slot.applies === null || slot.applies === undefined;
  const dim = !has && (off || unknown);
  return (
    <div className="checkitem" style={{ alignItems: 'center', opacity: dim ? 0.72 : 1 }}>
      <span className="pill" style={{ marginRight: 8 }}>{slot.label}</span>
      <div style={{ flex: 1, minWidth: 0 }}>
        {has ? slot.cards.map(c => (
          <div key={c.link_id} style={{ marginBottom: slot.cards.length > 1 ? 4 : 0 }}>
            <div style={{ fontWeight: 600, color: '#141B22' }}>{c.company_name || c.contact_name || c.email || '—'}</div>
            <div className="small" style={{ color: '#4B585C', wordBreak: 'break-word' }}>
              {[c.contact_name && c.company_name ? c.contact_name : '', c.email, c.phone].filter(Boolean).join(' · ') || '—'}
            </div>
          </div>
        )) : (
          <div className="small" style={{ color: '#4B585C' }}>
            {off || unknown ? slot.whyNot
              : (slot.required ? 'Needed on this file — nobody added yet.' : 'Nobody added yet.')}
          </div>
        )}
      </div>
      {has
        ? (
          <>
            <button className="btn ghost small" title="Edit this contact's details" onClick={() => onEdit(slot.cards[0])}>Edit</button>
            <button className="btn ghost small" title="Remove from this file" onClick={() => onRemove(slot.cards[0].link_id)}>Remove</button>
          </>
        )
        : !off && <button className="btn ghost small" onClick={onAdd}>+ Add</button>}
    </div>
  );
}

/* A read-only vendor list for a borrower profile — every vendor the borrower is
   dealing with, across all their files. */
export function BorrowerContacts({ borrowerId, isStaff }) {
  const [list, setList] = useState(null);
  useEffect(() => {
    (isStaff ? api.staffBorrowerContacts(borrowerId) : api.myContacts()).then(setList).catch(() => setList([]));
  }, [borrowerId, isStaff]);
  if (list == null) return <p className="muted small">Loading contacts…</p>;
  if (!list.length) return <p className="muted small">No vendors on record yet.</p>;
  return (
    <div style={{ display: 'grid', gap: 6 }}>
      {list.map(c => (
        <div key={c.id} className="checkitem" style={{ alignItems: 'center' }}>
          <span className="pill" style={{ marginRight: 8 }}>{contactTypeLabel(c)}</span>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontWeight: 600 }}>{c.company_name || c.contact_name || c.email || '—'}</div>
            <div className="muted small">{[c.email, c.phone].filter(Boolean).join(' · ') || '—'}</div>
          </div>
          {c.files_used > 0 && <span className="muted small">{c.files_used} file{c.files_used === 1 ? '' : 's'}</span>}
        </div>
      ))}
    </div>
  );
}
