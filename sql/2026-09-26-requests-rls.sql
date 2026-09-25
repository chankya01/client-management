-- Fix request creation/update access for the browser-hosted Vercel app.
-- Run this in Supabase SQL Editor.
--
-- It allows:
-- - Admin/Project Manager: create, read, update, delete requests.
-- - Developer/Reviewer: read internal requests.
-- - Client: read only requests linked to their client_id.

alter table public.requests enable row level security;

drop policy if exists "requests_select_policy" on public.requests;
drop policy if exists "requests_insert_policy" on public.requests;
drop policy if exists "requests_update_policy" on public.requests;
drop policy if exists "requests_delete_policy" on public.requests;

create policy "requests_select_policy"
on public.requests
for select
to authenticated
using (
  exists (
    select 1
    from public.profiles p
    where p.id = auth.uid()
      and p.role in ('owner', 'project_manager', 'developer', 'reviewer')
  )
  or exists (
    select 1
    from public.profiles p
    where p.id = auth.uid()
      and p.role = 'client'
      and p.client_id = requests.client_id
  )
);

create policy "requests_insert_policy"
on public.requests
for insert
to authenticated
with check (
  exists (
    select 1
    from public.profiles p
    where p.id = auth.uid()
      and p.role in ('owner', 'project_manager')
  )
  and created_by = auth.uid()
);

create policy "requests_update_policy"
on public.requests
for update
to authenticated
using (
  exists (
    select 1
    from public.profiles p
    where p.id = auth.uid()
      and p.role in ('owner', 'project_manager')
  )
)
with check (
  exists (
    select 1
    from public.profiles p
    where p.id = auth.uid()
      and p.role in ('owner', 'project_manager')
  )
);

create policy "requests_delete_policy"
on public.requests
for delete
to authenticated
using (
  exists (
    select 1
    from public.profiles p
    where p.id = auth.uid()
      and p.role = 'owner'
  )
);
