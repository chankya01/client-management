import {
  apiJson,
  createStorageSignedUrl,
  encodeValue,
  handleApiError,
  normalizeEmail,
  supabaseAdminFetch,
  tablePath
} from "../../_supabaseAdmin.js";

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
    const error = new Error("The document for this signing link could not be found.");
    error.status = 404;
    throw error;
  }

  const allRecipients = await supabaseAdminFetch(
    tablePath("signature_recipients", `?select=id,name,email,role,status,viewed_at,signed_at,declined_at&document_id=eq.${encodeValue(document.id)}&order=created_at.asc`)
  );
  const documentUrl = await createStorageSignedUrl(document.bucket_name, document.storage_path);

  return {
    document,
    recipient,
    recipients: allRecipients || [],
    document_url: documentUrl
  };
}

export async function GET(_request, { params }) {
  try {
    const payload = await loadSignature(params.token);
    if (payload.recipient.status === "sent") {
      const now = new Date().toISOString();
      await supabaseAdminFetch(tablePath("signature_recipients", `?id=eq.${encodeValue(payload.recipient.id)}`), {
        method: "PATCH",
        body: JSON.stringify({ status: "viewed", viewed_at: now })
      });
      await supabaseAdminFetch(tablePath("signature_events"), {
        method: "POST",
        body: JSON.stringify({
          document_id: payload.document.id,
          recipient_id: payload.recipient.id,
          event_type: "viewed",
          event_note: `${payload.recipient.name || payload.recipient.email} opened the signing link.`
        })
      });
      payload.recipient.status = "viewed";
      payload.recipient.viewed_at = now;
    }

    return apiJson({
      document: payload.document,
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
      document_url: payload.document_url
    });
  } catch (error) {
    return handleApiError(error);
  }
}

export async function POST(request, { params }) {
  try {
    const body = await request.json();
    const typedSignature = String(body.typedSignature || "").trim();
    if (!typedSignature) return apiJson({ error: "Type your full name to sign." }, 400);

    const payload = await loadSignature(params.token);
    if (payload.recipient.status === "signed") {
      return apiJson({ error: "This document has already been signed by this recipient." }, 400);
    }

    if (normalizeEmail(payload.recipient.email) && typedSignature.length < 2) {
      return apiJson({ error: "Signature name is too short." }, 400);
    }

    const now = new Date().toISOString();
    await supabaseAdminFetch(tablePath("signature_recipients", `?id=eq.${encodeValue(payload.recipient.id)}`), {
      method: "PATCH",
      body: JSON.stringify({
        status: "signed",
        signed_at: now,
        typed_signature: typedSignature,
        signed_ip: request.headers.get("x-forwarded-for") || request.headers.get("x-real-ip") || null,
        signed_user_agent: request.headers.get("user-agent") || null
      })
    });

    await supabaseAdminFetch(tablePath("signature_events"), {
      method: "POST",
      body: JSON.stringify({
        document_id: payload.document.id,
        recipient_id: payload.recipient.id,
        event_type: "signed",
        event_note: `${payload.recipient.name || payload.recipient.email} signed as ${typedSignature}.`
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
          event_note: "All recipients signed the document."
        })
      });
    }

    return apiJson({ signed: true, completed: allSigned });
  } catch (error) {
    return handleApiError(error);
  }
}
