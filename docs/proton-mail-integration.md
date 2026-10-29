# Proton Mail integration

The web app does not connect directly to Proton Mail. Proton's supported IMAP/SMTP integration is Proton Mail Bridge, which runs a local IMAP/SMTP server. Run the Bridge and a small always-on worker on the same machine (or VPS), then let that worker call the app webhook.

## Inbound mail

Set `PROTON_INBOUND_WEBHOOK_SECRET` in Vercel and send this request from the worker:

```http
POST /api/integrations/proton/messages
X-Proton-Webhook-Secret: <same secret>
Content-Type: application/json
```

```json
{
  "messageId": "bridge-message-id",
  "threadId": "bridge-thread-id",
  "from": "client@example.com",
  "subject": "Re: REQ-12 PDF remediation",
  "text": "The requested files are attached.",
  "receivedAt": "2026-10-30T10:30:00.000Z"
}
```

The app matches the request number in the subject first (`REQ-12`). If it is absent, it matches the sender to the client's primary email or a request contact. The message is inserted into that request's conversation and the external message ID prevents duplicates.

Run `sql/2026-10-30-proton-mail-integration.sql` before enabling the worker.

## Outbound mail

The app can forward a request conversation message to the worker with `PROTON_MAIL_OUTBOUND_WEBHOOK_URL` and `PROTON_MAIL_OUTBOUND_WEBHOOK_SECRET`. The worker sends it through Proton Mail Bridge's SMTP service. The app does not store Proton credentials and does not attempt to reach a Bridge running on a user's laptop from Vercel.
