'use strict';
/**
 * Admin Labeling Console (owner-directed 2026-07-22, R3.3).
 *
 * Super-admins train the Azure Custom classifier + per-type neural extractors
 * by TAGGING past documents. Each tag = one row in `label_examples` pointing
 * to the raw PDF bytes in the pilot-doc-ai-labels blob container.
 *
 * NEVER trains automatically — a super-admin explicitly kicks off training
 * from the UI once at least ~5 examples per doc type are on file. Per HARD
 * RULE, the AI does not silently retrain itself.
 *
 * Mounted at /api/admin/labeling behind requireAuth + requireStaff.
 */
const router = require('express').Router();
const db = require('../db');
const { requireRole } = require('../auth');
const azureBlob = require('../lib/ai/azure-blob');
const azc = require('../lib/ai/azure-custom');
const { decodeUploadBase64 } = require('../lib/upload-bytes');

// Canonical set (drop legacy aliases from the picker — DOC_TYPES has photo_id/hoi
// mapping to canonical types).
const DOC_TYPES = Object.keys(azc.DOC_TYPES).filter((k) => !['photo_id', 'hoi'].includes(k));

/**
 * List label examples, grouped by (target_project, doc_type) with counts +
 * per-type readiness (need ≥5 to train each extractor; the classifier needs
 * ≥5 per type it will distinguish).
 */
router.get('/examples', requireRole('super_admin'), async (req, res) => {
  try {
    const r = await db.query(
      `SELECT id, application_id, document_id, doc_type, target_project, pages,
              blob_url, blob_size_bytes, original_filename, uploaded_at,
              uploaded_by_staff_id, trained_at, trained_model_id
         FROM label_examples ORDER BY uploaded_at DESC LIMIT 2000`);
    const counts = {};
    const readyThreshold = 5;
    for (const row of r.rows) {
      const key = `${row.target_project}:${row.doc_type}`;
      counts[key] = (counts[key] || 0) + 1;
    }
    const summary = {
      classifier: DOC_TYPES.map(t => ({ docType: t, count: counts[`classifier:${t}`] || 0,
        ready: (counts[`classifier:${t}`] || 0) >= readyThreshold })),
      extractor: DOC_TYPES.map(t => ({ docType: t, count: counts[`extractor:${t}`] || 0,
        ready: (counts[`extractor:${t}`] || 0) >= readyThreshold })),
    };
    res.json({ ok: true, examples: r.rows, summary, readyThreshold, blobConfigured: azureBlob.configured(),
      classifierConfigured: azc.classifierConfigured(),
      docTypes: DOC_TYPES });
  } catch (e) { res.status(500).json({ error: e.message || 'could not load labels' }); }
});

/**
 * Upload + label a document. Uses the shared upload chokepoint
 * (upload-bytes.decodeUploadBase64) so the base64 decode is safe.
 * Body: { filename, contentType, dataBase64, docType, targetProject:'classifier'|'extractor',
 *         pages?:string, applicationId?:string, documentId?:string }
 */
router.post('/examples', requireRole('super_admin'), async (req, res) => {
  try {
    if (!azureBlob.configured()) return res.status(400).json({ error: 'Azure Blob storage is not configured — add AZURE_DOCAI_LABEL_SAS_TOKEN or AZURE_DOCAI_LABEL_ACCOUNT_KEY in Render.' });
    const b = req.body || {};
    const docType = String(b.docType || '').trim();
    const target = String(b.targetProject || '').trim();
    if (!DOC_TYPES.includes(docType)) return res.status(400).json({ error: `docType must be one of: ${DOC_TYPES.join(', ')}` });
    if (!['classifier', 'extractor'].includes(target)) return res.status(400).json({ error: 'targetProject must be classifier or extractor' });
    if (!b.filename || !b.dataBase64) return res.status(400).json({ error: 'filename + dataBase64 required' });

    let buf;
    try { buf = decodeUploadBase64(b.dataBase64); }
    catch (e) { return res.status(400).json({ error: 'bad upload: ' + (e && e.message || 'decode failed') }); }
    if (!buf || !buf.length) return res.status(400).json({ error: 'empty upload' });

    // Object key: <target>/<docType>/<applicationId or _>/<timestamp>_<safefilename>
    const safeName = String(b.filename).replace(/[^\w.\-]/g, '_').slice(0, 100);
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    const objectKey = `${target}/${docType}/${b.applicationId || '_'}/${ts}_${safeName}`;

    const up = await azureBlob.put({ objectKey, buffer: buf, contentType: b.contentType || 'application/pdf' });
    if (!up.ok) return res.status(502).json({ error: up.reason });

    const ins = await db.query(
      `INSERT INTO label_examples
         (application_id, document_id, doc_type, target_project, pages, blob_url,
          blob_size_bytes, original_filename, uploaded_by_staff_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
      [b.applicationId || null, b.documentId || null, docType, target,
       b.pages || null, up.url, up.sizeBytes || buf.length,
       b.filename, req.actor.staffId]);
    res.json({ ok: true, example: ins.rows[0] });
  } catch (e) { res.status(500).json({ error: e.message || 'label upload failed' }); }
});

router.delete('/examples/:id', requireRole('super_admin'), async (req, res) => {
  try {
    // Do NOT delete the blob — training runs may still reference it. Only remove
    // the DB row so the example is no longer offered to the next training run.
    const r = await db.query(`DELETE FROM label_examples WHERE id=$1 RETURNING id`, [req.params.id]);
    if (!r.rows[0]) return res.status(404).json({ error: 'not found' });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message || 'delete failed' }); }
});

/**
 * Request a training run. This records the run row and returns instructions —
 * PILOT does NOT trigger Azure's training itself yet (Azure Doc Intelligence
 * Studio kicks off the actual custom-model train against the labeled blobs;
 * automating it would require a build API call that varies by model type).
 * The user starts the actual train from the Studio (or a follow-up PR wires
 * the build endpoint). This route stamps the intent + counts + audit.
 */
router.post('/training-runs', requireRole('super_admin'), async (req, res) => {
  try {
    const b = req.body || {};
    const target = String(b.targetProject || '').trim();
    if (!['classifier', 'extractor'].includes(target)) return res.status(400).json({ error: 'targetProject must be classifier or extractor' });
    const docType = target === 'extractor' ? String(b.docType || '').trim() : null;
    if (target === 'extractor' && !DOC_TYPES.includes(docType)) return res.status(400).json({ error: `docType required for extractor training` });

    const modelId = String(b.modelId || '').trim();
    if (!modelId) return res.status(400).json({ error: 'modelId (Azure Custom project id) required' });

    // Count untrained examples of the right (target, doc_type) shape.
    let params, sql;
    if (target === 'classifier') {
      sql = `SELECT count(*)::int AS n FROM label_examples WHERE target_project='classifier' AND trained_at IS NULL`;
      params = [];
    } else {
      sql = `SELECT count(*)::int AS n FROM label_examples WHERE target_project='extractor' AND doc_type=$1 AND trained_at IS NULL`;
      params = [docType];
    }
    const cnt = ((await db.query(sql, params)).rows[0] || {}).n || 0;

    const ins = await db.query(
      `INSERT INTO label_training_runs (target_project, doc_type, model_id, requested_by_staff_id, example_count, status)
       VALUES ($1,$2,$3,$4,$5,'queued') RETURNING *`,
      [target, docType, modelId, req.actor.staffId, cnt]);
    // Best-effort stamp the examples as "sent to this training run" so the next
    // run doesn't reuse them by default.
    if (target === 'classifier') {
      await db.query(`UPDATE label_examples SET trained_at=now(), trained_model_id=$2 WHERE target_project='classifier' AND trained_at IS NULL`, [null, modelId]);
    } else {
      await db.query(`UPDATE label_examples SET trained_at=now(), trained_model_id=$2 WHERE target_project='extractor' AND doc_type=$1 AND trained_at IS NULL`, [docType, modelId]);
    }
    res.json({ ok: true, run: ins.rows[0],
      note: 'Recorded. Kick off the actual training in Azure Document Intelligence Studio against the labeled blobs — the container is pilot-doc-ai-labels. A follow-up will call the Azure build API directly.' });
  } catch (e) { res.status(500).json({ error: e.message || 'training-run request failed' }); }
});

router.get('/training-runs', requireRole('super_admin'), async (req, res) => {
  try {
    const r = await db.query(
      `SELECT r.*, s.full_name AS requested_by_name
         FROM label_training_runs r
         LEFT JOIN staff_users s ON s.id = r.requested_by_staff_id
        ORDER BY r.requested_at DESC LIMIT 200`);
    res.json({ ok: true, runs: r.rows });
  } catch (e) { res.status(500).json({ error: e.message || 'could not load training runs' }); }
});

module.exports = router;
