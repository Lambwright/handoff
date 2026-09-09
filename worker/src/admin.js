// /me (any verified Einbau ID session, role or not) and /admin/users (HANDOFF
// role management — admin only). auth-worker only knows admin|user, so HANDOFF's
// own `users` table is the source of truth for estimator/assignment/pm/admin.

import { json } from "./http.js";
import { verifyIdentity, resolveActor } from "./auth.js";
import { procoreFetch } from "./procore.js";
import { PROCORE_DEPARTMENTS, REGIONS, TIMEZONES } from "./procore-shapes.js";

// TEMPORARY diagnostic — an authenticated passthrough to an arbitrary Procore
// REST path, used to nail down the real endpoint/response shapes the
// TODO(sandbox) markers in procore-shapes.js are still guessing at. Same trick
// punch-worker used (`/admin/procore-probe`). Admin-only. Delete this route and
// handler once procore-shapes.js is filled in for real.
//   POST /admin/procore-probe  { path, version?, method?, body?, query? }
export async function procoreProbe({ request, env }) {
  const b = await request.json().catch(() => ({}));
  if (!b.path) {
    return json({ error: "invalid_request", detail: 'path is required, e.g. "/companies/<co>/project_stages"' }, 400);
  }
  const result = await procoreFetch(env, b.path, {
    method: b.method || "GET",
    version: b.version || "v1.0",
    body: b.body,
    query: b.query,
  });
  return json(result);
}

// Deliberately does NOT 403 when the caller has no HANDOFF role yet — the
// frontend needs to tell the difference between "not logged in" and "logged in,
// but no role assigned", and show the right message for each.
export async function getMe({ request, env, sql }) {
  const id = await verifyIdentity(request, env);
  if (!id.ok) return json({ error: "unauthorized", reason: id.reason }, id.status || 401);

  const actor = await resolveActor(sql, id.user.username);
  return json(
    { user: id.user, actor: actor || null },
    200,
    { refreshedToken: id.refreshedToken }
  );
}

// GET /departments — the static Procore Department option list, so the Admin
// UI can offer a dropdown instead of asking someone to type a numeric id.
// CAUTION carried through from procore-shapes.js: this list mixes real current
// PMs with departed employees and non-person buckets — picking an entry here
// doesn't mean it's a valid PM, only that it's a real option in Procore.
export async function listDepartments() {
  return json({ departments: PROCORE_DEPARTMENTS });
}

// GET /regions — Einbau's Procore project regions (branches), live.
export async function listRegions({ env }) {
  const { ok, data } = await procoreFetch(env, REGIONS.listPath(env.PROCORE_COMPANY_ID), { version: REGIONS.version });
  const regions = ok && Array.isArray(data) ? data.map((r) => ({ id: String(r.id), name: r.name })) : [];
  return json({ regions });
}

// GET /timezones — the fixed list (no useful Procore endpoint).
export async function listTimezones() {
  return json({ timezones: TIMEZONES });
}

export async function listUsers({ sql }) {
  const rows = await sql`
    select id, einbau_username, name, role, active, procore_department_id, procore_department_name, created_at
    from users order by name`;
  return json({ users: rows });
}

export async function upsertUser({ request, sql, auth }) {
  const body = await request.json().catch(() => null);
  if (!body || !body.einbau_username || !body.name || !body.role) {
    return json({ error: "invalid_request", detail: "einbau_username, name, and role are required" }, 400);
  }
  const role = String(body.role);
  if (!["estimator", "assignment", "pm", "admin"].includes(role)) {
    return json({ error: "invalid_request", detail: `unknown role: ${role}` }, 400);
  }
  const username = String(body.einbau_username).trim().toLowerCase();
  const active = body.active === undefined ? true : Boolean(body.active);

  // Only role='pm' rows carry a Department mapping — the assignment engine's
  // candidate roster is exactly the active pm-role users with one set.
  const dept = role === "pm" && body.procore_department_id ? PROCORE_DEPARTMENTS.find((d) => String(d.id) === String(body.procore_department_id)) : null;
  const departmentId = dept ? String(dept.id) : null;
  const departmentName = dept ? dept.name : null;

  const [row] = await sql`
    insert into users (einbau_username, name, role, active, procore_department_id, procore_department_name)
    values (${username}, ${body.name}, ${role}, ${active}, ${departmentId}, ${departmentName})
    on conflict (einbau_username) do update
      set name = excluded.name, role = excluded.role, active = excluded.active,
          procore_department_id = excluded.procore_department_id, procore_department_name = excluded.procore_department_name
    returning id, einbau_username, name, role, active, procore_department_id, procore_department_name, created_at`;

  return json({ user: row, upserted_by: auth.actor.einbau_username });
}

export async function deactivateUser({ params, sql, auth }) {
  const [row] = await sql`
    update users set active = false where id = ${params.id}
    returning id, einbau_username, name, role, active`;
  if (!row) return json({ error: "not_found" }, 404);
  return json({ user: row, deactivated_by: auth.actor.einbau_username });
}
