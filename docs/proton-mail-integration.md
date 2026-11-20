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
  "subject": "Re: PDF remediation",
  "text": "The requested files are attached.",
  "receivedAt": "2026-10-30T10:30:00.000Z"
}
```

The app routes inbound mail only when the subject contains exactly one existing client/request tag pair, such as `[Test LLC] [REQ-1]`. `Re:`, `Fw:`, extra whitespace, and provider counters such as `[3]` do not affect the stable tags. The tagged request must belong to an existing client, and the sender must be that client's primary email, an existing contact on that request, a configured team member, or the configured Proton mailbox. This lets an owner or admin reply from their normal mailbox without using the portal composer, as long as the message reaches the monitored Proton inbox and keeps the stable tags. Untagged mail, mail for an unknown request, and mail from an unapproved sender are acknowledged as ignored and are never inserted into a client conversation. The external message ID prevents duplicates. Once a valid message is accepted, addresses found in `CC` are automatically added to that request's client contacts (excluding the primary contact and configured Proton mailbox), so an additional approved participant can continue the conversation.

Run `sql/2026-10-30-proton-mail-integration.sql` before enabling the worker.

### Manual refresh

The Refresh Messages button can ask the worker to run one immediate IMAP pass. Set `PROTON_INBOUND_REFRESH_URL` and `PROTON_INBOUND_REFRESH_SECRET` in Vercel, and expose an authenticated `POST` endpoint at that URL on the worker. The endpoint should start the same `processInbox()` function used by the background loop and return `202` immediately when a pass is queued (or already running); it should not keep an HTTP request open while the IMAP backlog is processed. The worker should skip messages without both bracket tags before posting to the app, and should distinguish `ignored: true` webhook responses from actual imports in its logs. If the URL is not configured, Refresh Messages still reloads the database but cannot pull mail out of Proton ahead of the worker's next poll.

The worker should also filter before calling Vercel to avoid transfer from unrelated mailbox traffic. After fetching an envelope, skip and mark as seen when the subject does not contain a request tag (`[REQ-12]`) and a second bracket tag for the client organization. After the webhook response, parse JSON and log `Ignored` when `ignored: true`; a 2xx response means the message was acknowledged, not necessarily stored.

## Outbound mail

The app can forward a request conversation message to the worker with `PROTON_MAIL_OUTBOUND_WEBHOOK_URL` and `PROTON_MAIL_OUTBOUND_WEBHOOK_SECRET`. The worker sends it through Proton Mail Bridge's SMTP service. The app does not store Proton credentials and does not attempt to reach a Bridge running on a user's laptop from Vercel.

The outbound payload includes both `text` and `html`. The worker should send them as a MIME `multipart/alternative` email: use `text` for the plain-text part and `html` for the HTML part. The HTML is already styled as Helvetica, 14px and converts plain `http://` and `https://` URLs into clickable links. Keeping both parts preserves readable mail clients that do not render HTML.
