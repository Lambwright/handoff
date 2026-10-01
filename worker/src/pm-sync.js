// Syncs a confirmed PM onto the two Procore systems HANDOFF's own Department
// write doesn't touch: Resource Planning's own role, and the native Project
// Team/Directory "Project Manager" role — so the project is sortable/
// searchable by PM the way punch-worker's projects already are. Ported from
// punch-worker's syncProjectManagerForDepartment/fetchRpPersonByName/
// fetchProcoreUserIdByName/setRpProjectManager/setProcoreProjectManagerRole —
// proven live there, not a guess here.
//
// Explicitly NOT a Resource Planning staffing/timeline "request" — that's a
// separate, genuinely different RP feature neither punch-worker nor HANDOFF
// has ever touched (Ben, 2026-10-01). This is purely "attach the PM as a
// person" on both systems.
//
// Best-effort on every leg, same as punch-worker: a failure or no-match on one
// system never blocks another, and this never throws back into the caller —
// confirmAssignment's own Department PATCH is the one write that must
// succeed; this sync is a bonus, not a gate.

import { procoreFetch } from "./procore.js";
import { RESOURCE_PLANNING, PROJECT_ROLES, PROCORE_CUSTOM_FIELDS } from "./procore-shapes.js";

function nameTokens(s) {
  return (s || "").toUpperCase().split(/[^A-Z]+/).filter(Boolean);
}
function nameMatchesTokens(candidateName, targetTokens) {
  const candidateToks = new Set(nameTokens(candidateName));
  return targetTokens.length > 0 && targetTokens.every((t) => candidateToks.has(t));
}

// Deliberately unpaginated — confirmed live in punch-worker (twice) that the bare
// call returns the complete company list, while adding page/per_page returned a
// smaller result MISSING real users. Don't re-add pagination without re-confirming.
async function fetchProcoreUserIdByName(env, companyId, fullName) {
  const targetToks = nameTokens(fullName);
  const { ok, status, data } = await procoreFetch(env, `/companies/${companyId}/users`, { version: "v1.0" });
  if (!ok) throw new Error(`Procore company users request failed: ${status}`);
  const users = Array.isArray(data) ? data : [];
  const match = users.find((u) => nameMatchesTokens(u.name || `${u.first_name || ""} ${u.last_name || ""}`, targetToks));
  return match ? match.id : null;
}

// RP's own "people" roster has no shared id with Procore Directory users — name-
// token matching is the only link, same caveats as punch-worker (real records have
// real mess, e.g. a trailing space in a first_name; RP's own query filters are
// confirmed exact-match and unreliable, so fetch-all + match client-side instead).
async function fetchRpPersonByName(env, companyId, fullName) {
  const targetToks = nameTokens(fullName);
  const { ok, status, data } = await procoreFetch(env, RESOURCE_PLANNING.peoplePath(companyId), { version: RESOURCE_PLANNING.version });
  if (!ok) throw new Error(`Resource Planning people request failed: ${status}`);
  const pool = Array.isArray(data) ? data : [];
  const nameOf = (p) => (p.name ? `${p.name.first || ""} ${p.name.last || ""}` : `${p.first_name || ""} ${p.last_name || ""}`);
  const einbauMatch = pool.find((p) => p.company_name === "Einbau" && nameMatchesTokens(nameOf(p), targetToks));
  return einbauMatch || pool.find((p) => nameMatchesTokens(nameOf(p), targetToks)) || null;
}

async function fetchRpProjectByNumber(env, companyId, projectNumber) {
  const { ok, status, data } = await procoreFetch(env, RESOURCE_PLANNING.projectByNumberPath(companyId, projectNumber), {
    version: RESOURCE_PLANNING.version,
  });
  if (!ok) throw new Error(`Resource Planning project lookup failed: ${status}`);
  const list = Array.isArray(data) ? data : [];
  return list[0] || null;
}

// No "update role" endpoint on RP — only add/remove (confirmed: changing a
// project's PM in the live app replaces the role's own id entirely, not just its
// person_id). A real change is delete-old-role, add-new-role; already-correct is
// a no-op.
async function setRpProjectManager(env, companyId, rpProject, newPersonId) {
  const existing = (rpProject.roles || []).find((r) => r.job_title_id === RESOURCE_PLANNING.projectManagerJobTitleId);
  if (existing && existing.person_id === newPersonId) return { changed: false };
  if (existing) {
    if (!existing.id) throw new Error(`Resource Planning role for project ${rpProject.id} has no id in the live response — can't remove it safely`);
    await procoreFetch(env, RESOURCE_PLANNING.roleByIdPath(companyId, rpProject.id, existing.id), {
      method: "DELETE",
      version: RESOURCE_PLANNING.version,
    });
  }
  const { ok, status } = await procoreFetch(env, RESOURCE_PLANNING.rolesPath(companyId, rpProject.id), {
    method: "POST",
    version: RESOURCE_PLANNING.version,
    body: { person_id: newPersonId, job_title_id: RESOURCE_PLANNING.projectManagerJobTitleId },
  });
  if (!ok) throw new Error(`Resource Planning role POST failed: ${status}`);
  return { changed: true, previousPersonId: existing?.person_id || null };
}

// Same no-update, add/delete-only shape as RP. `role` is a plain company-
// configured name STRING, not an id.
async function setProcoreProjectManagerRole(env, procoreProjectId, procoreUserId) {
  const { ok, status, data } = await procoreFetch(env, PROJECT_ROLES.listPath(procoreProjectId), { version: PROJECT_ROLES.version });
  if (!ok) throw new Error(`Procore project_roles GET failed: ${status}`);
  const roles = Array.isArray(data) ? data : [];
  const existing = roles.find((r) => r.role === "Project Manager" && r.is_active !== false);
  if (existing && existing.user_id === procoreUserId) return { changed: false };
  if (existing) {
    const del = await procoreFetch(env, PROJECT_ROLES.deletePath(existing.id, procoreProjectId), {
      method: "DELETE",
      version: PROJECT_ROLES.version,
    });
    if (!del.ok && del.status !== 204) throw new Error(`Procore project_roles DELETE failed: ${del.status}`);
  }
  const post = await procoreFetch(env, PROJECT_ROLES.createPath(), {
    method: "POST",
    version: PROJECT_ROLES.version,
    body: { project_id: Number(procoreProjectId), project_role: { role: "Project Manager", user_id: procoreUserId } },
  });
  if (!post.ok) throw new Error(`Procore project_roles POST failed: ${post.status}`);
  return { changed: true, previousUserId: existing?.user_id || null };
}

// The one entry point confirmAssignment calls. Three independent, best-effort
// legs: Resource Planning's role, Procore's front-page PM custom field (People-
// type — {id, user_ids} shape, not a bare scalar), and the native Project Team
// role. Each leg's result/skip/error is reported separately rather than
// collapsed, so a partial sync is visible instead of silently "worked."
export async function syncProjectManager(env, { procoreProjectId, projectNumber, companyId, pmName }) {
  const result = { pm: pmName };

  if (!projectNumber) {
    result.rp = { skipped: true, reason: "no project number to resolve the Resource Planning project by" };
  } else {
    try {
      const [rpProject, rpPerson] = await Promise.all([
        fetchRpProjectByNumber(env, companyId, projectNumber),
        fetchRpPersonByName(env, companyId, pmName),
      ]);
      if (!rpProject) result.rp = { skipped: true, reason: `no Resource Planning project matched project number ${projectNumber}` };
      else if (!rpPerson) result.rp = { skipped: true, reason: `no Resource Planning person matched "${pmName}"` };
      else result.rp = await setRpProjectManager(env, companyId, rpProject, rpPerson.id);
    } catch (e) {
      result.rp = { error: e.message };
    }
  }

  let procoreUserId = null;
  try {
    procoreUserId = await fetchProcoreUserIdByName(env, companyId, pmName);
  } catch (e) {
    result.procore = { error: e.message };
  }

  if (procoreUserId === null && !result.procore) {
    result.procore = { skipped: true, reason: `no Procore company user matched "${pmName}"` };
  } else if (procoreUserId !== null) {
    const { ok, status, data } = await procoreFetch(env, `/projects/${procoreProjectId}`, {
      method: "PATCH",
      version: "v1.0",
      query: { company_id: companyId },
      body: { company_id: companyId, project: { [`custom_field_${PROCORE_CUSTOM_FIELDS.pm}`]: { id: PROCORE_CUSTOM_FIELDS.pm, user_ids: [procoreUserId] } } },
    });
    result.procore = ok ? { changed: true, userId: procoreUserId } : { error: `Procore PATCH failed: ${status} ${JSON.stringify(data).slice(0, 200)}` };

    try {
      result.team = await setProcoreProjectManagerRole(env, procoreProjectId, procoreUserId);
    } catch (e) {
      result.team = { error: e.message };
    }
  }

  return result;
}
