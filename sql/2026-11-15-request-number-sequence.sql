-- Stable, globally unique request codes used in email subjects and inbound
-- Proton routing. Run this once in the Supabase SQL editor.

create sequence if not exists public.request_number_seq;

do $$
declare
  current_max bigint;
begin
  select coalesce(
    max((substring(request_number from '^REQ-([0-9]+)$'))::bigint),
    0
  )
  into current_max
  from public.requests;

  if current_max > 0 then
    perform setval('public.request_number_seq', current_max, true);
  else
    perform setval('public.request_number_seq', 1, false);
  end if;
end
$$;

create or replace function public.next_request_number()
returns text
language sql
security definer
set search_path = public
as $$
  select 'REQ-' || nextval('public.request_number_seq')::text;
$$;

revoke all on function public.next_request_number() from public;
grant execute on function public.next_request_number() to authenticated, service_role;
