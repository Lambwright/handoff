import { getStoredToken, storeToken, clearToken } from "./auth.js";

const API_BASE = import.meta.env.DEV ? "/api" : import.meta.env.VITE_HANDOFF_API || "";

class UnauthorizedError extends Error {
  constructor(reason) {
    super(reason || "unauthorized");
    this.unauthorized = true;
  }
}

// A dead session (force-logout, archived user, natural expiry) previously just
// surfaced a raw error wherever the failing call happened to be — nothing sent
// the app back to the login screen. Rather than add `.unauthorized` checks at
// every one of the ~25 call sites below (easy to miss on the next one), request()
// calls this single hook on every 401; App.jsx registers it once, pointed at the
// same handleLogout the Log out button uses.
let onUnauthorized = null;
export function setUnauthorizedHandler(fn) {
  onUnauthorized = fn;
}

async function request(path, { method = "GET", body, headers, formData } = {}) {
  const token = getStoredToken();
  const res = await fetch(`${API_BASE}${path}`, {
    method,
    headers: {
      ...(formData ? {} : { "Content-Type": "application/json" }),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...headers,
    },
    body: formData ? formData : body !== undefined ? JSON.stringify(body) : undefined,
  });

  const refreshed = res.headers.get("X-Refreshed-Token");
  if (refreshed) storeToken(refreshed);

  if (res.status === 401) {
    clearToken();
    const data = await res.json().catch(() => ({}));
    onUnauthorized?.();
    throw new UnauthorizedError(data.reason);
  }

  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.detail || data.error || `HTTP ${res.status}`);
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return data;
}

export const api = {
  me: () => request("/me"),

  listUsers: () => request("/admin/users"),
  upsertUser: (fields) => request("/admin/users", { method: "POST", body: fields }),
  deactivateUser: (id) => request(`/admin/users/${id}`, { method: "DELETE" }),
  listDepartments: () => request("/departments"),
  listRegions: () => request("/regions"),
  listTimezones: () => request("/timezones"),
  listPmRoster: () => request("/pm-roster"),

  listBids: () => request("/bids"),
  refreshBids: () => request("/bids/refresh", { method: "POST", body: {} }),
  openHandoff: (bidId) => request("/handoffs", { method: "POST", body: { bid_id: bidId } }),

  listProjects: (status) => request(`/projects${status ? `?status=${encodeURIComponent(status)}` : ""}`),
  getHandoffByProcoreId: (procoreId) => request(`/projects/by-procore/${encodeURIComponent(procoreId)}`),
  getProjectSummary: (projectId) => request(`/projects/${projectId}/summary`),
  getGate: (projectId) => request(`/projects/${projectId}/gate`),
  patchGateTask: (taskId, fields) => request(`/gate-tasks/${taskId}`, { method: "PATCH", body: fields }),
  verifyGateTask: (taskId) => request(`/gate-tasks/${taskId}/verify`, { method: "POST", body: {} }),
  uploadPoDocument: (projectId, file) => uploadFile(`/projects/${projectId}/gate/po-document`, file),
  uploadTenderCorrespondence: (projectId, file) => uploadFile(`/projects/${projectId}/gate/tender-correspondence`, file),
  submitGate: (projectId) => request(`/projects/${projectId}/gate/submit`, { method: "POST", body: {} }),
  draftScope: (projectId) => request(`/projects/${projectId}/scope-draft`, { method: "POST", body: {} }),

  searchCustomers: (q) => request(`/customer-search?q=${encodeURIComponent(q)}`),

  getAssignmentCandidates: (projectId) => request(`/assignment/${projectId}/candidates`),
  recommendAssignment: (projectId) => request(`/assignment/${projectId}/recommend`, { method: "POST", body: {} }),
  confirmAssignment: (projectId, fields) => request(`/assignment/${projectId}/confirm`, { method: "POST", body: fields }),

  getBrief: (projectId) => request(`/briefs/${projectId}`),
  listNotifications: (projectId) => request(`/projects/${projectId}/notifications`),

  listAffinity: () => request("/pm-affinity"),
  upsertAffinity: (fields) => request("/pm-affinity", { method: "POST", body: fields }),
};

function uploadFile(path, file) {
  const form = new FormData();
  form.append("file", file, file.name);
  return request(path, { method: "POST", formData: form });
}

export { UnauthorizedError };
