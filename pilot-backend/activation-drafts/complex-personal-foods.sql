-- Local candidate only. Do not run in Supabase without a separate reviewed approval.
begin;
do $$ begin
  if not exists(select 1 from pg_roles where rolname='pilot_diary_server' and not rolsuper and not rolbypassrls)
    or not exists(select 1 from pg_proc where oid='pilot_private.diary_authorize(uuid,uuid,uuid)'::regprocedure) then
    raise exception 'PERSONAL_FOOD_PREREQUISITES_REQUIRED';
  end if;
  if not exists(select 1 from pg_proc p join pg_roles r on r.oid=p.proowner
    where p.oid='pilot_private.diary_authorize(uuid,uuid,uuid)'::regprocedure
    and r.rolname=current_user and (r.rolsuper or r.rolbypassrls)) then
    raise exception 'CONTROLLED_OWNER_REQUIRED';
  end if;
end $$;

create table pilot_private.pilot_personal_foods (
  gym_id uuid not null, client_id uuid not null, owner_user_id uuid not null references auth.users(id),
  food_id uuid not null, normalized_name text not null, food jsonb not null,
  created_at timestamptz not null default now(),
  primary key(gym_id,client_id,food_id), unique(gym_id,client_id,normalized_name),
  foreign key(gym_id,client_id) references public.clients(gym_id,id),
  check(length(normalized_name) between 2 and 100), check(octet_length(food::text)<=16000)
);
alter table pilot_private.pilot_personal_foods enable row level security;
alter table pilot_private.pilot_personal_foods force row level security;

create function pilot_private.personal_food_name_key(n text) returns text
language sql immutable strict set search_path='' as $$
  select pg_catalog.btrim(pg_catalog.regexp_replace(
    pg_catalog.lower(pg_catalog.regexp_replace(normalize(n,NFD), U&'[\0300-\036f]', '', 'g')) collate "C",
    '[^a-z0-9]+',' ','g'))
$$;

create function pilot_private.personal_food_list(a uuid,g uuid,c uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
begin
  perform pilot_private.diary_authorize(a,g,c);
  return coalesce((select pg_catalog.jsonb_agg(f.food order by f.normalized_name)
    from pilot_private.pilot_personal_foods f where f.gym_id=g and f.client_id=c and f.owner_user_id=a),'[]'::jsonb);
end $$;

create function pilot_private.personal_food_resolve(a uuid,g uuid,c uuid,fid uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
declare result jsonb;
begin
  perform pilot_private.diary_authorize(a,g,c);
  select f.food into result from pilot_private.pilot_personal_foods f
    where f.gym_id=g and f.client_id=c and f.owner_user_id=a and f.food_id=fid;
  return result;
end $$;

create function pilot_private.personal_food_create(a uuid,g uuid,c uuid,fid uuid,nkey text,definition jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare actual_key text;k text;v jsonb;qty numeric;unit text;
begin
  perform pilot_private.diary_authorize(a,g,c);
  actual_key:=pilot_private.personal_food_name_key(definition->>'canonicalName');
  if fid is null or definition->>'foodId' is distinct from fid::text
    or definition->>'canonicalName' is null or definition->>'displayName' is null
    or nkey is distinct from actual_key or definition->>'createdBy' is distinct from a::text
    or definition->>'contributionStatus' is distinct from 'USER_CONTRIBUTED'
    or definition->>'validationStatus' is distinct from 'PENDING_VALIDATION'
    or definition->>'active' is distinct from 'true'
    or definition->>'revision' is distinct from '1'
    or definition->'source'->>'type' is distinct from 'MANUAL'
    or octet_length(definition::text)>16000 then
      raise exception 'PERSONAL_FOOD_DEFINITION_REJECTED' using errcode='23514';
  end if;
  if jsonb_typeof(definition) is distinct from 'object'
    or jsonb_typeof(definition->'canonicalName') is distinct from 'string'
    or jsonb_typeof(definition->'displayName') is distinct from 'string'
    or length(actual_key) not between 2 and 100
    or length(definition->>'displayName') not between 2 and 100
    or definition->'active' is distinct from 'true'::jsonb
    or definition->'revision' is distinct from '1'::jsonb
    or definition->'source'->'provenance'->>'kind' is null
    or definition->'source'->'provenance'->>'kind' not in ('LABEL','MANUAL')
    or definition->>'nutritionBasis' is distinct from 'PER_REFERENCE_QUANTITY'
    or definition->'accountingPolicy'->'version' is distinct from '1'::jsonb
    or definition->'validatedBy' is distinct from 'null'::jsonb
    or definition->'validatedAt' is distinct from 'null'::jsonb then
    raise exception 'PERSONAL_FOOD_DEFINITION_REJECTED' using errcode='23514';
  end if;
  if definition->>'category' is null or definition->>'category' not in ('OTHER','COOKING_PROTEIN','DRY_STARCH','VEGETABLE')
    or (definition->>'category'='COOKING_PROTEIN' and
      (definition->>'preparationState' is distinct from 'COOKED' or definition->>'weighingBasis' is distinct from 'COOKED'))
    or (definition->>'category'='DRY_STARCH' and
      (definition->>'preparationState' is distinct from 'DRY' or definition->>'weighingBasis' is distinct from 'RAW_DRY'))
    or (definition->>'category'='OTHER' and
      (definition->>'preparationState' is distinct from 'AS_SOLD' or definition->>'weighingBasis' is distinct from 'AS_SOLD')) then
    raise exception 'INVALID_PREPARATION' using errcode='23514';
  end if;
  foreach k in array array['kcal','proteinG','carbsG','fatG'] loop
    v:=definition->k;
    if definition->>'category'='VEGETABLE' and v='null'::jsonb then continue; end if;
    if jsonb_typeof(v) is distinct from 'number' then
      raise exception 'INVALID_NUTRIENT' using errcode='23514';
    end if;
    if v::text::numeric<0 or v::text::numeric>(case when k='kcal' then 10000 else 1000 end) then
      raise exception 'INVALID_NUTRIENT' using errcode='23514';
    end if;
  end loop;
  if definition->>'category'<>'VEGETABLE' then
    unit:=definition->>'referenceUnit';
    if unit is null or unit not in ('g','ml','pieza','porcion','taza','cucharada','cucharadita','scoop')
      or jsonb_typeof(definition->'referenceQuantity') is distinct from 'number' then
      raise exception 'INVALID_REFERENCE' using errcode='23514';
    end if;
    qty:=(definition->>'referenceQuantity')::numeric;
    if qty<0.01 or qty>1000 or (unit not in ('g','ml') and qty>100) then
      raise exception 'INVALID_REFERENCE' using errcode='23514';
    end if;
    if unit='g' and ((definition->>'kcal')::numeric>qty*10
      or (definition->>'proteinG')::numeric>qty*1.01
      or (definition->>'carbsG')::numeric>qty*1.01
      or (definition->>'fatG')::numeric>qty*1.01) then
      raise exception 'INVALID_NUTRIENT_DENSITY' using errcode='23514';
    end if;
  end if;
  if definition->>'category'='VEGETABLE' then
    if definition->>'weighingBasis' is distinct from 'UNWEIGHED'
      or definition->>'preparationState' is distinct from 'RAW'
      or definition->'referenceQuantity' is distinct from 'null'::jsonb
      or definition->'referenceUnit' is distinct from 'null'::jsonb
      or definition->'accountingPolicy'->>'id' is distinct from 'VEGETABLE_ZERO'
      or definition->>'composition' is distinct from 'SINGLE_INGREDIENT' then
        raise exception 'VEGETABLE_ZERO_REQUIRED' using errcode='23514';
    end if;
  elsif definition->'accountingPolicy'->>'id' is distinct from 'STANDARD' then
    raise exception 'PERSONAL_FOOD_POLICY_REJECTED' using errcode='23514';
  end if;
  insert into pilot_private.pilot_personal_foods(gym_id,client_id,owner_user_id,food_id,normalized_name,food)
    values(g,c,a,fid,nkey,definition);
  return definition;
end $$;

-- Strip all default ACL recipients on these new objects, including service_role.
do $$ declare t text;x record;begin
 foreach t in array array['pilot_private.pilot_personal_foods'] loop
  for x in select distinct a.grantee from pg_class c,lateral aclexplode(coalesce(c.relacl,acldefault('r',c.relowner))) a where c.oid=t::regclass and a.grantee<>c.relowner loop
   execute format('revoke all on table %s from %s',t,case when x.grantee=0 then 'PUBLIC' else quote_ident(pg_get_userbyid(x.grantee)) end);
  end loop;
 end loop;
 foreach t in array array['pilot_private.personal_food_name_key(text)','pilot_private.personal_food_list(uuid,uuid,uuid)','pilot_private.personal_food_resolve(uuid,uuid,uuid,uuid)','pilot_private.personal_food_create(uuid,uuid,uuid,uuid,text,jsonb)'] loop
  for x in select distinct a.grantee from pg_proc p,lateral aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a where p.oid=t::regprocedure and a.grantee<>p.proowner loop
   execute format('revoke all on function %s from %s',t,case when x.grantee=0 then 'PUBLIC' else quote_ident(pg_get_userbyid(x.grantee)) end);
  end loop;
 end loop;
end $$;
grant usage on schema pilot_private to pilot_diary_server;
grant execute on function pilot_private.personal_food_list(uuid,uuid,uuid),
  pilot_private.personal_food_resolve(uuid,uuid,uuid,uuid),
  pilot_private.personal_food_create(uuid,uuid,uuid,uuid,text,jsonb) to pilot_diary_server;
commit;
