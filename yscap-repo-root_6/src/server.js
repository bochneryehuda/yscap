/**
 * YS Capital Portal — Express entrypoint.
 * Serves the existing static site (web/) UNTOUCHED and exposes the API.
 * The site's pricing/guideline engines are never imported or altered here;
 * they keep running client-side. We only add /api endpoints + hooks.
 */
const express = require('express');
const path = require('path');
const cfg = require('./config');

const app = express();
app.use(express.json({ limit: '25mb' }));   // room for base64 document uploads

// --- API ---
app.get('/api/health', (req, res) =>
  res.json({ ok: true, env: cfg.env, emailProvider: cfg.emailProvider, storage: cfg.storageProvider, ts: Date.now() }));
app.use('/auth', require('./auth').router);
app.use('/api/intake', require('./routes/intake'));
app.use('/api/borrower', require('./routes/borrower'));
app.use('/api/staff', require('./routes/staff'));
app.use('/api/admin', require('./routes/admin'));

// --- Static site (your existing build drops into web/) ---
const webDir = path.join(__dirname, '..', cfg.webDir);
app.use(express.static(webDir));
app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api') || req.path.startsWith('/auth')) return next();
  res.sendFile(path.join(webDir, 'index.html'), (err) => err && next());
});

// 404 for unmatched API routes
app.use((req, res) => res.status(404).json({ error: 'not found' }));

if (require.main === module) {
  app.listen(cfg.port, () => {
    console.log(`YS Capital Portal on :${cfg.port} (${cfg.env}) — email:${cfg.emailProvider} storage:${cfg.storageProvider}`);
    if (cfg.env === 'production' || process.env.RUN_SYNC === '1') {
      try { require('./sync/queue').start(); } catch (e) { console.warn('sync queue not started:', e.message); }
    }
  });
}
module.exports = app;
