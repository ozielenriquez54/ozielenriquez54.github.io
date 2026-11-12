-- Explicit RPC boundary. Apply as postgres (or a controlled BYPASSRLS migration role).
begin;
do $$
begin
  if not exists (select 1 from pg_roles where rolname = current_user and (rolsuper or rolbypassrls)) then
    raise exception 'PILOT_MIGRATION_REQUIRES_CONTROLLED_BYPASSRLS_OWNER';
  end if;
end;
$$;
create function pilot_private.has_role(p_gym_id uuid, p_roles public.pilot_role[])
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.gym_memberships m
    where m.gym_id = p_gym_id and m.user_id = auth.uid() and m.active and m.roles && p_roles);
$$;
-- Single future nutritional-access predicate: no OWNER/ADMIN shortcut.
create function pilot_private.can_access_client(p_gym_id uuid, p_client_id uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.clients c
    join public.gym_memberships cm on cm.gym_id = c.gym_id and cm.id = c.membership_id
    where c.gym_id = p_gym_id and c.id = p_client_id and cm.active
      and 'CLIENT'::public.pilot_role = any(cm.roles)
      and (cm.user_id = auth.uid() or exists (
        select 1 from public.coach_clients a
        join public.gym_memberships coach on coach.gym_id = a.gym_id and coach.id = a.coach_membership_id
        where a.gym_id = c.gym_id and a.client_id = c.id and a.active
          and coach.active and coach.user_id = auth.uid()
          and 'COACH'::public.pilot_role = any(coach.roles))));
$$;
create function pilot_private.can_read_profile(p_user_id uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select p_user_id = auth.uid() or exists (
    select 1 from public.gym_memberships m join public.clients c
      on c.gym_id = m.gym_id and c.membership_id = m.id
    where m.user_id = p_user_id and pilot_private.can_access_client(c.gym_id, c.id));
$$;
-- Tenant lock serializes grants/revocations and prevents last-owner races.
create function pilot_private.lock_admin(p_gym_id uuid)
returns public.pilot_role[] language plpgsql security definer set search_path = '' as $$
declare actor_roles public.pilot_role[];
begin
  if auth.uid() is null then raise exception 'AUTHENTICATION_REQUIRED' using errcode = '42501'; end if;
  perform 1 from public.gyms where id = p_gym_id for update;
  select roles into actor_roles from public.gym_memberships
    where gym_id = p_gym_id and user_id = auth.uid() and active;
  if actor_roles is null or not actor_roles && array['OWNER','ADMIN']::public.pilot_role[] then
    raise exception 'FORBIDDEN_GYM_ADMIN' using errcode = '42501';
  end if;
  return actor_roles;
end;
$$;
create function public.pilot_ensure_profile()
returns public.profiles language plpgsql security definer set search_path = '' as $$
declare result public.profiles;
begin
  if auth.uid() is null then raise exception 'AUTHENTICATION_REQUIRED' using errcode = '42501'; end if;
  insert into public.profiles(id) values (auth.uid()) on conflict (id) do nothing;
  select * into result from public.profiles where id = auth.uid();
  return result;
end;
$$;
-- Any registered pilot user may create a NEW gym; this never grants authority in an existing gym.
create function public.pilot_create_gym(p_name text)
returns public.gyms language plpgsql security definer set search_path = '' as $$
declare result public.gyms;
begin
  perform public.pilot_ensure_profile();
  insert into public.gyms(name) values (p_name) returning * into result;
  insert into public.gym_memberships(gym_id, user_id, roles)
    values (result.id, auth.uid(), array['OWNER']::public.pilot_role[]);
  return result;
end;
$$;
create function public.pilot_set_membership(
  p_gym_id uuid, p_user_id uuid, p_roles public.pilot_role[], p_active boolean, p_expected_revision bigint)
returns public.gym_memberships language plpgsql security definer set search_path = '' as $$
declare
  actor_roles public.pilot_role[];
  previous public.gym_memberships;
  result public.gym_memberships;
begin
  actor_roles := pilot_private.lock_admin(p_gym_id);
  if not pilot_private.valid_roles(p_roles) or p_active is null or p_expected_revision is null or p_expected_revision < 0 then
    raise exception 'INVALID_MEMBERSHIP_COMMAND' using errcode = '22023';
  end if;
  select * into previous from public.gym_memberships where gym_id = p_gym_id and user_id = p_user_id;
  if not ('OWNER'::public.pilot_role = any(actor_roles)) and
    (p_roles && array['OWNER','ADMIN']::public.pilot_role[] or
     coalesce(previous.roles && array['OWNER','ADMIN']::public.pilot_role[], false)) then
    raise exception 'OWNER_REQUIRED_FOR_PRIVILEGED_ROLES' using errcode = '42501';
  end if;
  if coalesce(previous.revision, 0) <> p_expected_revision then
    raise exception 'REVISION_CONFLICT' using errcode = '40001';
  end if;
  if previous.active and 'OWNER'::public.pilot_role = any(previous.roles)
     and (not p_active or not ('OWNER'::public.pilot_role = any(p_roles)))
     and not exists (select 1 from public.gym_memberships where gym_id = p_gym_id
       and id <> previous.id and active and 'OWNER'::public.pilot_role = any(roles)) then
    raise exception 'LAST_ACTIVE_OWNER' using errcode = '23514';
  end if;
  if previous.id is null then
    insert into public.gym_memberships(gym_id,user_id,roles,active)
      values (p_gym_id,p_user_id,p_roles,p_active) returning * into result;
  else
    update public.gym_memberships set roles = p_roles, active = p_active
      where id = previous.id returning * into result;
  end if;
  if p_active and 'CLIENT'::public.pilot_role = any(p_roles) then
    insert into public.clients(gym_id,membership_id) values (p_gym_id,result.id)
      on conflict (gym_id,membership_id) do nothing;
  end if;
  -- Retain rows/history; never implicitly revive assignments on reactivation.
  update public.coach_clients a set active = false
    where a.gym_id = p_gym_id and a.active and (
      (a.coach_membership_id = result.id and (not p_active or not ('COACH'::public.pilot_role = any(p_roles))))
      or (a.client_id in (select c.id from public.clients c where c.gym_id = p_gym_id and c.membership_id = result.id)
        and (not p_active or not ('CLIENT'::public.pilot_role = any(p_roles)))));
  return result;
end;
$$;
create function public.pilot_set_coach_client(
  p_gym_id uuid, p_coach_membership_id uuid, p_client_membership_id uuid,
  p_active boolean, p_expected_revision bigint)
returns public.coach_clients language plpgsql security definer set search_path = '' as $$
declare
  coach public.gym_memberships;
  client_member public.gym_memberships;
  target public.clients;
  previous public.coach_clients;
  result public.coach_clients;
begin
  perform pilot_private.lock_admin(p_gym_id);
  if p_active is null or p_expected_revision is null or p_expected_revision < 0 then
    raise exception 'INVALID_ASSIGNMENT_COMMAND' using errcode = '22023';
  end if;
  select * into coach from public.gym_memberships where gym_id = p_gym_id and id = p_coach_membership_id;
  select * into client_member from public.gym_memberships where gym_id = p_gym_id and id = p_client_membership_id;
  select * into target from public.clients where gym_id = p_gym_id and membership_id = p_client_membership_id;
  if coach.id is null or client_member.id is null or target.id is null then
    raise exception 'INVALID_SAME_GYM_RELATION' using errcode = '23503';
  end if;
  if p_active and (not coach.active or not client_member.active
      or not ('COACH'::public.pilot_role = any(coach.roles))
      or not ('CLIENT'::public.pilot_role = any(client_member.roles))) then
    raise exception 'ACTIVE_COACH_AND_CLIENT_REQUIRED' using errcode = '23514';
  end if;
  select * into previous from public.coach_clients where gym_id = p_gym_id
    and coach_membership_id = coach.id and client_id = target.id;
  if coalesce(previous.revision,0) <> p_expected_revision then
    raise exception 'REVISION_CONFLICT' using errcode = '40001';
  end if;
  if previous.id is null then
    if not p_active then raise exception 'ASSIGNMENT_NOT_FOUND' using errcode = '22023'; end if;
    insert into public.coach_clients(gym_id,coach_membership_id,client_id)
      values (p_gym_id,coach.id,target.id) returning * into result;
  else
    update public.coach_clients set active = p_active where id = previous.id returning * into result;
  end if;
  return result;
end;
$$;
create policy profiles_read on public.profiles for select to authenticated
  using (pilot_private.can_read_profile(id));
create policy gyms_read on public.gyms for select to authenticated
  using (pilot_private.has_role(id, array['OWNER','ADMIN','COACH','CLIENT']::public.pilot_role[]));
-- Administrative roster is not permission to read client/nutritional records.
create policy memberships_read on public.gym_memberships for select to authenticated
  using (user_id = auth.uid() or pilot_private.has_role(gym_id,array['OWNER','ADMIN']::public.pilot_role[]));
create policy clients_read on public.clients for select to authenticated
  using (pilot_private.can_access_client(gym_id,id));
create policy assignments_read on public.coach_clients for select to authenticated
  using (pilot_private.has_role(gym_id,array['OWNER','ADMIN']::public.pilot_role[])
    or pilot_private.can_access_client(gym_id,client_id));
-- Never grant table mutation privileges to browser roles; there are no mutation policies.
grant select on public.profiles, public.gyms, public.gym_memberships, public.clients, public.coach_clients to authenticated;
revoke all on all functions in schema pilot_private from public, anon, authenticated;
grant execute on function pilot_private.has_role(uuid,public.pilot_role[]),
  pilot_private.can_access_client(uuid,uuid), pilot_private.can_read_profile(uuid) to authenticated;
revoke all on function public.pilot_ensure_profile(), public.pilot_create_gym(text),
  public.pilot_set_membership(uuid,uuid,public.pilot_role[],boolean,bigint),
  public.pilot_set_coach_client(uuid,uuid,uuid,boolean,bigint) from public, anon, authenticated;
grant execute on function public.pilot_ensure_profile(), public.pilot_create_gym(text),
  public.pilot_set_membership(uuid,uuid,public.pilot_role[],boolean,bigint),
  public.pilot_set_coach_client(uuid,uuid,uuid,boolean,bigint) to authenticated;
commit;
