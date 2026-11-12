-- PILOT ONLY. No remote deployment configuration. Never run against legacy.
begin;
do $$
begin
  if to_regclass('public.plan_meta') is not null
     or to_regclass('public.daily_logs') is not null
     or to_regclass('public.profiles') is not null then
    raise exception 'PILOT_REQUIRES_NEW_DATABASE';
  end if;
end;
$$;
-- Browser roles cannot create arbitrary exposed functions.
revoke create on schema public from public, anon, authenticated;
create schema pilot_private;
revoke all on schema pilot_private from public, anon, authenticated;
grant usage on schema pilot_private to authenticated;
create type public.pilot_role as enum ('OWNER', 'ADMIN', 'COACH', 'CLIENT');
create function pilot_private.valid_roles(p_roles public.pilot_role[])
returns boolean language sql immutable set search_path = '' as $$
  select coalesce(cardinality(p_roles) > 0 and array_ndims(p_roles) = 1
    and array_position(p_roles, null) is null
    and cardinality(p_roles) = (select count(distinct r) from unnest(p_roles) r), false);
$$;
create table public.profiles (
  id uuid primary key references auth.users(id),
  created_by uuid not null references auth.users(id),
  created_at timestamptz not null, updated_at timestamptz not null,
  revision bigint not null check (revision > 0)
);
create table public.gyms (
  id uuid primary key default gen_random_uuid(),
  name text not null check (length(btrim(name)) between 1 and 160),
  created_by uuid not null references public.profiles(id),
  created_at timestamptz not null, updated_at timestamptz not null,
  revision bigint not null check (revision > 0)
);
create table public.gym_memberships (
  id uuid primary key default gen_random_uuid(),
  gym_id uuid not null references public.gyms(id),
  user_id uuid not null references public.profiles(id),
  roles public.pilot_role[] not null check (pilot_private.valid_roles(roles)),
  active boolean not null default true,
  created_by uuid not null references public.profiles(id),
  created_at timestamptz not null, updated_at timestamptz not null,
  revision bigint not null check (revision > 0),
  unique (gym_id, user_id), unique (gym_id, id)
);
create table public.clients (
  id uuid primary key default gen_random_uuid(),
  gym_id uuid not null references public.gyms(id),
  membership_id uuid not null,
  created_by uuid not null references public.profiles(id),
  created_at timestamptz not null, updated_at timestamptz not null,
  revision bigint not null check (revision > 0),
  foreign key (gym_id, membership_id) references public.gym_memberships(gym_id, id),
  unique (gym_id, membership_id), unique (gym_id, id)
);
create table public.coach_clients (
  id uuid primary key default gen_random_uuid(),
  gym_id uuid not null references public.gyms(id),
  coach_membership_id uuid not null, client_id uuid not null,
  active boolean not null default true,
  created_by uuid not null references public.profiles(id),
  created_at timestamptz not null, updated_at timestamptz not null,
  revision bigint not null check (revision > 0),
  foreign key (gym_id, coach_membership_id) references public.gym_memberships(gym_id, id),
  foreign key (gym_id, client_id) references public.clients(gym_id, id),
  unique (gym_id, coach_membership_id, client_id)
);
create index gym_memberships_user_idx on public.gym_memberships(user_id, gym_id);
create index coach_clients_client_idx on public.coach_clients(gym_id, client_id);
-- Internal authorization history; not a nutritional entity or public API.
create table pilot_private.identity_events (
  event_id bigint generated always as identity primary key,
  actor_id uuid not null references auth.users(id),
  gym_id uuid references public.gyms(id),
  entity_type text not null, entity_id uuid not null, entity_revision bigint not null,
  event_at timestamptz not null default clock_timestamp(),
  before_data jsonb, after_data jsonb not null,
  unique (entity_type, entity_id, entity_revision)
);
create function pilot_private.stamp_identity()
returns trigger language plpgsql set search_path = '' as $$
declare
  actor uuid := auth.uid();
  immutable_columns text[];
  column_name text;
begin
  if actor is null then raise exception 'AUTHENTICATION_REQUIRED' using errcode = '42501'; end if;
  if tg_op = 'INSERT' then
    new.created_by := actor; new.created_at := clock_timestamp(); new.revision := 1;
  else
    immutable_columns := case tg_table_name
      when 'gym_memberships' then array['id','gym_id','user_id']
      when 'clients' then array['id','gym_id','membership_id']
      when 'coach_clients' then array['id','gym_id','coach_membership_id','client_id']
      else array['id'] end;
    foreach column_name in array immutable_columns loop
      if (to_jsonb(new)->column_name) is distinct from (to_jsonb(old)->column_name) then
        raise exception 'IDENTITY_IMMUTABLE' using errcode = '23514';
      end if;
    end loop;
    new.created_by := old.created_by; new.created_at := old.created_at;
    new.revision := old.revision + 1;
  end if;
  new.updated_at := clock_timestamp();
  return new;
end;
$$;
create function pilot_private.audit_identity()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  insert into pilot_private.identity_events
    (actor_id, gym_id, entity_type, entity_id, entity_revision, before_data, after_data)
  values (auth.uid(), case when tg_table_name = 'gyms' then new.id
    else (to_jsonb(new)->>'gym_id')::uuid end, tg_table_name, new.id, new.revision,
    case when tg_op = 'UPDATE' then to_jsonb(old) else null end, to_jsonb(new));
  return new;
end;
$$;
do $$
declare table_name text;
begin
  foreach table_name in array array['profiles','gyms','gym_memberships','clients','coach_clients'] loop
    execute format('alter table public.%I enable row level security', table_name);
    execute format('alter table public.%I force row level security', table_name);
    execute format('revoke all on table public.%I from public, anon, authenticated', table_name);
    execute format('create trigger stamp_identity before insert or update on public.%I for each row execute function pilot_private.stamp_identity()', table_name);
    execute format('create trigger audit_identity after insert or update on public.%I for each row execute function pilot_private.audit_identity()', table_name);
  end loop;
end;
$$;
alter table pilot_private.identity_events enable row level security;
alter table pilot_private.identity_events force row level security;
revoke all on all tables in schema pilot_private from public, anon, authenticated;
revoke all on all sequences in schema pilot_private from public, anon, authenticated;
revoke all on all functions in schema pilot_private from public, anon, authenticated;
commit;
