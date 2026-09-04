import { useEffect, useState } from "react";
import { api } from "../api.js";

const ROLES = ["estimator", "assignment", "pm", "admin"];

function UsersTab() {
  const [users, setUsers] = useState([]);
  const [departments, setDepartments] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [form, setForm] = useState({ einbau_username: "", name: "", role: "estimator", procore_department_id: "" });
  const [saving, setSaving] = useState(false);

  function load() {
    setLoading(true);
    api
      .listUsers()
      .then((data) => setUsers(data.users || []))
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  }
  useEffect(load, []);
  useEffect(() => {
    api.listDepartments().then((data) => setDepartments(data.departments || []));
  }, []);

  async function save(e) {
    e.preventDefault();
    if (!form.einbau_username.trim() || !form.name.trim()) return;
    setSaving(true);
    setError(null);
    try {
      await api.upsertUser(form);
      setForm({ einbau_username: "", name: "", role: "estimator", procore_department_id: "" });
      load();
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  }

  async function deactivate(id) {
    await api.deactivateUser(id).catch((e) => setError(e.message));
    load();
  }

  return (
    <div>
      <div className="card">
        <div className="card-title">Add / Update a HANDOFF User</div>
        <form onSubmit={save} style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "flex-end" }}>
          <div className="field" style={{ minWidth: 160 }}>
            <label>Einbau ID username</label>
            <input value={form.einbau_username} onChange={(e) => setForm({ ...form, einbau_username: e.target.value })} />
          </div>
          <div className="field" style={{ minWidth: 160 }}>
            <label>Display name</label>
            <input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
          </div>
          <div className="field" style={{ minWidth: 140 }}>
            <label>Role</label>
            <select value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value, procore_department_id: "" })}>
              {ROLES.map((r) => (
                <option key={r} value={r}>
                  {r}
                </option>
              ))}
            </select>
          </div>
          {form.role === "pm" && (
            <div className="field" style={{ minWidth: 200 }}>
              <label>Procore Department</label>
              <select value={form.procore_department_id} onChange={(e) => setForm({ ...form, procore_department_id: e.target.value })}>
                <option value="">— none yet —</option>
                {departments.map((d) => (
                  <option key={d.id} value={d.id}>
                    {d.name}
                  </option>
                ))}
              </select>
              <span className="field-help">This list mixes departed employees and non-person buckets — pick carefully.</span>
            </div>
          )}
          <button className="btn btn-blue" disabled={saving} type="submit">
            {saving ? "Saving…" : "Save"}
          </button>
        </form>
      </div>

      {error && <div className="card" style={{ color: "var(--red)" }}>{error}</div>}
      {loading && <div className="empty-state">Loading…</div>}

      <div className="row-list">
        {users.map((u) => (
          <div key={u.id} className="row-item" style={{ gridTemplateColumns: "1fr 1fr 1fr 100px 90px" }}>
            <div className="row-primary">{u.name}</div>
            <div className="row-secondary">{u.einbau_username}</div>
            <div className="row-secondary">{u.role === "pm" ? u.procore_department_name || "no Department mapped" : ""}</div>
            <div>
              <span className="badge badge-pending">{u.role}</span>
            </div>
            {u.active ? (
              <button className="btn btn-danger btn-sm" onClick={() => deactivate(u.id)}>
                Deactivate
              </button>
            ) : (
              <span className="row-secondary">inactive</span>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

function AffinityTab() {
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
            {roster.length === 0 && <span className="field-help">No pm-role users mapped to a Department yet — see Admin → Users.</span>}
          </div>
          <div className="field" style={{ width: 80 }}>
            <label>Weight</label>
            <input type="number" value={form.weight} onChange={(e) => setForm({ ...form, weight: e.target.value })} />
          </div>
          <div className="field" style={{ minWidth: 160 }}>
            <label>Note</label>
            <input value={form.note} onChange={(e) => setForm({ ...form, note: e.target.value })} />
          </div>
          <button className="btn btn-blue" disabled={saving} type="submit">
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

// The assignment team can manage the PM-affinity table but not HANDOFF user
// roles (admin-only, backend-enforced) — the Users tab just doesn't render for
// them rather than rendering into a 403.
export default function Admin({ actor }) {
  const isAdmin = actor?.role === "admin";
  const [tab, setTab] = useState(isAdmin ? "users" : "affinity");
  return (
    <div>
      <div className="tabs">
        {isAdmin && (
          <button className={`tab ${tab === "users" ? "active" : ""}`} onClick={() => setTab("users")}>
            Users
          </button>
        )}
        <button className={`tab ${tab === "affinity" ? "active" : ""}`} onClick={() => setTab("affinity")}>
          PM Affinity
        </button>
      </div>
      {tab === "users" && isAdmin ? <UsersTab /> : <AffinityTab />}
    </div>
  );
}
