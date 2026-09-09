import { useCallback, useEffect, useState } from "react";
import { api } from "../api.js";
import GapResolution from "./GapResolution.jsx";

// The Procore project-level Full Screen tool. Given a Procore project id, shows
// the incoming PM everything HANDOFF holds for that project: the AI handoff
// brief, the PO / tender documents, the PM-assignment decision + reasoning, key
// info, and any gap still open (resolvable inline via the shared GapResolution
// component). Read-oriented; the estimator's gate work happens in the company
// tool.
const BRIEF_SECTIONS = [
  ["scope", "Scope of Work"],
  ["challenges", "Known Challenges / Open Items"],
  ["client_requirements", "Client Requirements"],
  ["billing_notes", "Billing / Invoicing Notes"],
  ["key_contacts", "Key Contacts"],
  ["key_dates", "Key Dates"],
];

export default function ProjectView({ procoreProjectId }) {
  const [handoffId, setHandoffId] = useState(null);
  const [data, setData] = useState(null);
  const [status, setStatus] = useState("loading"); // loading | none | ready | error
  const [error, setError] = useState(null);

  const loadSummary = useCallback((id) => {
    return api
      .getProjectSummary(id)
      .then((d) => {
        setData(d);
        setStatus("ready");
      })
      .catch((e) => {
        setError(e.message);
        setStatus("error");
      });
  }, []);

  useEffect(() => {
    api
      .getHandoffByProcoreId(procoreProjectId)
      .then(({ project }) => {
        setHandoffId(project.id);
        return loadSummary(project.id);
      })
      .catch((e) => {
        if (e.status === 404) setStatus("none");
        else {
          setError(e.message);
          setStatus("error");
        }
      });
  }, [procoreProjectId, loadSummary]);

  if (status === "loading") return <div className="empty-state">Loading…</div>;
  if (status === "error") return <div className="card" style={{ color: "var(--red)" }}>{error}</div>;
  if (status === "none") {
    return (
      <div className="card">
        <div className="card-title">Not a HANDOFF project</div>
        <p>This project wasn't created through HANDOFF, so there's no handoff brief or gate history for it here.</p>
      </div>
    );
  }

  const { project, brief, assignment, docs, gaps } = data;
  const content = brief?.content || {};

  return (
    <div>
      <div className="card">
        <div className="card-title">Project Handoff</div>
        <h2 style={{ fontFamily: "'Oswald', sans-serif", fontSize: 22, textTransform: "uppercase" }}>{project.name}</h2>
        <div className="row-secondary">
          {project.project_number || "no project #"} · {project.project_type || "type unset"} ·{" "}
          <span className={`badge badge-${project.status}`}>{project.status}</span>
        </div>
        <div className="kv-grid" style={{ marginTop: 12 }}>
          <div className="kv">
            <span className="kv-label">Customer</span>
            <span className="kv-value">{project.customer?.name || "—"}</span>
          </div>
          <div className="kv">
            <span className="kv-label">PO Number</span>
            <span className="kv-value mono">{project.po_number || "—"}</span>
          </div>
          <div className="kv">
            <span className="kv-label">Timeline</span>
            <span className="kv-value">
              {project.timeline?.start_date || "?"} → {project.timeline?.end_date || "?"}
            </span>
          </div>
          <div className="kv">
            <span className="kv-label">Assigned PM</span>
            <span className="kv-value">{assignment?.assigned_pm || "unassigned"}</span>
          </div>
          {project.inbound_email_address && (
            <div className="kv">
              <span className="kv-label">Project inbox (Emails tool)</span>
              <span className="kv-value mono">{project.inbound_email_address}</span>
            </div>
          )}
        </div>
      </div>

      {assignment && (
        <div className="card">
          <div className="card-title">PM Assignment</div>
          <p style={{ fontSize: 13 }}>
            <strong>{assignment.assigned_pm}</strong>
            {assignment.overridden ? " (assignment-team override)" : ""}
          </p>
          {assignment.recommendation_reasoning && (
            <p className="row-secondary" style={{ marginTop: 6 }}>
              {assignment.recommendation_reasoning}
            </p>
          )}
        </div>
      )}

      <div className="card">
        <div className="card-title">Handoff Brief</div>
        {!brief && <div className="row-secondary">No brief generated yet — a PM hasn't been confirmed.</div>}
        {brief &&
          BRIEF_SECTIONS.map(([key, label]) => (
            <div className="brief-section" key={key}>
              <div className="brief-section-title">{label}</div>
              <div className="brief-section-body">
                {typeof content[key] === "object" ? JSON.stringify(content[key]) : content[key] || "—"}
              </div>
            </div>
          ))}
      </div>

      <div className="card">
        <div className="card-title">Documents</div>
        {(!docs || docs.length === 0) && <div className="row-secondary">Nothing housed yet.</div>}
        {docs?.map((d) => (
          <div key={d.id} className="row-secondary" style={{ padding: "3px 0" }}>
            <strong>{d.doc_type.replace(/_/g, " ")}</strong> — {d.source_ref || "(no name)"}{" "}
            {d.pushed_at ? "· in Procore" : "· not pushed"}
          </div>
        ))}
      </div>

      {gaps?.length > 0 && (
        <div>
          <div className="card-title" style={{ marginTop: 12 }}>
            Open Gaps
          </div>
          <div className="checklist">
            {gaps.map((task) => (
              <GapResolution key={task.id} task={task} projectId={handoffId} project={project} onChanged={() => loadSummary(handoffId)} />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
