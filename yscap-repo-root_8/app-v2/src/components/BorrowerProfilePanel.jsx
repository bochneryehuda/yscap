import React, { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../lib/api.js';
import { fmtDay, dayInputValue } from '../lib/dates.js';
import { PhoneInput, ZipInput, EmailInput } from './FormattedInputs.jsx';
import AddressAutocomplete from './AddressAutocomplete.jsx';
import { CITIZENSHIP, MARITAL, CONTACT_TYPE, HOUSING, EMPLOYMENT, withCurrent } from '../lib/enums.js';
import { formatSSN, cleanFICO, ficoValid } from '../lib/validators.js';
import { fullNameOf, splitName, rejoin, nameChanged } from '../lib/personName.js';

/* THE BORROWER'S OWN RECORD — editable wherever the person appears
   (owner-directed 2026-07-27: "when we edit the application we can only edit the
   details of the property, we can't edit the borrower profile … there should be
   a button to edit the entire borrower profile over there, so we can edit the
   1st borrower profile and the 2nd borrower's profile as well — name, social,
   everything").

   Two different records live on a loan file and they were not equally reachable:
   the DEAL (property, price, program — `EditFileDetails`) and the PERSON (legal
   name, date of birth, Social, contact details, home address, housing,
   employment). Only the deal had a full editor on the file; the person's record
   could only be edited from the separate borrower-profile screen, and the
   CO-borrower's record had no full editor anywhere at all.

   So the profile editor moved OUT of the profile screen and into this shared
   component. There is ONE definition of "what a borrower profile is and how you
   edit it", used by the profile screen AND by the loan file, once per borrower —
   so the two can never drift apart, and a field added here appears on both.

   Every field routes through the SAME audited endpoints as before — nothing new
   is trusted to the client:
     · PATCH /api/staff/borrowers/:id   name / DOB / contact / address / housing
     · POST  /api/staff/borrowers/:id/ssn   the Social (separately audited)
   Access is the server's to decide (`canSeeBorrower`), which is the same scope
   that let the staffer open the file in the first place. */

const money = (n) => (n == null || n === '' ? null : '$' + Math.round(Number(n)).toLocaleString('en-US'));
function addrLine(a) {
  if (!a) return null;
  if (typeof a === 'string') return a;
  const s = [a.line1 || a.street, a.unit, a.city, [a.state, a.zip].filter(Boolean).join(' ')].filter(Boolean).join(', ');
  return s || null;
}
// THE ONE BIG NAME FIELD (db/346) — the whole name, middle name and suffix
// included, falling back to the parts so an older response still renders.
const fullName = (b) => fullNameOf(b);

// "Please check this name" — PILOT had to make a judgement call about where a
// borrower's name splits (db/345 `name_review_needed`), so it asks a human once.
// It is a PROMPT, never a gate: nothing on the file waits for it. One click
// confirms; editing the name clears it too, because typing the parts IS the answer.
const NAME_SPLIT_HELP = {
  only_one_word: 'Only one word was given, so we could not tell the first name from the last name.',
  three_words: 'Three words — we made the middle word the middle name. Please check that is right.',
  four_or_more_words: 'More than three words — please check we picked the right first, middle and last name.',
  surname_particle: 'The last name looks like it has a small word in it (like "van" or "de la"). Please check.',
  comma_form: 'The name was written last-name-first, so please check we read it the right way round.',
  surname_only: 'This looks like a last name with no first name. Please check.',
};
export function NameSplitPrompt({ b, onChanged }) {
  const [busy, setBusy] = useState(false);
  const [gone, setGone] = useState(false);
  if (!b || !b.name_review_needed || gone) return null;
  const why = NAME_SPLIT_HELP[b.name_review_reason] || 'Please check this name is split correctly.';
  const confirm = async () => {
    setBusy(true);
    try { await api.staffUpdateBorrower(b.id, { confirmNameSplit: true }); setGone(true); onChanged(); }
    catch (_) { setBusy(false); }
  };
  return (
    <div className="notice" style={{ borderLeft: '4px solid #AE8746', background: '#FFFDF7', color: '#141B22' }}>
      <b style={{ color: '#141B22' }}>Please check this name</b>
      <div style={{ marginTop: 4, color: '#4B585C' }}>{why}</div>
      <div style={{ marginTop: 8, color: '#141B22' }}>
        First <b>{b.first_name || '—'}</b>
        {'  ·  '}Middle <b>{b.middle_name || 'none'}</b>
        {'  ·  '}Last <b>{b.last_name || '—'}</b>
        {b.name_suffix ? <>{'  ·  '}Suffix <b>{b.name_suffix}</b></> : null}
      </div>
      <div style={{ marginTop: 10, display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        <button className="btn primary small" onClick={confirm} disabled={busy}>
          {busy ? 'Saving…' : 'Yes, that is right'}
        </button>
        <span className="small" style={{ color: '#4B585C', alignSelf: 'center' }}>
          Not right? Use <b>Edit</b> below and fix the boxes — that clears this too.
        </span>
      </div>
    </div>
  );
}

/* ---------------------------------------------------------------- the form ---
   Every field on the person's record. Extracted verbatim from the profile
   screen so the two surfaces stay identical by construction. */
export function BorrowerProfileForm({ b, onSaved, onCancel }) {
  const [team, setTeam] = useState([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  // A shared mailbox (a husband and wife on one address) is a real situation, not
  // an error — the save offers to keep BOTH profiles rather than dead-ending.
  const [shareOffer, setShareOffer] = useState(false);
  useEffect(() => { api.staffTeam().then(setTeam).catch(() => {}); }, []);
  const [f, setF] = useState(() => ({
    fullName: fullNameOf(b),
    firstName: b.first_name || '', middleName: b.middle_name || '', lastName: b.last_name || '',
    nameSuffix: b.name_suffix || '',
    email: b.email || '', cellPhone: b.cell_phone || '', contactType: b.contact_type || '',
    maritalStatus: b.marital_status || '', citizenship: b.citizenship || '',
    fico: b.fico == null ? '' : String(b.fico),
    dob: dayInputValue(b.date_of_birth) || '',
    primaryOfficerId: b.primary_officer_id || '',
    housingStatus: b.housing_status || '', housingPayment: b.housing_payment ?? '',
    yearsAtResidence: b.years_at_residence ?? '', monthsAtResidence: b.months_at_residence ?? '',
    employmentType: b.employment_type || '', employer: b.employer || '',
    dependentsCount: b.dependents_count ?? '',
    ca: b.current_address || {}, ma: b.mailing_address || {},
  }));

  async function save(allowSharedEmail = false) {
    // A FICO that is not a real 3-digit score never leaves the browser — the
    // server refuses it anyway, and refusing here names the field.
    if (f.fico !== '' && !ficoValid(f.fico)) { setErr('FICO must be a 3-digit score between 300 and 850.'); return; }
    setBusy(true); setErr('');
    try {
      await api.staffUpdateBorrower(b.id, {
        // Send the NAME only when it actually changed — a correction here is a
        // deliberate human decision, so it also goes out to every ClickUp card
        // (otherwise the next sync would read the old name straight back).
        ...(nameChanged(f, b) ? {
          firstName: f.firstName, middleName: f.middleName,
          lastName: f.lastName, nameSuffix: f.nameSuffix,
        } : {}),
        email: f.email, cellPhone: f.cellPhone, contactType: f.contactType,
        maritalStatus: f.maritalStatus, citizenship: f.citizenship,
        // FICO is editable here as of 2026-07-27 (owner-directed: EVERY field on
        // the borrower section, for every borrower). A credit pull still
        // overwrites it — this is for the score the team already has on paper,
        // and for correcting a wrong one. '' clears it; the server range-checks.
        fico: f.fico,
        // Send the DOB only when it actually changed — setting it applies to
        // the profile AND every linked ClickUp task (audited + journaled).
        ...(f.dob && f.dob !== (dayInputValue(b.date_of_birth) || '') ? { dob: f.dob } : {}),
        primaryOfficerId: f.primaryOfficerId || null,
        // Where they live and what they pay for it — the same columns the
        // borrower's own portal edits and the same ones that sync both ways with
        // ClickUp's Primary Housing fields, so the profile and the card agree.
        housingStatus: f.housingStatus, housingPayment: f.housingPayment,
        yearsAtResidence: f.yearsAtResidence, monthsAtResidence: f.monthsAtResidence,
        employmentType: f.employmentType, employer: f.employer,
        dependentsCount: f.dependentsCount,
        currentAddress: Object.values(f.ca).some(Boolean) ? f.ca : null,
        mailingAddress: Object.values(f.ma).some(Boolean) ? f.ma : null,
        ...(allowSharedEmail ? { allowSharedEmail: true } : {}),
      });
      setShareOffer(false);
      if (onSaved) await onSaved();
    } catch (e) {
      setErr(e.message || 'Could not save');
      setShareOffer(!!(e.data && e.data.sharedEmail && e.data.sharedEmail.canShare));
    } finally { setBusy(false); }
  }

  const setCa = (k, val) => setF(s => ({ ...s, ca: { ...s.ca, [k]: val } }));
  const setMa = (k, val) => setF(s => ({ ...s, ma: { ...s.ma, [k]: val } }));
  return (
    <div>
      {err && <div role="alert" className="notice err">{err}</div>}
      <div className="ts-inputs">
        {/* The legal name is correctable here (owner-directed 2026-07-26): a file
            opened under a nickname created the profile under that nickname, and
            there was nowhere to fix it. Saving pushes it to ClickUp too.

            THE ONE BIG NAME FIELD stays (owner-directed 2026-07-27): typing the
            whole name in the big box splits it into the parts below as you type,
            and typing a part rebuilds the big box. Either way the same four
            fields are saved, so nothing that reads a name changes. */}
        <label style={{ gridColumn: '1 / -1' }}><span>Full name</span>
          <input className="input" value={f.fullName}
            onChange={e => setF({ ...f, fullName: e.target.value, ...splitName(e.target.value) })}
            title="Their whole legal name. This is what every screen, email, term sheet and ClickUp card shows." /></label>
        <label><span>First name</span><input className="input" value={f.firstName}
          onChange={e => setF(s => rejoin({ ...s, firstName: e.target.value }))}
          title="Their real legal first name. Saving updates the profile and every linked ClickUp card." /></label>
        <label><span>Middle name <span style={{ color: '#4B585C', fontWeight: 400 }}>(optional)</span></span>
          <input className="input" value={f.middleName}
            onChange={e => setF(s => rejoin({ ...s, middleName: e.target.value }))}
            title="Leave empty if they do not have one." /></label>
        <label><span>Last name</span><input className="input" value={f.lastName}
          onChange={e => setF(s => rejoin({ ...s, lastName: e.target.value }))} /></label>
        <label><span>Suffix <span style={{ color: '#4B585C', fontWeight: 400 }}>(optional)</span></span>
          <input className="input" placeholder="Jr., III" value={f.nameSuffix}
            onChange={e => setF(s => rejoin({ ...s, nameSuffix: e.target.value }))} /></label>
        <label><span>Email</span><EmailInput value={f.email} onChange={v => setF({ ...f, email: v })} /></label>
        <label><span>Cell phone</span><PhoneInput value={f.cellPhone} onChange={v => setF({ ...f, cellPhone: v })} /></label>
        <label><span>Contact type</span>
          <select className="input" value={f.contactType} onChange={e => setF({ ...f, contactType: e.target.value })}>
            <option value="">Select…</option>{withCurrent(CONTACT_TYPE, f.contactType).map(c => <option key={c} value={c}>{c}</option>)}
          </select></label>
        <label><span>Marital status</span>
          <select className="input" value={f.maritalStatus} onChange={e => setF({ ...f, maritalStatus: e.target.value })}>
            <option value="">Select…</option>{withCurrent(MARITAL, f.maritalStatus).map(c => <option key={c} value={c}>{c}</option>)}
          </select></label>
        <label><span>Citizenship</span>
          <select className="input" value={f.citizenship} onChange={e => setF({ ...f, citizenship: e.target.value })}>
            <option value="">Select…</option>{withCurrent(CITIZENSHIP, f.citizenship).map(c => <option key={c} value={c}>{c}</option>)}
          </select></label>
        <label><span>Date of birth</span><input className="input" type="date" value={f.dob}
          onChange={e => setF({ ...f, dob: e.target.value })}
          title="Saving applies to the borrower profile and every linked ClickUp task (audited)" /></label>
        <label><span>FICO</span><input className="input" inputMode="numeric" maxLength={3}
          placeholder="300–850" value={f.fico}
          onChange={e => setF({ ...f, fico: cleanFICO(e.target.value) })}
          title="Normally comes from the credit pull — enter it when you have the score before the pull, or to correct a wrong one." /></label>
        <label><span>Primary officer</span>
          <select className="input" value={f.primaryOfficerId} onChange={e => setF({ ...f, primaryOfficerId: e.target.value })}>
            <option value="">—</option>
            {team.map(t => <option key={t.id} value={t.id}>{t.full_name}</option>)}
          </select></label>
      </div>
      <div style={{ fontWeight: 600, margin: '12px 0 6px', color: '#141B22' }}>Current address</div>
      <div className="ts-inputs">
        <label style={{ gridColumn: '1 / -1' }}><span>Street</span>
          <AddressAutocomplete value={f.ca.line1 || ''} onChange={v => setCa('line1', v)}
            onPick={addr => setF(s => ({ ...s, ca: { ...s.ca, line1: addr.line1 || '', city: addr.city || '', state: (addr.state || '').toUpperCase(), zip: addr.zip || '' } }))} /></label>
        <label><span>City</span><input className="input" value={f.ca.city || ''} onChange={e => setCa('city', e.target.value)} /></label>
        <label><span>State</span><input className="input" value={f.ca.state || ''} onChange={e => setCa('state', e.target.value)} /></label>
        <label><span>ZIP</span><ZipInput value={f.ca.zip || ''} onChange={v => setCa('zip', v)} /></label>
      </div>
      <div style={{ fontWeight: 600, margin: '12px 0 6px', color: '#141B22' }}>Mailing address (if different)</div>
      <div className="ts-inputs">
        <label style={{ gridColumn: '1 / -1' }}><span>Street</span>
          <AddressAutocomplete value={f.ma.line1 || ''} onChange={v => setMa('line1', v)}
            onPick={addr => setF(s => ({ ...s, ma: { ...s.ma, line1: addr.line1 || '', city: addr.city || '', state: (addr.state || '').toUpperCase(), zip: addr.zip || '' } }))} /></label>
        <label><span>City</span><input className="input" value={f.ma.city || ''} onChange={e => setMa('city', e.target.value)} /></label>
        <label><span>State</span><input className="input" value={f.ma.state || ''} onChange={e => setMa('state', e.target.value)} /></label>
        <label><span>ZIP</span><ZipInput value={f.ma.zip || ''} onChange={v => setMa('zip', v)} /></label>
      </div>
      {/* Housing: do they own or rent, and what does it cost them each month.
          Collected on the loan file and on the borrower's own application — the
          profile is where it belongs, and it rides along to every new file. */}
      <div style={{ fontWeight: 600, margin: '12px 0 6px', color: '#141B22' }}>Housing &amp; employment</div>
      <div className="ts-inputs">
        <label><span>Owns or rents</span>
          <select className="input" value={f.housingStatus} onChange={e => setF({ ...f, housingStatus: e.target.value })}>
            <option value="">Select…</option>{withCurrent(HOUSING, f.housingStatus).map(c => <option key={c} value={c}>{c}</option>)}
          </select></label>
        <label><span>Rent / mortgage per month</span>
          <input className="input" inputMode="decimal" placeholder="e.g. 2,800" value={f.housingPayment}
            onChange={e => setF({ ...f, housingPayment: e.target.value })} /></label>
        <label><span>Years at this address</span>
          <input className="input" inputMode="decimal" value={f.yearsAtResidence}
            onChange={e => setF({ ...f, yearsAtResidence: e.target.value })} /></label>
        <label><span>…plus months</span>
          <input className="input" inputMode="numeric" value={f.monthsAtResidence}
            onChange={e => setF({ ...f, monthsAtResidence: e.target.value })} /></label>
        <label><span>Employment</span>
          <select className="input" value={f.employmentType} onChange={e => setF({ ...f, employmentType: e.target.value })}
            title="A two-way ClickUp field — a spelling it cannot translate is dropped from the push in silence, so this is a fixed list.">
            <option value="">Select…</option>{withCurrent(EMPLOYMENT, f.employmentType).map(c => <option key={c} value={c}>{c}</option>)}
          </select></label>
        <label><span>Employer</span>
          <input className="input" value={f.employer} onChange={e => setF({ ...f, employer: e.target.value })} /></label>
        <label><span>Dependents</span>
          <input className="input" inputMode="numeric" value={f.dependentsCount}
            onChange={e => setF({ ...f, dependentsCount: e.target.value })} /></label>
      </div>
      <p className="small" style={{ color: '#4B585C', marginTop: 8 }}>
        This is the person's own record, not this deal's. Housing, employment and address save to the
        borrower's profile and go out to their ClickUp cards, so every file this person opens starts
        with the same details already filled in.
      </p>
      {shareOffer && (
        <div className="notice" style={{ marginTop: 10, color: '#141B22' }}>
          <strong>Do two people share this email?</strong> A husband and wife often use one mailbox.
          Keep both as separate profiles on the same address — only the first one can sign in to the portal.
          <div style={{ marginTop: 8 }}>
            <button className="btn small" disabled={busy} onClick={() => save(true)}>
              Yes — they share the mailbox, save anyway
            </button>
          </div>
        </div>
      )}
      <div className="row" style={{ gap: 8, marginTop: 12 }}>
        <button className="btn primary small" disabled={busy} onClick={() => save(false)}>{busy ? 'Saving…' : 'Save'}</button>
        <button className="btn ghost small" onClick={() => { setShareOffer(false); if (onCancel) onCancel(); }}>Cancel</button>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------- SSN -----
   Reveal, add, correct, and un-stick a duplicate. The number has its own audited
   endpoint (it is never part of the ordinary profile save), and a collision with
   another profile NAMES that profile and offers the move instead of dead-ending. */
export function BorrowerSsnRow({ b, onChanged }) {
  const [full, setFull] = useState('');
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [conflict, setConflict] = useState(null);

  async function reveal() {
    if (full) { setFull(''); return; }
    setBusy(true); setErr('');
    try { const r = await api.staffBorrowerSsn(b.id); setFull(r.ssn || ''); }
    catch (e) { setErr(e.message || 'Could not reveal the number'); }
    finally { setBusy(false); }
  }
  async function save(resolveConflict) {
    if (draft.replace(/\D/g, '').length !== 9) return;
    setBusy(true); setErr('');
    try {
      await api.staffSetBorrowerSsn(b.id, draft, resolveConflict ? { resolveConflict } : {});
      setEditing(false); setDraft(''); setFull(''); setConflict(null); if (onChanged) await onChanged();
    } catch (e) {
      setErr(e.message || 'Could not save the number');
      setConflict(e.data && e.data.conflict ? e.data.conflict : null);
    } finally { setBusy(false); }
  }

  return (
    <>
      <div className="metrow">
        <span className="k">SSN</span>
        <span className="v" style={{ display: 'flex', alignItems: 'center', gap: 8, justifyContent: 'flex-end', flexWrap: 'wrap' }}>
          {editing ? (
            <>
              <input className="input" type="password" inputMode="numeric" autoComplete="off"
                placeholder="•••-••-••••" value={draft} disabled={busy} style={{ maxWidth: 160 }}
                onChange={(e) => { setDraft(formatSSN(e.target.value)); setConflict(null); setErr(''); }}
                onKeyDown={(e) => { if (e.key === 'Enter') save(); if (e.key === 'Escape') { setEditing(false); setConflict(null); setErr(''); } }} />
              <button className="btn small" disabled={busy || draft.replace(/\D/g, '').length !== 9} onClick={() => save()}>
                {busy ? '…' : 'Save'}</button>
              <button className="btn ghost small" onClick={() => { setEditing(false); setDraft(''); setConflict(null); setErr(''); }}>Cancel</button>
            </>
          ) : (
            <>
              <span style={{ fontVariantNumeric: 'tabular-nums', letterSpacing: '.02em', color: '#141B22' }}>
                {full || (b.ssn_last4 ? `•••-••-${b.ssn_last4}` : '—')}
              </span>
              {b.ssn_last4 && (
                <button className="btn ghost small" disabled={busy} onClick={reveal}
                  title={full ? 'Hide the full number' : 'Show the full number (this is logged)'}>
                  {busy ? '…' : (full ? 'Hide' : 'Show')}
                </button>
              )}
              <button className="btn ghost small" onClick={() => { setDraft(''); setEditing(true); }}
                title={b.ssn_last4 ? 'Correct the Social Security number (logged, and sent to ClickUp)' : 'Add the Social Security number (logged, and sent to ClickUp)'}>
                {b.ssn_last4 ? 'Change' : 'Add'}
              </button>
            </>
          )}
        </span>
      </div>
      {err && (
        <div role="alert" className="notice err" style={{ marginTop: 6 }}>
          {err}
          {conflict && conflict.canResolve && (
            <div style={{ marginTop: 8, display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              {conflict.borrowerId && (
                <Link className="btn ghost small" to={`/internal/borrowers/${conflict.borrowerId}`}>
                  Open {conflict.name || 'the other profile'}
                </Link>
              )}
              <button className="btn small" disabled={busy} onClick={() => save('same_person')}>
                Same person — move the number to this profile
              </button>
            </div>
          )}
        </div>
      )}
    </>
  );
}

/* ------------------------------------------------------------ portal access --
   WHERE THIS PERSON STANDS WITH THE PORTAL (owner-directed 2026-08-02: the file
   must show, for the borrower AND the co-borrower, whether they were invited and
   when — with a way to send it again — and whether they joined and when they last
   signed in).

   It lives HERE, in the one shared borrower panel, for the same reason the editor
   does: mounted once per person, so the co-borrower gets it for free and the two
   can never drift. The server does all the judging (lib/portal-invite) and hands
   down the finished sentence, so the wording is identical on every surface. */
export function PortalAccessRow({ b, onChanged }) {
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  const [err, setErr] = useState('');
  const p = (b && b.portal) || null;
  if (!p) return null;

  async function invite() {
    setBusy(true); setErr(''); setMsg('');
    try {
      const r = await api.staffBorrowerInvite(b.id);
      setMsg(r && r.hasAccount
        ? 'Sign-in link emailed — they already have a portal login.'
        : 'Invitation emailed.');
      if (onChanged) await onChanged();
    } catch (e) { setErr(e.message || 'Could not send the invitation.'); }
    finally { setBusy(false); }
  }

  // Green once they are in, gold while an invitation is out, plain otherwise.
  const tone = p.state === 'joined' ? '#1F7A4D' : p.state === 'invited' ? '#8A6A22' : '#4B585C';
  const label = p.state === 'joined' ? 'In the portal'
    : p.state === 'invited' ? 'Invited' : 'Not invited';
  // "Invite" the first time, "Send again" afterwards — the button says which.
  const action = p.hasAccount ? 'Email a sign-in link'
    : p.inviteCount > 0 ? 'Send the invitation again' : 'Invite to the portal';

  return (
    <div className="metrow" style={{ alignItems: 'flex-start' }}>
      <span className="k">Portal access</span>
      <span className="v" style={{ display: 'block' }}>
        <span style={{ fontWeight: 600, color: tone }}>{label}</span>
        <span style={{ color: '#141B22' }}>{' — '}{p.headline}</span>
        {p.detail && <div className="small" style={{ color: '#4B585C', marginTop: 2 }}>{p.detail}</div>}
        <div className="row" style={{ gap: 8, marginTop: 6, alignItems: 'center', flexWrap: 'wrap' }}>
          <button className="btn ghost small" onClick={invite} disabled={busy || !p.canInvite}
            title={p.canInvite ? '' : 'Add an email address to this profile first'}>
            {busy ? 'Sending…' : action}
          </button>
          {msg && <span className="small" style={{ color: '#1F7A4D' }}>{msg}</span>}
          {err && <span className="small" style={{ color: '#B3261E' }}>{err}</span>}
        </div>
      </span>
    </div>
  );
}

/* ------------------------------------------------- the card on the loan file --
   Self-loading: hand it a borrower id and it fetches that person's record, shows
   the identity at a glance, and opens the full editor in place. Rendered once for
   the borrower and once for the co-borrower, so BOTH people are editable from the
   file — which is the whole point of the request. */
export default function BorrowerProfilePanel({ borrowerId, heading = 'Borrower profile', onChanged }) {
  const [b, setB] = useState(null);
  const [err, setErr] = useState('');
  const [editing, setEditing] = useState(false);
  const [msg, setMsg] = useState('');

  const load = useCallback(() => {
    if (!borrowerId) return Promise.resolve();
    return api.staffBorrower(borrowerId).then(setB).catch(e => setErr(e.message || 'Could not load this profile'));
  }, [borrowerId]);
  useEffect(() => { setB(null); setErr(''); setEditing(false); load(); }, [borrowerId, load]);

  // A save refreshes THIS card and tells the file to refresh too — the name and
  // contact details it just changed are shown in half a dozen places up the page.
  const afterSave = useCallback(async () => {
    setEditing(false);
    setMsg('Saved ✓');
    setTimeout(() => setMsg(''), 3000);
    await load();
    if (onChanged) await onChanged();
  }, [load, onChanged]);

  if (!borrowerId) return null;
  const Row = ({ k, v }) => (<div className="metrow"><span className="k">{k}</span><span className="v">{v || '—'}</span></div>);

  return (
    <div className="panel" style={{ marginTop: 14 }}>
      <div className="row" style={{ alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <h3 style={{ margin: 0, color: '#141B22' }}>{heading}{b && fullName(b) ? ` — ${fullName(b)}` : ''}</h3>
        <div className="spacer" />
        {b && (
          <>
            <Link className="btn ghost small" to={`/internal/borrowers/${b.id}`}
              title="Open this person's full profile screen — their other files, entities, track record and documents">
              Open full profile ↗
            </Link>
            <button className="btn primary small" onClick={() => setEditing(v => !v)}
              title="Edit this person's own record — legal name, date of birth, contact details, home address, housing and employment">
              {editing ? 'Close editor' : 'Edit borrower profile'}
            </button>
          </>
        )}
      </div>
      {err && <div role="alert" className="notice err" style={{ marginTop: 8 }}>{err}</div>}
      {msg && <div className="notice ok" style={{ marginTop: 8 }}>{msg}</div>}
      {/* PILOT had to judge where this person's name splits — ask right here, where
          the record is edited, rather than only on the separate profile screen. */}
      {b && <div style={{ marginTop: 8 }}><NameSplitPrompt b={b} onChanged={afterSave} /></div>}
      {!b && !err && <div className="muted small" style={{ marginTop: 8 }}>Loading…</div>}
      {b && (editing ? (
        <div style={{ marginTop: 10 }}><BorrowerProfileForm b={b} onSaved={afterSave} onCancel={() => setEditing(false)} /></div>
      ) : (
        <div style={{ marginTop: 10 }}>
          <Row k="Legal name" v={fullName(b)} />
          <Row k="Email" v={b.email && !/@clickup\.local$/i.test(b.email) ? b.email : null} />
          <Row k="Cell phone" v={b.cell_phone} />
          <Row k="Date of birth" v={fmtDay(b.date_of_birth)} />
          <BorrowerSsnRow b={b} onChanged={afterSave} />
          <Row k="FICO" v={b.fico} />
          <Row k="Citizenship" v={b.citizenship} />
          <Row k="Marital status" v={b.marital_status} />
          <Row k="Home address" v={addrLine(b.current_address)} />
          <Row k="Mailing address" v={b.mailing_address ? addrLine(b.mailing_address) : 'same as home'} />
          <Row k="Housing" v={b.housing_status
            ? `${String(b.housing_status).replace(/_/g, ' ')}${b.housing_payment ? ` · ${money(b.housing_payment)}/mo` : ''}`
            : null} />
          <Row k="Employment" v={[b.employment_type, b.employer].filter(Boolean).join(' · ')} />
          <Row k="Dependents" v={b.dependents_count} />
          <PortalAccessRow b={b} onChanged={load} />
        </div>
      ))}
    </div>
  );
}
