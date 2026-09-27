import {
  apiJson,
  currentProfile,
  encodeValue,
  handleApiError,
  supabaseAdminFetch,
  tablePath
} from "../_supabaseAdmin.js";

async function profileWithClient(profile) {
  if (!profile?.client_id) return { ...profile, clients: null };

  const clients = await supabaseAdminFetch(
    tablePath("clients", `?select=id,name,primary_contact_name,primary_contact_email,billing_email,created_at&id=eq.${encodeValue(profile.client_id)}&limit=1`)
  );

  return {
    ...profile,
    clients: clients?.[0] || null
  };
}

export async function GET(request) {
  try {
    const profile = await currentProfile(request);
    return apiJson(await profileWithClient(profile));
  } catch (error) {
    return handleApiError(error);
  }
}
