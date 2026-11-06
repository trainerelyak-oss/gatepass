create table if not exists gp_records     (id text primary key, data jsonb not null, updated_at timestamptz not null default now());
create table if not exists gp_invites     (id text primary key, data jsonb not null, updated_at timestamptz not null default now());
create table if not exists gp_devices     (id text primary key, data jsonb not null, updated_at timestamptz not null default now());
create table if not exists gp_device_keys (id text primary key, data jsonb not null, updated_at timestamptz not null default now());
create table if not exists gp_reviews     (id text primary key, data jsonb not null, updated_at timestamptz not null default now());
create table if not exists gp_users       (id text primary key, data jsonb not null, updated_at timestamptz not null default now());
create table if not exists gp_watchlist   (id text primary key, data jsonb not null, updated_at timestamptz not null default now());
create table if not exists gp_meta        (id text primary key, data jsonb not null, updated_at timestamptz not null default now());
create table if not exists gp_photos      (id text primary key, content_type text not null, data text not null, updated_at timestamptz not null default now());

create index if not exists gp_records_type on gp_records ((data->>'type'), (data->>'createdAt'));

alter table gp_records     enable row level security;
alter table gp_invites     enable row level security;
alter table gp_devices     enable row level security;
alter table gp_device_keys enable row level security;
alter table gp_reviews     enable row level security;
alter table gp_users       enable row level security;
alter table gp_watchlist   enable row level security;
alter table gp_meta        enable row level security;
alter table gp_photos      enable row level security;

create or replace view gp_visit_log with (security_invoker = true) as
select
  data->>'createdAt'   as at,
  data->>'type'        as event,
  data->>'name'        as name,
  data->>'badge'       as badge,
  data->>'gate'        as gate,
  data->>'guardName'   as officer,
  (data->>'recordedOffline')::boolean as recorded_offline
from gp_records
where data->>'type' in ('checkin', 'checkout', 'denied')
order by data->>'createdAt' desc;
