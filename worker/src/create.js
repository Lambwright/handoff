// The submit -> create + distribute pipeline. Runs once the Purgatory gate is
// complete: creates the Procore project from housed data, distributes address /
// customer / PO number / documents / correspondence, verifies each push landed,
// renames the source estimate, and hands off to assignment.
//
// Every step is resumable: `projects.create_progress` tracks which steps already
// succeeded, so re-running submit (a retried request, a step that failed
// halfway) never repeats a write that already landed.

import { procoreFetch } from "./procore.js";
import { PROJECT, STAGES, DIRECTORY, DOCUMENTS, EMAIL_TOOL, ESTIMATE_RENAME } from "./procore-shapes.js";
import { batched } from "./util.js";

async function markProgress(sql, projectId, patch) {
  await sql`
    update projects
    set create_progress = create_progress || ${JSON.stringify(patch)}::jsonb, updated_at = now()
    where id = ${projectId}`;
}

async function reload(sql, projectId) {
  const [p] = await sql`select * from projects where id = ${projectId}`;
  return p;
}

async function ensureProjectCreated(env, sql, project) {
  if (project.procore_project_id) return { project, error: null };

  const { ok: stagesOk, data: stages } = await procoreFetch(env, STAGES.listPath(env.PROCORE_COMPANY_ID), {
    version: STAGES.version,
  });
  const stageId = stagesOk ? STAGES.idByName(stages, STAGES.TARGET_CREATE_STAGE) : null;

  const payload = PROJECT.buildCreatePayload({
    companyId: env.PROCORE_COMPANY_ID,
    name: project.name,
    projectNumber: project.project_number,
    projectType: project.project_type,
    stageId,
    timeline: project.timeline,
  });

  const { ok, status, data } = await procoreFetch(env, PROJECT.createPath(), {
    method: "POST",
    version: PROJECT.version,
    body: payload,
  });
  if (!ok) {
    return { project, error: `project create failed (HTTP ${status}): ${JSON.stringify(data).slice(0, 300)}` };
  }

  const procoreProjectId = data.id;
  // The create response usually carries the project's inbound email address; if
  // not, a follow-up GET has it. Estimators forward tender emails to it.
  let inboundEmail = PROJECT.extractInboundEmail(data);
  if (!inboundEmail) {
    const { ok: gotOk, data: full } = await procoreFetch(env, PROJECT.getPath(procoreProjectId, env.PROCORE_COMPANY_ID), {
      version: PROJECT.version,
    });
    if (gotOk) inboundEmail = PROJECT.extractInboundEmail(full);
  }

  await sql`
    update projects
    set procore_project_id = ${procoreProjectId}, stage = ${STAGES.TARGET_CREATE_STAGE},
        inbound_email_address = ${inboundEmail}, status = 'creating',
        procore_created_at = now(), updated_at = now()
    where id = ${project.id}`;
  await markProgress(sql, project.id, { project_created: true });
  return { project: await reload(sql, project.id), error: null };
}

// `force` skips the create_progress short-circuit — used when gate.js re-pushes
// a single field as part of resolving a post-creation gap (the field changed
// after the pipeline already ran once, so "already set" no longer applies).
async function setAddress(env, sql, project, { force = false } = {}) {
  if ((!force && project.create_progress?.address_set) || !project.address) return null;
  const { ok, status, data } = await procoreFetch(env, PROJECT.patchPath(project.procore_project_id, env.PROCORE_COMPANY_ID), {
    method: "PATCH",
    version: PROJECT.version,
    body: PROJECT.buildAddressPatch({ companyId: env.PROCORE_COMPANY_ID, address: project.address }),
  });
  if (!ok) return `address PATCH failed (HTTP ${status}): ${JSON.stringify(data).slice(0, 300)}`;
  await markProgress(sql, project.id, { address_set: true });
  return null;
}

async function setCustomer(env, sql, project, { force = false } = {}) {
  if ((!force && project.create_progress?.customer_set) || !project.customer) return null;
  const customer = project.customer;
  let directoryId = customer.directory_id || customer.suggestion?.match?.directory_id || null;

  if (!directoryId && (customer.create || !directoryId) && customer.name) {
    // Coordinated write at the Project Directory level — per the kickoff doc this
    // cascades to the Company Directory automatically (confirm with a real
    // sandbox write; see procore-shapes.js DIRECTORY TODO).
    const { ok, status, data } = await procoreFetch(
      env,
      DIRECTORY.createProjectDirectoryCompanyPath(project.procore_project_id),
      { method: "POST", version: DIRECTORY.version, body: DIRECTORY.buildDirectoryCompany(customer) }
    );
    if (!ok) return `customer create failed (HTTP ${status}): ${JSON.stringify(data).slice(0, 300)}`;
    directoryId = data.id;
  }
  if (!directoryId) return "customer has no directory_id and no name to create from";

  const { ok, status, data } = await procoreFetch(env, PROJECT.patchPath(project.procore_project_id, env.PROCORE_COMPANY_ID), {
    method: "PATCH",
    version: PROJECT.version,
    body: DIRECTORY.buildCustomerPatch({ companyId: env.PROCORE_COMPANY_ID, directoryId }),
  });
  if (!ok) return `customer PATCH failed (HTTP ${status}): ${JSON.stringify(data).slice(0, 300)}`;
  await markProgress(sql, project.id, { customer_set: true });
  return null;
}

async function setPoNumber(env, sql, project, { force = false } = {}) {
  if ((!force && project.create_progress?.po_set) || !project.po_number) return null;
  const { ok, status, data } = await procoreFetch(env, PROJECT.patchPath(project.procore_project_id, env.PROCORE_COMPANY_ID), {
    method: "PATCH",
    version: PROJECT.version,
    body: PROJECT.buildPoNumberPatch({ companyId: env.PROCORE_COMPANY_ID, poNumber: project.po_number }),
  });
  if (!ok) return `PO number PATCH failed (HTTP ${status}): ${JSON.stringify(data).slice(0, 300)}`;
  await markProgress(sql, project.id, { po_set: true });
  return null;
}

async function setTimeline(env, sql, project, { force = false } = {}) {
  if ((!force && project.create_progress?.timeline_set) || !project.timeline?.start_date) return null;
  const { ok, status, data } = await procoreFetch(env, PROJECT.patchPath(project.procore_project_id, env.PROCORE_COMPANY_ID), {
    method: "PATCH",
    version: PROJECT.version,
    body: PROJECT.buildTimelinePatch({ companyId: env.PROCORE_COMPANY_ID, timeline: project.timeline }),
  });
  if (!ok) return `timeline PATCH failed (HTTP ${status}): ${JSON.stringify(data).slice(0, 300)}`;
  await markProgress(sql, project.id, { timeline_set: true });
  return null;
}

// Exposed so gate.js can re-push ONE field immediately when a post-creation gap
// (a deferred item, resolved late) is filled in — same write logic the pipeline
// itself uses, just called with force:true against a single field.
export const FIELD_PUSHERS = { address: setAddress, customer: setCustomer, po_number: setPoNumber, timeline: setTimeline };

// Uploads ONE housed PO document into the now-existing Procore project's
// Documents tool. (Tender correspondence is NOT pushed by HANDOFF — the
// estimator forwards those to the project inbox directly, and HANDOFF only
// verifies; see the post_creation task in checklist.js.) Shared by the
// pipeline's pushDocuments below and gate.js's post-creation gap path.
export async function pushOneDocument(env, sql, project, doc) {
  if (doc.doc_type !== "po_document") return { ok: true }; // nothing else is pushed
  const bytes = await env.DOCS.get(doc.r2_key);
  if (!bytes) return { ok: false, error: `not found in R2 (${doc.r2_key})` };

  const form = new FormData();
  form.append("file", new Blob([await bytes.arrayBuffer()], { type: doc.content_type || undefined }), doc.source_ref);
  // TODO(sandbox): confirm the multipart upload contract for DOCUMENTS.uploadPath.
  const res = await fetch(`${env.PROCORE_API_BASE}/rest/${DOCUMENTS.version}${DOCUMENTS.uploadPath(project.procore_project_id)}`, {
    method: "POST",
    headers: { "Procore-Company-Id": env.PROCORE_COMPANY_ID },
    body: form,
  });
  if (!res.ok) return { ok: false, error: `po_document upload failed: HTTP ${res.status}` };

  await sql`update back_of_house_docs set pushed_at = now() where id = ${doc.id}`;
  return { ok: true };
}

// Uploads every not-yet-pushed PO document into the project's Documents tool.
async function pushDocuments(env, sql, project) {
  const docs = await sql`
    select * from back_of_house_docs
    where project_id = ${project.id} and pushed_at is null and doc_type = 'po_document'`;
  const errors = [];

  await batched(docs, async (doc) => {
    try {
      const result = await pushOneDocument(env, sql, project, doc);
      if (!result.ok) errors.push(`${doc.doc_type} ${doc.source_ref}: ${result.error}`);
    } catch (e) {
      errors.push(`${doc.doc_type} ${doc.source_ref}: ${e.message}`);
    }
  });

  if (errors.length === 0) await markProgress(sql, project.id, { documents_pushed: true });
  return errors;
}

// The self-report + automated verification pattern, run AFTER distribution
// (there is no Procore project to check against during the gate itself — see
// gate.js). Any gate task with a verify_backing gets a live GET; a miss becomes
// a gap rather than blocking the pipeline.
export async function verifyBackedTask(env, project, task) {
  if (task.verify_backing === "email_communications") {
    const { ok, data } = await procoreFetch(env, EMAIL_TOOL.listPath(project.procore_project_id), {
      version: EMAIL_TOOL.version,
    });
    const count = ok ? EMAIL_TOOL.countFromList(data) : 0;
    return { found: count > 0, note: ok ? `${count} email(s) on the project` : "Procore request failed" };
  }
  if (task.verify_backing === "documents") {
    const { ok, data } = await procoreFetch(env, DOCUMENTS.listPath(project.procore_project_id), {
      version: DOCUMENTS.version,
    });
    const folder = ok ? (data || []).find((d) => d.name === DOCUMENTS.PO_FOLDER_NAME) : null;
    return { found: Boolean(folder), note: folder ? `found "${DOCUMENTS.PO_FOLDER_NAME}"` : "folder not found" };
  }
  return { found: false, note: `no verifier for backing "${task.verify_backing}"` };
}

async function verifyDistribution(env, sql, project) {
  const tasks = await sql`
    select * from gate_tasks where project_id = ${project.id} and verify_backing is not null and status = 'complete'`;

  await batched(tasks, async (task) => {
    const result = await verifyBackedTask(env, project, task);
    await sql`
      update gate_tasks
      set status = ${result.found ? "complete" : "verify_failed"}, verify_note = ${result.note}, verified_at = now()
      where id = ${task.id}`;
  });

  await markProgress(sql, project.id, { verified: true });
}

async function renameEstimate(env, sql, project) {
  if (project.create_progress?.estimate_renamed || !project.po_number) return null;
  const newTitle = ESTIMATE_RENAME.buildRenamedTitle(project.name, project.po_number);
  const { ok, status, data } = await procoreFetch(
    env,
    ESTIMATE_RENAME.bidBoardPatchPath(env.PROCORE_COMPANY_ID, project.source_bid_id),
    { method: "PATCH", version: ESTIMATE_RENAME.version, body: { name: newTitle } }
  );
  // Non-fatal: renaming the source estimate is a nice-to-have, not a blocker for
  // the handoff itself. Record the miss and move on.
  if (!ok) return `estimate rename failed (HTTP ${status}): ${JSON.stringify(data).slice(0, 200)}`;
  await markProgress(sql, project.id, { estimate_renamed: true });
  return null;
}

export async function runCreatePipeline(env, sql, projectId, actorUsername) {
  const errors = [];
  let project = await reload(sql, projectId);
  if (!project) throw new Error(`project ${projectId} not found`);

  const created = await ensureProjectCreated(env, sql, project);
  project = created.project;
  if (created.error) {
    errors.push(created.error);
    // Nothing downstream is reachable without a Procore project — stop here.
    return { project, errors, complete: false };
  }

  for (const step of [setAddress, setCustomer, setPoNumber, setTimeline]) {
    const err = await step(env, sql, project);
    if (err) errors.push(err);
    project = await reload(sql, projectId);
  }

  const pushErrors = await pushDocuments(env, sql, project);
  errors.push(...pushErrors);
  project = await reload(sql, projectId);

  await verifyDistribution(env, sql, project);

  const renameErr = await renameEstimate(env, sql, project);
  if (renameErr) errors.push(renameErr);

  await sql`update projects set status = 'assigning', updated_at = now() where id = ${projectId} and status <> 'assigning'`;
  project = await reload(sql, projectId);

  return { project, errors, complete: true, submitted_by: actorUsername };
}
