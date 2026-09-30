import {
  apiJson,
  currentProfile,
  createAuthUser,
  encodeValue,
  handleApiError,
  inFilter,
  internalRoles,
  managementRoles,
  normalizeEmail,
  requireProfileRole,
  selectOne,
  sendAccountSetupEmail,
  supabaseAdminFetch,
  tablePath,
  teamRoles,
  visibleRequestIdsForClientProfile
} from "../_supabaseAdmin.js";

function teamSelect() {
  return "id,full_name,email,role,job_title,client_id";
}

function profilePayload(body, id) {
  const email = normalizeEmail(body.email);
  const role = String(body.role || "").trim();
  const fullName = String(body.fullName || "").trim();
  const jobTitle = String(body.jobTitle || "").trim() || role;

  if (!fullName) throw new Error("Full name is required.");
  if (!email) throw new Error("Email address is required.");
  if (!teamRoles.has(role)) throw new Error("Select a valid team role.");

  return {
    ...(id ? { id } : {}),
    full_name: fullName,
    email,
    role,
    job_title: jobTitle,
    client_id: null,
    is_active: true,
    must_change_password: true
  };
}

async function assignmentProfileIdsForRequests(requestIds) {
  if (!requestIds.length) return [];

  try {
    const assignments = await supabaseAdminFetch(
      tablePath("request_assignments", `?select=profile_id,user_id&request_id=${inFilter(requestIds)}`)
    );
    return [...new Set((assignments || [])
      .map((assignment) => assignment.profile_id || assignment.user_id)
      .filter(Boolean))];
  } catch (error) {
    const message = String(error.message || "");
    if (message.includes("profile_id")) {
      const assignments = await supabaseAdminFetch(
        tablePath("request_assignments", `?select=user_id&request_id=${inFilter(requestIds)}`)
      );
      return [...new Set((assignments || []).map((assignment) => assignment.user_id).filter(Boolean))];
    }
    if (message.includes("user_id")) {
      const assignments = await supabaseAdminFetch(
        tablePath("request_assignments", `?select=profile_id&request_id=${inFilter(requestIds)}`)
      );
      return [...new Set((assignments || []).map((assignment) => assignment.profile_id).filter(Boolean))];
    }
    throw error;
  }
}

export async function GET(request) {
  try {
    const profile = await currentProfile(request);
    if (profile.role === "client") {
      const requestIds = await visibleRequestIdsForClientProfile(profile);
      if (!requestIds.length) return apiJson([]);

      const profileIds = await assignmentProfileIdsForRequests(requestIds);
      if (!profileIds.length) return apiJson([]);

      const rows = await supabaseAdminFetch(
        tablePath("profiles", `?select=id,full_name,role,job_title&role=neq.client&id=${inFilter(profileIds)}&order=full_name.asc`)
      );
      return apiJson((rows || []).map((member) => ({
        ...member,
        email: ""
      })));
    }

    if (!internalRoles.has(profile.role)) {
      const error = new Error("You do not have permission to view team members.");
      error.status = 403;
      throw error;
    }

    const rows = await supabaseAdminFetch(
      tablePath("profiles", `?select=${teamSelect()}&role=neq.client&order=full_name.asc`)
    );
    return apiJson(rows || []);
  } catch (error) {
    return handleApiError(error);
  }
}

export async function POST(request) {
  try {
    await requireProfileRole(request, managementRoles);
    const body = await request.json();
    const email = normalizeEmail(body.email);

    const existingByEmail = await selectOne("profiles", `?select=id&email=eq.${encodeValue(email)}&limit=1`);
    if (existingByEmail?.id) {
      return apiJson({
        error: `User already exists for ${email}. Edit the existing team member instead.`
      }, 409);
    }

    const authUser = await createAuthUser(email, body.fullName);
    const payload = profilePayload(body, authUser.id);
    const existingByAuthId = await selectOne("profiles", `?select=id&id=eq.${encodeValue(authUser.id)}&limit=1`);

    const rows = await supabaseAdminFetch(
      tablePath("profiles", existingByAuthId?.id
        ? `?id=eq.${encodeValue(authUser.id)}&select=${teamSelect()}`
        : `?select=${teamSelect()}`),
      {
        method: existingByAuthId?.id ? "PATCH" : "POST",
        headers: { Prefer: "return=representation" },
        body: JSON.stringify(payload)
      }
    );

    await sendAccountSetupEmail({
      email,
      name: body.fullName,
      reason: "You have been added as a team member in Clients. Please create your password to view assigned requests and messages."
    });

    return apiJson(rows?.[0] || null);
  } catch (error) {
    return handleApiError(error);
  }
}
