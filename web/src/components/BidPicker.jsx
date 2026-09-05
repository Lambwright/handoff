import { useEffect, useState } from "react";
import { api } from "../api.js";

function timeAgo(iso) {
  if (!iso) return "never";
  const mins = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.round(hrs / 24)}d ago`;
}

// Step 1 of the core flow: the estimator picks an Awarded bid. The list is
// served from HANDOFF's `bid_cache` (the Bid Board API can't be filtered and
// has ~4,200 records, so a background scan keeps the cache warm — 6h cron plus
// this screen's Refresh button). Opening a handoff pulls the bid's data into
// HANDOFF's own DB; nothing is created in Procore here.
export default function BidPicker() {
  const [bids, setBids] = useState([]);
  const [refreshedAt, setRefreshedAt] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [opening, setOpening] = useState(null);
  const [refreshing, setRefreshing] = useState(false);

  function load() {
    return api
      .listBids()
      .then((data) => {
        setBids(data.bids || []);
        setRefreshedAt(data.cache_refreshed_at || null);
      })
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  }

  useEffect(() => {
    load();
  }, []);

  async function refresh() {
    setRefreshing(true);
    setError(null);
    try {
      await api.refreshBids();
      // The scan runs in the background (~30s). Poll the list a few times.
      for (let i = 0; i < 8; i++) {
        await new Promise((r) => setTimeout(r, 6000));
        await load();
      }
    } catch (e) {
      setError(e.message);
    } finally {
      setRefreshing(false);
    }
  }

  async function open(bid) {
    setOpening(bid.bid_id);
    setError(null);
    try {
      if (bid.handoff_project_id) {
        window.location.hash = `#/project/${bid.handoff_project_id}/gate`;
        return;
      }
      const { project_id } = await api.openHandoff(bid.bid_id);
      window.location.hash = `#/project/${project_id}/gate`;
    } catch (e) {
      setError(e.message);
    } finally {
      setOpening(null);
    }
  }

  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 12 }}>
        <div className="card-title" style={{ margin: 0 }}>
          Awarded Bids — ready to hand off
        </div>
        <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
          <span className="row-secondary">synced {timeAgo(refreshedAt)}</span>
          <button className="btn btn-ghost btn-sm" onClick={refresh} disabled={refreshing}>
            {refreshing ? "Scanning Bid Board…" : "Refresh"}
          </button>
        </div>
      </div>

      {error && (
        <div className="card" style={{ color: "var(--red)" }}>
          {error}
        </div>
      )}
      {loading && <div className="empty-state">Loading…</div>}
      {!loading && bids.length === 0 && (
        <div className="empty-state">
          Nothing waiting — every Awarded bid has a handoff, or the cache is stale. Hit Refresh to rescan the Bid Board.
        </div>
      )}

      <div className="row-list">
        {bids.map((bid) => (
          <div key={bid.bid_id} className="row-item" style={{ gridTemplateColumns: "2fr 1fr 1fr 120px 140px", cursor: "default" }}>
            <div>
              <div className="row-primary">{bid.name || "(unnamed bid)"}</div>
              <div className="row-secondary">{bid.project_number || "no bid #"}</div>
            </div>
            <div className="row-secondary">{bid.customer_name || "—"}</div>
            <div className="row-secondary">{[bid.city, bid.state_code].filter(Boolean).join(", ") || "—"}</div>
            <div className="row-amount">{bid.estimate_total != null ? `$${Math.round(bid.estimate_total).toLocaleString()}` : "—"}</div>
            <button className="btn btn-accent btn-sm" disabled={opening === bid.bid_id} onClick={() => open(bid)}>
              {bid.handoff_project_id ? "Resume" : opening === bid.bid_id ? "Opening…" : "Start Handoff"}
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}
