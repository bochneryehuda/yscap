import React from 'react';

/* THE EXPERIENCE MATH, AT THE TOP OF THE TRACK RECORD (mega-workspace phase C,
   owner-directed 2026-08-09: "merge together … everything visible, nicely
   designed"). Three figures and a ladder, every number taken from the SERVER's
   own definitions — never recomputed here:

     Claimed  — the file's claim of record (requested_exp_*), what the loan is
                SIZED on (frozen 2026-07-14 rule).
     Verified — countBorrowersExperience(verifiedOnly) inside the frozen
                36-month window, via the track-record-todo endpoint.
     Needed   — experience.registeredExperienceNeed / shortfallOf — the SAME
                sentence the sign-off gate refuses with, so this header can
                never promise what the gate would refuse.

   The tier ladder repeats the tool's own thresholds VERBATIM (track-record.js:
   1 → Emerging, 3 → Experienced, 5 → Seasoned, 10 → Expert) over the VERIFIED
   in-window count — display math only, it writes nothing and gates nothing.
   The three verification checks stay ADVISORY per the owner's 2026-08-09
   decision ("Keep as is") — nothing here reads pillars. */

const INK = '#141B22';

function tierOf(qn) {
  if (qn >= 10) return { tier: 'Expert', next: '10+ qualifying exits — top tier.' };
  if (qn >= 5) return { tier: 'Seasoned', next: `${10 - qn} more verified ${10 - qn === 1 ? 'exit' : 'exits'} reaches Expert.` };
  if (qn >= 3) return { tier: 'Experienced', next: `${5 - qn} more reaches Seasoned.` };
  if (qn >= 1) return { tier: 'Emerging', next: `${3 - qn} more reaches Experienced.` };
  return { tier: 'New investor', next: 'The first verified exit inside 3 years starts the ladder.' };
}

const n0 = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
const trio = (o) => `${n0(o && o.flips)} flips · ${n0(o && o.holds)} holds · ${n0(o && o.ground)} ground-up`;

/* TWO LENSES (phase D): the LOAN FILE shows all three boxes — a claim and a
   sign-off requirement only exist on a file. The borrower PROFILE passes
   lens="borrower" and gets the one box that is about the PERSON: verified
   in-window counts + the tier ladder. */
export default function ExperienceHeader({ app, experience, findingsOpen, multiBorrower, lens = 'file' }) {
  // Claimed: the server's figure when the todo carried one, else the file's
  // own columns — the same value, read off the row already on screen.
  const claimed = (experience && experience.claimed) || {
    flips: n0(app && app.requested_exp_flips),
    holds: n0(app && app.requested_exp_holds),
    ground: n0(app && app.requested_exp_ground),
  };
  const verified = (experience && experience.verified) || null;
  const verifiedTotal = verified
    ? (Number.isFinite(Number(verified.total)) ? Number(verified.total)
      : n0(verified.flips) + n0(verified.holds) + n0(verified.ground))
    : null;
  const shortfall = (experience && experience.shortfall) || [];
  const claimedAny = n0(claimed.flips) + n0(claimed.holds) + n0(claimed.ground) > 0;
  const ladder = verifiedTotal == null ? null : tierOf(verifiedTotal);

  const ladderSub = ladder ? <><strong style={{ color: INK }}>{ladder.tier}</strong> · {ladder.next}</> : null;

  if (lens === 'borrower') {
    // The person, not a file: verified counts + the ladder, nothing that
    // presumes a claim or a sign-off gate.
    return (
      <div className="tr-stats">
        <div className="tr-stat">
          <span className="tr-eyebrow">Verified · last 3 years</span>
          <span className="tr-stat-v">{verified ? trio(verified) : '—'}</span>
          <span className="tr-stat-sub">{ladderSub || 'Only verified deals count toward experience.'}</span>
        </div>
      </div>
    );
  }

  return (
    <div className="tr-stats">
      <div className="tr-stat">
        <span className="tr-eyebrow">Claimed on this file</span>
        <span className="tr-stat-v">{claimedAny ? trio(claimed) : 'No experience claimed'}</span>
        <span className="tr-stat-sub">What the loan is sized on{multiBorrower ? ' — both borrowers, summed' : ''}.</span>
      </div>
      <div className="tr-stat">
        <span className="tr-eyebrow">Verified · last 3 years</span>
        <span className="tr-stat-v">{verified ? trio(verified) : '—'}</span>
        <span className="tr-stat-sub">{ladderSub || 'Only verified deals count.'}</span>
      </div>
      <div className={`tr-stat ${(findingsOpen || shortfall.length) ? 'flag' : (experience && !claimedAny ? '' : (experience ? 'met' : ''))}`}>
        <span className="tr-eyebrow">Still needed to sign off</span>
        {findingsOpen ? (
          <span className="tr-stat-v">Settle the {findingsOpen === 1 ? 'finding' : `${findingsOpen} findings`} above first</span>
        ) : !experience && claimedAny ? (
          /* A claim is on file but the server's math hasn't answered (still
             loading, or unreachable) — never assert "met" on silence. The
             server returns experience:null BY DESIGN only when nothing is
             claimed; with a claim, null means "don't know yet". */
          <span className="tr-stat-v">—</span>
        ) : shortfall.length ? (
          <span className="tr-stat-v">{shortfall.map((x) => (x && x.text) || String(x)).join(', ')}</span>
        ) : experience ? (
          /* Shortfall EMPTY decides "met" whether or not a product is
             registered — the gate signs off a fully-verified claim without
             one (2026-08-06); the registration is Products & Pricing's own
             condition, noted in the what's-left list below, never here. */
          <span className="tr-stat-v met">Requirement met ✓</span>
        ) : (
          <span className="tr-stat-v">Nothing — no experience required</span>
        )}
        <span className="tr-stat-sub">The same rule the experience condition&rsquo;s sign-off uses.</span>
      </div>
    </div>
  );
}
