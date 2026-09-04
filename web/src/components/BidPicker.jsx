import { useEffect, useState } from "react";
import { api } from "../api.js";

// Step 1 of the core flow: the estimator picks a won bid from the Awarded
// column. Nothing is created in Procore by this screen — opening a handoff just
// pulls the bid's data into HANDOFF's own database (bids.js openHandoff).
export default function BidPicker() {
  const [bids, setBids] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [opening, setOpening] = useState(null);

  useEffect(() => {
    api
      .listBids()
      .then((data) => setBids(data.bids || []))
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  }, []);

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
      <div className="card-title">Awarded Bids</div>
      {error && (
        <div className="card" style={{ color: "var(--red)" }}>
          {error}
        </div>
      )}
      {loading && <div className="empty-state">Loading Bid Board…</div>}
      {!loading && bids.length === 0 && <div className="empty-state">Nothing in the Awarded column right now.</div>}

      <div className="row-list">
        {bids.map((bid) => (
          <div key={bid.bid_id} className="row-item" style={{ gridTemplateColumns: "2fr 1fr 1fr 140px", cursor: "default" }}>
            <div>
              <div className="row-primary">{bid.name || "(unnamed bid)"}</div>
              <div className="row-secondary">{bid.project_number || "no bid #"}</div>
            </div>
            <div className="row-secondary">{bid.customer_name || "—"}</div>
            <div className="row-secondary">{[bid.city, bid.state_code].filter(Boolean).join(", ") || "—"}</div>
            <button className="btn btn-blue btn-sm" disabled={opening === bid.bid_id} onClick={() => open(bid)}>
              {bid.handoff_project_id ? "Resume" : opening === bid.bid_id ? "Opening…" : "Start Handoff"}
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}
