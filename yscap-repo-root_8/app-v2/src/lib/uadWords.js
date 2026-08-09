/* WHAT THE APPRAISER SAID ABOUT THE VIEW AND THE LOCATION — or an honest
 * admission that we could not read it.
 *
 * A UAD grid states these as a packed cell: "N;Res;" is Neutral / Residential,
 * "A;Traffic;Res" is Adverse / busy road. `src/lib/appraisal/uad-rating.js`
 * decodes the shapes it recognises and REFUSES the rest — deliberately, because
 * a confidently wrong reading of "this house backs onto a prison" is worse than
 * no reading. What it refuses is stored as the raw cell.
 *
 * So a screen that prints the stored value prints a machine code. Measured on
 * the corpus: 209 of 769 comparables and 112 of 150 subject rows. And the enum
 * humaniser makes it WORSE, because it splits the abbreviation — "N;CtyStr;"
 * renders as "N;Cty Str;", which looks like words and is not.
 *
 * Neither the code nor a blank row is the right answer. The report DID state
 * something, so the row stays and says plainly that we could not read it, which
 * is a reason to open the report; a code is a reason to file a bug.
 *
 * The test is the UAD separators: a decoded factor reads "Residential", "City
 * Street", "Woods"; a raw cell always carries a ';' or a '/'.
 *
 * ONE DEFINITION, because this has to hold on every screen that shows these two
 * facts — the file's appraisal panel and the research warehouse's property page
 * read the same values out of the same columns.
 */
export const UNREADABLE = 'the report states a code here that we could not read in plain words';

export const looksLikeUadCode = (v) => /[;/]/.test(String(v));

/**
 * @param {string|null} rating   the decoded verdict (Neutral / Beneficial / Adverse)
 * @param {string|null} type     the decoded factor (Residential, Woods, City Street)
 * @param {(v:string)=>string} [humanize]  optional enum prettifier for the factor
 * @returns {string} words a person can read, never a machine code
 */
export function uadWords(rating, type, humanize) {
  const keep = (v, pretty) => {
    if (!v || looksLikeUadCode(v)) return null;
    return pretty && humanize ? humanize(v) : String(v);
  };
  const parts = [keep(rating, false), keep(type, true)].filter(Boolean);
  return parts.length ? parts.join(' · ') : UNREADABLE;
}
