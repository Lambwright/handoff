alter table bid_cache add column if not exists project_id text;
create index if not exists idx_bid_cache_project_id on bid_cache (project_id) where project_id is not null;
