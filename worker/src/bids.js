// Bid Board read + opening a handoff. Step 1-2 of the core flow: the estimator
// picks an Awarded bid, HANDOFF pulls its data into a DB draft. NOTHING is
// created in Procore here — see create.js.
//
// The Bid Board API only supports page/per_page (no filter/sort), and there are
// ~4,200 bid records, so scanning it on every estimator visit is a non-starter.
// Instead: scanAwardedBids() pages the whole board and filters to the ~20
// Awarded-not-yet-handed-off bids; refreshBidCache() persists that into
// `bid_cache`; GET /bids reads the cache. The 6h cron refreshes it, and
// POST /bids/refresh forces it on demand.

import { json } from "./http.js";
import { procoreFetch } from "./procore.js";
import { BID_BOARD } from "./procore-shapes.js";
import { normalizeType, buildGateTasks } from "./checklist.js";
import { suggestCustomerMatch } from "./matching.js";
import { batched } from "./util.js";

const BID_SCAN_MAX_PAGES = 80; // ~4,200 records at ~80/page — generous headroom

// Pages the entire Bid Board and returns the raw records that are Awarded and
// not yet converted to a project. Bounded by BID_SCAN_MAX_PAGES.
export async function scanAwardedBids(env) {
  const path = BID_BOARD.listPath(env.PROCORE_COMPANY_ID);
  const ready = [];
  for (let page = 1; page <= BID_SCAN_MAX_PAGES; page++) {
    const { ok, status, data } = await procoreFetch(env, path, {
      version: BID_BOARD.version,
      query: { per_page: 100, page },
    });
    if (!ok) throw new Error(`Bid Board page ${page} failed: HTTP ${status} ${JSON.stringify(data).slice(0, 200)}`);
    const rows = data?.data || (Array.isArray(data) ? data : []);
    if (rows.length === 0) break;
    for (const b of rows) if (BID_BOARD.isReadyToHandOff(b)) ready.push(b);
  }
  return ready;
}

// Full-scan + upsert into bid_cache, pruning bids that dropped out of the set.
export async function refreshBidCache(env, sql) {
  const bids = await scanAwardedBids(env);
  const seen = bids.map((b) => String(b.id));

  await batched(bids, (b) => {
    const d = BID_BOARD.toDraft(b);
    return sql`
      insert into bid_cache (bid_id, name, customer_name, customer_company_id, project_number,
                             address, estimate_total, estimator_user_id, snapshot, refreshed_at)
      values (${String(b.id)}, ${d.name}, ${d.customer_name}, ${d.customer_company_id}, ${d.project_number},
              ${JSON.stringify(d.address)}::jsonb, ${d.estimate_total}, ${d.estimator_user_id},
              ${JSON.stringify(b)}::jsonb, now())
      on conflict (bid_id) do update set
        name = excluded.name, customer_name = excluded.customer_name,
        customer_company_id = excluded.customer_company_id, project_number = excluded.project_number,
        address = excluded.address, estimate_total = excluded.estimate_total,
        estimator_user_id = excluded.estimator_user_id, snapshot = excluded.snapshot,
        refreshed_at = excluded.refreshed_at`;
  });

  if (seen.length) {
    await sql`delete from bid_cache where bid_id <> all(${seen})`;
  } else {
    await sql`delete from bid_cache`;
  }
  return seen.length;
}

// GET /bids — the cached Awarded-not-handed-off bids, annotated with any handoff
// already opened against them (so the picker offers "resume", not a duplicate).
// ?refresh=1 forces a fresh scan first (accepts the ~10-30s wait).
export async function listAwardedBids({ url, env, sql }) {
  if (url.searchParams.get("refresh") === "1") {
    await refreshBidCache(env, sql);
  }

  const cached = await sql`select * from bid_cache order by refreshed_at desc, name`;
  const ids = cached.map((r) => r.bid_id);
  const existing = ids.length
    ? await sql`select source_bid_id, id as project_id, status from projects where source_bid_id = any(${ids})`
    : [];
  const byBidId = new Map(existing.map((r) => [r.source_bid_id, r]));

  const bids = cached.map((r) => {
    const handoff = byBidId.get(r.bid_id);
    return {
      bid_id: r.bid_id,
      name: r.name,
      project_number: r.project_number,
      customer_name: r.customer_name,
      city: r.address?.city || null,
      state_code: r.address?.state_code || null,
      estimate_total: r.estimate_total,
      handoff_project_id: handoff?.project_id || null,
      handoff_status: handoff?.status || null,
    };
  });

  const [{ refreshed_at } = {}] = cached.length
    ? [cached.reduce((a, b) => (a.refreshed_at > b.refreshed_at ? a : b))]
    : [];
  return json({ bids, cache_refreshed_at: refreshed_at || null });
}

// POST /bids/refresh — force a Bid Board rescan. The scan pages the whole board
// (~40+ sequential GETs, ~30-60s), which would blow a normal request's
// wall-clock budget, so it runs in the background via waitUntil and the caller
// re-fetches GET /bids once it's had time to land.
export async function refreshBids({ env, sql, executionCtx }) {
  executionCtx.waitUntil(refreshBidCache(env, sql).catch((e) => console.log("bid cache refresh failed:", e.message)));
  return json({ ok: true, started: true });
}

// The bid record for opening a handoff: prefer the cached snapshot; fall back to
// a direct single-bid GET if it's not in the cache (stale cache, or the scan
// hasn't run yet).
async function getBidRecord(env, sql, bidId) {
  const [row] = await sql`select snapshot from bid_cache where bid_id = ${bidId}`;
  if (row?.snapshot) return row.snapshot;
  const { ok, data } = await procoreFetch(
    env,
    `${BID_BOARD.listPath(env.PROCORE_COMPANY_ID)}/${bidId}`,
    { version: BID_BOARD.version }
  );
  if (!ok) return null;
  return data?.data || data || null;
}

// POST /handoffs { bid_id } — idempotent on source_bid_id: resumes an existing
// draft rather than erroring or duplicating.
export async function openHandoff({ request, env, sql, auth }) {
  const body = await request.json().catch(() => null);
  const bidId = body?.bid_id ? String(body.bid_id) : null;
  if (!bidId) return json({ error: "invalid_request", detail: "bid_id is required" }, 400);

  const [existing] = await sql`select id from projects where source_bid_id = ${bidId}`;
  if (existing) return json({ project_id: existing.id, resumed: true });

  const bid = await getBidRecord(env, sql, bidId);
  if (!bid) return json({ error: "not_found", detail: `bid ${bidId} not found` }, 404);
  if (!BID_BOARD.isReadyToHandOff(bid)) {
    return json({ error: "not_awarded", detail: "This bid isn't in the Awarded column, or already has a project." }, 409);
  }

  const draft = BID_BOARD.toDraft(bid);
  const projectType = normalizeType(draft.project_type); // null off the bid — estimator sets it in the gate

  // Best-effort customer suggestion so the customer gate task starts pre-filled
  // — the estimator still confirms it (matching.js never auto-writes to Procore;
  // name match only, no parsing).
  let customerSeed = { name: draft.customer_name || null, customer_company_id: draft.customer_company_id || null };
  if (draft.customer_name) {
    try {
      customerSeed.suggestion = await suggestCustomerMatch(env, draft.customer_name);
    } catch (e) {
      customerSeed.suggestion_error = e.message;
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
  // Pre-fill the tasks we already have data for (address off the bid) so the
  // estimator confirms rather than retypes. Timeline isn't on the bid, so it
  // stays empty.
  for (const t of tasks) {
    const seedValue = t.task_type === "address" ? draft.address : null;
    await sql`
      insert into gate_tasks (project_id, task_type, label, required, verify_backing, gap_owner, status, value)
      values (${project.id}, ${t.task_type}, ${t.label}, ${t.required}, ${t.verify_backing}, ${t.gap_owner},
              'pending', ${seedValue ? JSON.stringify(seedValue) : null}::jsonb)
      on conflict (project_id, task_type) do nothing`;
  }

  return json({ project_id: project.id, resumed: false }, 201);
}
