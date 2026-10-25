// Reports requests HANDOFF refuses (no token, bad session, forbidden, bad
// service key) to auth-worker's Security tab. Fire-and-forget via
// ctx.waitUntil from router.js -- must never delay or fail the real
// response. Contract: auth-worker/README.md "Apps reporting refused
// requests" (2026-10-25).

// Per-isolate flood control: at most one event per ip+outcome+route per
// minute. The event that opens a new window carries the PREVIOUS window's
// total count, so a burst of identical refusals collapses into one report
// instead of flooding the Security tab. Resets on cold start -- fine, this
// is best-effort visibility, not an audit log.
const floodMap = new Map();
const WINDOW_MS = 60_000;

function nextCount(key) {
  const now = Date.now();
  const entry = floodMap.get(key);
  if (!entry) {
    floodMap.set(key, { count: 1, windowStart: now });
    return 1;
  }
  if (now - entry.windowStart >= WINDOW_MS) {
    const count = entry.count;
    floodMap.set(key, { count: 1, windowStart: now });
    return count;
  }
  entry.count += 1;
  return null; // suppressed -- already reported this ip+outcome+route this window
}

// Called from router.js inside executionCtx.waitUntil whenever requireRole
// refuses a request. Never throws and never includes tokens/keys/bodies.
export async function reportRefusal(env, { request, route, outcome, username, detail }) {
  try {
    if (!outcome) return; // e.g. auth-worker unreachable -- an outage, not a refusal to report
    const ip = request.headers.get("CF-Connecting-IP") || null;
    const count = nextCount(`${ip || "?"}|${outcome}|${route}`);
    if (count === null) return;

    const event = {
      outcome,
      route,
      method: request.method,
      username: username || undefined,
      ip,
      country: request.cf?.country || null,
      city: request.cf?.city || null,
      org: request.cf?.asOrganization || null,
      ua: (request.headers.get("User-Agent") || "").slice(0, 200),
      count,
      detail: detail ? String(detail).slice(0, 150) : undefined,
    };

    await env.AUTH_WORKER.fetch("https://auth.ben-a90.workers.dev/auth/security/report", {
      method: "POST",
      headers: { "X-Auth-Service-Key": env.AUTH_SERVICE_KEY, "Content-Type": "application/json" },
      body: JSON.stringify({ events: [event] }),
    });
  } catch {
    // Best-effort only -- a reporting failure must never affect anything else.
  }
}
