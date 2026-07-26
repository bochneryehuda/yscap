'use strict';
/**
 * Registry of capital-provider "data tapes".
 *
 * A tape = one capital provider's required export format. Today there is one
 * (Fidelis); adding another is just a new module registered here plus its
 * template + column map — the export plumbing (routes, UI, buyer rule) does not
 * change. That is the whole point of this being a registry: the foundation is
 * built once, and each new investor's tape plugs in.
 *
 * Every tape declares:
 *   key        stable id used in URLs (e.g. 'fidelis')
 *   buyerKey   the normalized note-buyer key it belongs to (normNoteBuyer form)
 *   name       short display name ('Fidelis')
 *   fullName   long display name ('Fidelis Investors')
 *   kind       'xlsx-template' (fill an investor-supplied workbook) — the only
 *              kind today; future kinds (e.g. 'xlsx-native', 'csv') slot in here
 *   buildRow / filename / template metadata used by index.js to produce bytes
 */
const fidelis = require('./fidelis');

const TAPES = [fidelis];
const BY_KEY = Object.create(null);
for (const t of TAPES) BY_KEY[t.key] = t;

function getTape(key) { return BY_KEY[key] || null; }

// Public, function-free description of one tape (safe to send to the browser).
function publicTape(t) {
  return {
    key: t.key,
    buyerKey: t.buyerKey,
    name: t.name,
    fullName: t.fullName,
    description: t.description,
    kind: t.kind,
  };
}

function listTapes() { return TAPES.map(publicTape); }

// All tapes belonging to a given normalized note-buyer key.
function tapesForBuyer(buyerKey) {
  if (!buyerKey) return [];
  return TAPES.filter((t) => t.buyerKey === buyerKey);
}

module.exports = { TAPES, getTape, listTapes, tapesForBuyer, publicTape };
