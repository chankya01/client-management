import { NextResponse } from "next/server";
import { appConfig } from "../../src/config.js";

const supabaseUrl = process.env.SUPABASE_URL
  || process.env.NEXT_PUBLIC_SUPABASE_URL
  || process.env.VITE_SUPABASE_URL
  || appConfig.supabaseUrl;

const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY
  || process.env.SUPABASE_SERVICE_KEY
  || process.env.SUPABASE_SECRET_KEY
  || process.env.SERVICE_ROLE_KEY;

const anonKey = process.env.SUPABASE_ANON_KEY
  || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
  || process.env.VITE_SUPABASE_ANON_KEY
  || appConfig.supabaseAnonKey;

const resendApiKey = process.env.RESEND_API_KEY;
const notificationFrom = process.env.NOTIFICATION_FROM || "Clients <notifications@example.com>";
const appUrl = process.env.APP_URL || process.env.NEXT_PUBLIC_APP_URL || "";

export const managementRoles = new Set(["owner", "project_manager"]);
export const internalRoles = new Set(["owner", "project_manager", "developer", "reviewer", "assignee"]);
export const teamRoles = new Set(["owner", "project_manager", "developer", "reviewer", "assignee"]);

export function apiJson(payload, status = 200) {
  return NextResponse.json(payload, {
    status,
    headers: { "Cache-Control": "no-store" }
  });
}

export function normalizeEmail(email) {
  return String(email || "").trim().toLowerCase();
}

export function requireSupabaseAdmin() {
  if (!supabaseUrl || !serviceRoleKey) {
    const missing = [
      !supabaseUrl ? "SUPABASE_URL" : "",
      !serviceRoleKey ? "SUPABASE_SERVICE_ROLE_KEY" : ""
    ].filter(Boolean).join(" and ");
    throw new Error(`Server team API is not configured. Missing ${missing}. Check Vercel Environment Variables for the current environment, then redeploy.`);
  }
}

function rest(table, query = "") {
  return `/rest/v1/${table}${query}`;
}

export function tablePath(table, query = "") {
  return rest(table, query);
}

export function encodeValue(value) {
  return encodeURIComponent(value);
}

function isMissingPasswordFlagError(message) {
  return String(message || "").includes("profiles.must_change_password")
    || String(message || "").includes("must_change_password");
}

function removePasswordFlagFromPath(path) {
  return path
    .replaceAll(",must_change_password", "")
    .replaceAll("must_change_password,", "")
    .replaceAll("must_change_password", "");
}

function removePasswordFlagFromBody(body) {
  if (typeof body !== "string") return body;
  try {
    const parsed = JSON.parse(body);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      delete parsed.must_change_password;
      return JSON.stringify(parsed);
    }
  } catch {
    return body;
  }
  return body;
}

async function fetchSupabase(path, options = {}) {
  requireSupabaseAdmin();
  const requestOptions = { ...options };
  const response = await fetch(`${supabaseUrl}${path}`, {
    ...requestOptions,
    headers: {
      apikey: serviceRoleKey,
      Authorization: `Bearer ${serviceRoleKey}`,
      "Content-Type": "application/json",
      ...(requestOptions.headers || {})
    },
    cache: "no-store"
  });

  const contentType = response.headers.get("content-type") || "";
  const payload = contentType.includes("application/json")
    ? await response.json()
    : await response.text();

  if (!response.ok) {
    const message = typeof payload === "string"
      ? payload
      : payload?.message || payload?.msg || payload?.error_description || payload?.error;
    throw new Error(message || `Supabase request failed: ${response.status}`);
  }

  return payload;
}

export async function supabaseAdminFetch(path, options = {}) {
  try {
    return await fetchSupabase(path, options);
  } catch (error) {
    if (!isMissingPasswordFlagError(error.message)) throw error;
    return fetchSupabase(removePasswordFlagFromPath(path), {
      ...options,
      body: removePasswordFlagFromBody(options.body)
    });
  }
}

export async function selectOne(table, query) {
  const rows = await supabaseAdminFetch(rest(table, query), {
    headers: { Accept: "application/json" }
  });
  return Array.isArray(rows) ? rows[0] || null : rows;
}

async function userFromToken(token) {
  const response = await fetch(`${supabaseUrl}/auth/v1/user`, {
    headers: {
      apikey: anonKey || serviceRoleKey,
      Authorization: `Bearer ${token}`
    },
    cache: "no-store"
  });

  if (!response.ok) return null;
  return response.json();
}

export async function currentProfile(request) {
  requireSupabaseAdmin();
  const authHeader = request.headers.get("authorization") || "";
  const token = authHeader.replace(/^Bearer\s+/i, "").trim();
  if (!token) {
    const error = new Error("Please sign in again before managing team members.");
    error.status = 401;
    throw error;
  }

  const user = await userFromToken(token);
  if (!user?.id) {
    const error = new Error("Your session expired. Please sign in again.");
    error.status = 401;
    throw error;
  }

  const profile = await selectOne(
    "profiles",
    `?select=id,full_name,email,role,client_id,job_title,phone,must_change_password&or=(id.eq.${encodeValue(user.id)},email.eq.${encodeValue(normalizeEmail(user.email))})&limit=1`
  );

  if (!profile?.id) {
    const error = new Error("No profile is linked to this signed-in account.");
    error.status = 403;
    throw error;
  }

  return profile;
}

export async function requireProfileRole(request, allowedRoles) {
  const profile = await currentProfile(request);
  if (!allowedRoles.has(profile.role)) {
    const error = new Error("You do not have permission to perform this action.");
    error.status = 403;
    throw error;
  }
  return profile;
}

export async function createAuthUser(email, fullName, password = process.env.DEFAULT_TEMP_PASSWORD || "RequestManagement@123") {
  const normalizedEmail = normalizeEmail(email);
  const users = await supabaseAdminFetch("/auth/v1/admin/users?page=1&per_page=1000");
  const existing = users?.users?.find((user) => normalizeEmail(user.email) === normalizedEmail);
  if (existing) {
    await supabaseAdminFetch(`/auth/v1/admin/users/${existing.id}`, {
      method: "PUT",
      body: JSON.stringify({
        password,
        email_confirm: true,
        user_metadata: {
          ...(existing.user_metadata || {}),
          full_name: fullName || existing.user_metadata?.full_name || normalizedEmail
        }
      })
    });
    return existing;
  }

  return supabaseAdminFetch("/auth/v1/admin/users", {
    method: "POST",
    body: JSON.stringify({
      email: normalizedEmail,
      password,
      email_confirm: true,
      user_metadata: { full_name: fullName || normalizedEmail }
    })
  });
}

export async function generatePasswordSetupLink(email) {
  const normalizedEmail = normalizeEmail(email);
  const redirectTo = appUrl ? `${appUrl}?mode=password-reset&type=recovery` : undefined;
  const payload = await supabaseAdminFetch("/auth/v1/admin/generate_link", {
    method: "POST",
    body: JSON.stringify({
      type: "recovery",
      email: normalizedEmail,
      ...(redirectTo ? { options: { redirect_to: redirectTo } } : {})
    })
  });
  return payload?.properties?.action_link || payload?.action_link || payload?.actionLink || null;
}

export async function sendAccountSetupEmail({ email, name, reason }) {
  const normalizedEmail = normalizeEmail(email);
  if (!normalizedEmail) return { sent: false, reason: "No email address was provided." };
  if (!resendApiKey) {
    const reasonText = "RESEND_API_KEY is not configured.";
    console.warn(`[Clients] ${reasonText} Skipping account setup email.`);
    return { sent: false, reason: reasonText };
  }
  if (notificationFrom.includes("yourdomain.com") || notificationFrom.includes("example.com")) {
    const reasonText = "NOTIFICATION_FROM still uses a placeholder domain. Add a verified Resend sender/domain.";
    console.warn(`[Clients] ${reasonText}`);
    return { sent: false, reason: reasonText };
  }

  let setupLink;
  try {
    setupLink = await generatePasswordSetupLink(normalizedEmail);
  } catch (error) {
    const reasonText = error?.message || "Could not generate password setup link.";
    console.warn("[Clients] Account setup link generation failed", reasonText);
    return { sent: false, reason: reasonText };
  }
  if (!setupLink) {
    const reasonText = "Supabase did not return a password setup link.";
    console.warn(`[Clients] ${reasonText} ${normalizedEmail}`);
    return { sent: false, reason: reasonText };
  }

  const greeting = name ? `Hi ${name},` : "Hi,";
  const text = `${greeting}\n\n${reason || "You have been added to Clients."}\n\nCreate your password and sign in here:\n${setupLink}\n\nIf you were not expecting this, you can ignore this email.`;
  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${resendApiKey}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      from: notificationFrom,
      to: [normalizedEmail],
      subject: "You have been added to Clients",
      text
    })
  });

  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    console.warn("[Clients] Account setup email failed", detail);
    return { sent: false, reason: detail || `Resend returned ${response.status}.` };
  }

  const payload = await response.json().catch(() => ({}));
  return { sent: true, id: payload?.id || null };
}

export function handleApiError(error) {
  return apiJson({ error: error.message || "Unexpected server error." }, error.status || 500);
}
