import {
  apiJson,
  encodeValue,
  handleApiError,
  managementRoles,
  normalizeEmail,
  requireProfileRole,
  selectOne,
  supabaseAdminFetch,
  tablePath
} from "../../_supabaseAdmin.js";

export async function DELETE(request, { params }) {
  try {
    await requireProfileRole(request, managementRoles);
    const contactId = String(params.contactId || "").trim();
    if (!contactId) return apiJson({ error: "CC contact is required." }, 400);

    const contact = await selectOne(
      "profiles",
      `?select=id,email,role,client_id&id=eq.${encodeValue(contactId)}&limit=1`
    );
    if (!contact?.id || contact.role !== "client" || !contact.client_id) {
      return apiJson({ error: "Saved CC contact was not found." }, 404);
    }

    const client = await selectOne(
      "clients",
      `?select=id,primary_contact_email&id=eq.${encodeValue(contact.client_id)}&limit=1`
    );
    if (normalizeEmail(contact.email) === normalizeEmail(client?.primary_contact_email)) {
      return apiJson({ error: "The primary contact cannot be removed as a CC contact." }, 400);
    }

    // Remove request-level access before unlinking the profile from the organization.
    await supabaseAdminFetch(
      tablePath("request_client_contacts", `?profile_id=eq.${encodeValue(contact.id)}`),
      { method: "DELETE" }
    );
    await supabaseAdminFetch(
      tablePath("request_client_contacts", `?email=eq.${encodeValue(normalizeEmail(contact.email))}`),
      { method: "DELETE" }
    );

    const rows = await supabaseAdminFetch(
      tablePath("profiles", `?id=eq.${encodeValue(contact.id)}&select=id,full_name,email,role,client_id,job_title,must_change_password`),
      {
        method: "PATCH",
        headers: { Prefer: "return=representation" },
        body: JSON.stringify({ client_id: null })
      }
    );

    return apiJson({ ok: true, contact: rows?.[0] || { ...contact, client_id: null } });
  } catch (error) {
    return handleApiError(error);
  }
}
