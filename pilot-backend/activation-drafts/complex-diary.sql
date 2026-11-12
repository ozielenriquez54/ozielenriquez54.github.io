-- Candidate, not installed. Requires 001/002 and complex-macros scope.
begin;
do $$ begin
  if not exists(select 1 from pg_proc p join pg_roles r on r.oid=p.proowner
    where p.oid='pilot_private.can_access_client(uuid,uuid)'::regprocedure
    and r.rolname=current_user and (r.rolsuper or r.rolbypassrls)) then
    raise exception 'CONTROLLED_OWNER_REQUIRED'; end if;
end $$;
create role pilot_diary_server nologin noinherit nosuperuser nobypassrls nocreatedb nocreaterole;
create table public.pilot_intake_days (
  gym_id uuid not null, client_id uuid not null, nutrition_date date not null,
  revision bigint not null check(revision between 1 and 9007199254740991), record jsonb not null,
  primary key(gym_id,client_id,nutrition_date),
  foreign key(gym_id,client_id) references public.clients(gym_id,id)
);
create table pilot_private.pilot_intake_history (
  gym_id uuid not null,client_id uuid not null,nutrition_date date not null,
  revision bigint not null,record jsonb not null,
  primary key(gym_id,client_id,nutrition_date,revision),
  foreign key(gym_id,client_id) references public.clients(gym_id,id)
);
create table pilot_private.pilot_intake_receipts (
  actor_id uuid not null references auth.users(id), operation_id text not null,
  command jsonb not null,result jsonb not null,primary key(actor_id,operation_id)
);
alter table public.pilot_intake_days enable row level security;
alter table public.pilot_intake_days force row level security;
alter table pilot_private.pilot_intake_history enable row level security;
alter table pilot_private.pilot_intake_history force row level security;
alter table pilot_private.pilot_intake_receipts enable row level security;
alter table pilot_private.pilot_intake_receipts force row level security;
create policy own_intake_read on public.pilot_intake_days for select to authenticated using (
  exists(select 1 from public.clients c join public.gym_memberships m
    on m.id=c.membership_id and m.gym_id=c.gym_id
    where c.id=pilot_intake_days.client_id and c.gym_id=pilot_intake_days.gym_id
    and m.user_id=auth.uid() and m.active and 'CLIENT'=any(m.roles))
);
-- Only the trusted backend role may supply an actor; browser roles cannot invoke
-- these functions. Backend verifies JWT through Auth before entering transaction.
create function pilot_private.diary_authorize(a uuid,g uuid,c uuid) returns void
language plpgsql security definer set search_path='' as $$
begin
  perform 1 from pilot_private.complex_macro_scope s where s.gym_id=g and s.client_id=c for share;
  if not found then raise exception 'PILOT_SCOPE_REQUIRED' using errcode='42501'; end if;
  perform 1 from public.clients cl join public.gym_memberships m on m.id=cl.membership_id and m.gym_id=cl.gym_id
    where cl.id=c and cl.gym_id=g and m.user_id=a and m.active and 'CLIENT'=any(m.roles) for share of m;
  if not found then raise exception 'OWN_CLIENT_REQUIRED' using errcode='42501'; end if;
end $$;
create function pilot_private.diary_state(a uuid,g uuid,c uuid,d date,op text) returns jsonb
language plpgsql security definer set search_path='' as $$
declare head jsonb; receipt jsonb;
begin
  perform pilot_private.diary_authorize(a,g,c);
  -- Actor lock covers same operation replay across days; day lock serializes revisions.
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(a::text,0));
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(g::text||c::text||d::text,1));
  select record into head from public.pilot_intake_days where gym_id=g and client_id=c and nutrition_date=d;
  select jsonb_build_object('command',command,'result',result) into receipt
    from pilot_private.pilot_intake_receipts where actor_id=a and operation_id=op;
  return jsonb_build_object('head',head,'receipt',receipt);
end $$;
create function pilot_private.diary_commit(a uuid,g uuid,c uuid,d date,cmd jsonb,rec jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare state jsonb; rev bigint; op text:=cmd->>'operationId';
begin
  if op is null or length(op) not between 1 and 200 then raise exception 'INVALID_OPERATION' using errcode='22023'; end if;
  state:=pilot_private.diary_state(a,g,c,d,op);
  if state->'receipt' <> 'null'::jsonb then
    if state->'receipt'->'command'<>cmd then raise exception 'OPERATION_REUSED' using errcode='23514'; end if;
    return state->'receipt'->'result';
  end if;
  rev:=coalesce((state->'head'->>'revision')::bigint,0);
  if (cmd->>'baseRevision')::bigint is distinct from rev then raise exception 'REVISION_CONFLICT' using errcode='40001'; end if;
  if (rec->>'actorId')::uuid is distinct from a or (rec->>'clientId')::uuid is distinct from c
    or (rec->>'nutritionDate')::date is distinct from d or rec->>'kind' is distinct from 'INTAKE_DAY'
    or (rec->>'revision')::bigint is distinct from rev+1
    or rec->>'previousRecordId' is distinct from state->'head'->>'recordId'
    or rec->>'recordId' is null or jsonb_typeof(rec->'entries') is distinct from 'array'
    or coalesce((rec->>'status') not in ('PARTIAL','COMPLETE'),true) then
    raise exception 'INVALID_RECORD_CONTEXT' using errcode='23514'; end if;
  insert into public.pilot_intake_days values(g,c,d,rev+1,rec)
    on conflict(gym_id,client_id,nutrition_date) do update set revision=excluded.revision,record=excluded.record;
  insert into pilot_private.pilot_intake_history values(g,c,d,rev+1,rec);
  insert into pilot_private.pilot_intake_receipts values(a,op,cmd,rec);
  return rec;
end $$;
-- Strip ALL default ACL recipients on new objects, including inherited app roles.
do $$ declare t text; x record; begin
  foreach t in array array['public.pilot_intake_days','pilot_private.pilot_intake_history','pilot_private.pilot_intake_receipts'] loop
    for x in select distinct a.grantee from pg_class c,lateral aclexplode(coalesce(c.relacl,acldefault('r',c.relowner))) a
      where c.oid=t::regclass and a.grantee<>c.relowner loop
      execute format('revoke all on table %s from %s',t,case when x.grantee=0 then 'PUBLIC' else quote_ident(pg_get_userbyid(x.grantee)) end);
    end loop;
  end loop;
  foreach t in array array['pilot_private.diary_authorize(uuid,uuid,uuid)',
    'pilot_private.diary_state(uuid,uuid,uuid,date,text)','pilot_private.diary_commit(uuid,uuid,uuid,date,jsonb,jsonb)'] loop
    for x in select distinct a.grantee from pg_proc p,lateral aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a
      where p.oid=t::regprocedure and a.grantee<>p.proowner loop
      execute format('revoke all on function %s from %s',t,case when x.grantee=0 then 'PUBLIC' else quote_ident(pg_get_userbyid(x.grantee)) end);
    end loop;
  end loop;
end $$;
grant select on public.pilot_intake_days to authenticated;
grant usage on schema pilot_private to pilot_diary_server;
grant execute on function pilot_private.diary_state(uuid,uuid,uuid,date,text),
 pilot_private.diary_commit(uuid,uuid,uuid,date,jsonb,jsonb) to pilot_diary_server;
commit;
