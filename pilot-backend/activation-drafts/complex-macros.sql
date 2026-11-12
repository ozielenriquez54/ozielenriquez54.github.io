-- DRAFT ONLY. Not in migrations, never loaded by the production launcher.
-- Empty scope is intentional: populate only after explicit pilot authorization.
begin;
create table pilot_private.complex_macro_scope (
  gym_id uuid not null references public.gyms(id),
  coach_user_id uuid not null references auth.users(id),
  client_id uuid not null,
  primary key(gym_id,coach_user_id,client_id),
  foreign key(gym_id,client_id) references public.clients(gym_id,id)
);
alter table pilot_private.complex_macro_scope enable row level security;
alter table pilot_private.complex_macro_scope force row level security;
revoke all on pilot_private.complex_macro_scope from public,anon,authenticated,service_role;
create function public.pilot_save_complex_macros(p_command jsonb)
returns jsonb language plpgsql security definer set search_path='' as $$
begin
  if not exists(select 1 from pilot_private.complex_macro_scope s
    where s.coach_user_id=auth.uid()
    and s.gym_id=(p_command->>'gymId')::uuid
    and s.client_id=(p_command->>'clientId')::uuid) then
    raise exception 'COMPLEX_PILOT_SCOPE_REQUIRED' using errcode='42501';
  end if;
  -- 005 still verifies active coach, client and assignment under locks and
  -- preserves nutritional rules, revisions, receipts and idempotency unchanged.
  return public.pilot_assign_manual_macros(p_command);
end;
$$;
-- Eliminate grants inherited from default privileges on these NEW objects only.
do $$ declare x record; begin
  if not exists(select 1 from pg_proc p join pg_roles r on r.oid=p.proowner
    where p.oid='public.pilot_assign_manual_macros(jsonb)'::regprocedure
    and r.rolname=current_user and (r.rolsuper or r.rolbypassrls)) then
    raise exception 'CONTROLLED_005_OWNER_REQUIRED';
  end if;
  for x in select distinct a.grantee from pg_proc p,
    lateral aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a
    where p.oid='public.pilot_save_complex_macros(jsonb)'::regprocedure and a.grantee<>p.proowner
  loop execute format('revoke all on function public.pilot_save_complex_macros(jsonb) from %s',
    case when x.grantee=0 then 'PUBLIC' else quote_ident(pg_get_userbyid(x.grantee)) end); end loop;
  for x in select distinct a.grantee from pg_class c,
    lateral aclexplode(coalesce(c.relacl,acldefault('r',c.relowner))) a
    where c.oid='pilot_private.complex_macro_scope'::regclass and a.grantee<>c.relowner
  loop execute format('revoke all on table pilot_private.complex_macro_scope from %s',
    case when x.grantee=0 then 'PUBLIC' else quote_ident(pg_get_userbyid(x.grantee)) end); end loop;
end $$;
grant execute on function public.pilot_save_complex_macros(jsonb) to authenticated;
-- Original 005 RPC and direct table writes remain inaccessible to applications.
commit;
