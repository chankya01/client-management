-- Fix request creation/update access for the browser-hosted Vercel app.
-- Run this in Supabase SQL Editor.
--
-- It allows:
-- - Admin/Project Manager: create, read, update, delete requests.
-- - Developer/Reviewer/Assignee: read internal requests.
-- - Client: read only requests linked to their client_id.

alter table public.requests enable row level security;

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

drop policy if exists "requests_select_policy" on public.requests;
drop policy if exists "requests_insert_policy" on public.requests;
drop policy if exists "requests_update_policy" on public.requests;
drop policy if exists "requests_delete_policy" on public.requests;

create policy "requests_select_policy"
on public.requests
for select
to authenticated
using (
  public.current_app_role() in ('owner', 'project_manager', 'developer', 'reviewer', 'assignee')
  or (
    public.current_app_role() = 'client'
    and public.current_client_id() = requests.client_id
  )
);

create policy "requests_insert_policy"
on public.requests
for insert
to authenticated
with check (
  public.current_app_role() in ('owner', 'project_manager')
  and created_by = auth.uid()
);

create policy "requests_update_policy"
on public.requests
for update
to authenticated
using (
  public.current_app_role() in ('owner', 'project_manager')
)
with check (
  public.current_app_role() in ('owner', 'project_manager')
);

create policy "requests_delete_policy"
on public.requests
for delete
to authenticated
using (
  public.current_app_role() = 'owner'
);
