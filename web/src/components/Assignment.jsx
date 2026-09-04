import { useEffect, useState } from "react";
import { BarChart, Bar, XAxis, YAxis, Tooltip, Legend, ResponsiveContainer, CartesianGrid } from "recharts";
import { api } from "../api.js";

// Workload/affinity comparison + a Claude recommendation, with the assignment
// team always able to accept or override — never a silent auto-assign (kickoff
// doc). Headcount-on-site and geographic-distance scoring are deliberately not
// built here; the affinity table (region/client/job_type -> preferred PM)
// replaces distance scoring entirely.
export default function Assignment({ projectId }) {
  const [project, setProject] = useState(null);
  const [candidates, setCandidates] = useState([]);
  const [recommendation, setRecommendation] = useState(null);
  const [selected, setSelected] = useState(null);
  const [loading, setLoading] = useState(true);
  const [recommending, setRecommending] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [confirmResult, setConfirmResult] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    api
      .getAssignmentCandidates(projectId)
      .then((data) => {
        setProject(data.project);
        setCandidates(data.candidates || []);
      })
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  }, [projectId]);

  async function getRecommendation() {
    setRecommending(true);
    setError(null);
    try {
      const { event, candidates: fresh } = await api.recommendAssignment(projectId);
      setRecommendation(event);
      setCandidates(fresh);
      setSelected(event.recommended_pm);
    } catch (e) {
      setError(e.message);
    } finally {
      setRecommending(false);
    }
  }

  async function confirm() {
    if (!selected) return;
    setConfirming(true);
    setError(null);
    try {
      const overridden = recommendation ? selected !== recommendation.recommended_pm : false;
      const result = await api.confirmAssignment(projectId, {
        assigned_pm: selected,
        reasoning: overridden ? "Manual override by the assignment team." : recommendation?.recommendation_reasoning || null,
      });
      setConfirmResult(result);
    } catch (e) {
      setError(e.message);
    } finally {
      setConfirming(false);
    }
  }

  if (loading) return <div className="empty-state">Loading…</div>;
  if (error && !project) return <div className="card" style={{ color: "var(--red)" }}>{error}</div>;
  if (!project) return null;

  if (confirmResult) {
    return (
      <div className="card" style={{ borderColor: "var(--green)" }}>
        <div className="card-title">PM Assigned</div>
        <p>{project.name} is now assigned to {selected}. The handoff brief has been generated.</p>
        <a className="btn btn-blue" href={`#/project/${project.id}/brief`} style={{ marginTop: 10 }}>
          View Handoff Brief
        </a>
      </div>
    );
  }

  const chartData = candidates.map((c) => ({
    name: c.pm_name || c.pm_id,
    "Active projects": c.active_project_count,
    "Contract value ($k)": Math.round(c.total_value / 1000),
    "Overlap days": c.overlap_days,
  }));

  return (
    <div>
      <div className="card">
        <div className="card-title">PM Assignment</div>
        <h2 style={{ fontFamily: "'Oswald', sans-serif", fontSize: 22, textTransform: "uppercase" }}>{project.name}</h2>
        <div className="row-secondary">
          {project.timeline?.start_date || "?"} → {project.timeline?.end_date || "?"} · {project.customer?.name || "customer unset"}
        </div>
      </div>

      {error && <div className="card" style={{ color: "var(--red)" }}>{error}</div>}

      {!recommendation && (
        <button className="btn btn-blue" disabled={recommending || candidates.length === 0} onClick={getRecommendation} style={{ marginBottom: 16 }}>
          {recommending ? "Thinking…" : "Get Recommendation"}
        </button>
      )}
      {recommendation && (
        <div className="card" style={{ borderColor: "var(--green)" }}>
          <div className="card-title">Claude's recommendation</div>
          <p>
            <strong>{candidates.find((c) => c.pm_id === recommendation.recommended_pm)?.pm_name || recommendation.recommended_pm}</strong>
          </p>
          <p style={{ marginTop: 6 }}>{recommendation.recommendation_reasoning}</p>
        </div>
      )}

      {candidates.length === 0 && <div className="empty-state">No candidate PMs found — check the PM directory / active project data.</div>}

      {candidates.length > 0 && (
        <div className="chart-card">
          <ResponsiveContainer width="100%" height={280}>
            <BarChart data={chartData}>
              <CartesianGrid strokeDasharray="3 3" stroke="var(--border-color)" />
              <XAxis dataKey="name" stroke="var(--text-secondary)" fontSize={11} />
              <YAxis stroke="var(--text-secondary)" fontSize={11} />
              <Tooltip contentStyle={{ background: "var(--bg-card)", border: "1px solid var(--border-color)", fontSize: 12 }} />
              <Legend wrapperStyle={{ fontSize: 11 }} />
              <Bar dataKey="Active projects" fill="var(--blue)" />
              <Bar dataKey="Contract value ($k)" fill="var(--green)" />
              <Bar dataKey="Overlap days" fill="var(--yellow)" />
            </BarChart>
          </ResponsiveContainer>
        </div>
      )}

      <div className="candidate-grid">
        {candidates.map((c) => (
          <div
            key={c.pm_id}
            className={`candidate-card ${selected === c.pm_id ? "selected" : ""} ${recommendation?.recommended_pm === c.pm_id ? "recommended" : ""}`}
            onClick={() => setSelected(c.pm_id)}
          >
            <div className="candidate-name">
              {c.pm_name || c.pm_id}
              {recommendation?.recommended_pm === c.pm_id && <span className="recommend-pill">Recommended</span>}
            </div>
            <div className="candidate-stat"><span>Active projects</span><span>{c.active_project_count}</span></div>
            <div className="candidate-stat"><span>Contract value</span><span>${c.total_value.toLocaleString()}</span></div>
            <div className="candidate-stat"><span>Timeline overlap</span><span>{c.overlap_days}d</span></div>
            <div className="candidate-stat"><span>Affinity</span><span>{c.affinity_weight}</span></div>
          </div>
        ))}
      </div>

      <button className="btn btn-blue" disabled={!selected || confirming} onClick={confirm} style={{ marginTop: 12 }}>
        {confirming ? "Confirming…" : selected ? `Assign to ${candidates.find((c) => c.pm_id === selected)?.pm_name || selected}` : "Pick a PM"}
      </button>
    </div>
  );
}
