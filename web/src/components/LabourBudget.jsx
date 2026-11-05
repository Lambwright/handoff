import { useEffect, useState } from "react";
import { api } from "../api.js";
import Loading from "./Loading.jsx";
import { busyText } from "../festive.js";
import { buildLabourBudgetPdf } from "../labourBudgetPdf.js";

// The Labour Budget: pc/admin only, reachable once the Build the Procore
// Budget gate task is confirmed. Shows which estimate HANDOFF resolved as
// primary before generating anything (Ben, 2026-11-05 — "would you like to
// build a labor budget based on such and such an estimate?") so a wrong
// primary flag in Procore gets caught before a PDF goes out, not after.
export default function LabourBudget({ projectId }) {
  const [data, setData] = useState(null);
  const [status, setStatus] = useState("loading"); // loading | ready | empty | error
  const [error, setError] = useState(null);
  const [generating, setGenerating] = useState(false);

  useEffect(() => {
    api
      .getLabourBudget(projectId)
      .then((d) => {
        setData(d);
        setStatus("ready");
      })
      .catch((e) => {
        if (e.data?.error === "budget_empty") setStatus("empty");
        else {
          setError(e.message);
          setStatus("error");
        }
      });
  }, [projectId]);

  async function generate() {
    setGenerating(true);
    try {
      const bytes = await buildLabourBudgetPdf(data);
      const blob = new Blob([bytes], { type: "application/pdf" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `Labour Budget - ${data.project.project_number || data.project.name}.pdf`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (e) {
      setError(e.message);
    } finally {
      setGenerating(false);
    }
  }

  if (status === "loading") return <Loading />;
  if (status === "error") return <div className="card" style={{ color: "var(--red)" }}>{error}</div>;
  if (status === "empty") {
    return (
      <div className="card">
        <div className="card-title">Nothing to build from yet</div>
        <p>No Budget line items on this project — export the estimate to Budget in Procore first (Estimating &gt; Export &gt; Budget Template), then come back.</p>
      </div>
    );
  }

  const totalItems = data.groups.reduce((n, g) => n + g.items.length, 0);

  return (
    <div>
      <div className="card">
        <div className="card-title">Labour Budget</div>
        <h2 style={{ fontFamily: "'Oswald', sans-serif", fontSize: 22, textTransform: "uppercase" }}>{data.project.name}</h2>
        <div className="row-secondary">
          {data.project.project_number || "no project #"} · {data.project.customer || "customer unset"} · PO {data.project.po_number || "unset"}
        </div>

        <div style={{ marginTop: 14 }}>
          {data.proposal ? (
            <div className="gap-banner">
              <span className="gap-banner-title">Based on this estimate</span>
              {data.proposal.name}
              {data.proposal.quote_nr ? ` (quote ${data.proposal.quote_nr})` : ""}
            </div>
          ) : (
            <div className="gap-banner" style={{ borderColor: "var(--yellow)" }}>
              <span className="gap-banner-title">No primary estimate resolved</span>
              Couldn't find a primary proposal on the source bid — the PDF will still build from the live Budget, but
              double-check the right estimate is marked primary in Procore.
            </div>
          )}
          <div className="field-help" style={{ marginTop: 6 }}>
            If this isn't the right estimate, go mark the correct proposal primary in Procore's Estimating tool first,
            then come back here.
          </div>
        </div>

        <div className="row-secondary" style={{ marginTop: 10 }}>
          {data.groups.length} group{data.groups.length === 1 ? "" : "s"} · {totalItems} line item{totalItems === 1 ? "" : "s"}
        </div>

        <div style={{ marginTop: 14 }}>
          <button className="btn btn-accent" disabled={generating} onClick={generate}>
            {generating ? busyText("Generating…") : "Generate PDF"}
          </button>
        </div>
        {error && <div className="login-error" style={{ marginTop: 8 }}>{error}</div>}
      </div>
    </div>
  );
}
