import {
  apiJson,
  handleApiError,
  requireProfileRole,
  managementRoles,
  supabaseAdminFetch,
  tablePath
} from "../_supabaseAdmin.js";

export async function GET(request) {
  try {
    await requireProfileRole(request, managementRoles);
    const rows = await supabaseAdminFetch(
      tablePath("request_client_contacts", "?select=id,request_id,profile_id,name,email,created_at")
    );
    return apiJson(rows || []);
  } catch (error) {
    if (String(error.message || "").includes("request_client_contacts")) return apiJson([]);
    return handleApiError(error);
  }
}
