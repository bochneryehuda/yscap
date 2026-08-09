'use strict';
/**
 * DRAW SETTINGS — three levels, and WHICH ONE WON (owner-directed 2026-08-09). No DB, no network.
 *
 * The settings were in three places with nothing anywhere saying which one decided the answer in
 * front of you, so a $250 draw fee on one file and $299 on the next looked arbitrary and several
 * knobs were unreachable without a database edit. These assertions pin the parts that make the
 * answer trustworthy:
 *   - most specific wins, and the level is REPORTED;
 *   - ZERO and FALSE are real answers, not "unset" (the trap that would silently restore a default
 *     the moment somebody deliberately turned something off);
 *   - a value a knob does not allow is IGNORED rather than honoured;
 *   - every knob is settable somewhere, carries plain wording, and an advisory one says so.
 */
const assert = require('assert');
const DS = require('../src/sitewire/draw-settings');

let n = 0;
const ok = (cond, what) => { assert.ok(cond, what); n++; };
// Deep-compares via JSON so a two-value assertion ([value, level]) reads as one statement —
// assert.strictEqual on two arrays compares references and would fail on identical contents.
const eq = (a, b, what) => { assert.strictEqual(JSON.stringify(a), JSON.stringify(b), `${what} (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`); n++; };

const one = (key, sources) => DS.resolveOne(DS.BY_KEY[key], sources);

// ─────────────────────────────────────────────── A. the catalog is the one description
ok(DS.CATALOG.length >= 20, 'A1 the catalog covers the draw settings, not a handful');
for (const e of DS.CATALOG) {
  ok(e.key && e.label && e.help, `A2 "${e.key}" carries a name, plain wording and an explanation`);
  ok(e.company || e.rule || e.project, `A3 "${e.key}" is settable at at least one level`);
  ok(typeof e.type === 'string', `A4 "${e.key}" declares how to read it`);
  if (e.type === 'choice') ok(Array.isArray(e.choices) && e.choices.length, `A5 "${e.key}" lists its choices`);
  ok(!/\bmust\b.*refus|blocked/i.test(e.help) || !e.advisory, `A6 "${e.key}" does not describe an advisory knob as a refusal`);
}
ok(DS.CATALOG.some((e) => e.advisory), 'A7 some knobs are advisory-only');
ok(DS.CATALOG.filter((e) => e.advisory).every((e) => /never refuse|warn|shown|flag|used by|expected/i.test(e.help)),
  'A8 every advisory knob says in words that it only warns');
eq(new Set(DS.CATALOG.map((e) => e.key)).size, DS.CATALOG.length, 'A9 no key appears twice');

// ─────────────────────────────────────────────── B. most specific wins, and it says which
{
  const r = one('retainage_pct', { company: { retainage_pct: 10 }, project: { retainage_pct: 5 } });
  eq(r.value, 5, 'B1 the project beats the company default');
  eq(r.level, 'project', 'B2 …and says so');
  eq(r.levelLabel, DS.LEVEL_LABEL.project, 'B3 …in words a person reads');
  eq(r.levels.company, 10, 'B4 the levels it did NOT use are still reported, so a screen shows all three');
}
{
  const r = one('investor_funding_mode', {
    company: { investor_funding_mode_default: 'reimbursement' },
    rule: { investor_funding_mode: 'manual' },
  });
  eq([r.value, r.level], ['manual', 'capital_provider'], 'B5 the capital provider beats the company default');
}
{
  const r = one('wire_turnaround_hours', {});
  eq([r.value, r.level], [48, 'none'], 'B6 nothing anywhere lands on the built-in fallback');
  eq(r.levelLabel, DS.LEVEL_LABEL.none, 'B7 …and says that too, rather than pretending somebody set it');
}

// ─────────────────────────────────────────────── C. ZERO and FALSE are real answers
// This is the trap: treating them as "unset" silently restores a default the moment somebody
// deliberately turns something off — a 0% retainage would quietly become the company's 10%.
{
  const r = one('retainage_pct', { company: { retainage_pct: 10 }, project: { retainage_pct: 0 } });
  eq([r.value, r.level], [0, 'project'], 'C1 a deliberate 0 is honoured, not read as "unset"');
}
{
  const r = one('require_lien_waivers', { company: { require_lien_waivers: true }, project: { require_lien_waivers: false } });
  eq([r.value, r.level], [false, 'project'], 'C2 a deliberate "off" is honoured too');
}
{
  const r = one('min_draw_cents', { company: { min_draw_cents: 0 } });
  eq([r.value, r.level], [0, 'company'], 'C3 …at the company level as well');
}
// A genuinely absent level is skipped.
{
  const r = one('retainage_pct', { company: { retainage_pct: 10 }, project: { retainage_pct: null } });
  eq([r.value, r.level], [10, 'company'], 'C4 null really is "no answer here"');
  const r2 = one('retainage_pct', { company: { retainage_pct: 10 }, project: { retainage_pct: '' } });
  eq([r2.value, r2.level], [10, 'company'], 'C5 …and so is blank');
}

// ─────────────────────────────────────────────── D. a value the knob does not allow is ignored
{
  const r = one('investor_funding_mode', {
    company: { investor_funding_mode_default: 'reimbursement' },
    project: { investor_funding_mode: 'JUNK' },
  });
  eq([r.value, r.level], ['reimbursement', 'company'], 'D1 an unusable choice falls through, it is not honoured');
  eq(r.levels.project, 'JUNK', 'D2 …but it is still REPORTED, so a screen can show the bad value rather than hide it');
}
{
  const r = one('draw_platform', { rule: { draw_platform: 'somewhere_else' } });
  eq([r.value, r.level], ['sitewire', 'none'], 'D3 the same for the platform knob — a typo never reroutes draws');
}

// ─────────────────────────────────────────────── E. resolveAll + the company map
{
  const all = DS.resolveAll({ company: { retainage_pct: 7 } });
  eq(all.length, DS.CATALOG.length, 'E1 every knob is resolved, in catalog order');
  eq(all[0].key, DS.CATALOG[0].key, 'E2 …in catalog order');
  ok(all.every((r) => r.settable && typeof r.settable.company === 'boolean'), 'E3 each says where it CAN be set');
  eq(all.find((r) => r.key === 'retainage_pct').value, 7, 'E4 …and reads the company map');
}
{
  const m = DS.companyMapFrom([{ key: 'retainage_pct', value: 10 }, { key: 'require_lien_waivers', value: false }]);
  eq(m.retainage_pct, 10, 'E5 the settings rows become a plain map');
  eq(m.require_lien_waivers, false, 'E6 …with false preserved as false');
}

// Nothing here may throw, whatever it is handed — it renders a screen.
for (const bad of [undefined, {}, { company: null }, { project: { retainage_pct: {} } }]) {
  const r = DS.resolveAll(bad);
  ok(Array.isArray(r) && r.length === DS.CATALOG.length, `E7 resolveAll(${JSON.stringify(bad)}) still answers`);
}

console.log(`test-draw-settings-pure: all ${n} draw-settings checks passed.`);
