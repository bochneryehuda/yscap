import { useEffect, useState } from 'react';

/* STALE-BUILD WATCHDOG (owner-reported 2026-07-15 night: a long-lived tab ran
 * yesterday's bundle — a timezone-shifted DOB, missing screens — while a
 * freshly-reloaded admin saw the current build). Every 5 minutes and on window
 * focus, the DEPLOYED bundle hash is read from /api/health and compared with
 * the bundle this tab is RUNNING. Deliberately an /api/ path: the service
 * worker never intercepts those — a direct index.html fetch was answered from
 * the SW's own cache (which by construction references the running bundle),
 * so the check compared the build against itself and never fired.
 * Shared by EVERY layout shell (staff + borrower) per the CLAUDE.md rule. */
export function useStaleBuild() {
  const [stale, setStale] = useState(false);
  useEffect(() => {
    let alive = true;
    const running = (() => {
      const s = document.querySelector('script[src*="/assets/index-"]');
      const m = s && s.src && s.src.match(/index-([\w-]+)\.js/);
      return m ? m[1] : null;
    })();
    if (!running) return undefined;
    const check = () => fetch('/api/health', { cache: 'no-store' })
      .then((r) => (r.ok ? r.json() : null))
      .then((h) => { if (alive && h && h.bundle && h.bundle !== running) setStale(true); })
      .catch(() => {});
    check();
    const t = setInterval(check, 5 * 60 * 1000);
    const onFocus = () => check();
    window.addEventListener('focus', onFocus);
    return () => { alive = false; clearInterval(t); window.removeEventListener('focus', onFocus); };
  }, []);
  return stale;
}

export function StaleBuildBanner({ stale }) {
  if (!stale) return null;
  return (
    <div role="alert" style={{ position: 'fixed', top: 0, left: 0, right: 0, zIndex: 1000,
      background: '#AE8746', color: '#fff', padding: '8px 14px', display: 'flex',
      alignItems: 'center', justifyContent: 'center', gap: 12, fontSize: 14 }}>
      <span>PILOT was updated — refresh to get the latest screens and fixes.</span>
      <button className="btn small" style={{ background: '#fff', color: '#141B22', border: 'none' }}
        onClick={() => window.location.reload()}>Refresh now</button>
    </div>
  );
}
