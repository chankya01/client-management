-- Lead workflow fields used by the list-first team and client views.
-- Run this migration in the project Supabase SQL editor before deploying the
-- corresponding UI/API changes.

alter table public.profiles
  add column if not exists responsibilities text[] not null default '{}';

comment on column public.profiles.responsibilities is
  'Up to three short responsibility bullets shown in the team directory.';
