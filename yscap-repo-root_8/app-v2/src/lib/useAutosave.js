import { useEffect, useRef, useState, useCallback } from 'react';

/* Debounced autosave. Call save(partial) as fields change; batches writes and
   PUTs after `delay` ms of quiet. Exposes {status,save,flush}. */
export function useAutosave(saveFn, delay = 900) {
  const [status, setStatus] = useState('idle'); // idle|saving|saved|error
  const timer = useRef(null);
  const pending = useRef(null);

  const run = useCallback(async (rethrow = false) => {
    if (pending.current == null) return;
    const payload = pending.current; pending.current = null;
    setStatus('saving');
    try { await saveFn(payload); setStatus('saved'); }
    catch (e) {
      // Re-queue the failed batch UNDER anything typed since, so the next edit
      // (or flush) retries it — a transient failure no longer silently drops
      // the fields that were in flight.
      const newer = pending.current || {};
      pending.current = { ...payload, ...newer };
      if (payload.data || newer.data) pending.current.data = { ...(payload.data || {}), ...(newer.data || {}) };
      setStatus('error');
      if (rethrow) throw e;
    }
  }, [saveFn]);

  const save = useCallback((partial) => {
    const prev = pending.current || {};
    // Deep-merge the nested `data` object: callers save one field at a time as
    // { data: { field: value } }, and two edits inside the debounce window would
    // otherwise collide on `data` and drop the earlier field (silent data loss).
    pending.current = { ...prev, ...partial };
    if (partial && partial.data) pending.current.data = { ...(prev.data || {}), ...partial.data };
    setStatus('saving');
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(run, delay);
  }, [run, delay]);

  // flush() REJECTS if the final write fails — callers that submit right after
  // (Apply's step/submit) must know the last edits didn't reach the server,
  // instead of submitting a draft that's silently missing them.
  const flush = useCallback(async () => {
    if (timer.current) clearTimeout(timer.current);
    await run(true);
  }, [run]);

  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);
  return { status, save, flush };
}
