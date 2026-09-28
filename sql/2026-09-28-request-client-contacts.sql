-- Request client followers / contacts.
--
-- Allows a request to include additional client-side people beyond the
-- primary client contact. Contacts are used for message notification emails.
-- When a contact email also has a public.profiles row, the profile_id can be
-- stored so RLS can allow that person to see only the linked request.

create table if not exists public.request_client_contacts (
  id uuid primary key default gen_random_uuid(),
  request_id uuid not null references public.requests(id) on delete cascade,
  profile_id uuid references public.profiles(id) on delete cascade,
  name text,
  email text not null,
  created_at timestamptz not null default now()
);

alter table public.request_client_contacts
  add column if not exists request_id uuid references public.requests(id) on delete cascade;

alter table public.request_client_contacts
  add column if not exists profile_id uuid references public.profiles(id) on delete cascade;

alter table public.request_client_contacts
  add column if not exists name text;

alter table public.request_client_contacts
  add column if not exists email text;

alter table public.request_client_contacts
  add column if not exists created_at timestamptz not null default now();

create unique index if not exists request_client_contacts_request_email_uidx
on public.request_client_contacts(request_id, lower(email));

create index if not exists request_client_contacts_profile_id_idx
on public.request_client_contacts(profile_id);

create index if not exists request_client_contacts_request_id_idx
on public.request_client_contacts(request_id);

alter table public.request_client_contacts enable row level security;

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

create or replace function public.current_profile_email()
returns text
language sql
stable
security definer
set search_path = public
as $$
  select lower(email)
  from public.profiles
  where id = auth.uid()
  limit 1
$$;

create or replace function public.is_request_client_contact(target_request_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.request_client_contacts rcc
    where rcc.request_id = target_request_id
      and (
        rcc.profile_id = auth.uid()
        or lower(rcc.email) = public.current_profile_email()
      )
  )
$$;

drop policy if exists "request_client_contacts_select_policy" on public.request_client_contacts;
drop policy if exists "request_client_contacts_insert_policy" on public.request_client_contacts;
drop policy if exists "request_client_contacts_delete_policy" on public.request_client_contacts;

create policy "request_client_contacts_select_policy"
on public.request_client_contacts
for select
to authenticated
using (
  public.current_app_role() in ('owner', 'project_manager')
  or profile_id = auth.uid()
  or lower(email) = public.current_profile_email()
);

create policy "request_client_contacts_insert_policy"
on public.request_client_contacts
for insert
to authenticated
with check (
  public.current_app_role() in ('owner', 'project_manager')
);

create policy "request_client_contacts_delete_policy"
on public.request_client_contacts
for delete
to authenticated
using (
  public.current_app_role() in ('owner', 'project_manager')
);

-- Extend request visibility for request-level client followers.
drop policy if exists "requests_select_policy" on public.requests;

create policy "requests_select_policy"
on public.requests
for select
to authenticated
using (
  public.current_app_role() in ('owner', 'project_manager')
  or (
    public.current_app_role() in ('developer', 'reviewer', 'assignee')
    and public.is_assigned_to_request(requests.id)
  )
  or (
    public.current_app_role() = 'client'
    and (
      public.current_client_id() = requests.client_id
      or public.is_request_client_contact(requests.id)
    )
  )
);

-- Extend message visibility/insert permission for request-level client followers.
drop policy if exists "request_messages_select_policy" on public.request_messages;
drop policy if exists "request_messages_insert_policy" on public.request_messages;

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
  or (
    public.current_app_role() = 'client'
    and exists (
      select 1
      from public.requests r
      where r.id = request_messages.request_id
        and (
          public.current_client_id() = r.client_id
          or public.is_request_client_contact(r.id)
        )
    )
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
    or (
      public.current_app_role() = 'client'
      and exists (
        select 1
        from public.requests r
        where r.id = request_messages.request_id
          and (
            public.current_client_id() = r.client_id
            or public.is_request_client_contact(r.id)
          )
      )
    )
  )
);
