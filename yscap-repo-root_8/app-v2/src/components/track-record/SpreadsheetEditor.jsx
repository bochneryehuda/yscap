import React, { useState } from 'react';
import ToolModal from '../ToolModal.jsx';

/* THE SPREADSHEET EDITOR — the original static track-record tool, with its Excel IMPORT,
 * reachable from every surface that shows the record.
 *
 * Owner-directed 2026-08-24: *"On the track record section we should have a button to open up the
 * old static version of the track record where there is an import button. You can import the excel
 * sheet and that has the same old logic. We love that thing that you can import and export … so we
 * need to add maybe a button to open up the old static version, then you can import, it imports
 * everything and then you can save it, whatever it saves automatically and it goes into the
 * workflow. Add that button and bring back how it was … Leave all the enhancements but just bring
 * in that feature."*
 *
 * NOTHING IS BROUGHT BACK, BECAUSE NOTHING WAS TAKEN AWAY — the gap was WHERE it could be reached
 * from. The tool is `web/v2/tools/track-record.html`, the same one the marketing site publishes:
 * an Import button that reads the borrower's own exported .xlsx, and `track-record-portal.js`
 * bridging every row back into the workflow through the ordinary staff API (create-once, adopt the
 * server id, so a re-import never duplicates a line). It has been one click away on the LOAN FILE
 * the whole time. What changed on 2026-08-19 is that "Open full screen" stopped opening it and
 * started opening the live workspace — correctly, that screen is the record you read — and the
 * workspace and the borrower PROFILE were then the two places a person could stand with the whole
 * record in front of them and no way to import a spreadsheet into it.
 *
 * ONE COMPONENT, THREE MOUNTS, exactly like `ExportRecord` beside it: the loan file's Track record
 * section, the borrower profile's Track record tab, and the full-screen workspace. The URL is built
 * HERE and nowhere else — three hand-typed query strings is three chances for one surface to open
 * the tool in the wrong mode, and the mode is what decides whether it saves to this borrower's
 * record or to nobody's.
 *
 * `?internal=1` is the STAFF bridge (`&portal=1` is the borrower's own sheet and is deliberately
 * not offered here — it resolves the borrower from the session, so it would open the wrong
 * person's record on a staff screen).
 *
 * STAFF-ONLY. Text colours are explicit dark hex per the white-first rule (an --ink* token is a
 * LIGHT paper colour in this palette and renders white-on-white).
 */

/** The ONE definition of how a staff surface opens the legacy tool for one borrower. */
export function legacyToolUrl(borrowerId) {
  return `/tools/track-record.html?internal=1&borrower=${encodeURIComponent(borrowerId)}&embed=1`;
}

export default function SpreadsheetEditor({ borrowerId, className = '', label = 'Spreadsheet editor', onClosed = null }) {
  const [open, setOpen] = useState(false);
  // No borrower, no record to edit — offering the button would open the tool on nobody.
  if (!borrowerId) return null;
  return (
    <>
      <button type="button" className={`btn ghost small ${className}`.trim()} onClick={() => setOpen(true)}
        title="The original spreadsheet-style tool — bulk-edit the grid, and import or export the borrower’s Excel. Everything it saves goes back into this record.">
        {label}
      </button>
      {open && (
        <ToolModal
          title="Borrower track record"
          url={legacyToolUrl(borrowerId)}
          onClose={async () => { setOpen(false); if (onClosed) await onClosed(); }} />
      )}
    </>
  );
}
