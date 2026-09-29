import {
  apiJson,
  currentProfile,
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
    `?select=id,email,role,client_id,must_change_password&email=eq.${encodeValue(contact.email)}&limit=1`
  );

  if (!profile?.id) {
    const authUser = await createAuthUser(contact.email, contact.name || contact.email);
    const rows = await supabaseAdminFetch(tablePath("profiles", "?select=id,email,role,client_id,must_change_password"), {
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
    return { profile: rows?.[0] || null, needsSetup: true };
  }

  if (profile.role !== "client") {
    const error = new Error(`${contact.email} is an internal team member, so they cannot be added as a client CC contact.`);
    error.status = 400;
    throw error;
  }

  if (profile.client_id && profile.client_id !== clientId) {
    const error = new Error(`${contact.email} already belongs to another client organization.`);
    error.status = 400;
    throw error;
  }

  if (!profile.client_id) {
    const rows = await supabaseAdminFetch(
      tablePath("profiles", `?id=eq.${encodeValue(profile.id)}&select=id,email,role,client_id,must_change_password`),
      {
        method: "PATCH",
        headers: { Prefer: "return=representation" },
        body: JSON.stringify({ client_id: clientId })
      }
    );
    const updatedProfile = rows?.[0] || profile;
    return { profile: updatedProfile, needsSetup: Boolean(updatedProfile.must_change_password) };
  }

  return {
    profile,
    needsSetup: Boolean(profile.must_change_password)
  };
}

async function requestIsAccessibleToProfile(linkedRequest, profile) {
  if (managementRoles.has(profile.role)) return true;
  if (profile.role !== "client" || profile.client_id !== linkedRequest.client_id) return false;

  const client = await selectOne(
    "clients",
    `?select=id,primary_contact_email&id=eq.${encodeValue(linkedRequest.client_id)}&limit=1`
  );
  if (normalizeEmail(profile.email) === normalizeEmail(client?.primary_contact_email)) return true;

  const existingSelfContact = await selectOne(
    "request_client_contacts",
    `?select=id&request_id=eq.${encodeValue(linkedRequest.id)}&or=(profile_id.eq.${encodeValue(profile.id)},email.eq.${encodeValue(normalizeEmail(profile.email))})&limit=1`
  );
  return Boolean(existingSelfContact?.id);
}

async function sendContactAccessEmail({ contact, linkedRequest, alreadyOnRequest, needsSetup }) {
  const requestLabel = linkedRequest.request_number || linkedRequest.title || "this request";
  const emailResult = needsSetup
    ? await sendAccountSetupEmail({
      email: contact.email,
      name: contact.name,
      reason: `You have been CC’d on ${requestLabel} in Clients. Please set up your account to view request updates and messages.`
    })
    : await sendRequestAccessEmail({
      email: contact.email,
      name: contact.name,
      requestLabel
    });

  if (!emailResult.sent) {
    const action = needsSetup ? "setup" : "request access";
    const prefix = alreadyOnRequest ? "CC contact already exists, but" : "CC contact was added, but";
    throw new Error(`${prefix} ${action} email was not sent to ${contact.email}: ${emailResult.reason || "Unknown email error."}`);
  }

  return {
    email: contact.email,
    type: needsSetup ? "account_setup" : "request_access",
    ...emailResult
  };
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

    if (!contacts.length) {
      await supabaseAdminFetch(tablePath("request_client_contacts", `?request_id=eq.${encodeValue(requestId)}`), {
        method: "DELETE"
      });
      return apiJson({ ok: true });
    }

    const rows = [];
    const profileStatusByEmail = new Map();
    for (const contact of contacts) {
      const { profile, needsSetup } = await ensureClientProfile(contact, linkedRequest.client_id);
      profileStatusByEmail.set(contact.email, { profile, needsSetup });
      rows.push({
        request_id: requestId,
        profile_id: profile?.id || null,
        name: contact.name || null,
        email: contact.email
      });
    }

    const ccContactEmails = [];
    const requestLabel = linkedRequest.request_number || linkedRequest.title || "this request";
    for (const contact of contacts) {
      const { needsSetup } = profileStatusByEmail.get(contact.email) || {};
      if (existingEmails.has(contact.email) && !needsSetup) continue;
      const emailResult = needsSetup
        ? await sendAccountSetupEmail({
          email: contact.email,
          name: contact.name,
          reason: `You have been CC’d on ${requestLabel} in Clients. Please set up your account to view request updates and messages.`
        })
        : await sendRequestAccessEmail({
          email: contact.email,
          name: contact.name,
          requestLabel
        });
      ccContactEmails.push({
        email: contact.email,
        type: needsSetup ? "account_setup" : "request_access",
        ...emailResult
      });
      if (!emailResult.sent) {
        throw new Error(`CC contact was added, but ${needsSetup ? "setup" : "request access"} email was not sent to ${contact.email}: ${emailResult.reason || "Unknown email error."}`);
      }
    }

    await supabaseAdminFetch(tablePath("request_client_contacts", `?request_id=eq.${encodeValue(requestId)}`), {
      method: "DELETE"
    });

    await supabaseAdminFetch(tablePath("request_client_contacts"), {
      method: "POST",
      body: JSON.stringify(rows)
    });

    return apiJson({ ok: true, cc_contact_emails: ccContactEmails });
  } catch (error) {
    return handleApiError(error);
  }
}

export async function POST(request, { params }) {
  try {
    const actor = await currentProfile(request);
    const requestId = params.requestId;
    const body = await request.json();
    const contact = normalizedContacts([body.contact || body])[0];
    if (!contact?.email) return apiJson({ error: "Enter a CC contact email." }, 400);

    const linkedRequest = await selectOne(
      "requests",
      `?select=id,client_id,request_number,title&id=eq.${encodeValue(requestId)}&limit=1`
    );
    if (!linkedRequest?.id) return apiJson({ error: "Request not found." }, 404);

    const canAccessRequest = await requestIsAccessibleToProfile(linkedRequest, actor);
    if (!canAccessRequest) return apiJson({ error: "You do not have permission to add CC contacts to this request." }, 403);

    const client = await selectOne(
      "clients",
      `?select=id,primary_contact_email&id=eq.${encodeValue(linkedRequest.client_id)}&limit=1`
    );
    if (normalizeEmail(contact.email) === normalizeEmail(actor.email)) {
      return apiJson({ error: "You already have access to this request." }, 400);
    }
    if (normalizeEmail(contact.email) === normalizeEmail(client?.primary_contact_email)) {
      return apiJson({ error: "The primary contact already has access to this request." }, 400);
    }

    const existingContact = await selectOne(
      "request_client_contacts",
      `?select=id,profile_id,email&request_id=eq.${encodeValue(requestId)}&email=eq.${encodeValue(contact.email)}&limit=1`
    );

    const { profile, needsSetup } = await ensureClientProfile(contact, linkedRequest.client_id);
    if (!profile?.id) return apiJson({ error: "Could not prepare this CC contact." }, 400);

    if (existingContact?.id) {
      if (!existingContact.profile_id) {
        await supabaseAdminFetch(
          tablePath("request_client_contacts", `?id=eq.${encodeValue(existingContact.id)}`),
          {
            method: "PATCH",
            body: JSON.stringify({
              profile_id: profile.id,
              name: contact.name || null,
              email: contact.email
            })
          }
        );
      }

      const emailResult = needsSetup
        ? await sendContactAccessEmail({ contact, linkedRequest, alreadyOnRequest: true, needsSetup })
        : null;
      return apiJson({
        ok: true,
        already_exists: true,
        contact: {
          id: existingContact.id,
          request_id: requestId,
          profile_id: profile.id,
          name: contact.name || null,
          email: contact.email
        },
        cc_contact_email: emailResult
      });
    }

    const emailResult = await sendContactAccessEmail({ contact, linkedRequest, alreadyOnRequest: false, needsSetup });

    const rows = await supabaseAdminFetch(tablePath("request_client_contacts", "?select=id,request_id,profile_id,name,email,created_at"), {
      method: "POST",
      headers: { Prefer: "return=representation" },
      body: JSON.stringify({
        request_id: requestId,
        profile_id: profile.id,
        name: contact.name || null,
        email: contact.email
      })
    });

    return apiJson({
      ok: true,
      already_exists: false,
      contact: rows?.[0] || {
        request_id: requestId,
        profile_id: profile.id,
        name: contact.name || null,
        email: contact.email
      },
      cc_contact_email: emailResult
    });
  } catch (error) {
    return handleApiError(error);
  }
}
