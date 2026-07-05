import React, { useEffect, useState } from 'react';

/* Shows an "Install app" button when the browser offers PWA installation
   (Chrome/Edge fire `beforeinstallprompt`). Hidden once installed or when the
   browser doesn't support prompted install (e.g. iOS Safari uses Share → Add
   to Home Screen, which needs no button). */
export default function InstallButton() {
  const [deferred, setDeferred] = useState(null);
  const [hidden, setHidden] = useState(false);

  useEffect(() => {
    const onPrompt = (e) => { e.preventDefault(); setDeferred(e); };
    const onInstalled = () => { setHidden(true); setDeferred(null); };
    window.addEventListener('beforeinstallprompt', onPrompt);
    window.addEventListener('appinstalled', onInstalled);
    // Already running as an installed app? Then don't offer install.
    if (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches) setHidden(true);
    return () => {
      window.removeEventListener('beforeinstallprompt', onPrompt);
      window.removeEventListener('appinstalled', onInstalled);
    };
  }, []);

  if (hidden || !deferred) return null;
  return (
    <button className="btn ghost small" title="Install the YS Capital Group app on this device"
      onClick={async () => { deferred.prompt(); try { await deferred.userChoice; } catch { /* ignore */ } setDeferred(null); }}>
      ⤓ Install app
    </button>
  );
}
