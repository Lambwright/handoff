// HANDOFF's own Procore data-connection (client_credentials) — same shape as
// punch-worker / tally-worker, NOT routed through procore-worker. One more copy
// of the token plumbing, but HANDOFF stays independent of procore-worker's
// uptime, and the regional host below is the one PUNCH/TALLY proved for the
// document / forms / email_communications / RP surfaces HANDOFF needs.
//
// Secrets: PROCORE_CLIENT_ID, PROCORE_CLIENT_SECRET
// Vars:    PROCORE_COMPANY_ID, PROCORE_API_BASE (https://us02.procore.com)

// In-isolate cache — survives warm invocations, not cold starts. Worst case is a
// spare token fetch.
let cachedToken = null;
let tokenExpiresAt = 0;

export async function getProcoreToken(env, { force = false } = {}) {
  const now = Date.now();
  if (!force && cachedToken && now < tokenExpiresAt - 60000) return cachedToken;

  const body =
    `grant_type=client_credentials` +
    `&client_id=${encodeURIComponent(env.PROCORE_CLIENT_ID)}` +
    `&client_secret=${encodeURIComponent(env.PROCORE_CLIENT_SECRET)}`;

  const res = await fetch("https://login.procore.com/oauth/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  if (!res.ok) {
    throw new Error(`Procore token exchange failed: ${res.status} ${await res.text()}`);
  }
  const data = await res.json();
  cachedToken = data.access_token;
  tokenExpiresAt = now + data.expires_in * 1000;
  return cachedToken;
}

// One REST call. `path` is everything after the version segment, e.g.
// "/projects/123" or "/companies/562949953508586/project_stages". `query` is an
// optional object of query params. Retries once on 401 with a forced-fresh token.
//
// Returns { ok, status, data } and never throws on a non-2xx — callers decide
// what a failure means (a check-before-write can treat 404 as "not there yet").
export async function procoreFetch(env, path, { method = "GET", body, version = "v1.0", query } = {}) {
  let token = await getProcoreToken(env);

  let url = `${env.PROCORE_API_BASE}/rest/${version}${path}`;
  if (query && Object.keys(query).length) {
    const usp = new URLSearchParams();
    for (const [k, v] of Object.entries(query)) {
      if (v !== undefined && v !== null) usp.append(k, String(v));
    }
    url += (url.includes("?") ? "&" : "?") + usp.toString();
  }

  const doRequest = (t) =>
    fetch(url, {
      method,
      headers: {
        Authorization: `Bearer ${t}`,
        "Content-Type": "application/json",
        Accept: "application/json",
        "Procore-Company-Id": env.PROCORE_COMPANY_ID,
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });

  let res = await doRequest(token);
  if (res.status === 401) {
    token = await getProcoreToken(env, { force: true });
    res = await doRequest(token);
  }

  const text = await res.text();
  let data = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = { raw: text };
    }
  }
  return { ok: res.ok, status: res.status, data };
}

// Follows Procore's Link header pagination and returns the concatenated array.
// Used for full-directory / all-projects reads where server-side filtering can't
// be trusted (Procore's filters[created_at] is silently ignored on several
// endpoints — confirmed live).
export async function procoreFetchAll(env, path, { version = "v1.0", query = {}, perPage = 100, maxPages = 50 } = {}) {
  const all = [];
  for (let page = 1; page <= maxPages; page++) {
    const { ok, status, data } = await procoreFetch(env, path, {
      version,
      query: { ...query, page, per_page: perPage },
    });
    if (!ok) throw new Error(`Procore paginated GET ${path} failed on page ${page}: HTTP ${status}`);
    if (!Array.isArray(data) || data.length === 0) break;
    all.push(...data);
    if (data.length < perPage) break;
  }
  return all;
}
