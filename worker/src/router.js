// A tiny path matcher so the growing route list stays readable. Patterns look
// like "/projects/:id/gate"; :params are captured into ctx.params. Handlers get
// one ctx object and return a Response.

import { json, authError } from "./http.js";
import { requireRole } from "./auth.js";

function compile(pattern) {
  const names = [];
  const rx = pattern
    .replace(/[.*+?^${}()|[\]\\]/g, (m) => (m === "*" ? "*" : `\\${m}`))
    .replace(/\\\*/g, ".*")
    .replace(/:([A-Za-z_]+)/g, (_, n) => {
      names.push(n);
      return "([^/]+)";
    });
  return { rx: new RegExp(`^${rx}$`), names };
}

export function makeRouter() {
  const routes = [];

  function add(method, pattern, opts, handler) {
    if (typeof opts === "function") {
      handler = opts;
      opts = {};
    }
    routes.push({ method, ...compile(pattern), opts, handler });
  }

  const api = {
    get: (p, o, h) => add("GET", p, o, h),
    post: (p, o, h) => add("POST", p, o, h),
    patch: (p, o, h) => add("PATCH", p, o, h),
    delete: (p, o, h) => add("DELETE", p, o, h),

    async handle(request, env, executionCtx, sql) {
      const url = new URL(request.url);
      const matches = routes.filter((r) => r.rx.test(url.pathname));
      if (matches.length === 0) return json({ error: "not_found", path: url.pathname }, 404);

      const route = matches.find((r) => r.method === request.method);
      if (!route) {
        return json({ error: "method_not_allowed", allow: matches.map((m) => m.method) }, 405);
      }

      const m = url.pathname.match(route.rx);
      const params = {};
      route.names.forEach((n, i) => (params[n] = decodeURIComponent(m[i + 1])));

      const ctx = { request, env, executionCtx, url, params, sql, auth: null };

      if (route.opts.roles !== undefined) {
        const auth = await requireRole(request, env, sql, route.opts.roles);
        if (!auth.ok) return authError(auth);
        ctx.auth = auth;
      }

      try {
        const res = await route.handler(ctx);
        // Roll the session forward if auth-worker handed back a fresher token.
        if (ctx.auth?.refreshedToken && res && !res.headers.get("X-Refreshed-Token")) {
          res.headers.set("X-Refreshed-Token", ctx.auth.refreshedToken);
        }
        return res;
      } catch (e) {
        console.log("route error", url.pathname, e.message, e.stack);
        return json({ error: "internal_error", detail: e.message }, 500);
      }
    },
  };

  return api;
}
