-- Internal work-role access policies for the browser-hosted app.
-- Run this in Supabase SQL Editor after the base schema exists.
--
-- Goal:
-- - Admin / Project Manager keep management access.
-- - Developer / Reviewer / Assignee can view requests, clients needed for request names,
--   team directory, messages, and attachments.
-- - Client can only see records linked to their own client_id.

alter table public.clients enable row level security;
alter table public.profiles enable row level security;
alter table public.request_messages enable row level security;
alter table public.files enable row level security;

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

drop policy if exists "clients_select_policy" on public.clients;
drop policy if exists "profiles_select_policy" on public.profiles;
drop policy if exists "profiles_update_self_policy" on public.profiles;
drop policy if exists "profiles_update_management_policy" on public.profiles;
drop policy if exists "request_messages_select_policy" on public.request_messages;
drop policy if exists "request_messages_insert_policy" on public.request_messages;
drop policy if exists "files_select_policy" on public.files;
drop policy if exists "files_insert_policy" on public.files;

create policy "clients_select_policy"
on public.clients
for select
to authenticated
using (
  public.current_app_role() in ('owner', 'project_manager')
  or exists (
    select 1
    from public.requests r
    where r.client_id = clients.id
      and public.current_app_role() in ('developer', 'reviewer', 'assignee')
      and public.is_assigned_to_request(r.id)
  )
  or (
    public.current_app_role() = 'client'
    and public.current_client_id() = clients.id
  )
);

create policy "profiles_select_policy"
on public.profiles
for select
to authenticated
using (
  id = auth.uid()
  or public.current_app_role() in ('owner', 'project_manager', 'developer', 'reviewer', 'assignee')
);

create policy "profiles_update_self_policy"
on public.profiles
for update
to authenticated
using (id = auth.uid())
with check (
  id = auth.uid()
  and role = public.current_app_role()
  and client_id is not distinct from public.current_client_id()
);

create policy "profiles_update_management_policy"
on public.profiles
for update
to authenticated
using (
  public.current_app_role() in ('owner', 'project_manager')
)
with check (
  public.current_app_role() in ('owner', 'project_manager')
);

create policy "request_messages_select_policy"
on public.request_messages
for select
to authenticated
using (
  public.current_app_role() in ('owner', 'project_manager')
  or (
    public.current_app_role() in ('developer', 'reviewer', 'assignee')
    and public.is_assigned_to_request(request_messages.request_id)
  )
  or exists (
    select 1
    from public.requests r
    where r.id = request_messages.request_id
      and public.current_app_role() = 'client'
      and public.current_client_id() = r.client_id
  )
);

create policy "request_messages_insert_policy"
on public.request_messages
for insert
to authenticated
with check (
  sender_id = auth.uid()
  and (
    public.current_app_role() in ('owner', 'project_manager')
    or (
      public.current_app_role() in ('developer', 'reviewer', 'assignee')
      and public.is_assigned_to_request(request_messages.request_id)
    )
    or exists (
      select 1
      from public.requests r
      where r.id = request_messages.request_id
        and public.current_app_role() = 'client'
        and public.current_client_id() = r.client_id
    )
  )
);

create policy "files_select_policy"
on public.files
for select
to authenticated
using (
  public.current_app_role() in ('owner', 'project_manager')
  or (
    public.current_app_role() in ('developer', 'reviewer', 'assignee')
    and public.is_assigned_to_request(files.request_id)
  )
  or (
    public.current_app_role() = 'client'
    and public.current_client_id() = files.client_id
  )
);

create policy "files_insert_policy"
on public.files
for insert
to authenticated
with check (
  uploaded_by = auth.uid()
  and (
    public.current_app_role() in ('owner', 'project_manager')
    or (
      public.current_app_role() in ('developer', 'reviewer', 'assignee')
      and public.is_assigned_to_request(files.request_id)
    )
    or (
      public.current_app_role() = 'client'
      and public.current_client_id() = files.client_id
    )
  )
);
