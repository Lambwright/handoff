// Admin-editable PM <-> region/client/job-type affinity table. Replaces
// geographic-distance scoring entirely — this captures real institutional
// relationships and preferences that pure distance math would miss.

import { json } from "./http.js";

export async function listAffinity({ sql }) {
  const rows = await sql`select * from pm_affinity order by updated_at desc`;
  return json({ affinity: rows });
}

export async function upsertAffinity({ request, sql, auth }) {
  const body = await request.json().catch(() => null);
  if (!body?.preferred_pm) return json({ error: "invalid_request", detail: "preferred_pm is required" }, 400);

  if (body.id) {
    const [row] = await sql`
      update pm_affinity
      set region = ${body.region || null}, client = ${body.client || null}, job_type = ${body.job_type || null},
          preferred_pm = ${body.preferred_pm}, weight = ${body.weight ?? 1}, note = ${body.note || null},
          updated_by = ${auth.actor.einbau_username}, updated_at = now()
      where id = ${body.id}
      returning *`;
    if (!row) return json({ error: "not_found" }, 404);
    return json({ affinity: row });
  }

  const [row] = await sql`
    insert into pm_affinity (region, client, job_type, preferred_pm, weight, note, updated_by)
    values (${body.region || null}, ${body.client || null}, ${body.job_type || null}, ${body.preferred_pm},
            ${body.weight ?? 1}, ${body.note || null}, ${auth.actor.einbau_username})
    returning *`;
  return json({ affinity: row }, 201);
}
