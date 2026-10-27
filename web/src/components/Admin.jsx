import { useEffect, useState } from "react";
import { api } from "../api.js";

function AffinityTab({ helmName }) {
  const [rows, setRows] = useState([]);
  const [roster, setRoster] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [form, setForm] = useState({ region: "", client: "", job_type: "", preferred_pm: "", weight: 1, note: "" });
  const [saving, setSaving] = useState(false);

  function load() {
    setLoading(true);
    api
      .listAffinity()
      .then((data) => setRows(data.affinity || []))
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  }
  useEffect(load, []);
  useEffect(() => {
    api.listPmRoster().then((data) => setRoster(data.roster || []));
  }, []);

  function pmName(id) {
    return roster.find((r) => r.id === id)?.name || id;
  }

  async function save(e) {
    e.preventDefault();
    if (!form.preferred_pm.trim()) return;
    setSaving(true);
    setError(null);
    try {
      await api.upsertAffinity({ ...form, weight: Number(form.weight) || 1 });
      setForm({ region: "", client: "", job_type: "", preferred_pm: "", weight: 1, note: "" });
      load();
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div>
      <div className="card">
        <div className="card-title">Add a PM Affinity Rule</div>
        <p className="row-secondary" style={{ marginBottom: 10 }}>
          Institutional preference — a PM who works especially well with a region, client, or job type. Leave a field blank to match any value for it.
        </p>
        <form onSubmit={save} style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "flex-end" }}>
          <div className="field" style={{ width: 110 }}>
            <label>Region</label>
            <input value={form.region} onChange={(e) => setForm({ ...form, region: e.target.value })} placeholder="e.g. ON" />
          </div>
          <div className="field" style={{ width: 160 }}>
            <label>Client</label>
            <input value={form.client} onChange={(e) => setForm({ ...form, client: e.target.value })} />
          </div>
          <div className="field" style={{ width: 140 }}>
            <label>Job type</label>
            <input value={form.job_type} onChange={(e) => setForm({ ...form, job_type: e.target.value })} placeholder="e.g. Contract" />
          </div>
          <div className="field" style={{ width: 180 }}>
            <label>Preferred PM</label>
            <select value={form.preferred_pm} onChange={(e) => setForm({ ...form, preferred_pm: e.target.value })}>
              <option value="">— pick a PM —</option>
              {roster.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.name}
                </option>
              ))}
            </select>
            {roster.length === 0 && (
              <span className="field-help">No PMs mapped to a Procore Department yet — see {helmName || "Settings"} → Departments.</span>
            )}
          </div>
          <div className="field" style={{ width: 80 }}>
            <label>Weight</label>
            <input type="number" value={form.weight} onChange={(e) => setForm({ ...form, weight: e.target.value })} />
          </div>
          <div className="field" style={{ minWidth: 160 }}>
            <label>Note</label>
            <input value={form.note} onChange={(e) => setForm({ ...form, note: e.target.value })} />
          </div>
          <button className="btn btn-accent" disabled={saving} type="submit">
            {saving ? "Saving…" : "Save"}
          </button>
        </form>
      </div>

      {error && <div className="card" style={{ color: "var(--red)" }}>{error}</div>}
      {loading && <div className="empty-state">Loading…</div>}

      <div className="row-list">
        {rows.map((r) => (
          <div key={r.id} className="row-item" style={{ gridTemplateColumns: "1fr 1fr 1fr 1fr 60px" }}>
            <div className="row-secondary">{r.region || "any region"}</div>
            <div className="row-secondary">{r.client || "any client"}</div>
            <div className="row-secondary">{r.job_type || "any type"}</div>
            <div className="row-primary">{pmName(r.preferred_pm)}</div>
            <div className="row-amount">{r.weight}</div>
          </div>
        ))}
      </div>
    </div>
  );
}

// HANDOFF role/user management lives in HELM now (the role matrix) — this
// page is just the PM-affinity table, which HELM has no equivalent for.
// Reached via Header's nav, already gated to admin (or, if ever granted
// again, assignment) there.
export default function Admin({ helmName }) {
  return <AffinityTab helmName={helmName} />;
}
