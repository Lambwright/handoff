// HANDOFF runs in two shells: the standalone webpage (hash-routed, full layout)
// and a compact "sidebar" for the Procore Side Panel embedded component. Procore
// renders the app in an iframe and passes context by interpolating variables
// into the URL (Configuration Builder → Parameter Interpolation), e.g.
//   https://lambwright.github.io/handoff/?sidebar=1&bid={estimate_id}
//
// This parses that context. It reads the query string first, then the hash
// (some hosts only get to append to the fragment), and accepts a few likely
// names for the bid identifier until we've confirmed which variable Procore
// actually exposes on the Estimating/Bid Board context.

function paramsFrom(str) {
  try {
    return new URLSearchParams(str.replace(/^[?#]/, "").replace(/^\/*/, ""));
  } catch {
    return new URLSearchParams();
  }
}

export function getSidebarContext() {
  const q = paramsFrom(window.location.search);
  const h = paramsFrom(window.location.hash.includes("?") ? window.location.hash.split("?")[1] : "");
  const get = (k) => q.get(k) || h.get(k);

  const sidebar =
    get("sidebar") === "1" ||
    get("mode") === "sidebar" ||
    window.location.hash.replace(/^#\/?/, "").startsWith("sidebar");

  const bidId = get("bid") || get("bid_id") || get("estimate_id") || get("proposal_id") || get("bid_board_project_id") || null;

  return { sidebar, bidId: bidId ? String(bidId) : null };
}
