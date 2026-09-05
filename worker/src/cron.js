// The 6h scheduled tick. NOT a trigger (see index.js header) — HANDOFF owns
// project creation, so there's nothing to detect. This only escalates
// notifications for handoffs going stale, on the cadence the kickoff doc
// describes (Teams -> email -> manager), transport STUBBED (see notify.js).

import { sqlFor } from "./db.js";
import { writeNotification } from "./notify.js";
import { refreshBidCache } from "./bids.js";
import { batched } from "./util.js";

const STALE_AFTER_HOURS = 24;
const ESCALATION_CHANNELS = ["teams", "email", "manager"];

async function escalate(sql, key, { projectId = null, sourceBidId = null, subject, body }) {
  const existingCount = projectId
    ? (await sql`select count(*)::int as n from notifications where project_id = ${projectId}`)[0].n
    : (await sql`select count(*)::int as n from notifications where source_bid_id = ${sourceBidId}`)[0].n;

  const level = Math.min(existingCount, ESCALATION_CHANNELS.length - 1);
  const channel = ESCALATION_CHANNELS[level];
  return writeNotification(sql, { projectId, sourceBidId, channel, escalationLevel: level, subject, body });
}

export async function runCronTick(env) {
  const sql = sqlFor(env);

  // Rescan the Bid Board and refresh bid_cache (the "Awarded, not yet handed
  // off" list GET /bids serves). The scan is incremental — loop it in bounded
  // chunks until a full pass completes (or a generous guard trips), so a
  // scheduled invocation cut short still makes steady progress and the next
  // tick resumes. Then nudge on any cached bid nobody has opened a handoff for.
  try {
    for (let i = 0; i < 12; i++) {
      const { complete } = await refreshBidCache(env, sql, { maxPages: 12 });
      if (complete) break;
    }
    const cached = await sql`select bid_id, name from bid_cache`;
    const ids = cached.map((r) => r.bid_id);
    const started = ids.length ? await sql`select source_bid_id from projects where source_bid_id = any(${ids})` : [];
    const startedIds = new Set(started.map((r) => r.source_bid_id));
    const untouched = cached.filter((r) => !startedIds.has(r.bid_id));

    await batched(untouched, (bid) =>
      escalate(sql, `bid:${bid.bid_id}`, {
        sourceBidId: bid.bid_id,
        subject: `Awarded bid not yet handed off: ${bid.name || bid.bid_id}`,
        body: `This bid is in the Awarded column but no HANDOFF has been opened for it yet.`,
      })
    );
  } catch (e) {
    console.log("cron: bid cache refresh / staleness check failed:", e.message);
  }

  // Handoffs stuck mid-gate for more than STALE_AFTER_HOURS.
  const stale = await sql`
    select * from projects
    where status = 'gate' and updated_at < now() - (${STALE_AFTER_HOURS}::text || ' hours')::interval`;

  await batched(stale, (project) =>
    escalate(sql, `project:${project.id}`, {
      projectId: project.id,
      subject: `Handoff stalled: ${project.name || project.id}`,
      body: `This handoff has been in the Purgatory gate for over ${STALE_AFTER_HOURS}h without being submitted.`,
    })
  );

  // Refresh the PM workload cache opportunistically so the next assignment
  // screen opens fast. Best-effort — a live recompute also runs per-project.
  // (Left as a no-op here; computeCandidates in assignment.js recomputes fresh
  // per request, which is cheap enough at this project's volume for now.)
}
