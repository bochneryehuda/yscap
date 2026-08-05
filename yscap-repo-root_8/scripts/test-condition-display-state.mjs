/**
 * The condition DISPLAY STATE — the dot colour + small status wording (owner-directed
 * 2026-08-05). Richer than the raw status column: it must say from the OUTSIDE
 * whether a condition has documents in it, if one is waiting to be reviewed, was
 * accepted but not yet signed off, or was rejected — and it must show the worst news
 * first so a rejected document is never hidden.
 *
 * PURE — imports the app-v2 helper directly. In `npm test`.
 */
import assert from 'assert';
import { conditionDisplayState, CONDITION_DISPLAY } from '../app-v2/src/lib/conditions-vocab.js';

let failures = 0;
const ok = (c, m) => { console.log(`${c ? 'PASS' : 'FAIL'} ${m}`); if (!c) failures++; };
const S = (it, docs) => conditionDisplayState(it, docs);

// Cleared states win over everything.
ok(S({ signed_off_at: '2026-08-05T10:00:00Z' }).key === 'signed', 'signed off → signed (green)');
ok(S({ signed_off_at: '2026-08-05T10:00:00Z' }).cls === 'cond-satisfied', 'signed → cond-satisfied colour');
ok(S({ waived_at: '2026-08-05T10:00:00Z' }).key === 'waived', 'waived → waived (green)');
// A signed-off condition with a still-pending doc is still "signed" (worst news is not pending here).
ok(S({ signed_off_at: 'x' }, [{ review_status: 'pending' }]).key === 'signed', 'signed beats a leftover pending doc');

// Rejected is worst news among the open states.
ok(S({ status: 'issue' }).key === 'rejected', 'issue status → rejected (red)');
ok(S({ status: 'received' }, [{ review_status: 'rejected' }]).key === 'rejected', 'a rejected doc → rejected even if status is received');
ok(S({ status: 'received' }, [{ review_status: 'rejected' }, { review_status: 'pending' }]).key === 'rejected', 'rejected shown first, before the pending one');

// A document waiting to be reviewed.
ok(S({ status: 'received' }, [{ review_status: 'pending' }]).key === 'review', 'a pending doc → to review (gold)');
ok(S({ status: 'received' }, [{ review_status: 'pending' }]).cls === 'cond-received', 'review → gold colour');
ok(/2 to review/.test(S({ status: 'received' }, [{ review_status: 'pending' }, { review_status: 'pending' }]).label), 'two pending docs → "2 to review"');

// Documents accepted but not signed off — the NEW distinct blue state.
ok(S({ status: 'received' }, [{ review_status: 'accepted' }]).key === 'accepted', 'accepted doc, not signed → accepted');
ok(S({ status: 'received' }, [{ review_status: 'accepted' }]).cls === 'cond-accepted', 'accepted → the distinct blue colour');

// Asked the borrower, nothing in yet.
ok(S({ status: 'requested' }).key === 'requested', 'requested status → asked the borrower (teal)');
ok(S({ status: 'requested' }).cls === 'cond-requested', 'requested → teal colour');

// Not started.
ok(S({ status: 'outstanding' }).key === 'outstanding', 'outstanding → not started (grey)');
ok(S({}).key === 'outstanding', 'a bare row → not started');

// A superseded (not-current) doc is ignored.
ok(S({ status: 'received' }, [{ review_status: 'pending', is_current: false }]).key === 'outstanding', 'a superseded doc does not count');

// Every state exposes a next-step sentence + a colour class.
for (const k of Object.keys(CONDITION_DISPLAY)) {
  ok(CONDITION_DISPLAY[k].next && CONDITION_DISPLAY[k].next.length > 5, `${k} has a next-step sentence`);
  ok(/^cond-/.test(CONDITION_DISPLAY[k].cls), `${k} has a cond-* colour class`);
}
// hasDocs is reported.
ok(S({ status: 'received' }, [{ review_status: 'accepted' }]).hasDocs === true, 'hasDocs true when a document is present');
ok(S({ status: 'outstanding' }).hasDocs === false, 'hasDocs false with no documents');

if (failures) { console.error(`\n${failures} FAILED`); process.exit(1); }
console.log('\nAll condition display-state checks passed.');
