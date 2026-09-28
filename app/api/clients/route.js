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

function clientSelect() {
  return "id,name,primary_contact_name,primary_contact_email,billing_email,status,created_at";
}

export async function POST(request) {
  try {
    await requireProfileRole(request, managementRoles);
    const body = await request.json();
    const email = normalizeEmail(body.email);
    const name = String(body.name || "").trim();
    const contactName = String(body.contactName || "").trim();

    if (!name) throw new Error("Client name is required.");
    if (!contactName) throw new Error("Primary contact name is required.");
    if (!email) throw new Error("Primary contact email is required.");

    const duplicateClient = await selectOne(
      "clients",
      `?select=id,name,primary_contact_email&primary_contact_email=ilike.${encodeValue(email)}&limit=1`
    );
    if (duplicateClient) {
      return apiJson({
        error: `Client already exists for ${email}. Open the existing client instead of creating another one.`
      }, 409);
    }

    const rows = await supabaseAdminFetch(tablePath("clients", `?select=${clientSelect()}`), {
      method: "POST",
      headers: { Prefer: "return=representation" },
      body: JSON.stringify({
        name,
        primary_contact_name: contactName,
        primary_contact_email: email,
        billing_email: normalizeEmail(body.billingEmail || email),
        status: body.status || "signed"
      })
    });
    const client = rows?.[0] || null;
    if (!client?.id) throw new Error("Client could not be created.");

    const authUser = await createAuthUser(email, contactName);
    const existingProfile = await selectOne("profiles", `?select=id&email=eq.${encodeValue(email)}&limit=1`);
    const profilePayload = {
      full_name: contactName,
      email,
      role: "client",
      client_id: client.id,
      job_title: "Client contact",
      is_active: true,
      must_change_password: true
    };

    if (existingProfile?.id) {
      await supabaseAdminFetch(tablePath("profiles", `?id=eq.${encodeValue(existingProfile.id)}`), {
        method: "PATCH",
        body: JSON.stringify(profilePayload)
      });
    } else {
      await supabaseAdminFetch(tablePath("profiles"), {
        method: "POST",
        body: JSON.stringify({
          id: authUser.id,
          ...profilePayload
        })
      });
    }

    const accountSetupEmail = await sendAccountSetupEmail({
      email,
      name: contactName,
      reason: `You have been added to Clients for ${name}. Please create your password to view requests and messages.`
    });

    return apiJson({
      ...client,
      account_setup_email: accountSetupEmail
    });
  } catch (error) {
    return handleApiError(error);
  }
}
