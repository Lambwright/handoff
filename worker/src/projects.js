// The dashboard queue — every handoff, optionally filtered by status.

import { json } from "./http.js";

export async function listProjects({ url, sql }) {
  const status = url.searchParams.get("status");
  const rows = status
    ? await sql`select * from projects where status = ${status} order by created_at desc`
    : await sql`select * from projects order by created_at desc`;
  return json({ projects: rows });
}
