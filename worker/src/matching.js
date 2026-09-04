// Customer name-matching against the Procore Directory. Field-copy only — NO
// document parsing (Ben: address/customer are just fields, keep parsing to a
// minimum). Normalization ported from scout-intake/index.html's
// normalizeCompanyName; scoring is a token-set Jaccard ratio (dependency-free,
// good enough for "Acme Millwork Ltd." vs "ACME MILLWORK").
//
// /vendors holds EVERY company in the Directory (customers, subs, Einbau's own
// record) — there is no separate customers endpoint (confirmed in the addendum).

import { json } from "./http.js";
import { procoreFetchAll } from "./procore.js";
import { DIRECTORY } from "./procore-shapes.js";

export const HIGH_CONFIDENCE = 0.88; // auto-fill, still shown for a one-click confirm
export const LOW_CONFIDENCE = 0.55; // below this, don't even suggest it

// Strips one trailing legal-entity suffix (Inc/Ltd/LLC/Corp/Company/Co) before
// matching — without this, "Acme Millwork Ltd." parsed off a bid never matches a
// Directory record filed as plain "Acme Millwork".
export function normalizeCompanyName(name) {
  const stripped = String(name || "")
    .toUpperCase()
    .replace(/[,.]?\s*\b(INCORPORATED|INC|LIMITED|LTD|LLC|CORPORATION|CORP|COMPANY|CO)\.?\s*$/i, "")
    .replace(/[.,]+$/, "")
    .replace(/\s+/g, " ")
    .trim();
  return stripped.length >= 2 ? stripped : String(name || "").toUpperCase().trim();
}

function tokens(name) {
  return new Set(normalizeCompanyName(name).split(" ").filter(Boolean));
}

// Jaccard over word tokens, with a full-containment shortcut for cases like
// "ACME" vs "ACME MILLWORK" (one is a strict subset — treat that as a strong
// match rather than penalizing it for the size difference).
export function scoreMatch(a, b) {
  const ta = tokens(a);
  const tb = tokens(b);
  if (ta.size === 0 || tb.size === 0) return 0;
  const na = normalizeCompanyName(a);
  const nb = normalizeCompanyName(b);
  if (na === nb) return 1;

  let intersection = 0;
  for (const t of ta) if (tb.has(t)) intersection++;
  const union = ta.size + tb.size - intersection;
  const jaccard = union === 0 ? 0 : intersection / union;

  const smaller = ta.size <= tb.size ? ta : tb;
  const larger = ta.size <= tb.size ? tb : ta;
  let containedCount = 0;
  for (const t of smaller) if (larger.has(t)) containedCount++;
  const containment = smaller.size === 0 ? 0 : containedCount / smaller.size;

  return Math.max(jaccard, containment * 0.92); // full containment caps just under an exact match
}

// Ranks Directory vendors against `name`, best first.
export function rankMatches(name, vendors) {
  return vendors
    .map((v) => ({
      directory_id: v.id,
      name: v.name || v.company || v.companyname,
      score: scoreMatch(name, v.name || v.company || v.companyname || ""),
      is_active: v.is_active !== false,
    }))
    .filter((m) => m.name)
    .sort((a, b) => b.score - a.score);
}

// Live version — fetches the Directory and ranks. Returns a suggestion shape the
// frontend's customer gate-task input renders: a confident top match, a list of
// lower-confidence candidates, or neither (search / create only).
export async function suggestCustomerMatch(env, name) {
  const vendors = await procoreFetchAll(env, DIRECTORY.listVendorsPath(env.PROCORE_COMPANY_ID), {
    version: DIRECTORY.version,
  });
  const ranked = rankMatches(name, vendors).filter((m) => m.is_active);

  const top = ranked[0] || null;
  if (top && top.score >= HIGH_CONFIDENCE) {
    return { confidence: "high", match: top, candidates: ranked.slice(0, 5) };
  }
  const candidates = ranked.filter((m) => m.score >= LOW_CONFIDENCE).slice(0, 5);
  if (candidates.length) {
    return { confidence: "low", match: null, candidates };
  }
  return { confidence: "none", match: null, candidates: [] };
}

// On-demand manual search (the "search / create" path) — same normalize+score,
// just not gated behind a confidence threshold since a human is driving.
export async function searchDirectory(env, query) {
  const vendors = await procoreFetchAll(env, DIRECTORY.listVendorsPath(env.PROCORE_COMPANY_ID), {
    version: DIRECTORY.version,
  });
  return rankMatches(query, vendors)
    .filter((m) => m.is_active && m.score > 0)
    .slice(0, 20);
}

// GET /customer-search?q=... — the manual "search / create" path for the
// customer gate task, when the automatic suggestion isn't confident enough.
export async function searchCustomerDirectory({ url, env }) {
  const q = (url.searchParams.get("q") || "").trim();
  if (q.length < 2) return json({ candidates: [] });
  const candidates = await searchDirectory(env, q);
  return json({ candidates });
}
