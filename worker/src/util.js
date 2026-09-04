// Shared low-level helpers.

// This account's REAL per-invocation subrequest ceiling is well under Cloudflare's
// documented number — confirmed empirically on this plan (25 parallel failed, 8
// succeeded), and punch-worker's Stage Enforcer runs at exactly this size. Every
// fan-out in HANDOFF (PM workload aggregation, post-distribution verification,
// the reconciliation-free cron batch) goes through `batched` at this width.
export const BATCH_SIZE = 8;

// Run `fn` over every item, in sequential batches of `size`, each batch's calls
// in parallel. Returns results in input order. Rejections propagate — wrap `fn`
// if you want per-item error capture instead.
export async function batched(items, fn, size = BATCH_SIZE) {
  const out = [];
  for (let i = 0; i < items.length; i += size) {
    const slice = items.slice(i, i + size);
    const results = await Promise.all(slice.map((item, j) => fn(item, i + j)));
    out.push(...results);
  }
  return out;
}

// Embedded in any free-text HANDOFF writes into Procore (correspondence bodies,
// RP request notes) so a re-run can string-search for its own prior write instead
// of duplicating it. Procore documents retries + duplicate deliveries as expected.
export function handoffTag(projectId) {
  return `[HANDOFF:${projectId}]`;
}

export function nowIso() {
  return new Date().toISOString();
}
