'use strict';
/**
 * TrustPoint Public API client (phase 2 — blueprint §4; spec vendored at
 * docs/trustpoint/trustpoint-public-api-openapi.json).
 *
 * READ-MOSTLY BY DESIGN: draws / service orders / companies are read-only on
 * TrustPoint's side; PILOT's only phase-2 write is webhook registration. The guard
 * rails mirror the Sitewire client: master switch (TRUSTPOINT_ENABLED), dry-run
 * (TRUSTPOINT_DRYRUN — log the intended call, send nothing), a local token bucket
 * (TrustPoint's documented company-wide limit is heading to 600 rpm — we self-cap
 * far below), GET-only retries (writes are NEVER retried in-call — the caller owns
 * durable retry), and a write journal (trustpoint_write_log).
 *
 * Money discipline: TrustPoint REST amounts are JSON doubles in DOLLARS and webhook
 * amounts are DECIMAL STRINGS; PILOT is integer cents. centsFromTp() is the ONE
 * conversion — never Number()*100 inline (float-cent drift).
 */

const cfg = require('../config');
const switches = require('../lib/integrations/switches');

const PREFIX = () => String(cfg.trustpointPathPrefix || '/public-api').replace(/\/+$/, '');

function available() { return !!cfg.trustpointApiKey; }
function enabled() { return switches.on('TRUSTPOINT_ENABLED'); }

/** Dollars-double or decimal-string → integer cents. null/garbage → null (never 0). */
function centsFromTp(v) {
  if (v == null || v === '') return null;
  const n = Number(v);
  if (!Number.isFinite(n)) return null;
  return Math.round(n * 100);
}

// ---- local token bucket: ≤5 requests/second (well under the platform cap) ----
let stamps = [];
async function throttle() {
  for (;;) {
    const now = Date.now();
    stamps = stamps.filter((t) => now - t < 1000);
    if (stamps.length < 5) { stamps.push(now); return; }
    await new Promise((r) => setTimeout(r, 120));
  }
}

class TpError extends Error {
  constructor(status, body, path) {
    super(`TrustPoint ${status} on ${path}`);
    this.status = status; this.body = body; this.path = path;
    this.retryable = status === 429 || status >= 500;
  }
}

async function call(path, { method = 'GET', body, query } = {}) {
  if (!available()) { const e = new Error('TrustPoint API key not configured'); e.code = 'not_configured'; throw e; }
  const url = new URL(cfg.trustpointBaseUrl + (path.startsWith('/') ? path : PREFIX() + '/' + path));
  if (query) for (const [k, v] of Object.entries(query)) if (v != null && v !== '') url.searchParams.set(k, String(v));
  const isWrite = method !== 'GET';
  if (isWrite && cfg.trustpointDryrun) {
    const masked = body && body.credentials ? { ...body, credentials: '***' } : body;
    console.log(`[trustpoint][dryrun] ${method} ${url.pathname}${url.search} body=${JSON.stringify(masked || {}).slice(0, 500)}`);
    return { __dryrun: true };
  }
  const attempt = async () => {
    await throttle();
    // …and the SHARED budget on top: `throttle()` above is per-process, so two processes
    // paced themselves independently against one vendor key — the same hole ClickUp
    // phoned about (lib/api-rate-limit.js, db/482).
    await require('../lib/api-rate-limit').acquire('trustpoint');
    const res = await fetch(url, {
      method,
      headers: {
        Authorization: `Api-Key ${cfg.trustpointApiKey}`,
        Accept: 'application/json',
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch (_) { json = { raw: text && text.slice(0, 500) }; }
    if (!res.ok) throw new TpError(res.status, json, url.pathname);
    return json;
  };
  if (isWrite) return attempt();               // writes: NEVER retried in-call
  let last;
  for (let i = 0; i < 3; i++) {                // GETs: up to 3 tries on 429/5xx/network
    try { return await attempt(); }
    catch (e) { last = e; if (e instanceof TpError && !e.retryable) throw e; await new Promise((r) => setTimeout(r, 800 * (i + 1))); }
  }
  throw last;
}

/** Follow limit/offset pagination ({count,next,previous,results}) to the end (bounded). */
async function listAll(path, query = {}, { pageSize = 100, maxPages = 50 } = {}) {
  const out = [];
  for (let page = 0; page < maxPages; page++) {
    const res = await call(path, { query: { ...query, limit: pageSize, offset: page * pageSize } });
    const rows = Array.isArray(res && res.results) ? res.results : (Array.isArray(res) ? res : []);
    out.push(...rows);
    if (!res || !res.next || rows.length === 0) return out;
  }
  console.warn(`[trustpoint] listAll(${path}) hit the ${maxPages}-page bound — results may be truncated`);
  return out;
}

// ---- reads ----
const listProjects = (q) => listAll(PREFIX() + '/projects/', q);
const getProject = (pk) => call(PREFIX() + `/projects/${pk}/`);
const listDraws = (q) => listAll(PREFIX() + '/draw_requests/', q);
const listProjectDraws = (pk) => listAll(PREFIX() + `/projects/${pk}/draw_requests/`);
const getDraw = (pk, drawPk) => call(PREFIX() + `/projects/${pk}/draw_requests/${drawPk}/`);
const getDrawReport = (pk, drawPk) => call(PREFIX() + `/projects/${pk}/draw_requests/${drawPk}/report/`);
const listMilestones = (pk) => listAll(PREFIX() + `/projects/${pk}/milestones/`);
const listServiceOrders = (q) => listAll(PREFIX() + '/service_orders/', q);
const listCompanies = () => call(PREFIX() + '/companies/');
const listProjectDocuments = (pk) => listAll(PREFIX() + `/projects/${pk}/documents/`);

// ---- the one phase-2 write: webhook registration (journaled by the caller) ----
const listWebhooks = (companyPk) => call(PREFIX() + `/companies/${companyPk}/webhooks/`);
const createWebhook = (companyPk, body) => call(PREFIX() + `/companies/${companyPk}/webhooks/`, { method: 'POST', body });
const patchWebhook = (companyPk, webhookPk, body) => call(PREFIX() + `/companies/${companyPk}/webhooks/${webhookPk}/`, { method: 'PATCH', body });

module.exports = {
  available, enabled, centsFromTp, call, listAll, TpError,
  listProjects, getProject, listDraws, listProjectDraws, getDraw, getDrawReport,
  listMilestones, listServiceOrders, listCompanies, listProjectDocuments,
  listWebhooks, createWebhook, patchWebhook,
};
