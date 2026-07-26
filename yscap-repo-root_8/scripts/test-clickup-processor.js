/* Unit test for the inbound-processor GRACE WINDOW decision (owner-directed
 * 2026-07-20). ClickUp carries the processor in two fields — the people-picker and
 * an automation-filled "Processor Email" text field. decideInboundProcessor turns
 * the two resolved staff ids into { adopt, conflict }:
 *   • both set + SAME person   → adopt (agreement)
 *   • both set + DIFFERENT      → clear (the stale-duplicate signature)
 *   • people set + email empty  → adopt (a fresh assignment whose email is lagging)
 *   • people empty + email set   → adopt nobody, never clear (stale email = the Lisa
 *                                  Katz duplicate artifact; never trust email alone)
 *   • both empty                 → adopt nobody, never clear (silence)
 * Pure — no DB / no network. Run: node scripts/test-clickup-processor.js
 */
const { decideInboundProcessor } = require('../src/clickup/ingest');

let pass = 0, fail = 0;
const eq = (name, got, want) => { const ok = JSON.stringify(got) === JSON.stringify(want); if (ok) pass++; else { fail++; console.log(`FAIL ${name} — got ${JSON.stringify(got)} want ${JSON.stringify(want)}`); } };

eq('both fields the SAME person → adopt', decideInboundProcessor('u1', 'u1'), { adopt: 'u1', conflict: false });
eq('both fields DIFFERENT people → clear (stale-dup)', decideInboundProcessor('u1', 'u2'), { adopt: null, conflict: true });
eq('people set, email empty → adopt (fresh assignment, email lagging)', decideInboundProcessor('u1', null), { adopt: 'u1', conflict: false });
eq('people empty, email set → adopt nobody, NEVER clear (Lisa Katz artifact)', decideInboundProcessor(null, 'u2'), { adopt: null, conflict: false });
eq('both empty → adopt nobody, never clear (silence)', decideInboundProcessor(null, null), { adopt: null, conflict: false });
eq('people set, email undefined → adopt (lagging)', decideInboundProcessor('u1', undefined), { adopt: 'u1', conflict: false });

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
