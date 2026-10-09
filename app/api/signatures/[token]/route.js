import {
  apiJson,
  currentProfile,
  encodeValue,
  handleApiError,
  normalizeEmail,
  supabaseAdminFetch,
  tablePath
} from "../../_supabaseAdmin.js";

function defaultAgreement(document) {
  return {
    title: document?.title || "Service Agreement",
    scope: "",
    services: "",
    price: "",
    timeline: "",
    terms: "",
    nextSteps: ""
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
    agreement: parseAgreementSnapshot(events, document)
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
  const profile = await profileForRecipientEmail(recipient.email);
  if (!profile?.id) return null;

  let signedInProfile = null;
  try {
    signedInProfile = await currentProfile(request);
  } catch (error) {
    const authError = new Error("Please sign in with the recipient portal account before opening this agreement.");
    authError.status = error.status === 401 || error.status === 403 ? error.status : 401;
    throw authError;
  }

  if (normalizeEmail(signedInProfile.email) !== normalizeEmail(recipient.email)) {
    const error = new Error("This signing link belongs to a different recipient account. Please sign in with the matching recipient email.");
    error.status = 403;
    throw error;
  }

  return signedInProfile;
}

function cleanSignatureFields(body) {
  return {
    typedSignature: String(body.typedSignature || "").trim(),
    signerName: String(body.signerName || "").trim(),
    signerTitle: String(body.signerTitle || "").trim(),
    signatureDate: String(body.signatureDate || "").trim()
  };
}

function validateSignatureFields(signatureFields) {
  if (!signatureFields.typedSignature) return "Enter your signature.";
  if (!signatureFields.signerName) return "Enter your name.";
  if (!signatureFields.signerTitle) return "Enter your title.";
  if (!signatureFields.signatureDate) return "Enter the signing date.";
  if (signatureFields.typedSignature.length < 2) return "Signature is too short.";
  if (signatureFields.signerName.length < 2) return "Name is too short.";
  return "";
}

export async function POST(request, { params }) {
  try {
    const body = await request.json();
    const signatureFields = cleanSignatureFields(body);
    const validationError = validateSignatureFields(signatureFields);
    if (validationError) return apiJson({ error: validationError }, 400);

    const payload = await loadSignature(params.token);
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
        typed_signature: signatureFields.typedSignature,
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
        event_note: `${signatureFields.signerName} accepted and signed the agreement as ${signatureFields.signerTitle}.`
      })
    });

    const recipients = await supabaseAdminFetch(
      tablePath("signature_recipients", `?select=role,status&document_id=eq.${encodeValue(payload.document.id)}`)
    );
    const signerRecipients = (recipients || []).filter((recipient) => recipient.role === "signer" && recipient.status !== "declined");
    const allSigned = signerRecipients.length > 0 && signerRecipients.every((recipient) => recipient.status === "signed");
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
    }

    if (payload.document.uploaded_by) {
      try {
        await supabaseAdminFetch(tablePath("request_messages"), {
          method: "POST",
          body: JSON.stringify({
            request_id: payload.document.request_id,
            sender_id: payload.document.uploaded_by,
            message: allSigned
              ? `Agreement completed: ${payload.document.title || "Service Agreement"}`
              : `Agreement signed by ${payload.recipient.name || payload.recipient.email}: ${payload.document.title || "Service Agreement"}`,
            is_internal: false
          })
        });
      } catch (messageError) {
        console.warn("[Clients] Agreement message entry failed", messageError);
      }
    }

    return apiJson({ signed: true, completed: allSigned });
  } catch (error) {
    return handleApiError(error);
  }
}
