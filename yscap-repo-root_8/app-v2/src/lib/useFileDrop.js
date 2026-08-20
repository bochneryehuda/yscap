/* A DROP TARGET, IN ONE PLACE — the hook every new drag-and-drop zone uses.
   Owner-directed 2026-08-20: "the drag-and-drop feature that we have all over
   needs to be updated over there so that you should be able to just drop
   documents into that line item."

   `lib/drop-files.js` already owns the HARD part — reading the bytes out of a
   drop, including a file dragged straight out of the Outlook desktop app, whose
   constraints (never await before touching `dataTransfer`, a zero-byte result is
   a failure and never a document) are documented there and are not repeated here.
   What was repeated, eight times across five screens, is the little bit around
   it: preventDefault on dragover, a highlight while the pointer is over the row,
   clearing that highlight on the way out, and calling the reader on drop.

   THREE THINGS THAT LOOK LIKE STYLE AND ARE NOT:

   1. `onDragLeave` fires when the pointer crosses onto a CHILD element, so a zone
      containing anything at all flickers unless the leave is ignored for children.
      Half the existing copies guard it with `e.currentTarget === e.target`, which
      works only while the pointer is over the zone's own padding; this counts
      enter/leave pairs instead, which is correct however deeply nested the
      contents are — and a drop or a dragend resets the counter, because a leave
      is not always delivered after a drop.
   2. `preventDefault` on dragOVER is what makes the browser offer a drop at all.
      Without it the drop never fires and the browser navigates to the file
      instead, losing whatever the user was in the middle of.
   3. ZONES NEST — a track-record ledger ROW is a drop target and the documents
      card INSIDE it is another — and a drop bubbles, so without a guard the same
      files upload TWICE. `stopPropagation` is the obvious fix and is the wrong
      one: an outer zone that never hears the drop also never clears its
      highlight, and there is no later event on an external file drag to clear it
      with. So the drop is allowed to bubble (every zone in the chain resets) and
      the DELIVERY is claimed exactly once, by marking the event. React dispatches
      ONE synthetic event object through the chain, innermost first, so the
      innermost zone is the one that takes the files — which is what a person
      pointing at the inner card means.

   The pre-existing inline copies in ClosingPanel / LlcManager / Profile /
   StaffApplication / Application are behaviourally the same; they predate this
   hook and are deliberately left alone rather than swept in a change about the
   track record. NEW zones use this. */
import { useCallback, useRef, useState } from 'react';
import { onFilesDropped } from './drop-files.js';

/* The claim mark for a bubbling drop — see (3) above. A Symbol so it can never
   collide with a real property of the synthetic event. */
const DROP_CLAIMED = Symbol('pilot.dropClaimed');

/**
 * @param onFiles  (File[]) => void|Promise — what to do with the dropped documents.
 *                 Not called when nothing readable was dropped; `drop-files.js`
 *                 explains that to the user itself in that case.
 * @param enabled  false disables the zone entirely (no highlight, no drop).
 * @returns { over, dropProps } — spread `dropProps` on the element, and use
 *          `over` to paint the highlight.
 */
export default function useFileDrop(onFiles, enabled = true) {
  const [over, setOver] = useState(false);
  // A COUNTER, not a boolean: see (1) above.
  const depth = useRef(0);

  const reset = useCallback(() => { depth.current = 0; setOver(false); }, []);

  const onDragEnter = useCallback((e) => {
    e.preventDefault();
    depth.current += 1;
    setOver(true);
  }, []);

  const onDragOver = useCallback((e) => {
    e.preventDefault();               // (2) — without this there is no drop at all
    if (depth.current === 0) { depth.current = 1; setOver(true); }
  }, []);

  const onDragLeave = useCallback((e) => {
    e.preventDefault();
    depth.current = Math.max(0, depth.current - 1);
    if (depth.current === 0) setOver(false);
  }, []);

  const onDrop = useCallback((e) => {
    e.preventDefault();
    // EVERY zone in the chain clears its own highlight, whether or not it is the
    // one that takes the files — see (3).
    reset();
    // …and exactly ONE takes them. The innermost runs first, so it wins.
    if (e[DROP_CLAIMED]) return;
    e[DROP_CLAIMED] = true;
    // The DataTransfer is emptied the instant this handler returns, so the read
    // has to start before anything is awaited. `reset()` above is a setState, not
    // a read of the event, so it is safe to come first.
    onFilesDropped(e, onFiles);
  }, [onFiles, reset]);

  if (!enabled) return { over: false, dropProps: {} };
  return { over, dropProps: { onDragEnter, onDragOver, onDragLeave, onDrop, onDragEnd: reset } };
}
