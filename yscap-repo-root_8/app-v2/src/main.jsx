import React from 'react';
import { createRoot } from 'react-dom/client';
import './styles.css';
import App from './App.jsx';
createRoot(document.getElementById('root')).render(<App />);

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
