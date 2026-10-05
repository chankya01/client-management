import {
  downloadStorageObject,
  encodeValue,
  handleApiError,
  supabaseAdminFetch,
  tablePath
} from "../../../_supabaseAdmin.js";

function inlineFileName(fileName) {
  return String(fileName || "document.pdf").replace(/["\r\n]/g, "");
}

async function loadSignatureDocument(token) {
  const recipients = await supabaseAdminFetch(
    tablePath("signature_recipients", `?select=id,document_id&signing_token=eq.${encodeValue(token)}&limit=1`)
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
  return document;
}

export async function GET(_request, { params }) {
  try {
    const document = await loadSignatureDocument(params.token);
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
