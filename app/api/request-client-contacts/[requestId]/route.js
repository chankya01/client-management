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
  sendRequestAccessEmail,
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
    return { profile: rows?.[0] || null, created: true };
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
    return { profile: rows?.[0] || profile, created: false };
  }

  return { profile: profile.role === "client" ? profile : null, created: false };
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
    const profileStatusByEmail = new Map();
    for (const contact of contacts) {
      const { profile, created } = await ensureClientProfile(contact, linkedRequest.client_id);
      profileStatusByEmail.set(contact.email, { profile, created });
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

    const followerEmails = [];
    const requestLabel = linkedRequest.request_number || linkedRequest.title || "this request";
    for (const contact of contacts) {
      if (existingEmails.has(contact.email)) continue;
      const { created } = profileStatusByEmail.get(contact.email) || {};
      const emailResult = created
        ? await sendAccountSetupEmail({
          email: contact.email,
          name: contact.name,
          reason: `You have been added to ${requestLabel} in Clients. Please set up your account to view request updates and messages.`
        })
        : await sendRequestAccessEmail({
          email: contact.email,
          name: contact.name,
          requestLabel
        });
      followerEmails.push({
        email: contact.email,
        type: created ? "account_setup" : "request_access",
        ...emailResult
      });
      if (!emailResult.sent) {
        throw new Error(`Client follower was added, but ${created ? "setup" : "request access"} email was not sent to ${contact.email}: ${emailResult.reason || "Unknown email error."}`);
      }
    }

    return apiJson({ ok: true, follower_emails: followerEmails });
  } catch (error) {
    return handleApiError(error);
  }
}
