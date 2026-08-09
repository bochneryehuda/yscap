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
const MUTED = '#4B585C';

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

  const box = { flex: '1 1 180px', minWidth: 160, padding: '8px 12px', borderRadius: 10, border: '1px solid rgba(127,169,176,.25)', background: '#fff' };
  const eyebrow = { display: 'block', fontSize: 11, letterSpacing: '.06em', textTransform: 'uppercase', color: MUTED };
  const big = { fontSize: 15, fontWeight: 650, color: INK };

  if (lens === 'borrower') {
    // The person, not a file: verified counts + the ladder, nothing that
    // presumes a claim or a sign-off gate.
    return (
      <div style={{ margin: '4px 0 12px' }}>
        <div className="row" style={{ gap: 10, flexWrap: 'wrap', alignItems: 'stretch' }}>
          <div style={box}>
            <span style={eyebrow}>Verified (last 3 years)</span>
            <span style={big}>{verified ? trio(verified) : '—'}</span>
            <div className="small" style={{ color: MUTED }}>
              {ladder ? <><strong style={{ color: INK }}>{ladder.tier}</strong> · {ladder.next}</> : 'Only verified deals count toward experience.'}
            </div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div style={{ margin: '4px 0 12px' }}>
      <div className="row" style={{ gap: 10, flexWrap: 'wrap', alignItems: 'stretch' }}>
        <div style={box}>
          <span style={eyebrow}>Claimed on this file</span>
          <span style={big}>{claimedAny ? trio(claimed) : 'No experience claimed'}</span>
          <div className="small" style={{ color: MUTED }}>What the loan is sized on{multiBorrower ? ' — both borrowers, summed' : ''}.</div>
        </div>
        <div style={box}>
          <span style={eyebrow}>Verified (last 3 years)</span>
          <span style={big}>{verified ? trio(verified) : '—'}</span>
          <div className="small" style={{ color: MUTED }}>
            {ladder ? <><strong style={{ color: INK }}>{ladder.tier}</strong> · {ladder.next}</> : 'Only verified deals count.'}
          </div>
        </div>
        <div style={{ ...box, borderColor: (findingsOpen || shortfall.length) ? 'var(--gold)' : 'rgba(47,127,134,.4)' }}>
          <span style={eyebrow}>Still needed to sign off</span>
          {findingsOpen ? (
            <span style={big}>Settle the {findingsOpen === 1 ? 'finding' : `${findingsOpen} findings`} above first</span>
          ) : !experience && claimedAny ? (
            /* A claim is on file but the server's math hasn't answered (still
               loading, or unreachable) — never assert "met" on silence. The
               server returns experience:null BY DESIGN only when nothing is
               claimed; with a claim, null means "don't know yet". */
            <span style={big}>—</span>
          ) : shortfall.length ? (
            <span style={big}>{shortfall.map((x) => (x && x.text) || String(x)).join(', ')}</span>
          ) : experience ? (
            /* Shortfall EMPTY decides "met" whether or not a product is
               registered — the gate signs off a fully-verified claim without
               one (2026-08-06); the registration is Products & Pricing's own
               condition, noted in the what's-left list below, never here. */
            <span style={{ ...big, color: 'var(--teal, #2F7F86)' }}>Requirement met ✓</span>
          ) : (
            <span style={big}>Nothing — no experience required</span>
          )}
          <div className="small" style={{ color: MUTED }}>The same rule the experience condition&rsquo;s sign-off uses.</div>
        </div>
      </div>
    </div>
  );
}
