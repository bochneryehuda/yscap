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
    pending.current = { ...(pending.current || {}), ...partial };
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
