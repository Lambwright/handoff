// PM assignment: workload + timeline-overlap aggregation, the admin-editable
// affinity table, and a Claude-synthesized recommendation. The assignment team
// always has the final call — this never auto-assigns.
//
// Explicitly NOT built here (kickoff doc): headcount-on-site scoring (needs
// time-windowed Resource Planning data) and geographic distance scoring (the
// affinity table replaces it entirely).

import { json } from "./http.js";
import { procoreFetch, procoreFetchAll } from "./procore.js";
import { PROJECT, STAGES } from "./procore-shapes.js";
import { callClaude, extractJSON } from "./claude.js";
import { batched } from "./util.js";
import { generateBrief } from "./brief.js";
import { runStartupTasks } from "./startup.js";

// ---------------------------------------------------------------------------
// Pure logic (unit-tested without Procore/DB) — util.js's daysOverlap-style
// helpers, aggregation, and affinity scoring.
// ---------------------------------------------------------------------------

export function daysOverlap(aStart, aEnd, bStart, bEnd) {
  if (!aStart || !aEnd || !bStart || !bEnd) return 0;
  const s = Math.max(new Date(aStart).getTime(), new Date(bStart).getTime());
  const e = Math.min(new Date(aEnd).getTime(), new Date(bEnd).getTime());
  if (!Number.isFinite(s) || !Number.isFinite(e) || e <= s) return 0;
  return Math.round((e - s) / 86400000);
}

// Groups active projects by PM, aggregating count / value / overlap with the
// new project's own timeline. `pmDirectory` seeds every known PM at zero so a
// PM with no current load still shows up as a candidate.
export function aggregateWorkload(activeProjects, newTimeline, pmDirectory = []) {
  const byPm = new Map();
  for (const pm of pmDirectory) {
    byPm.set(pm.id, { pm_id: pm.id, pm_name: pm.name, active_project_count: 0, total_value: 0, overlap_days: 0, timeline: [] });
  }
  for (const p of activeProjects) {
    const pmId = PROJECT.extractPm(p);
    if (!pmId) continue;
    if (!byPm.has(pmId)) {
      byPm.set(pmId, { pm_id: pmId, pm_name: PROJECT.extractPmName(p), active_project_count: 0, total_value: 0, overlap_days: 0, timeline: [] });
    }
    const row = byPm.get(pmId);
    const t = PROJECT.extractTimeline(p);
    row.active_project_count += 1;
    row.total_value += PROJECT.extractValue(p);
    row.overlap_days += daysOverlap(t.start_date, t.end_date, newTimeline?.start_date, newTimeline?.end_date);
    row.timeline.push({ project_id: p.id, name: p.name, start_date: t.start_date, end_date: t.end_date, value: PROJECT.extractValue(p) });
  }
  return Array.from(byPm.values());
}

// Attaches the best-matching affinity row's weight for each candidate, given the
// new project's region/client/job_type. Institutional preference, not distance.
export function applyAffinity(candidates, affinityRows, { region, client, jobType }) {
  return candidates.map((c) => {
    const matches = affinityRows.filter(
      (a) =>
        a.preferred_pm === c.pm_id &&
        (!a.region || a.region === region) &&
        (!a.client || a.client === client) &&
        (!a.job_type || a.job_type === jobType)
    );
    const affinity_weight = matches.reduce((sum, m) => sum + Number(m.weight || 0), 0);
    return { ...c, affinity_weight, affinity_notes: matches.map((m) => m.note).filter(Boolean) };
  });
}

// Sort key ONLY — lower workload + higher affinity ranks first. This orders the
// comparison view; it never decides the assignment.
export function sortForDisplay(candidates) {
  return [...candidates].sort((a, b) => {
    const scoreA = a.affinity_weight * 2 - a.active_project_count - a.overlap_days / 30;
    const scoreB = b.affinity_weight * 2 - b.active_project_count - b.overlap_days / 30;
    return scoreB - scoreA;
  });
}

// ---------------------------------------------------------------------------
// Procore-backed loaders
// ---------------------------------------------------------------------------

async function loadActiveProjects(env) {
  const all = await procoreFetchAll(env, PROJECT.listPath(), { version: PROJECT.version, query: { company_id: env.PROCORE_COMPANY_ID } });
  return all.filter(STAGES.isActiveStage);
}

// The Procore Department dropdown itself is NOT a valid PM-candidate list —
// confirmed by Ben: it mixes real current PMs, people who no longer work at
// Einbau, and non-person buckets ("Project Management", "Back Log"). The
// candidate roster is HANDOFF's own curated `users` table instead — an admin
// maps each active pm-role person to their Department id once (Admin -> Users).
async function loadPmDirectory(sql) {
  const rows = await sql`
    select procore_department_id, procore_department_name, name
    from users
    where role = 'pm' and active = true and procore_department_id is not null`;
  return rows.map((r) => ({ id: r.procore_department_id, name: r.procore_department_name || r.name }));
}

async function computeCandidates(env, sql, project) {
  const [activeProjects, pmDirectory, affinityRows] = await Promise.all([
    loadActiveProjects(env),
    loadPmDirectory(sql),
    sql`select * from pm_affinity`,
  ]);

  let candidates = aggregateWorkload(activeProjects, project.timeline, pmDirectory);
  candidates = applyAffinity(candidates, affinityRows, {
    region: project.address?.state_code || null,
    client: project.customer?.name || null,
    jobType: project.project_type || null,
  });
  candidates = sortForDisplay(candidates);

  await batched(candidates, (c) =>
    sql`
      insert into pm_workload_cache (pm_id, pm_name, snapshot_at, active_project_count, total_value, timeline)
      values (${c.pm_id}, ${c.pm_name}, now(), ${c.active_project_count}, ${c.total_value}, ${JSON.stringify(c.timeline)}::jsonb)
      on conflict (pm_id) do update
        set pm_name = excluded.pm_name, snapshot_at = excluded.snapshot_at,
            active_project_count = excluded.active_project_count, total_value = excluded.total_value,
            timeline = excluded.timeline`
  );

  return candidates;
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

// GET /pm-roster — the curated candidate list on its own, for UI that needs to
// offer "pick a PM" without pulling full workload data (the affinity admin
// form's preferred_pm dropdown, mainly). Any active HANDOFF role can read it.
export async function getPmRoster({ sql }) {
  const roster = await loadPmDirectory(sql);
  return json({ roster });
}

export async function getAssignmentCandidates({ params, env, sql }) {
  const [project] = await sql`select * from projects where id = ${params.id}`;
  if (!project) return json({ error: "not_found" }, 404);
  if (!project.procore_project_id) {
    return json({ error: "not_created", detail: "This handoff hasn't been submitted yet." }, 409);
  }
  const candidates = await computeCandidates(env, sql, project);
  return json({ project, candidates });
}

export async function postAssignmentRecommendation({ params, env, sql }) {
  const [project] = await sql`select * from projects where id = ${params.id}`;
  if (!project) return json({ error: "not_found" }, 404);

  const candidates = await computeCandidates(env, sql, project);
  const [scopeTask] = await sql`select value from gate_tasks where project_id = ${project.id} and task_type = 'scope_summary'`;

  let recommended_pm = candidates[0]?.pm_id || null;
  let reasoning = "No candidates with workload data — pick manually.";
  if (candidates.length) {
    try {
      const text = await callClaude(env, {
        maxTokens: 500,
        system:
          "You help an Einbau Services operations team pick a project manager for a new millwork installation project. " +
          "You're given each candidate PM's current active-project count, total contract value, days of timeline overlap " +
          "with the new project, and an institutional-affinity weight (their track record with this region/client/job type). " +
          "Recommend ONE pm_id and give 2-3 sentences of plain-language reasoning a non-technical assignment coordinator can " +
          "read in five seconds. Reply with ONLY a JSON object: {\"recommended_pm\":\"<pm_id>\",\"reasoning\":\"...\"}.",
        userMessage: JSON.stringify({
          new_project: { name: project.name, type: project.project_type, timeline: project.timeline, scope: scopeTask?.value || null },
          candidates: candidates.map((c) => ({
            pm_id: c.pm_id,
            pm_name: c.pm_name,
            active_project_count: c.active_project_count,
            total_value: c.total_value,
            overlap_days: c.overlap_days,
            affinity_weight: c.affinity_weight,
          })),
        }),
      });
      const parsed = extractJSON(text);
      if (parsed.recommended_pm) recommended_pm = String(parsed.recommended_pm);
      if (parsed.reasoning) reasoning = parsed.reasoning;
    } catch (e) {
      reasoning = `Claude recommendation unavailable (${e.message}) — ranked by workload/affinity instead.`;
    }
  }

  const [event] = await sql`
    insert into assignment_events (project_id, recommended_pm, recommendation_reasoning, candidates)
    values (${project.id}, ${recommended_pm}, ${reasoning}, ${JSON.stringify(candidates)}::jsonb)
    returning *`;

  return json({ event, candidates });
}

export async function confirmAssignment({ params, request, env, sql, auth }) {
  const body = await request.json().catch(() => null);
  if (!body?.assigned_pm) return json({ error: "invalid_request", detail: "assigned_pm is required" }, 400);

  const [project] = await sql`select * from projects where id = ${params.id}`;
  if (!project) return json({ error: "not_found" }, 404);

  const [lastEvent] = await sql`
    select * from assignment_events where project_id = ${project.id} order by created_at desc limit 1`;
  const overridden = Boolean(lastEvent) && lastEvent.recommended_pm !== body.assigned_pm;

  const { ok, status, data } = await procoreFetch(env, PROJECT.patchPath(project.procore_project_id, env.PROCORE_COMPANY_ID), {
    method: "PATCH",
    version: PROJECT.version,
    body: PROJECT.buildAssignedPmPatch({ companyId: env.PROCORE_COMPANY_ID, departmentId: body.assigned_pm }),
  });
  if (!ok) {
    return json({ error: "procore_patch_failed", detail: `HTTP ${status}: ${JSON.stringify(data).slice(0, 300)}` }, 502);
  }

  const [event] = await sql`
    insert into assignment_events (project_id, recommended_pm, recommendation_reasoning, candidates, assigned_pm, overridden, decided_by, decided_at)
    values (${project.id}, ${lastEvent?.recommended_pm || null}, ${lastEvent?.recommendation_reasoning || null},
            ${lastEvent ? JSON.stringify(lastEvent.candidates) : null}::jsonb,
            ${body.assigned_pm}, ${overridden}, ${auth.actor.einbau_username}, now())
    returning *`;

  await sql`update projects set status = 'assigned', updated_at = now() where id = ${project.id}`;
  const updatedProject = { ...project, status: "assigned" };

  // Confirming the PM completes the handoff on HANDOFF's side: generate the
  // brief and fire startup tasks right away rather than waiting on a separate
  // click. Both are idempotent, so a retried confirm never double-runs them.
  const [brief, startupResults] = await Promise.all([
    generateBrief(env, sql, updatedProject, body.assigned_pm).catch((e) => ({ error: e.message })),
    runStartupTasks(env, sql, updatedProject).catch((e) => [{ error: e.message }]),
  ]);

  return json({ event, overridden, brief, startup_tasks: startupResults });
}
