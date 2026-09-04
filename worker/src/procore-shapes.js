// ===========================================================================
// procore-shapes.js — every Procore fact HANDOFF depends on that is NOT yet
// confirmed against the sandbox lives here, behind a TODO(sandbox) marker, so
// confirming each one is a single-file change. Nothing else in the worker should
// hardcode a Procore path, payload wrapper, or field name.
//
// Sources for the current best guesses: punch-worker (proven live for stages,
// projects PATCH, documents, forms, email_communications, vendors), tally-worker
// (Direct Cost wrappers), and the HANDOFF kickoff doc.
// ===========================================================================

// ---------------------------------------------------------------------------
// Bid Board
// ---------------------------------------------------------------------------
export const BID_BOARD = {
  // TODO(sandbox): confirm the exact endpoint + version for the Bid Board list.
  // Kickoff doc: procore-worker has a proven `/estimating/bid_board_projects`
  // (v2.0) namespace that SCOUT populates. v2.0 paths through our own client are
  // `/rest/v2.0/companies/{company_id}/...`.
  listPath: (companyId) => `/companies/${companyId}/estimating/bid_board_projects`,
  version: "v2.0",

  // TODO(sandbox): confirm which field/value marks a bid as being in the
  // "Awarded" column. Could be `bid_status`, `status`, a `stage`/`column`
  // object, or a boolean. Adjust this predicate only.
  isAwarded(bid) {
    const s = (bid.bid_status || bid.status || bid.stage?.name || bid.column?.name || "")
      .toString()
      .toLowerCase();
    return s.includes("award");
  },

  // Map a raw bid record to the fields HANDOFF houses. Every read here is a
  // structured field copy — NO document parsing (Ben: address/customer are just
  // fields, keep parsing to a minimum).
  // TODO(sandbox): confirm the real field names on the bid record.
  toDraft(bid) {
    return {
      name: bid.name || bid.project_name || bid.title || null,
      project_number: bid.project_number || bid.number || null,
      project_type: bid.project_type?.name || bid.type || null, // normalized later by checklist.js
      customer_name:
        bid.client?.name || bid.customer?.name || bid.owner?.name || bid.company?.name || null,
      address: {
        street: bid.address || bid.street_address || bid.location?.address || null,
        city: bid.city || bid.location?.city || null,
        state_code: bid.state_code || bid.location?.state_code || bid.province || null,
        postal_code: bid.zip || bid.postal_code || bid.location?.postal_code || null,
        country_code: bid.country_code || bid.location?.country_code || "CA",
      },
      timeline: {
        start_date: bid.start_date || bid.estimated_start_date || null,
        end_date: bid.completion_date || bid.estimated_completion_date || bid.end_date || null,
      },
    };
  },
};

// ---------------------------------------------------------------------------
// Project stages
// ---------------------------------------------------------------------------
export const STAGES = {
  // GET companies/{co}/project_stages — proven live in punch-worker.
  listPath: (companyId) => `/companies/${companyId}/project_stages`,
  version: "v1.0",

  // TODO(sandbox): Ben to provide the exact active-stage name list, and which
  // one a brand-new handed-off project should be created into. There is NO
  // holding/"Pending Setup" stage in this model.
  TARGET_CREATE_STAGE: "Course of Construction",
  ACTIVE_STAGES: ["Course of Construction", "Bidding", "Pre-Construction"],

  idByName(stages, name) {
    const hit = (stages || []).find((s) => (s.name || "").toLowerCase() === (name || "").toLowerCase());
    return hit ? hit.id : null;
  },
};

// ---------------------------------------------------------------------------
// Project create + admin-field writes
// ---------------------------------------------------------------------------
export const PROJECT = {
  // TODO(sandbox): confirm POST /rest/v1.0/projects creates a Portfolio project
  // and which fields it accepts on create vs. only on a follow-up PATCH.
  // punch-worker PATCHes with body { company_id, project: {...} } against
  // /rest/v1.0/projects/{id}?company_id=... — assuming create takes the same
  // wrapper.
  createPath: () => `/projects`,
  patchPath: (projectId, companyId) => `/projects/${projectId}?company_id=${companyId}`,
  version: "v1.0",

  buildCreatePayload({ companyId, name, projectNumber, projectType, stageId, timeline }) {
    const project = {
      name,
      project_number: projectNumber || undefined,
      active: true,
    };
    if (stageId) project.project_stage_id = stageId; // TODO(sandbox): field name
    if (projectType) project.type = projectType; // TODO(sandbox): likely project_type_id
    if (timeline?.start_date) project.start_date = timeline.start_date;
    if (timeline?.end_date) project.completion_date = timeline.end_date; // TODO(sandbox)
    return { company_id: companyId, project };
  },

  // TODO(sandbox): confirm the address field names on the project resource.
  buildAddressPatch({ companyId, address }) {
    return {
      company_id: companyId,
      project: {
        address: address.street || undefined,
        city: address.city || undefined,
        state_code: address.state_code || undefined,
        zip: address.postal_code || undefined,
        country_code: address.country_code || undefined,
      },
    };
  },

  // TODO(sandbox): confirm the date field names — used both at create time and
  // when a deferred timeline gap gets resolved after the project already exists.
  buildTimelinePatch({ companyId, timeline }) {
    return {
      company_id: companyId,
      project: {
        start_date: timeline.start_date || undefined,
        completion_date: timeline.end_date || undefined,
      },
    };
  },

  // TODO(sandbox): confirm whether PO number is a first-class project field or a
  // custom field on a fieldset (kickoff doc suggests it may be makeable
  // hard-required via Company Admin regardless).
  buildPoNumberPatch({ companyId, poNumber }) {
    return { company_id: companyId, project: { po_number: poNumber } };
  },

  // TODO(sandbox): confirm the assigned-PM field. Could be
  // `project_manager_id`, a `project_manager` object, or a role assignment via a
  // separate endpoint.
  buildAssignedPmPatch({ companyId, pmId }) {
    return { company_id: companyId, project: { project_manager_id: pmId } };
  },

  // Full project list for workload aggregation. TODO(sandbox): confirm field
  // names for the assigned PM, contract value, and project dates on the list
  // response — these three extractors are the only things that need to change.
  listPath: () => `/projects`,
  extractPm(project) {
    return project.project_manager?.id ? String(project.project_manager.id) : null;
  },
  extractPmName(project) {
    return project.project_manager?.name || null;
  },
  extractValue(project) {
    return Number(project.total_value ?? project.original_contract_value ?? 0) || 0;
  },
  extractTimeline(project) {
    return { start_date: project.start_date || null, end_date: project.completion_date || project.end_date || null };
  },
  extractStage(project) {
    return project.project_stage?.name || project.stage || null;
  },
};

// ---------------------------------------------------------------------------
// Company / Project Directory (the "Customer" gate task)
// ---------------------------------------------------------------------------
export const DIRECTORY = {
  // /vendors holds EVERY company in the Directory (customers, subs, Einbau
  // itself) — there is no separate customers endpoint. Proven in punch-worker.
  listVendorsPath: (companyId) => `/vendors?company_id=${companyId}`,
  version: "v1.0",

  // TODO(sandbox): confirm that creating a company at the PROJECT Directory
  // level cascades to the Company Directory in one write (kickoff Question #6;
  // INTAKE observed this empirically). Endpoint + wrapper to confirm.
  createProjectDirectoryCompanyPath: (projectId) => `/projects/${projectId}/vendors`,

  buildDirectoryCompany(customer) {
    return {
      vendor: {
        name: customer.name,
        company: customer.name,
        is_active: true,
        ...(customer.address
          ? {
              address: customer.address.street,
              city: customer.address.city,
              state_code: customer.address.state_code,
              zip: customer.address.postal_code,
              country_code: customer.address.country_code,
            }
          : {}),
      },
    };
  },

  // TODO(sandbox): confirm the "Customer" field on the project is a Directory
  // reference (kickoff doc: Procore custom-fields has a "Company" type that
  // references the Project Directory). Set it as part of the same coordinated
  // write, not via a free-text field.
  buildCustomerPatch({ companyId, directoryId }) {
    return { company_id: companyId, project: { customer_id: directoryId } };
  },
};

// ---------------------------------------------------------------------------
// Documents (PO document upload)
// ---------------------------------------------------------------------------
export const DOCUMENTS = {
  // punch-worker reads the project's top-level Documents folders here.
  listPath: (projectId) => `/projects/${projectId}/documents`,
  version: "v1.0",
  // TODO(sandbox): confirm the multipart upload endpoint + which folder PO docs
  // belong in. punch-worker's PO-on-file checklist item looks in a folder named
  // "03 Quotes-P.O".
  PO_FOLDER_NAME: "03 Quotes-P.O",
  uploadPath: (projectId) => `/projects/${projectId}/files`,
};

// ---------------------------------------------------------------------------
// Email / Correspondence (tender correspondence push + verify)
// ---------------------------------------------------------------------------
export const EMAIL_TOOL = {
  // Proven live in punch-worker (note the SINGULAR "project" in the path, and
  // the required topic_type/topic_id pair).
  listPath: (projectId) =>
    `/project/${projectId}/email_communications/emails?topic_type=project&topic_id=${projectId}`,
  version: "v1.0",
  // TODO(sandbox): confirm the create endpoint for pushing a stored email /
  // correspondence item onto the project.
  createPath: (projectId) => `/project/${projectId}/email_communications/emails`,

  countFromList(data) {
    return Array.isArray(data?.emails) ? data.emails.length : 0;
  },
};

// ---------------------------------------------------------------------------
// Project-level Estimating tool (cost / labour hours / margin for the brief)
// ---------------------------------------------------------------------------
export const ESTIMATING = {
  // TODO(sandbox): confirm the REST surface for the project-level Estimating
  // tool's Summary view. Kickoff doc: try a sibling of the proven
  // `/estimating/bid_board_projects` namespace. This data never has to leave
  // Procore (sidesteps the SCOUT->NetSuite write-leg risk).
  summaryPath: (projectId) => `/projects/${projectId}/estimating/summary`,
  version: "v2.0",

  parseSummary(data) {
    // Shape from Ben's live screenshot: cost-item-type rows (Labor, Materials),
    // total labour hours, difficulty factor, waste %, total cost, margin %,
    // total sales, Estimate Total.
    return {
      total_cost: data?.total_cost ?? data?.summary?.total_cost ?? null,
      total_labor_hours: data?.total_labor_hours ?? data?.summary?.total_labor_hours ?? null,
      margin_percent: data?.margin_percent ?? data?.summary?.margin_percent ?? null,
      total_sales: data?.total_sales ?? data?.summary?.total_sales ?? null,
      estimate_total: data?.estimate_total ?? data?.summary?.estimate_total ?? null,
      rows: data?.rows ?? data?.line_item_types ?? [],
    };
  },
};

// ---------------------------------------------------------------------------
// Resource Planning (first startup task)
// ---------------------------------------------------------------------------
export const RESOURCE_PLANNING = {
  // TODO(sandbox): confirm the Resource Planning "request" endpoint + payload.
  createRequestPath: () => `/resource_planning/requests`,
  version: "v1.0",

  buildRequest({ companyId, procoreProjectId, timeline, note }) {
    return {
      company_id: companyId,
      request: {
        project_id: procoreProjectId,
        start_date: timeline?.start_date || undefined,
        end_date: timeline?.end_date || undefined,
        notes: note || undefined,
      },
    };
  },
};

// ---------------------------------------------------------------------------
// Company users (PM candidate list)
// ---------------------------------------------------------------------------
export const USERS = {
  // TODO(sandbox): confirm how PM candidates are identified — a permission
  // template, a job title, or an explicit configured list (kickoff open item).
  listPath: (companyId) => `/companies/${companyId}/users`,
  version: "v1.3",
  isProjectManager(user) {
    const title = (user.job_title || user.title || "").toLowerCase();
    return title.includes("project manager") || title.includes("pm");
  },
};

// ---------------------------------------------------------------------------
// Linked source-estimate rename (SCOUT "Link Records" pattern)
// ---------------------------------------------------------------------------
export const ESTIMATE_RENAME = {
  // TODO(sandbox): once a PO number is captured, rename the source estimate
  // record(s). SCOUT keeps the NetSuite Opportunity and the Procore Bid Board
  // entry linked (PATCHes the Procore Bid ID back to NetSuite once both exist) —
  // this rename must update BOTH, not just one, or it reintroduces the drift
  // SCOUT's linking was built to prevent. NetSuite leg goes through
  // netsuite-worker; verify it has a working service-key path first.
  bidBoardPatchPath: (companyId, bidId) =>
    `/companies/${companyId}/estimating/bid_board_projects/${bidId}`,
  version: "v2.0",
  buildRenamedTitle(originalName, poNumber) {
    return `${originalName} — PO ${poNumber}`;
  },
};
