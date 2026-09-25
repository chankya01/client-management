import { createReadStream, existsSync, readFileSync } from "node:fs";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import http from "node:http";

const root = fileURLToPath(new URL(".", import.meta.url));
const env = loadEnv();
const port = Number(env.PORT || 8000);
const supabaseUrl = env.SUPABASE_URL || env.VITE_SUPABASE_URL;
const serviceRoleKey = env.SUPABASE_SERVICE_ROLE_KEY;
const supabaseAnonKey = env.SUPABASE_ANON_KEY || env.VITE_SUPABASE_ANON_KEY || serviceRoleKey;
const adminEmail = normalizeEmail(env.ADMIN_EMAIL || "sanithakur544@gmail.com");
const clientEmail = normalizeEmail(env.CLIENT_EMAIL || "client@example.com");
const clientName = env.CLIENT_NAME || "Test Client";
const clientContactName = env.CLIENT_CONTACT_NAME || "Test Client User";
const defaultTempPassword = env.DEFAULT_TEMP_PASSWORD || "RequestManagement@123";

if (!supabaseUrl || !serviceRoleKey) {
  console.warn("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY. /api calls will fail until .env is configured.");
}

const mimeTypes = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg"
};

function loadEnv() {
  const result = {};
  const envPath = join(root, ".env");
  if (!existsSync(envPath)) return { ...process.env };

  const lines = readFileSync(envPath, "utf8").split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const separator = trimmed.indexOf("=");
    if (separator === -1) continue;
    const key = trimmed.slice(0, separator).trim();
    let value = trimmed.slice(separator + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    result[key] = value;
  }
  return { ...result, ...process.env };
}

function normalizeEmail(email) {
  return String(email || "").trim().toLowerCase();
}

function json(res, status, payload) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store"
  });
  res.end(JSON.stringify(payload));
}

async function readJson(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  if (!chunks.length) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function requireSupabase() {
  if (!supabaseUrl || !serviceRoleKey) {
    throw new Error("Local Supabase admin proxy is not configured. Add SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY to .env, then restart npm run local.");
  }
}

async function supabaseFetch(path, options = {}) {
  requireSupabase();
  const requestOptions = { ...options };
  const response = await fetch(`${supabaseUrl}${path}`, {
    ...requestOptions,
    headers: {
      apikey: serviceRoleKey,
      Authorization: `Bearer ${serviceRoleKey}`,
      "Content-Type": "application/json",
      ...(requestOptions.headers || {})
    }
  });

  const contentType = response.headers.get("content-type") || "";
  const payload = contentType.includes("application/json")
    ? await response.json()
    : await response.text();

  if (!response.ok) {
    const message = typeof payload === "string" ? payload : payload?.message || payload?.msg || payload?.error_description || payload?.error;
    if (isMissingPasswordFlagError(message)) {
      return supabaseFetchWithoutPasswordFlag(path, requestOptions);
    }
    throw new Error(message || `Supabase request failed: ${response.status}`);
  }

  return payload;
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

async function supabaseFetchWithoutPasswordFlag(path, options = {}) {
  const fallbackPath = removePasswordFlagFromPath(path);
  const fallbackOptions = {
    ...options,
    body: removePasswordFlagFromBody(options.body)
  };
  const response = await fetch(`${supabaseUrl}${fallbackPath}`, {
    ...fallbackOptions,
    headers: {
      apikey: serviceRoleKey,
      Authorization: `Bearer ${serviceRoleKey}`,
      "Content-Type": "application/json",
      ...(fallbackOptions.headers || {})
    }
  });

  const contentType = response.headers.get("content-type") || "";
  const payload = contentType.includes("application/json")
    ? await response.json()
    : await response.text();

  if (!response.ok) {
    const message = typeof payload === "string" ? payload : payload?.message || payload?.msg || payload?.error_description || payload?.error;
    throw new Error(message || `Supabase request failed: ${response.status}`);
  }

  return payload;
}

function rest(table, query = "") {
  return `/rest/v1/${table}${query}`;
}

function encode(value) {
  return encodeURIComponent(value);
}

async function selectOne(table, query) {
  const rows = await supabaseFetch(rest(table, query), {
    headers: { Accept: "application/json" }
  });
  return Array.isArray(rows) ? rows[0] || null : rows;
}

async function loadRequestAttachments(requestId) {
  const baseQuery = `&request_id=eq.${encode(requestId)}&category=eq.attachment`;
  let files;

  try {
    files = await supabaseFetch(rest("files", `?select=id,request_id,client_id,uploaded_by,category,bucket_name,storage_path,file_name,mime_type,file_size,created_at${baseQuery}&order=created_at.asc`));
  } catch (error) {
    if (!String(error.message || "").includes("created_at")) throw error;
    files = await supabaseFetch(rest("files", `?select=id,request_id,client_id,uploaded_by,category,bucket_name,storage_path,file_name,mime_type,file_size${baseQuery}`));
  }

  if (!Array.isArray(files) || !files.length) return [];

  const uploaderIds = [...new Set(files.map((file) => file.uploaded_by).filter(Boolean))];
  let profileMap = {};
  if (uploaderIds.length) {
    const profiles = await supabaseFetch(rest("profiles", `?select=id,full_name,role&id=in.(${uploaderIds.map(encode).join(",")})`));
    profileMap = Object.fromEntries((profiles || []).map((profile) => [profile.id, profile]));
  }

  return files.map((file) => ({
    ...file,
    created_at: file.created_at || null,
    profiles: profileMap[file.uploaded_by] || null
  }));
}

function mergeMessagesAndAttachments(messages, attachments) {
  const attachmentNames = new Set(attachments.map((file) => String(file.file_name || "").trim().toLowerCase()));
  const visibleMessages = (messages || []).filter((message) => {
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

async function nextRequestNumberForClient(clientId) {
  const rows = await supabaseFetch(rest("requests", `?select=request_number&client_id=eq.${encode(clientId)}`));
  const maxNumber = (rows || [])
    .map((request) => String(request.request_number || "").match(/^REQ-(\d+)$/i)?.[1])
    .filter(Boolean)
    .map(Number)
    .reduce((max, number) => Math.max(max, number), 0);
  return `REQ-${maxNumber + 1}`;
}

async function createAuthUser(email, fullName, password = defaultTempPassword) {
  const users = await supabaseFetch("/auth/v1/admin/users?page=1&per_page=1000");
  const existing = users?.users?.find((user) => normalizeEmail(user.email) === normalizeEmail(email));
  if (existing) {
    if (password) {
      await supabaseFetch(`/auth/v1/admin/users/${existing.id}`, {
        method: "PUT",
        body: JSON.stringify({
          password,
          email_confirm: true,
          user_metadata: { ...(existing.user_metadata || {}), full_name: fullName || existing.user_metadata?.full_name || email }
        })
      });
    }
    return existing;
  }

  return supabaseFetch("/auth/v1/admin/users", {
    method: "POST",
    body: JSON.stringify({
      email: normalizeEmail(email),
      password,
      email_confirm: true,
      user_metadata: { full_name: fullName || email }
    })
  });
}

async function ensureAdminProfile() {
  const select = "?select=id,full_name,email,role,client_id,job_title,phone,must_change_password,clients(id,name,primary_contact_name,primary_contact_email,billing_email,created_at)"
    + `&email=eq.${encode(adminEmail)}&limit=1`;
  const existing = await selectOne("profiles", select);
  if (existing) {
    if (existing.role !== "owner") {
      const updated = await supabaseFetch(rest("profiles", `?id=eq.${encode(existing.id)}&select=id,full_name,email,role,client_id,job_title,phone`), {
        method: "PATCH",
        headers: { Prefer: "return=representation" },
        body: JSON.stringify({ role: "owner", client_id: null, job_title: existing.job_title || "Owner", is_active: true, must_change_password: false })
      });
      return { ...updated[0], clients: null };
    }
    return existing;
  }

  const authUser = await createAuthUser(adminEmail, "Sani Thakur");
  const inserted = await supabaseFetch(rest("profiles", "?select=id,full_name,email,role,client_id,job_title,phone,must_change_password"), {
    method: "POST",
    headers: {
      Prefer: "return=representation,resolution=merge-duplicates"
    },
    body: JSON.stringify({
      id: authUser.id,
      full_name: authUser.user_metadata?.full_name || "Sani Thakur",
      email: adminEmail,
      role: "owner",
      client_id: null,
      job_title: "Owner",
      is_active: true,
      must_change_password: false
    })
  });
  return { ...inserted[0], clients: null };
}

async function ensureClientProfile() {
  let client = await selectOne("clients", `?select=id,name,primary_contact_name,primary_contact_email,billing_email,status,created_at&primary_contact_email=eq.${encode(clientEmail)}&limit=1`);

  if (!client) {
    const insertedClient = await supabaseFetch(rest("clients", "?select=id,name,primary_contact_name,primary_contact_email,billing_email,status,created_at"), {
      method: "POST",
      headers: { Prefer: "return=representation" },
      body: JSON.stringify({
        name: clientName,
        primary_contact_name: clientContactName,
        primary_contact_email: clientEmail,
        billing_email: clientEmail,
        status: "ongoing"
      })
    });
    client = insertedClient[0];
  }

  let profile = await selectOne(
    "profiles",
    "?select=id,full_name,email,role,client_id,job_title,phone,must_change_password,clients(id,name,primary_contact_name,primary_contact_email,billing_email,created_at)"
      + `&email=eq.${encode(clientEmail)}&limit=1`
  );

  if (!profile) {
    const authUser = await createAuthUser(clientEmail, clientContactName);
    const insertedProfile = await supabaseFetch(rest("profiles", "?select=id,full_name,email,role,client_id,job_title,phone,must_change_password"), {
      method: "POST",
      headers: { Prefer: "return=representation" },
      body: JSON.stringify({
        id: authUser.id,
        full_name: clientContactName,
        email: clientEmail,
        role: "client",
        client_id: client.id,
        job_title: "Client contact",
        is_active: true,
        must_change_password: false
      })
    });
    profile = insertedProfile[0];
  } else if (profile.role !== "client" || profile.client_id !== client.id) {
    const updatedProfile = await supabaseFetch(rest("profiles", `?id=eq.${encode(profile.id)}&select=id,full_name,email,role,client_id,job_title,phone,must_change_password`), {
      method: "PATCH",
      headers: { Prefer: "return=representation" },
      body: JSON.stringify({
        role: "client",
        client_id: client.id,
        is_active: true,
        must_change_password: false
      })
    });
    profile = updatedProfile[0];
  }

  return {
    ...profile,
    clients: {
      id: client.id,
      name: client.name,
      primary_contact_name: client.primary_contact_name,
      primary_contact_email: client.primary_contact_email,
      billing_email: client.billing_email,
      created_at: client.created_at
    }
  };
}

async function currentProfile(url) {
  return url.searchParams.get("view") === "client"
    ? ensureClientProfile()
    : ensureAdminProfile();
}

async function handleApi(req, res, url) {
  const method = req.method || "GET";
  const path = url.pathname.replace(/^\/api/, "") || "/";

  if (path === "/auth/password" && method === "POST") {
    requireSupabase();
    const body = await readJson(req);
    const response = await fetch(`${supabaseUrl}/auth/v1/token?grant_type=password`, {
      method: "POST",
      headers: {
        apikey: supabaseAnonKey,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        email: normalizeEmail(body.email),
        password: body.password
      })
    });
    const payload = await response.json();
    if (!response.ok) {
      return json(res, response.status, { error: payload.error_description || payload.msg || payload.message || "Invalid email or password." });
    }
    return json(res, 200, { user: payload.user });
  }

  if (path === "/profile" && method === "GET") {
    return json(res, 200, await currentProfile(url));
  }

  if (path === "/clients" && method === "GET") {
    const rows = await supabaseFetch(rest("clients", "?select=id,name,primary_contact_name,primary_contact_email,billing_email,status,created_at&order=created_at.desc"));
    return json(res, 200, rows);
  }

  if (path === "/clients" && method === "POST") {
    const body = await readJson(req);
    const email = normalizeEmail(body.email);
    const duplicateClient = await selectOne("clients", `?select=id,name,primary_contact_email&primary_contact_email=ilike.${encode(email)}&limit=1`);
    if (duplicateClient) {
      return json(res, 409, {
        error: `Client already exists for ${email}. Open the existing client instead of creating another one.`
      });
    }
    const rows = await supabaseFetch(rest("clients", "?select=*"), {
      method: "POST",
      headers: { Prefer: "return=representation" },
      body: JSON.stringify({
        name: body.name,
        primary_contact_name: body.contactName,
        primary_contact_email: email,
        billing_email: normalizeEmail(body.billingEmail || body.email),
        status: body.status || "signed"
      })
    });
    const client = rows[0];
    const authUser = await createAuthUser(email, body.contactName);
    const existingProfile = await selectOne("profiles", `?select=id&email=eq.${encode(email)}&limit=1`);
    if (existingProfile) {
      await supabaseFetch(rest("profiles", `?id=eq.${encode(existingProfile.id)}`), {
        method: "PATCH",
        body: JSON.stringify({
          full_name: body.contactName,
          email,
          role: "client",
          client_id: client.id,
          job_title: "Client contact",
          is_active: true,
          must_change_password: true
        })
      });
    } else {
      await supabaseFetch(rest("profiles"), {
        method: "POST",
        body: JSON.stringify({
          id: authUser.id,
          full_name: body.contactName,
          email,
          role: "client",
          client_id: client.id,
          job_title: "Client contact",
          is_active: true,
          must_change_password: true
        })
      });
    }
    return json(res, 200, rows[0]);
  }

  const clientMatch = path.match(/^\/clients\/([^/]+)$/);
  if (clientMatch && method === "PUT") {
    const body = await readJson(req);
    const email = normalizeEmail(body.email);
    const duplicateClient = await selectOne("clients", `?select=id,name,primary_contact_email&primary_contact_email=ilike.${encode(email)}&id=neq.${encode(clientMatch[1])}&limit=1`);
    if (duplicateClient) {
      return json(res, 409, {
        error: `Client already exists for ${email}. Use the existing client record.`
      });
    }
    const rows = await supabaseFetch(rest("clients", `?id=eq.${encode(clientMatch[1])}&select=*`), {
      method: "PATCH",
      headers: { Prefer: "return=representation" },
      body: JSON.stringify({
        name: body.name,
        primary_contact_name: body.contactName,
        primary_contact_email: email,
        billing_email: normalizeEmail(body.billingEmail || body.email),
        status: body.status || "signed"
      })
    });
    const existingProfile = await selectOne("profiles", `?select=id&email=eq.${encode(email)}&limit=1`);
    if (existingProfile) {
      await supabaseFetch(rest("profiles", `?id=eq.${encode(existingProfile.id)}`), {
        method: "PATCH",
        body: JSON.stringify({
          full_name: body.contactName,
          email,
          role: "client",
          client_id: clientMatch[1],
          job_title: "Client contact",
          is_active: true
        })
      });
    } else {
      const authUser = await createAuthUser(email, body.contactName);
      await supabaseFetch(rest("profiles"), {
        method: "POST",
        body: JSON.stringify({
          id: authUser.id,
          full_name: body.contactName,
          email,
          role: "client",
          client_id: clientMatch[1],
          job_title: "Client contact",
          is_active: true,
          must_change_password: true
        })
      });
    }
    return json(res, 200, rows[0]);
  }

  if (clientMatch && method === "DELETE") {
    await supabaseFetch(rest("requests", `?client_id=eq.${encode(clientMatch[1])}`), { method: "DELETE" });
    await supabaseFetch(rest("clients", `?id=eq.${encode(clientMatch[1])}`), { method: "DELETE" });
    return json(res, 200, { ok: true });
  }

  if (path === "/requests" && method === "GET") {
    const closed = url.searchParams.get("closed") === "1";
    const profile = await currentProfile(url);
    const clientFilter = profile.role === "client" ? `&client_id=eq.${encode(profile.client_id)}` : "";
    const query = closed
      ? `?select=id,request_number,client_id,title,description,service_type,status,closed_at,created_at&status=in.(delivered,closed)${clientFilter}&order=closed_at.desc.nullslast`
      : `?select=id,request_number,client_id,title,description,service_type,status,due_date,created_at,updated_at,closed_at${clientFilter}&order=updated_at.desc`;
    return json(res, 200, await supabaseFetch(rest("requests", query)));
  }

  if (path === "/requests" && method === "POST") {
    const body = await readJson(req);
    const admin = await ensureAdminProfile();
    const requestNumber = await nextRequestNumberForClient(body.clientId);
    const rows = await supabaseFetch(rest("requests", "?select=*"), {
      method: "POST",
      headers: { Prefer: "return=representation" },
      body: JSON.stringify({
        request_number: requestNumber,
        client_id: body.clientId,
        title: body.title,
        description: body.description,
        service_type: body.serviceType,
        due_date: body.dueDate || null,
        status: body.status || "new",
        owner_id: body.ownerId || admin.id,
        created_by: body.ownerId || admin.id
      })
    });
    return json(res, 200, rows[0]);
  }

  const requestMatch = path.match(/^\/requests\/([^/]+)$/);
  if (requestMatch && method === "PUT") {
    const body = await readJson(req);
    const rows = await supabaseFetch(rest("requests", `?id=eq.${encode(requestMatch[1])}&select=*`), {
      method: "PATCH",
      headers: { Prefer: "return=representation" },
      body: JSON.stringify({
        client_id: body.clientId,
        title: body.title,
        description: body.description,
        service_type: body.serviceType,
        due_date: body.dueDate || null,
        status: body.status || "new"
      })
    });
    return json(res, 200, rows[0]);
  }

  if (requestMatch && method === "DELETE") {
    await supabaseFetch(rest("request_messages", `?request_id=eq.${encode(requestMatch[1])}`), { method: "DELETE" });
    await supabaseFetch(rest("requests", `?id=eq.${encode(requestMatch[1])}`), { method: "DELETE" });
    return json(res, 200, { ok: true });
  }

  if (path === "/team" && method === "GET") {
    const rows = await supabaseFetch(rest("profiles", "?select=id,full_name,email,role,job_title,client_id&role=neq.client&order=full_name.asc"));
    return json(res, 200, rows);
  }

  if (path === "/team" && method === "POST") {
    const body = await readJson(req);
    const email = normalizeEmail(body.email);
    let profile = await selectOne("profiles", `?select=id&email=eq.${encode(email)}&limit=1`);
    if (profile) {
      return json(res, 409, {
        error: `User already exists for ${email}. Edit the existing team member instead.`
      });
    }

    const authUser = await createAuthUser(email, body.fullName);
    const inserted = await supabaseFetch(rest("profiles", "?select=id"), {
      method: "POST",
      headers: { Prefer: "return=representation" },
      body: JSON.stringify({
        id: authUser.id,
        full_name: body.fullName,
        email,
        role: body.role,
        job_title: body.jobTitle || body.role,
        client_id: null,
        is_active: true,
        must_change_password: true
      })
    });
    profile = inserted[0];

    const rows = await supabaseFetch(rest("profiles", `?id=eq.${encode(profile.id)}&select=id,full_name,email,role,job_title,client_id`), {
      method: "PATCH",
      headers: { Prefer: "return=representation" },
      body: JSON.stringify({
        full_name: body.fullName,
        email,
        role: body.role,
        job_title: body.jobTitle || body.role,
        client_id: null,
        is_active: true,
        must_change_password: true
      })
    });
    return json(res, 200, rows[0]);
  }

  const teamMatch = path.match(/^\/team\/([^/]+)$/);
  if (teamMatch && method === "PUT") {
    const body = await readJson(req);
    const email = normalizeEmail(body.email);
    const duplicateProfile = await selectOne("profiles", `?select=id&email=eq.${encode(email)}&id=neq.${encode(teamMatch[1])}&limit=1`);
    if (duplicateProfile) {
      return json(res, 409, {
        error: `User already exists for ${email}. Use the existing profile.`
      });
    }
    const rows = await supabaseFetch(rest("profiles", `?id=eq.${encode(teamMatch[1])}&select=id,full_name,email,role,job_title,client_id`), {
      method: "PATCH",
      headers: { Prefer: "return=representation" },
      body: JSON.stringify({
        full_name: body.fullName,
        email,
        role: body.role,
        job_title: body.jobTitle || body.role
      })
    });
    return json(res, 200, rows[0]);
  }

  if (teamMatch && method === "DELETE") {
    await supabaseFetch(rest("profiles", `?id=eq.${encode(teamMatch[1])}`), { method: "DELETE" });
    return json(res, 200, { ok: true });
  }

  if (path === "/password" && method === "POST") {
    const body = await readJson(req);
    const profile = await currentProfile(url);
    if (!body.password || String(body.password).length < 8) {
      return json(res, 400, { error: "Password must be at least 8 characters." });
    }

    await supabaseFetch(`/auth/v1/admin/users/${profile.id}`, {
      method: "PUT",
      body: JSON.stringify({ password: body.password })
    });

    await supabaseFetch(rest("profiles", `?id=eq.${encode(profile.id)}`), {
      method: "PATCH",
      body: JSON.stringify({ must_change_password: false })
    });

    return json(res, 200, { ok: true });
  }

  if (path === "/messages" && method === "GET") {
    const requestId = url.searchParams.get("requestId");
    const profile = await currentProfile(url);
    if (profile.role === "client") {
      const request = await selectOne("requests", `?select=id,client_id&id=eq.${encode(requestId)}&limit=1`);
      if (!request || request.client_id !== profile.client_id) return json(res, 403, { error: "This request is not linked to the client test profile." });
    }
    const query = "?select=id,request_id,sender_id,message,is_internal,created_at,profiles(full_name,role)"
      + `&request_id=eq.${encode(requestId)}&order=created_at.asc`;
    const messages = await supabaseFetch(rest("request_messages", query));
    const attachments = await loadRequestAttachments(requestId);
    return json(res, 200, mergeMessagesAndAttachments(messages, attachments));
  }

  if (path === "/messages" && method === "POST") {
    const body = await readJson(req);
    const profile = await currentProfile(url);
    if (profile.role === "client") {
      const request = await selectOne("requests", `?select=id,client_id&id=eq.${encode(body.requestId)}&limit=1`);
      if (!request || request.client_id !== profile.client_id) return json(res, 403, { error: "This request is not linked to the client test profile." });
    }
    await supabaseFetch(rest("request_messages"), {
      method: "POST",
      body: JSON.stringify({
        request_id: body.requestId,
        sender_id: body.senderId || profile.id,
        message: body.message,
        is_internal: false
      })
    });
    return json(res, 200, { ok: true });
  }

  if (path === "/attachments" && method === "POST") {
    const body = await readJson(req);
    const profile = await currentProfile(url);
    const request = await selectOne("requests", `?select=id,client_id&id=eq.${encode(body.requestId)}&limit=1`);
    if (!request) return json(res, 404, { error: "Request not found." });
    if (profile.role === "client" && request.client_id !== profile.client_id) {
      return json(res, 403, { error: "This request is not linked to the client test profile." });
    }

    const safeFileName = String(body.fileName || "attachment").replace(/[^a-zA-Z0-9._-]/g, "-");
    const storagePath = `${request.client_id}/${request.id}/${Date.now()}-${safeFileName}`;
    const fileBuffer = Buffer.from(body.base64 || "", "base64");

    await supabaseFetch(`/storage/v1/object/request-attachments/${storagePath}`, {
      method: "POST",
      headers: {
        "Content-Type": body.mimeType || "application/octet-stream",
        "x-upsert": "false"
      },
      body: fileBuffer
    });

    await supabaseFetch(rest("files"), {
      method: "POST",
      body: JSON.stringify({
        request_id: request.id,
        client_id: request.client_id,
        uploaded_by: body.senderId || profile.id,
        category: "attachment",
        bucket_name: "request-attachments",
        storage_path: storagePath,
        file_name: body.fileName,
        mime_type: body.mimeType || null,
        file_size: body.fileSize || null
      })
    });

    await supabaseFetch(rest("request_messages"), {
      method: "POST",
      body: JSON.stringify({
        request_id: request.id,
        sender_id: body.senderId || profile.id,
        message: `Attachment uploaded: ${body.fileName}`,
        is_internal: false
      })
    });

    return json(res, 200, { ok: true });
  }

  if (path === "/deliverables" && method === "GET") {
    const requestId = url.searchParams.get("requestId");
    const profile = await currentProfile(url);
    if (profile.role === "client") {
      const request = await selectOne("requests", `?select=id,client_id&id=eq.${encode(requestId)}&limit=1`);
      if (!request || request.client_id !== profile.client_id) return json(res, 403, { error: "This request is not linked to the client test profile." });
    }
    const query = "?select=id,request_id,title,version,status,sent_at,created_at,files(id,bucket_name,storage_path,file_name)"
      + `&request_id=eq.${encode(requestId)}&order=created_at.desc`;
    return json(res, 200, await supabaseFetch(rest("deliverables", query)));
  }

  if (path === "/signed-download" && method === "POST") {
    const body = await readJson(req);
    const signed = await supabaseFetch(`/storage/v1/object/sign/${encode(body.bucketName)}/${body.storagePath}`, {
      method: "POST",
      body: JSON.stringify({ expiresIn: 60 })
    });
    return json(res, 200, { signedUrl: `${supabaseUrl}/storage/v1${signed.signedURL}` });
  }

  return json(res, 404, { error: `No API route for ${method} ${path}` });
}

function serveStatic(req, res, url) {
  const requestedPath = decodeURIComponent(url.pathname === "/" ? "/index.html" : url.pathname);
  const safePath = normalize(requestedPath).replace(/^(\.\.[/\\])+/, "");
  const filePath = join(root, safePath);

  if (!filePath.startsWith(root) || !existsSync(filePath)) {
    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("Not found");
    return;
  }

  res.writeHead(200, {
    "Content-Type": mimeTypes[extname(filePath)] || "application/octet-stream",
    "Cache-Control": "no-store"
  });
  createReadStream(filePath).pipe(res);
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url || "/", `http://${req.headers.host || "127.0.0.1"}`);
    if (url.pathname.startsWith("/api")) {
      await handleApi(req, res, url);
      return;
    }
    serveStatic(req, res, url);
  } catch (error) {
    json(res, 500, { error: error.message });
  }
});

server.listen(port, "127.0.0.1", () => {
  console.log(`RequestManagement local admin server running at http://127.0.0.1:${port}/`);
});
