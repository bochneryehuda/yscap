/**
 * A KEY SET UNDER A NAME WE ACCEPT IS *SET* ON THE HEALTH SCREEN TOO.
 *
 * `lib/usps-env` reads the USPS credential under any of the names USPS itself uses
 * ("Client ID" on one portal screen, "Consumer Key" on another). The API Health
 * screen's environment chips checked only the CANONICAL name — so a connector that
 * authenticates perfectly rendered a red "required — not set" chip, and the
 * screen's own missing-required count claimed a key was absent that is right there
 * and working. That is the exact "not connected / connected under another name"
 * ambiguity the alternate-name reader exists to remove, moved one screen over —
 * onto the ONE page somebody opens to answer that question.
 *
 * Three behaviours, and the third is the one that keeps it honest:
 *   1. An alternate name satisfies the chip.
 *   2. The chip SAYS which name carried it — a name, never a value.
 *   3. It still reports NOT SET when the credential genuinely is not there. A chip
 *      that always says "set" is worse than the bug it replaced.
 *
 * Pure — no DB, no network, no probe. Run: node scripts/test-env-alias-chip-pure.js
 */
'use strict';

const H = require('../src/lib/integrations/health-registry');
const USPS = require('../src/lib/usps-env');
const { envPresence } = H._internals;

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) pass++; else { fail++; console.log(`FAIL ${m}`); } };
const NEVER = 'sk_live_do_not_print_me';

/* The registry reads process.env at call time. Other suites share this process in
   `npm test`, so every USPS name is saved and restored. */
const NAMES = [...USPS.ID_NAMES, ...USPS.SECRET_NAMES, ...USPS.WEB_TOOLS_NAMES];
const SAVED = {};
for (const n of NAMES) SAVED[n] = process.env[n];
const setEnv = (o) => {
  for (const n of NAMES) delete process.env[n];
  for (const [k, v] of Object.entries(o)) process.env[k] = v;
};

/** The connector's own two chips, exactly as the screen would render them. */
const uspsChips = () => {
  const entry = H.INTEGRATIONS.find((i) => i.key === 'usps');
  return (entry.env || []).map((e) => ({ name: e.name, required: !!e.required, ...envPresence(e) }));
};

try {
  // ---- A. THE REGISTRY USES THE READER'S OWN LISTS --------------------
  // Not a second copy here: a copy would drift, and the drift is invisible — the
  // screen would go on saying "not set" about a name the reader is happily using.
  {
    const entry = H.INTEGRATIONS.find((i) => i.key === 'usps');
    const id = entry.env.find((e) => e.name === USPS.ID_NAMES[0]);
    const sec = entry.env.find((e) => e.name === USPS.SECRET_NAMES[0]);
    ok(!!id && !!sec, 'the USPS connector lists its two credentials, under the documented names');
    ok(id && String(id.alsoAccepts) === String(USPS.ID_NAMES.slice(1)),
      'and the id chip accepts exactly the alternates the reader accepts');
    ok(sec && String(sec.alsoAccepts) === String(USPS.SECRET_NAMES.slice(1)),
      'and so does the secret chip');
    ok(USPS.ID_NAMES.length > 1, 'there are real alternates to accept (a guard against an empty list passing)');
  }

  // ---- B. NOTHING SET still reads NOT SET -----------------------------
  setEnv({});
  {
    const c = uspsChips();
    ok(c.every((e) => e.set === false && e.required === true),
      'with nothing set, both read as REQUIRED and NOT SET — the chip never flatters');
    ok(c.every((e) => !e.setAs), 'and nothing claims to have been carried by another name');
  }

  // ---- C. THE CANONICAL NAME is unchanged -----------------------------
  setEnv({ USPS_CLIENT_ID: 'id', USPS_CLIENT_SECRET: 'sec' });
  {
    const c = uspsChips();
    ok(c.every((e) => e.set === true), 'the documented names still read as set');
    ok(c.every((e) => e.setAs === null), 'and say nothing extra — there is no other name to report');
  }

  // ---- D. THE ALTERNATE — the whole point -----------------------------
  setEnv({ USPS_CONSUMER_KEY: 'id', USPS_CONSUMER_SECRET: 'sec' });
  {
    const c = uspsChips();
    ok(c.every((e) => e.set === true),
      'a key under the name USPS prints on its own portal reads as SET, not as a missing requirement');
    const id = c.find((e) => e.name === 'USPS_CLIENT_ID');
    const sec = c.find((e) => e.name === 'USPS_CLIENT_SECRET');
    ok(id.setAs === 'USPS_CONSUMER_KEY', `and says which name carried it (${id.setAs})`);
    ok(sec.setAs === 'USPS_CONSUMER_SECRET', 'for the secret too');
    // This is the number the owner reads first on the card.
    ok(c.filter((e) => e.required && !e.set).length === 0,
      'so the screen reports NOTHING missing on a connector that is fully configured');
  }

  // ---- E. HALF SET is still half set ----------------------------------
  setEnv({ USPS_API_KEY: 'id' });
  {
    const c = uspsChips();
    const id = c.find((e) => e.name === 'USPS_CLIENT_ID');
    const sec = c.find((e) => e.name === 'USPS_CLIENT_SECRET');
    ok(id.set === true && id.setAs === 'USPS_API_KEY', 'one half under an alternate is set');
    ok(sec.set === false && !sec.setAs, 'and the missing half is STILL reported missing');
  }

  // ---- F. PRIORITY — the canonical name wins ---------------------------
  setEnv({ USPS_CLIENT_ID: 'canonical', USPS_CONSUMER_KEY: 'alternate', USPS_CLIENT_SECRET: 's' });
  {
    const id = uspsChips().find((e) => e.name === 'USPS_CLIENT_ID');
    ok(id.set === true && id.setAs === null,
      'with both set the canonical name wins and nothing extra is claimed — matching the reader');
  }

  // ---- G. A VALUE NEVER APPEARS, under any name ------------------------
  setEnv({ USPS_CONSUMER_KEY: NEVER, USPS_CONSUMER_SECRET: NEVER });
  {
    ok(!JSON.stringify(uspsChips()).includes(NEVER),
      'the environment chips carry variable NAMES only — never a credential value');
  }

  // ---- H. A WEB TOOLS ID IS NOT AN OAUTH CLIENT ------------------------
  // usps-env deliberately refuses to alias it (a key for a different, older API), so
  // the chip must not quietly accept it either — a screen saying "set" while the
  // connector says "not connected" is the disagreement this whole change removes.
  setEnv({ USPS_USERID: '123ABC456' });
  {
    ok(uspsChips().every((e) => e.set === false),
      'a Web Tools user id does not satisfy the OAuth client chip — it is a key for another service');
  }

  // ---- I. AN ENTRY WITH NO ALTERNATES IS UNTOUCHED ---------------------
  // Every other connector in the registry must behave exactly as before.
  {
    process.env.__ALIAS_TEST_ONLY = 'x';
    ok(envPresence({ name: '__ALIAS_TEST_ONLY' }).set === true, 'a plain entry with no alternates still reads set');
    ok(envPresence({ name: '__ALIAS_TEST_ONLY' }).setAs === null, 'and reports no other name');
    delete process.env.__ALIAS_TEST_ONLY;
    ok(envPresence({ name: '__ALIAS_TEST_ONLY' }).set === false, 'and not set once it is gone');
    ok(envPresence({ name: '__ALIAS_TEST_ONLY', alsoAccepts: [] }).set === false, 'an empty alternates list changes nothing');
  }
} catch (e) {
  console.error(e);
  fail++;
} finally {
  for (const n of NAMES) {
    if (SAVED[n] === undefined) delete process.env[n]; else process.env[n] = SAVED[n];
  }
}

console.log(`\ntest-env-alias-chip-pure: ${pass} passed${fail ? `, ${fail} FAILED` : ''}`);
process.exit(fail ? 1 : 0);
