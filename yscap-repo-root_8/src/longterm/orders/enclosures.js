/**
 * OUR OWN PAPER THAT RIDES ON AN ORDER.
 *
 * Some orders carry a document of ours out with the letter. Two exist today and
 * they arrive by two different routes, which is the whole reason this file is
 * separate from `desk.place`:
 *
 *   · The VERIFICATION OF RENT is RENDERED PER FILE — the borrower's name, the
 *     property, the landlord's block are drawn onto the blank at the moment of
 *     sending — so its bytes cannot be known here. `vor/desk.js` passes them in
 *     as `opts.attachments`, and this module deliberately answers NOTHING for
 *     that kind.
 *   · The CONDO QUESTIONNAIRE carries a FIXED blank — Fannie Mae Form 1076, the
 *     copy the owner supplied — identical on every file. Owner's original brief:
 *     *"we send out a template of the Fannie Mae condo questionnaire attached as
 *     a PDF."* It was dropped on the first build: the letter asked the
 *     association to complete a questionnaire and enclosed no questionnaire.
 *
 * WHY IT IS RESOLVED IN `desk.place` AND NOT AT THE CALL SITE: an order can be
 * placed from the orders desk, from the condition, and (later) by a rule. A form
 * attached at one of those three doors is a form missing from the other two, and
 * nothing would say so — the association would simply be asked for a completed
 * copy of a form nobody sent them.
 *
 * IT NEVER THROWS AND IT NEVER BLOCKS A SEND. A missing or unreadable asset
 * costs the enclosure and is REPORTED (`skipped`), because an order that reaches
 * the association a form short is recoverable in one reply, while an order that
 * refuses to go out because a file on our disk moved is not.
 */
const fs = require('fs');
const path = require('path');

const ASSETS = path.join(__dirname, '..', 'assets');

/** The fixed blanks, by order kind. Add a kind here, not at a call site. */
const ENCLOSURES = Object.freeze({
  condo_questionnaire: Object.freeze({
    file: 'fannie-1076-condo-questionnaire.pdf',
    // What the association sees in their mail client. Named for what it IS, not
    // for our internal filename — "fannie-1076-…" means nothing to a management office.
    filename: 'Condominium Questionnaire (Fannie Mae Form 1076).pdf',
  }),
});

/**
 * The enclosures for one order kind.
 *
 * @returns {{attachments: Array<{filename:string, content:string}>, skipped: Array<{filename:string, why:string}>}}
 */
function forKind(kind) {
  const spec = ENCLOSURES[String(kind || '').trim()];
  if (!spec) return { attachments: [], skipped: [] };
  try {
    const buf = fs.readFileSync(path.join(ASSETS, spec.file));
    // An empty read is a broken asset, not an empty form. Sending a 0-byte PDF
    // is worse than sending none: the reader sees an attachment and opens
    // nothing, and nobody tells us.
    if (!buf || !buf.length) {
      return { attachments: [], skipped: [{ filename: spec.filename, why: 'the stored form is empty' }] };
    }
    return { attachments: [{ filename: spec.filename, content: buf.toString('base64') }], skipped: [] };
  } catch (e) {
    return {
      attachments: [],
      skipped: [{ filename: spec.filename, why: 'the stored form could not be read' }],
    };
  }
}

module.exports = { forKind, ENCLOSURES };
