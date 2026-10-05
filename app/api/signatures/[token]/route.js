import {
  apiJson,
  createStorageSignedUrl,
  encodeValue,
  handleApiError,
  normalizeEmail,
  supabaseAdminFetch,
  tablePath,
  uploadStorageObject
} from "../../_supabaseAdmin.js";

function pdfEscape(value) {
  return String(value ?? "")
    .replaceAll("\\", "\\\\")
    .replaceAll("(", "\\(")
    .replaceAll(")", "\\)");
}

function formatAuditDate(value) {
  if (!value) return "";
  try {
    return new Date(value).toLocaleString("en-US", {
      dateStyle: "medium",
      timeStyle: "short",
      timeZone: "UTC"
    });
  } catch {
    return String(value);
  }
}

function textLine(text, x, y, size = 12, font = "F1") {
  return `BT /${font} ${size} Tf ${x} ${y} Td (${pdfEscape(text)}) Tj ET`;
}

function createSignatureCertificatePdf({ document, recipient, signedAt, ipAddress }) {
  const lines = [
    textLine("Clients", 72, 740, 18, "F2"),
    textLine("Electronic Signature Certificate", 72, 710, 22, "F2"),
    textLine("This certificate records the electronic signing event for the document below.", 72, 680, 11),
    textLine(`Document: ${document.title || document.file_name || "Document"}`, 72, 645, 12, "F2"),
    textLine(`File: ${document.file_name || "Uploaded document"}`, 72, 625),
    textLine(`Document ID: ${document.id}`, 72, 605),
    textLine(`Request ID: ${document.request_id}`, 72, 585),
    textLine("Signer", 72, 545, 14, "F2"),
    textLine(`Name: ${recipient.name || recipient.email}`, 72, 522),
    textLine(`Email: ${recipient.email}`, 72, 502),
    textLine(`Typed signature: ${recipient.typed_signature || recipient.name || recipient.email}`, 72, 482, 12, "F2"),
    textLine(`Signed at: ${formatAuditDate(signedAt)}`, 72, 462),
    textLine(`IP address: ${ipAddress || "Not captured"}`, 72, 442),
    textLine("Consent", 72, 402, 14, "F2"),
    textLine("The signer agreed that their typed name is their electronic signature.", 72, 379),
    textLine("This certificate is generated automatically by Clients after the signing action.", 72, 359),
    textLine("Audit Trail", 72, 319, 14, "F2"),
    textLine(`Recipient ID: ${recipient.id}`, 72, 296),
    textLine(`User agent captured separately in the recipient audit record.`, 72, 276),
    "0.8 w 72 250 468 0 l S",
    textLine("Generated signed proof copy", 72, 225, 10)
  ].join("\n");

  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R /F2 5 0 R >> >> /Contents 6 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold >>",
    `<< /Length ${Buffer.byteLength(lines, "utf8")} >>\nstream\n${lines}\nendstream`
  ];

  let pdf = "%PDF-1.4\n";
  const offsets = [0];
  objects.forEach((object, index) => {
    offsets[index + 1] = Buffer.byteLength(pdf, "utf8");
    pdf += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xrefOffset = Buffer.byteLength(pdf, "utf8");
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  offsets.slice(1).forEach((offset) => {
    pdf += `${String(offset).padStart(10, "0")} 00000 n \n`;
  });
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  return Buffer.from(pdf, "utf8");
}

function signedCertificatePath(document, recipient) {
  return `${document.request_id}/signatures/signed/${document.id}/${recipient.id}-signature-certificate.pdf`;
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
    const error = new Error("The document for this signing link could not be found.");
    error.status = 404;
    throw error;
  }

  const allRecipients = await supabaseAdminFetch(
    tablePath("signature_recipients", `?select=id,name,email,role,status,viewed_at,signed_at,declined_at&document_id=eq.${encodeValue(document.id)}&order=created_at.asc`)
  );
  const documentUrl = await createStorageSignedUrl(document.bucket_name, document.storage_path);
  const signedCertificateStoragePath = signedCertificatePath(document, recipient);
  let signedDocumentUrl = null;
  try {
    const files = await supabaseAdminFetch(
      tablePath("files", `?select=id&storage_path=eq.${encodeValue(signedCertificateStoragePath)}&limit=1`)
    );
    if (files?.length) {
      signedDocumentUrl = await createStorageSignedUrl(document.bucket_name, signedCertificateStoragePath);
    }
  } catch {
    signedDocumentUrl = null;
  }

  return {
    document,
    recipient,
    recipients: allRecipients || [],
    document_url: documentUrl,
    signed_document_url: signedDocumentUrl
  };
}

export async function GET(_request, { params }) {
  try {
    const payload = await loadSignature(params.token);
    const isPdf = payload.document.mime_type === "application/pdf"
      || String(payload.document.file_name || "").toLowerCase().endsWith(".pdf");
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
      document_url: payload.document_url,
      document_preview_url: isPdf ? `/api/signatures/${encodeURIComponent(params.token)}/document` : null,
      can_inline_preview: isPdf,
      signed_document_url: payload.signed_document_url
    });
  } catch (error) {
    return handleApiError(error);
  }
}

async function createSignedCertificateFile({ request, document, recipient, signedAt, ipAddress }) {
  const storagePath = signedCertificatePath(document, recipient);
  const fileName = `${String(document.title || document.file_name || "document").replace(/[^a-zA-Z0-9._-]/g, "-")}-signature-certificate.pdf`;
  const pdfBuffer = createSignatureCertificatePdf({ document, recipient, signedAt, ipAddress });
  await uploadStorageObject(document.bucket_name, storagePath, pdfBuffer, {
    contentType: "application/pdf",
    upsert: true
  });

  await supabaseAdminFetch(tablePath("files"), {
    method: "POST",
    headers: { Prefer: "resolution=merge-duplicates" },
    body: JSON.stringify({
      request_id: document.request_id,
      client_id: request?.client_id || null,
      uploaded_by: document.uploaded_by || null,
      category: "attachment",
      bucket_name: document.bucket_name,
      storage_path: storagePath,
      file_name: fileName,
      mime_type: "application/pdf",
      file_size: pdfBuffer.byteLength
    })
  });

  await supabaseAdminFetch(tablePath("signature_events"), {
    method: "POST",
    body: JSON.stringify({
      document_id: document.id,
      recipient_id: recipient.id,
      event_type: "signed_copy_created",
      event_note: `Signed certificate PDF created for ${recipient.name || recipient.email}.`
    })
  });

  return createStorageSignedUrl(document.bucket_name, storagePath);
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
    const ipAddress = request.headers.get("x-forwarded-for") || request.headers.get("x-real-ip") || null;
    await supabaseAdminFetch(tablePath("signature_recipients", `?id=eq.${encodeValue(payload.recipient.id)}`), {
      method: "PATCH",
      body: JSON.stringify({
        status: "signed",
        signed_at: now,
        typed_signature: typedSignature,
        signed_ip: ipAddress,
        signed_user_agent: request.headers.get("user-agent") || null
      })
    });

    payload.recipient.status = "signed";
    payload.recipient.signed_at = now;
    payload.recipient.typed_signature = typedSignature;
    payload.recipient.signed_ip = ipAddress;

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

    if (payload.document.uploaded_by) {
      try {
        const requestRows = await supabaseAdminFetch(
          tablePath("requests", `?select=id,client_id&id=eq.${encodeValue(payload.document.request_id)}&limit=1`)
        );
        const signedDocumentUrl = await createSignedCertificateFile({
          request: requestRows?.[0] || null,
          document: payload.document,
          recipient: payload.recipient,
          signedAt: now,
          ipAddress
        });

        await supabaseAdminFetch(tablePath("request_messages"), {
          method: "POST",
          body: JSON.stringify({
            request_id: payload.document.request_id,
            sender_id: payload.document.uploaded_by,
            message: allSigned
              ? `Document completed: ${payload.document.title || payload.document.file_name || "Document"}`
              : `Document signed by ${payload.recipient.name || payload.recipient.email}: ${payload.document.title || payload.document.file_name || "Document"}`,
            is_internal: false
          })
        });
        return apiJson({ signed: true, completed: allSigned, signed_document_url: signedDocumentUrl });
      } catch (messageError) {
        console.warn("[Clients] Signature signed copy/message entry failed", messageError);
      }
    }

    return apiJson({ signed: true, completed: allSigned });
  } catch (error) {
    return handleApiError(error);
  }
}
