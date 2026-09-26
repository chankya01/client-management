import { appConfig } from "./config.js";
import { isSupabaseConfigured, supabase } from "./supabase.js";

const demoIds = {
  clientId: "00000000-0000-4000-8000-000000000001",
  userId: "00000000-0000-4000-8000-000000000002",
  adminId: "00000000-0000-4000-8000-000000000099",
  requestId: "00000000-0000-4000-8000-000000000003"
};

const demoProfile = {
  id: demoIds.userId,
  full_name: "Dana Whitfield",
  email: "dana.whitfield@northwindhealth.com",
  role: "client",
  client_id: demoIds.clientId,
  job_title: "Product Director",
  phone: "",
  must_change_password: false,
  clients: {
    id: demoIds.clientId,
    name: "Northwind Health",
    primary_contact_name: "Dana Whitfield",
    primary_contact_email: "dana.whitfield@northwindhealth.com",
    billing_email: "ap@northwindhealth.com",
    created_at: "2025-10-08T00:00:00.000Z"
  }
};

const demoAdminProfile = {
  id: demoIds.adminId,
  full_name: "Sani Thakur",
  email: "sanithakur544@gmail.com",
  role: "owner",
  client_id: null,
  job_title: "Owner",
  phone: "",
  must_change_password: false,
  clients: null
};

function normalizeEmail(email) {
  return String(email || "").trim().toLowerCase();
}

function isLocalAdminMode() {
  return Boolean(
    appConfig.localAdminMode
    && typeof window !== "undefined"
    && ["localhost", "127.0.0.1"].includes(window.location.hostname)
  );
}

function localView() {
  if (typeof window === "undefined") return "admin";
  const requestedView = new URLSearchParams(window.location.search).get("view");
  if (requestedView === "client") return "client";
  if (requestedView === "admin") return "admin";
  if ((appConfig.localClientPorts || []).includes(window.location.port)) return "client";
  return appConfig.localView || "admin";
}

function isConfiguredAdminEmail(email) {
  return (appConfig.adminEmails || []).map(normalizeEmail).includes(normalizeEmail(email));
}

function useLocalAdminProxy() {
  return Boolean(isLocalAdminMode() && appConfig.localSupabaseAdminProxy);
}

export function isLocalAutoLoginMode() {
  return isLocalAdminMode() || useDemo();
}

async function localApi(path, options = {}) {
  const baseUrl = appConfig.localProxyUrl || "/api";
  const separator = path.includes("?") ? "&" : "?";
  const pathWithView = useLocalAdminProxy()
    ? `${path}${separator}view=${encodeURIComponent(localView())}`
    : path;
  let accessToken = "";
  try {
    const { data } = await supabase.auth.getSession();
    accessToken = data?.session?.access_token || "";
  } catch {
    accessToken = "";
  }
  const response = await fetch(`${baseUrl}${pathWithView}`, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
      ...(options.headers || {})
    }
  });

  const contentType = response.headers.get("content-type") || "";
  const payload = contentType.includes("application/json")
    ? await response.json()
    : await response.text();

  if (!response.ok) {
    const message = typeof payload === "string" ? payload : payload?.error;
    throw new Error(message || `Local Supabase API failed: ${response.status}`);
  }

  return payload;
}

async function fileToBase64(file) {
  const buffer = await file.arrayBuffer();
  let binary = "";
  const bytes = new Uint8Array(buffer);
  const chunkSize = 0x8000;
  for (let index = 0; index < bytes.length; index += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunkSize));
  }
  return btoa(binary);
}

function configuredAdminProfile(user) {
  const email = normalizeEmail(user?.email);
  return {
    id: user?.id || demoIds.adminId,
    full_name: email === "sanithakur544@gmail.com" ? "Sani Thakur" : email,
    email,
    role: "owner",
    client_id: null,
    job_title: "Owner",
    phone: "",
    must_change_password: false,
    clients: null
  };
}

function demoSession() {
  if (isLocalAdminMode()) {
    return {
      user: {
        id: demoIds.adminId,
        email: demoAdminProfile.email
      }
    };
  }

  const storedEmail = localStorage.getItem("requestManagementDemoEmail");
  if (!storedEmail) return null;
  const normalizedEmail = normalizeEmail(storedEmail);
  const teamMember = demoTeam.find((member) => member.email === normalizedEmail);
  return {
    user: {
      id: teamMember?.id || (normalizedEmail === demoAdminProfile.email ? demoIds.adminId : demoIds.userId),
      email: storedEmail
    }
  };
}

let demoMessages = [
  {
    id: "m1",
    request_id: demoIds.requestId,
    sender_id: "team-1",
    message: "Scope confirmed: WCAG 2.1 AA audit of the marketing site and member portal, plus a VPAT 2.5 Rev. Kickoff Monday.",
    is_internal: false,
    created_at: "2026-08-24T09:12:00.000Z",
    profiles: { full_name: "Kris Rivenburgh", role: "project_manager" }
  },
  {
    id: "m2",
    request_id: demoIds.requestId,
    sender_id: demoIds.userId,
    message: "Confirmed. Staging credentials are in the shared vault under Northwind / Accessible.",
    is_internal: false,
    created_at: "2026-08-24T14:40:00.000Z",
    profiles: { full_name: "Dana Whitfield", role: "client" }
  },
  {
    id: "m3",
    request_id: demoIds.requestId,
    sender_id: "team-1",
    message: "Audit report is posted under Deliverables. 146 issues, 38 of them critical. Everything is loaded into Accessibility Tracker with recommended fixes.",
    is_internal: false,
    created_at: "2026-09-04T11:05:00.000Z",
    profiles: { full_name: "Kris Rivenburgh", role: "project_manager" }
  },
  {
    id: "m4",
    request_id: demoIds.requestId,
    sender_id: demoIds.userId,
    message: "Engineering has cleared the critical set. Working through serious issues this sprint.",
    is_internal: false,
    created_at: "2026-09-15T16:22:00.000Z",
    profiles: { full_name: "Dana Whitfield", role: "client" }
  }
];

const demoRequests = [
  {
    id: demoIds.requestId,
    request_number: "REQ-1001",
    client_id: demoIds.clientId,
    title: "Northwind Health WCAG Audit + VPAT",
    description: "Your team is fixing the issues listed in the audit report. Tell us when you are ready and we will begin validation.",
    service_type: "WCAG 2.1 AA Audit - marketing site and member portal",
    status: "remediation",
    due_date: "2026-09-30",
    created_at: "2026-08-24T00:00:00.000Z",
    updated_at: "2026-09-18T08:30:00.000Z",
    closed_at: null
  }
];

const demoClients = [
  {
    id: demoIds.clientId,
    name: "Northwind Health",
    primary_contact_name: "Dana Whitfield",
    primary_contact_email: "dana.whitfield@northwindhealth.com",
    billing_email: "ap@northwindhealth.com",
    status: "active",
    created_at: "2025-10-08T00:00:00.000Z"
  },
  {
    id: "00000000-0000-4000-8000-000000000004",
    name: "Apex Retail",
    primary_contact_name: "Maya Shah",
    primary_contact_email: "maya@apexretail.com",
    billing_email: "billing@apexretail.com",
    status: "active",
    created_at: "2026-01-12T00:00:00.000Z"
  }
];

const demoTeam = [
  { id: demoIds.adminId, full_name: "Sani Thakur", email: "sanithakur544@gmail.com", role: "owner", job_title: "Owner" },
  { id: "team-1", full_name: "Kris Rivenburgh", email: "kris@accessible.org", role: "project_manager", job_title: "Project Manager" },
  { id: "team-2", full_name: "John Davis", email: "john@accessible.org", role: "developer", job_title: "Accessibility Developer" },
  { id: "team-3", full_name: "Sarah Jones", email: "sarah@accessible.org", role: "reviewer", job_title: "Reviewer" }
];

const demoHistory = [
  {
    id: "history-1",
    request_number: "REQ-0912",
    client_id: demoIds.clientId,
    title: "Mobile app audit - iOS and Android",
    description: "WCAG 2.1 AA audit of the Northwind member app. Completed and validated March 2026.",
    service_type: "Mobile accessibility audit",
    status: "closed",
    closed_at: "2026-03-27T00:00:00.000Z",
    created_at: "2026-02-19T00:00:00.000Z"
  },
  {
    id: "history-2",
    request_number: "REQ-0724",
    client_id: demoIds.clientId,
    title: "VPAT 2.4 Rev - member portal",
    description: "VPAT completed and ACR issued for the 2025 procurement cycle.",
    service_type: "VPAT / ACR",
    status: "closed",
    closed_at: "2025-10-08T00:00:00.000Z",
    created_at: "2025-09-18T00:00:00.000Z"
  }
];

const demoDeliverables = [
  {
    id: "d1",
    request_id: demoIds.requestId,
    title: "Northwind Health - WCAG 2.1 AA Audit Report.pdf",
    version: "1.0",
    status: "sent",
    sent_at: "2026-09-04T00:00:00.000Z",
    created_at: "2026-09-04T00:00:00.000Z",
    files: {
      id: "file-1",
      bucket_name: "deliverables",
      storage_path: `${demoIds.clientId}/${demoIds.requestId}/audit-report.pdf`,
      file_name: "Northwind Health - WCAG 2.1 AA Audit Report.pdf"
    }
  },
  {
    id: "d2",
    request_id: demoIds.requestId,
    title: "Issue export for Accessibility Tracker.csv",
    version: "1.0",
    status: "sent",
    sent_at: "2026-09-04T00:00:00.000Z",
    created_at: "2026-09-04T00:00:00.000Z",
    files: {
      id: "file-2",
      bucket_name: "deliverables",
      storage_path: `${demoIds.clientId}/${demoIds.requestId}/issue-export.csv`,
      file_name: "Issue export for Accessibility Tracker.csv"
    }
  }
];

function useDemo() {
  return appConfig.demoMode || !isSupabaseConfigured;
}

export async function getSession() {
  if (isLocalAdminMode() || useDemo()) {
    return demoSession();
  }

  if (typeof window !== "undefined") {
    const params = new URLSearchParams(window.location.search);
    const code = params.get("code");
    if (code) {
      const exchange = await supabase.auth.exchangeCodeForSession(code);
      if (exchange.error) throw exchange.error;
    }
  }

  const { data, error } = await supabase.auth.getSession();
  if (error) throw error;
  return data.session;
}

export async function sendMagicLink(email) {
  if (isLocalAdminMode() || useDemo()) {
    localStorage.setItem("requestManagementDemoEmail", normalizeEmail(email));
    return demoSession();
  }

  const redirectTo = window.location.origin;
  const { error } = await supabase.auth.signInWithOtp({
    email,
    options: {
      emailRedirectTo: redirectTo
    }
  });
  if (error) throw error;
}

export async function signInWithPassword(email, password) {
  if (useLocalAdminProxy()) {
    const data = await localApi("/auth/password", {
      method: "POST",
      body: JSON.stringify({ email, password })
    });
    return {
      user: {
        id: data.user?.id || demoIds.adminId,
        email: data.user?.email || normalizeEmail(email)
      }
    };
  }

  if (isLocalAdminMode() || useDemo()) {
    localStorage.setItem("requestManagementDemoEmail", normalizeEmail(email));
    return demoSession();
  }

  const { data, error } = await supabase.auth.signInWithPassword({
    email: normalizeEmail(email),
    password
  });
  if (error) throw error;
  return data.session;
}

export async function sendPasswordReset(email) {
  if (isLocalAdminMode() || useDemo()) {
    return;
  }

  const { error } = await supabase.auth.resetPasswordForEmail(normalizeEmail(email), {
    redirectTo: `${window.location.origin}?mode=password-reset&type=recovery`
  });
  if (error) throw error;
}

export async function updatePassword(password) {
  if (useLocalAdminProxy()) {
    await localApi("/password", {
      method: "POST",
      body: JSON.stringify({ password })
    });
    return;
  }

  if (isLocalAdminMode() || useDemo()) {
    return;
  }

  const { error } = await supabase.auth.updateUser({ password });
  if (error) throw error;

  const { data: userData, error: userError } = await supabase.auth.getUser();
  if (userError) throw userError;

  const rpc = await supabase.rpc("mark_password_changed");
  if (!rpc.error) return;

  const { error: profileError } = await supabase
    .from("profiles")
    .update({ must_change_password: false })
    .eq("id", userData.user.id);
  if (profileError) throw rpc.error;
}

export async function signOut() {
  if (isLocalAdminMode() || useDemo()) {
    localStorage.removeItem("requestManagementDemoEmail");
    return;
  }

  const { error } = await supabase.auth.signOut();
  if (error) throw error;
}

export function onAuthStateChange(callback) {
  if (isLocalAdminMode() || useDemo()) {
    return { data: { subscription: { unsubscribe() {} } } };
  }

  return supabase.auth.onAuthStateChange((event, session) => callback(session, event));
}

export async function loadProfile() {
  if (useLocalAdminProxy()) {
    return localApi("/profile");
  }

  if (isLocalAdminMode()) {
    return demoAdminProfile;
  }

  if (useDemo()) {
    const session = demoSession();
    const sessionEmail = normalizeEmail(session?.user?.email);
    const teamMember = demoTeam.find((member) => member.email === sessionEmail);
    if (teamMember) {
      return {
        id: teamMember.id,
        full_name: teamMember.full_name,
        email: teamMember.email,
        role: teamMember.role,
        client_id: null,
        job_title: teamMember.job_title,
        phone: "",
        must_change_password: false,
        clients: null
      };
    }
    return sessionEmail === demoAdminProfile.email
      ? demoAdminProfile
      : { ...demoProfile, email: session?.user?.email || demoProfile.email };
  }

  const { data: userData, error: userError } = await supabase.auth.getUser();
  if (userError) throw userError;
  const authUser = userData.user;

  const { data, error } = await supabase
    .from("profiles")
    .select("id, full_name, email, role, client_id, job_title, phone, must_change_password, clients(id, name, primary_contact_name, primary_contact_email, billing_email, created_at)")
    .eq("id", authUser.id)
    .maybeSingle();

  if (error) {
    if (String(error.message || "").includes("must_change_password")) {
      const fallback = await supabase
        .from("profiles")
        .select("id, full_name, email, role, client_id, job_title, phone, clients(id, name, primary_contact_name, primary_contact_email, billing_email, created_at)")
        .eq("id", authUser.id)
        .maybeSingle();
      if (fallback.error) throw fallback.error;
      if (fallback.data) return { ...fallback.data, must_change_password: false };
    }
    if (isConfiguredAdminEmail(authUser.email)) return configuredAdminProfile(authUser);
    throw error;
  }

  if (!data) {
    if (isConfiguredAdminEmail(authUser.email)) return configuredAdminProfile(authUser);
    throw new Error(`No profile found for ${authUser.email}. Create a row in public.profiles with the correct role and client_id.`);
  }

  if (isConfiguredAdminEmail(data.email || authUser.email) && data.role !== "owner") {
    return { ...data, role: "owner", client_id: null, clients: null, job_title: data.job_title || "Owner" };
  }

  return data;
}

export async function updateOwnProfile({ fullName, jobTitle, phone }) {
  if (useLocalAdminProxy()) {
    return localApi("/profile", {
      method: "PUT",
      body: JSON.stringify({ fullName, jobTitle, phone })
    });
  }

  if (useDemo()) return null;

  const { data: userData, error: userError } = await supabase.auth.getUser();
  if (userError) throw userError;

  const { data, error } = await supabase
    .from("profiles")
    .update({
      full_name: fullName,
      job_title: jobTitle || null,
      phone: phone || null
    })
    .eq("id", userData.user.id)
    .select("id, full_name, email, role, client_id, job_title, phone, must_change_password, clients(id, name, primary_contact_name, primary_contact_email, billing_email, created_at)")
    .single();

  if (error) throw error;
  return data;
}

export async function loadRequests() {
  if (useLocalAdminProxy()) return localApi("/requests");
  if (useDemo()) return demoRequests;

  const { data, error } = await supabase
    .from("requests")
    .select("id, request_number, client_id, title, description, service_type, status, due_date, created_at, updated_at, closed_at")
    .order("updated_at", { ascending: false });

  if (error) throw error;
  return data ?? [];
}

export async function loadRequestAssignments() {
  if (useDemo()) return [];
  try {
    return await localApi("/request-assignments");
  } catch (error) {
    if (useLocalAdminProxy()) throw error;
  }

  const { data, error } = await supabase
    .from("request_assignments")
    .select("request_id, profile_id, user_id, assigned_by, created_at");

  if (error) {
    if (String(error.message || "").includes("profile_id")) {
      const fallback = await supabase
        .from("request_assignments")
        .select("request_id, user_id, assigned_by, created_at");
      if (fallback.error) throw fallback.error;
      return (fallback.data ?? []).map((assignment) => ({
        ...assignment,
        profile_id: assignment.user_id
      }));
    }
    if (String(error.message || "").includes("user_id")) {
      const fallback = await supabase
        .from("request_assignments")
        .select("request_id, profile_id, assigned_by, created_at");
      if (fallback.error) throw fallback.error;
      return (fallback.data ?? []).map((assignment) => ({
        ...assignment,
        profile_id: assignment.profile_id
      }));
    }
    if (String(error.message || "").includes("request_assignments")) return [];
    throw error;
  }
  return (data ?? []).map((assignment) => ({
    ...assignment,
    profile_id: assignment.profile_id || assignment.user_id
  }));
}

export async function loadClients() {
  if (useLocalAdminProxy()) return localApi("/clients");
  if (useDemo()) return demoClients;

  const { data, error } = await supabase
    .from("clients")
    .select("id, name, primary_contact_name, primary_contact_email, billing_email, status, created_at")
    .order("created_at", { ascending: false });

  if (error) throw error;
  return data ?? [];
}

export async function loadTeam() {
  if (useDemo()) return demoTeam;
  try {
    return await localApi("/team");
  } catch (error) {
    if (useLocalAdminProxy()) throw error;
  }

  const { data, error } = await supabase
    .from("profiles")
    .select("id, full_name, email, role, job_title, client_id")
    .neq("role", "client")
    .order("full_name", { ascending: true });

  if (error) throw error;
  return data ?? [];
}

export async function createClient({ name, contactName, email, billingEmail, status }) {
  const normalizedEmail = normalizeEmail(email);
  if (useLocalAdminProxy()) {
    return localApi("/clients", {
      method: "POST",
      body: JSON.stringify({ name, contactName, email: normalizedEmail, billingEmail, status })
    });
  }

  if (useDemo()) {
    const client = {
      id: crypto.randomUUID(),
      name,
      primary_contact_name: contactName,
      primary_contact_email: normalizedEmail,
      billing_email: normalizeEmail(billingEmail || normalizedEmail),
      status: status || "signed",
      created_at: new Date().toISOString()
    };
    demoClients.unshift(client);
    return client;
  }

  const existing = await findClientByEmail(normalizedEmail);
  if (existing) {
    throw new Error(`Client already exists for ${normalizedEmail}. Open the existing client instead of creating another one.`);
  }

  const { data, error } = await supabase
    .from("clients")
    .insert({
      name,
      primary_contact_name: contactName,
      primary_contact_email: normalizedEmail,
      billing_email: normalizeEmail(billingEmail || normalizedEmail),
      status: status || "signed"
    })
    .select()
    .single();

  if (error) throw error;
  return data;
}

export async function updateClient(clientId, { name, contactName, email, billingEmail, status }) {
  const normalizedEmail = normalizeEmail(email);
  if (useLocalAdminProxy()) {
    return localApi(`/clients/${clientId}`, {
      method: "PUT",
      body: JSON.stringify({ name, contactName, email: normalizedEmail, billingEmail, status })
    });
  }

  if (useDemo()) {
    const duplicate = demoClients.find((item) => item.id !== clientId && normalizeEmail(item.primary_contact_email) === normalizedEmail);
    if (duplicate) throw new Error(`Client already exists for ${normalizedEmail}.`);
    const client = demoClients.find((item) => item.id === clientId);
    if (client) {
      client.name = name;
      client.primary_contact_name = contactName;
      client.primary_contact_email = normalizedEmail;
      client.billing_email = normalizeEmail(billingEmail || normalizedEmail);
      client.status = status || client.status || "signed";
    }
    return client;
  }

  const existing = await findClientByEmail(normalizedEmail);
  if (existing && existing.id !== clientId) {
    throw new Error(`Client already exists for ${normalizedEmail}. Use the existing client record.`);
  }

  const { data, error } = await supabase
    .from("clients")
    .update({
      name,
      primary_contact_name: contactName,
      primary_contact_email: normalizedEmail,
      billing_email: normalizeEmail(billingEmail || normalizedEmail),
      status: status || "signed"
    })
    .eq("id", clientId)
    .select()
    .single();

  if (error) throw error;
  return data;
}

async function findClientByEmail(email) {
  const { data, error } = await supabase
    .from("clients")
    .select("id, name, primary_contact_email")
    .ilike("primary_contact_email", normalizeEmail(email))
    .limit(1)
    .maybeSingle();

  if (error) throw error;
  return data;
}

export async function deleteClient(clientId) {
  if (useLocalAdminProxy()) {
    await localApi(`/clients/${clientId}`, { method: "DELETE" });
    return;
  }

  if (useDemo()) {
    const index = demoClients.findIndex((client) => client.id === clientId);
    if (index >= 0) demoClients.splice(index, 1);
    for (let i = demoRequests.length - 1; i >= 0; i -= 1) {
      if (demoRequests[i].client_id === clientId) demoRequests.splice(i, 1);
    }
    return;
  }

  const { error } = await supabase
    .from("clients")
    .delete()
    .eq("id", clientId);

  if (error) throw error;
}

export async function createRequest({ clientId, title, description, serviceType, dueDate, ownerId, status }) {
  if (useLocalAdminProxy()) {
    return localApi("/requests", {
      method: "POST",
      body: JSON.stringify({ clientId, title, description, serviceType, dueDate, ownerId, status })
    });
  }

  if (useDemo()) {
    const request = {
      id: crypto.randomUUID(),
      request_number: nextClientRequestNumber(demoRequests, clientId),
      client_id: clientId,
      title,
      description,
      service_type: serviceType,
      status: status || "new",
      due_date: dueDate || null,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      closed_at: null
    };
    demoRequests.unshift(request);
    return request;
  }

  const requestNumber = await nextSupabaseClientRequestNumber(clientId);
  const { data, error } = await supabase
    .from("requests")
    .insert({
      request_number: requestNumber,
      client_id: clientId,
      title,
      description,
      service_type: serviceType,
      due_date: dueDate || null,
      status: status || "new",
      owner_id: ownerId,
      created_by: ownerId
    })
    .select()
    .single();

  if (error) throw error;
  return data;
}

export async function setRequestAssignments(requestId, profileIds = [], assignedBy) {
  const uniqueProfileIds = Array.from(new Set((profileIds || []).filter(Boolean)));

  if (useDemo()) return;
  try {
    await localApi(`/request-assignments/${requestId}`, {
      method: "PUT",
      body: JSON.stringify({ profileIds: uniqueProfileIds, assignedBy })
    });
    return;
  } catch (error) {
    if (useLocalAdminProxy()) throw error;
  }

  const deleted = await supabase
    .from("request_assignments")
    .delete()
    .eq("request_id", requestId);
  if (deleted.error) throw deleted.error;

  if (!uniqueProfileIds.length) return;

  const rows = uniqueProfileIds.map((profileId) => ({
    request_id: requestId,
    profile_id: profileId,
    user_id: profileId,
    assigned_by: assignedBy
  }));

  const { error } = await supabase
    .from("request_assignments")
    .insert(rows);
  if (!error) return;
  const insertMessage = String(error.message || "");
  if (!insertMessage.includes("profile_id") && !insertMessage.includes("user_id")) {
    throw error;
  }

  const profileOnlyRows = uniqueProfileIds.map((profileId) => ({
    request_id: requestId,
    profile_id: profileId,
    assigned_by: assignedBy
  }));
  const profileOnly = await supabase
    .from("request_assignments")
    .insert(profileOnlyRows);
  if (!profileOnly.error) return;

  if (String(profileOnly.error.message || "").includes("profile_id")) {
    const userOnlyRows = uniqueProfileIds.map((profileId) => ({
      request_id: requestId,
      user_id: profileId,
      assigned_by: assignedBy
    }));
    const userOnly = await supabase
      .from("request_assignments")
      .insert(userOnlyRows);
    if (userOnly.error) throw userOnly.error;
    return;
  }

  throw profileOnly.error;
}

function nextClientRequestNumber(requests, clientId) {
  const maxNumber = (requests || [])
    .filter((request) => request.client_id === clientId)
    .map((request) => String(request.request_number || "").match(/^REQ-(\d+)$/i)?.[1])
    .filter(Boolean)
    .map(Number)
    .reduce((max, number) => Math.max(max, number), 0);
  return `REQ-${maxNumber + 1}`;
}

async function nextSupabaseClientRequestNumber(clientId) {
  const { data, error } = await supabase
    .from("requests")
    .select("request_number")
    .eq("client_id", clientId);

  if (error) throw error;
  return nextClientRequestNumber(data ?? [], clientId);
}

export async function updateRequest(requestId, { clientId, title, description, serviceType, dueDate, status }) {
  if (useLocalAdminProxy()) {
    return localApi(`/requests/${requestId}`, {
      method: "PUT",
      body: JSON.stringify({ clientId, title, description, serviceType, dueDate, status })
    });
  }

  if (useDemo()) {
    const request = demoRequests.find((item) => item.id === requestId);
    if (request) {
      request.client_id = clientId;
      request.title = title;
      request.description = description;
      request.service_type = serviceType;
      request.due_date = dueDate || null;
      request.status = status || request.status || "new";
      request.updated_at = new Date().toISOString();
    }
    return request;
  }

  const { data, error } = await supabase
    .from("requests")
    .update({
      client_id: clientId,
      title,
      description,
      service_type: serviceType,
      due_date: dueDate || null,
      status: status || "new"
    })
    .eq("id", requestId)
    .select()
    .single();

  if (error) throw error;
  return data;
}

export async function deleteRequest(requestId) {
  if (useLocalAdminProxy()) {
    await localApi(`/requests/${requestId}`, { method: "DELETE" });
    return;
  }

  if (useDemo()) {
    const index = demoRequests.findIndex((request) => request.id === requestId);
    if (index >= 0) demoRequests.splice(index, 1);
    demoMessages = demoMessages.filter((message) => message.request_id !== requestId);
    return;
  }

  const { error } = await supabase
    .from("requests")
    .delete()
    .eq("id", requestId);

  if (error) throw error;
}

export async function createTeamMember({ fullName, email, role, jobTitle }) {
  const normalizedEmail = normalizeEmail(email);

  if (!useDemo()) {
    return localApi("/team", {
      method: "POST",
      body: JSON.stringify({ fullName, email: normalizedEmail, role, jobTitle })
    });
  }

  if (useDemo()) {
    if (demoTeam.some((member) => normalizeEmail(member.email) === normalizedEmail)) {
      throw new Error(`User already exists for ${normalizedEmail}. Edit the existing team member instead.`);
    }
    const member = {
      id: crypto.randomUUID(),
      full_name: fullName,
      email: normalizedEmail,
      role,
      job_title: jobTitle || role
    };
    demoTeam.push(member);
    return member;
  }

  const existing = await supabase
    .from("profiles")
    .select("id")
    .eq("email", normalizedEmail)
    .maybeSingle();

  if (existing.error) throw existing.error;

  if (existing.data?.id) {
    throw new Error(`User already exists for ${normalizedEmail}. Edit the existing profile instead of creating another account.`);
  }

  throw new Error(`Invite ${normalizedEmail} in Supabase Auth first, then create or sync their public.profiles row. Frontend cannot create auth users safely.`);
}

export async function updateTeamMember(memberId, { fullName, email, role, jobTitle }) {
  const normalizedEmail = normalizeEmail(email);
  if (!useDemo()) {
    return localApi(`/team/${memberId}`, {
      method: "PUT",
      body: JSON.stringify({ fullName, email: normalizedEmail, role, jobTitle })
    });
  }

  if (useDemo()) {
    const duplicate = demoTeam.find((item) => item.id !== memberId && normalizeEmail(item.email) === normalizedEmail);
    if (duplicate) throw new Error(`User already exists for ${normalizedEmail}.`);
    const member = demoTeam.find((item) => item.id === memberId);
    if (member) {
      member.full_name = fullName;
      member.email = normalizedEmail;
      member.role = role;
      member.job_title = jobTitle || role;
    }
    return member;
  }

  const duplicate = await supabase
    .from("profiles")
    .select("id")
    .eq("email", normalizedEmail)
    .neq("id", memberId)
    .maybeSingle();

  if (duplicate.error) throw duplicate.error;
  if (duplicate.data?.id) throw new Error(`User already exists for ${normalizedEmail}. Use the existing profile.`);

  const { data, error } = await supabase
    .from("profiles")
    .update({
      full_name: fullName,
      email: normalizedEmail,
      role,
      job_title: jobTitle || role
    })
    .eq("id", memberId)
    .select()
    .single();

  if (error) throw error;
  return data;
}

export async function deleteTeamMember(memberId) {
  if (!useDemo()) {
    await localApi(`/team/${memberId}`, { method: "DELETE" });
    return;
  }

  if (useDemo()) {
    const index = demoTeam.findIndex((member) => member.id === memberId);
    if (index >= 0) demoTeam.splice(index, 1);
    return;
  }

  const { error } = await supabase
    .from("profiles")
    .delete()
    .eq("id", memberId);

  if (error) throw error;
}

export async function loadMessages(requestId) {
  if (useLocalAdminProxy()) return localApi(`/messages?requestId=${encodeURIComponent(requestId)}`);
  if (useDemo()) return demoMessages.filter((message) => message.request_id === requestId);

  const { data, error } = await supabase
    .from("request_messages")
    .select("id, request_id, sender_id, message, is_internal, created_at, profiles(full_name, role)")
    .eq("request_id", requestId)
    .order("created_at", { ascending: true });

  if (error) throw error;

  const attachments = await loadRequestAttachments(requestId);
  return mergeMessagesAndAttachments(data ?? [], attachments);
}

async function loadRequestAttachments(requestId) {
  const fieldsWithCreatedAt = "id, request_id, client_id, uploaded_by, category, bucket_name, storage_path, file_name, mime_type, file_size, created_at";
  const fieldsWithoutCreatedAt = "id, request_id, client_id, uploaded_by, category, bucket_name, storage_path, file_name, mime_type, file_size";

  let query = supabase
    .from("files")
    .select(fieldsWithCreatedAt)
    .eq("request_id", requestId)
    .eq("category", "attachment")
    .order("created_at", { ascending: true });

  let { data, error } = await query;

  if (error && String(error.message || "").includes("created_at")) {
    const fallback = await supabase
      .from("files")
      .select(fieldsWithoutCreatedAt)
      .eq("request_id", requestId)
      .eq("category", "attachment");
    data = fallback.data;
    error = fallback.error;
  }

  if (error) throw error;
  const files = data ?? [];
  if (!files.length) return [];

  const uploaderIds = [...new Set(files.map((file) => file.uploaded_by).filter(Boolean))];
  let profileMap = {};
  if (uploaderIds.length) {
    const profiles = await supabase
      .from("profiles")
      .select("id, full_name, role")
      .in("id", uploaderIds);
    if (!profiles.error) {
      profileMap = Object.fromEntries((profiles.data ?? []).map((profile) => [profile.id, profile]));
    }
  }

  return files.map((file) => ({
    ...file,
    created_at: file.created_at || null,
    profiles: profileMap[file.uploaded_by] || null
  }));
}

function mergeMessagesAndAttachments(messages, attachments) {
  const attachmentNames = new Set(attachments.map((file) => String(file.file_name || "").trim().toLowerCase()));
  const visibleMessages = messages.filter((message) => {
    const match = String(message.message || "").match(/^Attachment uploaded:\s*(.+)$/i);
    return !match || !attachmentNames.has(match[1].trim().toLowerCase());
  });

  const attachmentMessages = attachments.map((file) => ({
    id: `attachment-${file.id}`,
    request_id: file.request_id,
    sender_id: file.uploaded_by,
    message: "Attachment",
    is_internal: false,
    created_at: file.created_at || new Date().toISOString(),
    profiles: file.profiles || { full_name: "Team member", role: "developer" },
    attachment: file
  }));

  return [...visibleMessages, ...attachmentMessages].sort((left, right) => (
    new Date(left.created_at || 0).getTime() - new Date(right.created_at || 0).getTime()
  ));
}

export async function createMessage(requestId, senderId, message) {
  if (useLocalAdminProxy()) {
    await localApi("/messages", {
      method: "POST",
      body: JSON.stringify({ requestId, senderId, message })
    });
    return;
  }

  if (useDemo()) {
    const senderProfile = demoTeam.find((member) => member.id === senderId) || (senderId === demoAdminProfile.id ? demoAdminProfile : demoProfile);
    demoMessages.push({
      id: crypto.randomUUID(),
      request_id: requestId,
      sender_id: senderId,
      message,
      is_internal: false,
      created_at: new Date().toISOString(),
      profiles: { full_name: senderProfile.full_name, role: senderProfile.role }
    });
    return;
  }

  const { error } = await supabase.from("request_messages").insert({
    request_id: requestId,
    sender_id: senderId,
    message,
    is_internal: false
  });

  if (error) throw error;
}

export async function uploadRequestAttachment({ request, profile, file }) {
  if (useLocalAdminProxy()) {
    await localApi("/attachments", {
      method: "POST",
      body: JSON.stringify({
        requestId: request.id,
        clientId: request.client_id,
        senderId: profile.id,
        fileName: file.name,
        mimeType: file.type || "application/octet-stream",
        fileSize: file.size,
        base64: await fileToBase64(file)
      })
    });
    return;
  }

  if (useDemo()) {
    demoMessages.push({
      id: crypto.randomUUID(),
      request_id: request.id,
      sender_id: profile.id,
      message: `Attachment uploaded: ${file.name}`,
      is_internal: false,
      created_at: new Date().toISOString(),
      profiles: { full_name: profile.full_name, role: profile.role }
    });
    return;
  }

  const safeFileName = file.name.replace(/[^a-zA-Z0-9._-]/g, "-");
  const storagePath = `${request.client_id}/${request.id}/${Date.now()}-${safeFileName}`;

  const upload = await supabase.storage
    .from("request-attachments")
    .upload(storagePath, file, {
      cacheControl: "3600",
      upsert: false
    });

  if (upload.error) throw upload.error;

  const { error } = await supabase.from("files").insert({
    request_id: request.id,
    client_id: request.client_id,
    uploaded_by: profile.id,
    category: "attachment",
    bucket_name: "request-attachments",
    storage_path: storagePath,
    file_name: file.name,
    mime_type: file.type || null,
    file_size: file.size
  });

  if (error) throw error;
}

export async function loadDeliverables(requestId) {
  if (useLocalAdminProxy()) return localApi(`/deliverables?requestId=${encodeURIComponent(requestId)}`);
  if (useDemo()) return demoDeliverables.filter((deliverable) => deliverable.request_id === requestId);

  const { data, error } = await supabase
    .from("deliverables")
    .select("id, request_id, title, version, status, sent_at, created_at, files(id, bucket_name, storage_path, file_name)")
    .eq("request_id", requestId)
    .order("created_at", { ascending: false });

  if (error) throw error;
  return data ?? [];
}

export async function loadClosedRequests() {
  if (useLocalAdminProxy()) return localApi("/requests?closed=1");
  if (useDemo()) return demoHistory;

  const { data, error } = await supabase
    .from("requests")
    .select("id, request_number, client_id, title, description, service_type, status, closed_at, created_at")
    .in("status", ["delivered", "closed"])
    .order("closed_at", { ascending: false, nullsFirst: false });

  if (error) throw error;
  return data ?? [];
}

export async function createSignedDownload(file) {
  if (useLocalAdminProxy()) {
    const data = await localApi("/signed-download", {
      method: "POST",
      body: JSON.stringify({
        bucketName: file.bucket_name,
        storagePath: file.storage_path
      })
    });
    return data.signedUrl;
  }

  if (useDemo()) {
    const blob = new Blob([`Demo download for ${file.file_name}`], { type: "text/plain" });
    return URL.createObjectURL(blob);
  }

  const { data, error } = await supabase.storage
    .from(file.bucket_name)
    .createSignedUrl(file.storage_path, 60);

  if (error) throw error;
  return data.signedUrl;
}
