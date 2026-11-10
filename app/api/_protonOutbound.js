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

export async function sendProtonOutbound({ requestRow, senderProfile, message, subject, recipients: explicitRecipients }) {
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
  const threadId = requestThreadId(requestRow);
  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${secret}`
    },
    body: JSON.stringify({
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
      inReplyTo: threadId,
      references: threadId
    })
  });

  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    console.warn("[Clients] Proton outbound worker failed", detail);
    return { sent: false, configured: true, reason: detail || `Proton worker returned ${response.status}.` };
  }
  return { sent: true, configured: true, recipients: recipients.map((recipient) => recipient.email) };
}
