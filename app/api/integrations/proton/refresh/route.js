import {
  apiJson,
  currentProfile,
  handleApiError,
  internalRoles
} from "../../../_supabaseAdmin.js";

const REFRESH_TIMEOUT_MS = 12000;

export async function POST(request) {
  try {
    const profile = await currentProfile(request);
    if (!internalRoles.has(profile.role)) {
      return apiJson({ error: "Only team members can request a Proton sync." }, 403);
    }

    const endpoint = String(process.env.PROTON_INBOUND_REFRESH_URL || "").trim();
    if (!endpoint) {
      return apiJson({
        ok: true,
        requested: false,
        configured: false,
        reason: "PROTON_INBOUND_REFRESH_URL is not configured."
      });
    }

    const secret = String(
      process.env.PROTON_INBOUND_REFRESH_SECRET
      || process.env.PROTON_INBOUND_WEBHOOK_SECRET
      || ""
    ).trim();
    if (!secret) {
      return apiJson({
        ok: true,
        requested: false,
        configured: false,
        reason: "The Proton refresh secret is not configured."
      });
    }

    const body = await request.json().catch(() => ({}));
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REFRESH_TIMEOUT_MS);
    let response;
    try {
      response = await fetch(endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${secret}`,
          "X-Proton-Refresh-Secret": secret
        },
        body: JSON.stringify({
          requestId: String(body.requestId || "").trim(),
          requestedBy: profile.email || profile.id || "team"
        }),
        signal: controller.signal,
        cache: "no-store"
      });
    } finally {
      clearTimeout(timeout);
    }

    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      return apiJson({
        ok: false,
        requested: false,
        configured: true,
        reason: detail || `The Proton refresh worker returned ${response.status}.`
      }, 502);
    }

    return apiJson({ ok: true, requested: true, configured: true });
  } catch (error) {
    if (error?.name === "AbortError") {
      return apiJson({
        ok: false,
        requested: false,
        configured: true,
        reason: `The Proton refresh worker timed out after ${REFRESH_TIMEOUT_MS}ms.`
      }, 504);
    }
    return handleApiError(error);
  }
}
