// handoff-worker
//
// HANDOFF is the only sanctioned path from the Bid Board to the Portfolio. An
// estimator opens a handoff against an Awarded bid, HANDOFF houses everything
// the Purgatory checklist collects in its own database, and only once every item
// is complete-or-deferred does it create the Procore project and distribute the
// housed data. There is no webhook and no reconciliation poll — nothing to
// detect, because HANDOFF owns creation.
//
// Routes (see each module's header comment for the full list):
//   GET  /health                     — liveness, no auth
//   GET  /me                         — verified identity + HANDOFF role (or null)
//   GET  /admin/users                (admin) list HANDOFF users
//   POST /admin/users                (admin) create/update a HANDOFF user role
//   DELETE /admin/users/:id          (admin) deactivate
//   GET  /bids                       (estimator, assignment, admin) Awarded Bid Board projects
//   POST /handoffs                   (estimator, admin) open a handoff against a bid
//   GET  /projects                   (any role) dashboard queue, ?status= filter
//   GET  /projects/:id/gate          (any role) the gate-task list
//   PATCH /gate-tasks/:id            (estimator, pm, admin) set value / defer+reason
//   POST /gate-tasks/:id/verify      (estimator, pm, admin) self-report -> live Procore check
//   POST /projects/:id/gate/po-document        (estimator, admin) upload -> R2
//   POST /projects/:id/gate/tender-correspondence (estimator, admin) upload -> R2
//   POST /projects/:id/gate/submit   (estimator, admin) run the create+distribute pipeline
//   GET  /assignment/:id/candidates  (assignment, admin) PM workload/affinity comparison
//   POST /assignment/:id/recommend   (assignment, admin) Claude recommendation
//   POST /assignment/:id/confirm     (assignment, admin) accept/override -> PATCH Procore
//   GET  /briefs/:projectId          (any role) the persisted handoff brief
//   GET  /projects/:projectId/notifications (any role) the escalation ledger for one handoff
//   GET  /pm-affinity                (assignment, admin) list
//   POST /pm-affinity                (assignment, admin) upsert a row
//
// Secrets: DATABASE_URL, ANTHROPIC_API_KEY, HANDOFF_SERVICE_KEY,
//          PROCORE_CLIENT_ID, PROCORE_CLIENT_SECRET

import { json, preflight } from "./http.js";
import { sqlFor } from "./db.js";
import { makeRouter } from "./router.js";
import { getMe, listUsers, upsertUser, deactivateUser } from "./admin.js";
import { listAwardedBids, openHandoff } from "./bids.js";
import { searchCustomerDirectory } from "./matching.js";
import {
  getGate,
  patchGateTask,
  verifyGateTask,
  uploadGateDocument,
  submitGate,
} from "./gate.js";
import {
  getAssignmentCandidates,
  postAssignmentRecommendation,
  confirmAssignment,
} from "./assignment.js";
import { getBrief } from "./brief.js";
import { listAffinity, upsertAffinity } from "./affinity.js";
import { listNotifications } from "./notify.js";
import { listProjects } from "./projects.js";
import { runCronTick } from "./cron.js";

const router = makeRouter();

router.get("/health", () => json({ ok: true, app: "handoff-worker" }));
router.get("/me", getMe);

router.get("/admin/users", { roles: ["admin"] }, listUsers);
router.post("/admin/users", { roles: ["admin"] }, upsertUser);
router.delete("/admin/users/:id", { roles: ["admin"] }, deactivateUser);

router.get("/bids", { roles: ["estimator", "assignment"] }, listAwardedBids);
router.post("/handoffs", { roles: ["estimator"] }, openHandoff);

router.get("/projects", { roles: [] }, listProjects);
router.get("/customer-search", { roles: [] }, searchCustomerDirectory);
router.get("/projects/:id/gate", { roles: [] }, getGate);
router.patch("/gate-tasks/:id", { roles: [] }, patchGateTask);
router.post("/gate-tasks/:id/verify", { roles: [] }, verifyGateTask);
router.post("/projects/:id/gate/po-document", { roles: ["estimator"] }, (ctx) =>
  uploadGateDocument(ctx, "po_document")
);
router.post("/projects/:id/gate/tender-correspondence", { roles: ["estimator"] }, (ctx) =>
  uploadGateDocument(ctx, "tender_correspondence")
);
router.post("/projects/:id/gate/submit", { roles: ["estimator", "admin"] }, submitGate);

router.get("/assignment/:id/candidates", { roles: ["assignment"] }, getAssignmentCandidates);
router.post("/assignment/:id/recommend", { roles: ["assignment"] }, postAssignmentRecommendation);
router.post("/assignment/:id/confirm", { roles: ["assignment"] }, confirmAssignment);

router.get("/briefs/:projectId", { roles: [] }, getBrief);
router.get("/projects/:projectId/notifications", { roles: [] }, listNotifications);

router.get("/pm-affinity", { roles: ["assignment"] }, listAffinity);
router.post("/pm-affinity", { roles: ["assignment"] }, upsertAffinity);

export default {
  async fetch(request, env, executionCtx) {
    if (request.method === "OPTIONS") return preflight();
    const sql = sqlFor(env);
    return router.handle(request, env, executionCtx, sql);
  },

  // NOT a trigger — HANDOFF has nothing to detect (see file header). This only
  // refreshes the PM workload cache and runs the gate-staleness escalation tick.
  async scheduled(event, env, executionCtx) {
    executionCtx.waitUntil(runCronTick(env).catch((e) => console.log("cron tick failed:", e.message, e.stack)));
  },
};
