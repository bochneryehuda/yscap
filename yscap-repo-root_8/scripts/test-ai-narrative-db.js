'use strict';
/**
 * DB test for ai-narrative's SQL surfaces (owner-directed 2026-07-27). analyzeFile can't run the GPT
 * step without Azure, but its record / retract / audit-log-memo SQL must be schema-correct (a phantom
 * column would only surface against a real DB). This exercises: recording a narrative_coherence
 * ai_suggestion, the retract-open UPDATE, and the audit_log memo stamp + read. Rolls back. Skips
 * without DATABASE_URL.
 */
if (!process.env.DATABASE_URL) { console.log('SKIP test-ai-narrative-db (no DATABASE_URL)'); process.exit(0); }
const assert = require('assert');
const { Pool } = require('pg');
const aiSug = require('../src/lib/underwriting/ai-suggestions');

(async () => {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const uniq = 'narr+' + Buffer.from(String(process.pid)).toString('hex') + '@example.com';
    const b = (await client.query(`INSERT INTO borrowers (first_name,last_name,email) VALUES ('T','U',$1) RETURNING id`, [uniq])).rows[0];
    const app = (await client.query(`INSERT INTO applications (borrower_id, property_address) VALUES ($1,$2) RETURNING id`,
      [b.id, JSON.stringify({ line1: '1 Main', city: 'Austin', state: 'TX', zip: '78701' })])).rows[0];

    // A narrative concern records as an ai_suggestion (source/kind/severity accepted by the schema).
    const rec = await aiSug.record(client, {
      applicationId: app.id, source: 'narrative_coherence', kind: 'finding', severity: 'warning',
      title: 'The claimed experience does not match the file', body: 'why...', evidence: { groundingHash: 'abc', kind: 'narrative_coherence' },
      dedupeKey: 'narrative_coherence:abc123',
    });
    assert.ok(rec && rec.id, 'a narrative_coherence suggestion records');

    // The retract-open UPDATE (the exact shape ai-narrative.retractOpen uses) dismisses it.
    const upd = await client.query(
      `UPDATE ai_suggestions SET status='dismissed', status_reason=$3, updated_at=now()
        WHERE application_id=$1 AND source=$2 AND status='open' RETURNING id`,
      [app.id, 'narrative_coherence', 'Withdrawn automatically: the loan file changed — re-read']);
    assert.strictEqual(upd.rowCount, 1, 'the open narrative suggestion is withdrawn');

    // The audit_log memo stamp INSERT + the memo SELECT (schema-correct columns).
    await client.query(
      `INSERT INTO audit_log (actor_kind, action, entity_type, entity_id, detail)
       VALUES ('system','ai_narrative_run','application',$1,$2::jsonb)`, [app.id, JSON.stringify({ groundingHash: 'abc', concerns: 1 })]);
    const memo = await client.query(
      `SELECT detail FROM audit_log WHERE action='ai_narrative_run' AND entity_type='application' AND entity_id=$1 ORDER BY created_at DESC LIMIT 1`, [app.id]);
    let d = memo.rows[0].detail; if (typeof d === 'string') d = JSON.parse(d);
    assert.strictEqual(d.groundingHash, 'abc', 'the memo stamp round-trips the file-state hash');

    await client.query('ROLLBACK');
    console.log('✓ test-ai-narrative-db: record + retract + audit-log memo SQL are schema-correct');
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    console.error(e); process.exit(1);
  } finally { client.release(); await pool.end(); }
})();
