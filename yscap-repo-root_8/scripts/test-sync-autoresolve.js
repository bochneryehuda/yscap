/* Unit tests for the cross-system auto-resolution engine
 * (src/lib/sync-autoresolve.js — owner-directed 2026-07-15 evening).
 * Pure decision function only — no DB / network. Each case maps to a real
 * incident from the 2026-07-14/15 ClickUp data investigations.
 * Run: node scripts/test-sync-autoresolve.js */
const { decideDob, isArtifactDay } = require('../src/lib/sync-autoresolve');

let pass = 0, fail = 0;
const eq = (name, got, exp) => {
  const g = JSON.stringify(got), e = JSON.stringify(exp);
  if (g === e) { pass++; } else { fail++; console.log(`FAIL ${name}: got ${g} expected ${e}`); }
};

// ---- artifact detection ------------------------------------------------------
eq('artifact: typed 2-digit year (0095)', isArtifactDay('0095-10-19'), true);
eq('artifact: typed 26', isArtifactDay('0026-11-19'), true);
eq('artifact: normal adult DOB is not', isArtifactDay('1995-10-19'), false);
eq('artifact: toddler DOB is not (implausible, not artifact)', isArtifactDay('2022-12-11'), false);
eq('artifact: pure garbage is not', isArtifactDay('0203-01-01'), false);

// ---- agree: same day, any storage form ---------------------------------------
eq('agree: identical', decideDob({ clickupDay: '1995-10-19', portalDay: '1995-10-19' }),
   { outcome: 'agree', value: '1995-10-19' });
eq('agree: ClickUp artifact pivots to the SAME day as the portal',
   decideDob({ clickupDay: '0095-10-19', portalDay: '1995-10-19' }),
   { outcome: 'agree', value: '1995-10-19' });
eq('agree: both blank', decideDob({ clickupDay: null, portalDay: null }), { outcome: 'agree', value: null });

// ---- one side blank → the other fills ----------------------------------------
eq('adopt: portal blank, ClickUp plausible',
   decideDob({ clickupDay: '1972-02-24', portalDay: null }),
   { outcome: 'adopt', value: '1972-02-24', winner: 'clickup', why: 'portal_blank' });
eq('adopt: ClickUp blank, portal plausible',
   decideDob({ clickupDay: null, portalDay: '1988-12-03' }),
   { outcome: 'adopt', value: '1988-12-03', winner: 'portal', why: 'clickup_blank' });

// ---- plausibility beats impossibility (the Shloimy Breuer class) --------------
eq('adopt: portal toddler (2022) loses to plausible ClickUp (2002)',
   decideDob({ clickupDay: '2002-12-11', portalDay: '2022-12-11' }),
   { outcome: 'adopt', value: '2002-12-11', winner: 'clickup', why: 'portal_value_implausible' });
eq('adopt: ClickUp garbage loses to plausible portal',
   decideDob({ clickupDay: '0203-01-01', portalDay: '1983-02-23' }),
   { outcome: 'adopt', value: '1983-02-23', winner: 'portal', why: 'clickup_value_implausible' });

// ---- provenance rule (the Shaindel Schwimmer class) ----------------------------
eq('adopt: ClickUp typed artifact beats a SYNC-DERIVED portal profile',
   decideDob({ clickupDay: '0095-10-19', portalDay: '1996-11-19', portalOrigin: 'clickup_backfill' }),
   { outcome: 'adopt', value: '1995-10-19', winner: 'clickup', why: 'typed_artifact_beats_sync_derived_profile' });
eq('review: same artifact but the portal value has HUMAN provenance',
   decideDob({ clickupDay: '0095-10-19', portalDay: '1996-11-19', portalOrigin: null }).outcome, 'review');
eq('review: same artifact, portal origin explicitly human',
   decideDob({ clickupDay: '0095-10-19', portalDay: '1996-11-19', portalOrigin: 'portal' }).outcome, 'review');

// ---- genuine ambiguity → review (the Moshe Friedman class) ---------------------
eq('review: two plausible adult DOBs that differ',
   decideDob({ clickupDay: '1983-02-23', portalDay: '1986-02-23', portalOrigin: 'clickup_backfill' }).outcome, 'review');
eq('adopt: resolvable ClickUp artifact (0072→1972) beats a toddler portal value',
   decideDob({ clickupDay: '0072-02-24', portalDay: '2022-12-11' }),
   { outcome: 'adopt', value: '1972-02-24', winner: 'clickup', why: 'portal_value_implausible' });
eq('review: both sides truly unresolvable → review with no proposal',
   decideDob({ clickupDay: '0203-01-01', portalDay: '2022-12-11' }),
   { outcome: 'review', proposal: null });

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
