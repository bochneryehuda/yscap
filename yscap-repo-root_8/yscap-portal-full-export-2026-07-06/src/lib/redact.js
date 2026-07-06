/**
 * Strip PII we never want stored in cleartext (raw_intake / draft snapshots).
 * SSN is encrypted into borrowers.ssn_encrypted; it must not also survive in a
 * jsonb blob. Removes common SSN key spellings (any borrower index) and returns
 * a shallow copy — the original object is untouched.
 */
const SSN_KEY = /(^|_)ssn$|social.?security|(^|b\d)ssn/i;

function redactPII(obj) {
  if (!obj || typeof obj !== 'object') return obj;
  const out = Array.isArray(obj) ? [] : {};
  for (const [k, v] of Object.entries(obj)) {
    if (SSN_KEY.test(k)) continue;                       // drop SSN-ish keys
    out[k] = (v && typeof v === 'object') ? redactPII(v) : v;
  }
  return out;
}

module.exports = { redactPII };
