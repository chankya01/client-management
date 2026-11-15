-- Request numbers restart at REQ-1 for each client. The company name in the
-- email subject distinguishes identical request numbers across clients.

alter table public.requests
  drop constraint if exists requests_request_number_key;

drop index if exists public.requests_request_number_key;

create unique index if not exists requests_client_request_number_uidx
  on public.requests (client_id, request_number);
