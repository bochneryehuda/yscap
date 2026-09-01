import React, { useMemo, useState } from 'react';
import FileContacts from '../components/FileContacts.jsx';
import { ltApi } from './api.js';

/**
 * THE LONG-TERM FILE'S CONTACTS DESK — the SHORT-TERM component, not a copy.
 *
 * Owner-directed 2026-08-31: *"we added a section, especially for file contacts
 * where you can enter random file contacts and then the required file contact
 * comes up as conditions"*, and *"Bring over the entire file contact to just
 * share our vendor settings that we have on the short term side to be the same,
 * it should not copy. It should be the same, should be the exact same vendor
 * setup and use the same information."*
 *
 * `FileContacts.jsx` was given an `adapter`/`types` seam in the 2026-08-30
 * share-the-code pass precisely so this could exist, and then had no long-term
 * caller — which is why the loan screen had no contacts desk at all and the
 * orders had nobody to send to. This file is only the seam: no contacts logic
 * lives here, and the component branches on nothing.
 *
 * THE ADAPTER IS THE WHOLE POINT. Long-Term's rows live on `lt_loan_vendors`
 * pointing at the SAME shared `service_contacts` directory, and its columns are
 * named for a loan rather than for an application. Mapping them HERE — and not
 * with a branch inside the component — is what stops one product's vocabulary
 * leaking into the other's screen.
 */

/**
 * THE DROPDOWN'S FALLBACK, and only that.
 *
 * The vendor kinds are the SERVER's (`orders/kinds.js VENDOR_KINDS`) and arrive
 * with the contacts, so this list is what the dropdown shows for the moment
 * before the first answer lands. It is a copy, which is exactly the shape that
 * drifts — it already had, calling the settlement agent something the rest of the
 * system does not — so `test-lt-file-contacts-pure.js` reads BOTH out of the
 * source and fails the build the day they disagree. Add a kind on the server.
 */
const LT_TYPES = [
  ['title', 'Title company'],
  ['hazard_insurance', 'Hazard insurance agent'],
  ['flood_insurance', 'Flood insurance agent'],
  ['ny_settlement_agent', 'Settlement agent'],
  ['buyers_attorney', 'Buyer’s attorney'],
  ['our_attorney', 'Our attorney'],
  ['realtor', 'Realtor'],
  ['hoa', 'HOA management company'],
  ['landlord', 'Landlord'],
  ['appraisal', 'Appraisal management company'],
  ['payoff', 'Servicer being paid off'],
  ['other', 'Other'],
];

/**
 * The long-term rows in the shared component's shape.
 *
 * `emails`/`phones` are ARRAYS on this side (db/224 put an `emails text[]` beside
 * the legacy scalar). The component reads the singular, and the FIRST entry is
 * the one every existing reader of `service_contacts` treats as primary — so
 * taking `[0]` is the same value, not a lossy guess.
 */
function toSharedRow(v) {
  return {
    link_id: v.id,
    contact_id: v.serviceContactId,
    contact_type: v.kind,
    custom_type: null,
    company_name: v.companyName || '',
    contact_name: v.contactName || '',
    email: (v.emails || [])[0] || '',
    phone: (v.phones || [])[0] || '',
    address: v.address || '',
    notes: '',
    // A card removed from the shared directory reads as GONE rather than blank —
    // "this company is no longer in the directory" is a different instruction
    // from "nobody is on the file".
    missing: !!v.missing,
  };
}

export default function LtFileContacts({ loanId }) {
  /* WHICH CONTACTS THIS FILE EXPECTS, and which of them belong on it — computed on
     the SERVER from the one list (`conditions-center/library.js FILE_CONTACT_TYPES`)
     against this loan's own facts, so the desk and the pre-submittal condition can
     never disagree about what a row is called or which fact greys it.

     It rides the SAME request the contacts do rather than a second one: the two
     answers are about the same moment, and fetching them apart is how a screen
     ends up greying a row against facts that have since moved. Null until the
     first answer lands, and null again if the server could not read the facts —
     the shared component then draws its ordinary list, which is the honest
     degrade: no slots is better than slots greyed on a guess. */
  const [slots, setSlots] = useState(null);
  const [kinds, setKinds] = useState(null);
  /* SAID OUT LOUD WHEN A LANDLORD APPEARS BY ITSELF. The server fills in the
     landlord this borrower already had at this same home (owner-directed
     2026-08-31), and a card that turns up with nothing explaining where it came
     from is one nobody trusts and everybody re-checks — which costs more than
     typing it would have. Null on every read after the first, because the fill
     only ever happens once. */
  const [filled, setFilled] = useState(null);

  const adapter = useMemo(() => ({
    list: () => ltApi.orderVendors(loanId).then((r) => {
      setSlots(Array.isArray(r.contactTypes) && r.contactTypes.length ? r.contactTypes : null);
      setKinds(r.kinds && typeof r.kinds === 'object' ? Object.entries(r.kinds) : null);
      setFilled(r.landlordFilled || null);
      return (r.vendors || []).map(toSharedRow);
    }),
    add: (f) => ltApi.orderVendorCreate(loanId, {
      kind: f.contactType, customType: f.customType,
      companyName: f.companyName, contactName: f.contactName,
      email: f.email, phone: f.phone, address: f.address, notes: f.notes,
    }),
    edit: (linkId, f) => ltApi.orderVendorEdit(loanId, linkId, {
      kind: f.contactType, customType: f.customType,
      companyName: f.companyName, contactName: f.contactName,
      email: f.email, phone: f.phone, address: f.address, notes: f.notes,
    }),
    remove: (linkId) => ltApi.orderVendorUnlink(loanId, linkId),
    /* The fifth verb. This component does not draw a type-ahead — the condition
       forms do, against this same endpoint — but an adapter shape that carries
       it on one product and omits it on the other is drift on day one. */
    suggest: (type, q) => ltApi.orderVendorSearch(loanId, type, q).then((r) => r.results || []),
  }), [loanId]);

  return (
    <>
      {filled ? (
        /* Explicit darks: an `--ink*` token is a LIGHT paper colour in this
           palette, so one used as a text colour renders white on white. */
        <div style={{
          margin: '0 0 12px', padding: '10px 12px', borderRadius: 8,
          border: '1px solid #AE8746', background: '#FBF7EF', color: '#141B22', fontSize: 14,
        }}>
          <strong>{filled.name || 'The landlord'}</strong>{' '}
          was filled in from this borrower&rsquo;s last file
          {filled.addressText ? <> — they were renting <strong>{filled.addressText}</strong> then too</> : null}.
          {' '}Change it if they have a different landlord now.
        </div>
      ) : null}
    <FileContacts
      appId={loanId}
      isStaff
      adapter={adapter}
      types={kinds || LT_TYPES}
      slots={slots}
      heading="File contacts"
      blurb={'Title, insurance, the settlement agent, the association, the landlord and anyone else on this loan. '
        + 'A row that this deal does not need is greyed rather than hidden, so you can see the question was asked. '
        + 'These are the records the orders are sent to, and they are saved to the same company vendor directory '
        + 'the short-term side uses — so one company is one card across both.'}
    />
    </>
  );
}
