create table if not exists public.signature_documents (
  id uuid primary key default gen_random_uuid(),
  request_id uuid not null references public.requests(id) on delete cascade,
  uploaded_by uuid references public.profiles(id) on delete set null,
  title text not null,
  status text not null default 'sent' check (status in ('draft', 'sent', 'viewed', 'partially_signed', 'completed', 'declined', 'cancelled')),
  bucket_name text not null default 'request-attachments',
  storage_path text not null,
  file_name text not null,
  mime_type text,
  file_size bigint,
  sent_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.signature_recipients (
  id uuid primary key default gen_random_uuid(),
  document_id uuid not null references public.signature_documents(id) on delete cascade,
  name text not null,
  email text not null,
  role text not null default 'signer' check (role in ('signer', 'viewer')),
  signing_token uuid not null default gen_random_uuid() unique,
  status text not null default 'sent' check (status in ('sent', 'viewed', 'signed', 'declined')),
  viewed_at timestamptz,
  signed_at timestamptz,
  declined_at timestamptz,
  typed_signature text,
  signed_ip text,
  signed_user_agent text,
  created_at timestamptz not null default now()
);

create table if not exists public.signature_events (
  id uuid primary key default gen_random_uuid(),
  document_id uuid not null references public.signature_documents(id) on delete cascade,
  recipient_id uuid references public.signature_recipients(id) on delete set null,
  event_type text not null,
  event_note text,
  created_at timestamptz not null default now()
);

create index if not exists signature_documents_request_id_idx on public.signature_documents(request_id);
create index if not exists signature_recipients_document_id_idx on public.signature_recipients(document_id);
create index if not exists signature_recipients_email_idx on public.signature_recipients(lower(email));
create index if not exists signature_events_document_id_idx on public.signature_events(document_id);

alter table public.signature_documents enable row level security;
alter table public.signature_recipients enable row level security;
alter table public.signature_events enable row level security;

-- API routes use the service role for controlled access checks. These policies keep
-- direct client access closed unless you later choose to expose it deliberately.
drop policy if exists "No direct signature document access" on public.signature_documents;
create policy "No direct signature document access"
  on public.signature_documents for all
  using (false)
  with check (false);

drop policy if exists "No direct signature recipient access" on public.signature_recipients;
create policy "No direct signature recipient access"
  on public.signature_recipients for all
  using (false)
  with check (false);

drop policy if exists "No direct signature event access" on public.signature_events;
create policy "No direct signature event access"
  on public.signature_events for all
  using (false)
  with check (false);
