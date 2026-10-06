import {
  apiJson,
  createStorageSignedUrl,
  currentProfile,
  downloadStorageObject,
  encodeValue,
  handleApiError,
  normalizeEmail,
  signatureAccessCookieName,
  signatureAccessCookieValue,
  supabaseAdminFetch,
  tablePath,
  uploadStorageObject
} from "../../_supabaseAdmin.js";

function safePdfText(value) {
  return String(value ?? "")
    .replace(/[\r\n]+/g, " ")
    .replace(/[^\x20-\x7E]/g, "")
    .trim();
}

function truncatePdfText(value, maxLength = 95) {
  const text = safePdfText(value);
  return text.length > maxLength ? `${text.slice(0, Math.max(0, maxLength - 3))}...` : text;
}

function signedPdfPath(document, recipient) {
  return `${document.request_id}/signatures/signed/${document.id}/${recipient.id}-signed.pdf`;
}

function signedPdfFileName(document) {
  const baseName = String(document.title || document.file_name || "signed-document")
    .replace(/\.[^.]+$/, "")
    .replace(/[^a-zA-Z0-9._-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "") || "signed-document";
  return `${baseName}-signed.pdf`;
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

function legacySignedCertificatePath(document, recipient) {
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
  const signedCertificateStoragePath = legacySignedCertificatePath(document, recipient);
  const signedPdfStoragePath = signedPdfPath(document, recipient);
  let signedDocumentUrl = null;
  try {
    const files = await supabaseAdminFetch(
      tablePath("files", `?select=id,storage_path&or=(storage_path.eq.${encodeValue(signedPdfStoragePath)},storage_path.eq.${encodeValue(signedCertificateStoragePath)})&limit=1`)
    );
    if (files?.length) {
      signedDocumentUrl = await createStorageSignedUrl(document.bucket_name, files[0].storage_path);
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
    const matchingPortalProfile = await requireMatchingPortalSessionIfNeeded(_request, payload.recipient);
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

    const response = apiJson({
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
      document_inline_url: `/api/signatures/${encodeURIComponent(params.token)}/document`,
      document_preview_url: isPdf ? `/api/signatures/${encodeURIComponent(params.token)}/document` : null,
      can_inline_preview: isPdf,
      signed_document_url: payload.signed_document_url
    });
    if (matchingPortalProfile?.id) {
      response.cookies.set({
        name: signatureAccessCookieName(params.token),
        value: signatureAccessCookieValue(params.token, payload.recipient.id),
        httpOnly: true,
        sameSite: "lax",
        secure: process.env.NODE_ENV === "production",
        path: "/",
        maxAge: 60 * 10
      });
    }
    return response;
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
    const authError = new Error("Please sign in with the recipient portal account before signing this document.");
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

async function downloadDocumentBuffer(document) {
  const storageResponse = await downloadStorageObject(document.bucket_name, document.storage_path);
  const arrayBuffer = await storageResponse.arrayBuffer();
  return Buffer.from(arrayBuffer);
}

function isPdfDocument(document) {
  return document.mime_type === "application/pdf"
    || String(document.file_name || "").toLowerCase().endsWith(".pdf");
}

async function createSignedPdfBuffer({ document, recipient, signedAt, ipAddress, signatureFields }) {
  if (!isPdfDocument(document)) {
    const error = new Error("Only PDF documents can be signed in this flow. Please resend the document as a PDF.");
    error.status = 400;
    throw error;
  }

  const { PDFDocument, StandardFonts, rgb } = await import("pdf-lib");
  const sourceBytes = await downloadDocumentBuffer(document);
  const pdfDoc = await PDFDocument.load(sourceBytes, { ignoreEncryption: true });
  const pages = pdfDoc.getPages();
  if (!pages.length) {
    const error = new Error("The PDF has no pages to sign.");
    error.status = 400;
    throw error;
  }

  const page = pages[pages.length - 1];
  const { width } = page.getSize();
  const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
  const boldFont = await pdfDoc.embedFont(StandardFonts.HelveticaBold);
  const blockWidth = Math.min(500, Math.max(260, width - 72));
  const blockHeight = 118;
  const x = 36;
  const y = 36;
  const lineY = y + blockHeight - 34;

  page.drawRectangle({
    x,
    y,
    width: blockWidth,
    height: blockHeight,
    borderColor: rgb(0.38, 0.11, 0.51),
    borderWidth: 1.4,
    color: rgb(1, 1, 1),
    opacity: 0.96
  });
  page.drawText("Electronic Signature", {
    x: x + 14,
    y: y + blockHeight - 22,
    size: 11,
    font: boldFont,
    color: rgb(0.2, 0.2, 0.2)
  });
  page.drawLine({
    start: { x: x + 14, y: lineY },
    end: { x: x + blockWidth - 14, y: lineY },
    thickness: 0.6,
    color: rgb(0.72, 0.76, 0.82)
  });

  const rows = [
    ["Signature", signatureFields.typedSignature, "left"],
    ["Name", signatureFields.signerName, "left"],
    ["Title", signatureFields.signerTitle, "left"],
    ["Date", signatureFields.signatureDate, "left"],
    ["Recipient", recipient.email, "right"],
    ["Signed at", formatAuditDate(signedAt), "right"],
    ["IP", ipAddress || "Not captured", "right"]
  ];
  let leftIndex = 0;
  let rightIndex = 0;
  rows.forEach(([label, value, column], index) => {
    const isRightColumn = column === "right";
    const rowX = isRightColumn ? x + Math.min(265, blockWidth / 2 + 10) : x + 14;
    const rowY = lineY - 16 - ((isRightColumn ? rightIndex++ : leftIndex++) * 14);
    page.drawText(`${label}:`, {
      x: rowX,
      y: rowY,
      size: 8.5,
      font: boldFont,
      color: rgb(0.25, 0.29, 0.35)
    });
    page.drawText(truncatePdfText(value, isRightColumn ? 42 : 58), {
      x: rowX + 58,
      y: rowY,
      size: index === 0 ? 10 : 8.5,
      font: index === 0 ? boldFont : font,
      color: index === 0 ? rgb(0.32, 0.08, 0.44) : rgb(0.1, 0.1, 0.1)
    });
  });

  const signedBytes = await pdfDoc.save({ useObjectStreams: false });
  return Buffer.from(signedBytes);
}

async function createSignedPdfFile({ request, document, recipient, signedAt, ipAddress, signatureFields }) {
  const storagePath = signedPdfPath(document, recipient);
  const fileName = signedPdfFileName(document);
  const pdfBuffer = await createSignedPdfBuffer({ document, recipient, signedAt, ipAddress, signatureFields });
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
      event_note: `Signed PDF created for ${recipient.name || recipient.email}.`
    })
  });

  return createStorageSignedUrl(document.bucket_name, storagePath);
}

export async function POST(request, { params }) {
  try {
    const body = await request.json();
    const signatureFields = cleanSignatureFields(body);
    const validationError = validateSignatureFields(signatureFields);
    if (validationError) return apiJson({ error: validationError }, 400);

    const payload = await loadSignature(params.token);
    if (payload.recipient.status === "signed") {
      return apiJson({ error: "This document has already been signed by this recipient." }, 400);
    }

    await requireMatchingPortalSessionIfNeeded(request, payload.recipient);

    const now = new Date().toISOString();
    const ipAddress = request.headers.get("x-forwarded-for") || request.headers.get("x-real-ip") || null;
    const requestRows = await supabaseAdminFetch(
      tablePath("requests", `?select=id,client_id&id=eq.${encodeValue(payload.document.request_id)}&limit=1`)
    );
    const signedDocumentUrl = await createSignedPdfFile({
      request: requestRows?.[0] || null,
      document: payload.document,
      recipient: payload.recipient,
      signedAt: now,
      ipAddress,
      signatureFields
    });

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

    payload.recipient.status = "signed";
    payload.recipient.signed_at = now;
    payload.recipient.typed_signature = signatureFields.typedSignature;
    payload.recipient.signed_ip = ipAddress;

    await supabaseAdminFetch(tablePath("signature_events"), {
      method: "POST",
      body: JSON.stringify({
        document_id: payload.document.id,
        recipient_id: payload.recipient.id,
        event_type: "signed",
        event_note: `${payload.recipient.name || payload.recipient.email} signed the document.`
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
      } catch (messageError) {
        console.warn("[Clients] Signature message entry failed", messageError);
      }
    }

    return apiJson({ signed: true, completed: allSigned, signed_document_url: signedDocumentUrl });
  } catch (error) {
    return handleApiError(error);
  }
}
