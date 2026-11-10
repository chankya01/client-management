import {
  apiJson,
  encodeValue,
  handleApiError,
  normalizeEmail,
  publicAppOrigin,
  supabaseAdminFetch,
  tablePath
} from "../../_supabaseAdmin.js";
import { sendProtonOutbound } from "../../_protonOutbound.js";

function defaultAgreement(document) {
  return {
    title: document?.title || "Service Agreement",
    agreementText: ""
  };
}

function parseAgreementSnapshot(events, document) {
  const snapshot = (events || []).find((event) => event.event_type === "agreement_snapshot");
  if (!snapshot?.event_note) return defaultAgreement(document);

  try {
    const parsed = JSON.parse(snapshot.event_note);
    return {
      ...defaultAgreement(document),
      ...(parsed && typeof parsed === "object" ? parsed : {})
    };
  } catch {
    return defaultAgreement(document);
  }
}

function proposalApproved(events) {
  return (events || []).some((event) => event.event_type === "proposal_approved");
}

async function loadSignature(token) {
  const recipients = await supabaseAdminFetch(
    tablePath("signature_recipients", `?select=*&signing_token=eq.${encodeValue(token)}&limit=1`)
  );
  const recipient = recipients?.[0];
  if (!recipient?.id) {
    const error = new Error("This signing link is invalid or expired.");
    error.status = 404;
    throw error;
  }

  const documents = await supabaseAdminFetch(
    tablePath("signature_documents", `?select=*&id=eq.${encodeValue(recipient.document_id)}&limit=1`)
  );
  const document = documents?.[0];
  if (!document?.id) {
    const error = new Error("The agreement for this signing link could not be found.");
    error.status = 404;
    throw error;
  }

  const [allRecipients, events] = await Promise.all([
    supabaseAdminFetch(
      tablePath("signature_recipients", `?select=id,name,email,role,status,viewed_at,signed_at,declined_at&document_id=eq.${encodeValue(document.id)}&order=created_at.asc`)
    ),
    supabaseAdminFetch(
      tablePath("signature_events", `?select=*&document_id=eq.${encodeValue(document.id)}&order=created_at.asc`)
    )
  ]);

  return {
    document,
    recipient,
    recipients: allRecipients || [],
    events: events || [],
    agreement: parseAgreementSnapshot(events, document),
    proposalApproved: proposalApproved(events)
  };
}

export async function GET(request, { params }) {
  try {
    const payload = await loadSignature(params.token);
    await requireMatchingPortalSessionIfNeeded(request, payload.recipient);

    if (payload.recipient.status === "sent") {
      const now = new Date().toISOString();
      await supabaseAdminFetch(tablePath("signature_recipients", `?id=eq.${encodeValue(payload.recipient.id)}`), {
        method: "PATCH",
        body: JSON.stringify({ status: "viewed", viewed_at: now })
      });
      if (payload.document.status === "sent") {
        await supabaseAdminFetch(tablePath("signature_documents", `?id=eq.${encodeValue(payload.document.id)}`), {
          method: "PATCH",
          body: JSON.stringify({ status: "viewed", updated_at: now })
        });
        payload.document.status = "viewed";
        payload.document.updated_at = now;
      }
      await supabaseAdminFetch(tablePath("signature_events"), {
        method: "POST",
        body: JSON.stringify({
          document_id: payload.document.id,
          recipient_id: payload.recipient.id,
          event_type: "viewed",
          event_note: `${payload.recipient.name || payload.recipient.email} opened the agreement.`
        })
      });
      payload.recipient.status = "viewed";
      payload.recipient.viewed_at = now;
    }

    return apiJson({
      document: payload.document,
      agreement: payload.agreement,
      proposalApproved: payload.proposalApproved,
      recipient: {
        id: payload.recipient.id,
        name: payload.recipient.name,
        email: payload.recipient.email,
        role: payload.recipient.role,
        status: payload.recipient.status,
        viewed_at: payload.recipient.viewed_at,
        signed_at: payload.recipient.signed_at
      },
      recipients: payload.recipients,
      events: payload.events
    });
  } catch (error) {
    return handleApiError(error);
  }
}

async function profileForRecipientEmail(email) {
  const recipientEmail = normalizeEmail(email);
  if (!recipientEmail) return null;
  const profiles = await supabaseAdminFetch(
    tablePath("profiles", `?select=id,email&email=eq.${encodeValue(recipientEmail)}&limit=1`)
  );
  return profiles?.[0] || null;
}

async function requireMatchingPortalSessionIfNeeded(request, recipient) {
  // The opaque signing token is the recipient's authorization. Client portal
  // access is optional, so proposal recipients can open and sign directly
  // from the emailed link without creating or using a portal account.
  return null;
}

function cleanSignatureFields(body) {
  return {
    typedSignature: String(body.typedSignature || "").trim(),
    signatureImage: String(body.signatureImage || "").trim(),
    signerName: String(body.signerName || "").trim(),
    signerTitle: String(body.signerTitle || "").trim(),
    signatureDate: String(body.signatureDate || "").trim()
  };
}

function validateSignatureFields(signatureFields) {
  if (!signatureFields.typedSignature && !signatureFields.signatureImage) return "Enter or draw your signature.";
  if (!signatureFields.signerName) return "Enter your name.";
  if (!signatureFields.signerTitle) return "Enter your title.";
  if (!signatureFields.signatureDate) return "Enter the signing date.";
  if (signatureFields.typedSignature && signatureFields.typedSignature.length < 2) return "Signature is too short.";
  if (signatureFields.signerName.length < 2) return "Name is too short.";
  return "";
}

export async function POST(request, { params }) {
  try {
    const body = await request.json();
    const payload = await loadSignature(params.token);

    if (body.action === "approve") {
      if (payload.recipient.role !== "signer") {
        return apiJson({ error: "Only a signer can approve this proposal." }, 403);
      }

      await requireMatchingPortalSessionIfNeeded(request, payload.recipient);
      if (payload.proposalApproved) return apiJson({ approved: true });

      await supabaseAdminFetch(tablePath("signature_events"), {
        method: "POST",
        body: JSON.stringify({
          document_id: payload.document.id,
          recipient_id: payload.recipient.id,
          event_type: "proposal_approved",
          event_note: `${payload.recipient.name || payload.recipient.email} approved the proposal and unlocked signing.`
        })
      });

      if (payload.document.uploaded_by) {
        try {
          await supabaseAdminFetch(tablePath("request_messages"), {
            method: "POST",
            body: JSON.stringify({
              request_id: payload.document.request_id,
              sender_id: payload.document.uploaded_by,
              message: `Proposal approved by ${payload.recipient.name || payload.recipient.email}: ${payload.document.title || "Accessibility Services Proposal"}. Agreement signing is now unlocked.`,
              is_internal: false
            })
          });
        } catch (messageError) {
          console.warn("[Clients] Proposal approval message entry failed", messageError);
        }
      }

      return apiJson({ approved: true });
    }

    const signatureFields = cleanSignatureFields(body);
    const validationError = validateSignatureFields(signatureFields);
    if (validationError) return apiJson({ error: validationError }, 400);

    if (payload.recipient.status === "signed") {
      return apiJson({ error: "This agreement has already been signed by this recipient." }, 400);
    }

    await requireMatchingPortalSessionIfNeeded(request, payload.recipient);

    const now = new Date().toISOString();
    const ipAddress = request.headers.get("x-forwarded-for") || request.headers.get("x-real-ip") || null;

    await supabaseAdminFetch(tablePath("signature_recipients", `?id=eq.${encodeValue(payload.recipient.id)}`), {
      method: "PATCH",
      body: JSON.stringify({
        status: "signed",
        signed_at: now,
        typed_signature: signatureFields.typedSignature || null,
        signed_ip: ipAddress,
        signed_user_agent: request.headers.get("user-agent") || null
      })
    });

    await supabaseAdminFetch(tablePath("signature_events"), {
      method: "POST",
      body: JSON.stringify({
        document_id: payload.document.id,
        recipient_id: payload.recipient.id,
        event_type: "signed",
        event_note: JSON.stringify({
          message: `${signatureFields.signerName} accepted and signed the agreement as ${signatureFields.signerTitle}.`,
          ...signatureFields
        })
      })
    });

    const recipients = await supabaseAdminFetch(
      tablePath("signature_recipients", `?select=role,status&document_id=eq.${encodeValue(payload.document.id)}`)
    );
    const signerRecipients = (recipients || []).filter((recipient) => recipient.role === "signer" && recipient.status !== "declined");
    const allSigned = signerRecipients.length > 0 && signerRecipients.every((recipient) => recipient.status === "signed");
    const requestRowsForSignature = await supabaseAdminFetch(
      tablePath("requests", `?select=id,request_number,title,client_id&id=eq.${encodeValue(payload.document.request_id)}&limit=1`)
    );
    const requestRowForSignature = requestRowsForSignature?.[0];
    await supabaseAdminFetch(tablePath("signature_documents", `?id=eq.${encodeValue(payload.document.id)}`), {
      method: "PATCH",
      body: JSON.stringify({
        status: allSigned ? "completed" : "partially_signed",
        ...(allSigned ? { completed_at: now } : {}),
        updated_at: now
      })
    });

    if (allSigned) {
      await supabaseAdminFetch(tablePath("signature_events"), {
        method: "POST",
        body: JSON.stringify({
          document_id: payload.document.id,
          event_type: "completed",
          event_note: "All required recipients signed the agreement."
        })
      });
      if (requestRowForSignature?.client_id) {
        await supabaseAdminFetch(
          tablePath("clients", `?id=eq.${encodeValue(requestRowForSignature.client_id)}`),
          { method: "PATCH", body: JSON.stringify({ status: "signed" }) }
        );
      }
    }

    let signedMessageCreated = false;
    const signedAgreementUrl = `${publicAppOrigin(request)}/sign/${payload.recipient.signing_token}`;
    const signedMessage = allSigned
      ? `Agreement signed by ${payload.recipient.name || payload.recipient.email}: ${payload.document.title || "Accessibility Services Proposal"}. Signed at: ${now}. The signed agreement is ready to download.\nOpen signed agreement: ${signedAgreementUrl}`
      : `Agreement signed by ${payload.recipient.name || payload.recipient.email}: ${payload.document.title || "Accessibility Services Proposal"}`;
    try {
      const senderId = payload.document.uploaded_by
        || (await profileForRecipientEmail(payload.recipient.email))?.id;
      if (!senderId) throw new Error("No sender profile is available for the agreement message.");
      await supabaseAdminFetch(tablePath("request_messages"), {
        method: "POST",
        body: JSON.stringify({
          request_id: payload.document.request_id,
          sender_id: senderId,
          message: signedMessage,
          is_internal: false
        })
      });
      signedMessageCreated = true;
    } catch (messageError) {
      console.warn("[Clients] Agreement message entry failed", messageError);
    }

    try {
      const senderProfiles = payload.document.uploaded_by
        ? await supabaseAdminFetch(tablePath("profiles", `?select=id,full_name,email,role&id=eq.${encodeValue(payload.document.uploaded_by)}&limit=1`))
        : [];
      if (requestRowForSignature && senderProfiles?.[0]) {
        await sendProtonOutbound({
          requestRow: requestRowForSignature,
          senderProfile: senderProfiles[0],
          subject: requestRowForSignature.title || payload.document.title,
          message: signedMessage
        });
      }
    } catch (emailError) {
      console.warn("[Clients] Agreement signed email failed", emailError);
    }

    return apiJson({ signed: true, completed: allSigned, signedMessageCreated });
  } catch (error) {
    return handleApiError(error);
  }
}
