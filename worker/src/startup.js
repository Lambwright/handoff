// Extensible startup-task runner. A plain array of discrete steps, not one
// hardcoded action — more will be added later (kickoff doc). Each task is
// idempotent on (project_id, task_type): re-running after a partial failure only
// retries the tasks that didn't already succeed.

const STARTUP_TASKS = [
  {
    task_type: "resource_planning_request",
    // TODO: the original design (a "request" with timeline/notes) was wrong —
    // Resource Planning has no request concept. The real mechanism (confirmed
    // live in punch-worker, documented in procore-shapes.js's RESOURCE_PLANNING)
    // is resolving the assigned PM to an RP person_id by name-matching against
    // RP's own ~850-person roster, then adding them as a role on the RP
    // project. Real rework, not wired yet — fails clearly instead of silently
    // until it's built, so it shows up in /projects/:id/notifications as a
    // known gap rather than a confusing crash.
    async run() {
      throw new Error("Resource Planning startup task not yet implemented — see procore-shapes.js RESOURCE_PLANNING comment");
    },
  },
];

export async function runStartupTasks(env, sql, project) {
  const results = [];
  for (const task of STARTUP_TASKS) {
    const [existing] = await sql`
      select * from startup_tasks where project_id = ${project.id} and task_type = ${task.task_type}`;
    if (existing?.status === "complete") {
      results.push(existing);
      continue;
    }

    const [row] = existing
      ? await sql`update startup_tasks set status = 'running' where id = ${existing.id} returning *`
      : await sql`
          insert into startup_tasks (project_id, task_type, status) values (${project.id}, ${task.task_type}, 'running')
          returning *`;

    try {
      const result = await task.run(env, project);
      const [done] = await sql`
        update startup_tasks set status = 'complete', result = ${JSON.stringify(result)}::jsonb, ran_at = now()
        where id = ${row.id} returning *`;
      results.push(done);
    } catch (e) {
      const [failed] = await sql`
        update startup_tasks set status = 'failed', result = ${JSON.stringify({ error: e.message })}::jsonb, ran_at = now()
        where id = ${row.id} returning *`;
      results.push(failed);
    }
  }
  return results;
}
