-- Metadata used to make Proton Mail synchronization idempotent and traceable.
-- Run this once in the Supabase project before enabling the Proton bridge worker.
alter table public.request_messages
  add column if not exists external_message_id text,
  add column if not exists external_thread_id text,
  add column if not exists external_subject text,
  add column if not exists external_sender_email text,
  add column if not exists source text not null default 'app';

create unique index if not exists request_messages_external_message_id_idx
  on public.request_messages (external_message_id)
  where external_message_id is not null;

create index if not exists request_messages_external_thread_id_idx
  on public.request_messages (external_thread_id)
  where external_thread_id is not null;
