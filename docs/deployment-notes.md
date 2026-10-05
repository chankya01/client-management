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

## 2026-10-06 — Signature phase 3 signed proof copy

- Branch: `feature-internal-signatures`
- No SQL migration required.

### What changed

- Public signing links now show an inline PDF review area before the signer submits their typed signature.
- PDF preview is served through a token-scoped app route with inline content disposition instead of embedding the private Supabase storage URL directly.
- Non-PDF documents do not attempt inline browser preview; signers use `Download Document` to review those files.
- The send-document form accepts PDFs for signing so the in-browser signing experience matches the Adobe-style flow.
- When a signer completes signing, the server generates a signed certificate PDF recording:
  - document id and request id;
  - signer name and email;
  - typed signature;
  - signed timestamp;
  - captured IP address;
  - recipient audit id.
- The generated signed certificate PDF is uploaded to the existing `request-attachments` storage bucket and indexed through the existing `files` table as a request attachment.
- The signing page shows an `Open Signed Certificate` link after the recipient signs.

### Existing app impact

No existing tables were altered.

The original uploaded document is not modified in-place. This phase creates a separate signed proof certificate PDF. A future phase can add visual PDF stamping/placement on top of the original document if needed.
