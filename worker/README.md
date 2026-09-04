# handoff-worker

The Bid Board → Portfolio pipeline. HANDOFF is the only sanctioned path from a
won bid to a live Procore project: an estimator opens a handoff against an
Awarded bid, HANDOFF houses everything the Purgatory checklist collects in its
own database, and only once every item is complete-or-deferred does it create
the Procore project and distribute the housed data. See
[`../README.md`](../README.md) for the full architecture and the approved build
plan this was built from.

There is **no webhook and no reconciliation poll** — HANDOFF owns creation, so
there's nothing to detect.

## Local dev

```bash
npm install
npm test          # pure-logic unit tests: matching, checklist filtering, assignment aggregation, batched()
npm run dev        # wrangler dev — needs the secrets below and a real DATABASE_URL
```

`npm run dev` talks to real Neon / R2 / Procore / Anthropic — no local mock.
Point `DATABASE_URL` at a Neon **branch**, not production, while iterating.

## Deploy

1. **Neon** — create a dedicated `handoff` project (do NOT reuse PUNCH's — see
   the root README), apply the schema: `psql "$DATABASE_URL" -f schema.sql`.
   Re-running it **drops and recreates every table** — only run it against a
   project holding throwaway data.
2. **R2 bucket** (not public): `npx wrangler r2 bucket create handoff-docs`.
3. **Procore data-connection app** — HANDOFF has its own (client_credentials),
   not routed through `procore-worker` — see the root README's Procore-access
   decision.
4. Secrets (`npx wrangler secret put …`): `DATABASE_URL`, `ANTHROPIC_API_KEY`,
   `HANDOFF_SERVICE_KEY`, `PROCORE_CLIENT_ID`, `PROCORE_CLIENT_SECRET`.
5. `npx wrangler deploy`. **`wrangler.jsonc` already declares `[vars]`** — keep
   it that way. Deploying with no `[vars]` block is treated as authoritative by
   Cloudflare and silently wipes any plain vars set on the Worker in the
   dashboard (this actually happened to `procore-worker` and cost a multi-day
   credential-recovery scramble).
6. Give yourself the `admin` HANDOFF role once deployed and logged in — the
   first admin has to be inserted directly:
   ```sql
   insert into users (einbau_username, name, role) values ('ben', 'Ben Wright', 'admin');
   ```
7. **Map each real PM to their Procore Department** — Admin → Users, add a
   `pm`-role user per PM, and pick their entry from the Department dropdown
   (`GET /departments`). This is the actual PM-candidate roster the assignment
   engine uses; Procore's own Department list mixes departed employees and
   non-person buckets ("Project Management", "Back Log"), so nobody is a valid
   candidate until an admin has explicitly mapped them here.

## Confirmed against the live Procore account (2026-09-04)

Sourced from `punch-worker`'s `buildProcoreWriteback` / `buildProcoreChecklist`
(both verified against real writes on this account) plus direct answers from
Ben — no longer guesses:

- **Active vs. inactive stages**: `project.active === true` AND the stage isn't
  one of `Cancelled` / `Completed and Invoiced` / `On Hold` / `Overhead`
  (`STAGES.INACTIVE_STAGES` in `procore-shapes.js`). Still open: which specific
  stage a brand-new handed-off project should be created into
  (`STAGES.TARGET_CREATE_STAGE`).
- **Project types**: only Contract and Service Call come through the estimate
  → project flow (`checklist.js`'s `ESTIMATE_PROJECT_TYPES`); HANDOFF doesn't
  need to distinguish between them.
- **Customer** and **PO number** are custom fields on this account
  (`custom_field_73165` / `custom_field_562949953929326`), written as flat
  project properties, never nested under a `custom_fields` wrapper
  (`PROCORE_CUSTOM_FIELDS` in `procore-shapes.js`).
- **PM assignment** is the project's **Department** field
  (`department_ids: [id]`, read back as `project.departments[]`) — there is no
  separate "Project Manager" field on the project resource. The static option
  list (`PROCORE_DEPARTMENTS`) has no live Procore endpoint, so it's hardcoded,
  same as `punch-worker` does it. See step 7 above for why the roster used for
  assignment is HANDOFF's own `users` table, not this raw list.
- **Address** and **dates** field names were already right (matches
  `punch-worker`'s confirmed shape exactly).

## Still to confirm

Everything below lives behind a `TODO(sandbox)` or `TODO(ben)` comment in
[`src/procore-shapes.js`](src/procore-shapes.js) — confirming each is a
single-file change, nothing else in the worker hardcodes a Procore path or
field name:

- The Bid Board endpoint + which field/value means **Awarded**.
- The `POST /rest/v1.0/projects` payload that actually creates a Portfolio
  project, and which fields it accepts on create vs. only on a follow-up PATCH.
- Which specific stage new projects should be created into
  (`STAGES.TARGET_CREATE_STAGE`).
- The Project-Directory → Company-Directory cascade on a real write (one
  sandbox write should confirm this — INTAKE has already observed it
  empirically once).
- The project-level **Estimating** tool's REST surface for cost/hours/margin.
- The Resource Planning "request" endpoint + payload.
- The contract-value field name for PM-workload aggregation
  (`PROJECT.extractValue` — may be a custom field too, check
  `/custom_field_definitions` if `total_value` comes back empty).

## Notes

- **No separate Procore OAuth via `procore-worker`.** HANDOFF holds its own
  Procore `client_credentials` app (`src/procore.js`), the same shape as
  `punch-worker` / `tally-worker` — see the root README for why this was
  chosen over the kickoff doc's original "route through `procore-worker`"
  default.
- **Two layers of gap resolution.** Before creation, a deferred/incomplete gate
  task just blocks Submit. After creation, completing that same task (address,
  customer, PO number, timeline, a document) immediately re-pushes it to the
  now-existing Procore project (`create.js`'s `FIELD_PUSHERS` /
  `pushOneDocument`) rather than waiting for another full pipeline run — see
  `gate.js`.
- **Idempotency everywhere.** `POST /handoffs` no-ops on an existing
  `source_bid_id`; `POST /projects/:id/gate/submit` is safe to retry —
  `projects.create_progress` tracks which pipeline steps already landed, and a
  project already past `gate` just returns its current state.
- **Subrequest budget.** Every fan-out (PM workload aggregation, document
  push/verify, the cron's staleness sweep) goes through `util.js`'s `batched()`
  at width 8 — this account's real per-invocation subrequest ceiling, confirmed
  empirically elsewhere in the suite, well under the documented number.
- **Notification/email transport is stubbed.** `notify.js` only writes
  `notifications` rows (visible via `GET /projects/:id/notifications`); nothing
  is actually sent yet. Wiring a real transport (Power Automate HTTP flow vs.
  Procore's own email API — open decision) is a change to that one file.
- Every route except `/health` needs a real Einbau ID session verified against
  `auth-worker` through the `AUTH_WORKER` service binding (a plain
  worker→worker `fetch()` is blocked with Cloudflare error 1042).
  Authorization on top of that is HANDOFF's own `users` table — `auth-worker`
  only knows `admin`/`user`.
