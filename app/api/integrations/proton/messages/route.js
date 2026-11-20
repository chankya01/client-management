import {
  apiJson,
  encodeValue,
  createAuthUser,
  handleApiError,
  inFilter,
  normalizeEmail,
  supabaseAdminFetch,
  tablePath
} from "../../../_supabaseAdmin.js";

function configuredSecret() {
  return String(process.env.PROTON_INBOUND_WEBHOOK_SECRET || "").trim();
}

function authorized(request) {
  const expected = configuredSecret();
  if (!expected) return false;
  const provided = request.headers.get("x-proton-webhook-secret")
    || request.headers.get("authorization")?.replace(/^Bearer\s+/i, "").trim();
  return provided === expected;
}

function emailAddress(value) {
  if (value && typeof value === "object") {
    return normalizeEmail(value.address || value.email || value.value || "");
  }
  const text = String(value || "").trim();
  const bracketed = text.match(/<([^>]+)>/);
  return normalizeEmail(bracketed?.[1] || text.replace(/^.*?\s+/, ""));
}

function addressRecord(value) {
  if (value && typeof value === "object") {
    const email = emailAddress(value);
    return { email, name: String(value.name || value.displayName || "").trim() };
  }
  const text = String(value || "").trim();
  const bracketed = text.match(/^(.*?)\s*<([^>]+)>$/);
  return {
    email: normalizeEmail(bracketed?.[2] || text),
    name: String(bracketed?.[1] || "").replace(/^"|"$/g, "").trim()
  };
}

function addressRecords(value) {
  if (Array.isArray(value)) return value.flatMap(addressRecords);
  if (value && typeof value === "object") return [addressRecord(value)];
  return String(value || "")
    .split(/[;,]/)
    .map((item) => addressRecord(item))
    .filter((item) => item.email);
}

function headerValue(payload, names) {
  const headers = payload?.headers && typeof payload.headers === "object" ? payload.headers : {};
  const normalized = Object.fromEntries(Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value]));
  return names.map((name) => normalized[name]).find((value) => value) || "";
}

function stripQuotedReply(value) {
  const lines = String(value || "")
    .replace(/\r\n?/g, "\n")
    .split("\n");

  // Mail clients append the previous messages after a marker such as
  // “On ... wrote:” or “-----Original Message-----”. Keep only the new
  // content so an inbound reply is stored as one new portal message.
  const quoteStart = lines.findIndex((line, index) => {
    const normalized = line.replace(/\u00a0/g, " ").trim();
    if (!normalized) return false;
    if (/^\s*-{2,}\s*Original Message\s*-{2,}\s*$/i.test(normalized)) return true;
    if (index > 0 && /^\s*>/.test(line)) return true;

    // Gmail sometimes wraps the attribution header across two lines, e.g.
    // `On ... <support@example.com` followed by `> wrote:`.
    if (/^On\b/i.test(normalized)) {
      const header = lines
        .slice(index, index + 4)
        .map((part) => part.replace(/\u00a0/g, " ").trim())
        .join(" ");
      if (/\bwrote:\s*$/i.test(header)) return true;
    }
    return false;
  });
  const ownLines = quoteStart >= 0 ? lines.slice(0, quoteStart) : lines;
  return ownLines.join("\n").replace(/[ \t]+\n/g, "\n").trim();
}

function cleanBody(payload) {
  const plain = payload.text || payload.textPlain || payload.text_plain || payload.body || "";
  if (String(plain).trim()) return stripQuotedReply(plain);
  const html = String(payload.html || payload.textHtml || payload.text_html || "")
    // Gmail and many other clients wrap quoted history in these elements.
    .replace(/<blockquote[\s\S]*?<\/blockquote>/gi, "")
    .replace(/<div[^>]*class=["'][^"']*gmail_quote[^"']*["'][^>]*>[\s\S]*?<\/div>/gi, "");
  return stripQuotedReply(html
    .replace(/<br\s*\/?>(?=\s*)/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/\s+\n/g, "\n")
    .replace(/\n\s+/g, "\n"));
}

function normalizedReceivedAt(value) {
  const timestamp = Date.parse(String(value || ""));
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : new Date().toISOString();
}

function normalizeSubject(value) {
  return String(value || "")
    .replace(/\r\n?/g, " ")
    .replace(/^(?:(?:re|fw|fwd)\s*:\s*)+/i, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLocaleLowerCase();
}

function normalizeTag(value) {
  return String(value || "")
    .replace(/\s+/g, " ")
    .trim()
    .toLocaleLowerCase()
    .replace(/\s*-\s*/g, "-");
}

function subjectTags(value) {
  return [...String(value || "").matchAll(/\[([^\]]+)\]/g)]
    .map((match) => normalizeTag(match[1]))
    .filter(Boolean);
}

function subjectsMatch(requestRow, subject) {
  const company = String(requestRow?.client_name || "").replace(/[\[\]]/g, "").trim();
  const requestNumber = String(requestRow?.request_number || "").trim();
  if (!company || !/^REQ\s*-\s*\d+$/i.test(requestNumber)) return false;

  // Only the stable bracket tags route mail. The free-form subject may be
  // changed by a client, prefixed with Re/Fw, or decorated with a provider
  // counter such as [3] or [4].
  const tags = new Set(subjectTags(subject));
  return tags.has(normalizeTag(company)) && tags.has(normalizeTag(requestNumber));
}

async function resolveRequestsByTags(subject) {
  if (!String(subject || "").trim()) return [];

  const requests = await supabaseAdminFetch(
    tablePath("requests", "?select=id,request_number,title,client_id,created_at&order=created_at.desc")
  );
  const requestRows = requests || [];
  const clientIds = [...new Set(requestRows.map((requestRow) => requestRow.client_id).filter(Boolean))];
  if (!clientIds.length) return [];

  const clients = await supabaseAdminFetch(
    tablePath("clients", `?select=id,name,primary_contact_email&id=${inFilter(clientIds)}`)
  );
  const clientById = Object.fromEntries((clients || []).map((client) => [client.id, client]));

  return requestRows.map((requestRow) => {
    const client = clientById[requestRow.client_id] || {};
    return {
      ...requestRow,
      client_name: client.name || "",
    };
  }).filter((requestRow) => subjectsMatch(requestRow, subject));
}

async function requestInboundSenderEmails(requestRow) {
  const [clients, contacts, teamProfiles] = await Promise.all([
    supabaseAdminFetch(
      tablePath("clients", `?select=primary_contact_email&id=eq.${encodeValue(requestRow.client_id)}&limit=1`)
    ),
    supabaseAdminFetch(
      tablePath("request_client_contacts", `?select=email&request_id=eq.${encodeValue(requestRow.id)}`)
    ),
    // Team members are trusted senders for tagged request conversations even
    // when they were not assigned to this particular request. This allows an
    // owner/admin to reply from their normal mailbox and have the reply land
    // in the same portal conversation, while the stable subject tags still
    // constrain which request receives it.
    supabaseAdminFetch(
      tablePath("profiles", "?select=email&role=in.(owner,project_manager,developer,reviewer,assignee)")
    )
  ]);

  const configuredMailbox = normalizeEmail(
    process.env.PROTON_MAIL_ADDRESS || process.env.PROTON_MAIL_FROM || ""
  );
  return new Set([
    normalizeEmail(clients?.[0]?.primary_contact_email),
    configuredMailbox,
    ...(contacts || []).map((contact) => normalizeEmail(contact.email)),
    ...(teamProfiles || []).map((profile) => normalizeEmail(profile.email))
  ].filter(Boolean));
}

async function ensureInboundProfile(email, name, clientId) {
  const normalizedEmail = normalizeEmail(email);
  if (!normalizedEmail) return null;

  const existing = await supabaseAdminFetch(
    tablePath("profiles", `?select=id,full_name,email,role,client_id&email=eq.${encodeValue(normalizedEmail)}&limit=1`)
  );
  const profile = existing?.[0];
  if (profile?.id) {
    if (profile.role === "client" && profile.client_id && profile.client_id !== clientId) return null;
    if (profile.role === "client" && !profile.client_id) {
      const rows = await supabaseAdminFetch(
        tablePath("profiles", `?id=eq.${encodeValue(profile.id)}&select=id,full_name,email,role,client_id`),
        { method: "PATCH", body: JSON.stringify({ client_id: clientId }) }
      );
      return rows?.[0] || { ...profile, client_id: clientId };
    }
    return profile;
  }

  const authUser = await createAuthUser(normalizedEmail, name || normalizedEmail);
  const rows = await supabaseAdminFetch(tablePath("profiles"), {
    method: "POST",
    body: JSON.stringify({
      id: authUser.id,
      full_name: name || normalizedEmail,
      email: normalizedEmail,
      role: "client",
      client_id: clientId,
      job_title: "Client contact",
      is_active: true,
      must_change_password: true
    })
  });
  return rows?.[0] || null;
}

async function addDiscoveredContacts(requestRow, addresses) {
  const clients = await supabaseAdminFetch(
    tablePath("clients", `?select=primary_contact_email&id=eq.${encodeValue(requestRow.client_id)}&limit=1`)
  );
  const primaryEmail = normalizeEmail(clients?.[0]?.primary_contact_email);
  const configuredMailbox = normalizeEmail(process.env.PROTON_MAIL_ADDRESS || process.env.PROTON_MAIL_FROM || "");
  const uniqueAddresses = new Map();
  (addresses || []).forEach((address) => {
    const email = normalizeEmail(address.email);
    if (!email || email === primaryEmail || email === configuredMailbox) return;
    if (!uniqueAddresses.has(email)) uniqueAddresses.set(email, {
      email,
      name: String(address.name || "").trim() || null
    });
  });
  if (!uniqueAddresses.size) return { contacts: [], profiles: {} };

  const emails = [...uniqueAddresses.keys()];
  let profiles = await supabaseAdminFetch(
    tablePath("profiles", `?select=id,email,full_name,role,client_id&email=${inFilter(emails)}`)
  );
  const profileByEmail = Object.fromEntries((profiles || []).map((profile) => [normalizeEmail(profile.email), profile]));

  // A newly introduced CC participant becomes a request contact immediately.
  // Existing team profiles are reused; unknown client-side addresses get the
  // same lightweight client profile used by the manual CC-contact flow.
  for (const contact of uniqueAddresses.values()) {
    if (profileByEmail[contact.email]) continue;
    try {
      const profile = await ensureInboundProfile(contact.email, contact.name, requestRow.client_id);
      if (profile?.id) profileByEmail[contact.email] = profile;
    } catch (error) {
      // A malformed/foreign CC address must not prevent the actual message
      // from being imported. It simply will not be added as a portal contact.
      console.warn("[Clients] Could not prepare inbound CC contact", contact.email, error.message);
    }
  }

  const rows = [...uniqueAddresses.values()].map((contact) => ({
    request_id: requestRow.id,
    profile_id: profileByEmail[contact.email]?.id || null,
    name: contact.name,
    email: contact.email
  }));
  try {
    const inserted = await supabaseAdminFetch(tablePath("request_client_contacts"), {
      method: "POST",
      headers: {
        Prefer: "resolution=ignore-duplicates,return=representation"
      },
      body: JSON.stringify(rows)
    });
    return { contacts: inserted || [], profiles: profileByEmail };
  } catch (error) {
    // A previously discovered CC/contact must never prevent the message
    // itself from being imported.
    if (/duplicate key|already exists|unique constraint/i.test(String(error.message || ""))) {
      return { contacts: [], profiles: profileByEmail };
    }
    throw error;
  }
}

export async function POST(request) {
  try {
    if (!authorized(request)) return apiJson({ error: "Invalid Proton webhook secret." }, 401);

    const payload = await request.json();
    const senderRecord = addressRecord(payload.from || payload.sender || payload.senderEmail);
    const sender = senderRecord.email;
    const subject = String(payload.subject || "").trim();
    const body = cleanBody(payload);
    const receivedAt = normalizedReceivedAt(payload.receivedAt || payload.received_at || payload.date);
    const externalMessageId = String(payload.messageId || payload.message_id || payload.id || headerValue(payload, ["message-id"]) || "").trim();
    const externalThreadId = String(payload.threadId || payload.thread_id || payload.inReplyTo || payload.in_reply_to || headerValue(payload, ["in-reply-to", "references"]) || "").trim();
    // The inbound worker marks a message as processed whenever this endpoint
    // returns 2xx. Ignore malformed/unrelated mail with a successful response
    // so one bad mailbox item cannot be retried forever and consume origin
    // transfer.
    if (!sender || !body || !externalMessageId) {
      return apiJson({ ok: true, ignored: true, reason: "Missing sender, body, or messageId." });
    }

    const existing = await supabaseAdminFetch(
      tablePath("request_messages", `?select=id,request_id&external_message_id=eq.${encodeValue(externalMessageId)}&limit=1`)
    );
    if (existing?.[0]) return apiJson({ ok: true, duplicate: true, messageId: existing[0].id, requestId: existing[0].request_id });

    const requestMatches = await resolveRequestsByTags(subject);
    if (requestMatches.length !== 1) {
      return apiJson({
        ok: true,
        ignored: true,
        reason: "The email subject does not contain exactly one existing client/company request tag pair."
      });
    }
    const requestRow = requestMatches[0];
    const allowedSenderEmails = await requestInboundSenderEmails(requestRow);
    if (!allowedSenderEmails.has(sender)) {
      return apiJson({
        ok: true,
        ignored: true,
        reason: "The sender is not the client, an approved request contact, a team member, or the configured mailbox."
      });
    }

    const discovered = await addDiscoveredContacts(requestRow, [
      senderRecord,
      ...addressRecords(payload.cc)
    ]);
    const senderProfile = discovered.profiles[sender]
      || await ensureInboundProfile(sender, senderRecord.name, requestRow.client_id);
    if (!senderProfile?.id) {
      return apiJson({
        ok: true,
        ignored: true,
        reason: "The sender could not be linked to this client request."
      });
    }

    const rows = await supabaseAdminFetch(tablePath("request_messages"), {
      method: "POST",
      headers: { Prefer: "return=representation" },
      body: JSON.stringify({
        request_id: requestRow.id,
        sender_id: senderProfile.id,
        message: body,
        is_internal: false,
        external_message_id: externalMessageId,
        external_thread_id: externalThreadId || null,
        external_subject: subject,
        external_sender_email: sender,
        created_at: receivedAt,
        source: "proton"
      })
    });

    return apiJson({ ok: true, requestId: requestRow.id, messageId: rows?.[0]?.id || null });
  } catch (error) {
    return handleApiError(error);
  }
}
