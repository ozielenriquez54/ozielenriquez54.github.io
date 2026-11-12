-- Initial READ-ONLY deployment. No application EXECUTE on the assignment RPC.
begin;

do $$
begin
  if not exists (
    select 1 from pg_roles r join pg_proc p on p.proowner=r.oid
    where r.rolname=current_user and (r.rolsuper or r.rolbypassrls)
      and p.oid='pilot_private.can_access_client(uuid,uuid)'::regprocedure
  ) then raise exception 'MANUAL_MIGRATION_REQUIRES_CONTROLLED_IDENTITY_OWNER'; end if;
  -- Reject application roles able to inherit or SET ROLE to the owner.
  -- Never repair memberships or grants on existing roles in this migration.
  if exists (
    select 1 from pg_roles r where r.rolname<>current_user
      and (not (r.rolsuper or r.rolbypassrls)
        or r.rolname in ('anon','authenticated','authenticator','service_role','pilot_clinical_gateway','pilot_treatment_server'))
      and pg_has_role(r.oid,current_user::regrole,'MEMBER')
  ) or current_user in ('anon','authenticated','authenticator','service_role','pilot_clinical_gateway','pilot_treatment_server') then
    raise exception 'MANUAL_OWNER_REACHABLE_BY_APPLICATION';
  end if;
end;
$$;

create table public.manual_macro_target_versions (
  gym_id uuid not null, client_id uuid not null, id uuid not null,
  revision bigint not null check (revision between 1 and 9007199254740991),
  previous_id uuid, previous_revision bigint,
  protein_g integer not null check (protein_g between 0 and 400),
  carbs_g integer not null check (carbs_g between 0 and 1000),
  fat_g integer not null check (fat_g between 0 and 300),
  kcal integer generated always as (4*protein_g+4*carbs_g+9*fat_g) stored check (kcal between 500 and 6000),
  assigned_by uuid not null references auth.users(id),
  effective_from timestamptz not null, recorded_at timestamptz not null,
  confirmations jsonb not null,
  primary key (gym_id,client_id,id),
  unique (gym_id,client_id,revision), unique (gym_id,client_id,id,revision),
  unique (gym_id,client_id,previous_id),
  foreign key (gym_id,client_id) references public.clients(gym_id,id),
  foreign key (gym_id,client_id,previous_id,previous_revision)
    references public.manual_macro_target_versions(gym_id,client_id,id,revision),
  check ((revision=1 and previous_id is null and previous_revision is null) or
    (revision>1 and previous_id is not null and previous_revision is not null and previous_revision=revision-1))
);
create table public.manual_macro_targets (
  gym_id uuid not null, client_id uuid not null, current_id uuid not null,
  revision bigint not null check (revision between 1 and 9007199254740991),
  primary key (gym_id,client_id),
  foreign key (gym_id,client_id) references public.clients(gym_id,id),
  foreign key (gym_id,client_id,current_id,revision)
    references public.manual_macro_target_versions(gym_id,client_id,id,revision)
);
create table pilot_private.manual_macro_receipts (
  actor_id uuid not null references auth.users(id), operation_id text not null check(length(operation_id) between 1 and 200),
  gym_id uuid not null, client_id uuid not null, version_id uuid not null,
  command jsonb not null, result jsonb not null, recorded_at timestamptz not null,
  primary key (actor_id,operation_id),
  foreign key (gym_id,client_id,version_id) references public.manual_macro_target_versions(gym_id,client_id,id)
);

create function pilot_private.guard_manual_macro_history()
returns trigger language plpgsql set search_path='' as $$
declare old_version public.manual_macro_target_versions; expected jsonb; needs_change boolean;
begin
  if tg_op<>'INSERT' then raise exception 'MANUAL_HISTORY_IMMUTABLE' using errcode='23514'; end if;
  select coalesce(jsonb_agg(k order by k),'[]'::jsonb) into expected
    from (values ('proteinG',new.protein_g),('carbsG',new.carbs_g),('fatG',new.fat_g)) v(k,n) where n=0;
  if jsonb_typeof(new.confirmations) is distinct from 'object'
     or (new.confirmations - array['zeroMacros','energyChange'])<>'{}'::jsonb
     or jsonb_typeof(new.confirmations->'zeroMacros') is distinct from 'array'
     or jsonb_typeof(new.confirmations->'energyChange') is distinct from 'boolean' then
    raise exception 'INVALID_MANUAL_CONFIRMATIONS' using errcode='22023';
  end if;
  if (select coalesce(jsonb_agg(value order by value),'[]'::jsonb) from jsonb_array_elements(new.confirmations->'zeroMacros'))<>expected then
    raise exception 'MANUAL_ZERO_CONFIRMATION_REQUIRED' using errcode='23514';
  end if;
  if new.previous_id is not null then
    select * into old_version from public.manual_macro_target_versions
      where gym_id=new.gym_id and client_id=new.client_id and id=new.previous_id;
    if not found or new.effective_from<=old_version.effective_from then
      raise exception 'INVALID_MANUAL_VERSION_CHAIN' using errcode='23514';
    end if;
    needs_change:=4*abs((4*new.protein_g+4*new.carbs_g+9*new.fat_g)-old_version.kcal)>old_version.kcal;
    if needs_change and new.confirmations->'energyChange'<>'true'::jsonb then
      raise exception 'MANUAL_ENERGY_CONFIRMATION_REQUIRED' using errcode='23514';
    end if;
  end if;
  return new;
end;
$$;
create trigger manual_version_guard before insert or update or delete on public.manual_macro_target_versions
  for each row execute function pilot_private.guard_manual_macro_history();
create trigger manual_receipt_guard before update or delete on pilot_private.manual_macro_receipts
  for each row execute function pilot_private.guard_manual_macro_history();

create function public.pilot_assign_manual_macros(p_command jsonb)
returns jsonb language plpgsql security definer set search_path='' as $$
declare
  actor uuid:=auth.uid(); g uuid; c uuid; op text; base bigint; m jsonb;
  key text; value numeric; p integer; carbs integer; fat integer;
  head public.manual_macro_targets; prior pilot_private.manual_macro_receipts;
  version public.manual_macro_target_versions; stamp timestamptz;
  result jsonb;
begin
  if actor is null then raise exception 'AUTHENTICATION_REQUIRED' using errcode='42501'; end if;
  if jsonb_typeof(p_command) is distinct from 'object' then raise exception 'INVALID_MANUAL_COMMAND' using errcode='22023'; end if;
  if not (p_command ?& array['gymId','clientId','operationId','baseRevision','macros','confirmations'])
    or (p_command-array['gymId','clientId','operationId','baseRevision','macros','confirmations'])<>'{}'::jsonb
    or octet_length(p_command::text)>65536 then raise exception 'INVALID_MANUAL_COMMAND' using errcode='22023'; end if;
  if jsonb_typeof(p_command->'gymId') is distinct from 'string' or jsonb_typeof(p_command->'clientId') is distinct from 'string'
    or jsonb_typeof(p_command->'operationId') is distinct from 'string'
    or length(btrim(p_command->>'operationId'))=0 or length(p_command->>'operationId')>200
    or jsonb_typeof(p_command->'baseRevision') is distinct from 'number' then
    raise exception 'INVALID_MANUAL_COMMAND' using errcode='22023'; end if;
  begin g:=(p_command->>'gymId')::uuid; c:=(p_command->>'clientId')::uuid;
  exception when invalid_text_representation then raise exception 'INVALID_MANUAL_COMMAND' using errcode='22023'; end;
  value:=(p_command->>'baseRevision')::numeric;
  if value<0 or value>9007199254740990 or trunc(value)<>value then raise exception 'INVALID_MANUAL_COMMAND' using errcode='22023'; end if;
  base:=value::bigint; op:=p_command->>'operationId';
  -- Same lock order as authorization mutations: gym first, then actor, then aggregate.
  perform 1 from public.gyms where id=g for update;
  if not pilot_private.can_access_client(g,c) or not exists (
    select 1 from public.coach_clients a join public.gym_memberships cm on cm.gym_id=a.gym_id and cm.id=a.coach_membership_id
    where a.gym_id=g and a.client_id=c and a.active and cm.active and cm.user_id=actor and 'COACH'::public.pilot_role=any(cm.roles)
  ) then raise exception 'ASSIGNED_COACH_REQUIRED' using errcode='42501'; end if;
  -- Serializes operation IDs for this actor even across different organizations.
  perform 1 from public.profiles where id=actor for update;
  select * into prior from pilot_private.manual_macro_receipts where actor_id=actor and operation_id=op;
  if found then
    if prior.command<>p_command then raise exception 'MANUAL_OPERATION_CONFLICT' using errcode='23514'; end if;
    return prior.result;
  end if;
  select * into head from public.manual_macro_targets where gym_id=g and client_id=c for update;
  if coalesce(head.revision,0)<>base then raise exception 'MANUAL_REVISION_CONFLICT' using errcode='40001'; end if;
  m:=p_command->'macros';
  if jsonb_typeof(m) is distinct from 'object' then raise exception 'INVALID_MANUAL_MACROS' using errcode='22023'; end if;
  if not(m ?& array['proteinG','carbsG','fatG']) or (m-array['proteinG','carbsG','fatG'])<>'{}'::jsonb then
    raise exception 'INVALID_MANUAL_MACROS' using errcode='22023'; end if;
  foreach key in array array['proteinG','carbsG','fatG'] loop
    if jsonb_typeof(m->key) is distinct from 'number' then raise exception 'MANUAL_MACROS_INTEGER_REQUIRED' using errcode='22023'; end if;
    value:=(m->>key)::numeric;
    if value<>trunc(value) then raise exception 'MANUAL_MACROS_INTEGER_REQUIRED' using errcode='22023'; end if;
    if value<0 or value>(case key when 'proteinG' then 400 when 'carbsG' then 1000 else 300 end) then
      raise exception 'MANUAL_MACROS_OUT_OF_RANGE' using errcode='23514'; end if;
  end loop;
  p:=(m->>'proteinG')::numeric::integer; carbs:=(m->>'carbsG')::numeric::integer; fat:=(m->>'fatG')::numeric::integer;
  if 4*p+4*carbs+9*fat not between 500 and 6000 then raise exception 'MANUAL_KCAL_OUT_OF_RANGE' using errcode='23514'; end if;
  stamp:=clock_timestamp();
  insert into public.manual_macro_target_versions(gym_id,client_id,id,revision,previous_id,previous_revision,
    protein_g,carbs_g,fat_g,assigned_by,effective_from,recorded_at,confirmations)
    values(g,c,gen_random_uuid(),base+1,head.current_id,head.revision,p,carbs,fat,actor,stamp,stamp,p_command->'confirmations') returning * into version;
  if base=0 then insert into public.manual_macro_targets values(g,c,version.id,version.revision);
  else update public.manual_macro_targets set current_id=version.id,revision=version.revision where gym_id=g and client_id=c; end if;
  result:=jsonb_build_object('targetId',version.id,'gymId',g,'clientId',c,'revision',version.revision,'previousTargetId',version.previous_id,
    'macros',jsonb_build_object('proteinG',p,'carbsG',carbs,'fatG',fat,'kcal',version.kcal),
    'assignedBy',actor,'effectiveFrom',stamp,'recordedAt',stamp,'confirmations',version.confirmations);
  insert into pilot_private.manual_macro_receipts values(actor,op,g,c,version.id,p_command,result,stamp);
  return result;
end;
$$;

alter table public.manual_macro_targets enable row level security;
alter table public.manual_macro_targets force row level security;
alter table public.manual_macro_target_versions enable row level security;
alter table public.manual_macro_target_versions force row level security;
alter table pilot_private.manual_macro_receipts enable row level security;
alter table pilot_private.manual_macro_receipts force row level security;
create policy manual_targets_read on public.manual_macro_targets for select to authenticated
  using(pilot_private.can_access_client(gym_id,client_id));
create policy manual_versions_read on public.manual_macro_target_versions for select to authenticated
  using(pilot_private.can_access_client(gym_id,client_id));

-- Remove ALL inherited grants on these NEW objects only, including unknown recipients.
do $$
declare r record; recipient text;
begin
  for r in select p.oid::regprocedure as signature,a.grantee from pg_proc p
    cross join lateral aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a
    where p.oid in ('public.pilot_assign_manual_macros(jsonb)'::regprocedure,'pilot_private.guard_manual_macro_history()'::regprocedure) and a.grantee<>p.proowner loop
    recipient:=case when r.grantee=0 then 'PUBLIC' else quote_ident(pg_get_userbyid(r.grantee)) end;
    execute format('revoke all on function %s from %s',r.signature,recipient);
  end loop;
  for r in select c.oid::regclass as relation,a.grantee from pg_class c
    cross join lateral aclexplode(coalesce(c.relacl,acldefault('r',c.relowner))) a
    where c.oid in ('public.manual_macro_targets'::regclass,'public.manual_macro_target_versions'::regclass,'pilot_private.manual_macro_receipts'::regclass) and a.grantee<>c.relowner loop
    recipient:=case when r.grantee=0 then 'PUBLIC' else quote_ident(pg_get_userbyid(r.grantee)) end;
    execute format('revoke all on table %s from %s',r.relation,recipient);
  end loop;
end;
$$;
grant select on public.manual_macro_targets,public.manual_macro_target_versions to authenticated;
-- Deliberately no EXECUTE grant. A later separately reviewed migration is required.

do $$
begin
  if exists(select 1 from pg_proc p cross join lateral aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a
    where p.oid in ('public.pilot_assign_manual_macros(jsonb)'::regprocedure,'pilot_private.guard_manual_macro_history()'::regprocedure)
    and a.grantee<>p.proowner) then
    raise exception 'MANUAL_FUNCTION_ACL_INVALID'; end if;
  if exists(select 1 from pg_proc p
    where p.oid in ('public.pilot_assign_manual_macros(jsonb)'::regprocedure,'pilot_private.guard_manual_macro_history()'::regprocedure)
      and p.proowner<>current_user::regrole) then
    raise exception 'MANUAL_FUNCTION_OWNER_INVALID'; end if;
  if exists(select 1 from pg_roles r cross join pg_proc p
    where r.rolname in ('anon','authenticated','authenticator','service_role','pilot_clinical_gateway','pilot_treatment_server')
      and p.oid in ('public.pilot_assign_manual_macros(jsonb)'::regprocedure,'pilot_private.guard_manual_macro_history()'::regprocedure)
      and has_function_privilege(r.oid,p.oid,'EXECUTE')) then
    raise exception 'MANUAL_APPLICATION_EXECUTE_FORBIDDEN'; end if;
  if exists(select 1 from pg_class c
    cross join lateral aclexplode(coalesce(c.relacl,acldefault('r',c.relowner))) a
    where c.oid in ('public.manual_macro_targets'::regclass,'public.manual_macro_target_versions'::regclass,'pilot_private.manual_macro_receipts'::regclass)
      and a.grantee<>c.relowner and not (a.grantee='authenticated'::regrole
        and a.privilege_type='SELECT' and not a.is_grantable
        and c.oid<>'pilot_private.manual_macro_receipts'::regclass)) then
    raise exception 'MANUAL_TABLE_ACL_INVALID'; end if;
  if exists(select 1 from pg_roles r cross join pg_class c
    where c.oid in ('public.manual_macro_targets'::regclass,'public.manual_macro_target_versions'::regclass,'pilot_private.manual_macro_receipts'::regclass)
      and r.oid<>c.relowner and r.rolname !~ '^pg_'
      and (not(r.rolsuper or r.rolbypassrls)
        or r.rolname in ('anon','authenticated','authenticator','service_role','pilot_clinical_gateway','pilot_treatment_server'))
      and has_table_privilege(r.oid,c.oid,'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')) then
    raise exception 'MANUAL_APPLICATION_TABLE_WRITE_FORBIDDEN'; end if;
end;
$$;
commit;
