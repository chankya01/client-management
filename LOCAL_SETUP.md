# Local setup before pushing to stage

Use this flow to test admin, developer, and client changes locally before deploying to Vercel/stage.

## 1. Install dependencies

```bash
npm install
```

## 2. Configure local environment

Create `.env` from the example if it does not already exist:

```bash
cp .env.example .env
```

Fill these values in `.env`:

```text
SUPABASE_URL=...
SUPABASE_ANON_KEY=...
SUPABASE_SERVICE_ROLE_KEY=...
ADMIN_EMAIL=...
CLIENT_EMAIL=...
CLIENT_NAME=...
CLIENT_CONTACT_NAME=...
DEFAULT_TEMP_PASSWORD=...
```

Important: `.env` is ignored by git. Do not paste service-role keys into browser code or commit them.

## 3. Run admin/developer local view

Open two terminals.

Terminal 1:

```bash
npm run api:admin
```

Terminal 2:

```bash
npm run next:admin
```

Open:

```text
http://127.0.0.1:3000/
```

This uses the local API proxy and lets you test the internal admin/developer experience without repeated sign-in.

## 4. Run client local view

Open two more terminals.

Terminal 3:

```bash
npm run api:client
```

Terminal 4:

```bash
npm run next:client
```

Open:

```text
http://127.0.0.1:3001/
```

This loads the client-scoped view for `CLIENT_EMAIL` from `.env`.

## 5. Pre-stage test checklist

Before pushing to stage, verify:

- Admin can open Dashboard, Clients, Requests, Messages, Team, Settings.
- Developer can log in and open Dashboard, Requests, Messages, Account.
- Client can log in and first sees Dashboard.
- Pending message count shows which request has pending messages.
- Opening a pending request conversation clears the pending count for that request.
- Client messages show the actual sender name, not only “Team Member”.
- Request creation works for an existing client.
- Request status changes save without enum errors.
- Tagged team members can be added and updated.
- Long messages preserve line breaks and show “Show More” when needed.
- Attachments can be selected and removed before sending.
- Buttons have consistent purple styling and accessible focus states.

## 6. Build before deployment

Run:

```bash
npm run build
```

Only push/deploy after the build passes and the local checklist looks good.

