// Labour Budget generator — reads the real, already-pushed Procore Budget
// (budget_line_items) for a project and shapes it into the no-dollar-figures,
// hours-rounded-down, sub-job-grouped data the PDF is built from. The PDF
// itself is drawn client-side (web/src/labourBudgetPdf.js, same pdf-lib
// pattern TALLY's exportPdf.js already proves live) — this just resolves
// which estimate is primary (so the PC can confirm it's the right one before
// generating, per Ben's explicit ask 2026-11-05) and returns the shaped data.

import { json } from "./http.js";
import { procoreFetch, procoreFetchAll } from "./procore.js";
import { ESTIMATING, BUDGET } from "./procore-shapes.js";
import { pmMayAccess } from "./auth.js";

// GET /projects/:id/labour-budget — pc/admin only, same scope as build_budget.
export async function getLabourBudget({ params, env, sql, auth }) {
  const [project] = await sql`select * from projects where id = ${params.id}`;
  if (!project || !(await pmMayAccess(sql, auth?.actor, project))) return json({ error: "not_found" }, 404);
  if (!project.procore_project_id) {
    return json({ error: "not_created", detail: "This project hasn't been created in Procore yet." }, 409);
  }

  // Bid-scoped, not project-scoped (same reason as gate.js's scope draft / brief.js —
  // the real proposal never carries onto the created project, see procore-shapes.js's
  // ESTIMATING comment) — just for the confirmation prompt's "based on this estimate"
  // display. The actual Budget read below is project-scoped and doesn't need this.
  let proposal = null;
  if (project.source_bid_id) {
    const { ok, data } = await procoreFetch(env, ESTIMATING.bidProposalsPath(env.PROCORE_COMPANY_ID, project.source_bid_id), {
      version: ESTIMATING.version,
    });
    if (ok) {
      const primary = ESTIMATING.findPrimaryProposal(data);
      if (primary) proposal = { id: primary.id, name: primary.name, total: primary.total, quote_nr: primary.quote_nr };
    }
  }

  const items = await procoreFetchAll(env, BUDGET.lineItemsPath(env.PROCORE_COMPANY_ID, project.procore_project_id), {
    version: BUDGET.version,
    perPage: 100,
    maxPages: 20,
  });

  if (items.length === 0) {
    return json(
      {
        error: "budget_empty",
        detail: "No Budget line items on this project yet — export the estimate to Budget first (see the Build the Procore Budget gate task).",
      },
      409
    );
  }

  const groups = BUDGET.groupLineItems(items);

  return json({
    project: {
      name: project.name,
      project_number: project.project_number,
      po_number: project.po_number,
      customer: project.customer?.name || null,
    },
    proposal,
    groups,
  });
}
