// ===========================================================================
// procore-shapes.js — every Procore fact HANDOFF depends on lives here, so
// confirming or correcting one is a single-file change. Nothing else in the
// worker should hardcode a Procore path, payload wrapper, or field name.
//
// Two tiers of confidence, marked inline:
//   - CONFIRMED: proven live elsewhere in the suite (punch-worker's
//     buildProcoreWriteback / buildProcoreChecklist are the primary source —
//     that code was verified against real writes on this exact Procore
//     account) or confirmed directly by Ben.
//   - TODO(sandbox) / TODO(ben): still a guess; needs one real check before
//     the dependent feature is trusted.
// ===========================================================================

// ---------------------------------------------------------------------------
// Bid Board
// ---------------------------------------------------------------------------
export const BID_BOARD = {
  // CONFIRMED by full probe sweep 2026-09-05 (4,255 bid records).
  //
  // The endpoint supports ONLY page + per_page — no server-side status /
  // archived / sort filter (all silently ignored). So the "Awarded, not yet
  // handed off" set is found by paging the whole board and filtering here.
  // That's too slow for an interactive request, so bids.js caches the result
  // in `bid_cache` (refreshed by the 6h cron + on demand) and GET /bids reads
  // the cache. See scanAwardedBids() in bids.js.
  //
  // Response envelope: { "data": [ ...records... ] } — NOT a bare array.
  // Records carry: id (string), name, description, status, archived,
  // project_id (null until converted to a Portfolio project), project_number,
  // customer_company {id, name}, address {street, city, state, zip, country}
  // (frequently all null), stats.total, due_date (the BID due date — NOT a
  // project timeline), estimator_user_id. No project_type, no start/end dates,
  // no board-column field.
  listPath: (companyId) => `/companies/${companyId}/estimating/bid_board_projects`,
  version: "v2.0",

  // The board's "Awarded" column = status COMPLETE and not archived (matches
  // the column's count of 230 exactly). The board's other columns map to
  // status too: Lost->LOST, Estimating Queue->ESTIMATING, Submitted->
  // BID_SUBMITTED, Watch List->DELAYED, Active 30-60->ACCEPTED, Active 60-90+
  // ->IN_PROGRESS, Archived->archived:true.
  isAwarded(bid) {
    return bid.status === "COMPLETE" && bid.archived === false;
  },

  // What GET /bids actually offers: Awarded AND not already turned into a
  // Portfolio project (project_id null). ~20 of the 230 Awarded bids.
  isReadyToHandOff(bid) {
    return BID_BOARD.isAwarded(bid) && !bid.project_id;
  },

  // Structured field copy — NO document parsing (Ben). `project_type` and a
  // real start/end timeline are NOT on the bid record, so they're left null
  // for the estimator to set in the gate (checklist.js defaults type to
  // Contract; `due_date` is deliberately not mapped — it's the bid deadline,
  // not the project schedule).
  toDraft(bid) {
    return {
      name: bid.name || null,
      project_number: bid.project_number || null,
      project_type: null,
      customer_name: bid.customer_company?.name || null,
      customer_company_id: bid.customer_company?.id ? String(bid.customer_company.id) : null,
      address: {
        street: bid.address?.street || null,
        city: bid.address?.city || null,
        state_code: bid.address?.state || null, // bid uses `state`, project uses `state_code`
        postal_code: bid.address?.zip || null,
        country_code: bid.address?.country || "CA",
      },
      estimate_total: bid.stats?.total ?? null,
      estimator_user_id: bid.estimator_user_id ? String(bid.estimator_user_id) : null,
      timeline: { start_date: null, end_date: null },
    };
  },
};

// ---------------------------------------------------------------------------
// Project stages
//
// CONFIRMED (Ben, 2026-09-04): the delineation between Active and Inactive
// stages lives in the same place punch-worker's Budget Importer / Stage
// Enforcer already use it — an INACTIVE deny-list, not an allow-list, checked
// alongside Procore's own native `project.active` boolean. Three independent
// call sites across PUNCH and TALLY agree on this set:
//   - punch-worker's Portfolio sync excludes "Cancelled" outright
//   - punch-worker's Budget Importer excludes "Cancelled", "Completed and
//     Invoiced", "Overhead"
//   - punch-worker's Stage Enforcer / TALLY's INACTIVE_STAGES both treat
//     "On Hold" and "Completed and Invoiced" as needing a nudge back to
//     attention
// Unioned, that's the INACTIVE_STAGES set below. Follow the same deny-list
// pattern here rather than trying to guess a positive "active stages" list.
// ---------------------------------------------------------------------------
export const STAGES = {
  // GET companies/{co}/project_stages — CONFIRMED by probe 2026-09-05. The
  // account's full stage list (id / name):
  //   3                "Course of Construction"   (default_stage)
  //   562949953421313  "Bidding"                  (is_bidding_stage)
  //   562949953421314  "Pre-Construction"
  //   562949953421315  "Warranty"
  //   562949953421316  "Post-Construction"
  //   562949953443621  "Construction - T&M"
  //   562949953443622  "Overhead"
  //   562949953483254  "Service Call"
  //   5629499535107xx  "Course of Construction >25% / <25% / 50% / 75%"
  //   562949953510803  "Significant Completion"
  //   562949953510804  "Completed"
  //   562949953510805  "Completed and Invoiced"
  //   562949953510806  "Cancelled"
  //   562949953514618  "Back Log"
  //   562949953524467  "On Hold"
  //   562949953524533  "Billing Review Required"
  listPath: (companyId) => `/companies/${companyId}/project_stages`,
  version: "v1.0",

  INACTIVE_STAGES: new Set(["Cancelled", "Completed and Invoiced", "On Hold", "Overhead"]),

  // CONFIRMED: "Course of Construction" (id 3, default_stage) is the account's
  // main active construction stage — a new handed-off project lands here.
  // There is NO holding/"Pending Setup" stage in this model.
  TARGET_CREATE_STAGE: "Course of Construction",

  idByName(stages, name) {
    const hit = (stages || []).find((s) => (s.name || "").toLowerCase() === (name || "").toLowerCase());
    return hit ? hit.id : null;
  },

  // A project counts toward PM workload / is eligible to be handed off into
  // only if Procore's own `active` flag is true AND its stage isn't one of the
  // terminal/paused ones above.
  isActiveStage(project) {
    return project.active === true && !STAGES.INACTIVE_STAGES.has(PROJECT.extractStage(project));
  },
};

// ---------------------------------------------------------------------------
// Custom field IDs — CONFIRMED twice over: punch-worker's PROCORE_CUSTOM_FIELDS
// (verified against real writes) AND a HANDOFF probe 2026-09-05 that read them
// straight off a live project:
//   custom_field_73165           -> {data_type:"vendor", value:{id, label}}   (Customer)
//   custom_field_562949953929326 -> {data_type:"string", value:"tbd"}         (PO Number)
//   custom_field_562949953942386 -> {data_type:"lov_entry", value:{id,label}} (Currency, unused here)
// Reads come back nested under `project.custom_fields.custom_field_<id>.value`;
// WRITES go as flat project properties (`project.custom_field_<id> = <id|string>`),
// never nested — confirmed against a real Power Automate flow that hit this
// exact trap on 2026-04-24.
// ---------------------------------------------------------------------------
export const PROCORE_CUSTOM_FIELDS = {
  customer: 73165,
  poNumber: 562949953929326,
};

// ---------------------------------------------------------------------------
// Department — CONFIRMED (Ben, 2026-09-04): Einbau uses the project's
// Department field on the admin page to indicate who is responsible for it.
// This is what HANDOFF's PM assignment actually reads/writes — there is no
// separate "Project Manager" field on the Procore project resource. There is
// no public Procore endpoint for this dropdown's options (confirmed in
// punch-worker), so the list is hardcoded, same as punch-worker does it.
//
// CAUTION (Ben): this list mixes real current PMs, people who no longer work
// at Einbau, and non-person buckets ("Project Management", "Back Log", etc).
// It is NOT a valid PM-candidate list on its own — HANDOFF's assignment engine
// uses its own `users` table (role='pm', active=true, procore_department_id
// set) as the curated candidate roster, and only uses this list to resolve a
// department id to a display name and to populate the admin mapping UI.
// ---------------------------------------------------------------------------
export const PROCORE_DEPARTMENTS = [
  { id: 562949953453259, name: "Warren Wagler" },
  { id: 562949953487335, name: "Walter Corsetti" },
  { id: 562949953507599, name: "Sunita Jackson" },
  { id: 562949953498534, name: "Scot Carter-Nichols" },
  { id: 562949953453256, name: "Rudi Dyck" },
  { id: 562949953454803, name: "Project Management" },
  { id: 562949953454805, name: "Project Logistics" },
  { id: 562949953454802, name: "Project Estimation" },
  { id: 562949953453255, name: "Peter Dyck" },
  { id: 562949953454804, name: "Mel Gabriel" },
  { id: 562949953492649, name: "Luigi Perna" },
  { id: 562949953463907, name: "Kevin Smith" },
  { id: 562949953453258, name: "Hal Rowan" },
  { id: 562949953489165, name: "Elliot Natovitch" },
  { id: 562949953482755, name: "Dwayne Rogers" },
  { id: 562949953473800, name: "Devid Manzke" },
  { id: 562949953489369, name: "Dave LeBlanc" },
  { id: 562949953454806, name: "Danny Pagniello" },
  { id: 562949953495200, name: "Chris Hong" },
  { id: 562949953453257, name: "Ben Wright" },
  { id: 562949953453261, name: "Back Log" },
  { id: 562949953453265, name: "Alfonso Lopez" },
  { id: 562949953497563, name: "Alex Reid" },
];

// ---------------------------------------------------------------------------
// Project regions (Einbau branches) + timezones — for the gate's Region /
// Timezone tasks. Regions are live (confirmed by probe 2026-09-05:
// /companies/{co}/project_regions -> [{id, name:"Einbau GTA"}, ...]).
// Timezones have no useful endpoint — Rails' list, stored by name, same as
// punch-worker hardcodes.
// ---------------------------------------------------------------------------
export const REGIONS = {
  listPath: (companyId) => `/companies/${companyId}/project_regions`,
  version: "v1.0",
};

export const TIMEZONES = [
  "Pacific Time (US & Canada)",
  "Mountain Time (US & Canada)",
  "Saskatchewan",
  "Central Time (US & Canada)",
  "Eastern Time (US & Canada)",
  "Atlantic Time (Canada)",
  "Newfoundland",
];

// Rough state/province -> timezone default so the gate pre-fills it.
export const PROVINCE_TIMEZONE = {
  BC: "Pacific Time (US & Canada)",
  YT: "Pacific Time (US & Canada)",
  AB: "Mountain Time (US & Canada)",
  NT: "Mountain Time (US & Canada)",
  SK: "Saskatchewan",
  MB: "Central Time (US & Canada)",
  NU: "Central Time (US & Canada)",
  ON: "Eastern Time (US & Canada)",
  QC: "Eastern Time (US & Canada)",
  NB: "Atlantic Time (Canada)",
  NS: "Atlantic Time (Canada)",
  PE: "Atlantic Time (Canada)",
  NL: "Newfoundland",
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
  // Single-project GET — returns `departments`, `project_type`, full
  // `custom_fields`, etc. that the LIST endpoint omits (confirmed by probe
  // 2026-09-05; `?view=extended` on the list does NOT add them).
  getPath: (projectId, companyId) => `/projects/${projectId}?company_id=${companyId}`,
  version: "v1.0",

  // TODO(sandbox): no real create has been run yet. Field names below are the
  // PATCH-confirmed ones (project_stage_id / start_date / completion_date) plus
  // guesses for type. Confirm with one sandbox create before trusting.
  buildCreatePayload({ companyId, name, projectNumber, projectType, stageId, timeline }) {
    const project = {
      name,
      project_number: projectNumber || undefined,
      active: true,
    };
    if (stageId) project.project_stage_id = stageId; // CONFIRMED field name (writeback)
    if (projectType) project.type = projectType; // TODO(sandbox): likely project_type_id
    if (timeline?.start_date) project.start_date = timeline.start_date; // CONFIRMED
    if (timeline?.end_date) project.completion_date = timeline.end_date; // CONFIRMED
    return { company_id: companyId, project };
  },

  // CONFIRMED live (punch-worker's buildProcoreWriteback "address" case).
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

  // CONFIRMED live (punch-worker's buildProcoreWriteback "dates" case).
  buildTimelinePatch({ companyId, timeline }) {
    return {
      company_id: companyId,
      project: {
        start_date: timeline.start_date || undefined,
        completion_date: timeline.end_date || undefined,
      },
    };
  },

  // CONFIRMED: PO number is a custom field on this account (poNumber:text),
  // not a first-class project field — same wrapper punch-worker's writeback
  // uses. (Kickoff doc's "make it hard-required via Company Admin" bonus still
  // applies independently of this.)
  buildPoNumberPatch({ companyId, poNumber }) {
    return { company_id: companyId, project: { [`custom_field_${PROCORE_CUSTOM_FIELDS.poNumber}`]: poNumber } };
  },

  // CONFIRMED live (punch-worker buildProcoreWriteback "region" / "timezone").
  buildRegionPatch({ companyId, regionId }) {
    return { company_id: companyId, project: { project_region_id: Number(regionId) } };
  },
  buildTimezonePatch({ companyId, timezone }) {
    return { company_id: companyId, project: { time_zone: timezone } };
  },

  // CONFIRMED (Ben, 2026-09-04): assignment is written via the project's
  // Department field, `department_ids: [id]` — see PROCORE_DEPARTMENTS above.
  // `departmentId` here is one of that list's numeric ids (resolved from the
  // curated HANDOFF `users` row for the chosen PM, not typed free-form).
  buildAssignedPmPatch({ companyId, departmentId }) {
    return { company_id: companyId, project: { department_ids: [Number(departmentId)] } };
  },

  // Full project list for workload aggregation. NOTE (probe 2026-09-05): the
  // list response carries id / active / project_stage / start_date /
  // completion_date / total_value / custom_fields — but NOT `departments`.
  // assignment.js must hydrate `departments` per project via getPath() (the
  // single GET) before extractPm() returns anything.
  listPath: () => `/projects`,

  // CONFIRMED shape (probe 2026-09-05): `project.departments` is an ARRAY of
  // {id, name} — e.g. [{"id":562949953498534,"name":"Scot Carter-Nichols"}] —
  // matching PROCORE_DEPARTMENTS exactly. Only present on the single GET.
  // Einbau's admin-page UI is single-select in practice, so the first entry is
  // treated as *the* responsible department/PM. extractPm returns the id as a
  // string to line up with pm_affinity / pm_workload_cache / users without a
  // repeated Number()/String() dance.
  extractPm(project) {
    const first = (project.departments || [])[0];
    return first ? String(first.id) : null;
  },
  extractPmName(project) {
    return (project.departments || [])[0]?.name || null;
  },
  // CONFIRMED (probe 2026-09-05): `total_value` is a top-level field, a STRING
  // ("3840.0"). Number() handles it.
  extractValue(project) {
    return Number(project.total_value ?? project.original_contract_value ?? 0) || 0;
  },
  // CONFIRMED (punch-worker's buildProcoreChecklist "dates" case).
  extractTimeline(project) {
    return { start_date: project.start_date || null, end_date: project.completion_date || project.end_date || null };
  },
  // CONFIRMED (probe 2026-09-05): both `project_stage: {id, name}` and a flat
  // `stage` string come back on the list AND the single GET.
  extractStage(project) {
    return project.project_stage?.name || project.stage || null;
  },
  // The project's Emails-tool inbound address — estimators forward tender
  // correspondence here. Seen on the single-project GET as `inbound_email` /
  // `inbound_email_address`.
  extractInboundEmail(project) {
    return project?.inbound_email_address || project?.inbound_email || null;
  },
};

// ---------------------------------------------------------------------------
// Company / Project Directory (the "Customer" gate task)
// ---------------------------------------------------------------------------
export const DIRECTORY = {
  // /vendors holds EVERY company in the Directory (customers, subs, Einbau
  // itself) — there is no separate customers endpoint. CONFIRMED 200 by probe
  // 2026-09-05 (returns {id, address, authorized_bidder, bidding:{...}, ...}).
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

  // CONFIRMED: "Customer" is custom_field_73165 on this account (a Directory
  // vendor id), matching the kickoff doc's guess that it's a real Directory
  // reference dressed up as a custom field, not free text. Same wrapper
  // punch-worker's writeback uses.
  buildCustomerPatch({ companyId, directoryId }) {
    return { company_id: companyId, project: { [`custom_field_${PROCORE_CUSTOM_FIELDS.customer}`]: directoryId } };
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
// Email / Correspondence — VERIFY ONLY. HANDOFF does not push tender emails
// into Procore (Ben, 2026-09-08): the estimator forwards them to the project's
// inbound address after creation, and HANDOFF just confirms they arrived.
// ---------------------------------------------------------------------------
export const EMAIL_TOOL = {
  // Proven live in punch-worker (note the SINGULAR "project" in the path, and
  // the required topic_type/topic_id pair).
  listPath: (projectId) =>
    `/project/${projectId}/email_communications/emails?topic_type=project&topic_id=${projectId}`,
  version: "v1.0",

  countFromList(data) {
    return Array.isArray(data?.emails) ? data.emails.length : 0;
  },
};

// ---------------------------------------------------------------------------
// Project-level Estimating tool (cost / labour hours / margin for the brief)
// ---------------------------------------------------------------------------
export const ESTIMATING = {
  // TODO(sandbox): the guessed path below returned 404 on probe 2026-09-05
  // (v2.0). Still need to find the real REST surface for the project-level
  // Estimating tool's Summary view — likely also gated behind the same
  // Estimating permission that's currently blocking the Bid Board, so re-probe
  // once that's granted. This data never has to leave Procore (sidesteps the
  // SCOUT->NetSuite write-leg risk).
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
