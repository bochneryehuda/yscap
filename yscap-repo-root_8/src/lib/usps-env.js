'use strict';
/**
 * WHICH ENVIRONMENT VARIABLE ARE THE USPS KEYS ACTUALLY UNDER?
 *
 * The owner's words: *"USPS credentials are already in Render — you can use the
 * exact same keys for this one."* Very likely true, and it is exactly the
 * situation where the integration reports "not connected" forever and nobody can
 * tell why: the code reads `USPS_CLIENT_ID` / `USPS_CLIENT_SECRET`, and a value
 * set under any other name is invisible to it. "Not connected" and "connected
 * under a different name" look identical from the outside, and one of them is a
 * five-second fix nobody knows to make.
 *
 * Two things happen here, and the second matters more than the first:
 *
 *  1. THE COMMON ALTERNATE NAMES ARE ACCEPTED. USPS's own portal labels the v3
 *     OAuth pair "Consumer Key" and "Consumer Secret" on some screens and "Client
 *     ID" / "Client Secret" on others, so `USPS_CONSUMER_KEY` is at least as
 *     likely a name as the one we read. Accepting it costs nothing and removes a
 *     whole class of silent misconfiguration.
 *
 *  2. WHEN IT IS STILL NOT CONFIGURED, IT SAYS WHAT IT CAN SEE. `describe()`
 *     lists every `USPS*` variable that IS set, BY NAME AND NEVER BY VALUE, so the
 *     health screen can say "USPS_API_KEY is set; this integration reads
 *     USPS_CLIENT_ID" instead of "not connected". A diagnostic that names the
 *     problem is the difference between a five-second fix and a week of assuming
 *     the integration is broken.
 *
 * ─── THE ONE ALIAS DELIBERATELY NOT ACCEPTED ──────────────────────────────────
 *
 * `USPS_USERID` / `USPS_USER_ID` is the credential for USPS **Web Tools**, the
 * OLD XML API — a single user id, no secret, a completely different protocol and
 * host. Feeding it to the v3 OAuth client would produce an authentication failure
 * that reads as "your key is wrong" when the truth is "that is a key for a
 * different service". So it is DETECTED and NAMED as the wrong kind of credential
 * rather than aliased into working-looking breakage.
 *
 * NEVER LOGS OR RETURNS A SECRET VALUE. Only names, and only whether they are set.
 */

const nonEmpty = (v) => (typeof v === 'string' && v.trim() !== '' ? v.trim() : null);

/* The names read for each half, in priority order. The canonical one is first, so
   a deployment that sets both keeps the documented behaviour. */
const ID_NAMES = Object.freeze([
  'USPS_CLIENT_ID', 'USPS_CONSUMER_KEY', 'USPS_API_KEY', 'USPS_KEY', 'USPS_ID',
]);
const SECRET_NAMES = Object.freeze([
  'USPS_CLIENT_SECRET', 'USPS_CONSUMER_SECRET', 'USPS_API_SECRET', 'USPS_SECRET',
]);
/* Web Tools — a DIFFERENT API. Recognised so it can be named, never used. */
const WEB_TOOLS_NAMES = Object.freeze(['USPS_USERID', 'USPS_USER_ID', 'USPS_WEB_TOOLS_USERID']);

/** The first of `names` that is set in `env`, as {name, value} — or null. */
function firstSet(names, env) {
  for (const n of names) {
    const v = nonEmpty(env[n]);
    if (v) return { name: n, value: v };
  }
  return null;
}

/** The credential pair, whichever names it is under. Values included — callers store them, never print them. */
function credentials(env = process.env) {
  const id = firstSet(ID_NAMES, env);
  const secret = firstSet(SECRET_NAMES, env);
  return {
    clientId: id ? id.value : undefined,
    clientSecret: secret ? secret.value : undefined,
    idName: id ? id.name : null,
    secretName: secret ? secret.name : null,
  };
}

/**
 * WHAT WE CAN SEE, IN WORDS, WITH NO SECRET IN IT.
 *
 * Returns `{ configured, idName, secretName, seen[], webTools[], detail }`.
 * `detail` is a plain sentence for the health screen — written for somebody who
 * is trying to work out why a thing they believe they configured says it is not.
 */
function describe(env = process.env) {
  const c = credentials(env);
  const configured = !!(c.clientId && c.clientSecret);
  // Every USPS-ish variable that is SET, by name only. This is the diagnostic.
  const seen = Object.keys(env)
    .filter((k) => /^USPS[_A-Z0-9]*$/.test(k) && nonEmpty(env[k]))
    .sort();
  const webTools = seen.filter((k) => WEB_TOOLS_NAMES.includes(k));
  const known = new Set([...ID_NAMES, ...SECRET_NAMES]);
  const unread = seen.filter((k) => !known.has(k) && !WEB_TOOLS_NAMES.includes(k));

  let detail;
  if (configured) {
    detail = c.idName === ID_NAMES[0] && c.secretName === SECRET_NAMES[0]
      ? 'Credentials are set.'
      : `Credentials are set, under ${c.idName} and ${c.secretName}.`;
  } else if (!c.clientId && !c.clientSecret && !seen.length) {
    detail = 'No USPS credentials are set at all. This needs a client id and a client secret '
      + `(read from ${ID_NAMES[0]} / ${SECRET_NAMES[0]}, or any of the usual alternate names).`;
  } else {
    const halves = [];
    if (c.clientId && !c.clientSecret) halves.push(`the client id is set (as ${c.idName}) but the SECRET is not`);
    if (!c.clientId && c.clientSecret) halves.push(`the secret is set (as ${c.secretName}) but the CLIENT ID is not`);
    if (!c.clientId && !c.clientSecret) halves.push('neither half is set under a name this reads');
    const extras = [];
    if (unread.length) {
      extras.push(`These USPS variables ARE set but are not names this reads: ${unread.join(', ')}`
        + ` — if one of them holds the key, rename it to ${ID_NAMES[0]} or ${SECRET_NAMES[0]}.`);
    }
    if (webTools.length) {
      // The single most likely wrong answer, and it fails in a confusing way.
      extras.push(`${webTools.join(', ')} is set — that is a USPS Web Tools credential (the older XML API, `
        + 'a user id with no secret). This integration is the v3 Addresses API, which needs an OAuth '
        + 'client id AND secret from developer.usps.com; the Web Tools id will not authenticate here.');
    }
    detail = `Not connected: ${halves.join('; ')}.${extras.length ? ' ' + extras.join(' ') : ''}`;
  }
  return { configured, idName: c.idName, secretName: c.secretName, seen, webTools, unread, detail };
}

module.exports = { credentials, describe, ID_NAMES, SECRET_NAMES, WEB_TOOLS_NAMES, _internals: { firstSet } };
