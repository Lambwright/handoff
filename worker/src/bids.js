// Bid Board read + opening a handoff. Step 1-2 of the core flow: the estimator
// picks an Awarded bid, HANDOFF pulls its data into a DB draft. NOTHING is
// created in Procore here — see create.js.
//
// The Bid Board API only supports page/per_page (no filter/sort), and there are
// ~4,200 bid records — a full pass exceeds a Worker's waitUntil budget. So the
// scan is incremental + resumable (see refreshBidCache): each cron tick does a
// full pass, and POST /bids/refresh advances it a bounded chunk at a time.
// GET /bids just reads `bid_cache`.

import { json } from "./http.js";
import { procoreFetch } from "./procore.js";
import { BID_BOARD } from "./procore-shapes.js";
import { normalizeType, buildGateTasks } from "./checklist.js";
import { suggestCustomerMatch } from "./matching.js";

const BID_SCAN_MAX_PAGES = 120; // ~4,200 records at ~60-85/page ≈ 60-70 pages; headroom for growth
// The endpoint IGNORES per_page and returns its own page size (~60-85 rows), so
// "did I get a full page?" can't be judged by row count — the scan pages until
// it hits a genuinely empty page. per_page is still sent as a hint.
const BID_SCAN_PER_PAGE = 100;
// A fresh full pass restarts if the in-progress one hasn't advanced in this long
// (a scan that died mid-way shouldn't wedge the state forever).
const SCAN_RESUME_STALE_MIN = 20;

async function upsertBidRow(sql, bid, runId) {
  const d = BID_BOARD.toDraft(bid);
  await sql`
    insert into bid_cache (bid_id, name, customer_name, customer_company_id, project_number,
                           address, estimate_total, estimator_user_id, snapshot, run_id, refreshed_at)
    values (${String(bid.id)}, ${d.name}, ${d.customer_name}, ${d.customer_company_id}, ${d.project_number},
            ${JSON.stringify(d.address)}::jsonb, ${d.estimate_total}, ${d.estimator_user_id},
            ${JSON.stringify(bid)}::jsonb, ${runId}, now())
    on conflict (bid_id) do update set
      name = excluded.name, customer_name = excluded.customer_name,
      customer_company_id = excluded.customer_company_id, project_number = excluded.project_number,
      address = excluded.address, estimate_total = excluded.estimate_total,
      estimator_user_id = excluded.estimator_user_id, snapshot = excluded.snapshot,
      run_id = excluded.run_id, refreshed_at = excluded.refreshed_at`;
}

// Advances the incremental Bid Board scan by up to `maxPages` pages, upserting
// each page's Awarded-not-handed-off bids as it goes. A full pass:
//   - starts a new run_id (fresh, or the previous run went stale)
//   - pages from last_page+1, persisting state after every page (so a
//     waitUntil cancellation just means the next call resumes)
//   - on reaching the end, prunes every bid_cache row not stamped with this
//     run_id and records full_pass_completed_at
// Returns { pagesScanned, complete }.
export async function refreshBidCache(env, sql, { maxPages = BID_SCAN_MAX_PAGES } = {}) {
  const [state] = await sql`select * from bid_scan_state where singleton = 1`;
  const staleCutoffMs = SCAN_RESUME_STALE_MIN * 60 * 1000;
  const inProgress =
    state?.run_id && state.last_page > 0 && Date.now() - new Date(state.updated_at).getTime() < staleCutoffMs;

  let runId = inProgress ? state.run_id : crypto.randomUUID();
  let startPage = inProgress ? state.last_page + 1 : 1;
  if (!inProgress) {
    await sql`update bid_scan_state set run_id = ${runId}, last_page = 0, updated_at = now() where singleton = 1`;
  }

  const path = BID_BOARD.listPath(env.PROCORE_COMPANY_ID);
  let page = startPage;
  let complete = false;
  for (let i = 0; i < maxPages && page <= BID_SCAN_MAX_PAGES; i++, page++) {
    const { ok, status, data } = await procoreFetch(env, path, {
      version: BID_BOARD.version,
      query: { per_page: BID_SCAN_PER_PAGE, page },
    });
    if (!ok) throw new Error(`Bid Board page ${page} failed: HTTP ${status} ${JSON.stringify(data).slice(0, 200)}`);
    const rows = data?.data || (Array.isArray(data) ? data : []);

    if (rows.length === 0) {
      complete = true;
      break;
    }

    for (const b of rows) if (BID_BOARD.isReadyToHandOff(b)) await upsertBidRow(sql, b, runId);
    await sql`update bid_scan_state set last_page = ${page}, updated_at = now() where singleton = 1`;
  }
  if (page > BID_SCAN_MAX_PAGES) complete = true;

  if (complete) {
    await sql`delete from bid_cache where run_id is distinct from ${runId}`;
    await sql`update bid_scan_state set last_page = 0, full_pass_completed_at = now(), updated_at = now() where singleton = 1`;
  }
  return { pagesScanned: page - startPage, complete };
}

// GET /bids — the cached Awarded-not-handed-off bids, annotated with any handoff
// already opened against them (so the picker offers "resume", not a duplicate).
export async function listAwardedBids({ env, sql }) {
  const cached = await sql`select * from bid_cache order by name`;
  const [state] = await sql`select full_pass_completed_at, last_page, updated_at from bid_scan_state where singleton = 1`;

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

  return json({
    bids,
    cache_refreshed_at: state?.full_pass_completed_at || null,
    scan_in_progress: Boolean(state?.last_page && state.last_page > 0),
  });
}

// POST /bids/refresh — advance the incremental Bid Board scan by a bounded chunk
// (small enough to finish inside a waitUntil budget, ~12 pages). Repeated calls
// resume and eventually complete a full pass; the 6h cron completes one on its
// own. Returns immediately; the caller re-polls GET /bids.
export async function refreshBids({ env, sql, executionCtx }) {
  executionCtx.waitUntil(
    refreshBidCache(env, sql, { maxPages: 12 }).catch((e) => console.log("bid cache refresh chunk failed:", e.message))
  );
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
