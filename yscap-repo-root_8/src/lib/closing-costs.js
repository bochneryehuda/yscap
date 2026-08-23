'use strict';
/* =====================================================================
   closing-costs — the government charges on an RTL closing.

   THIS IS A TWO-LINE RE-EXPORT ON PURPOSE. The rule itself lives in
   `web/v2/tools/gov-charges.js`, because the SAME rule has to run in two
   places: the Term Sheet Studio draws the term sheet in the BROWSER (that is
   where the form fields and the frozen program engines both live), and the
   server prices and registers the loan in NODE.

   A browser twin of a server rule is a drift class this repo has been bitten
   by more than once — the studio would PRINT one cash to close while the
   register BOOKED another, and the copy that drifts is the one that goes out
   for signature. So there is exactly ONE definition, loaded two ways: the
   studio with a <script> tag, the server through this file. It is the same
   arrangement `src/lib/pricing.js` already uses for the frozen program
   engines, which it requires straight out of the tools folder.

   Never copy a rate, a rule or a label out of that file into a second one.
   ===================================================================== */
module.exports = require('../../web/v2/tools/gov-charges.js');
