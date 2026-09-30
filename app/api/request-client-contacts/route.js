import {
  apiJson,
  currentProfile,
  encodeValue,
  handleApiError,
  internalRoles,
  managementRoles,
  normalizeEmail,
  supabaseAdminFetch,
  tablePath
} from "../_supabaseAdmin.js";

function inList(values = []) {
  return `in.(${values.map((value) => encodeValue(value)).join(",")})`;
}

async function visibleRequestIdsForClient(profile) {
  if (profile.role !== "client") return [];

  const profileEmail = normalizeEmail(profile.email);
  const primaryRequestIds = [];

  if (profile.client_id) {
    const clients = await supabaseAdminFetch(
      tablePath("clients", `?select=primary_contact_email&id=eq.${encodeValue(profile.client_id)}&limit=1`)
    );
    const isPrimaryContact = normalizeEmail(clients?.[0]?.primary_contact_email) === profileEmail;

    if (isPrimaryContact) {
      const requests = await supabaseAdminFetch(
        tablePath("requests", `?select=id&client_id=eq.${encodeValue(profile.client_id)}`)
      );
      primaryRequestIds.push(...(requests || []).map((request) => request.id).filter(Boolean));
    }
  }

  const taggedContacts = await supabaseAdminFetch(
    tablePath("request_client_contacts", `?select=request_id&or=(profile_id.eq.${encodeValue(profile.id)},email.eq.${encodeValue(profileEmail)})`)
  );
  const taggedRequestIds = (taggedContacts || []).map((contact) => contact.request_id).filter(Boolean);

  return [...new Set([...primaryRequestIds, ...taggedRequestIds])];
}

export async function GET(request) {
  try {
    const profile = await currentProfile(request);
    let query = "?select=id,request_id,profile_id,name,email,created_at";

    if (!managementRoles.has(profile.role)) {
      if (profile.role === "client") {
        const requestIds = await visibleRequestIdsForClient(profile);
        if (!requestIds.length) return apiJson([]);
        query += `&request_id=${inList(requestIds)}`;
      } else if (internalRoles.has(profile.role)) {
        const assignments = await supabaseAdminFetch(
          tablePath("request_assignments", `?select=request_id&or=(profile_id.eq.${encodeValue(profile.id)},user_id.eq.${encodeValue(profile.id)})`)
        );
        const requestIds = [...new Set((assignments || []).map((assignment) => assignment.request_id).filter(Boolean))];
        if (!requestIds.length) return apiJson([]);
        query += `&request_id=${inList(requestIds)}`;
      } else {
        return apiJson([]);
      }
    }

    const rows = await supabaseAdminFetch(tablePath("request_client_contacts", query));
    return apiJson(rows || []);
  } catch (error) {
    if (String(error.message || "").includes("request_client_contacts")) return apiJson([]);
    return handleApiError(error);
  }
}
