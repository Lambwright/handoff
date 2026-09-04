// The Purgatory gate — CRUD on gate_tasks, document intake into R2, and the
// submit -> create.js handoff. Everything here operates on HANDOFF's own
// database; no Procore project exists until submitGate's pipeline runs.

import { json } from "./http.js";
import { runCreatePipeline, verifyBackedTask, pushOneDocument, FIELD_PUSHERS } from "./create.js";

async function loadProjectAndTasks(sql, projectId) {
  const [project] = await sql`select * from projects where id = ${projectId}`;
  if (!project) return { project: null, tasks: [] };
  const tasks = await sql`select * from gate_tasks where project_id = ${projectId} order by created_at`;
  return { project, tasks };
}

export async function getGate({ params, sql }) {
  const { project, tasks } = await loadProjectAndTasks(sql, params.id);
  if (!project) return json({ error: "not_found" }, 404);
  return json({ project, tasks });
}

// A gate task is either completed with a value, or explicitly deferred with a
// reason — never silently left blank. Completing address / customer / timeline /
// po_number mirrors the value onto the projects row.
//
// Before creation (project.status === 'gate'), that mirroring is all this does —
// there's no Procore project yet to push to. AFTER creation, completing one of
// those same fields is a GAP getting resolved (a deferred item filled in late),
// so this also re-pushes that one field to the now-existing Procore project
// immediately (create.js's FIELD_PUSHERS, force:true) rather than waiting for
// another full pipeline run.
export async function patchGateTask({ params, request, env, sql, auth }) {
  const body = await request.json().catch(() => null);
  if (!body) return json({ error: "invalid_request" }, 400);

  const [task] = await sql`select * from gate_tasks where id = ${params.id}`;
  if (!task) return json({ error: "not_found" }, 404);

  const [project] = await sql`select * from projects where id = ${task.project_id}`;
  const postCreation = project && project.status !== "gate";

  let updated;
  if (body.defer) {
    if (!body.reason || !String(body.reason).trim()) {
      return json({ error: "invalid_request", detail: "A reason is required to defer a gate task." }, 400);
    }
    [updated] = await sql`
      update gate_tasks
      set status = 'deferred', deferred_reason = ${body.reason}, resolved_by = ${auth.actor.einbau_username},
          resolved_at = now()
      where id = ${params.id}
      returning *`;
    return json({ task: updated });
  }

  if (body.value === undefined) return json({ error: "invalid_request", detail: "value or defer is required" }, 400);
  [updated] = await sql`
    update gate_tasks
    set status = 'complete', value = ${JSON.stringify(body.value)}::jsonb, deferred_reason = null,
        resolved_by = ${auth.actor.einbau_username}, resolved_at = now()
    where id = ${params.id}
    returning *`;

  // Neon's tagged-template driver doesn't support a dynamic identifier helper
  // the way postgres.js does, so this is spelled out per column rather than
  // interpolating `task.task_type` as a column name.
  let projectPatch = null;
  if (task.task_type === "address") projectPatch = sql`update projects set address = ${JSON.stringify(body.value)}::jsonb, updated_at = now() where id = ${task.project_id} returning *`;
  else if (task.task_type === "customer") projectPatch = sql`update projects set customer = ${JSON.stringify(body.value)}::jsonb, updated_at = now() where id = ${task.project_id} returning *`;
  else if (task.task_type === "timeline") projectPatch = sql`update projects set timeline = ${JSON.stringify(body.value)}::jsonb, updated_at = now() where id = ${task.project_id} returning *`;
  else if (task.task_type === "po_number") projectPatch = sql`update projects set po_number = ${body.value?.po_number ?? body.value}, updated_at = now() where id = ${task.project_id} returning *`;

  if (projectPatch) {
    const [freshProject] = await projectPatch;

    if (postCreation && FIELD_PUSHERS[task.task_type]) {
      const pushError = await FIELD_PUSHERS[task.task_type](env, sql, freshProject, { force: true });
      [updated] = await sql`
        update gate_tasks
        set status = ${pushError ? "verify_failed" : "complete"}, verify_note = ${pushError || "pushed to Procore"}, verified_at = now()
        where id = ${params.id}
        returning *`;
    }
  }

  return json({ task: updated });
}

// Manual re-check — meaningful once a Procore project exists (post-submit). If
// there's no procore_project_id yet, there's nothing to verify against.
export async function verifyGateTask({ params, env, sql }) {
  const [task] = await sql`select * from gate_tasks where id = ${params.id}`;
  if (!task) return json({ error: "not_found" }, 404);
  if (!task.verify_backing) return json({ error: "not_verifiable", detail: "This item has no live-check backing it." }, 400);

  const [project] = await sql`select * from projects where id = ${task.project_id}`;
  if (!project?.procore_project_id) {
    return json({ error: "not_yet_created", detail: "The Procore project doesn't exist yet — nothing to verify against." }, 409);
  }

  const result = await verifyBackedTask(env, project, task);

  const [updated] = await sql`
    update gate_tasks
    set status = ${result.found ? "complete" : "verify_failed"}, verify_note = ${result.note}, verified_at = now()
    where id = ${params.id}
    returning *`;

  return json({ task: updated, result });
}

// PO document / tender correspondence intake. Multipart upload -> R2, tracked in
// back_of_house_docs. Before creation, the upload itself is the evidence — the
// task goes straight to 'complete' and gets pushed + verified during the
// create.js pipeline. AFTER creation (a deferred doc gap, resolved late), the
// project already exists, so this pushes the document immediately instead of
// waiting for a pipeline that already ran.
export async function uploadGateDocument({ params, request, env, sql, auth }, docType) {
  const [project] = await sql`select * from projects where id = ${params.id}`;
  if (!project) return json({ error: "not_found" }, 404);

  const form = await request.formData().catch(() => null);
  const file = form?.get("file");
  if (!file || typeof file.arrayBuffer !== "function") {
    return json({ error: "invalid_request", detail: "multipart form-data with a 'file' field is required" }, 400);
  }

  const key = `${project.id}/${docType}/${crypto.randomUUID()}-${file.name}`;
  const bytes = await file.arrayBuffer();
  await env.DOCS.put(key, bytes, { httpMetadata: { contentType: file.type || "application/octet-stream" } });

  const [doc] = await sql`
    insert into back_of_house_docs (project_id, doc_type, source_ref, r2_key, content_type, size_bytes)
    values (${project.id}, ${docType}, ${file.name}, ${key}, ${file.type || null}, ${bytes.byteLength})
    returning *`;

  let status = "complete";
  let verifyNote = null;
  if (project.procore_project_id) {
    const result = await pushOneDocument(env, sql, project, doc);
    status = result.ok ? "complete" : "verify_failed";
    verifyNote = result.ok ? "pushed to Procore" : result.error;
  }

  const verifiedAt = verifyNote ? new Date().toISOString() : null;
  const [task] = await sql`
    update gate_tasks
    set status = ${status},
        value = ${JSON.stringify({ doc_id: doc.id, filename: file.name })}::jsonb,
        deferred_reason = null, verify_note = ${verifyNote}, verified_at = ${verifiedAt},
        resolved_by = ${auth.actor.einbau_username}, resolved_at = now()
    where project_id = ${project.id} and task_type = ${docType}
    returning *`;

  return json({ doc, task });
}

function gateIsComplete(tasks) {
  const blocking = tasks.filter((t) => t.required);
  const unresolved = blocking.filter((t) => !["complete", "deferred"].includes(t.status));
  return { ready: unresolved.length === 0, unresolved };
}

// The one big step: validate the gate, then run the resumable create+distribute
// pipeline (create.js). Re-POSTing here is safe — a project already past 'gate'
// just returns its current progress instead of re-running anything.
export async function submitGate({ params, sql, env, auth }) {
  const { project, tasks } = await loadProjectAndTasks(sql, params.id);
  if (!project) return json({ error: "not_found" }, 404);

  if (project.status !== "gate") {
    return json({ project, already_submitted: true });
  }

  const { ready, unresolved } = gateIsComplete(tasks);
  if (!ready) {
    return json(
      {
        error: "gate_incomplete",
        detail: "Every required item needs a value or a deferral reason before this can be submitted.",
        unresolved: unresolved.map((t) => ({ id: t.id, task_type: t.task_type, label: t.label })),
      },
      400
    );
  }

  const result = await runCreatePipeline(env, sql, project.id, auth.actor.einbau_username);
  return json(result);
}
