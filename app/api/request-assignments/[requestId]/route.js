import {
  apiJson,
  encodeValue,
  handleApiError,
  managementRoles,
  requireProfileRole,
  supabaseAdminFetch,
  tablePath
} from "../../_supabaseAdmin.js";

function uniqueIds(values) {
  return Array.from(new Set((values || []).map(String).filter(Boolean)));
}

async function assignmentRoleMap(profileIds) {
  if (!profileIds.length) return {};
  const profiles = await supabaseAdminFetch(
    tablePath("profiles", `?select=id,role&id=in.(${profileIds.map(encodeValue).join(",")})`)
  );
  return Object.fromEntries((profiles || []).map((profile) => [profile.id, profile.role || "developer"]));
}

async function insertAssignments(requestId, profileIds, assignedBy) {
  if (!profileIds.length) return;
  const rolesByProfileId = await assignmentRoleMap(profileIds);
  const roleFor = (profileId) => rolesByProfileId[profileId] || "developer";

  const fullRows = profileIds.map((profileId) => ({
    request_id: requestId,
    profile_id: profileId,
    user_id: profileId,
    assignment_role: roleFor(profileId),
    assigned_by: assignedBy || null
  }));

  try {
    await supabaseAdminFetch(tablePath("request_assignments"), {
      method: "POST",
      body: JSON.stringify(fullRows)
    });
    return;
  } catch (error) {
    const message = String(error.message || "");
    if (!message.includes("profile_id") && !message.includes("user_id")) throw error;
  }

  const profileRows = profileIds.map((profileId) => ({
    request_id: requestId,
    profile_id: profileId,
    assignment_role: roleFor(profileId),
    assigned_by: assignedBy || null
  }));
  try {
    await supabaseAdminFetch(tablePath("request_assignments"), {
      method: "POST",
      body: JSON.stringify(profileRows)
    });
    return;
  } catch (error) {
    if (!String(error.message || "").includes("profile_id")) throw error;
  }

  const userRows = profileIds.map((profileId) => ({
    request_id: requestId,
    user_id: profileId,
    assignment_role: roleFor(profileId),
    assigned_by: assignedBy || null
  }));
  await supabaseAdminFetch(tablePath("request_assignments"), {
    method: "POST",
    body: JSON.stringify(userRows)
  });
}

export async function PUT(request, { params }) {
  try {
    const profile = await requireProfileRole(request, managementRoles);
    const body = await request.json();
    const requestId = params.requestId;
    const profileIds = uniqueIds(body.profileIds);

    await supabaseAdminFetch(tablePath("request_assignments", `?request_id=eq.${encodeValue(requestId)}`), {
      method: "DELETE"
    });

    await insertAssignments(requestId, profileIds, body.assignedBy || profile.id);
    return apiJson({ ok: true });
  } catch (error) {
    return handleApiError(error);
  }
}
