// Handoff brief generation. Inputs: the PO document / tender correspondence
// metadata housed during the gate, the estimator's scope summary, and estimate
// cost/hours/margin read live from Procore's project-level Estimating tool (this
// data never has to leave Procore). Claude turns that into a structured brief
// for the incoming PM. Email delivery is STUBbed — see notify.js.

import { json } from "./http.js";
import { procoreFetch } from "./procore.js";
import { ESTIMATING } from "./procore-shapes.js";
import { callClaude, extractJSON } from "./claude.js";
import { writeNotification } from "./notify.js";

async function loadEstimateSummary(env, project) {
  try {
    const { ok, data } = await procoreFetch(env, ESTIMATING.summaryPath(project.procore_project_id), {
      version: ESTIMATING.version,
    });
    return ok ? ESTIMATING.parseSummary(data) : null;
  } catch {
    return null;
  }
}

export async function generateBrief(env, sql, project, assignedPm) {
  const [tasks, docs, estimateSummary] = await Promise.all([
    sql`select * from gate_tasks where project_id = ${project.id}`,
    sql`select doc_type, source_ref, curated_at from back_of_house_docs where project_id = ${project.id}`,
    loadEstimateSummary(env, project),
  ]);

  const byType = Object.fromEntries(tasks.map((t) => [t.task_type, t]));
  const gaps = tasks
    .filter((t) => ["deferred", "verify_failed"].includes(t.status))
    .map((t) => ({ task_type: t.task_type, label: t.label, reason: t.deferred_reason || t.verify_note || "unresolved" }));

  let content;
  try {
    const text = await callClaude(env, {
      maxTokens: 1200,
      system:
        "You write a short, practical handoff brief for a project manager at Einbau Services (a millwork installation " +
        "subcontractor) who is about to inherit a project they had no part in estimating. Use only the facts given — " +
        "never invent scope, dates, or numbers. Reply with ONLY a JSON object: " +
        '{"scope":"...","challenges":"...","client_requirements":"...","billing_notes":"...","key_contacts":"...","key_dates":"..."}. ' +
        "Keep each field to 2-4 sentences, plain language, no bullet-point markup.",
      userMessage: JSON.stringify({
        project: { name: project.name, type: project.project_type, address: project.address, customer: project.customer, timeline: project.timeline, po_number: project.po_number },
        scope_summary: byType.scope_summary?.value || null,
        site_contact: byType.site_contact?.value || null,
        documents_on_file: docs,
        estimate_summary: estimateSummary,
        known_gaps: gaps,
      }),
    });
    content = extractJSON(text);
  } catch (e) {
    content = {
      scope: byType.scope_summary?.value?.text || byType.scope_summary?.value || "(Claude unavailable — see gate scope summary directly.)",
      challenges: null,
      client_requirements: null,
      billing_notes: null,
      key_contacts: byType.site_contact?.value || null,
      key_dates: project.timeline,
      claude_error: e.message,
    };
  }

  const [brief] = await sql`
    insert into handoff_briefs (project_id, pm_id, content, gaps_flagged)
    values (${project.id}, ${assignedPm || null}, ${JSON.stringify(content)}::jsonb, ${JSON.stringify(gaps)}::jsonb)
    returning *`;

  await writeNotification(sql, {
    projectId: project.id,
    channel: "email",
    recipient: assignedPm,
    subject: `Handoff brief: ${project.name}`,
    body: JSON.stringify(content),
  });

  return brief;
}

export async function getBrief({ params, sql }) {
  const [brief] = await sql`
    select * from handoff_briefs where project_id = ${params.projectId} order by generated_at desc limit 1`;
  if (!brief) return json({ error: "not_found" }, 404);
  return json({ brief });
}
