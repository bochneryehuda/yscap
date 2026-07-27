'use strict';
/**
 * desk-findings — the note-buyer guideline overlay's unhappy items as findings in the ONE registry.
 *
 * WHAT THIS GUARDS (owner-reported 2026-07-27): the same guideline issue was on the screen three
 * times, in three different-looking cards. The merge only works if
 *   (a) every unhappy item becomes exactly ONE finding — including the two kinds the ai_suggestions
 *       bridge deliberately never forwarded, which would otherwise vanish when the panel's own list
 *       goes to the background, and
 *   (b) each finding carries the keys that let the AI panel recognize its own mirror of the SAME
 *       item (`isgKey` = the suggestion dedupe key, `templateCode` = the PILOT condition code).
 *       Without those the two sides key in different namespaces and can never collide — which is
 *       precisely why the old code-only dedupe could not see the duplicate.
 * Plus the non-negotiables: advisory (never blocks CTC) and never throws.
 *
 * Pure — no DB, no network.
 */

const assert = require('assert');
const { deskToFindings, SOURCE, _internals } = require('../src/lib/underwriting/investor-guidelines/desk-findings');
const { deskToSuggestions } = require('../src/lib/underwriting/investor-guidelines/desk-sync');

let n = 0;
const t = (name, fn) => { fn(); n += 1; console.log(`  ok ${name}`); };

console.log('desk-findings (pure)');

// ── never throws / empty inputs ──────────────────────────────────────────────
t('null / undefined / garbage desks return []', () => {
  for (const bad of [null, undefined, {}, { unhappy: null }, { unhappy: 'nope' }, 42, 'x', []]) {
    assert.deepStrictEqual(deskToFindings(bad), [], `expected [] for ${JSON.stringify(bad)}`);
  }
});

t('a HAPPY desk (no unhappy items) produces no findings', () => {
  assert.deepStrictEqual(deskToFindings({ happy: true, unhappy: [], verdicts: [{ cond_no: 1 }] }), []);
});

// ── the three forwarded flags ────────────────────────────────────────────────
const desk = {
  noteBuyer: { name: 'Blue Lake' },
  verdicts: [{ cond_no: 1 }],
  unhappy: [
    { cond_no: 2193, flag: 'coverage_gap', severity: 'fatal', name: 'Construction feasibility report',
      pilot_template_code: 'rtl_cond_feasibility', domain: 'construction_feasibility',
      required_evidence: 'A third-party feasibility report' },
    { cond_no: 3345, flag: 'conflict', severity: 'fatal', name: 'Rural property',
      pilot_template_code: 'rtl_cond_appraisaldocs', domain: 'appraisal',
      reason: 'The appraisal says Rural.', checks: [{ status: 'conflict', detail: 'Rural is not eligible' }] },
    { cond_no: 3333, flag: 'concern', severity: 'warning', name: 'Non-arms-length transaction',
      pilot_template_code: 'rtl_cond_nonarms', domain: 'non_arms_length', concern_field: 'party_collusion' },
  ],
};

t('every forwarded unhappy item becomes exactly one finding', () => {
  const f = deskToFindings(desk);
  assert.strictEqual(f.length, 3, `expected 3 findings, got ${f.length}`);
  assert.ok(f.every((x) => x.source === SOURCE));
  assert.ok(f.every((x) => x.category === 'investor_guideline'));
});

t('ONE finding per suggestion — the two sides never disagree on count or wording', () => {
  const sugs = deskToSuggestions(desk);
  const f = deskToFindings(desk);
  assert.strictEqual(f.length, sugs.length,
    'a forwarded item must map 1:1 — a drift here is the duplicate bug coming back');
  for (const s of sugs) {
    const match = f.find((x) => x.title === s.title);
    assert.ok(match, `no finding carries the suggestion's title: ${s.title}`);
    assert.strictEqual(match.howTo, s.body, 'the finding must reuse the suggestion wording verbatim');
    assert.strictEqual(match.severity, s.severity);
  }
});

t('each finding carries BOTH dedupe keys the AI panel needs to hide its mirror', () => {
  const sugs = deskToSuggestions(desk);
  const f = deskToFindings(desk);
  for (const s of sugs) {
    const match = f.find((x) => x.title === s.title);
    assert.strictEqual(match.isgKey, s.dedupeKey,
      'isgKey must equal the suggestion dedupe_key exactly, or the AI panel cannot match it');
    assert.strictEqual(match.templateCode, s.evidence.code,
      'templateCode must equal the suggestion evidence.code (an older row keys on that)');
  }
});

t('a coverage gap names the condition to post; a conflict / concern does not', () => {
  const f = deskToFindings(desk);
  const gap = f.find((x) => x.code.startsWith('isg_gap'));
  const conflict = f.find((x) => x.code.startsWith('isg_conflict'));
  const concern = f.find((x) => x.code.startsWith('isg_concern'));
  assert.strictEqual(gap.opensCondition, 'rtl_cond_feasibility');
  assert.strictEqual(conflict.opensCondition, undefined);
  assert.strictEqual(concern.opensCondition, undefined);
  // The buttons must agree with the sentence: you post/chase a gap, you correct or except a
  // conflict, you look at and clear a concern.
  assert.ok(gap.actions.includes('post_condition') && gap.actions.includes('request_document'));
  assert.ok(!gap.actions.includes('fix_file'), 'there is no value on the file to fix for a coverage gap');
  assert.ok(conflict.actions.includes('fix_file') && conflict.actions.includes('grant_exception'));
  assert.ok(concern.actions.includes('clear'));
});

// ── the two flags the suggestions bridge never forwarded ─────────────────────
t('info_missing and appraisal_review reach the list AND are dismissable (row, no email)', () => {
  const d = {
    noteBuyer: { name: 'CorrFirst' },
    verdicts: [{ cond_no: 1 }],
    unhappy: [
      { cond_no: 1009, flag: 'info_missing', severity: 'warning', name: 'Borrower email address',
        pilot_template_code: null, domain: 'contact', required_evidence: 'A working email address' },
      { cond_no: 3349, flag: 'appraisal_review', severity: 'fatal', name: 'Transferred appraisal',
        pilot_template_code: 'rtl_cond_appraisaldocs', domain: 'appraisal',
        reason: 'The appraisal names a different lender.' },
    ],
  };
  // They ARE forwarded now (post-merge audit 2026-07-27) — with `suppressNotify`, so the row exists
  // (a human's Dismiss can stick) but the team is not emailed. Before that they had no row at all,
  // which meant the desk re-raised them on every file view with nothing a staffer could click.
  const sugs = deskToSuggestions(d);
  assert.strictEqual(sugs.length, 2, 'both kinds now reach ai_suggestions');
  assert.ok(sugs.every((x) => x.suppressNotify === true),
    'they must carry suppressNotify — a fatal row without it emails the whole file team');
  const f = deskToFindings(d);
  assert.strictEqual(f.length, 2, 'both must still reach the ONE findings list');
  const info = f.find((x) => x.code.startsWith('isg_info_missing'));
  const appr = f.find((x) => x.code.startsWith('isg_appraisal_review'));
  assert.ok(info && appr);
  assert.strictEqual(info.severity, 'warning');
  assert.strictEqual(appr.severity, 'fatal');
  // They carry a real suggestion key now, which is what makes them actionable on the merged card.
  assert.strictEqual(info.isgKey, 'isg-info_missing:1009');
  assert.strictEqual(appr.isgKey, 'isg-appraisal_review:3349');
  assert.ok(info.howTo.includes('A working email address'), 'the required evidence must survive');
  assert.ok(appr.howTo.includes('different lender'), 'the desk reason must survive');
});

t('forwarded and non-forwarded flags coexist without colliding', () => {
  const d = {
    noteBuyer: { name: 'Blue Lake' },
    verdicts: [{ cond_no: 1 }],
    unhappy: [
      desk.unhappy[0],
      { cond_no: 1009, flag: 'info_missing', severity: 'warning', name: 'Borrower email address' },
    ],
  };
  const f = deskToFindings(d);
  assert.strictEqual(f.length, 2);
  assert.strictEqual(new Set(f.map((x) => x.code)).size, 2, 'codes must be distinct');
});

// ── the non-negotiables ──────────────────────────────────────────────────────
t('ADVISORY — no finding ever blocks clear-to-close, and none is resolvable-by-id', () => {
  const all = deskToFindings(desk).concat(deskToFindings({
    noteBuyer: { name: 'X' }, verdicts: [{ cond_no: 1 }],
    unhappy: [{ cond_no: 9, flag: 'appraisal_review', severity: 'fatal', name: 'Something' }],
  }));
  for (const f of all) {
    assert.strictEqual(f.blocksCtc, false, `${f.code} must not block CTC — the AI never blocks`);
    assert.strictEqual(f.id, undefined, `${f.code} must carry no stored id (it renders read-only)`);
    assert.ok(f.severity === 'fatal' || f.severity === 'warning');
    assert.ok(f.title && typeof f.title === 'string');
  }
});

t('an item with no cond_no is skipped rather than guessed at', () => {
  const f = deskToFindings({ noteBuyer: { name: 'X' }, verdicts: [{ cond_no: 1 }],
    unhappy: [{ flag: 'info_missing', severity: 'warning', name: 'No number' }] });
  assert.deepStrictEqual(f, []);
});

// ── the gaps the pre-merge audit named (2026-07-27) ──────────────────────────
t('the two non-forwarded flags get real, distinct action menus', () => {
  // Audit: only the gap/conflict/concern menus were asserted, so emptying either of these two
  // would have gone unnoticed — and an empty menu is a card with no buttons.
  const { ACTIONS_BY_FLAG } = _internals;
  for (const flag of ['info_missing', 'appraisal_review']) {
    const a = ACTIONS_BY_FLAG[flag];
    assert.ok(Array.isArray(a) && a.length >= 2, `${flag} must offer real actions, got ${JSON.stringify(a)}`);
    assert.ok(a.includes('dismiss'), `${flag} must always be dismissable`);
  }
  assert.ok(ACTIONS_BY_FLAG.info_missing.includes('fix_file'), 'an empty slot on the file is fixed on the file');
  assert.ok(ACTIONS_BY_FLAG.appraisal_review.includes('request_document'));
});

t('a file with NO note buyer still produces readable wording', () => {
  // Audit: `lender` is NULL on most real applications, so the no-note-buyer path is the COMMON case
  // and both fixtures above hid it by always setting a name.
  const d = {
    noteBuyer: {}, verdicts: [{ cond_no: 1 }],
    unhappy: [
      { cond_no: 2193, flag: 'coverage_gap', severity: 'fatal', name: 'Feasibility report', pilot_template_code: 'rtl_cond_feasibility' },
      { cond_no: 1009, flag: 'info_missing', severity: 'warning', name: 'Borrower email address' },
    ],
  };
  const f = deskToFindings(d);
  assert.strictEqual(f.length, 2);
  for (const x of f) {
    assert.ok(x.title.includes('the note buyer'), `expected the neutral fallback in: ${x.title}`);
    assert.ok(!/undefined|null|\[object/.test(x.title + x.howTo), `placeholder leaked into: ${x.title}`);
  }
});

t('two same-flag rules sharing a template code stay DISTINCT findings', () => {
  // Audit: keying the extra flags on the template code made two appraisal rules in one domain
  // produce an identical code AND an identical field — the whole dedupe key for a finding with no
  // document — so dedupeByClaim would have merged them and one would vanish with no trace.
  const d = {
    noteBuyer: { name: 'Blue Lake' }, verdicts: [{ cond_no: 1 }],
    unhappy: [
      { cond_no: 3345, flag: 'appraisal_review', severity: 'warning', name: 'Rural property',
        pilot_template_code: 'rtl_cond_appraisaldocs', domain: 'appraisal' },
      { cond_no: 3349, flag: 'appraisal_review', severity: 'fatal', name: 'Transferred appraisal',
        pilot_template_code: 'rtl_cond_appraisaldocs', domain: 'appraisal' },
    ],
  };
  const f = deskToFindings(d);
  assert.strictEqual(f.length, 2);
  assert.strictEqual(new Set(f.map((x) => x.code)).size, 2,
    `both rules produced the same code (${f.map((x) => x.code).join(', ')}) — one would be deduped away`);
});

t('record() actually HONOURS suppressNotify — the flag is not decorative', () => {
  // The whole reason these two kinds were held out of ai_suggestions was the fatal-notify fan-out.
  // Forwarding them is only safe because `record()` skips that fan-out when asked. If someone drops
  // the guard, every empty-file-slot and appraisal-read item starts emailing the file team — the
  // 298-send failure, re-armed. Asserted against the source because the notify is a `setImmediate`
  // side effect with no return value to observe.
  const src = require('fs').readFileSync(
    require('path').resolve(__dirname, '../src/lib/underwriting/ai-suggestions.js'), 'utf8');
  const guard = /if\s*\(\s*String\(s\.severity[^)]*\)[^{]*!s\.suppressNotify\s*\)/;
  assert.ok(guard.test(src),
    'ai-suggestions.record must gate the fatal notify on !s.suppressNotify');
});

t('codeOf produces a stable, safe finding code', () => {
  const { codeOf } = _internals;
  assert.strictEqual(codeOf('isg-gap:rtl_cond_feasibility'), 'isg_gap_rtl_cond_feasibility');
  assert.strictEqual(codeOf('isg-conflict:3345'), 'isg_conflict_3345');
  assert.strictEqual(codeOf(''), 'isg_guideline');
  assert.strictEqual(codeOf(null), 'isg_guideline');
  assert.strictEqual(codeOf('!!!'), 'isg_guideline');
  assert.ok(/^[a-z0-9_]+$/.test(codeOf('Weird — Key: 12')), 'a code must be lowercase word chars only');
});

console.log(`\n${n} checks passed.`);
