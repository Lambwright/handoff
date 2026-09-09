// The Purgatory checklist as DATA, not hardcoded UI — a configurable,
// project-type-aware list. Same underlying concept as PUNCH's CHECKLIST_REGISTRY
// / buildChecklist() (PUNCH/punch-bubbles.jsx): each item declares which project
// types it applies to; the seed keeps only the applicable ones.
//
// PUNCH's registry spans five types (T&M, Contract, Service Call, Warranty,
// Overhead). CONFIRMED (Ben, 2026-09-04): only Contract and Service Call come
// through the estimate -> project flow, and HANDOFF doesn't really need to
// distinguish between them — every registry item below already treats the two
// identically, so no per-item changes were needed, just this constant.
// PROJECT_TYPES keeps all five so normalizeType() still degrades gracefully on
// stray data instead of returning null; ESTIMATE_PROJECT_TYPES is the real
// subset HANDOFF's flow is scoped to.
export const PROJECT_TYPES = ["T&M", "Contract", "Service Call", "Warranty", "Overhead"];
export const ESTIMATE_PROJECT_TYPES = ["Contract", "Service Call"];

const ALL = { "T&M": true, Contract: true, "Service Call": true, Warranty: true, Overhead: true };
const CONTRACTISH = { "T&M": true, Contract: true, "Service Call": true, Warranty: false, Overhead: false };

// input types the frontend PurgatoryGate / GapResolution knows how to render:
//   text | textarea | address | customer | dates | file | forward_verify
// verify_backing (self-report + live Procore check):
//   documents | email_communications | null
// post_creation: not part of the gate's "ready to submit" check — the estimator
//   does it in Procore directly AFTER the project exists, then HANDOFF verifies
//   (e.g. tender emails: forward to the project inbox, then confirm they landed
//   in the Emails tool). Still tracked as an outstanding item until verified.
// gap_owner: who a deferred / verify-failed item routes to via GapResolution.
export const CHECKLIST_REGISTRY = [
  {
    key: "address",
    label: "Project address",
    input: "address",
    required: true,
    types: ALL,
    gap_owner: "estimator",
    help: "Pre-filled from the bid record. Review and confirm — PM assignment depends on it.",
  },
  {
    key: "customer",
    label: "Customer",
    input: "customer",
    required: true,
    types: ALL,
    gap_owner: "estimator",
    help: "Matched against the Procore Directory. Confirm the match or search / create.",
  },
  {
    key: "timeline",
    label: "Start / end dates",
    input: "dates",
    required: true,
    types: ALL,
    gap_owner: "estimator",
    help: "Confirmed timeline — feeds PM workload/overlap and the Resource Planning request.",
  },
  {
    key: "po_number",
    label: "PO number",
    input: "text",
    required: true,
    types: CONTRACTISH,
    gap_owner: "estimator",
    help: "The purchase-order number (distinct from the PO document).",
  },
  {
    key: "po_document",
    label: "PO document",
    input: "file",
    required: true,
    types: CONTRACTISH,
    verify_backing: "documents",
    gap_owner: "estimator",
    help: "Drag-and-drop the PO. Attached to the Procore project on creation.",
  },
  {
    key: "tender_correspondence",
    label: "Tender correspondence",
    input: "forward_verify",
    required: true,
    post_creation: true,
    types: ALL,
    verify_backing: "email_communications",
    gap_owner: "estimator",
    help: "Once the project exists, forward the tender emails to its Procore inbox. HANDOFF then confirms they landed in the Emails tool.",
  },
  {
    key: "scope_summary",
    label: "Scope summary",
    input: "textarea",
    required: true,
    types: ALL,
    gap_owner: "estimator",
    help: "A few sentences on what's actually in scope. Seeds the handoff brief.",
  },
  {
    key: "estimates_reviewed",
    label: "Estimate reviewed with PM lead",
    input: "text",
    required: false,
    types: { "T&M": false, Contract: true, "Service Call": true, Warranty: false, Overhead: false },
    gap_owner: "estimator",
  },
  {
    key: "site_contact",
    label: "Key site contact",
    input: "text",
    required: false,
    types: ALL,
    gap_owner: "pm",
    help: "Name + phone for the person on site, if known.",
  },
];

// Map whatever Procore calls the project/bid type onto one of PROJECT_TYPES.
export function normalizeType(raw) {
  const s = (raw || "").toString().trim().toLowerCase();
  if (!s) return null;
  if (s.includes("t&m") || s.includes("t & m") || s.includes("time") || s === "tm") return "T&M";
  if (s.includes("service")) return "Service Call";
  if (s.includes("warrant")) return "Warranty";
  if (s.includes("overhead")) return "Overhead";
  if (s.includes("contract") || s.includes("lump") || s.includes("fixed")) return "Contract";
  return null;
}

export function isPostCreation(taskType) {
  return Boolean(CHECKLIST_REGISTRY.find((i) => i.key === taskType)?.post_creation);
}

// The gate-task rows to seed for a given project type. Unknown / null type ->
// treat as Contract (the strictest reasonable default) so nothing is skipped.
export function buildGateTasks(projectType) {
  const type = PROJECT_TYPES.includes(projectType) ? projectType : "Contract";
  return CHECKLIST_REGISTRY.filter((item) => item.types[type]).map((item) => ({
    task_type: item.key,
    label: item.label,
    required: item.required !== false,
    verify_backing: item.verify_backing || null,
    gap_owner: item.gap_owner || "estimator",
  }));
}
