import { useCallback, useEffect, useState } from "react";
import { api } from "../api.js";
import GapResolution from "./GapResolution.jsx";
import { getShellContext } from "../shell.js";

// In the Procore side panel, the assignment / brief steps (assignment team's
// job, wide Recharts UI) open in the full view rather than trying to fit the
// panel. Elsewhere they're same-tab hash links.
const IN_SIDEBAR = getShellContext().sidebar;
const fullBase = `${window.location.origin}${window.location.pathname}`;
function stageLink(hash) {
  return IN_SIDEBAR ? { href: `${fullBase}${hash}`, target: "_blank", rel: "noreferrer" } : { href: hash };
}

// The Purgatory gate: every required task filled or deferred before HANDOFF will
// create anything in Procore. "No project yet" is the lock — there is nothing
// here that visibly blocks the estimator except the Submit button staying
// disabled, which is the point (kickoff doc: falsely claiming completion should
// cost the same effort as actually doing it — here, it simply can't be claimed
// without a real value or an honest deferral reason).
export default function PurgatoryGate({ projectId }) {
  const [project, setProject] = useState(null);
  const [tasks, setTasks] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [submitting, setSubmitting] = useState(false);
  const [submitResult, setSubmitResult] = useState(null);

  const load = useCallback(() => {
    setError(null);
    api
      .getGate(projectId)
      .then((data) => {
        setProject(data.project);
        setTasks(data.tasks);
      })
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  }, [projectId]);

  useEffect(() => {
    load();
  }, [load]);

  async function submit() {
    setSubmitting(true);
    setSubmitResult(null);
    setError(null);
    try {
      const result = await api.submitGate(projectId);
      setSubmitResult(result);
      load();
    } catch (e) {
      if (e.data?.error === "gate_incomplete") {
        setSubmitResult(e.data);
      } else {
        setError(e.message);
      }
    } finally {
      setSubmitting(false);
    }
  }

  if (loading) return <div className="empty-state">Loading…</div>;
  if (error && !project) return <div className="card" style={{ color: "var(--red)" }}>{error}</div>;
  if (!project) return null;

  // Mirror of checklist.js: post_creation items (tender emails) don't block the
  // submit that creates the project — they're done in Procore afterward.
  const POST_CREATION = new Set(["tender_correspondence"]);
  const blocking = tasks.filter((t) => t.required && !POST_CREATION.has(t.task_type));
  const done = blocking.filter((t) => ["complete", "deferred"].includes(t.status));
  const ready = done.length === blocking.length;
  const alreadyCreated = project.status !== "gate";
  const postTasks = tasks.filter(
    (t) => POST_CREATION.has(t.task_type) || ["deferred", "verify_failed"].includes(t.status)
  );

  return (
    <div>
      <div className="card">
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
          <div>
            <div className="card-title">Purgatory Gate</div>
            <h2 style={{ fontFamily: "'Oswald', sans-serif", fontSize: 22, textTransform: "uppercase" }}>{project.name}</h2>
            <div className="row-secondary">{project.project_number || "no project #"} · {project.project_type || "type unknown"}</div>
          </div>
          <span className={`badge badge-${project.status}`}>{project.status}</span>
        </div>
      </div>

      {alreadyCreated && (
        <div className="card" style={{ borderColor: "var(--green)" }}>
          This handoff has already been submitted — Procore project #{project.procore_project_id || "?"} was created.
          {project.status === "assigning" && (
            <div style={{ marginTop: 10 }}>
              <a className="btn btn-accent btn-sm" {...stageLink(`#/project/${project.id}/assignment`)}>
                Go to PM Assignment{IN_SIDEBAR ? " ↗" : ""}
              </a>
            </div>
          )}
          {["assigned", "complete"].includes(project.status) && (
            <div style={{ marginTop: 10 }}>
              <a className="btn btn-accent btn-sm" {...stageLink(`#/project/${project.id}/brief`)}>
                View Handoff Brief{IN_SIDEBAR ? " ↗" : ""}
              </a>
            </div>
          )}
        </div>
      )}

      {alreadyCreated && postTasks.length > 0 && (
        <div>
          <div className="card-title" style={{ marginTop: 12 }}>
            Still to do in Procore
          </div>
          <div className="checklist">
            {postTasks.map((task) => (
              <GapResolution key={task.id} task={task} projectId={projectId} project={project} onChanged={load} />
            ))}
          </div>
        </div>
      )}

      {!alreadyCreated && (
        <>
          <div className="checklist-progress">
            {done.length} of {blocking.length} items to resolve before submitting
          </div>
          {error && <div className="card" style={{ color: "var(--red)" }}>{error}</div>}
          {submitResult?.error === "gate_incomplete" && (
            <div className="card" style={{ color: "var(--yellow)" }}>
              Still needs: {submitResult.unresolved.map((u) => u.label).join(", ")}
            </div>
          )}
          {submitResult?.errors?.length > 0 && (
            <div className="card" style={{ color: "var(--yellow)" }}>
              <div className="card-title">Created, with some issues to review</div>
              <ul style={{ paddingLeft: 18 }}>
                {submitResult.errors.map((e, i) => (
                  <li key={i}>{e}</li>
                ))}
              </ul>
            </div>
          )}

          <div className="checklist">
            {tasks.map((task) => (
              <GapResolution key={task.id} task={task} projectId={projectId} project={project} onChanged={load} />
            ))}
          </div>

          <div style={{ marginTop: 16 }}>
            <button className="btn btn-accent" disabled={!ready || submitting} onClick={submit}>
              {submitting ? "Creating project…" : "Submit — Create Project"}
            </button>
          </div>
        </>
      )}
    </div>
  );
}
