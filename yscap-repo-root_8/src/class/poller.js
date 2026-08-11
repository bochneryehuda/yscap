'use strict';
/**
 * Class Valuation — the callback-inbox BACKSTOP.
 *
 * Class pushes, so the receiver drains the inbox the moment a delivery lands
 * (routes/class-webhook.js). This exists for the one case that does not cover: a
 * delivery that was STORED but whose processing failed. Without a sweep it would sit
 * unprocessed until some other callback happened to arrive — and on a file that has
 * gone quiet, that may be never.
 *
 * Deliberately small. It does not poll Class for anything (they push; polling would
 * be a second, competing source of truth), it only re-runs our own unprocessed rows.
 * Self-gated, bounded, and it never throws.
 */

const switches = require('../lib/integrations/switches');

const EVERY_MS = Number(process.env.CLASS_DRAIN_SEC || 300) * 1000;
let timer = null;

async function tick() {
  // Read the switch at CALL time, not at boot — an admin flipping it on must not
  // require a redeploy (the repo's standing rule for every integration switch).
  if (!switches.on('CLASS_ENABLED')) return;
  try {
    const out = await require('./callbacks').drain({ limit: 100 });
    if (out && (out.processed || out.failed)) {
      console.log(`[class] callback drain: ${out.processed} processed, ${out.failed} failed`);
    }
  } catch (e) {
    console.warn('[class] callback drain tick failed:', e && e.message);
  }
  // Backstop the document fetch: an attachment announced but never downloaded (the
  // fetch failed, or the callback arrived before their order id had been written back)
  // is re-attempted here. Same reason the drain exists — a quiet file may otherwise
  // never see another callback. Bounded and never throws.
  try {
    const sw = await require('./documents').sweepPendingOnce();
    if (sw && sw.swept) console.log(`[class] attachment sweep: ${sw.swept} order(s)`);
  } catch (e) {
    console.warn('[class] attachment sweep tick failed:', e && e.message);
  }
}

function start() {
  if (timer) return;
  if (process.env.CLASS_DRAIN_DISABLED === '1') return;
  timer = setInterval(() => { tick().catch(() => {}); }, Math.max(60000, EVERY_MS));
  if (timer.unref) timer.unref();   // never hold the process open
}
function stop() { if (timer) { clearInterval(timer); timer = null; } }

module.exports = { start, stop, tick };
