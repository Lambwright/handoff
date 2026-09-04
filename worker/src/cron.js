// The 6h scheduled tick. NOT a trigger (see index.js header) — HANDOFF owns
// project creation, so there's nothing to detect. This only escalates
// notifications for handoffs going stale, on the cadence the kickoff doc
// describes (Teams -> email -> manager), transport STUBBED (see notify.js).

import { sqlFor } from "./db.js";
import { procoreFetch } from "./procore.js";
import { BID_BOARD } from "./procore-shapes.js";
import { writeNotification } from "./notify.js";
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

  // Awarded bids nobody has opened a handoff for yet.
  try {
    const { ok, data } = await procoreFetch(env, BID_BOARD.listPath(env.PROCORE_COMPANY_ID), { version: BID_BOARD.version });
    const awarded = ok ? (Array.isArray(data) ? data : data?.bid_board_projects || data?.projects || []).filter(BID_BOARD.isAwarded) : [];
    const ids = awarded.map((b) => String(b.id));
    const started = ids.length ? await sql`select source_bid_id from projects where source_bid_id = any(${ids})` : [];
    const startedIds = new Set(started.map((r) => r.source_bid_id));
    const untouched = awarded.filter((b) => !startedIds.has(String(b.id)));

    await batched(untouched, (bid) =>
      escalate(sql, `bid:${bid.id}`, {
        sourceBidId: String(bid.id),
        subject: `Awarded bid not yet handed off: ${bid.name || bid.id}`,
        body: `This bid has been Awarded but no HANDOFF has been opened for it yet.`,
      })
    );
  } catch (e) {
    console.log("cron: bid staleness check failed:", e.message);
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
