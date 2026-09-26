import {
  apiJson,
  createAuthUser,
  encodeValue,
  handleApiError,
  internalRoles,
  managementRoles,
  normalizeEmail,
  requireProfileRole,
  selectOne,
  supabaseAdminFetch,
  tablePath,
  teamRoles
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

export async function GET(request) {
  try {
    await requireProfileRole(request, internalRoles);
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

    return apiJson(rows?.[0] || null);
  } catch (error) {
    return handleApiError(error);
  }
}
