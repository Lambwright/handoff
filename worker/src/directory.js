// GET /directory/vendor-contacts?vendor_id= — CRM's follow-up-email "To" picker
// (2026-10-27, Ben approved). Serves Procore Directory contacts for one vendor
// out of a whole-company cache refreshed at most once/24h, so a cache hit never
// calls Procore. See schema.sql's directory_contacts_cache / _scan_state and
// PROCORE-RATE-LIMITS.md.

import { json } from "./http.js";
import { procoreFetchAll } from "./procore.js";
import { DIRECTORY } from "./procore-shapes.js";
import { rankMatches } from "./matching.js";

const REFRESH_INTERVAL_MS = 24 * 60 * 60 * 1000;

// v1.3 company users — CONFIRMED live (auth-worker's fetchProcoreEmployees)
// to include external/subcontractor Directory contacts, not just employees,
// and to carry id/name/email_address/is_active/is_employee/vendor{name}.
// phone/title field names below are NOT confirmed on this account — best
// guess at Procore's usual v1.3 User fields; a wrong guess just means that
// column stays null, nothing breaks.
function mapUser(u) {
  const first = u.first_name || (u.name ? u.name.split(" ")[0] : "") || "";
  const last = u.last_name || (u.name ? u.name.split(" ").slice(1).join(" ") : "") || "";
  return {
    procore_user_id: String(u.id),
    vendor_id: u.vendor?.id != null ? String(u.vendor.id) : null,
    vendor_name: u.vendor?.name || null,
    first_name: first,
    last_name: last,
    email: (u.email_address || u.login || "").trim() || null,
    phone: u.business_phone || u.mobile_phone || u.phone || null,
    title: u.job_title || u.title || null,
    is_active: Boolean(u.is_active),
  };
}

// One bulk upsert via unnest() rather than one round-trip per row -- ~2,500
// sequential awaited upserts was minutes-slow (and once risked running past a
// Worker's execution budget, the same ceiling that forced bids.js's scan to be
// incremental/resumable). A single statement scales to this row count fine.
async function refreshCache(env, sql) {
  const users = await procoreFetchAll(env, `/companies/${env.PROCORE_COMPANY_ID}/users`, {
    version: "v1.3",
    perPage: 1000,
    maxPages: 10,
  });
  const rows = users.filter((u) => u && u.id != null).map(mapUser);

  if (rows.length) {
    await sql`
      insert into directory_contacts_cache
        (procore_user_id, vendor_id, vendor_name, first_name, last_name, email, phone, title, is_active, refreshed_at)
      select * from unnest(
        ${rows.map((r) => r.procore_user_id)}::text[],
        ${rows.map((r) => r.vendor_id)}::text[],
        ${rows.map((r) => r.vendor_name)}::text[],
        ${rows.map((r) => r.first_name)}::text[],
        ${rows.map((r) => r.last_name)}::text[],
        ${rows.map((r) => r.email)}::text[],
        ${rows.map((r) => r.phone)}::text[],
        ${rows.map((r) => r.title)}::text[],
        ${rows.map((r) => r.is_active)}::boolean[]
      ) as t(procore_user_id, vendor_id, vendor_name, first_name, last_name, email, phone, title, is_active)
      on conflict (procore_user_id) do update set
        vendor_id = excluded.vendor_id, vendor_name = excluded.vendor_name,
        first_name = excluded.first_name, last_name = excluded.last_name,
        email = excluded.email, phone = excluded.phone, title = excluded.title,
        is_active = excluded.is_active, refreshed_at = now()`;
  }

  await sql`
    update directory_contacts_scan_state
    set last_full_refresh_at = now(), updated_at = now()
    where singleton = 1`;
}

// GET /directory/vendor-search?q= — CRM's "Find in Procore" linker for a
// company with no Procore vendor id yet (2026-10-29, Ben approved via CRM).
// Same cache-at-most-daily shape as the contacts cache above, same scoring as
// matching.js's customer-search (rankMatches over the whole Directory).
async function refreshVendorsCache(env, sql) {
  const vendors = await procoreFetchAll(env, DIRECTORY.listVendorsPath(env.PROCORE_COMPANY_ID), {
    version: DIRECTORY.version,
    perPage: 1000,
    maxPages: 10,
  });
  const rows = vendors
    .filter((v) => v && v.id != null && (v.name || v.company || v.companyname))
    .map((v) => ({
      directory_id: String(v.id),
      name: v.name || v.company || v.companyname,
      is_active: v.is_active !== false,
    }));

  if (rows.length) {
    await sql`
      insert into directory_vendors_cache (directory_id, name, is_active, refreshed_at)
      select * from unnest(
        ${rows.map((r) => r.directory_id)}::text[],
        ${rows.map((r) => r.name)}::text[],
        ${rows.map((r) => r.is_active)}::boolean[]
      ) as t(directory_id, name, is_active)
      on conflict (directory_id) do update set
        name = excluded.name, is_active = excluded.is_active, refreshed_at = now()`;
  }

  await sql`
    update directory_contacts_scan_state
    set last_vendor_refresh_at = now(), updated_at = now()
    where singleton = 1`;
}

export async function searchVendors({ env, sql, url }) {
  const q = (url.searchParams.get("q") || "").trim();
  if (q.length < 2) return json({ candidates: [] });

  const [state] = await sql`select last_vendor_refresh_at from directory_contacts_scan_state where singleton = 1`;
  const stale = !state?.last_vendor_refresh_at || Date.now() - new Date(state.last_vendor_refresh_at).getTime() >= REFRESH_INTERVAL_MS;

  if (stale) {
    try {
      await refreshVendorsCache(env, sql);
    } catch (e) {
      return json({ error: "procore_unavailable", detail: e.message }, 502);
    }
  }

  const vendors = await sql`select directory_id as id, name, is_active from directory_vendors_cache`;
  const candidates = rankMatches(q, vendors)
    .filter((m) => m.is_active && m.score > 0)
    .slice(0, 10);
  return json({ candidates });
}

export async function getVendorContacts({ env, sql, url }) {
  const vendorId = url.searchParams.get("vendor_id");
  if (!vendorId) return json({ error: "invalid_request", detail: "vendor_id is required" }, 400);

  const [state] = await sql`select last_full_refresh_at from directory_contacts_scan_state where singleton = 1`;
  const stale = !state?.last_full_refresh_at || Date.now() - new Date(state.last_full_refresh_at).getTime() >= REFRESH_INTERVAL_MS;
  let cached = true;

  if (stale) {
    cached = false;
    try {
      await refreshCache(env, sql);
    } catch (e) {
      // Procore failure (incl. a 429 procoreFetchAll turned into a throw) --
      // don't serve possibly-wrong data; let CRM keep its own last copy.
      return json({ error: "procore_unavailable", detail: e.message }, 502);
    }
  }

  const rows = await sql`
    select procore_user_id, first_name, last_name, email, phone, title, is_active
    from directory_contacts_cache where vendor_id = ${vendorId}`;
  const [fresh] = await sql`select last_full_refresh_at from directory_contacts_scan_state where singleton = 1`;

  return json({
    vendor_id: vendorId,
    contacts: rows.map((r) => ({
      id: r.procore_user_id,
      first_name: r.first_name,
      last_name: r.last_name,
      email: r.email,
      phone: r.phone,
      title: r.title,
      is_active: r.is_active,
    })),
    fetched_at: fresh?.last_full_refresh_at || null,
    cached,
  });
}
