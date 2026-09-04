'use strict';
/**
 * WHY EVERY INVESTOR SAID NO — BOTH RATE SHEETS, ONE LIST, ONE DEFINITION.
 *
 * ── WHY THIS FILE EXISTS ───────────────────────────────────────────────────
 * The COMBINED engine's `/combined/disqualify` door held ~90 lines of real
 * behaviour: two halves fetched two different ways, each settled independently,
 * refusals carried rather than swallowed, and one entry per investor. The GENERAL
 * engine had nothing comparable — its own `/disqualify` takes a SCENARIO and asks
 * Lender Price alone, so a LoanNEX refusal could never reach its not-eligible list
 * even on a board whose answer already held the tree id.
 *
 * ⛔ SO THE BEHAVIOUR IS LIFTED OUT RATHER THAN COPIED. Two engines each holding
 * their own copy of "how are the two halves joined, what does ready mean, what
 * happens when one fails" is two chances for the answers to drift — and the one
 * that drifts is the one an officer reads a refusal off. This is the ONE
 * definition; both doors call it.
 *
 * PURE OF HTTP: it takes handles and clients and answers a body. Every vendor
 * client is INJECTED, so the whole thing is provable with no network.
 */

const reasonOf = (e) => String((e && e.message) || e || 'unknown').slice(0, 300);

/**
 * Fetch and join the two halves.
 *
 * @param {object} h            `{ pollKey, treeId, portal, reveal }` — the handles the
 *                              price answer returned. The PORTAL comes from the caller's
 *                              own copy; it is never told one.
 * @param {object} deps         `{ lp, nex, programs }` — the two vendor clients and the
 *                              module that decorates a refused lender with its white label.
 */
async function collect(h = {}, deps = {}) {
  const { lp, nex, programs } = deps;
  const reveal = h.reveal === true;
  const pollKey = h.pollKey ? String(h.pollKey) : null;
  const treeId = h.treeId ? String(h.treeId) : null;

  const pending = []; const failed = []; const lenders = [];
  /* The half is named by its MECHANISM unless an admin asked to see the source — the
     same rule the board and the explain handle already apply. */
  const POLLED = reveal ? 'lenderprice' : 'polled';
  const TREE = reveal ? 'loannex' : 'tree';

  let polledReady = false;
  if (pollKey && lp) {
    try {
      const pr = await lp.pollDisqualifiedByKey(pollKey);
      if (pr.unknown) {
        failed.push({ half: POLLED, reason: 'unknown_search_key',
          message: 'That search has expired — price the loan again to start a fresh ineligible list.' });
      } else if (!pr.ok) {
        failed.push({ half: POLLED, reason: pr.error || 'error', message: pr.message || null });
      } else if (!pr.ready) {
        pending.push(POLLED);
      } else {
        polledReady = true;
        const parsed = pr.parsed || lp.parseDisqualified(pr.raw);
        for (const l of programs.decorateDisqualifiedLenders((parsed && parsed.lenders) || [])) {
          lenders.push(reveal ? { ...l, source: 'lenderprice' } : l);
        }
      }
    } catch (e) {
      failed.push({ half: POLLED, reason: e.code || 'error', message: reasonOf(e) });
    }
  }

  let treeReady = false;
  if (treeId && nex) {
    try {
      const r = await nex.fails(treeId, { portal: h.portal });
      treeReady = true;
      for (const l of programs.decorateDisqualifiedLenders(((r.disqualified || {}).lenders) || [])) {
        lenders.push(reveal ? { ...l, source: 'loannex' } : l);
      }
    } catch (e) {
      failed.push({ half: TREE, reason: e.code || 'error', message: reasonOf(e) });
    }
  }

  /**
   * ONE INVESTOR, ONE ENTRY. A refused investor can legitimately appear on BOTH sheets —
   * the board joins the two by `investorKey` and this list must join them the same way, or
   * the screen shows one company twice under one white label and reads as a bug. An
   * investor the registry cannot key is kept under its own name rather than dropped: an
   * unkeyed refusal is still a refusal, and dropping it would quietly shorten the list.
   */
  const byKey = new Map();
  for (const l of lenders) {
    const k = l.investorKey || ('name:' + String(l.lender || '').toLowerCase());
    const prev = byKey.get(k);
    if (!prev) byKey.set(k, { ...l, items: [...(l.items || [])] });
    else prev.items.push(...(l.items || []));
  }
  const mergedLenders = [...byKey.values()];

  return {
    ok: true,
    /* Ready when ANYTHING arrived — a list that says "still computing" while holding real
       refusals would hide the answer it already has. */
    ready: polledReady || treeReady,
    pending,
    failed,
    disqualified: {
      lenders: mergedLenders,
      lenderCount: mergedLenders.length,
      itemCount: mergedLenders.reduce((n, l) => n + ((l.items || []).length), 0),
    },
    retryAfterMs: pending.length ? 2000 : null,
    message: pending.length
      ? 'One of the two rate sheets is still working out its ineligible list — ask again shortly.'
      : null,
  };
}

/** The refusal a door answers when it was handed no handle at all. */
const NO_HANDLE = Object.freeze({
  ok: false,
  error: 'missing_handle',
  message: 'Send the ineligibility handle the price answer returned.',
});

module.exports = { collect, NO_HANDLE, _internals: { reasonOf } };
