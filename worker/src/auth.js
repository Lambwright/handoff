// HANDOFF auth. Two layers:
//   1. Identity  — Einbau ID (auth-worker) verifies the bearer token. Same
//      pattern as punch-worker / tally-worker: a plain worker->worker fetch() to
//      a *.workers.dev URL is blocked (Cloudflare error 1042), so the call goes
//      through the AUTH_WORKER service binding.
//   2. Authorization — auth-worker only stores admin|user, so HANDOFF keeps its
//      own richer roles in the `users` table and resolves them here. Every
//      gate/assignment action is attributed to the resolved actor.
//
// Non-browser callers (the cron issuing internal calls) present a static
// X-Handoff-Service-Key instead of a session.

export async function verifyIdentity(request, env) {
  const authHeader = request.headers.get("Authorization") || "";
  const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : null;
  if (!token) return { ok: false, status: 401, reason: "No session token was sent with the request." };
  try {
    const res = await env.AUTH_WORKER.fetch(`${env.AUTH_WORKER_URL}/auth/verify`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: "{}",
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "(no body)");
      return { ok: false, status: 401, reason: `auth-worker rejected verify (HTTP ${res.status}): ${body.slice(0, 160)}` };
    }
    const data = await res.json();
    if (!data.valid) return { ok: false, status: 401, reason: "Session is invalid or expired — please log in again." };
    return { ok: true, user: data.user, refreshedToken: data.refreshedToken || null };
  } catch (e) {
    return { ok: false, status: 502, reason: `Couldn't reach auth-worker: ${e.message}` };
  }
}

export function isServiceCaller(request, env) {
  const key = request.headers.get("X-Handoff-Service-Key");
  return Boolean(key) && Boolean(env.HANDOFF_SERVICE_KEY) && key === env.HANDOFF_SERVICE_KEY;
}

// The HANDOFF-side user row (role + attribution) for a verified Einbau ID username.
export async function resolveActor(sql, username) {
  if (!username) return null;
  const rows = await sql`
    select id, einbau_username, name, role, active
    from users
    where einbau_username = ${String(username).toLowerCase()}`;
  return rows[0] || null;
}

// Verify the session AND require an active HANDOFF role. `roles` is a list of
// allowed roles; 'admin' always passes. Returns { ok, user, actor, refreshedToken }
// on success, or an auth-error shape ({ ok:false, status, reason }) to hand to
// http.authError.
export async function requireRole(request, env, sql, roles = null) {
  if (isServiceCaller(request, env)) {
    return { ok: true, user: { username: "service" }, actor: { einbau_username: "service", role: "admin", name: "HANDOFF service" }, refreshedToken: null };
  }
  const id = await verifyIdentity(request, env);
  if (!id.ok) return id;

  const actor = await resolveActor(sql, id.user?.username);
  if (!actor || !actor.active) {
    return {
      ok: false,
      status: 403,
      reason: `"${id.user?.username}" has no active HANDOFF role yet — an admin needs to add you.`,
    };
  }
  if (roles && roles.length && actor.role !== "admin" && !roles.includes(actor.role)) {
    return {
      ok: false,
      status: 403,
      reason: `This action needs role: ${roles.join(" or ")}. You are "${actor.role}".`,
    };
  }
  return { ok: true, user: id.user, actor, refreshedToken: id.refreshedToken };
}
