-- Request assignment support.
-- Run this before re-running the updated RLS policy files.
--
-- This file is safe to re-run. It also repairs an existing request_assignments
-- table that was created earlier without the expected profile_id column.

create table if not exists public.request_assignments (
  request_id uuid references public.requests(id) on delete cascade,
  profile_id uuid references public.profiles(id) on delete cascade,
  assigned_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now()
);

alter table public.request_assignments
  add column if not exists request_id uuid references public.requests(id) on delete cascade;

alter table public.request_assignments
  add column if not exists profile_id uuid references public.profiles(id) on delete cascade;

alter table public.request_assignments
  add column if not exists assigned_by uuid references public.profiles(id) on delete set null;

alter table public.request_assignments
  add column if not exists created_at timestamptz not null default now();

-- If an older prototype used user_id/assignee_id instead of profile_id, copy it.
do $$
begin
  if exists (
    select 1
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'request_assignments'
      and column_name = 'user_id'
  ) then
    execute 'update public.request_assignments set profile_id = user_id where profile_id is null and user_id is not null';
  end if;

  if exists (
    select 1
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'request_assignments'
      and column_name = 'assignee_id'
  ) then
    execute 'update public.request_assignments set profile_id = assignee_id where profile_id is null and assignee_id is not null';
  end if;
end $$;

create index if not exists request_assignments_profile_id_idx
on public.request_assignments(profile_id);

create unique index if not exists request_assignments_request_profile_uidx
on public.request_assignments(request_id, profile_id)
where request_id is not null and profile_id is not null;

alter table public.request_assignments enable row level security;

create or replace function public.current_app_role()
returns public.app_role
language sql
stable
security definer
set search_path = public
as $$
  select role
  from public.profiles
  where id = auth.uid()
  limit 1
$$;

create or replace function public.current_client_id()
returns uuid
language sql
stable
security definer
set search_path = public
as $$
  select client_id
  from public.profiles
  where id = auth.uid()
  limit 1
$$;

create or replace function public.is_assigned_to_request(target_request_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.request_assignments ra
    where ra.request_id = target_request_id
      and ra.profile_id = auth.uid()
  )
$$;

drop policy if exists "request_assignments_select_policy" on public.request_assignments;
drop policy if exists "request_assignments_insert_policy" on public.request_assignments;
drop policy if exists "request_assignments_delete_policy" on public.request_assignments;

create policy "request_assignments_select_policy"
on public.request_assignments
for select
to authenticated
using (
  public.current_app_role() in ('owner', 'project_manager')
  or profile_id = auth.uid()
);

create policy "request_assignments_insert_policy"
on public.request_assignments
for insert
to authenticated
with check (
  public.current_app_role() in ('owner', 'project_manager')
  and request_id is not null
  and profile_id is not null
);

create policy "request_assignments_delete_policy"
on public.request_assignments
for delete
to authenticated
using (
  public.current_app_role() in ('owner', 'project_manager')
);
