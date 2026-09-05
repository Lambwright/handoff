import { getStoredToken, storeToken, clearToken } from "./auth.js";

const API_BASE = import.meta.env.DEV ? "/api" : import.meta.env.VITE_HANDOFF_API || "";

class UnauthorizedError extends Error {
  constructor(reason) {
    super(reason || "unauthorized");
    this.unauthorized = true;
  }
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
  listPmRoster: () => request("/pm-roster"),

  listBids: () => request("/bids"),
  refreshBids: () => request("/bids/refresh", { method: "POST", body: {} }),
  openHandoff: (bidId) => request("/handoffs", { method: "POST", body: { bid_id: bidId } }),

  listProjects: (status) => request(`/projects${status ? `?status=${encodeURIComponent(status)}` : ""}`),
  getGate: (projectId) => request(`/projects/${projectId}/gate`),
  patchGateTask: (taskId, fields) => request(`/gate-tasks/${taskId}`, { method: "PATCH", body: fields }),
  verifyGateTask: (taskId) => request(`/gate-tasks/${taskId}/verify`, { method: "POST", body: {} }),
  uploadPoDocument: (projectId, file) => uploadFile(`/projects/${projectId}/gate/po-document`, file),
  uploadTenderCorrespondence: (projectId, file) => uploadFile(`/projects/${projectId}/gate/tender-correspondence`, file),
  submitGate: (projectId) => request(`/projects/${projectId}/gate/submit`, { method: "POST", body: {} }),

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
