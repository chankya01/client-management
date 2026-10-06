import {
  currentProfile,
  downloadStorageObject,
  encodeValue,
  handleApiError,
  normalizeEmail,
  signatureAccessCookieName,
  signatureAccessCookieValue,
  supabaseAdminFetch,
  tablePath
} from "../../../_supabaseAdmin.js";

function inlineFileName(fileName) {
  return String(fileName || "document.pdf").replace(/["\r\n]/g, "");
}

async function loadSignatureDocument(token) {
  const recipients = await supabaseAdminFetch(
    tablePath("signature_recipients", `?select=id,document_id,email&signing_token=eq.${encodeValue(token)}&limit=1`)
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
  return { document, recipient };
}

async function profileForRecipientEmail(email) {
  const recipientEmail = normalizeEmail(email);
  if (!recipientEmail) return null;
  const profiles = await supabaseAdminFetch(
    tablePath("profiles", `?select=id,email&email=eq.${encodeValue(recipientEmail)}&limit=1`)
  );
  return profiles?.[0] || null;
}

async function requireMatchingPortalSessionIfNeeded(request, recipient, token) {
  const profile = await profileForRecipientEmail(recipient.email);
  if (!profile?.id) return null;

  const expectedCookieValue = signatureAccessCookieValue(token, recipient.id);
  const accessCookie = request.cookies?.get(signatureAccessCookieName(token))?.value;
  if (accessCookie && accessCookie === expectedCookieValue) return profile;

  let signedInProfile = null;
  try {
    signedInProfile = await currentProfile(request);
  } catch (error) {
    const authError = new Error("Please sign in with the recipient portal account before viewing this document.");
    authError.status = error.status === 401 || error.status === 403 ? error.status : 401;
    throw authError;
  }

  if (normalizeEmail(signedInProfile.email) !== normalizeEmail(recipient.email)) {
    const error = new Error("This document belongs to a different recipient account. Please sign in with the matching recipient email.");
    error.status = 403;
    throw error;
  }

  return signedInProfile;
}

export async function GET(request, { params }) {
  try {
    const { document, recipient } = await loadSignatureDocument(params.token);
    await requireMatchingPortalSessionIfNeeded(request, recipient, params.token);
    const storageResponse = await downloadStorageObject(document.bucket_name, document.storage_path);
    const contentType = document.mime_type || storageResponse.headers.get("content-type") || "application/octet-stream";
    const body = await storageResponse.arrayBuffer();

    return new Response(body, {
      headers: {
        "Cache-Control": "no-store",
        "Content-Disposition": `inline; filename="${inlineFileName(document.file_name)}"`,
        "Content-Type": contentType,
        "X-Content-Type-Options": "nosniff"
      }
    });
  } catch (error) {
    return handleApiError(error);
  }
}
