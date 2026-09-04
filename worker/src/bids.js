// Bid Board read + opening a handoff. This is step 1-2 of the core flow: the
// estimator picks a won bid, and HANDOFF pulls its data into a DB draft. NOTHING
// is created in Procore here — see create.js for that.

import { json } from "./http.js";
import { procoreFetch } from "./procore.js";
import { BID_BOARD } from "./procore-shapes.js";
import { normalizeType, buildGateTasks } from "./checklist.js";
import { suggestCustomerMatch } from "./matching.js";

async function fetchBidBoard(env) {
  const { ok, status, data } = await procoreFetch(env, BID_BOARD.listPath(env.PROCORE_COMPANY_ID), {
    version: BID_BOARD.version,
  });
  if (!ok) throw new Error(`Procore Bid Board request failed: ${status} ${JSON.stringify(data)?.slice(0, 300)}`);
  return Array.isArray(data) ? data : data?.bid_board_projects || data?.projects || [];
}

// GET /bids — every bid in the Awarded column, annotated with whether a handoff
// has already been opened against it (so the picker can offer "resume" instead
// of silently starting a duplicate).
export async function listAwardedBids({ env, sql }) {
  const bids = await fetchBidBoard(env);
  const awarded = bids.filter(BID_BOARD.isAwarded);

  const ids = awarded.map((b) => String(b.id));
  const existing = ids.length
    ? await sql`select source_bid_id, id as project_id, status from projects where source_bid_id = any(${ids})`
    : [];
  const byBidId = new Map(existing.map((r) => [r.source_bid_id, r]));

  const results = awarded.map((bid) => {
    const draft = BID_BOARD.toDraft(bid);
    const handoff = byBidId.get(String(bid.id));
    return {
      bid_id: String(bid.id),
      name: draft.name,
      project_number: draft.project_number,
      customer_name: draft.customer_name,
      city: draft.address?.city || null,
      state_code: draft.address?.state_code || null,
      handoff_project_id: handoff?.project_id || null,
      handoff_status: handoff?.status || null,
    };
  });

  return json({ bids: results });
}

// POST /handoffs { bid_id } — idempotent on source_bid_id: resumes an existing
// draft rather than erroring or duplicating.
export async function openHandoff({ request, env, sql, auth }) {
  const body = await request.json().catch(() => null);
  const bidId = body?.bid_id ? String(body.bid_id) : null;
  if (!bidId) return json({ error: "invalid_request", detail: "bid_id is required" }, 400);

  const [existing] = await sql`select id from projects where source_bid_id = ${bidId}`;
  if (existing) {
    return json({ project_id: existing.id, resumed: true });
  }

  const bids = await fetchBidBoard(env);
  const bid = bids.find((b) => String(b.id) === bidId);
  if (!bid) return json({ error: "not_found", detail: `bid ${bidId} not found (or no longer Awarded)` }, 404);

  const draft = BID_BOARD.toDraft(bid);
  const projectType = normalizeType(draft.project_type);

  // Best-effort customer suggestion at open time so the gate task starts
  // pre-filled — the estimator still has to confirm it (matching.js never
  // auto-writes to Procore, and this is a name match only, no document parsing).
  let customerSeed = { name: draft.customer_name || null };
  if (draft.customer_name) {
    try {
      const suggestion = await suggestCustomerMatch(env, draft.customer_name);
      customerSeed = { name: draft.customer_name, suggestion };
    } catch (e) {
      customerSeed = { name: draft.customer_name, suggestion_error: e.message };
    }
  }

  const [project] = await sql`
    insert into projects (source_bid_id, name, project_number, project_type, bid_snapshot,
                           address, customer, timeline, created_by)
    values (${bidId}, ${draft.name}, ${draft.project_number}, ${projectType},
            ${JSON.stringify(bid)}::jsonb, ${JSON.stringify(draft.address)}::jsonb,
            ${JSON.stringify(customerSeed)}::jsonb, ${JSON.stringify(draft.timeline)}::jsonb,
            ${auth.actor.einbau_username})
    returning *`;

  const tasks = buildGateTasks(projectType);
  // Pre-fill the tasks HANDOFF already has structured data for so the estimator
  // is confirming, not retyping — address/timeline came straight off the bid.
  const prefilled = new Set(["address", "timeline"]);
  for (const t of tasks) {
    const hasSeed = prefilled.has(t.task_type);
    await sql`
      insert into gate_tasks (project_id, task_type, label, required, verify_backing, gap_owner, status, value)
      values (${project.id}, ${t.task_type}, ${t.label}, ${t.required}, ${t.verify_backing}, ${t.gap_owner},
              ${hasSeed ? "pending" : "pending"},
              ${hasSeed ? JSON.stringify(t.task_type === "address" ? draft.address : draft.timeline) : null}::jsonb)
      on conflict (project_id, task_type) do nothing`;
  }

  return json({ project_id: project.id, resumed: false }, 201);
}
