-- Add the Assignee role to the app_role enum.
-- Run this first, by itself, before running any RLS policy that references 'assignee'.
--
-- Supabase/Postgres enum values must exist before policies can compare against them.

alter type public.app_role add value if not exists 'assignee';
