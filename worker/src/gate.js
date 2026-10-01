// The Purgatory gate — CRUD on gate_tasks, document intake into R2, and the
// submit -> create.js handoff. Everything here operates on HANDOFF's own
// database; no Procore project exists until submitGate's pipeline runs.

import { json } from "./http.js";
import { runCreatePipeline, verifyBackedTask, pushOneDocument, FIELD_PUSHERS } from "./create.js";
import { isPostCreation } from "./checklist.js";
import { callClaude } from "./claude.js";
import { procoreFetch } from "./procore.js";
import { EMAIL_TOOL, BID_BOARD, ESTIMATING } from "./procore-shapes.js";
import { stripHtml } from "./util.js";

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
  const v = body.value;
  let projectPatch = null;
  if (task.task_type === "address") projectPatch = sql`update projects set address = ${JSON.stringify(v)}::jsonb, updated_at = now() where id = ${task.project_id} returning *`;
  else if (task.task_type === "customer") projectPatch = sql`update projects set customer = ${JSON.stringify(v)}::jsonb, updated_at = now() where id = ${task.project_id} returning *`;
  else if (task.task_type === "timeline") projectPatch = sql`update projects set timeline = ${JSON.stringify(v)}::jsonb, updated_at = now() where id = ${task.project_id} returning *`;
  else if (task.task_type === "po_number") projectPatch = sql`update projects set po_number = ${v?.po_number ?? v}, updated_at = now() where id = ${task.project_id} returning *`;
  else if (task.task_type === "region") projectPatch = sql`update projects set region_id = ${v?.id ?? v}, updated_at = now() where id = ${task.project_id} returning *`;
  else if (task.task_type === "timezone") projectPatch = sql`update projects set timezone = ${v?.name ?? v}, updated_at = now() where id = ${task.project_id} returning *`;

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

// POST /projects/:id/scope-draft — AI-draft the scope summary from whatever
// context HANDOFF can reach: the bid record, its Procore notes, the primary
// Estimating proposal (real estimator-authored scope_of_work/inclusions/
// exclusions, once the project exists), and the tender emails forwarded into
// Procore's Emails tool. Bid drawings have no confirmed API path (see
// procore-shapes.js's BID_BOARD comment) — those arrive via the gate's manual
// upload instead, not this draft.
export async function draftScopeSummary({ params, env, sql }) {
  const [project] = await sql`select * from projects where id = ${params.id}`;
  if (!project) return json({ error: "not_found" }, 404);

  const bid = project.bid_snapshot || {};

  let bidNotes = [];
  if (bid.id) {
    const { ok, data } = await procoreFetch(env, BID_BOARD.notesPath(env.PROCORE_COMPANY_ID, bid.id), { version: BID_BOARD.notesVersion });
    if (ok && Array.isArray(data?.data)) {
      bidNotes = data.data.map((n) => n.value).filter(Boolean);
    }
  }

  let proposal = null;
  let summary = null;
  if (project.procore_project_id) {
    const { ok, data } = await procoreFetch(env, ESTIMATING.proposalsPath(project.procore_project_id), { version: ESTIMATING.version });
    if (ok) {
      const primary = ESTIMATING.findPrimaryProposal(data);
      if (primary) {
        proposal = {
          name: primary.name,
          total: primary.total,
          // scope_of_work/notes come back as rich-text HTML (<ul>/<li>/<strong>);
          // inclusions/exclusions are already plain strings.
          scope_of_work: primary.scope_of_work ? stripHtml(primary.scope_of_work) : null,
          inclusions: primary.inclusions || [],
          exclusions: primary.exclusions || [],
          notes: primary.notes ? stripHtml(primary.notes) : null,
        };
        const summaryRes = await procoreFetch(env, ESTIMATING.summaryPath(project.procore_project_id, primary.id), { version: ESTIMATING.version });
        if (summaryRes.ok) summary = ESTIMATING.parseSummary(summaryRes.data);
      }
    }
  }

  let emails = [];
  if (project.procore_project_id) {
    const { ok, data } = await procoreFetch(env, EMAIL_TOOL.listPath(project.procore_project_id), { version: EMAIL_TOOL.version });
    if (ok && Array.isArray(data?.emails)) {
      // Chronological (oldest first) so the draft reads the tender conversation in the
      // order it actually happened, not whatever order Procore's API returns it in.
      const sorted = [...data.emails].sort((a, b) => new Date(a.email_sent_at || 0) - new Date(b.email_sent_at || 0));
      // Bounded by total chars, not just count/per-email length — a handful of long
      // emails shouldn't get truncated to the same 800 chars as a one-line reply, but
      // the combined prompt still needs a ceiling on cost/latency regardless of how
      // many emails or how long they are. ~60k chars is comfortably inside Sonnet's
      // context window with room for the bid/estimate context alongside it.
      const CHAR_BUDGET = 60_000;
      let used = 0;
      for (const e of sorted) {
        const body = stripHtml(e.body);
        const snippet = body.slice(0, CHAR_BUDGET - used);
        if (!snippet) break;
        emails.push({ subject: e.subject, sent_at: e.email_sent_at, snippet });
        used += snippet.length;
        if (used >= CHAR_BUDGET) break;
      }
    }
  }

  let draft = "";
  try {
    draft = await callClaude(env, {
      maxTokens: 700,
      system:
        "You draft a short 'scope of work' summary for an Einbau Services millwork-installation project handoff, for the incoming PM. " +
        "If a primary estimating proposal is given, its scope_of_work/inclusions/exclusions are the estimator's own words — " +
        "ground the draft in those rather than re-inventing them, and use the other material to fill gaps or add context. " +
        "Use only the material given. If it's thin, say what's known and flag what's missing — do not invent scope. 4-8 sentences, plain prose, no bullet markup.",
      userMessage: JSON.stringify({
        project: { name: project.name, type: project.project_type, customer: project.customer?.name, address: project.address },
        bid: { name: bid.name, description: bid.description, estimate_total: bid.stats?.total, notes: bidNotes },
        primary_proposal: proposal,
        estimate_summary: summary,
        tender_emails: emails,
      }),
    });
  } catch (e) {
    draft = `(AI draft unavailable: ${e.message})`;
  }
  return json({
    draft,
    context: { tender_email_count: emails.length, bid_note_count: bidNotes.length, has_primary_proposal: Boolean(proposal) },
  });
}

function gateIsComplete(tasks) {
  // post_creation items (tender emails, etc.) are done in Procore after the
  // project exists — they don't block the submit that creates it.
  const blocking = tasks.filter((t) => t.required && !isPostCreation(t.task_type));
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
