import {
  apiJson,
  createAuthUser,
  encodeValue,
  handleApiError,
  managementRoles,
  normalizeEmail,
  requireProfileRole,
  selectOne,
  sendAccountSetupEmail,
  supabaseAdminFetch,
  tablePath
} from "../_supabaseAdmin.js";

function contactSelect() {
  return "id,full_name,email,role,client_id,job_title,must_change_password";
}

export async function GET(request) {
  try {
    await requireProfileRole(request, managementRoles);
    const rows = await supabaseAdminFetch(
      tablePath("profiles", `?select=${contactSelect()}&role=eq.client&order=full_name.asc`)
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
    const clientId = String(body.clientId || "").trim();
    const fullName = String(body.fullName || "").trim();
    const email = normalizeEmail(body.email);

    if (!clientId) throw new Error("Organization is required.");
    if (!fullName) throw new Error("Contact name is required.");
    if (!email) throw new Error("Contact email is required.");

    const client = await selectOne(
      "clients",
      `?select=id,name&id=eq.${encodeValue(clientId)}&limit=1`
    );
    if (!client?.id) throw new Error("Organization was not found.");

    const existingProfile = await selectOne(
      "profiles",
      `?select=${contactSelect()}&email=eq.${encodeValue(email)}&limit=1`
    );

    if (existingProfile?.id && existingProfile.role !== "client") {
      throw new Error(`${email} already belongs to an internal team member.`);
    }
    if (existingProfile?.id && existingProfile.client_id && existingProfile.client_id !== clientId) {
      throw new Error(`${email} is already linked to another organization.`);
    }

    let profile;
    let needsSetup = true;
    if (existingProfile?.id) {
      const rows = await supabaseAdminFetch(
        tablePath("profiles", `?id=eq.${encodeValue(existingProfile.id)}&select=${contactSelect()}`),
        {
          method: "PATCH",
          headers: { Prefer: "return=representation" },
          body: JSON.stringify({
            full_name: fullName,
            email,
            role: "client",
            client_id: clientId,
            job_title: existingProfile.job_title || "Client Contact",
            is_active: true
          })
        }
      );
      profile = rows?.[0] || existingProfile;
      needsSetup = Boolean(profile.must_change_password);
    } else {
      const authUser = await createAuthUser(email, fullName);
      const rows = await supabaseAdminFetch(tablePath("profiles", `?select=${contactSelect()}`), {
        method: "POST",
        headers: { Prefer: "return=representation" },
        body: JSON.stringify({
          id: authUser.id,
          full_name: fullName,
          email,
          role: "client",
          client_id: clientId,
          job_title: "Client Contact",
          is_active: true,
          must_change_password: true
        })
      });
      profile = rows?.[0] || null;
    }

    const accountSetupEmail = needsSetup
      ? await sendAccountSetupEmail({
        email,
        name: fullName,
        reason: `You have been added as a contact for ${client.name} in Clients. Please set up your account to view request updates and messages.`
      })
      : { sent: false, reason: "Contact already has an active account." };

    if (needsSetup && !accountSetupEmail.sent) {
      throw new Error(`Contact was created, but setup email was not sent to ${email}: ${accountSetupEmail.reason || "Unknown email error."}`);
    }

    return apiJson({
      ...profile,
      account_setup_email: accountSetupEmail
    });
  } catch (error) {
    return handleApiError(error);
  }
}
