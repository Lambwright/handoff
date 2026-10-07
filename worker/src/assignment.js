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
import { syncProjectManager } from "./pm-sync.js";

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
    if (a.group !== b.group && (a.group === "main" || b.group === "main")) return a.group === "main" ? -1 : 1;
    const scoreA = a.affinity_weight * 2 - a.active_project_count - a.overlap_days / 30;
    const scoreB = b.affinity_weight * 2 - b.active_project_count - b.overlap_days / 30;
    return scoreB - scoreA;
  });
}

// ---------------------------------------------------------------------------
// Procore-backed loaders
// ---------------------------------------------------------------------------

// The list endpoint gives everything workload aggregation needs EXCEPT
// `departments` (confirmed by probe 2026-09-05 — not on the list at all, even
// with view=extended). So: list + filter to active first (cheap), then hydrate
// only the active ones with a per-project GET, batched at the subrequest
// ceiling. On a large active portfolio this is a lot of GETs; the 6h cron
// warms pm_workload_cache so an assignment screen rarely pays the full cost
// live. TODO(perf): if this gets slow, check whether Procore's project list
// supports filters[project_stage_id] / filters[department_id] to prune first.
async function loadActiveProjects(env) {
  const all = await procoreFetchAll(env, PROJECT.listPath(), {
    version: PROJECT.version,
    query: { company_id: env.PROCORE_COMPANY_ID },
  });
  const active = all.filter(STAGES.isActiveStage);

  const hydrated = await batched(active, async (p) => {
    const { ok, data } = await procoreFetch(env, PROJECT.getPath(p.id, env.PROCORE_COMPANY_ID), {
      version: PROJECT.version,
    });
    return ok && data ? { ...p, departments: data.departments || [] } : p;
  });
  return hydrated;
}

// Everyone who can open HANDOFF, with their Procore Department (set in HELM).
// `isPm` is the main roster: HANDOFF level 'pm', or — while HANDOFF is not yet
// live for them — a legacy users-table role of 'pm'. Anyone with a department who
// isn't a PM is on the bench: assignable and filterable, but not presented as a
// main option. Department-less PMs are kept so they can be reported.
async function loadAssignablePeople(env, sql, request) {
  const token = (request.headers.get("Authorization") || "").replace(/^Bearer /, "");
  const res = await env.AUTH_WORKER.fetch(`${env.AUTH_WORKER_URL}/auth/app/users`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ app: "HANDOFF" }),
  });
  if (!res.ok) throw new Error(`auth-worker /auth/app/users failed: HTTP ${res.status}`);
  const { users = [] } = await res.json();

  const rows = await sql`select einbau_username, role, active from users`;
  const legacy = new Map(rows.map((r) => [r.einbau_username, r]));

  return users
    .map((u) => {
      const row = legacy.get(String(u.username).toLowerCase());
      const isPm = u.level === "pm" || (u.level === "access" && row?.role === "pm" && row.active);
      const dept = u.department && !u.department.missing ? u.department : null;
      return {
        username: u.username,
        name: u.displayName,
        level: u.level,
        isPm,
        department_id: dept ? String(dept.id) : null,
        department_name: dept ? dept.name : null,
      };
    })
    .filter((p) => p.isPm || p.department_id);
}

// Every person who can be assigned a handoff: anyone with a department.
async function loadAssignableDirectory(env, sql, request) {
  const people = await loadAssignablePeople(env, sql, request);
  return people.filter((p) => p.department_id);
}

async function computeCandidates(env, sql, project, request) {
  const [activeProjects, people, affinityRows] = await Promise.all([
    loadActiveProjects(env),
    loadAssignableDirectory(env, sql, request),
    sql`select * from pm_affinity`,
  ]);
  const pmDirectory = people.map((p) => ({ id: p.department_id, name: p.department_name || p.name }));
  const groupById = new Map(people.map((p) => [p.department_id, p.isPm ? "main" : "bench"]));

  // aggregateWorkload also adds any department seen on an active project, so
  // drop anything not tied to a person (departed staff, Back Log, etc.).
  let candidates = aggregateWorkload(activeProjects, project.timeline, pmDirectory);
  candidates = candidates
    .filter((c) => groupById.has(c.pm_id))
    .map((c) => ({ ...c, group: groupById.get(c.pm_id) }));
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

// GET /pm-roster — PMs who can be assigned (mapped to a Procore Department),
// plus any PM who still has no mapping, so an admin can see the gap. Any
// authenticated HANDOFF user can read it.
export async function getPmRoster({ request, env, sql }) {
  const people = await loadAssignablePeople(env, sql, request);
  const asOption = (p) => ({ id: p.department_id, name: p.department_name || p.name });
  return json({
    roster: people.filter((p) => p.isPm && p.department_id).map(asOption),
    bench: people.filter((p) => !p.isPm && p.department_id).map(asOption),
    unmapped: people.filter((p) => p.isPm && !p.department_id).map((p) => ({ username: p.username, name: p.name })),
  });
}

// Departments that have at least one handoff assigned to them — the only ones
// worth offering as a filter.
export async function getAssignmentDepartments({ env, sql, request }) {
  const [latest, assignable] = await Promise.all([
    sql`select distinct on (project_id) project_id, assigned_pm from assignment_events
        where assigned_pm is not null order by project_id, decided_at desc`,
    loadAssignableDirectory(env, sql, request),
  ]);
  const used = new Set(latest.map((r) => String(r.assigned_pm)));
  const departments = assignable
    .filter((p) => used.has(String(p.department_id)))
    .map((p) => ({ id: p.department_id, name: p.department_name || p.name }));
  return json({ departments });
}

export async function getAssignmentCandidates({ params, env, sql, request }) {
  const [project] = await sql`select * from projects where id = ${params.id}`;
  if (!project) return json({ error: "not_found" }, 404);
  if (!project.procore_project_id) {
    return json({ error: "not_created", detail: "This handoff hasn't been submitted yet." }, 409);
  }
  const candidates = await computeCandidates(env, sql, project, request);
  return json({ project, candidates });
}

export async function postAssignmentRecommendation({ params, env, sql, request }) {
  const [project] = await sql`select * from projects where id = ${params.id}`;
  if (!project) return json({ error: "not_found" }, 404);

  const candidates = await computeCandidates(env, sql, project, request);
  const mainCandidates = candidates.filter((c) => c.group === "main");
  const [scopeTask] = await sql`select value from gate_tasks where project_id = ${project.id} and task_type = 'scope_summary'`;

  let recommended_pm = mainCandidates[0]?.pm_id || null;
  let reasoning = "No PMs on the main roster with workload data — pick manually.";
  if (mainCandidates.length) {
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
          candidates: mainCandidates.map((c) => ({
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

  const assignable = await loadAssignableDirectory(env, sql, request);
  const pm = assignable.find((p) => String(p.department_id) === String(body.assigned_pm));
  if (!pm) {
    return json({ error: "invalid_request", detail: "That department isn't tied to anyone who can be assigned." }, 400);
  }

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

  // The Department field above is HANDOFF's own PM-assignment mechanism. This is
  // a bonus on top of it, not a replacement: syncs the same PM onto Resource
  // Planning's role and Procore's native Project Team role, same two systems
  // punch-worker already keeps in sync for its own checklist writeback, so a
  // HANDOFF-created project is sortable/searchable by PM the same way. Best-effort
  // — never blocks the confirm itself, which already succeeded above.
  const pmSync = await syncProjectManager(env, {
    procoreProjectId: project.procore_project_id,
    projectNumber: project.project_number,
    companyId: env.PROCORE_COMPANY_ID,
    pmName: pm.department_name || pm.name,
  }).catch((e) => ({ error: e.message }));

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

  return json({ event, overridden, brief, startup_tasks: startupResults, pm_sync: pmSync });
}
