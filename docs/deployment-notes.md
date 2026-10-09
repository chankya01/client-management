# Deployment and Migration Notes

This file records manual database migrations and deployment notes so each environment change has a reference in code.

## 2026-10-03 — Internal signature documents foundation

- Branch: `feature-internal-signatures`
- Environment applied: current Supabase stage project
- Supabase project id: `pgzvfuqibgydtwktrojk`
- Migration file: [`sql/2026-10-03-signature-documents.sql`](../sql/2026-10-03-signature-documents.sql)
- Applied manually in Supabase SQL Editor.

### What changed

Added new additive-only signature tables:

- `signature_documents`
- `signature_recipients`
- `signature_events`

Added indexes for request/document lookups and recipient email lookups.

Enabled RLS on the new tables and added deny-by-default direct-access policies. App access is handled through server API routes using controlled permission checks.

### Existing app impact

No existing tables were altered.

Existing client/request/message/team flows should not be affected because the migration only creates new signature-related tables.

### Related feature work

The feature branch adds:

- Documents tab for signature workflows
- document upload/send-for-signature flow
- token-based public signing page
- typed-name signature capture
- signature recipient/event status tracking

## 2026-10-04 — Signature preview routing and request-scoped documents

- Branch: `feature-internal-signatures`
- No SQL migration required.

### What changed

- Vercel/Next API routes now stay enabled in preview deployments. The local `/api/*` rewrite only runs when `LOCAL_API_PORT` is set for local proxy testing.
- Signing links now use `/sign/<token>` instead of only `/?sign=<token>`. The old query-string link is still supported.
- Documents are shown inside the related request details instead of listing every client/request document on the global Documents page.
- Client navigation no longer shows a global Documents tab; clients open documents from the specific request.

### Preview environment checklist

For email delivery, configure these Vercel Preview environment variables and redeploy the preview:

- `RESEND_API_KEY`
- `NOTIFICATION_FROM` using a verified Resend sender/domain
- `APP_URL` or `NEXT_PUBLIC_APP_URL` pointing to the preview or target app URL

## 2026-10-10 — Proposal-style web agreements

- Branch: `feature-internal-signatures`
- No SQL migration required.

### What changed

- The PDF-first signing experiment was removed. There is no `pdf-lib` dependency and the app no longer creates stamped PDF copies.
- Internal users now create proposal-style web agreements attached to a request.
- Admin/developer/reviewer users paste or edit one complete agreement body instead of filling separate required scope/service/price fields.
- The complete agreement body can include the project overview, services, pricing, timeline, payment terms, legal terms, and signature wording from the source agreement.
- The client opens the signing link and reviews a web agreement page with company/process context, the complete agreement, recipients, and a signature section at the bottom.
- Signers manually enter all signing fields. Nothing is prepopulated:
  - signature;
  - name;
  - title;
  - date.
- If the recipient email already belongs to an existing portal profile, the signing API requires a signed-in Supabase session for that same recipient email before accepting the signature.
- Agreement content is stored as an `agreement_snapshot` event so the exact version sent for signature remains tied to the signature record without requiring another table.
- Signing still updates `signature_recipients`, `signature_documents`, `signature_events`, and the related request message timeline.

### Existing app impact

No existing tables were altered.

The agreement feature continues to use the additive signature tables created earlier. Existing client/request/message/team flows should not be affected.
