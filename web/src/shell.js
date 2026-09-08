// HANDOFF runs in three shells:
//   - standalone webpage  — full layout, own header + app-switcher (default)
//   - Procore Full Screen embedded tool  (?embed=1) — full layout, Procore
//     provides the chrome so HANDOFF's own app-switcher is suppressed. Company
//     level = estimator workflow; project level (?embed=1&project_id=N) = the
//     PM read view scoped to that Procore project.
//   - Procore Side Panel compact  (?sidebar=1&bid=N) — narrow panel, dormant
//     hook for a future browser-extension / Estimating surface.
//
// Procore interpolates context into the URL (Configuration Builder → Parameter
// Interpolation). We read the query string first, then the hash fragment.

function paramsFrom(str) {
  try {
    return new URLSearchParams(str.replace(/^[?#]/, "").replace(/^\/*/, ""));
  } catch {
    return new URLSearchParams();
  }
}

export function getShellContext() {
  const q = paramsFrom(window.location.search);
  const h = paramsFrom(window.location.hash.includes("?") ? window.location.hash.split("?")[1] : "");
  const get = (k) => q.get(k) || h.get(k);

  const sidebar =
    get("sidebar") === "1" ||
    get("mode") === "sidebar" ||
    window.location.hash.replace(/^#\/?/, "").startsWith("sidebar");
  const embed = get("embed") === "1" || get("mode") === "embed";

  // Procore's numeric project id (project-level embed). Named `project_id` in
  // Procore's context tokens.
  const procoreProjectId = get("project_id") || get("procore_project_id") || null;

  // The estimating bid_board_projects record id (sidebar / bid-contextual
  // launch). Exact Procore variable name TBD — accept the likely ones.
  const bidId = get("bid") || get("bid_id") || get("estimate_id") || get("proposal_id") || get("bid_board_project_id") || null;

  return {
    sidebar,
    embed,
    procoreProjectId: procoreProjectId ? String(procoreProjectId) : null,
    bidId: bidId ? String(bidId) : null,
  };
}
