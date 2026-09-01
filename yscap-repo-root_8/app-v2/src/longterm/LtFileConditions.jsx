import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ltApi } from './api.js';
import LtSendConditions from './LtSendConditions.jsx';
import { stamp } from './format.js';
import LtConditionAnswer from './LtConditionAnswer.jsx';

/* THE SHORT-TERM CONDITION CENTER'S OWN COMPONENTS, MOUNTED HERE.
 *
 * Authorized in writing by the owner, 2026-08-30 (the share-the-code directive,
 * docs/longterm/SHARE-THE-CODE-DIRECTIVE.md, and one line each in the crossing
 * ledger): *"the same look of the Condition Center … the way you preview stuff,
 * the way you preview the PDFs, the way you drag and drop, accept, reject,
 * preview, download, and delete … it should update them both places. You need to
 * share the code."*
 *
 * These are the REAL components the short-term file screen draws, not a copy of
 * them. Every one takes its I/O as function props and none of them imports an
 * API client, which is what makes them mountable here at all — the adapter below
 * is backed by `ltApi` and hits the /api/lt doors, so the components cannot tell
 * which product they are drawing.
 *
 * ── DO NOT EDIT A SHARED COMPONENT TO MAKE LONG-TERM FIT ────────────────────
 *
 * They are read by the short-term file screen at the same time. Renaming a field
 * they read, or restyling one to suit this page, silently changes the live
 * product — which is the one thing the owner named in the same breath: *"watch
 * what you're doing not to break the other side of the business."* Anything
 * Long-Term needs differently is normalized HERE, on the way in and out. */
import ConditionLine, { ConditionCollapse, ConditionNote } from '../components/ConditionLine.jsx';
import ConditionActions, { DocActions } from '../components/ConditionActions.jsx';
/* THE SHOW PICKER — the SAME rule the short-term list runs, not a Long-Term
   copy of it. Owner-directed 2026-09-01: "add the full sorting features so that
   you can sort by stuff that is done, by signed off, and by outstanding … that
   we have on the short-term side. You can share that code as well." It reads
   the SHARED condition shape, which is exactly what `asSharedCondition` below
   already produces — so both products filter the same rows the same way. */
import { CONDITION_FILTER_KEYS, conditionFilterLabel, conditionFilterHint, matchConditionFilter } from '../lib/condition-filter.js';
import LtConditionContacts from './LtConditionContacts.jsx';
import LtConditionOrder from './LtConditionOrder.jsx';
import DocPreview from '../components/DocPreview.jsx';
import DropZone from '../components/DropZone.jsx';
import UploadRows from '../components/UploadRows.jsx';
import LoudHint from '../components/LoudHint.jsx';

/**
 * THE GENERAL CONDITION CENTER, on one loan.
 *
 * OUR OWN conditions — what this file needs to get submitted, cleared to close,
 * docked, funded and sold. The section above it on the file screen is the
 * ENCOMPASS MIRROR: what the investor's underwriter raised after buying the
 * loan. Two centres, on purpose.
 *
 * ── WHAT IS SHARED, AND WHAT IS THIS PAGE'S OWN ─────────────────────────────
 *
 * SHARED: the condition line, the action bar and its More menu, the document
 * row's verbs, the PDF previewer with its own find bar, the drag-and-drop zone,
 * the uploading bar, the loud-hint banner. Those are the owner's list, and they
 * update in both products at once because there is one of each.
 *
 * OURS: the LONG-TERM LOOK. *"This is not a redesign … I like the design that we
 * have on the long-term side. Don't change the design. Stick with the design and
 * with the fonts."* So the page around the shared parts is unchanged — the gates
 * in the buckets' own order, the three-number summary, the white boxes, the
 * fonts — and the shared components are dropped INTO it rather than the page
 * being rebuilt around them.
 *
 * ── FIVE THINGS ON THIS SCREEN ARE DELIBERATE ───────────────────────────────
 *
 * 1. GROUPED BY THE GATE IT BLOCKS, in the buckets' own order, because that is
 *    the order the work happens in. The server owns the order, so this file
 *    holds no rule about it and the two cannot drift.
 *
 * 2. A REFUSAL IS THE ANSWER, AND IT IS SHOWN. Signing off a condition with a
 *    document nobody has looked at is refused BY THE SERVER, in words; this
 *    screen prints those words rather than a generic "that did not work" — and
 *    it prints them ON THE ROW, because a refusal at the top of a long screen,
 *    away from the button that caused it, reads as "nothing happened".
 *
 * 3. "DONE" IS THREE DIFFERENT FACTS. Satisfied, waived and did-not-apply are
 *    shown differently and a waiver always shows its reason — that reason is the
 *    thing somebody reads a year later. The shared audit line states who and
 *    when; the REASON is printed beside it, because that line has no room for it
 *    and Long-Term will not let a waiver go unexplained.
 *
 * 4. A CONDITION WHOSE TEMPLATE IS SWITCHED OFF IS GREYED WITH ITS REASON, not
 *    hidden. A feature that silently disappears is worse than one that says it
 *    is off.
 *
 * 5. EVERY COLOUR IS AN EXPLICIT DARK ON WHITE. `--ink*` is a LIGHT paper colour
 *    in this palette — the names are legacy and they lie.
 *
 * ── THE WAIVER IS TYPED ON THE ROW, AND THAT IS BOTH RULES AT ONCE ──────────
 *
 * The shared action bar offers "Not required" only on an OPTIONAL condition and
 * carries no reason box; Long-Term's rule is that ANY condition may be waived
 * and that the reason is required. So the waiver rides in the bar's own `extra`
 * slot — inside the same More menu, in the same place a person already looks —
 * and the reason is typed on the row rather than in a dialog. That is what this
 * repo's own rule asks for anyway.
 */

const INK = '#141B22';
const MUTED = '#4B585C';
const LINE = '#E6E1D6';
const GREEN = '#2F6B4F';
const AMBER = '#8A6A17';
const RED = '#8A2D2D';

/** The statuses that mean the condition is no longer work. */
const DONE_STATUSES = new Set(['satisfied', 'waived', 'not_applicable']);
/** …and the two of those that are a WAIVE rather than a satisfaction. */
const WAIVED_STATUSES = new Set(['waived', 'not_applicable']);

/* ── THE ROW SHAPE, NORMALIZED ON THE LONG-TERM SIDE ONLY ───────────────────
 *
 * The shared components read a `checklist_items` row in the SHORT-TERM
 * vocabulary — `staff` / `borrower` / `both` for the audience, and the five
 * statuses that column's CHECK constraint admits. The Long-Term read hands back
 * the OWNER'S wording (`internal` / `external`, and six statuses including
 * `waived` and `not_applicable`), because that is what the owner's own library
 * is written in and what every other Long-Term screen shows.
 *
 * `src/longterm/conditions-center/vocabulary.js` is the one translation between
 * them on the server, and these two maps are its front-end counterpart — the
 * SAME pairs, in the same direction. They live here, on the Long-Term side, and
 * NEVER inside a shared component: renaming a field in there to make Long-Term
 * fit would change what the short-term product reads off its own rows.
 */
const AUDIENCE_TO_SHARED = { internal: 'staff', external: 'borrower', both: 'both' };
const STATUS_TO_SHARED = {
  outstanding: 'outstanding',
  in_progress: 'requested',
  received: 'received',
  satisfied: 'satisfied',
  // A WAIVE is `satisfied` plus the stamp — this system's own way of recording
  // one, and the reason `vocabulary.js` maps rather than widening the column.
  // The stamp below is what tells the shared line it was waived rather than met.
  waived: 'satisfied',
  not_applicable: 'satisfied',
  // RTL's push-back state has no Long-Term word and is reported AS ITSELF by the
  // read, so it is carried straight through rather than flattened.
  issue: 'issue',
};
/** The inverse, for the ONE status door Long-Term exposes (`write.setStatus`). */
const SHARED_STATUS_TO_LT = { outstanding: 'outstanding', requested: 'in_progress', received: 'received' };

/**
 * One Long-Term condition, in the shape the shared components read.
 *
 * Everything absent here is absent ON PURPOSE, and each one would be a claim we
 * cannot back: `assignee_staff_id` (no assignment door — and the shared bar
 * hides that control entirely when no team is passed), `note_buyer_mark` /
 * `esign_auto` / `is_gate` / `override_at` (short-term facts, derived
 * server-side over there).
 * A field left off simply does not render.
 */
function asSharedCondition(c) {
  const waived = WAIVED_STATUSES.has(c.status);
  return {
    id: c.id,
    label: c.label,
    audience: AUDIENCE_TO_SHARED[c.audience] || 'staff',
    status: STATUS_TO_SHARED[c.status] || 'outstanding',
    is_required: c.isRequired !== false,
    signed_off_at: c.status === 'satisfied' ? (c.satisfiedAt || null) : null,
    signed_off_name: c.satisfiedBy || null,
    // The loan officer's own step, the same two fields the short-term side
    // renders — so the audit line reads identically on both products.
    reviewed_at: c.reviewedAt || null,
    reviewed_by_name: c.reviewedBy || null,
    waived_at: waived ? (c.waivedAt || null) : null,
    waived_by_name: c.waivedBy || null,
    notes: c.notes || '',
  };
}

/**
 * A FILTER THIS PERSON PICKED, REMEMBERED — under a LONG-TERM key.
 *
 * The short-term screen keeps its sticky filters under `pilot.filter.*`. Sharing
 * that namespace would make a processor's Long-Term choice silently apply to
 * their short-term list and back again, on a screen where the two products' rows
 * mean different things. So the prefix is the product's own, and the two can
 * never reach each other's value.
 */
function useLtStickyFilter(key, fallback) {
  const full = `pilot.lt.filter.${key}`;
  const [v, setV] = useState(() => {
    try { const s = localStorage.getItem(full); return s == null ? fallback : s; } catch { return fallback; }
  });
  const set = useCallback((next) => {
    setV(next);
    try { localStorage.setItem(full, String(next)); } catch { /* private mode */ }
  }, [full]);
  return [v, set];
}


export default function LtFileConditions({ loanId }) {
  const [data, setData] = useState(null);
  const [err, setErr] = useState(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState('');
  const [open, setOpen] = useState(() => new Set());
  const [rowErr, setRowErr] = useState({});
  /* WHAT PILOT READ OFF AN UPLOADED MORTGAGE STATEMENT — a NOTE, never an
     error, and kept apart from `rowErr` for exactly that reason: the upload
     succeeded either way, and colouring a successful read like a failure is
     how somebody learns to ignore the box. */
  const [rowRead, setRowRead] = useState({});
  /* WHICH CONDITIONS AM I LOOKING AT. The key is NEW ('condShow') rather than a
     re-use of the old show-finished tick: that value was a '1'/'0' and reading
     it as a filter name would leave somebody's saved choice meaning nothing.
     A stale one falls through to the default anyway, so nobody lands on a blank
     screen either way. */
  const [condFilter, setCondFilter] = useLtStickyFilter('condShow', 'mine');
  const [role, setRole] = useState(null);
  const [roleKnown, setRoleKnown] = useState(false);
  const [preview, setPreview] = useState(null);   // the document being looked at
  const [dlBusy, setDlBusy] = useState(null);     // the document being downloaded

  /* ONE hidden file input for the whole screen, aimed by a ref.
     A per-row input would be one element per condition on a list of forty, and
     the REPLACE action has no element of its own to hang one on — it is a button
     inside a document's More menu. */
  const fileRef = useRef(null);
  const aimRef = useRef(null);                    // { conditionId, replaceDocumentId }

  const load = useCallback(() => {
    setErr(null);
    ltApi.fileConditions(loanId)
      .then(setData)
      .catch((e) => setErr(e.message || 'Could not read this file’s conditions.'));
  }, [loanId]);
  useEffect(load, [load]);

  /* WHICH BUTTONS THIS PERSON SEES comes from their own long-term role, read from
     the server. The shared ladder decides what a role may do, so passing anything
     else here would show a control the server then refuses — or hide one it
     allows. A role we could not read shows the non-completer's view, which is the
     safe direction: it offers less, never more. */
  useEffect(() => {
    let alive = true;
    ltApi.me()
      .then((m) => { if (alive) setRole(m && m.ltRole ? String(m.ltRole) : null); })
      .catch(() => { /* the ladder degrades to the smaller set of actions */ })
      /* WHO IS READING NOW DECIDES WHICH ROWS ARE SHOWN, not only which buttons
         are on them — so the list waits for the answer rather than drawing the
         back-office view and then having rows vanish from under a loan officer
         a moment later. It is a SEPARATE flag from `role` and it is set on the
         FAILURE path too: gating on `role` itself would leave the whole screen
         permanently blank for anybody whose role could not be read, which is a
         far worse failure than the flicker it fixes. */
      .finally(() => { if (alive) setRoleKnown(true); });
    return () => { alive = false; };
  }, []);

  // A REFUSAL BELONGS TO THE ROW THAT CAUSED IT. Keyed on the condition id, so
  // two rows can never show each other's message and the server's own words are
  // what a person reads — its refusals name what is missing and what to do about
  // it, and replacing them with "that did not work" is what makes a condition
  // feel like a dead end.
  const say = useCallback((id, message) => setRowErr((prev) => ({ ...prev, [id]: message })), []);

  const act = useCallback(async (id, fn, okNote) => {
    setBusy(true); setNote('');
    setRowErr((prev) => ({ ...prev, [id]: null }));
    try {
      await fn();
      if (okNote) setNote(okNote);
      load();
      return true;
    } catch (e) {
      say(id, e.message || 'That did not work.');
      return false;
    } finally {
      setBusy(false);
    }
  }, [load, say]);

  const evaluate = () => act('__file', async () => {
    const out = await ltApi.fileConditionsEvaluate(loanId);
    const bits = [];
    if (out.added && out.added.length) bits.push(`${out.added.length} added`);
    if (out.removed && out.removed.length) bits.push(`${out.removed.length} taken off`);
    // NOTHING IS SILENT. A rule PILOT could not decide is reported, because it
    // means the file was left as it was found — which is not the same as
    // "nothing needed doing".
    if (out.skipped && out.skipped.length) bits.push(`${out.skipped.length} PILOT could not decide`);
    if (!bits.length) bits.push('nothing changed');
    setNote(`Re-checked the rules: ${bits.join(', ')}.${out.degraded ? ` Some of the file could not be read (${out.degraded}), so this is not the whole picture.` : ''}`);
  });

  const toggle = (id) => setOpen((prev) => {
    const next = new Set(prev);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });

  /* ── THE ADAPTER ────────────────────────────────────────────────────────────
   *
   * The shared components speak ONE verb — `onPatch(id, patch)` — because on the
   * short-term side one PATCH route accepts every field. Long-Term has a door per
   * verb instead (satisfy / waive / reopen / status / note), which is its own
   * design and not something to change to suit a component. So this is the
   * translation, and it is deliberately EXHAUSTIVE: a patch shape with no
   * Long-Term door says so in plain words on the row rather than doing nothing,
   * because a button that silently does nothing is the worst of the three
   * possible answers.
   */
  const [waiving, setWaiving] = useState(null);   // the condition id being waived

  const patchCondition = useCallback(async (id, patch) => {
    const p = patch || {};

    /* A SUPER ADMIN'S OVERRIDE has no Long-Term door. On the short-term side it
       clears a condition WITHOUT what it asks for and records the reason; here
       the recorded way through is a WAIVE, which requires the same reason and
       stores it in its own column. Say so and put them in the box, rather than
       calling a waive an override — they are different facts and the file has to
       be able to tell them apart a year later. */
    if (p.adminOverride) {
      setWaiving(id);
      say(id, 'Long-Term has no override door. Waiving the condition records the same reason on the file — type it below.');
      return false;
    }
    if (p.signedOff === true) return act(id, () => ltApi.conditionSatisfy(loanId, id), 'Marked satisfied.');
    if (p.signedOff === false || p.waived === false) {
      return act(id, () => ltApi.conditionReopen(loanId, id), 'Reopened.');
    }
    // "Not required" — Long-Term always asks WHY, so the box opens instead of the
    // condition being cleared on the spot.
    if (p.waived === true) { setWaiving(id); say(id, null); return false; }
    /* The loan officer's own step. It is a STAMP and moves no status — the back
       office still signs the condition off afterwards, which is the whole reason
       it is separate. Same two columns the short-term side has always used. */
    if (Object.prototype.hasOwnProperty.call(p, 'reviewed')) {
      const on = p.reviewed !== false;
      return act(id, () => ltApi.conditionMarkDone(loanId, id, on),
        on ? 'Marked done — the back office signs it off after you.' : 'Put back on your list.');
    }
    if (Object.prototype.hasOwnProperty.call(p, 'status')) {
      if (p.status === 'satisfied') return act(id, () => ltApi.conditionSatisfy(loanId, id), 'Marked satisfied.');
      const ltStatus = SHARED_STATUS_TO_LT[p.status];
      if (!ltStatus) {
        say(id, 'That status is not one a Long-Term condition can be moved to here.');
        return false;
      }
      return act(id, () => ltApi.conditionStatus(loanId, id, ltStatus), null);
    }
    if (Object.prototype.hasOwnProperty.call(p, 'notes')) {
      return act(id, () => ltApi.conditionNote(loanId, id, p.notes), 'Note saved.');
    }
    if (Object.prototype.hasOwnProperty.call(p, 'externalNote')) {
      say(id, 'Long-Term has no borrower-facing note on a condition yet.');
      return false;
    }
    say(id, 'That action is not available on the Long-Term side yet.');
    return false;
  }, [act, loanId, say]);

  const waive = (id, reason) => act(id, () => ltApi.conditionWaive(loanId, id, reason), 'Waived.');
  const removeCondition = (id) => act(id, () => ltApi.conditionRemove(loanId, id), 'Removed.');

  /* ── THE DOCUMENTS ─────────────────────────────────────────────────────────*/

  // A verdict that needs words (reject, accept-and-ask-for-more) and the delete
  // confirmation are typed ON THE ROW, for the same reason a waiver is: the
  // short-term host's dialog layer is that product's, and a second overlay host
  // inside one app is worse than either.
  const [docAsk, setDocAsk] = useState(null);     // { conditionId, doc, action }

  const reviewDoc = useCallback((conditionId, doc, action) => {
    if (action === 'accept') {
      return act(conditionId, () => ltApi.conditionDocReview(doc.id, { action: 'accept' }), 'Document accepted.');
    }
    // reject / accept_more / delete each need something from the person first.
    setDocAsk({ conditionId, doc, action });
    say(conditionId, null);
    return Promise.resolve(false);
  }, [act, say]);

  const submitDocAsk = async (text) => {
    if (!docAsk) return;
    const { conditionId, doc, action } = docAsk;
    let ok = false;
    if (action === 'reject') {
      ok = await act(conditionId, () => ltApi.conditionDocReview(doc.id, { action: 'reject', reason: text }), 'Document rejected.');
    } else if (action === 'accept_more') {
      ok = await act(conditionId, () => ltApi.conditionDocReview(doc.id, { action: 'accept', requestMore: true, note: text }), 'Accepted — one more document asked for.');
    } else if (action === 'delete') {
      ok = await act(conditionId, () => ltApi.conditionDocRemove(doc.id), 'Document deleted.');
    }
    if (ok) setDocAsk(null);
  };

  const downloadDoc = useCallback(async (conditionId, doc) => {
    setDlBusy(doc.id);
    try { await ltApi.conditionDocDownload(doc.id, doc.filename); }
    catch (e) { say(conditionId, e.message || 'Could not download that document.'); }
    finally { setDlBusy(null); }
  }, [say]);

  /* FILE A DOCUMENT INTO ONE OF THE CONDITION'S SLOTS.
     The order desk guesses from the filename when a return arrives; this is the
     human's correction after previewing it. The server refuses a slot the
     condition does not have, so a wrong pick answers with the reason rather than
     filing the document somewhere nothing renders. The whole list is reloaded on
     success because the SLOT BOARD above reads from the same documents. */
  const setDocSlot = useCallback(async (conditionId, doc, slot) => {
    setBusy(true);
    setRowErr((prev) => ({ ...prev, [conditionId]: null }));
    try {
      await ltApi.conditionDocSlot(doc.id, slot);
      await load();
    } catch (e) {
      say(conditionId, e.message || 'Could not file that document.');
    } finally { setBusy(false); }
  }, [say, load]);

  /* THE UPLOAD. The bytes are read here and posted to the /api/lt door, which is
     itself a thin caller of the ONE shared upload service — so a Long-Term
     document lands under exactly the rules a short-term one does. The bar comes
     from the shared upload store, published by Long-Term's own transport. */
  const uploadFiles = useCallback(async (conditionId, files, replaceDocumentId) => {
    if (!files || !files.length) return;
    setRowErr((prev) => ({ ...prev, [conditionId]: null }));
    let failed = 0;
    for (const file of Array.from(files)) {
      try {
        /* THE FILE GOES STRAIGHT ON THE WIRE. Reading it into base64 first put the
           whole document in a JSON body, which the server caps at 25 MB — and
           base64 inflates by about a third, so the real ceiling was nearer 18 MB
           of actual file. The streamed door takes what the short-term side takes.
           No `await readAsBase64` here is also why a large file no longer freezes
           the tab while the browser encodes it. */
        const up = await ltApi.conditionDocUpload(loanId, conditionId, {
          file,
          filename: file.name,
          contentType: file.type || 'application/octet-stream',
          ...(replaceDocumentId ? { replaceDocumentId } : {}),
        });
        /* THE MORTGAGE STATEMENT READS ITSELF. The server sends this back only
           for that one condition, and only when it either FILLED the answer in
           or read the document and came up short — so this box appears where it
           means something and nowhere else. It is a heads-up, not a result: the
           figures are in the answer below and a person still confirms them. */
        if (up && up.statementRead) {
          setRowRead((prev) => ({ ...prev, [conditionId]: up.statementRead }));
        }
      } catch (e) {
        failed += 1;
        // The uploading row already carries the reason in place; this puts it on
        // the condition too, because that row disappears once it is dismissed.
        say(conditionId, e.message || `Could not upload “${file.name}”.`);
      }
    }
    if (failed < Array.from(files).length) load();
  }, [loanId, load, say]);

  const pickFiles = useCallback((conditionId, replaceDocumentId) => {
    aimRef.current = { conditionId, replaceDocumentId: replaceDocumentId || null };
    if (fileRef.current) { fileRef.current.value = ''; fileRef.current.click(); }
  }, []);

  const onPicked = (e) => {
    const aim = aimRef.current;
    const files = e.target.files;
    aimRef.current = null;
    if (aim && files && files.length) uploadFiles(aim.conditionId, files, aim.replaceDocumentId);
  };

  const summary = (data && data.summary) || null;

  /* THE FILTER RUNS ON THE SHARED SHAPE, which is the whole reason one rule can
     serve both products: `asSharedCondition` is already the translation every
     shared component reads, so the predicate never learns that Long-Term stores
     a waive as its own status or that `in_progress` is what the other side
     calls `requested`. The default view is still THE WORK — a list of forty
     rows where thirty are finished is a list nobody reads — but it is now the
     ROLE-AWARE version of that: a loan officer's own Done stamp clears a row
     from their list without clearing it for the back office. */
  const groups = useMemo(() => {
    const list = (data && data.buckets) || [];
    return list.map((b) => ({
      ...b,
      conditions: (b.conditions || []).filter((c) => matchConditionFilter(asSharedCondition(c), condFilter, role)),
    }));
  }, [data, condFilter, role]);

  if (err) return <p style={{ margin: 0, color: RED, fontSize: 13 }}>{err}</p>;
  if (!data || !roleKnown) return <p style={{ margin: 0, color: MUTED, fontSize: 13 }}>Reading the conditions…</p>;

  return (
    <>
      {/* THE LOGIN-FREE LINK. Above the list on purpose: it is about the whole
          file rather than any one condition, and the moment a person wants it is
          when they are looking at what is still outstanding. It reads its own
          state from the server and offers nothing when the loan cannot be sent
          one. */}
      <LtSendConditions loanId={loanId} />

      {/* A DEGRADED READ IS NOT AN EMPTY FILE. */}
      {data.degraded && (
        <p style={{ margin: '0 0 10px', color: RED, fontSize: 13, lineHeight: 1.55 }}>
          Some of this could not be read just now, so what is below is not the whole picture.
        </p>
      )}

      <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap', alignItems: 'center', marginBottom: 12 }}>
        {summary && (
          <div style={{ fontSize: 13, color: MUTED }}>
            <strong style={{ color: INK, fontSize: 16 }}>{summary.outstanding}</strong> outstanding
            {summary.received > 0 && <> · <strong style={{ color: AMBER }}>{summary.received}</strong> received, not checked</>}
            {' '}· {summary.satisfied} satisfied
            {summary.waived > 0 && <> · {summary.waived} waived</>}
            {summary.notApplicable > 0 && <> · {summary.notApplicable} did not apply</>}
          </div>
        )}
        <div style={{ flex: 1 }} />
        {/* ONE control, not two. The old "Show finished" tick did half of what
            this picker does and would have sat beside it disagreeing — a row
            hidden by one and shown by the other is the state nobody can
            explain. The options are the MODULE'S, never typed out here, so a
            view added on one product cannot be missing from the other. */}
        <label style={{ fontSize: 13, color: INK, display: 'flex', gap: 6, alignItems: 'center' }}>
          <span style={{ color: MUTED }}>Show</span>
          <select className="input" style={{ maxWidth: 190 }} value={condFilter}
            onChange={(e) => setCondFilter(e.target.value)}
            title={conditionFilterHint(role)}>
            {CONDITION_FILTER_KEYS.map((k) => (
              <option key={k} value={k}>{conditionFilterLabel(k, role)}</option>
            ))}
          </select>
        </label>
        <button className="btn soft" onClick={evaluate} disabled={busy}
          title="Run the rules against this file again and bring its conditions into line.">
          Re-check the rules
        </button>
      </div>

      {note && (
        <div style={{ marginBottom: 12, padding: '9px 12px', border: `1px solid ${LINE}`,
          borderRadius: 8, background: '#FBF9F4', color: INK, fontSize: 13, lineHeight: 1.5 }}>
          {note}
        </div>
      )}

      {/* The one file picker for the whole screen — see the aim ref above. */}
      <input ref={fileRef} type="file" multiple style={{ display: 'none' }} onChange={onPicked} />

      {groups.map((b) => (
        <div key={b.key} style={{ marginBottom: 16 }}>
          <div style={{ display: 'flex', gap: 8, alignItems: 'baseline', flexWrap: 'wrap' }}>
            <div style={{ fontSize: 14, fontWeight: 700, color: INK }}>{b.label}</div>
            <div style={{ fontSize: 12, color: MUTED }}>
              {b.summary.outstanding} of {b.summary.total} still open
            </div>
            {b.retired && (
              <div style={{ fontSize: 12, color: AMBER }}>
                this gate was retired — these conditions are still here
              </div>
            )}
          </div>
          {b.blurb && <div style={{ fontSize: 12, color: MUTED, marginTop: 2 }}>{b.blurb}</div>}

          <div style={{ marginTop: 8, display: 'grid', gap: 6 }}>
            {b.conditions.map((c) => (
              <ConditionRow key={c.id} c={c} role={role} loanId={loanId}
                open={open.has(c.id)} onToggle={() => toggle(c.id)}
                busy={busy} problem={rowErr[c.id] || null} readOff={rowRead[c.id] || null}
                onChanged={load}
                onPatch={patchCondition}
                waiving={waiving === c.id}
                onWaiveOpen={() => setWaiving(c.id)}
                onWaiveCancel={() => setWaiving(null)}
                onWaive={async (reason) => { if (await waive(c.id, reason)) setWaiving(null); }}
                onRemove={() => removeCondition(c.id)}
                onUpload={(files) => uploadFiles(c.id, files)}
                onPick={(replaceDocumentId) => pickFiles(c.id, replaceDocumentId)}
                onReviewDoc={(doc, action) => reviewDoc(c.id, doc, action)}
                onDownloadDoc={(doc) => downloadDoc(c.id, doc)}
                onPreview={(doc) => setPreview(doc)}
                onSetSlot={(doc, slot) => setDocSlot(c.id, doc, slot)}
                dlBusy={dlBusy}
                docAsk={docAsk && docAsk.conditionId === c.id ? docAsk : null}
                onDocAskCancel={() => setDocAsk(null)}
                onDocAskSubmit={submitDocAsk}
              />
            ))}
            {b.conditions.length === 0 && (
              <div style={{ fontSize: 13, color: MUTED }}>
                {condFilter === 'all' ? 'Nothing here yet.' : 'Nothing to show here under this view.'}
              </div>
            )}
          </div>
        </div>
      ))}

      {groups.length === 0 && (
        <p style={{ margin: 0, color: MUTED, fontSize: 13, lineHeight: 1.55 }}>
          No conditions have been worked out for this file yet. Press <strong>Re-check the rules</strong>{' '}
          to run the library against it.
        </p>
      )}

      {/* THE PREVIEWER IS THE SHORT-TERM ONE — the PDF renderer, its find bar, the
          image and text branches and the layering rules all come with it. It is
          handed an authenticated loader because a sandboxed frame cannot carry
          the session token, which is the same reason the short-term side fetches
          the bytes rather than pointing a frame at the route. */}
      {preview && (
        <DocPreview
          title={preview.slot_label || preview.filename}
          filename={preview.filename}
          contentType={preview.content_type}
          load={() => ltApi.conditionDocBlob(preview.id)}
          onDownload={() => ltApi.conditionDocDownload(preview.id, preview.filename)}
          onClose={() => setPreview(null)}
        />
      )}
    </>
  );
}

/**
 * ONE CONDITION — the shared line, and the shared parts under it.
 *
 * The LONG-TERM box is this page's own (its border, its background, its
 * spacing); everything inside it that the owner named is the short-term
 * component doing its own job.
 */
function ConditionRow({
  c, role, loanId, open, onToggle, busy, problem, readOff, onChanged, onPatch,
  waiving, onWaiveOpen, onWaiveCancel, onWaive, onRemove,
  onUpload, onPick, onReviewDoc, onDownloadDoc, onPreview, onSetSlot, dlBusy,
  docAsk, onDocAskCancel, onDocAskSubmit,
}) {
  const it = asSharedCondition(c);
  const docs = (c.documents && c.documents.list) || [];
  const done = DONE_STATUSES.has(c.status);
  /* WHAT KIND OF CONDITION THIS IS decides whether it takes an upload at all.
     Read off the server's own vocabulary, so the screen and the library can
     never disagree about what a condition is. */
  const isForm = c.kind === 'form';
  const isOrder = c.kind === 'order';
  const [reason, setReason] = useState('');
  const [askText, setAskText] = useState('');
  const [confirmRemove, setConfirmRemove] = useState(false);

  useEffect(() => { if (!waiving) setReason(''); }, [waiving]);
  useEffect(() => { setAskText(''); }, [docAsk && docAsk.doc && docAsk.doc.id, docAsk && docAsk.action]);

  return (
    /* NO `overflow:hidden` HERE, EVER. The condition's own "More ▾" menu is a
       `position:absolute` popup (`.cond-more-menu`) rendered INSIDE this card, so
       a clip on the card cuts its options off at the card's edge — which is
       exactly what it did (owner-reported 2026-08-31). The card is a plain white
       rounded box with no child that paints to its corners, so the clip bought
       nothing; `styles.css` already records the same trap for `.lt-card`. */
    <div style={{ border: `1px solid ${LINE}`, borderRadius: 10, background: '#FFFFFF' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '4px 10px' }}>
        <div style={{ minWidth: 0, flex: 1 }}>
          <ConditionLine it={it} role={role} docs={docs} open={open}
            onToggle={onToggle} onPatch={onPatch} done={done} />
        </div>
        {/* A condition whose TEMPLATE is switched off is greyed WITH its reason
            rather than hidden — a feature that vanishes reads as one that broke. */}
        {c.enabled === false && (
          <span style={{ fontSize: 11, color: AMBER, whiteSpace: 'nowrap' }}>switched off</span>
        )}
        {open && <ConditionCollapse onToggle={onToggle} />}
      </div>

      {open && (
        <div style={{ padding: '0 14px 12px', borderTop: `1px solid ${LINE}` }}>
          {c.enabled === false && c.disabledReason && (
            <p style={{ margin: '10px 0 0', fontSize: 13, color: AMBER, lineHeight: 1.55 }}>{c.disabledReason}</p>
          )}

          {/* A hint whose first line is marked carries a requirement the owner
              wants UNMISSABLE; the shared renderer draws it as a callout and an
              ordinary hint exactly as before. */}
          {c.hint && <div style={{ marginTop: 10 }}><LoudHint hint={c.hint} className="" style={{ fontSize: 13, color: INK, lineHeight: 1.55 }} /></div>}

          {/* THE THREE CONDITIONS THAT ARE A CHOICE draw their own ways here —
              the mortgages on the credit report, the mortgage on the property
              being refinanced, and the vesting entity reading the borrower's
              profile. It self-hides on every other condition (the workspace
              door answers `null`), so nothing is added to an ordinary row. */}
          <LtConditionAnswer loanId={loanId} conditionId={c.id} onSaved={onChanged} />

          {/* ── WHAT KIND OF CONDITION THIS ACTUALLY IS ─────────────────────
              The library has carried `kind` on every condition since it was
              written — `form` on the contacts, `order` on the six orders — and
              this renderer READ NONE OF IT, so a contacts form and a title
              order both drew a file-upload box. Owner-reported 2026-08-31:
              "The file contacts condition has an upload slot. This is not the
              intent" and "Title ordered and insurance ordered now have a file
              upload. This is a different kind of condition."

              Both components SELF-HIDE on the wrong kind, so an ordinary
              document condition renders exactly as it did. */}
          <LtConditionContacts loanId={loanId} condition={c} onChanged={onChanged} />
          <LtConditionOrder loanId={loanId} condition={c} onChanged={onChanged} />

          {/* ── THE SLOTS, AS A BOARD ────────────────────────────────────────
              Owner-directed 2026-08-31: *"Each document should be linked to a
              slot within the condition … When the documents are coming back from
              the order, we can assign each document to each and every slot after
              previewing it."* A bullet list of names could not say which of them
              had arrived, so a condition with four documents on it and three
              slots filled looked exactly like one with nothing filed. */}
          {c.slots && c.slots.length > 0 && (
            <div style={{ marginTop: 10 }}>
              <div style={{ fontSize: 11, letterSpacing: '.06em', textTransform: 'uppercase',
                color: MUTED, fontWeight: 700 }}>What goes here</div>
              <ul style={{ listStyle: 'none', margin: '4px 0 0', padding: 0, fontSize: 13, color: INK }}>
                {c.slots.map((sl) => {
                  const inIt = docs.filter((d) => d.slot_label === sl.label && d.is_current !== false);
                  return (
                    <li key={sl.key} style={{ marginTop: 3, display: 'flex', gap: 8, alignItems: 'baseline', flexWrap: 'wrap' }}>
                      <span style={{ color: inIt.length ? GREEN : MUTED, fontWeight: 700, fontSize: 12 }}>
                        {inIt.length ? '✓' : '○'}
                      </span>
                      <span>{sl.label}{sl.required === false ? ' (optional)' : ''}</span>
                      <span style={{ color: MUTED, fontSize: 12.5, minWidth: 0, wordBreak: 'break-word' }}>
                        {inIt.length
                          ? inIt.map((d) => d.filename).join(', ')
                          : '— nothing filed here yet'}
                      </span>
                    </li>
                  );
                })}
              </ul>
            </div>
          )}

          {/* ── THE DOCUMENTS ────────────────────────────────────────────────
              A CONTACTS FORM AND AN ORDER TAKE NO UPLOAD. The contacts answer
              is a contact record; the order's answer arrives on the matching
              documents condition, which is where its slots live. An upload box
              on either is what the owner reported.

              But a document that somehow IS on one is still SHOWN — never
              hidden. Evidence that exists and is invisible is worse than a box
              that should not be there. */}
          {(!isForm && !isOrder) || docs.length > 0 ? (
          <div style={{ marginTop: 12 }}>
            <div style={{ fontSize: 11, letterSpacing: '.06em', textTransform: 'uppercase',
              color: MUTED, fontWeight: 700 }}>Documents</div>

            {/* The bar, in the place the finished document will appear. It draws
                only what the shared upload store holds, which Long-Term's own
                transport publishes into — so an upload shows its name and its
                percentage from the moment the file is chosen. */}
            <UploadRows target={`condition:${c.id}`} />

            {docs.length === 0 && !isForm && !isOrder && (
              <div style={{ fontSize: 13, color: MUTED, marginTop: 4 }}>
                Nothing uploaded against this condition yet.
              </div>
            )}
            {docs.map((doc) => (
              <div key={doc.id} style={{ marginTop: 8, paddingTop: 8, borderTop: `1px solid ${LINE}` }}>
                <div style={{ fontSize: 13, color: INK, wordBreak: 'break-word' }}>
                  {doc.slot_label ? <strong>{doc.slot_label}: </strong> : null}{doc.filename}
                  {doc.is_current === false && (
                    <span style={{ fontSize: 12, color: MUTED }}> · an older version</span>
                  )}
                </div>
                {c.slots && c.slots.length > 0 ? (
                  <div style={{ marginTop: 4, display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
                    <span style={{ fontSize: 12, color: MUTED }}>File under</span>
                    <select className="input" value={doc.slot_label || ''} disabled={busy}
                      style={{ fontSize: 12.5, padding: '3px 6px', maxWidth: 260 }}
                      onChange={(e) => onSetSlot(doc, e.target.value || null)}>
                      <option value="">Not filed yet</option>
                      {c.slots.map((sl) => (
                        <option key={sl.key} value={sl.label}>{sl.label}</option>
                      ))}
                    </select>
                  </div>
                ) : null}
                <DocActions doc={doc} role={role}
                  onReviewDoc={(d, action) => onReviewDoc(d, action)}
                  onDownloadDoc={onDownloadDoc}
                  onPreview={onPreview}
                  onReplace={() => onPick(doc.id)}
                  dlBusy={dlBusy} />
                {docAsk && docAsk.doc.id === doc.id && (
                  <DocAsk action={docAsk.action} value={askText} onChange={setAskText}
                    busy={busy} onCancel={onDocAskCancel} onSubmit={() => onDocAskSubmit(askText)} />
                )}
              </div>
            ))}

            {/* DRAG AND DROP, the owner's own words — the same zone the
                short-term side uses, so a drag out of the Outlook desktop app
                works here for the same reason it works there. */}
            {!isForm && !isOrder ? (
              <DropZone className="cond-drop" enabled={!busy} onFiles={onUpload}
                title="Drop a document here, or press Upload."
                style={{ marginTop: 10, padding: '10px 12px', border: `1px dashed ${LINE}`,
                  borderRadius: 8, display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
                <span style={{ fontSize: 13, color: MUTED }}>Drop a document here, or</span>
                <button type="button" className="btn soft small" disabled={busy}
                  onClick={() => onPick(null)}>Upload…</button>
              </DropZone>
            ) : null}
          </div>
          ) : null}

          {/* ── WHAT HAPPENED TO IT ────────────────────────────────────────── */}
          {c.status === 'waived' && (
            <p style={{ margin: '10px 0 0', fontSize: 13, color: INK, lineHeight: 1.55 }}>
              Waived{c.waivedBy ? ` by ${c.waivedBy}` : ''}{c.waivedAt ? ` on ${stamp(c.waivedAt)}` : ''}
              {c.waivedReason ? ` — ${c.waivedReason}` : ''}
            </p>
          )}
          {c.status === 'not_applicable' && (
            <p style={{ margin: '10px 0 0', fontSize: 13, color: INK, lineHeight: 1.55 }}>
              Did not apply to this file{c.waivedBy ? `, recorded by ${c.waivedBy}` : ''}
              {c.waivedAt ? ` on ${stamp(c.waivedAt)}` : ''}{c.waivedReason ? ` — ${c.waivedReason}` : ''}
            </p>
          )}

          {/* THE INTERNAL NOTE — the shared editor, so a note behaves the same in
              both products (shown when there is one, a quiet link when there is
              not, rather than an empty box on every row). */}
          <div style={{ marginTop: 10 }}>
            <ConditionNote it={it} onPatch={onPatch} />
          </div>

          {/* THE REFUSAL, WHERE THE BUTTON IS. The server names what is missing
              and what to do about it; this prints those words verbatim. */}
          {problem && (
            <p style={{ margin: '10px 0 0', padding: '8px 10px', borderRadius: 8,
              background: '#FBF1F1', color: RED, fontSize: 13, lineHeight: 1.5 }}>
              {problem}
            </p>
          )}

          {/* WHAT PILOT READ OFF THE STATEMENT. Two shapes, and they are different
              pieces of work for the person reading them: figures that were filled
              in and need CHECKING, or a document that was read and came up short,
              which needs TYPING. Neither is an error — the document is filed
              either way — so neither is coloured like one. Every colour here is an
              explicit dark on white: an `--ink*` token is a light paper colour in
              this palette and would render white on white. */}
          {readOff && readOff.status === 'filled' && (
            <div style={{ margin: '10px 0 0', padding: '10px 12px', borderRadius: 8,
              background: '#F3F7F4', border: `1px solid ${LINE}` }}>
              <p style={{ margin: 0, fontSize: 12, fontWeight: 600, color: GREEN,
                textTransform: 'uppercase', letterSpacing: '.04em' }}>
                Read off the statement
              </p>
              <dl style={{ margin: '6px 0 0', display: 'grid',
                gridTemplateColumns: 'auto 1fr', gap: '2px 10px', fontSize: 13 }}>
                <dt style={{ color: MUTED }}>Servicer</dt>
                <dd style={{ margin: 0, color: INK }}>{readOff.servicer || '—'}</dd>
                <dt style={{ color: MUTED }}>Loan number</dt>
                <dd style={{ margin: 0, color: INK }}>{readOff.loanNumber || '—'}</dd>
                <dt style={{ color: MUTED }}>Outstanding balance</dt>
                <dd style={{ margin: 0, color: INK }}>
                  {typeof readOff.balance === 'number'
                    ? readOff.balance.toLocaleString(undefined,
                      { style: 'currency', currency: 'USD' })
                    : '—'}
                </dd>
              </dl>
              {readOff.note && (
                <p style={{ margin: '8px 0 0', fontSize: 12, color: MUTED, lineHeight: 1.5 }}>
                  {readOff.note}
                </p>
              )}
            </div>
          )}
          {readOff && readOff.status === 'short' && (
            <p style={{ margin: '10px 0 0', padding: '8px 10px', borderRadius: 8,
              background: '#FBF6EA', color: AMBER, fontSize: 13, lineHeight: 1.5 }}>
              PILOT read the document but could not fill it in — {readOff.detail}.
              Type what it says into the answer below.
            </p>
          )}

          {waiving ? (
            <div style={{ marginTop: 12 }}>
              <label style={{ fontSize: 12, color: MUTED, display: 'block', marginBottom: 4 }}>
                Why is this being waived? This is what somebody reads a year from now.
              </label>
              <textarea className="input" rows={2} style={{ width: '100%', fontSize: 14 }}
                value={reason} onChange={(e) => setReason(e.target.value)} />
              <div style={{ display: 'flex', gap: 8, marginTop: 8, flexWrap: 'wrap' }}>
                <button className="btn" disabled={busy || reason.trim().length < 4}
                  onClick={() => onWaive(reason)}>Waive it</button>
                <button className="btn ghost" onClick={onWaiveCancel}>Cancel</button>
              </div>
            </div>
          ) : (
            <div style={{ marginTop: 12 }}>
              {/* THE SHARED ACTION BAR — one prominent next step, everything else
                  behind More, the plain sentence under it saying what will
                  happen, and the audit line saying who cleared it and when.
                  `team` is deliberately absent (Long-Term has no assignment door,
                  and the control hides itself), and `canSendBack` is false
                  because the borrower's own long-term view is its own door. */}
              <ConditionActions it={it} role={role} onPatch={onPatch}
                docs={docs} canSendBack={false}
                extra={!done ? (
                  <button className="btn ghost small" onClick={onWaiveOpen}
                    title="Clear this condition without what it asks for, and record why. The reason is saved on the file.">
                    Waive with a reason…
                  </button>
                ) : null} />
              {c.origin === 'manual' && (
                <div style={{ marginTop: 8, display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                  {confirmRemove ? (
                    <>
                      <button className="btn ghost small" style={{ color: RED }} disabled={busy}
                        onClick={() => { setConfirmRemove(false); onRemove(); }}>
                        Yes, take it off the file
                      </button>
                      <button className="btn ghost small" onClick={() => setConfirmRemove(false)}>Keep it</button>
                    </>
                  ) : (
                    <button className="btn ghost small" onClick={() => setConfirmRemove(true)} disabled={busy}>
                      Remove this condition
                    </button>
                  )}
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * THE ONE THING A DOCUMENT VERDICT NEEDS FROM A PERSON, asked on the row.
 *
 * A rejection always needs a reason and an accept-and-ask-for-more always needs
 * a note — both are the SHARED service's own rules, refused there, so the box is
 * required here rather than letting somebody send an empty one and read the
 * refusal back. A delete asks for nothing but confirmation, because it is
 * permanent.
 */
function DocAsk({ action, value, onChange, busy, onCancel, onSubmit }) {
  const copy = {
    reject: {
      label: 'Why is this being rejected? The borrower is told this.',
      go: 'Reject it',
      min: 1,
    },
    accept_more: {
      label: 'What else is needed on this condition? The borrower is told this.',
      go: 'Accept, and ask for one more',
      min: 1,
    },
    delete: {
      label: 'This deletes the document permanently — it is not kept as an old version.',
      go: 'Yes, delete it',
      min: 0,
    },
  }[action];
  if (!copy) return null;
  return (
    <div style={{ marginTop: 8 }}>
      <label style={{ fontSize: 12, color: MUTED, display: 'block', marginBottom: 4 }}>{copy.label}</label>
      {copy.min > 0 && (
        <textarea className="input" rows={2} style={{ width: '100%', fontSize: 14 }}
          value={value} onChange={(e) => onChange(e.target.value)} />
      )}
      <div style={{ display: 'flex', gap: 8, marginTop: 8, flexWrap: 'wrap' }}>
        <button className="btn small" disabled={busy || (copy.min > 0 && value.trim().length < copy.min)}
          style={action === 'delete' ? { color: RED } : undefined}
          onClick={onSubmit}>{copy.go}</button>
        <button className="btn ghost small" onClick={onCancel}>Cancel</button>
      </div>
    </div>
  );
}
