import { neon } from "@neondatabase/serverless";

// A lazily-constructed HTTP-mode Neon client. `neon()` validates the connection
// string synchronously and throws on a bad/empty one, so constructing it eagerly
// at the top of every fetch() means one misconfigured secret takes down every
// route — including /health, which never touches the DB. Deferring construction
// to the first actual query keeps non-DB routes working and turns a bad
// DATABASE_URL into a clear per-route 500 instead of a blanket 1101.
//
// HANDOFF has no row-level-security policies (unlike PUNCH), so there's no
// per-request `set_config` to do here — authorization is enforced in the Worker
// via the `users` table (see auth.js).
export function sqlFor(env) {
  let client = null;
  const get = () => (client ??= neon(env.DATABASE_URL));
  return (...args) => get()(...args);
}
