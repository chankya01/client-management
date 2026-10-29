import {
  apiJson,
  encodeValue,
  handleApiError,
  inFilter,
  normalizeEmail,
  supabaseAdminFetch,
  tablePath
} from "../../../_supabaseAdmin.js";

function configuredSecret() {
  return String(process.env.PROTON_INBOUND_WEBHOOK_SECRET || "").trim();
}

function authorized(request) {
  const expected = configuredSecret();
  if (!expected) return false;
  const provided = request.headers.get("x-proton-webhook-secret")
    || request.headers.get("authorization")?.replace(/^Bearer\s+/i, "").trim();
  return provided === expected;
}

function emailAddress(value) {
  if (value && typeof value === "object") {
    return normalizeEmail(value.address || value.email || value.value || "");
  }
  const text = String(value || "").trim();
  const bracketed = text.match(/<([^>]+)>/);
  return normalizeEmail(bracketed?.[1] || text.replace(/^.*?\s+/, ""));
}

function cleanBody(payload) {
  const plain = payload.text || payload.textPlain || payload.text_plain || payload.body || "";
  if (String(plain).trim()) return String(plain).trim();
  const html = String(payload.html || payload.textHtml || payload.text_html || "");
  return html
    .replace(/<br\s*\/?>(?=\s*)/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/\s+\n/g, "\n")
    .replace(/\n\s+/g, "\n")
    .trim();
}

function requestReference(subject) {
  const value = String(subject || "");
  const requestNumber = value.match(/\bREQ-\d{1,6}\b/i)?.[0]?.toUpperCase() || null;
  const requestId = value.match(/\b[0-9a-f]{8}-[0-9a-f-]{27,}\b/i)?.[0] || null;
  return { requestNumber, requestId };
}

async function requestsForSender(sender) {
  const clients = await supabaseAdminFetch(
    tablePath("clients", `?select=id&primary_contact_email=eq.${encodeValue(sender)}`)
  );
  const clientIds = (clients || []).map((client) => client.id).filter(Boolean);
  const clientRequests = clientIds.length
    ? await supabaseAdminFetch(tablePath("requests", `?select=id,request_number,title,client_id&client_id=${inFilter(clientIds)}&order=created_at.desc`))
    : [];

  let contactRows = [];
  try {
    contactRows = await supabaseAdminFetch(
      tablePath("request_client_contacts", `?select=request_id,email&email=eq.${encodeValue(sender)}`)
    );
  } catch (error) {
    if (!String(error.message || "").includes("request_client_contacts")) throw error;
  }

  const contactRequestIds = [...new Set((contactRows || []).map((row) => row.request_id).filter(Boolean))];
  const contactRequests = contactRequestIds.length
    ? await supabaseAdminFetch(tablePath("requests", `?select=id,request_number,title,client_id&id=${inFilter(contactRequestIds)}&order=created_at.desc`))
    : [];

  return [...(clientRequests || []), ...(contactRequests || [])]
    .filter((request, index, rows) => rows.findIndex((candidate) => candidate.id === request.id) === index);
}

async function resolveRequest(subject, sender) {
  const { requestNumber, requestId } = requestReference(subject);
  if (requestId) {
    const rows = await supabaseAdminFetch(
      tablePath("requests", `?select=id,request_number,title,client_id&id=eq.${encodeValue(requestId)}&limit=1`)
    );
    if (rows?.[0]) return rows[0];
  }
  if (requestNumber) {
    const rows = await supabaseAdminFetch(
      tablePath("requests", `?select=id,request_number,title,client_id&request_number=eq.${encodeValue(requestNumber)}&limit=1`)
    );
    if (rows?.[0]) return rows[0];
  }

  const candidates = await requestsForSender(sender);
  if (candidates.length === 1) return candidates[0];
  if (!candidates.length) {
    throw new Error("No request matched this Proton message. Include the request number (for example, REQ-12) in the subject or link the sender to a request contact.");
  }
  throw new Error("More than one request matches this Proton sender. Include the request number (for example, REQ-12) in the subject.");
}

async function senderCanUseRequest(requestRow, sender) {
  const clients = await supabaseAdminFetch(
    tablePath("clients", `?select=primary_contact_email&id=eq.${encodeValue(requestRow.client_id)}&limit=1`)
  );
  if (normalizeEmail(clients?.[0]?.primary_contact_email) === sender) return true;

  try {
    const contacts = await supabaseAdminFetch(
      tablePath("request_client_contacts", `?select=id&request_id=eq.${encodeValue(requestRow.id)}&email=eq.${encodeValue(sender)}&limit=1`)
    );
    return Boolean(contacts?.length);
  } catch (error) {
    if (!String(error.message || "").includes("request_client_contacts")) throw error;
    return false;
  }
}

export async function POST(request) {
  try {
    if (!authorized(request)) return apiJson({ error: "Invalid Proton webhook secret." }, 401);

    const payload = await request.json();
    const sender = emailAddress(payload.from || payload.sender || payload.senderEmail);
    const subject = String(payload.subject || "").trim();
    const body = cleanBody(payload);
    const externalMessageId = String(payload.messageId || payload.message_id || payload.id || "").trim();
    const externalThreadId = String(payload.threadId || payload.thread_id || payload.inReplyTo || payload.in_reply_to || "").trim();

    if (!sender || !subject || !body) return apiJson({ error: "from, subject, and a non-empty message body are required." }, 400);
    if (!externalMessageId) return apiJson({ error: "messageId is required so Proton messages can be de-duplicated." }, 400);

    const existing = await supabaseAdminFetch(
      tablePath("request_messages", `?select=id,request_id&external_message_id=eq.${encodeValue(externalMessageId)}&limit=1`)
    );
    if (existing?.[0]) return apiJson({ ok: true, duplicate: true, messageId: existing[0].id, requestId: existing[0].request_id });

    const requestRow = await resolveRequest(subject, sender);
    if (!(await senderCanUseRequest(requestRow, sender))) {
      throw new Error("The Proton sender is not linked to the request named in the subject.");
    }
    const profiles = await supabaseAdminFetch(
      tablePath("profiles", `?select=id,full_name,email,role&email=eq.${encodeValue(sender)}&limit=1`)
    );
    const senderProfile = profiles?.[0];
    if (!senderProfile?.id) throw new Error(`No signed-in client profile is linked to ${sender}. Link the sender before importing Proton messages.`);

    const rows = await supabaseAdminFetch(tablePath("request_messages"), {
      method: "POST",
      headers: { Prefer: "return=representation" },
      body: JSON.stringify({
        request_id: requestRow.id,
        sender_id: senderProfile.id,
        message: body,
        is_internal: false,
        external_message_id: externalMessageId,
        external_thread_id: externalThreadId || null,
        external_subject: subject,
        external_sender_email: sender,
        source: "proton"
      })
    });

    return apiJson({ ok: true, requestId: requestRow.id, messageId: rows?.[0]?.id || null });
  } catch (error) {
    return handleApiError(error);
  }
}
