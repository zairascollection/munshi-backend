const express = require("express");

// ---------------------------------------------------------------
// Express 4 does not understand async route handlers.
//
//   router.get("/", async (req, res) => {
//     const { rows } = await pool.query("...");   // <- if this rejects
//     res.json(rows);
//   });
//
// When that query rejects, Express never sees the error. It becomes an
// unhandled promise rejection, and since Node 15 that terminates the
// process. One slow query or one dropped connection and the whole server
// dies — which on Railway looks like "it crashed again".
//
// Requiring this file once patches the Router so every async handler is
// wrapped: a rejection is passed to next(err) and lands in the normal
// error middleware, which replies 500 and keeps the server alive. This is
// what the express-async-errors package does, inlined here so it is
// visible rather than hidden in node_modules.
//
// Express 5 does this natively; when this app moves to Express 5 this
// file can be deleted.
// ---------------------------------------------------------------

const METHODS = ["get", "post", "put", "patch", "delete", "all", "use"];

function wrapHandler(fn) {
  if (typeof fn !== "function") return fn;
  if (fn.__asyncWrapped) return fn;

  // A mounted router or sub-app is also a function, but Express inspects
  // its properties (.stack, .handle, .set) to mount it. Wrapping one would
  // hide those and break the mount, so leave them exactly as they are.
  if (fn.stack || fn.handle || fn.set) return fn;

  // Error middleware has four arguments and must keep that shape, or
  // Express stops recognising it as an error handler.
  if (fn.length === 4) {
    const wrapped = function (err, req, res, next) {
      try {
        const out = fn.call(this, err, req, res, next);
        if (out && typeof out.catch === "function") out.catch(next);
        return out;
      } catch (e) {
        return next(e);
      }
    };
    wrapped.__asyncWrapped = true;
    return wrapped;
  }

  const wrapped = function (req, res, next) {
    try {
      const out = fn.call(this, req, res, next);
      if (out && typeof out.catch === "function") {
        out.catch((err) => {
          // A handler that already answered can't be answered again;
          // log it rather than triggering "headers already sent".
          if (res.headersSent) {
            console.error("[async] error after response was sent:", err && err.message);
            return;
          }
          next(err);
        });
      }
      return out;
    } catch (e) {
      return next(e);
    }
  };
  wrapped.__asyncWrapped = true;
  return wrapped;
}

function patch(target) {
  METHODS.forEach((method) => {
    const original = target[method];
    if (typeof original !== "function" || original.__asyncPatched) return;
    const patched = function (...args) {
      return original.apply(this, args.map((a) => (typeof a === "function" ? wrapHandler(a) : a)));
    };
    patched.__asyncPatched = true;
    target[method] = patched;
  });
}

// Router.prototype covers every router created anywhere in the app,
// including ones built before this module was required.
patch(express.Router);
patch(express.application);

module.exports = { wrapHandler };
