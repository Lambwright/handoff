import { useState } from "react";
import { api } from "../api.js";

// ONE generic item component, reused on both sides of the process (kickoff
// doc): the estimator uses it to fill/defer every Purgatory gate task, and the
// same component renders a post-creation gap (a deferred item, or a
// verify_failed item) wherever it resurfaces — currently the gate screen itself
// and the brief's "known gaps" list.
//
// `input` types this knows how to render: text | textarea | address | customer |
// dates | file. Mirrors checklist.js's CHECKLIST_REGISTRY on the worker — if a
// new gate-task key is added there with a new input type, add it here too.
const TASK_INPUT_TYPES = {
  address: "address",
  customer: "customer",
  timeline: "dates",
  po_number: "text",
  po_document: "file",
  tender_correspondence: "file",
  scope_summary: "textarea",
  drawings: "file",
  estimates_reviewed: "text",
  site_contact: "text",
};

function ValueInput({ task, draft, setDraft }) {
  const input = TASK_INPUT_TYPES[task.task_type] || "text";

  if (input === "address") {
    const v = draft || task.value || {};
    const set = (k) => (e) => setDraft({ ...v, [k]: e.target.value });
    return (
      <div className="kv-grid">
        <div className="field">
          <label>Street</label>
          <input value={v.street || ""} onChange={set("street")} />
        </div>
        <div className="field">
          <label>City</label>
          <input value={v.city || ""} onChange={set("city")} />
        </div>
        <div className="field">
          <label>Province/State</label>
          <input value={v.state_code || ""} onChange={set("state_code")} />
        </div>
        <div className="field">
          <label>Postal Code</label>
          <input value={v.postal_code || ""} onChange={set("postal_code")} />
        </div>
      </div>
    );
  }

  if (input === "dates") {
    const v = draft || task.value || {};
    const set = (k) => (e) => setDraft({ ...v, [k]: e.target.value });
    return (
      <div className="kv-grid">
        <div className="field">
          <label>Start date</label>
          <input type="date" value={v.start_date || ""} onChange={set("start_date")} />
        </div>
        <div className="field">
          <label>End date</label>
          <input type="date" value={v.end_date || ""} onChange={set("end_date")} />
        </div>
      </div>
    );
  }

  if (input === "textarea") {
    return <textarea rows={3} value={draft ?? task.value ?? ""} onChange={(e) => setDraft(e.target.value)} />;
  }

  if (input === "text") {
    return <input value={draft ?? task.value?.po_number ?? task.value ?? ""} onChange={(e) => setDraft(e.target.value)} />;
  }

  return null; // file / customer have their own dedicated flows below
}

export default function GapResolution({ task, projectId, onChanged }) {
  const [draft, setDraft] = useState(null);
  const [deferReason, setDeferReason] = useState("");
  const [showDefer, setShowDefer] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [customerQuery, setCustomerQuery] = useState("");
  const [customerResults, setCustomerResults] = useState(null);

  const input = TASK_INPUT_TYPES[task.task_type] || "text";
  const locked = task.status === "complete";

  async function complete(value) {
    setBusy(true);
    setError(null);
    try {
      await api.patchGateTask(task.id, { value });
      onChanged();
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }

  async function saveDefer() {
    if (!deferReason.trim()) return;
    setBusy(true);
    setError(null);
    try {
      await api.patchGateTask(task.id, { defer: true, reason: deferReason });
      setShowDefer(false);
      onChanged();
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }

  async function uploadFile(e) {
    const file = e.target.files?.[0];
    if (!file) return;
    setBusy(true);
    setError(null);
    try {
      if (task.task_type === "po_document") await api.uploadPoDocument(projectId, file);
      else await api.uploadTenderCorrespondence(projectId, file);
      onChanged();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  async function runCustomerSearch() {
    if (customerQuery.trim().length < 2) return;
    const { candidates } = await api.searchCustomers(customerQuery);
    setCustomerResults(candidates);
  }

  async function retryVerify() {
    setBusy(true);
    setError(null);
    try {
      await api.verifyGateTask(task.id);
      onChanged();
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className={`checklist-item status-${task.status}`}>
      <div className="checklist-item-head">
        <span className="checklist-item-label">{task.label}</span>
        <span className={`badge badge-${task.status}`}>{task.status.replace("_", " ")}</span>
      </div>
      {task.help && <div className="checklist-item-help">{task.help}</div>}
      {task.status === "deferred" && <div className="gap-banner"><span className="gap-banner-title">Deferred</span>{task.deferred_reason}</div>}
      {task.status === "verify_failed" && (
        <div className="gap-banner">
          <span className="gap-banner-title">Didn't land in Procore</span>
          {task.verify_note}
          <div>
            <button className="btn btn-ghost btn-sm" onClick={retryVerify} disabled={busy} style={{ marginTop: 6 }}>
              Re-check
            </button>
          </div>
        </div>
      )}
      {error && <div className="login-error">{error}</div>}

      {!locked && input === "file" && (
        <div className="checklist-item-body">
          {task.value?.filename && <div className="row-secondary">Uploaded: {task.value.filename}</div>}
          <input type="file" onChange={uploadFile} disabled={busy} />
        </div>
      )}

      {!locked && input === "customer" && (
        <div className="checklist-item-body">
          {task.value?.suggestion?.confidence === "high" && task.value.suggestion.match && (
            <div className="row-secondary">
              Matched to <strong>{task.value.suggestion.match.name}</strong> ({Math.round(task.value.suggestion.match.score * 100)}% confident)
              <div className="checklist-item-actions">
                <button className="btn btn-blue btn-sm" disabled={busy} onClick={() => complete({ directory_id: task.value.suggestion.match.directory_id, name: task.value.suggestion.match.name })}>
                  Confirm match
                </button>
              </div>
            </div>
          )}
          {task.value?.suggestion?.candidates?.length > 0 && task.value.suggestion.confidence !== "high" && (
            <div>
              <div className="row-secondary">Possible matches:</div>
              {task.value.suggestion.candidates.map((c) => (
                <button key={c.directory_id} className="btn btn-ghost btn-sm" style={{ marginRight: 6, marginTop: 4 }} disabled={busy} onClick={() => complete({ directory_id: c.directory_id, name: c.name })}>
                  {c.name} ({Math.round(c.score * 100)}%)
                </button>
              ))}
            </div>
          )}
          <div className="checklist-item-actions" style={{ marginTop: 6 }}>
            <input placeholder="Search the Directory…" value={customerQuery} onChange={(e) => setCustomerQuery(e.target.value)} style={{ width: 220 }} />
            <button className="btn btn-ghost btn-sm" onClick={runCustomerSearch} disabled={busy}>
              Search
            </button>
            <button className="btn btn-ghost btn-sm" disabled={busy || !customerQuery.trim()} onClick={() => complete({ create: true, name: customerQuery.trim() })}>
              Create new: "{customerQuery.trim()}"
            </button>
          </div>
          {customerResults && (
            <div>
              {customerResults.length === 0 && <div className="row-secondary">No matches.</div>}
              {customerResults.map((c) => (
                <button key={c.directory_id} className="btn btn-ghost btn-sm" style={{ marginRight: 6, marginTop: 4 }} disabled={busy} onClick={() => complete({ directory_id: c.directory_id, name: c.name })}>
                  {c.name} ({Math.round(c.score * 100)}%)
                </button>
              ))}
            </div>
          )}
        </div>
      )}

      {!locked && input !== "file" && input !== "customer" && (
        <div className="checklist-item-body">
          <ValueInput task={task} draft={draft} setDraft={setDraft} />
          <div className="checklist-item-actions">
            <button className="btn btn-blue btn-sm" disabled={busy} onClick={() => complete(draft ?? task.value)}>
              {task.status === "pending" ? "Confirm" : "Save"}
            </button>
            {!showDefer && (
              <button className="btn btn-ghost btn-sm" disabled={busy} onClick={() => setShowDefer(true)}>
                Defer instead
              </button>
            )}
          </div>
          {showDefer && (
            <div className="checklist-item-actions">
              <input placeholder="Why not yet?" value={deferReason} onChange={(e) => setDeferReason(e.target.value)} style={{ flex: 1 }} />
              <button className="btn btn-ghost btn-sm" disabled={busy} onClick={saveDefer}>
                Save deferral
              </button>
            </div>
          )}
        </div>
      )}

      {!locked && (input === "file" || input === "customer") && !showDefer && (
        <div className="checklist-item-actions" style={{ marginTop: 6 }}>
          <button className="btn btn-ghost btn-sm" disabled={busy} onClick={() => setShowDefer(true)}>
            Defer instead
          </button>
        </div>
      )}
      {!locked && (input === "file" || input === "customer") && showDefer && (
        <div className="checklist-item-actions" style={{ marginTop: 6 }}>
          <input placeholder="Why not yet?" value={deferReason} onChange={(e) => setDeferReason(e.target.value)} style={{ flex: 1 }} />
          <button className="btn btn-ghost btn-sm" disabled={busy} onClick={saveDefer}>
            Save deferral
          </button>
        </div>
      )}

      {locked && (
        <div className="row-secondary">
          {input === "address" && task.value && [task.value.street, task.value.city, task.value.state_code, task.value.postal_code].filter(Boolean).join(", ")}
          {input === "dates" && task.value && `${task.value.start_date || "?"} → ${task.value.end_date || "?"}`}
          {input === "customer" && task.value && task.value.name}
          {input === "text" && (task.value?.po_number || task.value)}
          {input === "textarea" && task.value}
          {input === "file" && task.value?.filename}
        </div>
      )}
    </div>
  );
}
