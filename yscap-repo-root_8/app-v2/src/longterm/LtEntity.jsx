import React, { useCallback, useMemo, useState } from 'react';
import { ltApi } from './api.js';
import { GOLD_TEXT } from './ppeStyles.js';
import { askConfirm, askPrompt } from '../lib/dialog.js';
import LlcManager from '../components/LlcManager.jsx';

/**
 * THE ENTITY SECTION, ON A LONG-TERM FILE — THE SAME ONE.
 *
 * Owner-directed 2026-08-31: *"I think you're missing the entire entity section
 * that we were officially needing to bring in from the RTL side. The logic
 * should work the same: the exact entity section, same exact form information to
 * type in an entity section. The exact verification workflow. The entity section
 * should be directly linked to the profile. The exact document slots and
 * bi-directional … We can choose corporations and stuff like that. We can set
 * who owns it, percentages, and layered entities. Bring in the entire logic …
 * Don't reinvent."*
 *
 * ── WHAT IS ACTUALLY IN THIS FILE ───────────────────────────────────────────
 *
 * Almost nothing, and that is the point. The form, the entity-type picker, the
 * partnership and trust sub-kinds, the ownership rows with their percentages,
 * the signature titles, a corporation's shares and certificate numbers, the
 * three document slots with their drag-and-drop, preview and download, and the
 * LAYERED-ENTITY recursion are all `components/LlcManager.jsx` — the same
 * component the short-term file screen and the borrower's own profile render.
 * What is here is the ADAPTER that points its calls at `/api/lt/*`, the
 * verify/revoke control, and the one thing that is genuinely this product's: the
 * step that puts the company on the borrower's profile in the first place.
 *
 * ── IT IS THE SAME COMPANY, NOT A COPY OF ONE ───────────────────────────────
 *
 * `llcs` is a BORROWER's record, not a file's, and the identity is shared
 * between the two products (the login, the person, the roster). So a company
 * documented from a long-term file IS the company a short-term file will find
 * already documented, and the reverse — which is the owner's *"bi-directional"*
 * and *"pre-filled entity section with the pre-filled information and pre-filled
 * documents"*. Nothing here copies a document anywhere: an entity document is
 * filed against the company with no file owner at all, which is what makes ONE
 * operating agreement follow it to every loan it vests.
 *
 * ── DARK TEXT ON WHITE, ALWAYS ──────────────────────────────────────────────
 *
 * Explicit hexes, never an `--ink*` token — those are LIGHT paper colours in
 * this palette and render white-on-white.
 */

const INK = '#141B22';
const MUTED = '#4B585C';
const LINE = '#E6E1D6';
const RED = '#8A2D2D';

const eyebrow = {
  fontSize: 11, letterSpacing: '.06em', textTransform: 'uppercase',
  color: GOLD_TEXT, fontWeight: 700, marginBottom: 6,
};
const btn = (on) => ({
  font: 'inherit', fontSize: 13, fontWeight: 600, cursor: 'pointer',
  padding: '6px 10px', borderRadius: 6,
  border: `1px solid ${on ? GOLD_TEXT : LINE}`,
  background: on ? '#FDF8EC' : '#FFFFFF',
  color: INK,
});

export default function LtEntity({ loanId, entityName, profile, note, onChanged, coBorrower = null }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const [msg, setMsg] = useState(null);
  // The shared component reloads itself; this only forces a remount when the
  // company underneath changes identity (it is put on the profile for the first
  // time), so an open form is never yanked out from under somebody mid-edit.
  const llcId = profile && profile.llcId ? String(profile.llcId) : null;

  const flash = (t) => { setMsg(t); setTimeout(() => setMsg(null), 4000); };

  /* THE ADAPTER — the whole of this product's half of the entity section.
     Every rule behind these five calls lives in `src/lib/llc-edit.js`, which the
     short-term routes call too, so "may this be edited", "does the ownership add
     up", "who may verify" and "what does a revoke do to the companies
     underneath" have ONE answer for both products.

     `upload` takes the company off the body rather than closing over one: the
     shared component renders a whole ownership CHAIN from this single adapter,
     so a nested owner's slot must file against ITS OWN company. `download` is
     the same problem from the other side, which is why the server derives the
     company from the document there. */
  const adapter = useMemo(() => ({
    get: (id) => ltApi.entityGet(loanId, id),
    update: (id, b) => ltApi.entitySave(loanId, id, b),
    members: (id, m) => ltApi.entityMembers(loanId, id, m),
    upload: (b) => ltApi.entityDocUpload(loanId, b.llcId, b.checklistItemId, b),
    download: (documentId) => ltApi.entityDocBlob(loanId, documentId),
  }), [loanId]);

  const saveToProfile = useCallback(async () => {
    setBusy(true); setErr(null);
    try {
      await ltApi.vestingEntityToProfile(loanId);
      flash('Saved to the borrower’s profile ✓');
      if (onChanged) await onChanged();
    } catch (e) {
      setErr((e && (e.error || e.message)) || 'That could not be saved.');
    } finally { setBusy(false); }
  }, [loanId, onChanged]);

  /* VERIFY AND REVOKE — the short-term wording, deliberately, because it is the
     same act on the same record: verifying satisfies the entity condition on
     every open file vesting in this company, on BOTH products, and revoking
     reopens them and cascades down the ownership chain. A revoke REQUIRES a
     reason because the borrower is told why. */
  const setVerified = useCallback(async (verified) => {
    if (busy) return;
    let reason;
    if (!verified) {
      reason = await askPrompt('Revoke verification of this company? The entity condition reopens on every open file vesting in it, and the borrower is notified. Reason (the borrower is told why — required):');
      if (reason === null || !reason.trim()) return;
    } else if (!(await askConfirm(`Mark "${entityName || 'this company'}" as verified? The entity condition on every open file vesting in it is satisfied and signed off automatically.`))) {
      return;
    }
    setBusy(true); setErr(null);
    try {
      await ltApi.entityVerify(loanId, llcId,
        verified ? { verified: true } : { verified: false, reason: reason.trim() });
      flash(verified ? 'Company verified ✓ — linked files updated.' : 'Verification revoked — linked files reopened.');
      if (onChanged) await onChanged();
    } catch (e) {
      // THE SERVER'S OWN WORDS, and its own LIST when it has one: "not ready to
      // verify" is only useful if it says what is still missing.
      const missing = e && e.data && Array.isArray(e.data.missing) ? e.data.missing : null;
      setErr(missing && missing.length
        ? `Not ready to verify: ${missing.join(' · ')}`
        : ((e && (e.error || e.message)) || 'Could not update the company.'));
    } finally { setBusy(false); }
  }, [busy, entityName, llcId, loanId, onChanged]);

  return (
    <div>
      <div style={eyebrow}>On the borrower’s profile</div>

      {/* AN UNREADABLE PROFILE IS NOT "NOTHING ON FILE". Saying the second when
          the first is true would ask a borrower for documents they already sent. */}
      {profile && profile.unreadable && (
        <p style={{ margin: 0, fontSize: 13, color: RED, lineHeight: 1.55 }}>{profile.why}</p>
      )}

      {profile && !profile.unreadable && !profile.found && (
        <div>
          <p style={{ margin: 0, fontSize: 13, color: MUTED, lineHeight: 1.55 }}>
            {entityName
              ? `${entityName} is not on this borrower’s profile yet. Save it there and its documents live on the profile — so the next loan for the same company starts already done.`
              : 'This loan has no vesting company recorded yet. It comes from Encompass once somebody enters it.'}
          </p>
          {entityName && (
            <button
              type="button" disabled={busy}
              style={{ ...btn(true), marginTop: 10, opacity: busy ? 0.5 : 1 }}
              onClick={saveToProfile}>
              {busy ? 'Saving…' : 'Save this company to the borrower’s profile'}
            </button>
          )}
        </div>
      )}

      {profile && !profile.unreadable && profile.found && llcId && (
        <div>
          <p style={{ margin: '0 0 10px', fontSize: 13, color: INK, lineHeight: 1.55 }}>
            <strong>{entityName}</strong> is on this borrower’s profile
            {profile.verified ? ' and verified.' : ', not yet verified.'}
            {' '}Anything entered here is the borrower’s own record — it is already there on their
            other files, on both products, and stays there for the next one.
          </p>

          {/* THE SHARED SECTION. Same component, same form, same slots, same
              layered-entity recursion as the short-term file screen — pointed at
              this product's doors by the adapter, and nothing else changed. */}
          {/* KEYED ON THE LOCK STATE TOO (owner-reported 2026-09-02: *"I clicked
              on revoke verification. I tried editing, and it didn't work."*).
              The shared section reads `is_verified` off its own load and its
              reload effect is keyed on the company id alone — so a revoke made
              from THIS control lifted the lock on the server and left the form
              greyed until the page was reloaded. Remounting it when the lock
              flips is the honest fix: the form re-reads the company and unlocks
              on the spot. Nothing is in flight to lose — the verify/revoke
              buttons sit outside the form, and a revoke asks for a reason first. */}
          <LlcManager
            key={`${llcId}:${profile.verified ? 'locked' : 'open'}`}
            llcId={llcId}
            staff
            compactHeader
            adapter={adapter}
            coBorrower={coBorrower}
            onChanged={onChanged} />

          {/* UNLOCK → EDIT → LOCK (owner-directed 2026-09-02: *"Everything was
              locked. It needs to have an option to unlock, make the edits, and
              then lock again."*). The two acts are the short-term ones — a
              revoke and a verify — under the names that say what they do to
              the form: while the company is verified its type, its details,
              its owners and its documents are all locked; unlocking is a revoke
              (with a reason, because the borrower is told), and locking again is
              marking it verified, which satisfies the condition on every file. */}
          <div className="row" style={{ gap: 8, alignItems: 'center', marginTop: 12, flexWrap: 'wrap' }}>
            {profile.verified
              ? (
                <button type="button" disabled={busy} style={{ ...btn(false), opacity: busy ? 0.5 : 1 }}
                  title="Revokes the verification so the entity type, details, owners and documents can be changed. A reason is asked for — the borrower is told why."
                  onClick={() => setVerified(false)}>
                  {busy ? 'Working…' : '🔓 Unlock to edit (revoke verification)'}
                </button>
              )
              : (
                <button type="button" disabled={busy} style={{ ...btn(true), opacity: busy ? 0.5 : 1 }}
                  title="Marks the company verified: the section locks again and the entity condition is satisfied on every open file vesting in it."
                  onClick={() => setVerified(true)}>
                  {busy ? 'Working…' : '🔒 Lock & mark verified'}
                </button>
              )}
            <span style={{ fontSize: 12, color: MUTED, lineHeight: 1.5 }}>
              {profile.verified
                ? 'Verified, so its entity type, details, owners and documents are locked. Unlock to edit, make the change, then lock it again.'
                : 'Unlocked — the entity type, details, owners and documents above can be edited. Locking (verifying) satisfies the entity condition on every open file vesting in this company.'}
            </span>
          </div>

          {/* THE SAME COMPANY, ON THE BORROWER'S OWN PAGE. It is one `llcs` row
              wherever it is edited — here, on a short-term file, or on the
              profile — so this is a door to the same record, not a copy of it. */}
          {profile.borrowerId && (
            <p style={{ margin: '8px 0 0', fontSize: 12, color: MUTED, lineHeight: 1.5 }}>
              This is the borrower’s own record. It can also be edited on their profile:{' '}
              <a href={`#/internal/borrowers/${encodeURIComponent(profile.borrowerId)}`} target="_blank" rel="noreferrer"
                style={{ color: GOLD_TEXT, fontWeight: 600 }}>
                open the borrower’s profile ↗
              </a>
            </p>
          )}

          {note && (
            <p style={{ margin: '8px 0 0', fontSize: 12, color: MUTED, lineHeight: 1.5 }}>{note}</p>
          )}
        </div>
      )}

      {msg && <p style={{ margin: '8px 0 0', fontSize: 13, color: INK, lineHeight: 1.55 }}>{msg}</p>}
      {err && <p role="alert" style={{ margin: '8px 0 0', fontSize: 13, color: RED, lineHeight: 1.55 }}>{err}</p>}
    </div>
  );
}
