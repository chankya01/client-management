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
  const signingUrl = `${requestOrigin}/sign/${recipient.signing_token}`;
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
    signing_url: (isInternal || isOwnRecipient) ? signingUrl : null,
    document_title: documentTitle
  };
}

function cleanAgreementContent(body) {
  const title = String(body.title || "Service Agreement").trim();
  const agreementText = String(body.agreementText || "").trim();
  const legacyText = [
    body.scope ? `Project Scope\n${String(body.scope).trim()}` : "",
    body.services ? `Services\n${String(body.services).trim()}` : "",
    body.price ? `Price\n${String(body.price).trim()}` : "",
    body.timeline ? `Timeline\n${String(body.timeline).trim()}` : "",
    body.terms ? `Terms\n${String(body.terms).trim()}` : "",
    body.nextSteps ? `Next Steps\n${String(body.nextSteps).trim()}` : ""
  ].filter(Boolean).join("\n\n");
  return {
    title,
    agreementText: agreementText || legacyText || "Generated agreement"
  };
}

function parseAgreementSnapshot(events, document) {
  const snapshot = (events || []).find((event) => event.event_type === "agreement_snapshot");
  if (!snapshot?.event_note) {
    return { title: document?.title || "Service Agreement", agreementText: "" };
  }

  try {
    const parsed = JSON.parse(snapshot.event_note);
    return {
      title: document?.title || "Service Agreement",
      ...(parsed && typeof parsed === "object" ? parsed : {})
    };
  } catch {
    return { title: document?.title || "Service Agreement", agreementText: "" };
  }
}

async function ensureCompletedAgreementMessage(document, recipients, events, origin) {
  const completed = document?.status === "completed" || (events || []).some((event) => event.event_type === "completed");
  const signer = (recipients || []).find((recipient) => recipient.role === "signer" && recipient.status === "signed");
  if (!completed || !signer || !document?.uploaded_by || !document?.request_id) return;

  const signerName = signer.name || signer.email || "Client";
  const title = document.title || "Accessibility Services Proposal";
  const marker = `Agreement signed by ${signerName}: ${title}`;
  const existingMessages = await supabaseAdminFetch(
    tablePath("request_messages", `?select=id,message&request_id=eq.${encodeValue(document.request_id)}&order=created_at.desc&limit=100`)
  );
  if ((existingMessages || []).some((message) => String(message.message || "").includes(marker))) return;

  await supabaseAdminFetch(tablePath("request_messages"), {
    method: "POST",
    body: JSON.stringify({
      request_id: document.request_id,
      sender_id: document.uploaded_by,
      message: `${marker}. Signed at: ${signer.signed_at || "-"}. The signed agreement is ready to download.\nOpen signed agreement: ${origin}/sign/${signer.signing_token}`,
      is_internal: false
    })
  });
}

function agreementFileName(title) {
  const safeTitle = String(title || "Service Agreement")
    .replace(/[^a-zA-Z0-9._-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "") || "service-agreement";
  return `${safeTitle}.html`;
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

  const events = await supabaseAdminFetch(
    tablePath("signature_events", `?select=*&document_id=${inFilter(documentIds)}&order=created_at.asc`)
  );
  const eventsByDocument = new Map();
  (events || []).forEach((event) => {
    const list = eventsByDocument.get(event.document_id) || [];
    list.push(event);
    eventsByDocument.set(event.document_id, list);
  });

  await Promise.all(documents.map(async (document) => {
    try {
      await ensureCompletedAgreementMessage(
        document,
        recipientsByDocument.get(document.id) || [],
        eventsByDocument.get(document.id) || [],
        origin
      );
    } catch (error) {
      console.warn("[Clients] Completed agreement message reconciliation failed", error);
    }
  }));

  return Promise.all(documents.map(async (document) => {
    let documentUrl = null;
    try {
      if (document.mime_type === "text/html") {
        documentUrl = null;
      } else {
        documentUrl = await createStorageSignedUrl(document.bucket_name, document.storage_path);
      }
    } catch {
      documentUrl = null;
    }

    const documentEvents = eventsByDocument.get(document.id) || [];
    return {
      ...document,
      document_url: documentUrl,
      recipients: (recipientsByDocument.get(document.id) || []).map((recipient) => (
        publicRecipient(recipient, profile, document.title, origin)
      )),
      events: documentEvents,
      agreement: parseAgreementSnapshot(documentEvents, document),
      proposal_approved: documentEvents.some((event) => event.event_type === "proposal_approved")
    };
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
    const requiresSignature = body.requiresSignature !== false;
    if (!requestId || !(await requestIsVisible(profile, requestId))) {
      return apiJson({ error: "This request is not available to your account." }, 403);
    }

    const recipients = (body.recipients || [])
      .map((recipient, index) => ({
        name: String(recipient.name || "").trim(),
        email: normalizeEmail(recipient.email),
        role: requiresSignature && (recipient.role === "signer" || index === 0) ? "signer" : "viewer"
      }))
      .filter((recipient) => recipient.name && recipient.email);

    if (!recipients.length) {
      return apiJson({ error: "Add at least one recipient." }, 400);
    }
    const signerCount = recipients.filter((recipient) => recipient.role === "signer").length;
    if (requiresSignature && signerCount !== 1) {
      return apiJson({ error: "Add exactly one signing recipient. Additional recipients are view-only." }, 400);
    }
    const agreement = cleanAgreementContent(body);
    if (!agreement.agreementText) {
      return apiJson({ error: "Add the agreement text before sending." }, 400);
    }

    const createdDocuments = await supabaseAdminFetch(tablePath("signature_documents"), {
      method: "POST",
      headers: { Prefer: "return=representation" },
      body: JSON.stringify({
        request_id: requestId,
        uploaded_by: profile.id,
        title: agreement.title,
        status: "sent",
        bucket_name: body.bucketName || "request-attachments",
        storage_path: `agreements/${requestId}/${Date.now()}-${agreementFileName(agreement.title)}`,
        file_name: agreementFileName(agreement.title),
        mime_type: "text/html",
        file_size: JSON.stringify(agreement).length,
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
        event_type: "agreement_snapshot",
        event_note: JSON.stringify(agreement)
      })
    });

    await supabaseAdminFetch(tablePath("signature_events"), {
      method: "POST",
      body: JSON.stringify({
        document_id: document.id,
        event_type: "sent",
        event_note: `${requiresSignature ? "Sent for signature" : "Shared for viewing"} by ${profile.full_name || profile.email || "Team Member"}`
      })
    });

    const origin = new URL(request.url).origin;
    const emailResults = await Promise.all((recipientRows || []).map((recipient) => (
      sendSignatureRequestEmail({
        email: recipient.email,
        name: recipient.name,
        documentTitle: document.title,
        signingUrl: `${origin}/sign/${recipient.signing_token}`,
        requiresSignature: requiresSignature && recipient.role === "signer"
      })
    )));

    let messageResult = { created: false };
    try {
      const proposalLinks = (recipientRows || [])
        .filter((recipient) => recipient.signing_token)
        .map((recipient) => `${recipient.name || recipient.email}: ${origin}/sign/${recipient.signing_token}`)
        .join("\n");
      await supabaseAdminFetch(tablePath("request_messages"), {
        method: "POST",
        body: JSON.stringify({
          request_id: requestId,
          sender_id: profile.id,
          message: `${requiresSignature ? "Proposal sent for review" : "Proposal shared"}: ${document.title || "Accessibility Services Proposal"}.\n${proposalLinks ? `Open proposal:\n${proposalLinks}` : "Recipients received their private link by email."}`,
          is_internal: false
        })
      });
      messageResult = { created: true };
    } catch (messageError) {
      console.warn("[Clients] Signature document message entry failed", messageError);
      messageResult = { created: false, reason: messageError?.message || "Message entry could not be created." };
    }

    return apiJson({
      ...document,
      document_url: null,
      recipients: (recipientRows || []).map((recipient) => publicRecipient(recipient, profile, document.title, origin)),
      email_results: emailResults,
      message_result: messageResult
    }, 201);
  } catch (error) {
    return handleApiError(error);
  }
}
