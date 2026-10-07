// The dashboard queue + single-handoff reads (used by the Procore project-level
// Full Screen tool's PM read view).

import { json } from "./http.js";
import { isPostCreation } from "./checklist.js";
import { pmMayAccess } from "./auth.js";

// A handoff's department is the one it was most recently assigned to.
export async function listProjects({ url, sql, auth }) {
  const status = url.searchParams.get("status");
  const department = url.searchParams.get("department");
  const rows = status
    ? await sql`select * from projects where status = ${status} order by created_at desc`
    : await sql`select * from projects order by created_at desc`;

  let assignedTo = null;
  if (department) {
    const latest = await sql`
      select distinct on (project_id) project_id, assigned_pm from assignment_events
      where assigned_pm is not null order by project_id, decided_at desc`;
    assignedTo = new Map(latest.map((r) => [r.project_id, String(r.assigned_pm)]));
  }

  const visible = [];
  for (const p of rows) {
    if (assignedTo && assignedTo.get(p.id) !== String(department)) continue;
    if (await pmMayAccess(sql, auth?.actor, p)) visible.push(p);
  }
  return json({ projects: visible });
}

// GET /projects/by-procore/:procoreId — the HANDOFF handoff for a Procore
// project id, or 404 if that project wasn't created through HANDOFF.
export async function getProjectByProcore({ params, sql, auth }) {
  const [project] = await sql`select * from projects where procore_project_id = ${params.procoreId}`;
  if (!project || !(await pmMayAccess(sql, auth?.actor, project))) {
    return json({ error: "not_found", detail: "This project wasn't created through HANDOFF." }, 404);
  }
  return json({ project });
}

// GET /projects/:id/summary — everything the PM read view needs in one call:
// the handoff, its gate tasks (with open gaps), the latest brief, the latest
// assignment decision, the housed documents, and the notification ledger.
export async function getProjectSummary({ params, sql, auth }) {
  const [project] = await sql`select * from projects where id = ${params.id}`;
  if (!project || !(await pmMayAccess(sql, auth?.actor, project))) return json({ error: "not_found" }, 404);

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
    // Open items for the PM view: deferred, failed verification, or a
    // post-creation task not yet done (tender emails).
    gaps: gateTasks.filter(
      (t) =>
        ["deferred", "verify_failed"].includes(t.status) ||
        (isPostCreation(t.task_type) && t.status !== "complete")
    ),
    brief: briefRow[0] || null,
    assignment: assignmentRow[0] || null,
    docs,
    notifications,
  });
}
