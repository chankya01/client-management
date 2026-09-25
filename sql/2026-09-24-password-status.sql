alter table public.profiles
add column if not exists must_change_password boolean not null default false;

comment on column public.profiles.must_change_password is
'True when the user was created with a temporary password and must set their own password after signing in.';

create or replace function public.mark_password_changed()
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.profiles
  set must_change_password = false
  where id = auth.uid();
end;
$$;

grant execute on function public.mark_password_changed() to authenticated;
