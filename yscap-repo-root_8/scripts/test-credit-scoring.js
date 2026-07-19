/* Ad-hoc unit tests for src/lib/credit/scoring.js
 * Run: node scripts/test-credit-scoring.js   (no DB / network needed) */
const S = require('../src/lib/credit/scoring');

let pass = 0, fail = 0;
const eq = (name, got, exp) => {
  const g = JSON.stringify(got), e = JSON.stringify(exp);
  if (g === e) { pass++; } else { fail++; console.log(`FAIL ${name}: got ${g} expected ${e}`); }
};

// ---- brackets (incl. owner's 760-779 / 780+ split) ----
eq('bracket 619', S.bracketOf(619), '<620');
eq('bracket 620', S.bracketOf(620), '620-639');
eq('bracket 699', S.bracketOf(699), '680-699');
eq('bracket 700', S.bracketOf(700), '700-719');
eq('bracket 718', S.bracketOf(718), '700-719');
eq('bracket 719', S.bracketOf(719), '700-719');
eq('bracket 720', S.bracketOf(720), '720-739');
eq('bracket 739', S.bracketOf(739), '720-739');
eq('bracket 740', S.bracketOf(740), '740-759');
eq('bracket 759', S.bracketOf(759), '740-759');
eq('bracket 760', S.bracketOf(760), '760-779');
eq('bracket 779', S.bracketOf(779), '760-779');
eq('bracket 780', S.bracketOf(780), '780+');
eq('bracket 850', S.bracketOf(850), '780+');
eq('bracket string input', S.bracketOf('700'), '700-719');
eq('bracket out-of-range null', S.bracketOf(0), null);
eq('bracket junk null', S.bracketOf('9002'), null);
eq('bracket null in null out', S.bracketOf(null), null);

// ---- bracketChanged (the reset trigger; owner's examples) ----
eq('changed 718->700 same', S.bracketChanged(718, 700), false);   // both 700-719
eq('changed 718->699 diff', S.bracketChanged(718, 699), true);    // 700-719 -> 680-699
eq('changed 700->720 diff', S.bracketChanged(700, 720), true);
eq('changed 760->780 diff', S.bracketChanged(760, 780), true);    // new split matters
eq('changed 780->790 same', S.bracketChanged(780, 790), false);   // both 780+
eq('changed null est -> real', S.bracketChanged(null, 700), true);
eq('changed both null', S.bracketChanged(null, null), false);

// ---- parseScoreValue guard ----
eq('parse valid', S.parseScoreValue('734'), 734);
eq('parse zero -> null', S.parseScoreValue('0'), null);
eq('parse blank -> null', S.parseScoreValue(''), null);
eq('parse reject code 9002 -> null', S.parseScoreValue('9002'), null);
eq('parse junk -> null', S.parseScoreValue('718abc'), null);
eq('parse below band -> null', S.parseScoreValue('299'), null);

// ---- classifyScore ----
const EQ = { bureau: 'Equifax', model: 'EquifaxBeacon5.0', value: '734' };
eq('classify ok', S.classifyScore(EQ).usable, true);
eq('classify ok value', S.classifyScore(EQ).value, 734);
eq('classify wrong model rejected',
   S.classifyScore({ bureau: 'Equifax', model: 'VantageScore4.0', value: '734' }).reason, 'model_mismatch');
eq('classify exclusion code 9002',
   S.classifyScore({ bureau: 'Experian', model: 'ExperianFairIsaac', value: '9002' }).reason, 'excluded');
eq('classify exclusion code 9002 reason',
   S.classifyScore({ bureau: 'Experian', model: 'ExperianFairIsaac', value: '9002' }).exclusionReason, 'no-recent-activity');
eq('classify explicit exclusionReason',
   S.classifyScore({ bureau: 'TransUnion', model: 'FICORiskScoreClassic04', value: '720', exclusionReason: 'NotScoredSubjectDeceased' }).usable, false);
eq('classify zero value out_of_range',
   S.classifyScore({ bureau: 'Equifax', model: 'EquifaxBeacon5.0', value: '0' }).reason, 'out_of_range');
eq('classify missing value',
   S.classifyScore({ bureau: 'Equifax', model: 'EquifaxBeacon5.0' }).reason, 'out_of_range');

// ---- borrowerMiddle ----
const b1 = [
  { bureau: 'Equifax', model: 'EquifaxBeacon5.0', value: '734' },
  { bureau: 'Experian', model: 'ExperianFairIsaac', value: '732' },
  { bureau: 'TransUnion', model: 'FICORiskScoreClassic04', value: '730' },
];
eq('middle of 734/732/730 = 732', S.borrowerMiddle(b1).middle, 732);
eq('middle of 700/720/740 = 720', S.borrowerMiddle([
  { bureau: 'Equifax', model: 'EquifaxBeacon5.0', value: '700' },
  { bureau: 'Experian', model: 'ExperianFairIsaac', value: '720' },
  { bureau: 'TransUnion', model: 'FICORiskScoreClassic04', value: '740' },
]).middle, 720);
// ties keep duplicates: {680,680,720} -> 680 (NOT 720)
eq('ties 680/680/720 = 680', S.borrowerMiddle([
  { bureau: 'Equifax', model: 'EquifaxBeacon5.0', value: '680' },
  { bureau: 'Experian', model: 'ExperianFairIsaac', value: '680' },
  { bureau: 'TransUnion', model: 'FICORiskScoreClassic04', value: '720' },
]).middle, 680);
// two usable (one bureau excluded) -> LOWER of the two
eq('two scores -> lower (one frozen)', S.borrowerMiddle([
  { bureau: 'Equifax', model: 'EquifaxBeacon5.0', value: '740' },
  { bureau: 'Experian', model: 'ExperianFairIsaac', value: '9002' },      // no-score
  { bureau: 'TransUnion', model: 'FICORiskScoreClassic04', value: '700' },
]).middle, 700);
eq('one score -> that one', S.borrowerMiddle([
  { bureau: 'Equifax', model: 'EquifaxBeacon5.0', value: '705' },
]).middle, 705);
eq('zero usable -> null (no-score)', S.borrowerMiddle([
  { bureau: 'Equifax', model: 'EquifaxBeacon5.0', value: '9003' },
]).middle, null);
eq('zero usable -> noScore flag', S.borrowerMiddle([]).noScore, true);
eq('middle bracket label', S.borrowerMiddle(b1).bracket, '720-739');

// ---- loanRepresentative (HIGHEST middle across borrowers) ----
eq('rep highest of 720 & 660 = 720', S.loanRepresentative([720, 660]).score, 720);
eq('rep single borrower', S.loanRepresentative([705]).score, 705);
eq('rep ignores no-score borrower', S.loanRepresentative([720, null]).score, 720);
eq('rep flags no-score borrower', S.loanRepresentative([720, null]).hasNoScoreBorrower, true);
eq('rep all no-score -> null', S.loanRepresentative([null, null]).score, null);
eq('rep bracket label', S.loanRepresentative([720, 660]).bracket, '720-739');

// ---- end-to-end: two-borrower file, per-owner rules ----
const borrowerA = S.borrowerMiddle(b1).middle;                 // 732
const borrowerB = S.borrowerMiddle([
  { bureau: 'Equifax', model: 'EquifaxBeacon5.0', value: '648' },
  { bureau: 'Experian', model: 'ExperianFairIsaac', value: '661' },
  { bureau: 'TransUnion', model: 'FICORiskScoreClassic04', value: '655' },
]).middle;                                                      // 655
const rep = S.loanRepresentative([borrowerA, borrowerB]);
eq('e2e rep = 732 (higher of 732 & 655)', rep.score, 732);
eq('e2e rep bracket 720-739', rep.bracket, '720-739');

console.log(`\ncredit-scoring: ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
