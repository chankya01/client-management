import {
  encodeValue,
  inFilter,
  normalizeEmail,
  supabaseAdminFetch,
  tablePath
} from "./_supabaseAdmin.js";
import { appConfig } from "../../src/config.js";

function uniqueRecipients(recipients, senderEmail, excludedEmails = []) {
  const sender = normalizeEmail(senderEmail);
  const excluded = new Set((excludedEmails || []).map(normalizeEmail).filter(Boolean));
  const map = new Map();
  (recipients || []).forEach((recipient) => {
    const email = normalizeEmail(recipient.email);
    if (!email || email === sender || excluded.has(email)) return;
    if (!map.has(email)) map.set(email, {
      email,
      name: recipient.name || recipient.full_name || email
    });
  });
  return [...map.values()];
}

async function safeFetchRows(path) {
  try {
    return await supabaseAdminFetch(path);
  } catch (error) {
    if (String(error.message || "").includes("request_client_contacts")) return [];
    throw error;
  }
}

async function notificationRecipients(requestRow, senderProfile) {
  const configuredAdmins = (appConfig.adminEmails || []).map((email) => ({
    email: normalizeEmail(email),
    name: "Admin"
  }));
  const [admins, assignments, client, clientProfiles, requestContacts] = await Promise.all([
    supabaseAdminFetch(tablePath("profiles", "?select=id,full_name,email,role&role=in.(owner,project_manager)")),
    supabaseAdminFetch(tablePath("request_assignments", `?select=profile_id,user_id&request_id=eq.${encodeValue(requestRow.id)}`)),
    supabaseAdminFetch(tablePath("clients", `?select=primary_contact_email&id=eq.${encodeValue(requestRow.client_id)}&limit=1`)),
    supabaseAdminFetch(tablePath("profiles", `?select=id,full_name,email,role&client_id=eq.${encodeValue(requestRow.client_id)}&role=eq.client`)),
    safeFetchRows(tablePath("request_client_contacts", `?select=name,email,profile_id&request_id=eq.${encodeValue(requestRow.id)}`))
  ]);

  const assignedIds = [...new Set((assignments || [])
    .flatMap((assignment) => [assignment.profile_id, assignment.user_id])
    .filter(Boolean))];
  const assignedProfiles = assignedIds.length
    ? await supabaseAdminFetch(tablePath("profiles", `?select=id,full_name,email,role&id=in.(${assignedIds.map(encodeValue).join(",")})`))
    : [];

  return uniqueRecipients([
    ...configuredAdmins,
    ...(admins || []),
    ...(assignedProfiles || []),
    ...(clientProfiles || []).filter((profile) => (
      normalizeEmail(profile.email) === normalizeEmail(client?.[0]?.primary_contact_email)
    )),
    ...(requestContacts || [])
  ], senderProfile.email);
}

function requestThreadId(requestRow) {
  const value = String(requestRow?.id || requestRow?.request_number || "request")
    .replace(/[^a-zA-Z0-9._-]/g, "-");
  return `<clients-request-${value}@accessible.org>`;
}

async function previousThreadMessage(requestRow) {
  try {
    const rows = await supabaseAdminFetch(
      tablePath(
        "request_messages",
        `?select=external_message_id,external_thread_id&request_id=eq.${encodeValue(requestRow.id)}&external_message_id=not.is.null&order=created_at.desc&limit=1`
      )
    );
    return rows?.[0] || null;
  } catch (error) {
    // Older projects may not have the Proton metadata columns yet. The
    // stable request root still gives those projects deterministic headers.
    if (String(error.message || "").includes("external_message_id")) return null;
    throw error;
  }
}

function outboundMessageId(threadId, hasParent) {
  if (!hasParent) return threadId;
  const randomPart = typeof globalThis.crypto?.randomUUID === "function"
    ? globalThis.crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return `<clients-message-${randomPart}@accessible.org>`;
}

export async function sendProtonOutbound({ requestRow, senderProfile, message, subject, recipients: explicitRecipients, messageRowId }) {
  const endpoint = String(process.env.PROTON_MAIL_OUTBOUND_WEBHOOK_URL || "").trim();
  if (!endpoint) return { sent: false, configured: false, reason: "Proton outbound worker is not configured." };

  const secret = String(process.env.PROTON_MAIL_OUTBOUND_WEBHOOK_SECRET || "").trim();
  if (!secret) return { sent: false, configured: true, reason: "PROTON_MAIL_OUTBOUND_WEBHOOK_SECRET is not configured." };

  const recipients = explicitRecipients
    ? uniqueRecipients(explicitRecipients, senderProfile.email)
    : await notificationRecipients(requestRow, senderProfile);
  if (!recipients.length) return { sent: false, configured: true, reason: "No email recipients were found for this request." };

  const requestNumber = String(requestRow.request_number || requestRow.id);
  const cleanSubject = String(subject || requestRow.title || "Request").trim();
  const fallbackThreadId = requestThreadId(requestRow);
  const previous = await previousThreadMessage(requestRow);
  const threadId = previous?.external_thread_id || fallbackThreadId;
  const inReplyTo = previous?.external_message_id || "";
  const references = [previous?.external_thread_id, previous?.external_message_id]
    .filter(Boolean)
    .join(" ") || "";
  const messageId = outboundMessageId(threadId, Boolean(previous?.external_message_id));
  const payload = JSON.stringify({
    from: process.env.PROTON_MAIL_FROM || "",
    to: recipients.map((recipient) => recipient.email),
    subject: cleanSubject,
    text: message,
    requestId: requestRow.id,
    requestNumber,
    sentAt: new Date().toISOString(),
    sender: senderProfile.email,
    // The worker must copy these values to SMTP In-Reply-To and References
    // headers. A stable request root keeps proposal, status, and message
    // emails in one conversation even when the subject is unchanged.
    threadId,
    messageId,
    inReplyTo,
    references
  });

  // A slow or briefly unavailable Lightsail worker should not leave the
  // portal button spinning forever. Retry one transient failure, then return
  // a structured delivery result so the message can remain saved in the
  // conversation without users accidentally sending duplicates.
  const timeoutMs = Math.max(3000, Number(process.env.PROTON_MAIL_OUTBOUND_TIMEOUT_MS || 8000));
  let response;
  let lastError;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      response = await fetch(endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${secret}`
        },
        body: payload,
        signal: controller.signal
      });
      if (response.ok || response.status < 500 || attempt === 1) break;
    } catch (error) {
      lastError = error;
      if (attempt === 1) break;
    } finally {
      clearTimeout(timeout);
    }
  }

  if (!response) {
    const reason = lastError?.name === "AbortError"
      ? `Proton worker timed out after ${timeoutMs}ms.`
      : lastError?.message || "Proton worker could not be reached.";
    console.warn("[Clients] Proton outbound worker unavailable", reason);
    return { sent: false, configured: true, reason };
  }

  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    console.warn("[Clients] Proton outbound worker failed", detail);
    return { sent: false, configured: true, reason: detail || `Proton worker returned ${response.status}.` };
  }

  if (messageRowId) {
    try {
      await supabaseAdminFetch(tablePath("request_messages", `?id=eq.${encodeValue(messageRowId)}`), {
        method: "PATCH",
        body: JSON.stringify({
          external_message_id: messageId,
          external_thread_id: threadId,
          external_subject: cleanSubject,
          external_sender_email: senderProfile.email,
          source: "proton_outbound"
        })
      });
    } catch (error) {
      // Delivery succeeded; metadata persistence must not turn it into a
      // failed send. The next message can fall back to the stable root.
      console.warn("[Clients] Proton outbound metadata could not be saved", error);
    }
  }

  return {
    sent: true,
    configured: true,
    messageId,
    threadId,
    recipients: recipients.map((recipient) => recipient.email)
  };
}
