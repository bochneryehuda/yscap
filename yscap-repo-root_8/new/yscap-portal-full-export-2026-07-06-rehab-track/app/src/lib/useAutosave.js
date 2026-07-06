import { useEffect, useRef, useState, useCallback } from 'react';

/* Debounced autosave. Call save(partial) as fields change; batches writes and
   PUTs after `delay` ms of quiet. Exposes {status,save,flush}. */
export function useAutosave(saveFn, delay = 900) {
  const [status, setStatus] = useState('idle'); // idle|saving|saved|error
  const timer = useRef(null);
  const pending = useRef(null);

  const run = useCallback(async () => {
    if (pending.current == null) return;
    const payload = pending.current; pending.current = null;
    setStatus('saving');
    try { await saveFn(payload); setStatus('saved'); }
    catch { setStatus('error'); }
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

  const flush = useCallback(async () => {
    if (timer.current) clearTimeout(timer.current);
    await run();
  }, [run]);

  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);
  return { status, save, flush };
}
