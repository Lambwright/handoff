// Extensible startup-task runner. A plain array of discrete steps, not one
// hardcoded action — more will be added later (kickoff doc). Each task is
// idempotent on (project_id, task_type): re-running after a partial failure only
// retries the tasks that didn't already succeed.

import { procoreFetch } from "./procore.js";
import { RESOURCE_PLANNING } from "./procore-shapes.js";
import { handoffTag } from "./util.js";

const STARTUP_TASKS = [
  {
    task_type: "resource_planning_request",
    async run(env, project) {
      const { ok, status, data } = await procoreFetch(env, RESOURCE_PLANNING.createRequestPath(), {
        method: "POST",
        version: RESOURCE_PLANNING.version,
        body: RESOURCE_PLANNING.buildRequest({
          companyId: env.PROCORE_COMPANY_ID,
          procoreProjectId: project.procore_project_id,
          timeline: project.timeline,
          note: `${handoffTag(project.id)} auto-created at handoff for the confirmed project timeline.`,
        }),
      });
      if (!ok) throw new Error(`Resource Planning request failed: HTTP ${status} ${JSON.stringify(data).slice(0, 200)}`);
      return data;
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
