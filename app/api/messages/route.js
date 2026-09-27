import {
  apiJson,
  currentProfile,
  encodeValue,
  handleApiError,
  supabaseAdminFetch,
  tablePath
} from "../_supabaseAdmin.js";

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

  const attachmentMessages = (attachments || []).map((file) => ({
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
      if (!linkedRequest || linkedRequest.client_id !== profile.client_id) {
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
