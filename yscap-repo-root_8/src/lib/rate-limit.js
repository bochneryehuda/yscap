/**
 * Zero-dependency, in-memory sliding-window rate limiter — no express-rate-limit,
 * no Redis (the service runs a single instance because it mounts a disk, so an
 * in-process store is correct and consistent).
 *
 * Purpose: throttle abuse the per-account lockout can't stop — credential
 * stuffing spread across many accounts, and flooding of the unauthenticated
 * public endpoints (register / forgot / intake / leads). It also protects the
 * event loop: every login runs scrypt on the threadpool, so an un-throttled
 * login flood is a real load vector.
 *
 * State is a Map keyed by `${bucket}:${ip}`; a lazy sweep drops expired windows
 * so memory stays bounded. On restart the windows reset (acceptable for abuse
 * throttling; account lockout persists in the DB regardless).
 */
const hits = new Map();   // key -> { count, resetAt }
let lastSweep = 0;

function sweep(now) {
  if (now - lastSweep < 60000) return;   // at most once a minute
  lastSweep = now;
  for (const [k, v] of hits) if (v.resetAt <= now) hits.delete(k);
}

// Behind Render's proxy, the real client IP is the first x-forwarded-for hop.
// (server.js sets `trust proxy`, so req.ip already resolves to it; fall back
// defensively.)
function clientIp(req) {
  return req.ip ||
    (req.get('x-forwarded-for') || '').split(',')[0].trim() ||
    req.socket?.remoteAddress || 'unknown';
}

/**
 * rateLimit({ windowMs, max, bucket }) -> express middleware.
 * Answers 429 with Retry-After when a client exceeds `max` requests per window.
 */
function rateLimit({ windowMs = 60000, max = 30, bucket = 'default' } = {}) {
  return function (req, res, next) {
    const now = Date.now();
    sweep(now);
    const key = `${bucket}:${clientIp(req)}`;
    let e = hits.get(key);
    if (!e || e.resetAt <= now) { e = { count: 0, resetAt: now + windowMs }; hits.set(key, e); }
    e.count++;
    const remaining = Math.max(0, max - e.count);
    res.setHeader('RateLimit-Limit', String(max));
    res.setHeader('RateLimit-Remaining', String(remaining));
    res.setHeader('RateLimit-Reset', String(Math.ceil((e.resetAt - now) / 1000)));
    if (e.count > max) {
      const retry = Math.ceil((e.resetAt - now) / 1000);
      res.setHeader('Retry-After', String(retry));
      return res.status(429).json({ error: 'Too many requests — please wait a moment and try again.' });
    }
    next();
  };
}

module.exports = { rateLimit };
