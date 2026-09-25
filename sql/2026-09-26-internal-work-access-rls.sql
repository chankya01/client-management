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

drop policy if exists "clients_select_policy" on public.clients;
drop policy if exists "profiles_select_policy" on public.profiles;
drop policy if exists "request_messages_select_policy" on public.request_messages;
drop policy if exists "request_messages_insert_policy" on public.request_messages;
drop policy if exists "files_select_policy" on public.files;
drop policy if exists "files_insert_policy" on public.files;

create policy "clients_select_policy"
on public.clients
for select
to authenticated
using (
  exists (
    select 1
    from public.profiles p
    where p.id = auth.uid()
      and p.role in ('owner', 'project_manager', 'developer', 'reviewer', 'assignee')
  )
  or exists (
    select 1
    from public.profiles p
    where p.id = auth.uid()
      and p.role = 'client'
      and p.client_id = clients.id
  )
);

create policy "profiles_select_policy"
on public.profiles
for select
to authenticated
using (
  id = auth.uid()
  or exists (
    select 1
    from public.profiles p
    where p.id = auth.uid()
      and p.role in ('owner', 'project_manager', 'developer', 'reviewer', 'assignee')
  )
);

create policy "request_messages_select_policy"
on public.request_messages
for select
to authenticated
using (
  exists (
    select 1
    from public.profiles p
    where p.id = auth.uid()
      and p.role in ('owner', 'project_manager', 'developer', 'reviewer', 'assignee')
  )
  or exists (
    select 1
    from public.profiles p
    join public.requests r on r.id = request_messages.request_id
    where p.id = auth.uid()
      and p.role = 'client'
      and p.client_id = r.client_id
  )
);

create policy "request_messages_insert_policy"
on public.request_messages
for insert
to authenticated
with check (
  sender_id = auth.uid()
  and (
    exists (
      select 1
      from public.profiles p
      where p.id = auth.uid()
        and p.role in ('owner', 'project_manager', 'developer', 'reviewer', 'assignee')
    )
    or exists (
      select 1
      from public.profiles p
      join public.requests r on r.id = request_messages.request_id
      where p.id = auth.uid()
        and p.role = 'client'
        and p.client_id = r.client_id
    )
  )
);

create policy "files_select_policy"
on public.files
for select
to authenticated
using (
  exists (
    select 1
    from public.profiles p
    where p.id = auth.uid()
      and p.role in ('owner', 'project_manager', 'developer', 'reviewer', 'assignee')
  )
  or exists (
    select 1
    from public.profiles p
    where p.id = auth.uid()
      and p.role = 'client'
      and p.client_id = files.client_id
  )
);

create policy "files_insert_policy"
on public.files
for insert
to authenticated
with check (
  uploaded_by = auth.uid()
  and (
    exists (
      select 1
      from public.profiles p
      where p.id = auth.uid()
        and p.role in ('owner', 'project_manager', 'developer', 'reviewer', 'assignee')
    )
    or exists (
      select 1
      from public.profiles p
      where p.id = auth.uid()
        and p.role = 'client'
        and p.client_id = files.client_id
    )
  )
);
