'use strict';
/**
 * LONG-TERM — the product stamp.
 *
 * The rule (CLAUDE.md §7): a screen that can show both products must carry "a visible
 * product stamp on every row and every file header so anyone can tell at a glance
 * which product a file is", and the merge happens only in the read/view layer —
 * "each product answers for its own rows, the edge tags and concatenates".
 *
 * ═══════════════════════════════════════════════════════════════════════════════
 * THE STAMP BELONGS TO THE ROW, NOT TO THE SCREEN.
 *
 * It would be easier for the long-term screens to print "Long-term" because they are
 * the long-term screens. That is exactly the version that goes wrong: the day a
 * combined pipeline lists both books, a stamp derived from which screen you are on
 * labels every row with the same word, and the one thing the stamp exists to prevent
 * — not being able to tell a short-term file from a long-term one — is what it
 * causes. So THIS side tags its own rows here, the front end renders whatever tag a
 * row carries, and a row with no tag renders no stamp rather than a guessed one.
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * NOT A CROSSING. This names the long-term product only. It reads nothing from RTL,
 * declares nothing on RTL's behalf, and RTL must tag its own rows in its own code —
 * a shared tagger would be a shared module between two products that never share one.
 *
 * PURE — no database, no config, no requires.
 */

/** The key a row carries. Machine-readable, stable, never shown to a person. */
const PRODUCT_KEY = 'long_term';

/** What a person reads. The owner's own word for this book. */
const PRODUCT_LABEL = 'Long-term';

/**
 * The stamp for a long-term row.
 *
 * Returned as an OBJECT rather than a bare string so a screen renders the label and
 * keys off `product` without parsing display text — and so a later short-term stamp
 * can be the same shape without either side importing the other's.
 */
const stamp = () => ({ product: PRODUCT_KEY, productLabel: PRODUCT_LABEL });

/** Tag one row. Returns a new object; never mutates what it was handed. */
const tagRow = (row) => (row && typeof row === 'object' ? { ...row, ...stamp() } : row);

/** Tag a list of rows. A non-array is returned untouched rather than coerced. */
const tagRows = (rows) => (Array.isArray(rows) ? rows.map(tagRow) : rows);

module.exports = { PRODUCT_KEY, PRODUCT_LABEL, stamp, tagRow, tagRows };
