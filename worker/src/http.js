// HTTP plumbing shared by every route.

export function corsHeaders() {
  return {
    // TODO: tighten to env.ALLOWED_ORIGIN once the frontend origin is live. The
    // rest of the suite still ships "*" here and gates on the bearer token, so
    // matching that for now.
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET,POST,PATCH,DELETE,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Handoff-Service-Key",
    "Access-Control-Expose-Headers": "X-Refreshed-Token",
  };
}

// `extra` may carry { refreshedToken } — surfaced as X-Refreshed-Token so the
// frontend's api.js can silently roll the session forward (TALLY pattern).
export function json(data, status = 200, extra = {}) {
  const headers = { "Content-Type": "application/json", ...corsHeaders() };
  if (extra.refreshedToken) headers["X-Refreshed-Token"] = extra.refreshedToken;
  return new Response(JSON.stringify(data), { status, headers });
}

export function preflight() {
  return new Response(null, { headers: corsHeaders() });
}

export async function parseBody(request) {
  try {
    return await request.json();
  } catch {
    return null;
  }
}

// Standard shape for an auth rejection coming out of auth.js.
export function authError(result) {
  return json({ error: "unauthorized", reason: result.reason }, result.status || 401);
}
