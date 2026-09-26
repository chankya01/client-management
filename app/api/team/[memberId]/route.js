import {
  apiJson,
  encodeValue,
  handleApiError,
  managementRoles,
  normalizeEmail,
  requireProfileRole,
  selectOne,
  supabaseAdminFetch,
  tablePath,
  teamRoles
} from "../../_supabaseAdmin.js";

function teamSelect() {
  return "id,full_name,email,role,job_title,client_id";
}

function updatePayload(body) {
  const email = normalizeEmail(body.email);
  const role = String(body.role || "").trim();
  const fullName = String(body.fullName || "").trim();

  if (!fullName) throw new Error("Full name is required.");
  if (!email) throw new Error("Email address is required.");
  if (!teamRoles.has(role)) throw new Error("Select a valid team role.");

  return {
    full_name: fullName,
    email,
    role,
    job_title: String(body.jobTitle || "").trim() || role,
    client_id: null,
    is_active: true
  };
}

export async function PUT(request, { params }) {
  try {
    await requireProfileRole(request, managementRoles);
    const body = await request.json();
    const memberId = params.memberId;
    const email = normalizeEmail(body.email);

    const duplicate = await selectOne(
      "profiles",
      `?select=id&email=eq.${encodeValue(email)}&id=neq.${encodeValue(memberId)}&limit=1`
    );
    if (duplicate?.id) {
      return apiJson({ error: `User already exists for ${email}. Use the existing profile.` }, 409);
    }

    const rows = await supabaseAdminFetch(
      tablePath("profiles", `?id=eq.${encodeValue(memberId)}&select=${teamSelect()}`),
      {
        method: "PATCH",
        headers: { Prefer: "return=representation" },
        body: JSON.stringify(updatePayload(body))
      }
    );

    return apiJson(rows?.[0] || null);
  } catch (error) {
    return handleApiError(error);
  }
}

export async function DELETE(request, { params }) {
  try {
    await requireProfileRole(request, managementRoles);
    await supabaseAdminFetch(tablePath("profiles", `?id=eq.${encodeValue(params.memberId)}`), {
      method: "DELETE"
    });
    return apiJson({ ok: true });
  } catch (error) {
    return handleApiError(error);
  }
}
