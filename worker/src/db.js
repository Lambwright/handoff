import { neon } from "@neondatabase/serverless";

// One HTTP-mode Neon client per request. HANDOFF has no row-level-security
// policies (unlike PUNCH), so there's no per-request `set_config` to do here —
// authorization is enforced in the Worker via the `users` table (see auth.js).
export function sqlFor(env) {
  return neon(env.DATABASE_URL);
}
