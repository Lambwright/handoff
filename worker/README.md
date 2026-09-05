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

## Confirmed against the live Procore account

Via `punch-worker`'s verified writeback code, direct answers from Ben, and a
live probe run on 2026-09-05 (temporary `/admin/procore-probe` route against the
deployed Worker's own Procore OAuth):

- **Procore OAuth** works — HANDOFF's own `client_credentials` app authenticates
  and the app has broad company **read** access: `/projects`, `/vendors`
  (Directory), `/companies/{co}/project_stages`, `/companies/{co}/project_regions`
  all return 200.
- **Stage list** — the account's real stages are enumerated in
  `procore-shapes.js` `STAGES`. `"Course of Construction"` (id `3`,
  `default_stage`) is the account's main active construction stage and is what a
  new handed-off project is created into (`STAGES.TARGET_CREATE_STAGE`). The
  inactive set (`Cancelled` / `Completed and Invoiced` / `On Hold` / `Overhead`)
  all check out as real names.
- **Active vs. inactive**: `project.active === true` AND stage not in
  `STAGES.INACTIVE_STAGES`.
- **Project types**: only Contract and Service Call come through the estimate →
  project flow; HANDOFF doesn't distinguish between them.
- **Customer / PO number** — read straight off a live project:
  `custom_field_73165` (`{data_type:"vendor", value:{id,label}}`) and
  `custom_field_562949953929326` (`{data_type:"string"}`). Reads are nested
  under `project.custom_fields.custom_field_<id>.value`; writes are flat
  (`project.custom_field_<id> = <id|string>`).
- **PM assignment** — the project's **Department** field, `department_ids:[id]`
  on write, `project.departments: [{id, name}]` on read (e.g.
  `[{id:562949953498534, name:"Scot Carter-Nichols"}]`, matching
  `PROCORE_DEPARTMENTS`). **`departments` only appears on the single-project
  GET, not the list endpoint** — `assignment.js`'s `loadActiveProjects` hydrates
  it per-project. No live Procore endpoint for the Department option list, so
  `PROCORE_DEPARTMENTS` stays hardcoded (same as `punch-worker`). Step 7 above:
  the assignment roster is HANDOFF's own curated `users` table, not this raw list.
- **`total_value`** — top-level project field, a string (`"3840.0"`); `Number()`
  handles it. `project_stage.name`, `start_date`, `completion_date` all confirmed.
- **Address / dates** field names were already right.

## Still to confirm

Everything below is behind a `TODO(sandbox)` / `TODO(ben)` comment in
[`src/procore-shapes.js`](src/procore-shapes.js):

- **Bid Board — BLOCKED ON PERMISSION.** The path
  (`/rest/v2.0/companies/{co}/estimating/bid_board_projects`) is correct — it
  returns **403 "not authorized"**, not 404. The Procore app needs the
  **Estimating / Bidding** tool permission added (Developer Portal → app →
  Permissions, and/or the service account's company permission template). Once
  granted, re-probe to confirm the record shape + the "Awarded" signal
  (`BID_BOARD.isAwarded` / `toDraft`).
- The `POST /rest/v1.0/projects` create payload (no real create has been run
  yet — PATCH field names are confirmed, `type` on create is still a guess).
- The Project-Directory → Company-Directory cascade on a real write.
- The project-level **Estimating** tool's REST surface for cost/hours/margin —
  the guessed `/projects/{id}/estimating/summary` (v2.0) returned **404**;
  likely also behind the Estimating permission, re-probe once that's granted.
- The Resource Planning "request" endpoint + payload.

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
