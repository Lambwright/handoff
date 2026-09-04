-- HANDOFF database schema — the Bid Board -> Portfolio handoff pipeline.
--
-- A handoff row exists in THIS database (status 'gate') from the moment an
-- estimator opens it against an Awarded bid. The Procore project is not created
-- until the Purgatory gate is complete; `projects.procore_project_id` stays NULL
-- until then. "No project yet" is the gate — there is no locked holding stage.
--
-- Re-running this file DROPS and recreates every table. Only run it against a
-- Neon project holding throwaway data.

create extension if not exists pgcrypto;
-- The project-scoped copilot chat is deferred, but the "Back of House SOW" corpus
-- is curated progressively from day one, so have pgvector available to embed it
-- into later without a migration.
create extension if not exists vector;

drop table if exists startup_tasks cascade;
drop table if exists notifications cascade;
drop table if exists back_of_house_docs cascade;
drop table if exists handoff_briefs cascade;
drop table if exists assignment_events cascade;
drop table if exists gate_tasks cascade;
drop table if exists pm_affinity cascade;
drop table if exists pm_workload_cache cascade;
drop table if exists projects cascade;
drop table if exists users cascade;

-- ---------------------------------------------------------------------------
-- users — HANDOFF-side authorization. auth-worker (Einbau ID) is the identity
-- provider and only knows admin|user, so HANDOFF owns its own richer roles and
-- ties every gate/assignment action to a real logged-in person.
-- ---------------------------------------------------------------------------
create table users (
  id uuid primary key default gen_random_uuid(),
  einbau_username text not null unique,   -- matches auth-worker user.username, lowercased
  name text not null,
  role text not null check (role in ('estimator','assignment','pm','admin')),
  active boolean not null default true,
  created_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- projects — one row per handoff. Created at 'gate' with procore_project_id NULL;
-- the create.js pipeline fills procore_project_id and advances status.
-- ---------------------------------------------------------------------------
create table projects (
  id uuid primary key default gen_random_uuid(),
  source_bid_id text not null unique,     -- Procore Bid Board project id the handoff came from
  procore_project_id bigint unique,       -- NULL until the gate clears and creation runs
  name text,
  project_number text,
  project_type text,                      -- one of the configured estimate->project types
  stage text,                             -- Procore stage name once created
  status text not null default 'gate'
    check (status in ('gate','creating','assigning','assigned','complete','cancelled')),
  bid_snapshot jsonb not null default '{}'::jsonb,   -- raw bid record pulled at open time
  address jsonb,                          -- {street, city, state_code, postal_code, country_code, ...}
  customer jsonb,                         -- {directory_id, name} | {create:true, name, ...}
  po_number text,
  timeline jsonb,                         -- {start_date, end_date} confirmed during the gate
  create_progress jsonb not null default '{}'::jsonb,  -- which create.js steps have succeeded
  created_by text not null,              -- einbau_username of the estimator who opened it
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  procore_created_at timestamptz
);
create index idx_projects_status on projects (status);
create index idx_projects_created_by on projects (created_by);

-- ---------------------------------------------------------------------------
-- gate_tasks — the Purgatory checklist, seeded from checklist.js per project
-- type. Every item ends either 'complete' or 'deferred' (with a reason) — never
-- silently dropped. Items with a `verify_backing` are self-report + live Procore
-- check (the pattern PUNCH proved for tender emails).
-- ---------------------------------------------------------------------------
create table gate_tasks (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references projects(id) on delete cascade,
  task_type text not null,               -- checklist.js key
  label text not null,
  required boolean not null default true,
  status text not null default 'pending'
    check (status in ('pending','complete','deferred','verifying','verify_failed')),
  value jsonb,                           -- captured value (shape depends on task_type)
  deferred_reason text,                  -- required whenever status = 'deferred'
  verify_backing text,                   -- 'email_communications' | 'documents' | null
  verify_note text,                      -- last verification detail (what was / wasn't found)
  gap_owner text,                        -- 'estimator' | 'pm' — who a deferred/failed item routes to
  resolved_by text,
  resolved_at timestamptz,
  verified_at timestamptz,
  created_at timestamptz not null default now(),
  unique (project_id, task_type)
);
create index idx_gate_tasks_project on gate_tasks (project_id);

-- ---------------------------------------------------------------------------
-- pm_workload_cache — refreshed by the 6h cron and on demand before an
-- assignment decision. Timeline overlap matters as much as raw count.
-- ---------------------------------------------------------------------------
create table pm_workload_cache (
  pm_id text primary key,                -- Procore user id (as text)
  pm_name text,
  snapshot_at timestamptz not null default now(),
  active_project_count integer not null default 0,
  total_value numeric not null default 0,
  timeline jsonb not null default '[]'::jsonb   -- [{project_id, start_date, end_date, value}]
);

-- ---------------------------------------------------------------------------
-- pm_affinity — admin-editable institutional knowledge that pure distance math
-- would miss. Replaces geographic scoring entirely (not a phase-2 add to it).
-- ---------------------------------------------------------------------------
create table pm_affinity (
  id uuid primary key default gen_random_uuid(),
  region text,
  client text,
  job_type text,
  preferred_pm text not null,            -- Procore user id
  weight numeric not null default 1,
  note text,
  updated_by text,
  updated_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- assignment_events — every recommendation + human decision, override or not.
-- ---------------------------------------------------------------------------
create table assignment_events (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references projects(id) on delete cascade,
  recommended_pm text,
  recommendation_reasoning text,
  candidates jsonb,                      -- the aggregated per-PM numbers shown at decision time
  assigned_pm text,
  overridden boolean not null default false,
  decided_by text,
  decided_at timestamptz,
  created_at timestamptz not null default now()
);
create index idx_assignment_events_project on assignment_events (project_id);

-- ---------------------------------------------------------------------------
-- handoff_briefs — the Claude-generated brief, persisted as a re-visitable
-- record. Email delivery is STUBBED this phase: emailed_at stays NULL and a
-- notifications row records the intended send.
-- ---------------------------------------------------------------------------
create table handoff_briefs (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references projects(id) on delete cascade,
  pm_id text,
  content jsonb not null,               -- structured brief
  gaps_flagged jsonb not null default '[]'::jsonb,
  generated_at timestamptz not null default now(),
  emailed_at timestamptz
);
create index idx_handoff_briefs_project on handoff_briefs (project_id);

-- ---------------------------------------------------------------------------
-- back_of_house_docs — the curated retrieval corpus for the future copilot.
-- Crucial documents + parsed takeoffs only, not every email ever generated.
-- ---------------------------------------------------------------------------
create table back_of_house_docs (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references projects(id) on delete cascade,
  doc_type text not null,               -- 'po_document' | 'tender_correspondence' | 'takeoff' | ...
  source_ref text,                      -- original filename / email subject / Procore ref
  r2_key text,                          -- key in the DOCS bucket when the bytes are held here
  content_type text,
  size_bytes bigint,
  notes text,
  pushed_at timestamptz,                -- set once create.js has pushed this doc into Procore
  curated_at timestamptz not null default now()
);
create index idx_boh_docs_project on back_of_house_docs (project_id);

-- ---------------------------------------------------------------------------
-- startup_tasks — extensible list of automated actions after a confirmed
-- handoff. First: a Procore Resource Planning request for the timeline.
-- ---------------------------------------------------------------------------
create table startup_tasks (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references projects(id) on delete cascade,
  task_type text not null,              -- 'resource_planning_request' | ...
  status text not null default 'pending'
    check (status in ('pending','running','complete','failed','skipped')),
  result jsonb,
  ran_at timestamptz,
  created_at timestamptz not null default now(),
  unique (project_id, task_type)
);
create index idx_startup_tasks_project on startup_tasks (project_id);

-- ---------------------------------------------------------------------------
-- notifications — the escalation ledger. Transport (Teams / email / manager) is
-- STUBBED this phase: rows are written, sent_at stays NULL. `source_bid_id` is
-- set for staleness nudges fired before a handoff row exists.
-- ---------------------------------------------------------------------------
create table notifications (
  id uuid primary key default gen_random_uuid(),
  project_id uuid references projects(id) on delete cascade,
  source_bid_id text,
  channel text not null,                -- 'teams' | 'email' | 'manager'
  escalation_level integer not null default 0,
  recipient text,
  subject text,
  body text,
  created_at timestamptz not null default now(),
  sent_at timestamptz
);
create index idx_notifications_project on notifications (project_id);
create index idx_notifications_bid on notifications (source_bid_id);
