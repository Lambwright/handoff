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

const HANDOFF_LEVELS = ["admin", "estimator", "assignment", "pm", "viewer"];

// The HANDOFF-side user row for a verified Einbau ID username — only consulted
// while HANDOFF's role-matrix Live switch is off ("access"), and for the
// per-person PM → Procore Department mapping, which lives on the same row.
export async function resolveActor(sql, username) {
  if (!username) return null;
  const rows = await sql`
    select id, einbau_username, name, role, active, procore_department_id, procore_department_name
    from users
    where einbau_username = ${String(username).toLowerCase()}`;
  return rows[0] || null;
}

// Role comes from auth-worker's appRoles.HANDOFF (role matrix). "access" means
// HANDOFF isn't switched over yet, so keep the users-table role; anything else
// (no_access, unknown) is denied. user.role / user.jobRole are never gated on.
export async function resolveHandoffActor(sql, user) {
  const username = String(user?.username || "").toLowerCase();
  const appRole = user?.appRoles?.HANDOFF;
  if (HANDOFF_LEVELS.includes(appRole)) {
    return { einbau_username: username, name: user.displayName || username, role: appRole, active: true, source: "matrix" };
  }
  if (appRole === "access") {
    const row = await resolveActor(sql, username);
    return row && row.active ? { ...row, source: "users" } : null;
  }
  return null;
}

// A PM only sees a handoff once it's assigned to them. Other roles are unaffected.
// Handlers return 404 (not 403) when this is false, so the handoff doesn't appear
// to exist to a PM who isn't on it.
export async function pmMayAccess(sql, actor, project) {
  if (!actor || actor.role !== "pm") return true;
  if (!project || !["assigned", "complete"].includes(project.status)) return false;
  const [me] = await sql`select procore_department_id from users where einbau_username = ${actor.einbau_username}`;
  if (!me?.procore_department_id) return false;
  const [last] = await sql`
    select assigned_pm from assignment_events
    where project_id = ${project.id} and assigned_pm is not null
    order by decided_at desc limit 1`;
  return Boolean(last) && String(last.assigned_pm) === String(me.procore_department_id);
}

// Verify the session AND require a HANDOFF role. `roles` is a list of allowed
// roles; 'admin' always passes. Returns { ok, user, actor, refreshedToken } on
// success, or an auth-error shape ({ ok:false, status, reason }) for http.authError.
export async function requireRole(request, env, sql, roles = null) {
  if (isServiceCaller(request, env)) {
    return { ok: true, user: { username: "service" }, actor: { einbau_username: "service", role: "admin", name: "HANDOFF service" }, refreshedToken: null };
  }
  const id = await verifyIdentity(request, env);
  if (!id.ok) return id;

  const actor = await resolveHandoffActor(sql, id.user);
  if (!actor) {
    return {
      ok: false,
      status: 403,
      reason: `"${id.user?.username}" doesn't have HANDOFF access — an admin needs to grant it.`,
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
