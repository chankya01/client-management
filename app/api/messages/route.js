import {
  apiJson,
  currentProfile,
  encodeValue,
  handleApiError,
  internalRoles,
  managementRoles,
  normalizeEmail,
  supabaseAdminFetch,
  tablePath
} from "../_supabaseAdmin.js";
import { appConfig } from "../../../src/config.js";

function senderIdsFromMessages(messages) {
  return [...new Set((messages || []).map((message) => message.sender_id).filter(Boolean))];
}

async function attachProfiles(messages) {
  const senderIds = senderIdsFromMessages(messages);
  if (!senderIds.length) return messages || [];

  const profiles = await supabaseAdminFetch(
    tablePath("profiles", `?select=id,full_name,role&id=in.(${senderIds.map(encodeValue).join(",")})`)
  );
  const profileMap = Object.fromEntries((profiles || []).map((profile) => [profile.id, profile]));
  return (messages || []).map((message) => ({
    ...message,
    profiles: message.profiles?.full_name ? message.profiles : profileMap[message.sender_id] || message.profiles
  }));
}

async function loadRequestAttachments(requestId) {
  let files;
  try {
    files = await supabaseAdminFetch(
      tablePath("files", `?select=id,request_id,client_id,uploaded_by,category,bucket_name,storage_path,file_name,mime_type,file_size,created_at&request_id=eq.${encodeValue(requestId)}&category=eq.attachment&order=created_at.asc`)
    );
  } catch (error) {
    if (!String(error.message || "").includes("created_at")) throw error;
    files = await supabaseAdminFetch(
      tablePath("files", `?select=id,request_id,client_id,uploaded_by,category,bucket_name,storage_path,file_name,mime_type,file_size&request_id=eq.${encodeValue(requestId)}&category=eq.attachment`)
    );
  }

  const uploaderIds = [...new Set((files || []).map((file) => file.uploaded_by).filter(Boolean))];
  let profileMap = {};
  if (uploaderIds.length) {
    const profiles = await supabaseAdminFetch(
      tablePath("profiles", `?select=id,full_name,role&id=in.(${uploaderIds.map(encodeValue).join(",")})`)
    );
    profileMap = Object.fromEntries((profiles || []).map((profile) => [profile.id, profile]));
  }

  return (files || []).map((file) => ({
    ...file,
    created_at: file.created_at || null,
    profiles: profileMap[file.uploaded_by] || null
  }));
}

function mergeMessagesAndAttachments(messages, attachments) {
  const attachmentNames = new Set((attachments || []).map((file) => String(file.file_name || "").trim().toLowerCase()));
  const visibleMessages = (messages || []).filter((message) => {
    const match = String(message.message || "").match(/^Attachment uploaded:\s*(.+)$/i);
    return !match || !attachmentNames.has(match[1].trim().toLowerCase());
  });
  const pairedAttachmentIds = new Set();

  (attachments || []).forEach((file) => {
    const fileTime = new Date(file.created_at || 0).getTime();
    if (!fileTime) return;
    const matchingMessage = [...visibleMessages].reverse().find((message) => (
      message.sender_id === file.uploaded_by
      && !message.attachment
      && String(message.message || "").trim()
      && Math.abs(fileTime - new Date(message.created_at || 0).getTime()) <= 30000
    ));
    if (matchingMessage) {
      matchingMessage.attachment = file;
      pairedAttachmentIds.add(file.id);
    }
  });

  const attachmentMessages = (attachments || []).filter((file) => !pairedAttachmentIds.has(file.id)).map((file) => ({
    id: `attachment-${file.id}`,
    request_id: file.request_id,
    sender_id: file.uploaded_by,
    message: "Attachment",
    is_internal: false,
    created_at: file.created_at || new Date().toISOString(),
    profiles: file.profiles || { full_name: "Team Member", role: "developer" },
    attachment: file
  }));

  return [...visibleMessages, ...attachmentMessages].sort((left, right) => (
    new Date(left.created_at || 0).getTime() - new Date(right.created_at || 0).getTime()
  ));
}

async function safeFetchRows(path) {
  try {
    return await supabaseAdminFetch(path);
  } catch (error) {
    const message = String(error.message || "");
    if (message.includes("request_client_contacts")) return [];
    throw error;
  }
}

function uniqueRecipients(recipients, senderEmail, excludedEmails = []) {
  const sender = normalizeEmail(senderEmail);
  const excluded = new Set((excludedEmails || []).map(normalizeEmail).filter(Boolean));
  const map = new Map();
  (recipients || []).forEach((recipient) => {
    const email = normalizeEmail(recipient.email);
    if (!email || email === sender || excluded.has(email)) return;
    if (!map.has(email)) {
      map.set(email, {
        email,
        name: recipient.name || recipient.full_name || email
      });
    }
  });
  return [...map.values()];
}

async function requestIsVisibleToProfile(requestRow, profile) {
  if (managementRoles.has(profile.role)) return true;
  if (profile.role === "client") {
    const client = await supabaseAdminFetch(
      tablePath("clients", `?select=primary_contact_email&id=eq.${encodeValue(requestRow.client_id)}&limit=1`)
    );
    if (
      requestRow.client_id === profile.client_id
      && normalizeEmail(client?.[0]?.primary_contact_email) === normalizeEmail(profile.email)
    ) return true;
    const contacts = await safeFetchRows(
      tablePath("request_client_contacts", `?select=id&request_id=eq.${encodeValue(requestRow.id)}&or=(profile_id.eq.${encodeValue(profile.id)},email.eq.${encodeValue(normalizeEmail(profile.email))})&limit=1`)
    );
    return Boolean(contacts?.length);
  }
  if (internalRoles.has(profile.role)) {
    const assignments = await supabaseAdminFetch(
      tablePath("request_assignments", `?select=request_id&request_id=eq.${encodeValue(requestRow.id)}&or=(profile_id.eq.${encodeValue(profile.id)},user_id.eq.${encodeValue(profile.id)})&limit=1`)
    );
    return Boolean(assignments?.length);
  }
  return false;
}

async function notificationRecipients(requestRow, senderProfile, excludedEmails = []) {
  const configuredAdmins = (appConfig.adminEmails || []).map((email) => ({
    email: normalizeEmail(email),
    name: "Admin"
  }));
  const [admins, assignments, client, clientProfiles, requestContacts] = await Promise.all([
    supabaseAdminFetch(
      tablePath("profiles", "?select=id,full_name,email,role&role=in.(owner,project_manager)")
    ),
    supabaseAdminFetch(
      tablePath("request_assignments", `?select=profile_id,user_id&request_id=eq.${encodeValue(requestRow.id)}`)
    ),
    supabaseAdminFetch(
      tablePath("clients", `?select=primary_contact_email&id=eq.${encodeValue(requestRow.client_id)}&limit=1`)
    ),
    supabaseAdminFetch(
      tablePath("profiles", `?select=id,full_name,email,role&client_id=eq.${encodeValue(requestRow.client_id)}&role=eq.client`)
    ),
    safeFetchRows(
      tablePath("request_client_contacts", `?select=name,email,profile_id&request_id=eq.${encodeValue(requestRow.id)}`)
    )
  ]);

  const assignedIds = [...new Set((assignments || [])
    .flatMap((assignment) => [assignment.profile_id, assignment.user_id])
    .filter(Boolean))];
  const assignedProfiles = assignedIds.length
    ? await supabaseAdminFetch(
      tablePath("profiles", `?select=id,full_name,email,role&id=in.(${assignedIds.map(encodeValue).join(",")})`)
    )
    : [];

  return uniqueRecipients([
    ...configuredAdmins,
    ...(admins || []),
    ...(assignedProfiles || []),
    ...(clientProfiles || []).filter((profile) => (
      normalizeEmail(profile.email) === normalizeEmail(client?.[0]?.primary_contact_email)
    )),
    ...(requestContacts || [])
  ], senderProfile.email, excludedEmails);
}

async function requestLabel(requestRow) {
  const storedNumber = String(requestRow?.request_number || "").trim();
  if (/^REQ-\d{1,3}$/i.test(storedNumber)) return storedNumber.toUpperCase();

  if (requestRow?.client_id) {
    const relatedRequests = await supabaseAdminFetch(
      tablePath("requests", `?select=id,request_number,created_at&client_id=eq.${encodeValue(requestRow.client_id)}&order=created_at.asc`)
    );
    const requestIndex = (relatedRequests || []).findIndex((request) => request.id === requestRow.id);
    if (requestIndex >= 0) return `REQ-${requestIndex + 1}`;
  }

  return storedNumber || requestRow?.title || "the request";
}

async function senderDisplayName(requestRow, senderProfile) {
  if (senderProfile?.role === "client") {
    const senderEmail = normalizeEmail(senderProfile.email);
    const contacts = await safeFetchRows(
      tablePath("request_client_contacts", `?select=name,email,profile_id&request_id=eq.${encodeValue(requestRow.id)}&or=(profile_id.eq.${encodeValue(senderProfile.id)},email.eq.${encodeValue(senderEmail)})&limit=1`)
    );
    const contactName = String(contacts?.[0]?.name || "").trim();
    if (contactName) return contactName;

    const client = await supabaseAdminFetch(
      tablePath("clients", `?select=primary_contact_name,primary_contact_email&id=eq.${encodeValue(requestRow.client_id)}&limit=1`)
    );
    const primaryContactName = String(client?.[0]?.primary_contact_name || "").trim();
    if (primaryContactName) return primaryContactName;
  }

  return senderProfile.full_name || senderProfile.email || "someone";
}

async function sendMessageNotification({ requestRow, senderProfile, excludedEmails = [] }) {
  const apiKey = process.env.RESEND_API_KEY;
  const from = process.env.NOTIFICATION_FROM || "Clients <notifications@example.com>";
  const appUrl = process.env.APP_URL || process.env.NEXT_PUBLIC_APP_URL || "";
  if (!apiKey) {
    throw new Error("RESEND_API_KEY is not configured. Message was not sent.");
  }
  if (from.includes("yourdomain.com") || from.includes("example.com")) {
    throw new Error("NOTIFICATION_FROM still uses a placeholder domain. Add a verified Resend sender/domain.");
  }

  const recipients = await notificationRecipients(requestRow, senderProfile, excludedEmails);
  if (!recipients.length) {
    return { sent: false, reason: "No email recipients were found after applying exclusions.", recipients: [] };
  }

  const label = await requestLabel(requestRow);
  const senderName = await senderDisplayName(requestRow, senderProfile);
  const link = appUrl ? `\n\nOpen Clients: ${appUrl}` : "";
  const text = `Hi,\n\nThere is an update on ${label} from ${senderName}. Please sign in to view it.${link}`;

  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      from,
      to: recipients.map((recipient) => recipient.email),
      subject: `Update on ${label}`,
      text
    })
  });

  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    console.warn("[Clients] Message notification email failed", detail);
    throw new Error(detail || `Resend returned ${response.status}.`);
  }

  const payload = await response.json().catch(() => ({}));
  return {
    sent: true,
    id: payload?.id || null,
    recipients: recipients.map((recipient) => recipient.email)
  };
}

export async function GET(request) {
  try {
    const url = new URL(request.url);
    const requestId = url.searchParams.get("requestId");
    if (!requestId) return apiJson({ error: "Request id is required." }, 400);

    const profile = await currentProfile(request);
    if (profile.role === "client") {
      const rows = await supabaseAdminFetch(
        tablePath("requests", `?select=id,client_id&id=eq.${encodeValue(requestId)}&limit=1`)
      );
      const linkedRequest = rows?.[0];
      if (!linkedRequest || !(await requestIsVisibleToProfile(linkedRequest, profile))) {
        return apiJson({ error: "This request is not linked to your client profile." }, 403);
      }
    }

    const messages = await supabaseAdminFetch(
      tablePath("request_messages", `?select=id,request_id,sender_id,message,is_internal,created_at&request_id=eq.${encodeValue(requestId)}&order=created_at.asc`)
    );
    const enrichedMessages = await attachProfiles(messages || []);
    const attachments = await loadRequestAttachments(requestId);

    return apiJson(mergeMessagesAndAttachments(enrichedMessages, attachments));
  } catch (error) {
    return handleApiError(error);
  }
}

export async function POST(request) {
  try {
    const profile = await currentProfile(request);
    const body = await request.json();
    const requestId = body.requestId;
    const message = String(body.message || "").trim();
    if (!requestId) return apiJson({ error: "Request id is required." }, 400);
    if (!message) return apiJson({ error: "Message is required." }, 400);

    const requests = await supabaseAdminFetch(
      tablePath("requests", `?select=id,request_number,title,client_id&id=eq.${encodeValue(requestId)}&limit=1`)
    );
    const requestRow = requests?.[0];
    if (!requestRow) return apiJson({ error: "Request not found." }, 404);

    const canAccess = await requestIsVisibleToProfile(requestRow, profile);
    if (!canAccess) return apiJson({ error: "This request is not linked to your account." }, 403);

    await supabaseAdminFetch(tablePath("request_messages"), {
      method: "POST",
      body: JSON.stringify({
        request_id: requestId,
        sender_id: profile.id,
        message,
        is_internal: false
      })
    });

    const notification = body.notify !== false
      ? await sendMessageNotification({ requestRow, senderProfile: profile, excludedEmails: body.excludeEmails || [] })
      : { sent: false, reason: "Notification disabled for this message." };

    return apiJson({ ok: true, notification });
  } catch (error) {
    return handleApiError(error);
  }
}
