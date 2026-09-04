import { useCallback, useEffect, useState } from "react";
import { api } from "../api.js";
import GapResolution from "./GapResolution.jsx";

const SECTIONS = [
  ["scope", "Scope"],
  ["challenges", "Known Challenges"],
  ["client_requirements", "Client Requirements"],
  ["billing_notes", "Billing / Invoicing Notes"],
  ["key_contacts", "Key Contacts"],
  ["key_dates", "Key Dates"],
];

// The persisted, re-visitable handoff brief. Any gap still open at this point
// (deferred during the gate, or a post-creation verification that didn't land)
// routes to the incoming PM through the SAME GapResolution component the
// estimator used — one generic gap UI, not two parallel ones.
export default function HandoffBrief({ projectId }) {
  const [brief, setBrief] = useState(null);
  const [project, setProject] = useState(null);
  const [gapTasks, setGapTasks] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const load = useCallback(() => {
    setError(null);
    Promise.all([api.getBrief(projectId), api.getGate(projectId)])
      .then(([briefData, gateData]) => {
        setBrief(briefData.brief);
        setProject(gateData.project);
        setGapTasks(gateData.tasks.filter((t) => ["deferred", "verify_failed"].includes(t.status)));
      })
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  }, [projectId]);

  useEffect(() => {
    load();
  }, [load]);

  if (loading) return <div className="empty-state">Loading…</div>;
  if (error) return <div className="card" style={{ color: "var(--red)" }}>{error}</div>;
  if (!brief) return <div className="empty-state">No brief generated yet — this handoff hasn't had a PM confirmed.</div>;

  const content = brief.content || {};

  return (
    <div>
      <div className="card">
        <div className="card-title">Handoff Brief</div>
        <h2 style={{ fontFamily: "'Oswald', sans-serif", fontSize: 22, textTransform: "uppercase" }}>{project?.name}</h2>
        <div className="row-secondary">
          Generated {new Date(brief.generated_at).toLocaleString()} · PM: {brief.pm_id || "unassigned"}
        </div>
      </div>

      <div className="card">
        {SECTIONS.map(([key, label]) => (
          <div className="brief-section" key={key}>
            <div className="brief-section-title">{label}</div>
            <div className="brief-section-body">{typeof content[key] === "object" ? JSON.stringify(content[key]) : content[key] || "—"}</div>
          </div>
        ))}
      </div>

      {gapTasks.length > 0 && (
        <div>
          <div className="card-title" style={{ marginTop: 12 }}>
            Open Gaps
          </div>
          <div className="checklist">
            {gapTasks.map((task) => (
              <GapResolution key={task.id} task={task} projectId={project.id} onChanged={load} />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
