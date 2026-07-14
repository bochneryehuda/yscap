import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Builds the PILOT (V2) portal into web/v2/portal/. V2 IS THE DEFAULT
// (owner-directed 2026-07-14): src/server.js mounts web/v2 at the ROOT, so
// this bundle serves at /portal/ — base '/portal/' keeps the shell, assets,
// service worker, and manifest all self-consistent there. The old /v2/portal/
// URLs keep working through the web/ fallthrough mount.
export default defineConfig({
  plugins: [react()],
  base: '/portal/',
  build: {
    outDir: '../web/v2/portal',
    emptyOutDir: true,
  },
});
