import {
  apiJson,
  currentProfile,
  encodeValue,
  handleApiError,
  managementRoles,
  normalizeEmail,
  supabaseAdminFetch,
  tablePath
} from "../_supabaseAdmin.js";

export async function GET(request) {
  try {
    const profile = await currentProfile(request);
    const query = managementRoles.has(profile.role)
      ? "?select=id,request_id,profile_id,name,email,created_at"
      : `?select=id,request_id,profile_id,name,email,created_at&or=(profile_id.eq.${encodeValue(profile.id)},email.eq.${encodeValue(normalizeEmail(profile.email))})`;
    const rows = await supabaseAdminFetch(tablePath("request_client_contacts", query));
    return apiJson(rows || []);
  } catch (error) {
    if (String(error.message || "").includes("request_client_contacts")) return apiJson([]);
    return handleApiError(error);
  }
}
