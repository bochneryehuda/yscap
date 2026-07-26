'use strict';
/**
 * Direct-Source Verification Hub — Sovereign (blueprint sec. 9).
 *
 * PILOT prefers AUTHORITATIVE data over uploaded documents wherever available.
 * This module is the orchestrator that calls each direct-source connector for
 * a file and records their answers as fact_observations (source_type =
 * 'api_verification'). The twin's reconciliation then AUTOMATICALLY treats
 * the API source as `verified` — outranking document-only observations.
 *
 * Each connector implements the same tiny interface:
 *   configured() → bool
 *   ping()       → { ok, reason? }
 *   fetch(appId, ctx) → { ok, observations: [{ fact_key, value_json, raw_value, confidence }], reason? }
 *
 * Ships with three STUBS (plaid, property-data, xactus) that follow the
 * interface so the wiring works today; when the real keys arrive, each
 * connector's fetch() becomes a real HTTP call — no change to callers,
 * to the twin, or to the underwriting engine.
 *
 * Pure — best-effort per connector; one failure never stops the batch.
 */
let _db = null;
const db = () => (_db || (_db = require('../../db')));
const twin = require('../underwriting/twin');
const plaid = require('./direct-source-connectors/plaid');
const propertyData = require('./direct-source-connectors/property-data');
const xactus = require('./direct-source-connectors/xactus');
const houseCanary = require('./direct-source-connectors/housecanary');
const clearCapital = require('./direct-source-connectors/clearcapital');
const attom = require('./direct-source-connectors/attom');

const CONNECTORS = Object.freeze({
  plaid, property_data: propertyData, xactus,
  housecanary: houseCanary, clearcapital: clearCapital, attom,
});

/**
 * enrichCtx(client, appId, ctx) → ctx  (best-effort, NEVER THROWS)
 * Property connectors (ATTOM, HouseCanary, Clear Capital) need the subject
 * property address, which the callers don't build. Load it ONCE from
 * applications.property_address (jsonb {line1,line2,city,state,zip}) and merge a
 * normalized `property` block into ctx so every property connector can read it.
 * A caller that already supplied an address is never overwritten.
 */
async function enrichCtx(client, appId, ctx = {}) {
  try {
    if (ctx && (ctx.property || ctx.street || ctx.address1)) return ctx; // caller already supplied one
    const runner = client || (db().pool || db());
    if (!runner || typeof runner.query !== 'function') return ctx;
    const r = await runner.query('SELECT property_address FROM applications WHERE id = $1', [appId]);
    const pa = r && r.rows && r.rows[0] && r.rows[0].property_address;
    if (!pa || typeof pa !== 'object') return ctx;
    const street = pa.line1 || pa.address || pa.address1 || pa.street || null;
    const property = { street, address2: pa.line2 || null, city: pa.city || null, state: pa.state || null, zip: pa.zip || pa.postal || null };
    if (!property.street) return ctx; // nothing usable
    return Object.assign({}, ctx, { property });
  } catch (_e) { return ctx; }
}

/**
 * Run all configured direct-source connectors on ONE file. Every observation
 * feeds twin.recordObservation with source_type='api_verification' so the
 * reconciler treats them as verified truth.
 * Best-effort — a connector that fails is recorded and skipped.
 * Runs on the caller's transaction (they pass a `client`).
 */
async function verifyFile(client, appId, ctx = {}) {
  if (!appId) throw new Error('verifyFile: appId required');
  const results = [];
  const kindFilter = ctx && ctx.kind ? String(ctx.kind) : null;
  ctx = await enrichCtx(client, appId, ctx); // give property connectors the subject address
  for (const [name, conn] of Object.entries(CONNECTORS)) {
    if (kindFilter && conn.kind !== kindFilter) continue;
    if (!conn.configured()) { results.push({ connector: name, ok: false, skipped: true, reason: 'not configured' }); continue; }
    try {
      const r = await conn.fetch(appId, ctx);
      if (!r || !r.ok) { results.push({ connector: name, ok: false, reason: r && r.reason || 'no response' }); continue; }
      let recorded = 0;
      for (const obs of (r.observations || [])) {
        try {
          await twin.recordObservation(client, {
            appId, factKey: obs.fact_key,
            sourceType: 'api_verification', sourceId: name,
            rawValue: obs.raw_value != null ? String(obs.raw_value) : (obs.value_json != null ? JSON.stringify(obs.value_json) : null),
            valueJson: obs.value_json != null ? obs.value_json : { value: obs.raw_value },
            extractionConfidence: obs.confidence != null ? Number(obs.confidence) : 0.95,
            reason: `${name} verification`,
          });
          recorded += 1;
        } catch (_) { /* per-observation failures don't stop the connector */ }
      }
      results.push({ connector: name, ok: true, recorded });
    } catch (e) {
      results.push({ connector: name, ok: false, reason: (e && e.message) || 'error' });
    }
  }
  return { appId, results };
}

/** Health-panel entry — which connectors are ready. */
async function ping() {
  const out = {};
  for (const [name, conn] of Object.entries(CONNECTORS)) {
    try { out[name] = conn.configured() ? await conn.ping() : { ok: false, reason: 'not configured' }; }
    catch (e) { out[name] = { ok: false, reason: (e && e.message) || 'ping error' }; }
  }
  return out;
}

module.exports = { CONNECTORS, verifyFile, ping };
