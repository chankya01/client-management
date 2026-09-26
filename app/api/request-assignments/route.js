import {
  apiJson,
  handleApiError,
  internalRoles,
  requireProfileRole,
  supabaseAdminFetch,
  tablePath
} from "../_supabaseAdmin.js";

export async function GET(request) {
  try {
    await requireProfileRole(request, internalRoles);
    const rows = await supabaseAdminFetch(
      tablePath("request_assignments", "?select=request_id,profile_id,user_id,assigned_by,created_at")
    );
    return apiJson((rows || []).map((assignment) => ({
      ...assignment,
      profile_id: assignment.profile_id || assignment.user_id
    })));
  } catch (error) {
    if (String(error.message || "").includes("profile_id")) {
      try {
        const rows = await supabaseAdminFetch(
          tablePath("request_assignments", "?select=request_id,user_id,assigned_by,created_at")
        );
        return apiJson((rows || []).map((assignment) => ({
          ...assignment,
          profile_id: assignment.user_id
        })));
      } catch (fallbackError) {
        return handleApiError(fallbackError);
      }
    }
    if (String(error.message || "").includes("user_id")) {
      try {
        const rows = await supabaseAdminFetch(
          tablePath("request_assignments", "?select=request_id,profile_id,assigned_by,created_at")
        );
        return apiJson((rows || []).map((assignment) => ({
          ...assignment,
          profile_id: assignment.profile_id
        })));
      } catch (fallbackError) {
        return handleApiError(fallbackError);
      }
    }
    return handleApiError(error);
  }
}
