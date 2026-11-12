-- LOCAL CANDIDATE ONLY. Apply AFTER complex-diary.sql; never loaded by Render.
begin;
do $$ begin
 if not exists(select 1 from pg_proc p join pg_roles r on r.oid=p.proowner
 where p.oid='pilot_private.diary_authorize(uuid,uuid,uuid)'::regprocedure
 and r.rolname=current_user and (r.rolsuper or r.rolbypassrls)) then raise exception 'CONTROLLED_OWNER_REQUIRED'; end if;
end $$;
create table pilot_private.tracking_history (
 gym_id uuid not null,client_id uuid not null,tracking_date date not null,
 kind text not null check(kind in ('WEIGHT_DAY','HABITS_DAY')),
 revision bigint not null check(revision between 1 and 9007199254740991),record jsonb not null,
 primary key(gym_id,client_id,tracking_date,kind,revision),
 foreign key(gym_id,client_id) references public.clients(gym_id,id)
);
create table pilot_private.tracking_receipts (
 actor_id uuid not null references auth.users(id),operation_id text not null,
 command jsonb not null,result jsonb not null,primary key(actor_id,operation_id)
);
alter table pilot_private.tracking_history enable row level security;
alter table pilot_private.tracking_history force row level security;
alter table pilot_private.tracking_receipts enable row level security;
alter table pilot_private.tracking_receipts force row level security;
create function pilot_private.tracking_state(a uuid,g uuid,c uuid,d date,k text,op text) returns jsonb
language plpgsql security definer set search_path='' as $$
declare head jsonb;receipt jsonb;
begin
 perform pilot_private.diary_authorize(a,g,c);
 if d is null or k is null or k not in ('WEIGHT_DAY','HABITS_DAY') then raise exception 'INVALID_TRACKING_KIND' using errcode='22023'; end if;
 perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(a::text,0));
 perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(g::text||c::text||d::text||k,1));
 select record into head from pilot_private.tracking_history where gym_id=g and client_id=c and tracking_date=d and kind=k order by revision desc limit 1;
 select jsonb_build_object('command',command,'result',result) into receipt from pilot_private.tracking_receipts where actor_id=a and operation_id=op;
 return jsonb_build_object('head',head,'receipt',receipt);
end $$;
create function pilot_private.tracking_commit(a uuid,g uuid,c uuid,d date,cmd jsonb,rec jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare s jsonb;rev bigint;k text:=cmd->>'kind';op text:=cmd->>'operationId';v jsonb;f text;
begin
 if op is null or length(op) not between 1 and 200 then raise exception 'INVALID_OPERATION' using errcode='22023'; end if;
 s:=pilot_private.tracking_state(a,g,c,d,k,op);
 if s->'receipt'<>'null'::jsonb then
  if s->'receipt'->'command'<>cmd then raise exception 'OPERATION_REUSED' using errcode='23514'; end if;
  return s->'receipt'->'result';
 end if;
 rev:=coalesce((s->'head'->>'revision')::bigint,0);
 if (cmd->>'baseRevision')::bigint is distinct from rev then raise exception 'REVISION_CONFLICT' using errcode='40001'; end if;
 if (cmd->>'gymId')::uuid is distinct from g or (cmd->>'clientId')::uuid is distinct from c
 or (cmd->>'nutritionDate')::date is distinct from d
 or (rec->>'actorId')::uuid is distinct from a or (rec->>'clientId')::uuid is distinct from c
 or (rec->>'nutritionDate')::date is distinct from d or rec->>'kind' is distinct from k
 or (rec->>'revision')::bigint is distinct from rev+1
 or rec->>'previousRecordId' is distinct from s->'head'->>'recordId'
 or coalesce(length(rec->>'recordId'),0)=0 then raise exception 'INVALID_RECORD_CONTEXT' using errcode='23514'; end if;
 if k='WEIGHT_DAY' then
  if jsonb_typeof(rec->'weightKg') is distinct from 'number' or not ((rec->>'weightKg')::numeric>0 and (rec->>'weightKg')::numeric<=9007199254740991) then raise exception 'INVALID_WEIGHT' using errcode='23514'; end if;
 else
  if jsonb_typeof(rec->'values') is distinct from 'object' or jsonb_typeof(rec->'completion') is distinct from 'object' then raise exception 'INVALID_HABITS' using errcode='23514'; end if;
  foreach f in array array['steps','sleepHours','sleepQuality','waterLiters','stress'] loop
   v:=rec->'values'->f;
   if v is null or (v<>'null'::jsonb and (jsonb_typeof(v)<>'number')) then raise exception 'INVALID_HABIT' using errcode='23514'; end if;
   if v<>'null'::jsonb then
    if v::text::numeric<0 or v::text::numeric>9007199254740991 then raise exception 'INVALID_HABIT' using errcode='23514'; end if;
    if f in ('steps','sleepQuality','stress') and trunc(v::text::numeric)<>v::text::numeric then raise exception 'INVALID_INTEGER' using errcode='23514'; end if;
    if f in ('sleepQuality','stress') and v::text::numeric not between 1 and 5 then raise exception 'INVALID_SCALE' using errcode='23514'; end if;
   end if;
  end loop;
  if rec->'values'->'training' is null or (rec->'values'->'training'<>'null'::jsonb and rec->'values'->>'training' not in ('STRENGTH','NO_STRENGTH')) then raise exception 'INVALID_TRAINING' using errcode='23514'; end if;
  for f,v in select * from jsonb_each(rec->'completion') loop
   if f not in ('steps','sleepHours','sleepQuality','waterLiters','stress','training') or jsonb_typeof(v) not in ('null','boolean') then raise exception 'INVALID_COMPLETION' using errcode='23514'; end if;
  end loop;
 end if;
 insert into pilot_private.tracking_history values(g,c,d,k,rev+1,rec);
 insert into pilot_private.tracking_receipts values(a,op,cmd,rec);
 return rec;
end $$;
-- Scope and active relationship are checked on EVERY read; no OWNER bypass.
create function pilot_private.tracking_read_authorize(a uuid,g uuid,c uuid) returns void
language plpgsql security definer set search_path='' as $$
declare owner_id uuid;
begin
 perform 1 from pilot_private.complex_macro_scope where gym_id=g and client_id=c for share;
 if not found then raise exception 'PILOT_SCOPE_REQUIRED' using errcode='42501'; end if;
 select m.user_id into owner_id from public.clients cl join public.gym_memberships m on m.id=cl.membership_id and m.gym_id=cl.gym_id
 where cl.id=c and cl.gym_id=g and m.active and 'CLIENT'=any(m.roles) for share of m;
 if owner_id is null then raise exception 'ACTIVE_CLIENT_REQUIRED' using errcode='42501'; end if;
 if owner_id=a then return; end if;
 perform 1 from public.coach_clients cc join public.gym_memberships m on m.id=cc.coach_membership_id and m.gym_id=cc.gym_id
 join pilot_private.complex_macro_scope s on s.gym_id=cc.gym_id and s.client_id=cc.client_id and s.coach_user_id=m.user_id
 where cc.gym_id=g and cc.client_id=c and cc.active and m.active and m.user_id=a and 'COACH'=any(m.roles) for share of cc,m,s;
 if not found then raise exception 'ASSIGNED_COACH_REQUIRED' using errcode='42501'; end if;
end $$;
create function pilot_private.tracking_history_read(a uuid,g uuid,c uuid,lo date,hi date) returns jsonb
language plpgsql security definer set search_path='' as $$
declare result jsonb;
begin
 perform pilot_private.tracking_read_authorize(a,g,c);
 if lo is null or hi is null or hi<lo or hi-lo>30 then raise exception 'INVALID_DATE_RANGE' using errcode='22023'; end if;
 select coalesce(jsonb_agg(record order by tracking_date,kind,revision),'[]'::jsonb) into result from (
  select nutrition_date tracking_date,'INTAKE_DAY' kind,revision,record from pilot_private.pilot_intake_history where gym_id=g and client_id=c and nutrition_date between lo and hi
  union all select tracking_date,kind,revision,record from pilot_private.tracking_history where gym_id=g and client_id=c and tracking_date between lo and hi
 ) records;
 return result;
end $$;
-- Remove inherited/default grants, including PUBLIC and service_role.
do $$ declare t text;x record;begin
 foreach t in array array['pilot_private.tracking_history','pilot_private.tracking_receipts'] loop
  for x in select distinct a.grantee from pg_class c,lateral aclexplode(coalesce(c.relacl,acldefault('r',c.relowner))) a where c.oid=t::regclass and a.grantee<>c.relowner loop
   execute format('revoke all on table %s from %s',t,case when x.grantee=0 then 'PUBLIC' else quote_ident(pg_get_userbyid(x.grantee)) end);
  end loop;
 end loop;
 foreach t in array array['pilot_private.tracking_state(uuid,uuid,uuid,date,text,text)','pilot_private.tracking_commit(uuid,uuid,uuid,date,jsonb,jsonb)','pilot_private.tracking_read_authorize(uuid,uuid,uuid)','pilot_private.tracking_history_read(uuid,uuid,uuid,date,date)'] loop
  for x in select distinct a.grantee from pg_proc p,lateral aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a where p.oid=t::regprocedure and a.grantee<>p.proowner loop
   execute format('revoke all on function %s from %s',t,case when x.grantee=0 then 'PUBLIC' else quote_ident(pg_get_userbyid(x.grantee)) end);
  end loop;
 end loop;
end $$;
grant execute on function pilot_private.tracking_state(uuid,uuid,uuid,date,text,text),pilot_private.tracking_commit(uuid,uuid,uuid,date,jsonb,jsonb),pilot_private.tracking_history_read(uuid,uuid,uuid,date,date) to pilot_diary_server;
commit;
