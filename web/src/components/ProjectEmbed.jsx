import { useCallback, useEffect, useState } from "react";
import { api } from "../api.js";
import Loading from "./Loading.jsx";
import PurgatoryGate from "./PurgatoryGate.jsx";
import ProjectView from "./ProjectView.jsx";

// The Procore project-level Full Screen tool's entry point (Ben, 2026-11-05):
// a project can now exist before HANDOFF ever heard of it -- the estimator
// pushed it to Portfolio natively in Procore, no HANDOFF step involved. So the
// first thing this does is resolve (or lazily bind, server-side -- see
// getProjectByProcore in projects.js) the Procore project id Procore hands us
// in the URL to a HANDOFF project. Once resolved, it routes by status: 'gate'
// / 'assigning' means the checklist isn't done yet, so render the SAME
// PurgatoryGate used for the old pre-creation flow (create.js's
// ensureProjectCreated already no-ops when procore_project_id is set, so
// "Submit" there PATCHes the real fields onto the real project instead of
// creating a new one -- nothing else needed changing); 'assigned' / 'complete'
// means a PM is already on it, so show the read-oriented brief/summary view.
export default function ProjectEmbed({ procoreProjectId, actor }) {
  const [state, setState] = useState("loading"); // loading | not_linked | ready | error
  const [project, setProject] = useState(null);
  const [error, setError] = useState(null);
  const [bidIdInput, setBidIdInput] = useState("");
  const [linking, setLinking] = useState(false);
  const [linkError, setLinkError] = useState(null);

  const resolve = useCallback(() => {
    setState("loading");
    api
      .getHandoffByProcoreId(procoreProjectId)
      .then(({ project }) => {
        setProject(project);
        setState("ready");
      })
      .catch((e) => {
        if (e.status === 404 && e.data?.error === "not_linked") setState("not_linked");
        else {
          setError(e.message);
          setState("error");
        }
      });
  }, [procoreProjectId]);

  useEffect(() => {
    resolve();
  }, [resolve]);

  async function linkBid() {
    if (!bidIdInput.trim()) return;
    setLinking(true);
    setLinkError(null);
    try {
      await api.linkBid(procoreProjectId, bidIdInput.trim());
      resolve();
    } catch (e) {
      setLinkError(e.message);
    } finally {
      setLinking(false);
    }
  }

  if (state === "loading") return <Loading />;
  if (state === "error") return <div className="card" style={{ color: "var(--red)" }}>{error}</div>;

  if (state === "not_linked") {
    return (
      <div className="card">
        <div className="card-title">Linking this project to its bid…</div>
        <p className="row-secondary">
          This project was just pushed to Portfolio — HANDOFF hasn't caught up to it yet. This usually resolves on
          its own shortly; refresh in a minute, or link it now by pasting the bid/estimate number from the Bid
          Board.
        </p>
        <div className="checklist-item-actions" style={{ marginTop: 10 }}>
          <input placeholder="Bid / estimate number" value={bidIdInput} onChange={(e) => setBidIdInput(e.target.value)} style={{ flex: 1 }} />
          <button className="btn btn-accent btn-sm" disabled={linking} onClick={linkBid}>
            {linking ? "Linking…" : "Link"}
          </button>
        </div>
        {linkError && <div className="login-error" style={{ marginTop: 6 }}>{linkError}</div>}
      </div>
    );
  }

  if (["gate", "assigning"].includes(project.status)) {
    return <PurgatoryGate projectId={project.id} actor={actor} />;
  }
  return <ProjectView handoffId={project.id} actor={actor} />;
}
