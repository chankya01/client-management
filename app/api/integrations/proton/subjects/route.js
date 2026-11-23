import {
  apiJson,
  encodeValue,
  handleApiError,
  inFilter,
  supabaseAdminFetch,
  tablePath
} from "../../../_supabaseAdmin.js";

function configuredSecret() {
  return String(process.env.PROTON_INBOUND_SUBJECTS_SECRET
    || process.env.PROTON_INBOUND_WEBHOOK_SECRET
    || "").trim();
}

function authorized(request) {
  const expected = configuredSecret();
  if (!expected) return false;

  const provided = request.headers.get("x-proton-subjects-secret")
    || request.headers.get("x-proton-webhook-secret")
    || request.headers.get("authorization")?.replace(/^Bearer\s+/i, "").trim();

  return provided === expected;
}

function normalizeTag(value) {
  return String(value || "")
    .replace(/[\[\]]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

export async function GET(request) {
  try {
    if (!authorized(request)) {
      return apiJson({ error: "Invalid Proton subjects secret." }, 401);
    }

    const requestRows = await supabaseAdminFetch(
      tablePath(
        "requests",
        "?select=id,request_number,title,client_id,updated_at&order=updated_at.desc"
      )
    );

    const clientIds = [...new Set(
      (requestRows || []).map((row) => row.client_id).filter(Boolean)
    )];

    if (!clientIds.length) {
      return apiJson({ requests: [] });
    }

    const clients = await supabaseAdminFetch(
      tablePath(
        "clients",
        `?select=id,name&id=${inFilter(clientIds)}`
      )
    );

    const clientById = Object.fromEntries(
      (clients || []).map((client) => [client.id, client])
    );

    const requests = (requestRows || [])
      .map((row) => {
        const clientName = normalizeTag(clientById[row.client_id]?.name);
        const requestNumber = normalizeTag(row.request_number);

        if (!clientName || !/^REQ\s*-\s*\d+$/i.test(requestNumber)) {
          return null;
        }

        return {
          requestId: row.id,
          clientTag: clientName,
          requestTag: requestNumber,
          subjectTag: `[${clientName}] [${requestNumber}]`
        };
      })
      .filter(Boolean);

    return apiJson({ requests });
  } catch (error) {
    return handleApiError(error);
  }
}
