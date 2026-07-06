/**
 * Express 4 does not catch rejected promises from async handlers: the request
 * simply hangs until the platform gateway gives up and answers 502. With 130+
 * async handlers (and a DB query inside the auth middleware on every call), a
 * momentary Postgres blip used to turn into a wall of gateway errors.
 *
 * Every router in the app is created through this factory instead of
 * express.Router(). It wraps each handler so a returned promise's rejection is
 * forwarded to next(err) and answered quickly by the JSON error middleware in
 * server.js — a fast, friendly 500/503 instead of a hung request.
 */
const express = require('express');

function wrap(fn) {
  if (typeof fn !== 'function') return fn;
  // Error middleware is detected by arity (4 declared params) — preserve it.
  if (fn.length === 4) {
    return function (err, req, res, next) {
      const out = fn(err, req, res, next);
      if (out && typeof out.catch === 'function') out.catch(next);
    };
  }
  return function (req, res, next) {
    const out = fn(req, res, next);
    if (out && typeof out.catch === 'function') out.catch(next);
  };
}

const deepWrap = (h) => (Array.isArray(h) ? h.map(deepWrap) : wrap(h));

module.exports = function safeRouter(opts) {
  const router = express.Router(opts);
  // NOTE: 'param' is intentionally excluded — param callbacks take
  // (req, res, next, value) and would be misread as error middleware.
  for (const m of ['use', 'get', 'post', 'put', 'patch', 'delete', 'options', 'head', 'all']) {
    const orig = router[m].bind(router);
    router[m] = (...args) => orig(...args.map(deepWrap));
  }
  return router;
};
