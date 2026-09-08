import { useEffect, useState } from "react";
import { api } from "../api.js";
import PurgatoryGate from "./PurgatoryGate.jsx";
import BidPicker from "./BidPicker.jsx";

// Compact shell for the Procore Side Panel. Assumes it's already past auth (App
// handles login / no-role). With a bid id in the URL it opens (or resumes) that
// bid's handoff and drops straight into the Purgatory gate; without one it shows
// the queue so the estimator can still pick.
const FULL_VIEW_URL = `${window.location.origin}${window.location.pathname}`;

export default function SidebarApp({ bidId, user, onLogout }) {
  const [projectId, setProjectId] = useState(null);
  const [phase, setPhase] = useState(bidId ? "opening" : "picker"); // opening | gate | picker | error
  const [error, setError] = useState(null);

  useEffect(() => {
    if (!bidId) return;
    api
      .openHandoff(bidId)
      .then(({ project_id }) => {
        setProjectId(project_id);
        setPhase("gate");
      })
      .catch((e) => {
        setError(
          e.status === 403
            ? "This bid needs an estimator to start its handoff."
            : e.data?.detail || e.message
        );
        setPhase("error");
      });
  }, [bidId]);

  return (
    <div className="sidebar-shell">
      <div className="sidebar-topbar">
        <span className="sidebar-wordmark">HANDOFF</span>
        <span className="sidebar-user">{user?.displayName || user?.username}</span>
        <a className="sidebar-link" href={FULL_VIEW_URL} target="_blank" rel="noreferrer">
          Full view ↗
        </a>
        <button className="btn btn-ghost btn-sm" onClick={onLogout}>
          Log out
        </button>
      </div>

      <div className="sidebar-body">
        {phase === "opening" && <div className="empty-state">Opening handoff…</div>}
        {phase === "error" && (
          <div className="card" style={{ color: "var(--red)" }}>
            {error}
          </div>
        )}
        {phase === "gate" && projectId && <PurgatoryGate projectId={projectId} />}
        {phase === "picker" && <BidPicker />}
      </div>
    </div>
  );
}
