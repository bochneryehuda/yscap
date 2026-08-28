'use strict';
/**
 * Orders — CC THE BORROWER'S HELPER (owner-directed 2026-08-28: "when you order
 * title and insurance and you have the option to CC the borrower, you should also
 * be able to have an option to CC the helper as well if there is a borrower helper
 * on file").
 *
 * A HELPER is the standing second login a borrower authorizes — `borrower_assistants`
 * (db/472), the person who "can do everything but not see the personal information and
 * not sign documents". On these files the helper is very often the person actually
 * talking to the title company.
 *
 * WHAT THIS PINS, and why each line is worth a test:
 *   1. THE COMPANY DEFAULT IS OFF for every order kind — the same standard the
 *      borrower's CC was tightened to on 2026-08-05. A helper joining a vendor
 *      thread must be somebody's decision, never a default nobody chose.
 *   2. THE TWO FOOTINGS ARE INDEPENDENT. This is the whole shape of the feature:
 *      CC'ing the borrower must not drag the helper on, and CC'ing the helper must
 *      not drag the borrower on. A single shared flag would have been the cheap way
 *      and it is exactly wrong — an officer asked for the helper on the chase while
 *      the borrower stays off it.
 *   3. A FILE WITH NO HELPER CANNOT CC ONE. The choice is inert, not wrong: no
 *      address exists, so nothing is added and nothing is invented.
 *   4. EACH ORDER KIND HAS ITS OWN OFFICER SETTING KEY, and both exist in
 *      lo-settings defaulting OFF — that is what the company default rests on.
 *   5. `helperEmails` is the ONE reading of "which addresses are the helpers'",
 *      shared by the recipients, the panel preview and the follow-up/reply
 *      "never" list — lower-cased and de-duplicated, so a helper cannot be on one
 *      surface and off another.
 *
 * PURE — no DB, no network. In `npm test`.
 */
const orders = require('../src/lib/orders');
const loSettings = require('../src/lib/lo-settings');

let failures = 0;
const ok = (c, m) => { console.log(`${c ? 'PASS' : 'FAIL'} ${m}`); if (!c) failures++; };

const HELPER = 'helper@example.com';
const HELPER2 = 'second.helper@example.com';
const BORROWER = 'borrower@example.com';
const CO = 'co@example.com';

const fileWith = (helpers) => ({
  appId: 'app-1',
  vendors: { insurance: { email: 'agent@ins.example' }, title: { email: 'agent@title.example' } },
  borrowerEmail: BORROWER,
  coBorrowerEmail: CO,
  helpers,
  officer: { email: 'lo@yscap.example' },
  processor: { email: 'proc@yscap.example' },
});
const oneHelper = fileWith([{ id: 'h1', name: 'Rivky', email: HELPER, forCoBorrower: false }]);
const noHelper = fileWith([]);

const hasHelper = (r) => r.cc.includes(HELPER);
const hasBorrower = (r) => r.cc.includes(BORROWER) || r.cc.includes(CO);

// ── 1. THE COMPANY DEFAULT IS OFF, on every kind ────────────────────────────
for (const kind of ['title', 'insurance']) {
  ok(orders.ccHelperDefault(kind, undefined) === false, `${kind}: default (no officer setting) → helper NOT CC'd`);
  ok(orders.ccHelperDefault(kind, false) === false, `${kind}: officer setting off → helper NOT CC'd`);
  ok(orders.ccHelperDefault(kind, true) === true, `${kind}: officer opted in → helper CC'd`);
  ok(orders.ccHelperDefault(kind, 'true') === false, `${kind}: only a real boolean true opts in (no truthy coercion)`);
  ok(!hasHelper(orders.recipientsFor(kind, oneHelper, {})), `${kind}: a helper on file is NOT copied unless somebody says so`);
  ok(hasHelper(orders.recipientsFor(kind, oneHelper, { ccHelper: true })), `${kind}: the per-order choice copies the helper`);
  ok(hasHelper(orders.recipientsFor(kind, oneHelper, { loHelperCcSetting: true })), `${kind}: the officer's own default copies the helper`);
  ok(!hasHelper(orders.recipientsFor(kind, oneHelper, { ccHelper: false, loHelperCcSetting: true })),
    `${kind}: an explicit "no" beats the officer's default`);
}

// ── 2. THE TWO FOOTINGS ARE INDEPENDENT — the point of the whole build ──────
{
  const helperOnly = orders.recipientsFor('title', oneHelper, { ccHelper: true, ccBorrower: false });
  ok(hasHelper(helperOnly) && !hasBorrower(helperOnly), 'helper ON + borrower OFF: only the helper is copied');
  const borrowerOnly = orders.recipientsFor('title', oneHelper, { ccHelper: false, ccBorrower: true });
  ok(!hasHelper(borrowerOnly) && hasBorrower(borrowerOnly), 'borrower ON + helper OFF: only the borrower is copied');
  const both = orders.recipientsFor('title', oneHelper, { ccHelper: true, ccBorrower: true });
  ok(hasHelper(both) && hasBorrower(both), 'both ON: both are copied');
  const neither = orders.recipientsFor('title', oneHelper, { ccHelper: false, ccBorrower: false });
  ok(!hasHelper(neither) && !hasBorrower(neither), 'both OFF: neither is copied');
  // And the officer's two defaults do not cross either.
  const dflt = orders.recipientsFor('title', oneHelper, { loCcSetting: true, loHelperCcSetting: false });
  ok(hasBorrower(dflt) && !hasHelper(dflt), 'the borrower default does not drag the helper on');
  const dflt2 = orders.recipientsFor('title', oneHelper, { loCcSetting: false, loHelperCcSetting: true });
  ok(hasHelper(dflt2) && !hasBorrower(dflt2), 'the helper default does not drag the borrower on');
}

// ── 3. NO HELPER ON FILE ⇒ NOTHING TO CC (the choice is inert, never invented) ─
{
  const r = orders.recipientsFor('title', noHelper, { ccHelper: true });
  ok(r.cc.length === orders.recipientsFor('title', noHelper, { ccHelper: false }).cc.length,
    'no helper on file: asking to CC one adds nobody');
  ok(!r.cc.includes(undefined) && !r.cc.includes('') && r.cc.every((e) => typeof e === 'string' && e),
    'no helper on file: no blank/undefined recipient is produced');
  // Missing / malformed helper rows are skipped rather than mailed to.
  const junk = fileWith([{ email: '' }, { email: null }, {}, { email: '   ' }]);
  ok(orders.recipientsFor('title', junk, { ccHelper: true }).cc.every((e) => e && e.includes('@')),
    'a helper row with no usable address is skipped, never sent to');
  const missing = { ...noHelper }; delete missing.helpers;
  ok(orders.recipientsFor('title', missing, { ccHelper: true }).cc.includes('lo@yscap.example'),
    'a data blob with no helpers key at all still builds its recipients');
}

// ── 4. EACH KIND HAS ITS OWN OFFICER KEY, both defaulting OFF ───────────────
ok(orders.ccHelperSettingKey('title') === 'ccHelperOnTitleOrder', 'title → ccHelperOnTitleOrder key');
ok(orders.ccHelperSettingKey('insurance') === 'ccHelperOnInsuranceOrder', 'insurance → ccHelperOnInsuranceOrder key');
ok(orders.ccHelperSettingKey('nonsense') === null, 'an unknown kind has no key (company default stands: off)');
ok(orders.ccHelperSettingKey('title') !== orders.ccBorrowerSettingKey('title'),
  'the helper key is NOT the borrower key — two settings, not one');
for (const k of ['ccHelperOnTitleOrder', 'ccHelperOnInsuranceOrder']) {
  ok(loSettings.SETTINGS_KEYS[k] && loSettings.SETTINGS_KEYS[k].default === false, `lo-settings ${k} exists and defaults false`);
  ok(loSettings.validate({ [k]: true }).ok === true, `${k} validates as a real setting`);
}

// ── 5. helperEmails — ONE reading, lower-cased and de-duplicated ────────────
{
  const dup = fileWith([
    { email: 'Helper@Example.com' },
    { email: 'helper@example.com' },
    { email: HELPER2 },
    { email: null },
  ]);
  const list = orders.helperEmails(dup);
  ok(list.length === 2, 'helperEmails de-duplicates case-insensitively (2 from 4 rows)');
  ok(list[0] === HELPER && list[1] === HELPER2, 'helperEmails lower-cases and keeps order');
  ok(orders.helperEmails(null).length === 0, 'helperEmails(null) is an empty list, never a throw');
  ok(orders.helperEmails({}).length === 0, 'helperEmails on a file with no helpers is an empty list');
  // The Cc actually built uses the SAME list — proven by comparison, not by eye.
  const cc = orders.recipientsFor('title', dup, { ccHelper: true }).cc;
  ok(list.every((e) => cc.includes(e)), 'every address helperEmails names is on the Cc when the helper is copied');
}

// ── 6. A helper who is ALSO the vendor address is not duplicated ────────────
{
  const clash = fileWith([{ email: 'agent@title.example' }]);
  const r = orders.recipientsFor('title', clash, { ccHelper: true });
  ok(!r.cc.includes('agent@title.example'), 'an address already on To is not repeated on Cc');
}

// ── 7. recipientsFor REPORTS the footing it used, so a caller can persist it ─
{
  ok(orders.recipientsFor('title', oneHelper, { ccHelper: true }).ccHelper === true, 'recipientsFor reports ccHelper true');
  ok(orders.recipientsFor('title', oneHelper, {}).ccHelper === false, 'recipientsFor reports ccHelper false when nothing opted in');
}

if (failures) { console.error(`\n${failures} FAILED`); process.exit(1); }
console.log('\nAll orders CC-helper checks passed.');
