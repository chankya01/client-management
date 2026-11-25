-- Preserve the plain-text message for search/accessibility while retaining
-- the sanitized editor HTML used by the dashboard and outbound email.
alter table public.request_messages
  add column if not exists message_html text;
