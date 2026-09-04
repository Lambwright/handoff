// /me (any verified Einbau ID session, role or not) and /admin/users (HANDOFF
// role management — admin only). auth-worker only knows admin|user, so HANDOFF's
// own `users` table is the source of truth for estimator/assignment/pm/admin.

import { json } from "./http.js";
import { verifyIdentity, resolveActor } from "./auth.js";

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

export async function listUsers({ sql }) {
  const rows = await sql`select id, einbau_username, name, role, active, created_at from users order by name`;
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

  const [row] = await sql`
    insert into users (einbau_username, name, role, active)
    values (${username}, ${body.name}, ${role}, ${active})
    on conflict (einbau_username) do update
      set name = excluded.name, role = excluded.role, active = excluded.active
    returning id, einbau_username, name, role, active, created_at`;

  return json({ user: row, upserted_by: auth.actor.einbau_username });
}

export async function deactivateUser({ params, sql, auth }) {
  const [row] = await sql`
    update users set active = false where id = ${params.id}
    returning id, einbau_username, name, role, active`;
  if (!row) return json({ error: "not_found" }, 404);
  return json({ user: row, deactivated_by: auth.actor.einbau_username });
}
