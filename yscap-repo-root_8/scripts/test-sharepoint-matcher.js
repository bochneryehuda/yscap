/* Unit tests for the SharePoint fuzzy FOLDER MATCHER (src/lib/sharepoint-map.js).
 *
 * This is the code that decides WHICH person's / property's existing folder a
 * document is filed into — the exact surface where the "filed into the wrong
 * borrower's folder" (A1) class of bug lives. It was previously exercised only
 * indirectly (the e2e test stubs resolveSyncFolder out entirely), so its safety
 * invariants had no direct coverage. This suite pins them:
 *   • house-number anchor + suffix/directional street normalization
 *   • unit/apt isolation (two units never collapse into one folder)
 *   • "Moshe Katz" must NEVER match "Moshe Katzman" (prefix-extension guard)
 *   • middle-name / initial tolerance on both sides
 *   • Damerau-Levenshtein typo tolerance (≤1) with the length>64 defensive cap
 *   • marker stripping so an auto-created folder ("…, Synced by Pilot" / the
 *     legacy "…, YS portal syncing") re-matches its borrower/address next time
 *   • officer names: exact or first+last only, NO typo tolerance
 * Pure functions — no DB / no network. Run: node scripts/test-sharepoint-matcher.js
 */
const m = require('../src/lib/sharepoint-map');

let pass = 0, fail = 0;
const ok = (name, cond) => { if (cond) pass++; else { fail++; console.log(`FAIL ${name}`); } };
const eq = (name, got, want) => ok(`${name} (got ${JSON.stringify(got)} exp ${JSON.stringify(want)})`, got === want);

// ─── norm(): marker stripping + normalization ──────────────────────────────
eq('norm strips the new "Synced by Pilot" marker', m.norm('Moshe Spitzer, Synced by Pilot'), 'moshe spitzer');
eq('norm strips the legacy "YS portal syncing" marker', m.norm('76 Thompson St, YS portal syncing'), '76 thompson st');
eq('norm strips the short "Pilot sync" leaf', m.norm('Unfiled, Pilot sync'), 'unfiled');
eq('norm lowercases + drops punctuation/quotes', m.norm("O'Brien, LLC."), 'o brien llc');
eq('norm collapses whitespace', m.norm('  a   b  '), 'a b');
eq('norm of null/undefined is empty', m.norm(undefined), '');

// ─── addressCore(): house-number gate + normalization ──────────────────────
ok('addressCore requires a leading house number (stage folder → null)', m.addressCore('Open loan') === null);
ok('addressCore null on empty', m.addressCore('') === null);
ok('addressCore parses num + normalized street', (() => {
  const c = m.addressCore('654 Hamilton St, Newark NJ 07105');
  return c && c.num === '654' && c.street.join(' ') === 'hamilton street' && c.unit === null;
})());
ok('addressCore captures a unit/apt tail', (() => {
  const c = m.addressCore('12 Main St Apt 4B');
  return c && c.num === '12' && c.unit === '4b';
})());
ok('addressCore keeps a lettered house number (654A)', (() => {
  const c = m.addressCore('654a Hamilton St'); return c && c.num === '654a';
})());

// ─── addressMatches(): the house-number anchor + exact street tokens ────────
ok('same street, "St"≡"Street", city/state tail ignored', m.addressMatches('654 Hamilton St', '654 Hamilton Street, Newark NJ 07105'));
ok('directional abbrev "N"≡"North"', m.addressMatches('10 N Main St', '10 North Main Street'));
ok('DIFFERENT house number never matches', !m.addressMatches('654 Hamilton St', '655 Hamilton St'));
ok('"Oak Street Extension" is a DIFFERENT street from "Oak St"', !m.addressMatches('45 Oak Street Extension', '45 Oak St'));
ok('two different apt units never collapse', !m.addressMatches('12 Main St Apt 4', '12 Main St Apt 5'));
ok('same apt unit matches', m.addressMatches('12 Main St Apt 4', '12 Main St Apt 4, Newark'));
ok('a stage folder ("closed") can never match a real address', !m.addressMatches('closed', '654 Hamilton St'));
// Comma-delimited city tail is ignored; a comma-LESS embedded unknown city is
// NOT guessed away — it falls through to the safe create-new-folder path.
ok('comma-delimited city tail ignored', m.addressMatches('100 Main St', '100 Main Street, Springfield IL 62704'));
ok('comma-less embedded city does NOT force a match (safe fall-through)', !m.addressMatches('100 Main St', '100 Main Street Springfield IL 62704'));
ok('an auto-created address folder re-matches (legacy marker after comma)', m.addressMatches('76 Thompson St, YS portal syncing', '76 Thompson Street'));

// ─── addressMatchesTypo(): one street-token edit, but the house-number anchor
//     and street length still hold (flagged fallback pass) ───────────────────
ok('address typo: "654 Hamiltion St" ↔ "654 Hamilton Street"', m.addressMatchesTypo('654 Hamiltion St', '654 Hamilton Street'));
ok('address typo STILL requires an identical house number', !m.addressMatchesTypo('655 Hamilton St', '654 Hamilton St'));
ok('address typo STILL refuses "Oak Street Extension" vs "Oak St" (length)', !m.addressMatchesTypo('45 Oak Street Extension', '45 Oak St'));
ok('address typo STILL isolates different units', !m.addressMatchesTypo('12 Main St Apt 4', '12 Main St Apt 5'));

// ─── dlDistance(): Damerau-Levenshtein, capped, with the >64 guard ─────────
eq('dlDistance identical = 0', m.dlDistance('john', 'john'), 0);
eq('dlDistance transposition (jonh↔john) = 1', m.dlDistance('jonh', 'john'), 1);
eq('dlDistance insertion (hamilton↔hamiltion) = 1', m.dlDistance('hamiltion', 'hamilton'), 1);
eq('dlDistance substitution (cohen↔kohen) = 1', m.dlDistance('cohen', 'kohen'), 1);
eq('dlDistance length-diff>1 is capped at 2 (katz↔katzman)', m.dlDistance('katz', 'katzman'), 2);
eq('dlDistance on a >64-char token short-circuits to 2 (no O(n^2) DP)',
  m.dlDistance('a'.repeat(65), 'a'.repeat(64) + 'b'), 2);

// ─── tokenClose(): one edit only on tokens long enough to be safe ──────────
ok('tokenClose short tokens never match ("st" vs "s")', !m.tokenClose('st', 's'));
ok('tokenClose cohen↔kohen (len≥4, DL 1)', m.tokenClose('cohen', 'kohen'));
ok('tokenClose katz↔katzman is NOT close (DL 2)', !m.tokenClose('katz', 'katzman'));

// ─── borrowerMatches(): exact or first+last, middle ignored, NO substrings ─
ok('borrower exact full name', m.borrowerMatches('Moshe Spitzer', 'Moshe', 'Spitzer'));
ok('borrower folder with a MIDDLE initial still matches', m.borrowerMatches('Moshe C Spitzer', 'Moshe', 'Spitzer'));
ok('borrower whose OWN first name carries a middle ("Moshe C")', m.borrowerMatches('Moshe Spitzer', 'Moshe C', 'Spitzer'));
ok('CRITICAL: "Moshe Katzman" folder must NOT match borrower "Moshe Katz"', !m.borrowerMatches('Moshe Katzman', 'Moshe', 'Katz'));
ok('CRITICAL: "Moshe Katz" folder must NOT match borrower "Moshe Katzman"', !m.borrowerMatches('Moshe Katz', 'Moshe', 'Katzman'));
ok('a single-token folder ("Cohen") never matches a two-part name', !m.borrowerMatches('Cohen', 'David', 'Cohen'));
ok('an auto-created borrower folder re-matches (marker stripped)', m.borrowerMatches('Moshe Spitzer, Synced by Pilot', 'Moshe', 'Spitzer'));

// ─── borrowerMatchesTypo(): flagged fallback — near-matches, but Katz≠Katzman ─
ok('typo pass: "Jonh Smith" ↔ borrower "John Smith"', m.borrowerMatchesTypo('Jonh Smith', 'John', 'Smith'));
ok('typo pass: "Dovid Kohen" ↔ borrower "Dovid Cohen" (1-letter surname)', m.borrowerMatchesTypo('Dovid Kohen', 'Dovid', 'Cohen'));
ok('CRITICAL: typo pass STILL refuses "Moshe Katz" ↔ "Moshe Katzman"', !m.borrowerMatchesTypo('Moshe Katz', 'Moshe', 'Katzman'));
ok('typo pass needs ≥2 tokens (single-token folder never matches)', !m.borrowerMatchesTypo('Cohen', 'David', 'Cohen'));

// ─── officerMatches(): exact or first+last, NO typo tolerance ──────────────
ok('officer exact', m.officerMatches('Joshua Friedlander', 'Joshua Friedlander'));
ok('officer with a middle initial matches', m.officerMatches('Joshua M Friedlander', 'Joshua Friedlander'));
ok('officer "Josh" does NOT match "Joshua" (no typo tolerance for officers)', !m.officerMatches('Josh Friedlander', 'Joshua Friedlander'));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
