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
