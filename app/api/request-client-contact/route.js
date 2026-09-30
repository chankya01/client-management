import { apiJson } from "../_supabaseAdmin.js";
import { POST as addRequestClientContact } from "../request-client-contacts/[requestId]/route.js";

export async function POST(request) {
  const body = await request.json();
  const requestId = body.requestId;
  if (!requestId) return apiJson({ error: "Request is required before adding a CC contact." }, 400);

  const forwardedRequest = new Request(request.url, {
    method: "POST",
    headers: request.headers,
    body: JSON.stringify({ contact: body.contact || body })
  });

  return addRequestClientContact(forwardedRequest, { params: { requestId } });
}
