// Client-side mirror of the backend password rule (src/lib/crypto.js
// `passwordProblem`). Keep the two IN SYNC — the backend is the real gate; this
// just gives the user the same plain-language feedback before they submit.
// Hardened for a regulated lender (HIPAA-aware / NYDFS 23 NYCRR 500): min 10
// chars with upper/lower/number/symbol, and rejects obviously guessable values.
// Returns a reason the password is too weak, or '' if it passes (S1-02).
const WEAK_PASSWORDS = new Set([
  'password', 'password1', 'password1!', 'password123', 'passw0rd', 'p@ssw0rd', 'p@ssword1',
  'welcome1', 'welcome123', 'qwerty123', 'qwertyuiop', 'letmein1', 'admin123', 'iloveyou1',
  'abc123456', 'changeme1', '1q2w3e4r5t', 'q1w2e3r4t5', 'monkey123', 'football1', 'sunshine1',
]);
export function passwordProblem(pw, hints) {
  const s = String(pw == null ? '' : pw);
  if (s.length < 10) return 'Password must be at least 10 characters.';
  if (s.length > 200) return 'Password must be 200 characters or fewer.';
  if (!/[a-z]/.test(s)) return 'Password must include a lowercase letter.';
  if (!/[A-Z]/.test(s)) return 'Password must include an uppercase letter.';
  if (!/[0-9]/.test(s)) return 'Password must include a number.';
  if (!/[^A-Za-z0-9]/.test(s)) return 'Password must include a symbol (e.g. ! ? @ # $ %).';
  const low = s.toLowerCase();
  if (WEAK_PASSWORDS.has(low)) return 'That password is too common — please choose a less guessable one.';
  if (/^(.)\1+$/.test(s)) return 'Password can’t be a single repeated character.';
  const toks = (Array.isArray(hints) ? hints : [hints])
    .filter(Boolean)
    .flatMap(h => String(h).toLowerCase().split(/[@.\s]+/))
    .filter(t => t.length >= 4);
  if (toks.some(t => low.includes(t))) return 'Password can’t contain your name or email.';
  return '';
}

// One shared hint shown under password fields so the requirement is visible
// up front, not only after a rejected submit.
export const PASSWORD_HINT =
  'At least 10 characters, with an uppercase letter, a lowercase letter, a number, and a symbol.';
