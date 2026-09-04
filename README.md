# HANDOFF

Automates Einbau's estimate → live-project handoff. Today, when an estimate is
won, the admin setup that should follow (PO number, address, customer, PM
assignment, a real handoff to the incoming PM) happens inconsistently, and Ben
personally cleans up the mess. HANDOFF fixes this by being **the only
sanctioned path from the Bid Board to the Portfolio**, and by not letting the
Procore project exist until the handoff work is actually done:

1. An estimator picks a won bid (the Bid Board's **Awarded** column) in
   HANDOFF.
2. HANDOFF pulls that bid's data into its own database and walks the estimator
   through the full **Purgatory** checklist — every item either filled in or
   explicitly deferred with a reason. Nothing is silently dropped.
3. Only once the checklist is complete does HANDOFF **create the Procore
   project** and **distribute** the housed data (address, customer, PO number,
   PO document, tender correspondence, project type, dates), then verify each
   push actually landed.
4. A workload/affinity-aware **PM assignment** step runs — a Claude
   recommendation plus a Recharts comparison, with the assignment team always
   able to accept or override.
5. A Claude-generated **handoff brief** is persisted for the incoming PM.
6. An extensible list of **startup tasks** fires (first: a Procore Resource
   Planning request for the confirmed timeline).

There is **no holding/"Pending Setup" stage and no lock** — nothing can lock a
user's Procore session from outside, and with this model there's nothing to
lock: no project exists until the gate clears, which is a stronger gate than a
locked stage would be. There is **no webhook and no reconciliation poll** —
HANDOFF owns creation, so there's nothing to detect.

Full design context lives in the kickoff prompt this was built from and the
approved build plan; the load-bearing decisions, repeated here because they
shape every file in this repo:

- **Multi-user, not multi-tenant.** Every Einbau estimator / assignment-team
  member / PM / admin gets their own login and role, tied to every gate
  resolution and assignment decision. Selling this to other subcontractors is
  a future aspiration, not something this build isolates for.
- **Own Procore OAuth, not `procore-worker`.** HANDOFF holds its own Procore
  `client_credentials` app (like `punch-worker` / `tally-worker`), rather than
  routing through the shared `procore-worker` — chosen so HANDOFF isn't
  coupled to `procore-worker`'s uptime, and to reuse the regional
  `us02.procore.com` host PUNCH/TALLY already proved works for the document /
  forms / email / RP surfaces this needs.
- **Address and customer are field copies, not parsed documents.** Both come
  straight off the bid's structured fields (customer gets a Directory
  name-match on top); there is no document-parsing fallback for either.
- **Notification/email transport is stubbed for now.** Every notification
  (the escalation ledger, the brief "email") is persisted as a
  `notifications` row and shown in the UI; nothing is actually sent yet. See
  `worker/README.md`.

## Layout

```
worker/   handoff-worker — Cloudflare Worker: Bid Board read, the gate API,
          the create+distribute pipeline, PM assignment, brief generation,
          startup tasks, the notification ledger.
web/      React + Vite frontend (Einbau ID gated), GitHub Pages.
.github/  GitHub Pages deploy workflow for web/.
```

See [`worker/README.md`](worker/README.md) for the Worker's deploy steps and
the full list of Procore facts still to confirm against the sandbox (every one
is isolated behind a `TODO(sandbox)` marker in `worker/src/procore-shapes.js`,
so confirming each is a single-file change).

## Stack

- **Frontend**: React/Vite, hosted on GitHub Pages at
  `https://lambwright.github.io/handoff/`, matching SCOUT/PUNCH/TALLY's
  existing pattern. Recharts for the PM-assignment comparison view.
- **Auth**: Einbau ID (the shared session-token system already used by
  PUNCH/SCOUT/INTAKE/TALLY, backed by `auth-worker`). `auth-worker` only knows
  `admin`/`user`, so HANDOFF keeps its own richer role (estimator / assignment
  / pm / admin) in its own `users` table and resolves it per request.
- **Backend**: a single Cloudflare Worker (`handoff-worker`) — the Bid Board
  read, the gate API, the create+distribute pipeline, PM assignment, brief
  generation, startup tasks, and a 6h cron for cache refresh + staleness
  escalation (not a trigger — see above).
- **Database**: a dedicated Neon Postgres project (`handoff`) — **not** shared
  with PUNCH's. Neon's free tier gives each project its own independent
  compute/storage allowance, and PUNCH's project has already used a large
  share of its own quota. `pgvector` is enabled from day one even though the
  project-scoped copilot chat itself is deferred — the "Back of House SOW"
  curated document corpus is assembled progressively as HANDOFF processes each
  project, so there's a real corpus to embed later instead of reconstructing
  one retroactively.

## Explicitly deferred / not built here

- **Headcount-on-site PM scoring** — needs time-windowed Resource Planning
  data, not a day-one build.
- **Geographic-distance PM scoring** — replaced entirely by the admin-editable
  PM-affinity table (region/client/job-type → preferred PM + weight), not a
  phase-2 add to it.
- **Multi-tenant / customer-facing packaging** — this is an internal Einbau
  tool for now.
- **The project-scoped copilot chat** — the Back-of-House document corpus is
  being assembled now so it's ready, but retrieval/embedding itself is future
  work.
- **Automatic marked-up-drawing extraction** — explore later, not committed.
- **Real notification/email transport** — see `worker/README.md`.

## Verification

- `cd worker && npm test` — vitest pure-logic tests (customer-name matching,
  checklist filtering, workload/affinity aggregation, `batched()`).
- `cd worker && npx wrangler deploy --dry-run` — bundles the Worker without
  publishing, to catch import/syntax errors.
- `cd web && npm run build` — production frontend build.
- Local loop: `cd worker && npx wrangler dev` + `cd web && npm run dev` (Vite's
  dev proxy keeps the browser same-origin past `auth-worker`'s CORS lock).
- End-to-end, once the sandbox facts above are confirmed: pick an Awarded bid →
  open a handoff → fill the gate → submit → confirm the project landed in the
  right stage with address/customer/PO set and documents attached → get a PM
  recommendation → confirm → verify the brief persisted and a Resource
  Planning request was created.
