// /me (any verified Einbau ID session, role or not) and small live/static
// option-list reads. Role, department, and every other per-person fact comes
// from auth-worker's role matrix (HELM) — HANDOFF holds none of it itself.

import { json } from "./http.js";
import { verifyIdentity, resolveHandoffActor } from "./auth.js";
import { procoreFetch } from "./procore.js";
import { REGIONS, TIMEZONES, PROCORE_CUSTOM_FIELDS, fiscalYearOptionsPath, CURRENCY_OPTIONS, PAYMENT_TERMS_OPTIONS } from "./procore-shapes.js";

// TEMPORARY diagnostic — an authenticated passthrough to an arbitrary Procore
// REST path, used to nail down the real endpoint/response shapes the
// TODO(sandbox) markers in procore-shapes.js are still guessing at. Same trick
// punch-worker used (`/admin/procore-probe`). Admin-only. Delete this route and
// handler once procore-shapes.js is filled in for real.
//   POST /admin/procore-probe  { path, version?, method?, body?, query? }
export async function procoreProbe({ request, env }) {
  const b = await request.json().catch(() => ({}));
  if (!b.path) {
    return json({ error: "invalid_request", detail: 'path is required, e.g. "/companies/<co>/project_stages"' }, 400);
  }
  const result = await procoreFetch(env, b.path, {
    method: b.method || "GET",
    version: b.version || "v1.0",
    body: b.body,
    query: b.query,
  });
  return json(result);
}

// Deliberately does NOT 403 when the caller has no HANDOFF role yet — the
// frontend needs to tell the difference between "not logged in" and "logged in,
// but no role assigned", and show the right message for each.
export async function getMe({ request, env }) {
  const id = await verifyIdentity(request, env);
  if (!id.ok) return json({ error: "unauthorized", reason: id.reason }, id.status || 401);

  const actor = resolveHandoffActor(id.user);
  return json(
    { user: id.user, actor: actor || null },
    200,
    { refreshedToken: id.refreshedToken }
  );
}

// GET /regions — Einbau's Procore project regions (branches), live.
export async function listRegions({ env }) {
  const { ok, data } = await procoreFetch(env, REGIONS.listPath(env.PROCORE_COMPANY_ID), { version: REGIONS.version });
  const regions = ok && Array.isArray(data) ? data.map((r) => ({ id: String(r.id), name: r.name })) : [];
  return json({ regions });
}

// GET /timezones — the fixed list (no useful Procore endpoint).
export async function listTimezones() {
  return json({ timezones: TIMEZONES });
}

// GET /currency-options, /payment-terms-options — stable, hardcoded (confirmed
// 2026-10-07, unlike Fiscal Year these aren't actively relabeled).
export async function listCurrencyOptions() {
  return json({ options: CURRENCY_OPTIONS });
}
export async function listPaymentTermsOptions() {
  return json({ options: PAYMENT_TERMS_OPTIONS });
}

// GET /fiscal-year-options — live, NOT cached/hardcoded: Ben relabels these
// entries as part of an annual portfolio cleanup (see procore-shapes.js), so
// a stale snapshot would silently point at the wrong year. Whoever renders
// the gate's Fiscal Year field should match "Current" by name from this list
// at the moment they need a default, not remember an id from an earlier call.
export async function listFiscalYearOptions({ env }) {
  const { ok, data } = await procoreFetch(env, fiscalYearOptionsPath(PROCORE_CUSTOM_FIELDS.fiscalYear), { version: "v1.0", query: { company_id: env.PROCORE_COMPANY_ID } });
  const options = ok && Array.isArray(data) ? data.map((o) => ({ id: String(o.id), name: o.label })) : [];
  return json({ options });
}

// GET /bid-stage-history — raw win-rate tracking data (admin only). No chart
// yet, just the queryable record Ben asked for; optional ?bid_id= to scope to
// one bid, otherwise the most recent transitions across the whole board.
export async function listBidStageHistory({ url, sql }) {
  const bidId = url.searchParams.get("bid_id");
  const rows = bidId
    ? await sql`select * from bid_stage_history where bid_id = ${bidId} order by changed_at desc`
    : await sql`select * from bid_stage_history order by changed_at desc limit 500`;
  return json({ history: rows });
}

