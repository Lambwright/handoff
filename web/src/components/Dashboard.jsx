import { useEffect, useState } from "react";
import { api } from "../api.js";

const STATUSES = [
  { key: "", label: "All" },
  { key: "gate", label: "In the Gate" },
  { key: "assigning", label: "Needs PM" },
  { key: "assigned", label: "Assigned" },
  { key: "complete", label: "Complete" },
];

function targetHash(project) {
  if (project.status === "gate") return `#/project/${project.id}/gate`;
  if (project.status === "assigning") return `#/project/${project.id}/assignment`;
  return `#/project/${project.id}/brief`;
}

export default function Dashboard({ actor }) {
  const [status, setStatus] = useState("");
  const [projects, setProjects] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  useEffect(() => {
    setLoading(true);
    setError(null);
    api
      .listProjects(status)
      .then((data) => setProjects(data.projects || []))
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  }, [status]);

  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
        <div className="tabs" style={{ marginBottom: 0 }}>
          {STATUSES.map((s) => (
            <button key={s.key} className={`tab ${status === s.key ? "active" : ""}`} onClick={() => setStatus(s.key)}>
              {s.label}
            </button>
          ))}
        </div>
        {(actor?.role === "estimator" || actor?.role === "admin") && (
          <a className="btn btn-blue" href="#/bids">
            + Start a Handoff
          </a>
        )}
      </div>

      {error && (
        <div className="card" style={{ color: "var(--red)" }}>
          {error}
        </div>
      )}
      {loading && <div className="empty-state">Loading…</div>}
      {!loading && projects.length === 0 && <div className="empty-state">No handoffs here yet.</div>}

      <div className="row-list">
        {projects.map((p) => (
          <a key={p.id} className="row-item" href={targetHash(p)} style={{ textDecoration: "none", color: "inherit", gridTemplateColumns: "2fr 1fr 1fr 120px" }}>
            <div>
              <div className="row-primary">{p.name || "(unnamed project)"}</div>
              <div className="row-secondary">{p.project_number || "no project #"}</div>
            </div>
            <div className="row-secondary">{p.customer?.name || p.customer?.suggestion?.match?.name || "—"}</div>
            <div className="row-secondary">{p.created_by}</div>
            <div>
              <span className={`badge badge-${p.status}`}>{p.status}</span>
            </div>
          </a>
        ))}
      </div>
    </div>
  );
}
