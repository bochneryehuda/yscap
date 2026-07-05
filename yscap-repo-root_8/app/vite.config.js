import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Builds the borrower portal into the backend's web/portal/ folder, so the
// existing Express static-serving deploys it with NO Render build changes.
// base '/portal/' => assets resolve under /portal/. HashRouter handles routing
// entirely client-side, so no server SPA-fallback surgery is required.
export default defineConfig({
  plugins: [react()],
  base: '/portal/',
  build: {
    outDir: '../web/portal',
    emptyOutDir: true,
  },
});
