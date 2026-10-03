import {
  apiJson,
  createStorageSignedUrl,
  currentProfile,
  encodeValue,
  handleApiError,
  inFilter,
  internalRoles,
  managementRoles,
  normalizeEmail,
  sendSignatureRequestEmail,
  supabaseAdminFetch,
  tablePath,
  visibleRequestIdsForClientProfile
} from "../_supabaseAdmin.js";

async function visibleRequestIds(profile) {
  if (managementRoles.has(profile.role)) {
    const rows = await supabaseAdminFetch(tablePath("requests", "?select=id"));
    return (rows || []).map((request) => request.id).filter(Boolean);
  }

  if (profile.role === "client") return visibleRequestIdsForClientProfile(profile);

  if (internalRoles.has(profile.role)) {
    const rows = await supabaseAdminFetch(
      tablePath("request_assignments", `?select=request_id&or=(profile_id.eq.${encodeValue(profile.id)},user_id.eq.${encodeValue(profile.id)})`)
    );
    return [...new Set((rows || []).map((row) => row.request_id).filter(Boolean))];
  }

  return [];
}

async function requestIsVisible(profile, requestId) {
  const requestIds = await visibleRequestIds(profile);
  return requestIds.includes(requestId);
}

function publicRecipient(recipient, profile, documentTitle, requestOrigin) {
  const isInternal = internalRoles.has(profile.role);
  const isOwnRecipient = normalizeEmail(recipient.email) === normalizeEmail(profile.email);
  return {
    id: recipient.id,
    document_id: recipient.document_id,
    name: recipient.name,
    email: recipient.email,
    role: recipient.role,
    status: recipient.status,
    viewed_at: recipient.viewed_at,
    signed_at: recipient.signed_at,
    declined_at: recipient.declined_at,
    signing_url: (isInternal || isOwnRecipient)
      ? `${requestOrigin}/?sign=${recipient.signing_token}`
      : null,
    document_title: documentTitle
  };
}

async function documentsForProfile(profile, origin) {
  const requestIds = await visibleRequestIds(profile);
  if (!requestIds.length) return [];

  const documents = await supabaseAdminFetch(
    tablePath("signature_documents", `?select=*&request_id=${inFilter(requestIds)}&order=created_at.desc`)
  );
  if (!documents?.length) return [];

  const documentIds = documents.map((document) => document.id);
  const recipients = await supabaseAdminFetch(
    tablePath("signature_recipients", `?select=*&document_id=${inFilter(documentIds)}&order=created_at.asc`)
  );
  const recipientsByDocument = new Map();
  (recipients || []).forEach((recipient) => {
    const list = recipientsByDocument.get(recipient.document_id) || [];
    list.push(recipient);
    recipientsByDocument.set(recipient.document_id, list);
  });

  return documents.map((document) => ({
    ...document,
    recipients: (recipientsByDocument.get(document.id) || []).map((recipient) => (
      publicRecipient(recipient, profile, document.title, origin)
    ))
  }));
}

export async function GET(request) {
  try {
    const profile = await currentProfile(request);
    const origin = new URL(request.url).origin;
    return apiJson(await documentsForProfile(profile, origin));
  } catch (error) {
    return handleApiError(error);
  }
}

export async function POST(request) {
  try {
    const profile = await currentProfile(request);
    if (!internalRoles.has(profile.role)) {
      return apiJson({ error: "Only internal team members can send documents for signature." }, 403);
    }

    const body = await request.json();
    const requestId = body.requestId;
    if (!requestId || !(await requestIsVisible(profile, requestId))) {
      return apiJson({ error: "This request is not available to your account." }, 403);
    }

    const recipients = (body.recipients || [])
      .map((recipient) => ({
        name: String(recipient.name || "").trim(),
        email: normalizeEmail(recipient.email),
        role: recipient.role === "viewer" ? "viewer" : "signer"
      }))
      .filter((recipient) => recipient.name && recipient.email);

    if (!recipients.length) {
      return apiJson({ error: "Add at least one recipient." }, 400);
    }
    if (!body.storagePath || !body.fileName) {
      return apiJson({ error: "Upload a document before sending for signature." }, 400);
    }

    const createdDocuments = await supabaseAdminFetch(tablePath("signature_documents"), {
      method: "POST",
      headers: { Prefer: "return=representation" },
      body: JSON.stringify({
        request_id: requestId,
        uploaded_by: profile.id,
        title: body.title || body.fileName || "Signature document",
        status: "sent",
        bucket_name: body.bucketName || "request-attachments",
        storage_path: body.storagePath,
        file_name: body.fileName,
        mime_type: body.mimeType || null,
        file_size: body.fileSize || null,
        sent_at: new Date().toISOString()
      })
    });
    const document = createdDocuments?.[0];
    if (!document?.id) throw new Error("Document could not be created.");

    const recipientRows = await supabaseAdminFetch(tablePath("signature_recipients"), {
      method: "POST",
      headers: { Prefer: "return=representation" },
      body: JSON.stringify(recipients.map((recipient) => ({
        document_id: document.id,
        ...recipient,
        status: "sent"
      })))
    });

    await supabaseAdminFetch(tablePath("signature_events"), {
      method: "POST",
      body: JSON.stringify({
        document_id: document.id,
        event_type: "sent",
        event_note: `Sent by ${profile.full_name || profile.email || "Team Member"}`
      })
    });

    const origin = new URL(request.url).origin;
    const emailResults = await Promise.all((recipientRows || []).map((recipient) => (
      sendSignatureRequestEmail({
        email: recipient.email,
        name: recipient.name,
        documentTitle: document.title,
        signingUrl: `${origin}/?sign=${recipient.signing_token}`
      })
    )));

    let documentUrl = null;
    try {
      documentUrl = await createStorageSignedUrl(document.bucket_name, document.storage_path);
    } catch {
      documentUrl = null;
    }

    return apiJson({
      ...document,
      document_url: documentUrl,
      recipients: (recipientRows || []).map((recipient) => publicRecipient(recipient, profile, document.title, origin)),
      email_results: emailResults
    }, 201);
  } catch (error) {
    return handleApiError(error);
  }
}
