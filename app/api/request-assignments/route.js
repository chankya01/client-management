import {
  apiJson,
  currentProfile,
  handleApiError,
  inFilter,
  internalRoles,
  supabaseAdminFetch,
  tablePath,
  visibleRequestIdsForClientProfile
} from "../_supabaseAdmin.js";

async function assignmentRowsForProfile(profile, select = "request_id,profile_id,user_id,assigned_by,created_at") {
  if (internalRoles.has(profile.role)) {
    return supabaseAdminFetch(tablePath("request_assignments", `?select=${select}`));
  }

  if (profile.role === "client") {
    const requestIds = await visibleRequestIdsForClientProfile(profile);
    if (!requestIds.length) return [];
    return supabaseAdminFetch(tablePath("request_assignments", `?select=${select}&request_id=${inFilter(requestIds)}`));
  }

  return [];
}

export async function GET(request) {
  try {
    const profile = await currentProfile(request);
    const rows = await assignmentRowsForProfile(profile);
    return apiJson((rows || []).map((assignment) => ({
      ...assignment,
      profile_id: assignment.profile_id || assignment.user_id
    })));
  } catch (error) {
    if (String(error.message || "").includes("profile_id")) {
      try {
        const rows = await assignmentRowsForProfile(await currentProfile(request), "request_id,user_id,assigned_by,created_at");
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
        const rows = await assignmentRowsForProfile(await currentProfile(request), "request_id,profile_id,assigned_by,created_at");
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
