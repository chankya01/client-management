# RequestManagement

This is a Next.js app for the request/client management portal:

- Supabase magic-link sign-in
- Supabase email/password sign-in
- Client-scoped request dashboard
- Request messages
- Attachment upload to private Supabase Storage
- Deliverable/history signed downloads
- Account page from `profiles` and `clients`

## Local Development

The app can run locally in admin mode without repeated login while still reading and writing Supabase data.

Create a `.env` file from `.env.example`:

```bash
cp .env.example .env
```

Then fill in:

```text
SUPABASE_URL=https://your-project-ref.supabase.co
SUPABASE_SERVICE_ROLE_KEY=your-private-service-role-key
ADMIN_EMAIL=sanithakur544@gmail.com
CLIENT_EMAIL=client@example.com
CLIENT_NAME=Test Client
CLIENT_CONTACT_NAME=Test Client User
DEFAULT_TEMP_PASSWORD=RequestManagement@123
```

Do not put the service-role key in browser code. It is used only by the local Node server.

Install dependencies once:

```bash
npm install
```

For admin testing, open two terminals.

Terminal 1 — API proxy:

```bash
cd /Users/prashant/downloads/projects/RequestManagement
npm run api:admin
```

Terminal 2 — Next.js admin UI:

```bash
cd /Users/prashant/downloads/projects/RequestManagement
npm run next:admin
```

Then open:

```text
http://127.0.0.1:3000/
```

Localhost runs in admin test mode when `localAdminMode` and `localSupabaseAdminProxy` are true in `src/config.js`. This lets you test the owner/admin UI without repeated magic-link login while the local server writes to Supabase.

For client testing, open two more terminals.

Terminal 3 — client API proxy:

```bash
cd /Users/prashant/downloads/projects/RequestManagement
npm run api:client
```

Terminal 4 — Next.js client UI:

```bash
cd /Users/prashant/downloads/projects/RequestManagement
npm run next:client
```

Then use:

```text
Admin:  http://127.0.0.1:3000/
Client: http://127.0.0.1:3001/
```

Port `3001` automatically opens the restricted client portal for `CLIENT_EMAIL`. You can also force either view with:

```text
http://127.0.0.1:3000/?view=admin
http://127.0.0.1:3000/?view=client
```

The older static local server scripts still exist as fallback:

```bash
npm run local:admin
npm run local:client
```

Use the `next:*` scripts for Next.js development.

Disable `localAdminMode` and `localSupabaseAdminProxy` before staging/production deployment.

## Email and Password Login

The production sign-in screen supports:

- Email + password login
- Forgot password email
- Optional magic-link fallback
- Change password from the Account page

When the local/server backend creates a client or team member, it creates or updates the matching Supabase Auth user and `public.profiles` row. New users can sign in with:

```text
Email: the email entered on the client/team form
Temporary password: DEFAULT_TEMP_PASSWORD from .env
```

After signing in, users should change their password from Account.

Run this SQL once in Supabase:

```sql
alter table public.profiles
add column if not exists must_change_password boolean not null default false;

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
```

The app does not store passwords in `public.profiles`. Supabase Auth stores passwords securely. The `must_change_password` column only controls whether the UI should force the user to set a new password.

Password form behavior:

- `must_change_password = true`: show New password + Confirm password automatically.
- `must_change_password = false`: hide the form and show only an “Update password” button.
- After a successful password update: set `must_change_password = false`.

For staging/production, keep the service-role key only on a backend or Supabase Edge Function. Never put the service-role key in frontend/browser code.

## Staging Mode

The app is configured to use Supabase Auth and Supabase tables from `src/config.js`.

Before staging users can sign in, each user must exist in Supabase Auth and must have a matching row in `public.profiles`.

```text
Owner/admin: role = owner
Project manager: role = project_manager
Developer: role = developer
Reviewer: role = reviewer
Client: role = client and client_id = linked client organization
```

The owner login opens the management workspace with delete permissions. Developer/reviewer/project manager users open the internal workspace without delete permissions. Client users open the restricted client portal.

Client records support editing and lifecycle statuses: `signed`, `ongoing`, and `dropped`. Request records also support editing from the Requests page or request detail page.

Team-member invitation should be implemented through a secure backend or Supabase Edge Function because frontend code must never use the service-role key.

Current config:

```js
export const appConfig = {
  supabaseUrl: "https://pgzvfuqibgydtwktrojk.supabase.co",
  supabaseAnonKey: "your-public-anon-key-or-configured-value",
  localAdminMode: false,
  localSupabaseAdminProxy: false,
  localProxyUrl: "/api",
  localView: "admin",
  localClientPorts: ["8001", "3001"],
  demoMode: false
};
```

## Required Supabase Setup

Run the table SQL, RLS SQL, and Storage policies that were provided earlier.

Expected private buckets:

```text
request-attachments
deliverables
agreements
```

Storage paths use:

```text
{client_id}/{request_id}/{file_name}
```

## Important

The anon key is safe for browser use only when RLS is enabled. Never put the Supabase service-role key in this app.
