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
} from "../../_supabaseAdmin.js";

function normalizedContacts(contacts) {
  return Array.from(new Map((contacts || [])
    .map((contact) => ({
      name: String(contact.name || "").trim(),
      email: normalizeEmail(contact.email)
    }))
    .filter((contact) => contact.email)
    .map((contact) => [contact.email, contact])).values());
}

async function ensureClientProfile(contact, clientId) {
  let profile = await selectOne(
    "profiles",
    `?select=id,email,role,client_id&email=eq.${encodeValue(contact.email)}&limit=1`
  );

  if (!profile?.id) {
    const authUser = await createAuthUser(contact.email, contact.name || contact.email);
    const rows = await supabaseAdminFetch(tablePath("profiles", "?select=id,email,role,client_id"), {
      method: "POST",
      headers: { Prefer: "return=representation" },
      body: JSON.stringify({
        id: authUser.id,
        full_name: contact.name || contact.email,
        email: contact.email,
        role: "client",
        client_id: clientId,
        job_title: "Client Contact",
        must_change_password: true
      })
    });
    return rows?.[0] || null;
  }

  if (profile.role === "client" && !profile.client_id) {
    const rows = await supabaseAdminFetch(
      tablePath("profiles", `?id=eq.${encodeValue(profile.id)}&select=id,email,role,client_id`),
      {
        method: "PATCH",
        headers: { Prefer: "return=representation" },
        body: JSON.stringify({ client_id: clientId })
      }
    );
    return rows?.[0] || profile;
  }

  return profile.role === "client" ? profile : null;
}

export async function PUT(request, { params }) {
  try {
    await requireProfileRole(request, managementRoles);
    const requestId = params.requestId;
    const body = await request.json();
    const contacts = normalizedContacts(body.contacts);

    const linkedRequest = await selectOne(
      "requests",
      `?select=id,client_id,request_number,title&id=eq.${encodeValue(requestId)}&limit=1`
    );
    if (!linkedRequest?.id) return apiJson({ error: "Request not found." }, 404);

    const existingContacts = await supabaseAdminFetch(
      tablePath("request_client_contacts", `?select=email&request_id=eq.${encodeValue(requestId)}`)
    );
    const existingEmails = new Set((existingContacts || []).map((contact) => normalizeEmail(contact.email)));

    await supabaseAdminFetch(tablePath("request_client_contacts", `?request_id=eq.${encodeValue(requestId)}`), {
      method: "DELETE"
    });

    if (!contacts.length) return apiJson({ ok: true });

    const rows = [];
    for (const contact of contacts) {
      const profile = await ensureClientProfile(contact, linkedRequest.client_id);
      rows.push({
        request_id: requestId,
        profile_id: profile?.id || null,
        name: contact.name || null,
        email: contact.email
      });
    }

    await supabaseAdminFetch(tablePath("request_client_contacts"), {
      method: "POST",
      body: JSON.stringify(rows)
    });

    const requestLabel = linkedRequest.request_number || linkedRequest.title || "this request";
    for (const contact of contacts) {
      if (existingEmails.has(contact.email)) continue;
      await sendAccountSetupEmail({
        email: contact.email,
        name: contact.name,
        reason: `You have been added to ${requestLabel} in Clients. Please create your password to view request updates and messages.`
      });
    }

    return apiJson({ ok: true });
  } catch (error) {
    return handleApiError(error);
  }
}
