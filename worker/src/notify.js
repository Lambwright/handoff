// Notification / escalation ledger. Transport is STUBBED this phase — every call
// here just writes a `notifications` row (visible in the dashboard); nothing is
// actually sent yet. Wiring a real transport (Power Automate HTTP flow vs.
// Procore's email API — open item) later is a change to this one file, not to
// every caller.

import { json } from "./http.js";

export async function writeNotification(sql, { projectId = null, sourceBidId = null, channel, escalationLevel = 0, recipient = null, subject = null, body = null }) {
  const [row] = await sql`
    insert into notifications (project_id, source_bid_id, channel, escalation_level, recipient, subject, body)
    values (${projectId}, ${sourceBidId}, ${channel}, ${escalationLevel}, ${recipient}, ${subject}, ${body})
    returning *`;
  return row;
}

export async function listNotifications({ params, sql }) {
  const rows = await sql`select * from notifications where project_id = ${params.projectId} order by created_at desc`;
  return json({ notifications: rows });
}
