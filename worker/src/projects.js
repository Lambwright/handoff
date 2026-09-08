// The dashboard queue + single-handoff reads (used by the Procore project-level
// Full Screen tool's PM read view).

import { json } from "./http.js";

export async function listProjects({ url, sql }) {
  const status = url.searchParams.get("status");
  const rows = status
    ? await sql`select * from projects where status = ${status} order by created_at desc`
    : await sql`select * from projects order by created_at desc`;
  return json({ projects: rows });
}

// GET /projects/by-procore/:procoreId — the HANDOFF handoff for a Procore
// project id, or 404 if that project wasn't created through HANDOFF.
export async function getProjectByProcore({ params, sql }) {
  const [project] = await sql`select * from projects where procore_project_id = ${params.procoreId}`;
  if (!project) return json({ error: "not_found", detail: "This project wasn't created through HANDOFF." }, 404);
  return json({ project });
}

// GET /projects/:id/summary — everything the PM read view needs in one call:
// the handoff, its gate tasks (with open gaps), the latest brief, the latest
// assignment decision, the housed documents, and the notification ledger.
export async function getProjectSummary({ params, sql }) {
  const [project] = await sql`select * from projects where id = ${params.id}`;
  if (!project) return json({ error: "not_found" }, 404);

  const [gateTasks, briefRow, assignmentRow, docs, notifications] = await Promise.all([
    sql`select * from gate_tasks where project_id = ${params.id} order by created_at`,
    sql`select * from handoff_briefs where project_id = ${params.id} order by generated_at desc limit 1`,
    sql`select * from assignment_events where project_id = ${params.id} and assigned_pm is not null order by decided_at desc limit 1`,
    sql`select id, doc_type, source_ref, content_type, size_bytes, pushed_at, curated_at from back_of_house_docs where project_id = ${params.id} order by curated_at`,
    sql`select * from notifications where project_id = ${params.id} order by created_at desc`,
  ]);

  return json({
    project,
    gate_tasks: gateTasks,
    gaps: gateTasks.filter((t) => ["deferred", "verify_failed"].includes(t.status)),
    brief: briefRow[0] || null,
    assignment: assignmentRow[0] || null,
    docs,
    notifications,
  });
}
