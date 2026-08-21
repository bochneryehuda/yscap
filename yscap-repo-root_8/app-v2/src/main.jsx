import React from 'react';
import { createRoot } from 'react-dom/client';
import './styles.css';
import App from './App.jsx';
import { installStrayDropGuard } from './lib/stray-drop-guard.js';
import { showMessage } from './lib/dialog.js';
createRoot(document.getElementById('root')).render(<App />);

/* A FILE DROPPED IN THE WRONG PLACE MUST NOT DESTROY THE PAGE (owner item 6,
   2026-08-21: dropping a document outside an upload zone "will close your file,
   explode it"). That is the browser's default — it navigates the tab to the file and
   the whole app goes with it, unsaved work included. Installed once, at start-up, so
   it covers every screen and the margins outside React's root too; it only ever sees
   drops that no upload zone claimed. */
installStrayDropGuard((e) => {
  showMessage(
    'That document was dropped outside an upload box, so nothing was uploaded — and PILOT stopped '
    + 'the browser from opening the file and closing your work.\n\n'
    + 'Drop it straight onto the condition, the document slot, or the upload area you want it filed against.',
    { title: 'Nothing was uploaded' },
  );
  void e;
});

// Register the PWA service worker so the portal is installable and opens fast.
// It caches only the static shell — never API/auth/PII (see public/sw.js).
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register(import.meta.env.BASE_URL + 'sw.js').catch(() => {});
  });
  // When a NEW service worker takes control of this tab (a deploy just landed
  // and the sw.js version changed), reload ONCE so the tab runs the fresh
  // bundle instead of yesterday's code. Without this, a long-lived tab (or an
  // installed-app window) could keep running an old build — including old,
  // buggy session logic — until the user cleared site data by hand (the
  // recurring "I have to clear my cookies" logout reports, 2026-07-29).
  // Guards:
  // - `hadController`: on the very FIRST install, clients.claim() fires
  //   controllerchange on a page that was never controlled — that page is
  //   already running the freshest code, so reloading it would be a pointless
  //   flicker (and on a slow connection, a visible double-load).
  // - `reloaded`: one reload per page lifetime, so a misbehaving SW can never
  //   put the tab into a reload loop.
  let hadController = !!navigator.serviceWorker.controller;
  let reloaded = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (!hadController) { hadController = true; return; }
    if (reloaded) return;
    reloaded = true;
    window.location.reload();
  });
}
