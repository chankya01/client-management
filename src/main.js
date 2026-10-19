import {
  addRequestClientContact,
  completePasswordRecoverySession,
  createClient,
  createClientContact,
  createMessage,
  createRequest,
  createSignedDownload,
  createSignatureDocument,
  createTeamMember,
  deleteClient,
  deleteRequest,
  deleteTeamMember,
  getSession,
  isLocalAutoLoginMode,
  loadClientContacts,
  loadClients,
  loadClosedRequests,
  loadDeliverables,
  loadMessages,
  loadProfile,
  loadRequestAssignments,
  loadRequestClientContacts,
  loadRequests,
  loadSignatureByToken,
  loadSignatureDocuments,
  loadTeam,
  onAuthStateChange,
  sendMagicLink,
  sendPasswordReset,
  setRequestClientContacts,
  setRequestAssignments,
  signSignatureRecipient,
  signInWithPassword,
  signOut,
  updateClient,
  updateOwnProfile,
  updatePassword,
  updateRequest,
  updateTeamMember,
  uploadRequestAttachment
} from "./api.js";

const root = document.getElementById("root");
const APP_NAME = "Clients";

function signatureTokenFromUrl() {
  if (typeof window === "undefined") return "";
  const queryToken = new URLSearchParams(window.location.search).get("sign");
  if (queryToken) return queryToken;
  const match = window.location.pathname.match(/^\/sign\/([^/]+)/);
  return match ? decodeURIComponent(match[1]) : "";
}

const state = {
  session: null,
  profile: null,
  requests: [],
  activeRequest: null,
  messages: [],
  messagesByRequest: {},
  unreadCounts: {},
  deliverables: [],
  history: [],
  clients: [],
  clientContacts: [],
  team: [],
  requestAssignments: [],
  requestClientContacts: [],
  signatureDocuments: [],
  publicSignature: null,
  publicSignatureToken: signatureTokenFromUrl(),
  publicSignatureError: "",
  publicProposalPage: "services",
  messageDrafts: {},
  clientDraft: {},
  requestDraft: {},
  ccContactDrafts: {},
  signatureDraft: {},
  pendingActions: new Set(),
  selectedRequestId: null,
  selectedClientId: null,
  requestClientSelection: null,
  signatureClientSelection: null,
  selectedSignatureDocumentId: null,
  proposalViewer: null,
  editingClientId: null,
  editingRequestId: null,
  editingTeamId: null,
  showPasswordForm: false,
  authView: isPasswordRecoveryFlow() ? "reset-password" : "signin",
  page: "dashboard",
  loading: true,
  loadError: "",
  toast: ""
};

const adminPages = ["admin-dashboard", "admin-clients", "admin-client-detail", "admin-requests", "admin-request-detail", "admin-messages", "admin-documents", "admin-team", "admin-settings"];
const clientPages = ["dashboard", "messages", "request", "account"];
const managementRoles = ["owner", "project_manager"];
const workRoles = ["developer", "reviewer", "assignee"];
const internalRoles = [...managementRoles, ...workRoles];
const workPortalPages = ["admin-dashboard", "admin-requests", "admin-request-detail", "admin-messages", "admin-documents", "admin-team", "admin-settings"];
const LOAD_TIMEOUT_MS = 20000;
const MESSAGE_POLL_MS = 8000;
const UNREAD_POLL_MS = 30000;
const UNREAD_BATCH_SIZE = 4;
const LAST_PAGE_KEY = "requestManagementLastPage";
const LAST_REQUEST_KEY = "requestManagementLastRequest";
const serviceCatalog = [
  "WCAG Accessibility Audit",
  "VPAT / ACR",
  "Technical Support",
  "Certification",
  "User Testing",
  "Document Remediation",
  "Custom Accessibility Statement",
  "Expedited Accessibility"
];
let loadGeneration = 0;
let messagePollInFlight = false;
let unreadPollInFlight = false;

function withTimeout(promise, label, ms = LOAD_TIMEOUT_MS) {
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      window.setTimeout(() => reject(new Error(`${label} took too long. Please sign out and sign in again, or check Supabase profile/RLS setup.`)), ms);
    })
  ]);
}

async function safeLoad(label, loader, fallback) {
  try {
    return await loader();
  } catch (error) {
    console.warn(`[${APP_NAME}] ${label} failed`, error);
    return fallback;
  }
}

function normalizeEmail(email) {
  return String(email || "").trim().toLowerCase();
}

function statusLabel(status) {
  const normalizedStatus = workflowStatusKey(status);
  const labels = {
    new: "Enquiry",
    scoping: "Scoping",
    agreement: "Agreement",
    payment: "Payment",
    in_progress: "In Progress",
    validation: "Validation",
    closed: "Completed",
    cancelled: "Cancelled"
  };
  return labels[normalizedStatus] || String(status || "new")
    .replaceAll("_", " ")
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function statusDescription(status) {
  const normalizedStatus = workflowStatusKey(status);
  const descriptions = {
    new: "Client provided project details.",
    scoping: "Scope and quote are being prepared.",
    agreement: "Agreement details are being handled with the client.",
    payment: "Payment is pending, received, or being confirmed.",
    in_progress: "Audit, tracker setup, remediation, or assigned work is in progress.",
    validation: "Fixes are being validated.",
    closed: "Process complete.",
    cancelled: "Request cancelled."
  };
  return descriptions[normalizedStatus] || "Pending";
}

function workflowStatusKey(status) {
  if (["quote_sent"].includes(status)) return "scoping";
  if (["agreement_pending", "agreement_acknowledged"].includes(status)) return "agreement";
  if (["remediation", "client_fixes", "delivered", "tracker_uploaded"].includes(status)) return "in_progress";
  if (["documentation_issued"].includes(status)) return "closed";
  return status || "new";
}

function isTerminalRequestStatus(status) {
  return ["closed", "cancelled"].includes(workflowStatusKey(status));
}

function roleLabel(role) {
  if (role === "owner") return "Admin";
  if (role === "project_manager") return "Project Manager";
  return statusLabel(role || "Team Member");
}

function isPasswordRecoveryFlow(event) {
  if (event === "PASSWORD_RECOVERY") return true;
  if (typeof window === "undefined") return false;
  const params = new URLSearchParams(window.location.search);
  const hashParams = new URLSearchParams(window.location.hash.replace(/^#/, ""));
  return params.get("mode") === "password-reset"
    || params.get("type") === "recovery"
    || (params.has("code") && params.get("mode") === "password-reset")
    || hashParams.get("type") === "recovery";
}

function passwordRecoveryPage() {
  if (!isInternal()) return "account";
  return "admin-settings";
}

function clearPasswordRecoveryUrl() {
  if (typeof window === "undefined") return;
  const params = new URLSearchParams(window.location.search);
  if (params.get("mode") !== "password-reset" && params.get("type") !== "recovery" && !params.has("code") && !window.location.hash.includes("type=recovery")) return;
  window.history.replaceState({}, document.title, window.location.pathname);
}

function requestServices(request) {
  return String(request?.service_type || "")
    .split(/\s*,\s*|\s*\+\s*|\s*;\s*/)
    .map((service) => service.trim())
    .filter(Boolean);
}

function servicesText(request) {
  const services = requestServices(request);
  return services.length ? services.join(", ") : "Accessibility service";
}

function serviceCheckboxes(selectedText) {
  const selectedServices = new Set(requestServices({ service_type: selectedText }));
  return `
    <div class="field wide service-dropdown" data-service-dropdown>
      <span>Services</span>
      <button class="service-dropdown-toggle" type="button" data-action="toggle-services" aria-expanded="false">
        <span data-service-summary>${selectedServices.size ? escapeHtml(Array.from(selectedServices).join(", ")) : "Select Services"}</span>
        <span aria-hidden="true">▾</span>
      </button>
      <div class="service-dropdown-menu" data-service-menu hidden>
        ${serviceCatalog.map((service) => `
          <label>
            <input type="checkbox" name="services" value="${escapeHtml(service)}" ${selectedServices.has(service) ? "checked" : ""} />
            <span>${escapeHtml(service)}</span>
          </label>
        `).join("")}
        <div class="form-actions">
          <button class="secondary small-action" type="button" data-action="close-services">Done</button>
        </div>
      </div>
      <small class="helper">Select one or more services.</small>
    </div>
  `;
}

function statusTracker(request) {
  const steps = [
    "new",
    "scoping",
    "agreement",
    "payment",
    "in_progress",
    "validation",
    "closed"
  ];
  const currentIndex = Math.max(0, steps.indexOf(workflowStatusKey(request?.status)));
  return `
    <section class="card">
      <p class="section-label">Status Tracker</p>
      <div class="status-timeline">
        ${steps.map((step, index) => `
          <div class="timeline-step ${index < currentIndex ? "done" : ""} ${index === currentIndex ? "current" : ""}">
            <span class="timeline-dot"></span>
            <div>
              <strong>${statusLabel(step)}</strong>
              <small>${index < currentIndex ? "Completed" : index === currentIndex ? statusDescription(step) : "Pending"}</small>
            </div>
          </div>
        `).join("")}
      </div>
    </section>
  `;
}

function formatDate(value) {
  if (!value) return "-";
  return new Intl.DateTimeFormat("en", {
    month: "short",
    day: "numeric",
    year: "numeric"
  }).format(new Date(value));
}

function formatTime(value) {
  return new Intl.DateTimeFormat("en", {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit"
  }).format(new Date(value));
}

function formatFileSize(bytes) {
  const size = Number(bytes || 0);
  if (!size) return "";
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}

function showToast(message) {
  state.toast = message;
  render();
  window.clearTimeout(showToast.timer);
  showToast.timer = window.setTimeout(() => {
    state.toast = "";
    render();
  }, 3200);
}

function friendlyErrorMessage(error) {
  const message = String(error?.message || error || "Something went wrong.");
  const lower = message.toLowerCase();
  if (lower.includes("duplicate key") || lower.includes("already exists") || lower.includes("23505")) {
    if (lower.includes("request")) {
      return "A request with the same generated number already exists. Please try creating it again.";
    }
    if (lower.includes("email")) {
      return message.includes("already exists")
        ? message
        : "A record with this email already exists. Please use the existing record.";
    }
    return message.includes("already exists")
      ? message
      : "A duplicate record already exists. Please use the existing record or try again.";
  }
  if (lower.includes("row level security") || lower.includes("violates row-level security")) {
    return "Permission issue: your account is not allowed to perform this action yet. Please ask an admin to check access policies.";
  }
  if (lower.includes("invalid login credentials")) return "Invalid email or password.";
  if (lower.includes("failed to fetch") || lower.includes("network")) {
    return "Network error. Please check your connection and try again.";
  }
  return message;
}

function showAppError(error, context = "Action failed") {
  console.error(`[${APP_NAME}] ${context}`, error);
  showToast(friendlyErrorMessage(error));
}

function setActionElementBusy(element, busy) {
  if (!element) return;
  const buttons = element.matches?.("button")
    ? [element]
    : Array.from(element.querySelectorAll("button[type='submit'], button.primary, button.secondary, button.danger-link"));
  buttons.forEach((button) => {
    if (busy) {
      button.dataset.originalText = button.dataset.originalText || button.textContent;
      button.disabled = true;
      if (button.type === "submit" || button.classList.contains("primary")) button.textContent = "Working...";
    } else {
      button.disabled = false;
      if (button.dataset.originalText) {
        button.textContent = button.dataset.originalText;
        delete button.dataset.originalText;
      }
    }
  });
}

async function withActionLock(key, element, action) {
  if (state.pendingActions.has(key)) return null;
  state.pendingActions.add(key);
  setActionElementBusy(element, true);
  try {
    return await action();
  } finally {
    state.pendingActions.delete(key);
    setActionElementBusy(element, false);
  }
}

function defaultPage() {
  if (state.profile?.must_change_password) {
    if (!isInternal()) return "account";
    return "admin-settings";
  }
  if (canAccessManagementPages()) return "admin-dashboard";
  return isInternal() ? "admin-dashboard" : "dashboard";
}

function pageIsAllowed(page) {
  if (!isInternal()) return clientPages.includes(page);
  return allowedInternalPages().includes(page);
}

function allowedInternalPages() {
  return canAccessManagementPages() ? adminPages : workPortalPages;
}

function savedPage() {
  if (state.profile?.must_change_password) return null;
  const page = localStorage.getItem(LAST_PAGE_KEY);
  return page && pageIsAllowed(page) ? page : null;
}

function routePage() {
  if (typeof window === "undefined" || state.profile?.must_change_password) return null;
  const page = new URLSearchParams(window.location.search).get("page");
  return page && pageIsAllowed(page) ? page : null;
}

function routeRequestId() {
  if (typeof window === "undefined") return "";
  return new URLSearchParams(window.location.search).get("request") || "";
}

async function restorePageAfterPortalLoad({ fallbackToCurrent = false } = {}) {
  const page = routePage()
    || (fallbackToCurrent && pageIsAllowed(state.page) ? state.page : null)
    || savedPage()
    || defaultPage();
  const requestId = routeRequestId() || state.activeRequest?.id;

  if (requestId && pageUsesRequestParam(page)) {
    await setActiveRequest(requestId, { page, markRead: false });
  } else {
    state.page = page;
    rememberPage();
  }
}

function rememberPage() {
  if (pageIsAllowed(state.page)) {
    localStorage.setItem(LAST_PAGE_KEY, state.page);
  }
}

function currentRoute() {
  const params = new URLSearchParams();
  if (state.page) params.set("page", state.page);
  if (pageUsesRequestParam(state.page) && state.activeRequest?.id) params.set("request", state.activeRequest.id);
  if (state.selectedClientId) params.set("client", state.selectedClientId);
  return `${window.location.pathname}?${params.toString()}`;
}

function syncBrowserHistory({ replace = false } = {}) {
  if (typeof window === "undefined" || !pageIsAllowed(state.page)) return;
  const route = currentRoute();
  if (window.location.pathname + window.location.search === route) return;
  const method = replace ? "replaceState" : "pushState";
  window.history[method]({ page: state.page, requestId: state.activeRequest?.id || null }, "", route);
}

function closeServiceDropdownsOnOutsideClick(event) {
  if (event.target.closest?.("[data-service-dropdown], [data-assignment-dropdown], [data-cc-dropdown]")) return;
  document.querySelectorAll("[data-service-menu]").forEach((menu) => {
    menu.hidden = true;
    const toggle = menu.closest("[data-service-dropdown]")?.querySelector("[data-action='toggle-services']");
    toggle?.setAttribute("aria-expanded", "false");
  });
  document.querySelectorAll("[data-assignment-menu]").forEach((menu) => {
    menu.hidden = true;
    const toggle = menu.closest("[data-assignment-dropdown]")?.querySelector("[data-action='toggle-assignments']");
    toggle?.setAttribute("aria-expanded", "false");
  });
  document.querySelectorAll("[data-cc-menu]").forEach((menu) => {
    menu.hidden = true;
    const toggle = menu.closest("[data-cc-dropdown]")?.querySelector("[data-action='toggle-cc-contacts']");
    toggle?.setAttribute("aria-expanded", "false");
  });
}

function nextServiceVersionLabel(requestId) {
  const messages = state.messagesByRequest[requestId] || [];
  const versions = messages
    .map((message) => String(message.message || "").match(/Services v(\d+)/i)?.[1])
    .filter(Boolean)
    .map(Number);
  const nextVersion = versions.length ? Math.max(...versions) + 1 : 1;
  return `Services v${nextVersion}`;
}

function serviceVersionMessage({ versionLabel, services }) {
  return `${versionLabel}: ${services || "No services selected"}.`;
}

function statusChangeMessage({ previousStatus, nextStatus, actorName }) {
  return `Status updated by ${actorName || "Team Member"}: ${statusLabel(previousStatus)} → ${statusLabel(nextStatus)}.`;
}

function displayText(value, fallback = "Not Set") {
  const text = String(value || "").trim();
  return text || fallback;
}

function canonicalText(value) {
  return String(value || "").trim().replace(/\s+/g, " ");
}

function canonicalServices(value) {
  return requestServices({ service_type: value })
    .map((service) => service.toLowerCase())
    .sort()
    .join("|");
}

function teamNamesForIds(profileIds = []) {
  const profileIdSet = new Set(profileIds.filter(Boolean));
  const names = state.team
    .filter((member) => profileIdSet.has(member.id))
    .map((member) => member.full_name);
  const missingIds = [...profileIdSet].filter((id) => !state.team.some((member) => member.id === id));
  return [...names, ...missingIds].sort((left, right) => left.localeCompare(right));
}

function contactsForDisplay(contacts = []) {
  return contacts
    .map((contact) => ({
      name: String(contact.name || "").trim(),
      email: String(contact.email || "").trim().toLowerCase()
    }))
    .filter((contact) => contact.email)
    .sort((left, right) => left.email.localeCompare(right.email));
}

function listDisplay(items = [], fallback = "None") {
  return items.length ? items.join(", ") : fallback;
}

function contactDisplay(contacts = []) {
  return listDisplay(contactsForDisplay(contacts).map((contact) => (
    contact.name ? `${contact.name} <${contact.email}>` : contact.email
  )));
}

function contactComparison(contacts = []) {
  return contactsForDisplay(contacts)
    .map((contact) => `${contact.name.toLowerCase()}<${contact.email}>`)
    .join("|");
}

function newContactEmails(previousContacts = [], nextContacts = []) {
  const previousEmails = new Set(contactsForDisplay(previousContacts).map((contact) => contact.email));
  return contactsForDisplay(nextContacts)
    .map((contact) => contact.email)
    .filter((email) => email && !previousEmails.has(email));
}

function requestUpdateMessage({
  previousRequest,
  nextRequest,
  previousAssignedIds,
  nextAssignedIds,
  previousContacts,
  nextContacts,
  actorName
}) {
  const changes = [];
  const addChange = (label, before, after, beforeCompare = before, afterCompare = after) => {
    if (beforeCompare === afterCompare) return;
    changes.push(`- ${label}: ${before} → ${after}`);
  };

  addChange("Client", clientName(previousRequest.client_id), clientName(nextRequest.clientId), previousRequest.client_id, nextRequest.clientId);
  addChange("Title", displayText(previousRequest.title), displayText(nextRequest.title), canonicalText(previousRequest.title), canonicalText(nextRequest.title));
  addChange("Description", displayText(previousRequest.description), displayText(nextRequest.description), canonicalText(previousRequest.description), canonicalText(nextRequest.description));
  addChange("Services", displayText(previousRequest.service_type), displayText(nextRequest.serviceType), canonicalServices(previousRequest.service_type), canonicalServices(nextRequest.serviceType));
  addChange("Due Date", formatDate(previousRequest.due_date), formatDate(nextRequest.dueDate), previousRequest.due_date || "", nextRequest.dueDate || "");
  addChange("Status", statusLabel(previousRequest.status), statusLabel(nextRequest.status), workflowStatusKey(previousRequest.status), workflowStatusKey(nextRequest.status));

  const previousTeamNames = teamNamesForIds(previousAssignedIds);
  const nextTeamNames = teamNamesForIds(nextAssignedIds);
  addChange(
    "Tagged Team Members",
    listDisplay(previousTeamNames),
    listDisplay(nextTeamNames),
    [...previousAssignedIds].sort().join("|"),
    [...nextAssignedIds].sort().join("|")
  );

  addChange(
    "CC Contacts",
    contactDisplay(previousContacts),
    contactDisplay(nextContacts),
    contactComparison(previousContacts),
    contactComparison(nextContacts)
  );

  if (!changes.length) return "";
  return [`Request updated by ${actorName || "Team Member"}:`, ...changes].join("\n");
}

function readStateKey() {
  return `requestManagementReadState:${state.profile?.id || "anonymous"}`;
}

function loadReadState() {
  try {
    return JSON.parse(localStorage.getItem(readStateKey()) || "{}");
  } catch {
    return {};
  }
}

function saveReadState(readState) {
  localStorage.setItem(readStateKey(), JSON.stringify(readState));
}

function messageNeedsRead(message) {
  const senderRole = message.profiles?.role;
  if (message.sender_id && message.sender_id === state.profile?.id) return false;
  if (!isInternal()) return senderRole !== "client";
  if (senderRole === "client") return true;
  if (senderRole) return false;
  return !state.team.some((member) => member.id === message.sender_id);
}

function calculateUnreadCounts() {
  const readState = loadReadState();
  state.unreadCounts = Object.fromEntries(state.requests.map((request) => {
    const messages = state.messagesByRequest[request.id] || [];
    const lastReadAt = readState[request.id] || "";
    const unreadCount = messages.filter((message) => (
      messageNeedsRead(message) && (!lastReadAt || new Date(message.created_at) > new Date(lastReadAt))
    )).length;
    return [request.id, unreadCount];
  }));
}

function totalUnreadCount() {
  return Object.values(state.unreadCounts).reduce((sum, count) => sum + Number(count || 0), 0);
}

function requestUnreadBadge(requestId) {
  const count = state.unreadCounts[requestId] || 0;
  return count ? `<span class="count">${count}</span>` : "";
}

function downloadFromUrl(url, fileName = "download") {
  const link = document.createElement("a");
  link.href = url;
  link.download = fileName;
  link.rel = "noopener noreferrer";
  link.style.display = "none";
  document.body.appendChild(link);
  link.click();
  link.remove();
}

function messageDraftValue(requestId) {
  return escapeHtml(state.messageDrafts[requestId] || "");
}

function clearMessageDraft(requestId) {
  if (!requestId) return;
  delete state.messageDrafts[requestId];
}

function clientDraftValue(field, fallback = "") {
  return state.clientDraft[field] ?? fallback ?? "";
}

function clearClientDraft() {
  state.clientDraft = {};
}

function hasClientDraft() {
  const draft = state.clientDraft || {};
  return Boolean(
    String(draft.name || "").trim()
    || String(draft.contactName || "").trim()
    || String(draft.email || "").trim()
    || String(draft.billingEmail || "").trim()
    || (draft.status && draft.status !== "signed")
    || String(draft.ccFullName || "").trim()
    || String(draft.ccEmail || "").trim()
  );
}

function requestDraftValue(field, fallback = "") {
  return state.editingRequestId ? fallback : (state.requestDraft[field] ?? fallback ?? "");
}

function requestDraftList(field, fallback = []) {
  return state.editingRequestId ? fallback : (state.requestDraft[field] || fallback || []);
}

function hasRequestDraft() {
  const draft = state.requestDraft || {};
  return Boolean(
    state.requestClientSelection
    || String(draft.title || "").trim()
    || String(draft.description || "").trim()
    || String(draft.dueDate || "").trim()
    || (draft.status && draft.status !== "new")
    || (draft.services || []).length
    || (draft.assignedProfileIds || []).length
    || (draft.ccContactEmails || []).length
  );
}

function clearRequestDraft() {
  state.requestDraft = {};
  state.requestClientSelection = null;
}

function requestDraftFromForm(form) {
  const formData = new FormData(form);
  return {
    clientId: String(formData.get("clientId") || ""),
    title: String(formData.get("title") || ""),
    description: String(formData.get("description") || ""),
    dueDate: String(formData.get("dueDate") || ""),
    status: String(formData.get("status") || "new"),
    services: formData.getAll("services").map(String),
    assignedProfileIds: formData.getAll("assignedProfileIds").map(String),
    ccContactEmails: formData.getAll("ccContactEmails").map(String)
  };
}

function ccContactDraft(requestId) {
  return state.ccContactDrafts[requestId] || { name: "", email: "" };
}

function clearCcContactDraft(requestId) {
  if (!requestId) return;
  delete state.ccContactDrafts[requestId];
}

function isConversationPage(page) {
  return page === "messages" || page === "admin-messages";
}

function pageUsesRequestParam(page) {
  return ["messages", "request", "admin-messages", "admin-request-detail"].includes(page);
}

function pageNeedsMessages(page) {
  return isConversationPage(page) || page === "admin-request-detail";
}

function pageNeedsDeliverables(page) {
  return page === "request";
}

function rememberActiveRequest() {
  if (state.activeRequest?.id) {
    localStorage.setItem(LAST_REQUEST_KEY, state.activeRequest.id);
  }
}

function markRequestRead(requestId) {
  if (!requestId) return;
  const messages = state.messagesByRequest[requestId] || [];
  const latestMessage = messages[messages.length - 1];
  const readState = loadReadState();
  readState[requestId] = latestMessage?.created_at || new Date().toISOString();
  saveReadState(readState);
  calculateUnreadCounts();
}

async function setActiveRequest(requestId, { page, markRead = false } = {}) {
  const targetPage = page || state.page;
  state.activeRequest = state.requests.find((request) => request.id === requestId) || state.activeRequest || state.requests[0] || null;
  state.selectedRequestId = state.activeRequest?.id || null;
  rememberActiveRequest();
  if (state.activeRequest && pageNeedsMessages(targetPage)) {
    state.messages = state.messagesByRequest[state.activeRequest.id] || await loadMessages(state.activeRequest.id);
    state.messagesByRequest[state.activeRequest.id] = state.messages;
  } else {
    state.messages = state.activeRequest ? (state.messagesByRequest[state.activeRequest.id] || []) : [];
  }
  state.deliverables = state.activeRequest && pageNeedsDeliverables(targetPage)
    ? await loadDeliverables(state.activeRequest.id)
    : [];
  if (markRead && state.activeRequest) markRequestRead(state.activeRequest.id);
  if (page) {
    state.page = page;
    rememberPage();
  }
}

async function goToPage(page, { requestId, clientId, replace = false, scroll = true } = {}) {
  state.page = page;
  if (clientId) state.selectedClientId = clientId;
  rememberPage();
  if (requestId) {
    await setActiveRequest(requestId, { page, markRead: isConversationPage(page) });
  } else if (isConversationPage(page) && state.activeRequest) {
    await setActiveRequest(state.activeRequest.id, { markRead: true });
  }
  syncBrowserHistory({ replace });
  render();
  if (scroll) {
    if (isConversationPage(page)) {
      scrollConversationToEnd();
    } else {
      window.scrollTo({ top: 0, behavior: "smooth" });
    }
  }
}

function scrollConversationToEnd({ behavior = "smooth" } = {}) {
  const scrollToEnd = () => {
    document.querySelector("[data-message-end]")?.scrollIntoView({ behavior, block: "end" });
  };
  window.requestAnimationFrame(() => {
    scrollToEnd();
    window.requestAnimationFrame(scrollToEnd);
    window.setTimeout(scrollToEnd, 120);
  });
}

async function refreshActiveMessages({ markRead = false } = {}) {
  if (!state.activeRequest) return;
  state.messages = await loadMessages(state.activeRequest.id);
  state.messagesByRequest[state.activeRequest.id] = state.messages;
  if (markRead) markRequestRead(state.activeRequest.id);
  calculateUnreadCounts();
}

function messageListSignature(messages = []) {
  return messages.map((message) => `${message.id}:${message.created_at || ""}`).join("|");
}

async function pollActiveMessages() {
  if (
    messagePollInFlight
    || !state.session
    || state.loading
    || !state.activeRequest
    || !isConversationPage(state.page)
    || document.visibilityState === "hidden"
  ) {
    return;
  }
  messagePollInFlight = true;
  try {
    const previousSignature = messageListSignature(state.messagesByRequest[state.activeRequest.id] || []);
    const messages = await loadMessages(state.activeRequest.id);
    const nextSignature = messageListSignature(messages);
    if (previousSignature !== nextSignature) {
      state.messages = messages;
      state.messagesByRequest[state.activeRequest.id] = messages;
      markRequestRead(state.activeRequest.id);
      calculateUnreadCounts();
      render();
    }
  } catch (error) {
    console.warn(`[${APP_NAME}] Message polling failed`, error);
  } finally {
    messagePollInFlight = false;
  }
}

async function refreshUnreadCounts({ onlyMissing = false, generation = loadGeneration, allowWhileLoading = false } = {}) {
  if (unreadPollInFlight || !state.session || (!allowWhileLoading && state.loading) || document.visibilityState === "hidden") return;
  const activeConversationRequestId = isConversationPage(state.page) ? state.activeRequest?.id : null;
  const requestsToLoad = state.requests.filter((request) => (
    request.id !== activeConversationRequestId
    && (!onlyMissing || !state.messagesByRequest[request.id])
  ));
  if (!requestsToLoad.length) return;
  unreadPollInFlight = true;
  try {
    for (let index = 0; index < requestsToLoad.length; index += UNREAD_BATCH_SIZE) {
      const batch = requestsToLoad.slice(index, index + UNREAD_BATCH_SIZE);
      const messageEntries = await Promise.all(batch.map(async (request) => [
        request.id,
        await loadMessages(request.id)
      ]));
      if (generation !== loadGeneration) return;
      messageEntries.forEach(([requestId, messages]) => {
        state.messagesByRequest[requestId] = messages;
      });
    }
    calculateUnreadCounts();
    // Do not replace an active proposal document while it is being reviewed.
    if (!document.querySelector("[data-proposal-preview-document], [data-proposal-viewer-document]")) render();
  } catch (error) {
    console.warn(`[${APP_NAME}] Unable to refresh unread counts`, error);
  } finally {
    unreadPollInFlight = false;
  }
}

async function returnToSignInAfterLoadFailure(error, context = "Account loading", { keepCurrentPortal = false } = {}) {
  console.error(`[${APP_NAME}] ${context}`, error);
  if (keepCurrentPortal && state.profile) {
    state.loading = false;
    state.loadError = "";
    render();
    return;
  }
  state.loading = false;
  state.loadError = error?.message || "Account data could not be loaded.";
  render();
}

async function boot() {
  const generation = ++loadGeneration;
  const recoveryFlow = isPasswordRecoveryFlow();
  try {
    if (state.publicSignatureToken) {
      try {
        state.session = await withTimeout(getSession(), "Session check");
        state.publicSignature = await withTimeout(loadSignatureByToken(state.publicSignatureToken), "Signature document loading");
        state.publicSignatureError = "";
      } catch (error) {
        console.warn(`[${APP_NAME}] Signature link loading`, error);
        state.publicSignature = null;
        state.publicSignatureError = error?.message || "This signing link could not be loaded. Please request a fresh link.";
      }
      state.loading = false;
      render();
      return;
    }
    state.session = recoveryFlow
      ? await withTimeout(completePasswordRecoverySession(), "Password reset session")
      : await withTimeout(getSession(), "Session check");
    if (state.session) {
      if (recoveryFlow) {
        state.authView = "reset-password";
        state.loading = false;
        render();
        return;
      }
      await withTimeout(loadPortalData(), "Account data loading");
      await restorePageAfterPortalLoad();
      syncBrowserHistory({ replace: true });
    } else if (recoveryFlow) {
      state.authView = "reset-password";
    }
  } catch (error) {
    if (recoveryFlow) {
      console.warn(`[${APP_NAME}] Password reset session setup`, error);
      state.authView = "reset-password";
      state.loadError = "";
      showToast("Enter your new password to continue. If this fails, request a fresh reset link.");
    } else {
      await returnToSignInAfterLoadFailure(error, "Initial account loading");
    }
  } finally {
    if (generation !== loadGeneration) return;
    state.loading = false;
    render();
  }
}

async function loadPortalData() {
  state.profile = await loadProfile();
  const [
    loadedRequests,
    requestAssignments,
    requestClientContacts,
    clientContacts,
    clients,
    team,
    history,
    signatureDocuments
  ] = await Promise.all([
    loadRequests(),
    (isInternal() || state.profile?.role === "client") ? safeLoad("Request assignment loading", loadRequestAssignments, []) : Promise.resolve([]),
    (canAccessManagementPages() || state.profile?.role === "client") ? safeLoad("Request contact loading", loadRequestClientContacts, []) : Promise.resolve([]),
    canAccessManagementPages() ? safeLoad("Client contact loading", loadClientContacts, []) : Promise.resolve([]),
    isInternal() ? safeLoad("Client loading", loadClients, []) : Promise.resolve([]),
    (isInternal() || state.profile?.role === "client") ? safeLoad("Team loading", loadTeam, []) : Promise.resolve([]),
    isInternal() ? safeLoad("History loading", loadClosedRequests, null) : Promise.resolve(null),
    safeLoad("Signature document loading", loadSignatureDocuments, [])
  ]);
  state.requestAssignments = requestAssignments;
  state.requestClientContacts = requestClientContacts;
  state.clientContacts = clientContacts;
  state.signatureDocuments = signatureDocuments;
  if (isInternal() && !canAccessManagementPages()) {
    state.requests = loadedRequests.filter((request) => state.requestAssignments.some((assignment) => (
      assignment.request_id === request.id && assignment.profile_id === state.profile.id
    )));
  } else if (state.profile?.role === "client"
    && normalizeEmail(state.profile.email) !== normalizeEmail(state.profile.clients?.primary_contact_email)) {
    state.requests = loadedRequests.filter((request) => state.requestClientContacts.some((contact) => (
      contact.request_id === request.id
      && (contact.profile_id === state.profile.id || normalizeEmail(contact.email) === normalizeEmail(state.profile.email))
    )));
  } else {
    state.requests = loadedRequests;
  }
  state.clients = clients;
  state.team = team;
  const lastRequestId = localStorage.getItem(LAST_REQUEST_KEY);
  state.activeRequest = state.requests.find((request) => request.id === lastRequestId)
    || state.requests.find((request) => !isTerminalRequestStatus(request.status))
    || state.requests[0]
    || null;
  state.selectedRequestId = state.activeRequest?.id || null;
  state.history = isInternal() ? (history || state.requests) : state.requests;
  state.messagesByRequest = {};

  if (state.activeRequest) {
    calculateUnreadCounts();
    state.messages = [];
    state.deliverables = [];
  } else {
    state.messages = [];
    state.deliverables = [];
    calculateUnreadCounts();
  }

  refreshUnreadCounts({ onlyMissing: true, generation: loadGeneration, allowWhileLoading: true });
}

function renderSignIn() {
  root.innerHTML = `
    <main class="signin-shell">
      <form class="signin-card" id="signinForm">
        ${brandLogo("signin")}
        <h1>Sign In</h1>
        <p class="helper">Use your email and password to access your workspace or client portal.</p>
          <label class="field">
            <span>Email Address</span>
            <input name="email" type="email" autocomplete="email" required />
          </label>
          <label class="field">
            <span>Password</span>
            <input name="password" type="password" autocomplete="current-password" required />
          </label>
          <label class="password-toggle">
            <input type="checkbox" data-toggle-password="password" />
            <span>Show Password</span>
          </label>
        <button class="primary" type="submit">Sign In</button>
        <div class="signin-actions">
          <button class="link-button" type="button" data-action="forgot-password">Forgot Password?</button>
        </div>
      </form>
      ${toastHtml()}
    </main>
  `;

  attachSignInEvents();
}

function attachSignInEvents() {
  document.getElementById("signinForm")?.addEventListener("submit", async (event) => {
    event.preventDefault();
    const values = Object.fromEntries(new FormData(event.currentTarget));
    try {
      const session = await signInWithPassword(values.email, values.password);
      if (session?.user) {
        state.authView = "signin";
        await completeSignIn(session);
        return;
      }
      showToast(`Signed in to ${APP_NAME}.`);
    } catch (error) {
      showAppError(error);
    }
  });

  document.querySelector("[data-action='forgot-password']")?.addEventListener("click", () => {
    state.authView = "forgot-password";
    render();
  });

  attachPasswordToggles();
}

function renderForgotPassword() {
  root.innerHTML = `
    <main class="signin-shell">
      <form class="signin-card" id="forgotPasswordForm">
        ${brandLogo("signin")}
        <h1>Reset Password</h1>
        <p class="helper">Enter your account email address. We’ll send a secure password reset link.</p>
        <label class="field">
          <span>Email Address</span>
          <input name="email" type="email" autocomplete="email" required />
        </label>
        <div class="auth-actions">
          <button class="primary" type="submit">Send Reset Link</button>
          <button class="secondary" type="button" data-action="back-to-signin">Back to Sign In</button>
        </div>
      </form>
      ${toastHtml()}
    </main>
  `;

  document.getElementById("forgotPasswordForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    const values = Object.fromEntries(new FormData(event.currentTarget));
    try {
      await sendPasswordReset(values.email);
      showToast("Password reset email sent. Check your inbox.");
    } catch (error) {
      showAppError(error);
    }
  });

  document.querySelector("[data-action='back-to-signin']").addEventListener("click", () => {
    state.authView = "signin";
    render();
  });
}

function renderResetPassword() {
  root.innerHTML = `
    <main class="signin-shell">
      <form class="signin-card" id="resetPasswordForm">
        ${brandLogo("signin")}
        <h1>Set New Password</h1>
        <p class="helper">Enter and confirm your new password.</p>
        <label class="field">
          <span>New Password</span>
          <input name="password" type="password" autocomplete="new-password" minlength="8" required />
        </label>
        <label class="field">
          <span>Confirm Password</span>
          <input name="confirmPassword" type="password" autocomplete="new-password" minlength="8" required />
        </label>
        <label class="password-toggle">
          <input type="checkbox" data-toggle-password="password,confirmPassword" />
          <span>Show Password</span>
        </label>
        <button class="primary" type="submit">Update Password</button>
      </form>
      ${toastHtml()}
    </main>
  `;

  document.getElementById("resetPasswordForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    const values = Object.fromEntries(new FormData(event.currentTarget));
    if (values.password !== values.confirmPassword) {
      showToast("Passwords do not match.");
      return;
    }
    try {
      await updatePassword(values.password);
      clearPasswordRecoveryUrl();
      await signOut();
      resetSessionState();
      renderSignIn();
      showToast("Password updated. Please sign in with your new password.");
    } catch (error) {
      showAppError(error);
    }
  });

  attachPasswordToggles();
}

async function completeSignIn(session) {
  state.session = session;
  state.loading = true;
  state.loadError = "";
  render();
  if (state.publicSignatureToken) {
    try {
      state.publicSignature = await loadSignatureByToken(state.publicSignatureToken);
      state.publicSignatureError = "";
      state.loading = false;
      showToast(`Signed in to ${APP_NAME}.`);
      render();
      return;
    } catch (error) {
      state.publicSignature = null;
      state.publicSignatureError = error?.message || "This signing link could not be loaded. Please request a fresh link.";
      state.loading = false;
      render();
      return;
    }
  }
  await loadPortalData();
  state.loading = false;
  state.page = defaultPage();
  showToast(`Signed in to ${APP_NAME}.`);
  render();
}

function isAdmin() {
  return managementRoles.includes(state.profile?.role);
}

function isInternal() {
  return internalRoles.includes(state.profile?.role);
}

function canAccessManagementPages() {
  return managementRoles.includes(state.profile?.role);
}

function canManageTeam() {
  return managementRoles.includes(state.profile?.role);
}

function canManageRequests() {
  return managementRoles.includes(state.profile?.role);
}

function canManageClients() {
  return managementRoles.includes(state.profile?.role);
}

function canDelete() {
  return state.profile?.role === "owner";
}

function navHtml() {
  if (isInternal()) return adminNavHtml();

  const unreadCount = totalUnreadCount();
  return `
    <header class="topbar">
      <div class="topbar-inner">
        ${brandLogo("nav")}
        <nav class="nav client-nav" aria-label="Client portal">
          ${navButton("dashboard", "Dashboard")}
          ${navButton("messages", `Messages ${unreadCount ? `<span class="count">${unreadCount}</span>` : ""}`)}
          ${navButton("account", "Account")}
        </nav>
      </div>
    </header>
  `;
}

function adminNavHtml() {
  const canManage = canAccessManagementPages();
  return `
    <header class="topbar admin-topbar">
      <div class="topbar-inner admin-topbar-inner">
        ${brandLogo("nav")}
        <nav class="nav" aria-label="Admin portal">
          ${navButton("admin-dashboard", "Dashboard")}
          ${canManage ? navButton("admin-clients", "Clients") : ""}
          ${navButton("admin-requests", "Requests")}
          ${navButton("admin-messages", `Messages ${totalUnreadCount() ? `<span class="count">${totalUnreadCount()}</span>` : ""}`)}
          ${navButton("admin-documents", "Proposals")}
          ${navButton("admin-team", "Team")}
          ${navButton("admin-settings", "Settings")}
          <button class="nav-logout" data-action="logout">Logout</button>
        </nav>
      </div>
    </header>
  `;
}

function navButton(page, label) {
  return `<button class="${state.page === page ? "active" : ""}" data-page="${page}">${label}</button>`;
}

function brandLogo(variant = "nav") {
  return `
    <div class="brand brand-logo brand-logo-${variant}" aria-label="${APP_NAME}">
      <span class="brand-mark" aria-hidden="true">
        <span class="brand-ticket"></span>
        <span class="brand-chat"></span>
      </span>
      <span class="brand-copy">
        <strong>${APP_NAME}</strong>
      </span>
    </div>
  `;
}

function requestTitle() {
  return state.activeRequest?.title || "No Active Request";
}

function organizationName() {
  return state.profile?.clients?.name || "Client Organization";
}

function clientName(clientId) {
  return state.clients.find((client) => client.id === clientId)?.name || organizationName();
}

function clientPrimaryContactName(clientId) {
  const client = state.clients.find((item) => item.id === clientId);
  return client?.primary_contact_name || state.profile?.clients?.primary_contact_name || state.profile?.full_name || "Client";
}

function organizationContacts(clientId) {
  const client = state.clients.find((item) => item.id === clientId);
  const primaryEmail = normalizeEmail(client?.primary_contact_email);
  return state.clientContacts
    .filter((contact) => contact.client_id === clientId)
    .filter((contact) => normalizeEmail(contact.email) !== primaryEmail)
    .sort((left, right) => String(left.full_name || "").localeCompare(String(right.full_name || "")));
}

function assignableTeamMembers() {
  return state.team.filter((member) => member.role !== "client");
}

function assignedProfileIdsForRequest(requestId) {
  return state.requestAssignments
    .filter((assignment) => assignment.request_id === requestId)
    .map((assignment) => assignment.profile_id);
}

function assignedPeopleText(requestId) {
  const assignedIds = new Set(assignedProfileIdsForRequest(requestId));
  const names = state.team
    .filter((member) => assignedIds.has(member.id))
    .map((member) => member.full_name);
  return names.length ? names.join(", ") : "Not Assigned";
}

function clientContactsForRequest(requestId) {
  return state.requestClientContacts.filter((contact) => contact.request_id === requestId);
}

function requestCcPanel(request = state.activeRequest) {
  if (isInternal() || !request) return "";
  const contacts = clientContactsForRequest(request.id);
  const draft = ccContactDraft(request.id);
  return `
    <section class="card request-cc-panel">
      <p class="section-label">CC Contacts</p>
      <div class="cc-contact-list">
        ${contacts.map((contact) => `
          <div class="cc-contact-row">
            <strong>${escapeHtml(contact.name || contact.email)}</strong>
            <span>${escapeHtml(contact.email)}</span>
          </div>
        `).join("") || `<p class="helper">No CC contacts added yet.</p>`}
      </div>
      <form class="mini-form" data-client-cc-contact-form data-request-id="${escapeHtml(request.id)}">
        <label>
          Name
          <input name="name" type="text" placeholder="Contact name" value="${escapeHtml(draft.name)}" />
        </label>
        <label>
          Email
          <input name="email" type="email" placeholder="contact@example.com" value="${escapeHtml(draft.email)}" required />
        </label>
        <div class="form-actions">
          <button class="primary small-action" type="submit">Add CC</button>
          <button class="secondary small-action" type="button" data-cancel-request-cc-contact>Cancel</button>
        </div>
      </form>
    </section>
  `;
}

function ccContactCheckboxes(clientId, selectedContacts = []) {
  const contacts = organizationContacts(clientId);
  const selectedEmails = new Set(selectedContacts.map((contact) => normalizeEmail(contact.email)));
  const client = state.clients.find((item) => item.id === clientId);
  const selectedSummary = contacts
    .filter((contact) => selectedEmails.has(normalizeEmail(contact.email)))
    .map((contact) => contact.full_name || contact.email)
    .join(", ");
  return `
    <div class="field wide service-dropdown cc-dropdown" data-cc-dropdown>
      <span>CC Contacts</span>
      <button class="service-dropdown-toggle" type="button" data-action="toggle-cc-contacts" aria-expanded="false" ${clientId ? "" : "disabled"}>
        <span data-cc-summary>${selectedSummary ? escapeHtml(selectedSummary) : "Select CC Contacts"}</span>
        <span aria-hidden="true">▾</span>
      </button>
      <div class="service-dropdown-menu" data-cc-menu hidden>
        ${contacts.map((contact) => `
          <label>
            <input type="checkbox" name="ccContactEmails" value="${escapeHtml(contact.email)}" data-cc-name="${escapeHtml(contact.full_name || contact.email)}" ${selectedEmails.has(normalizeEmail(contact.email)) ? "checked" : ""} />
            <span>${escapeHtml(contact.full_name || contact.email)} · ${escapeHtml(contact.email)}</span>
          </label>
        `).join("") || `<p class="helper">No additional contacts for ${escapeHtml(client?.name || "this organization")} yet. Add contacts from Client Management first.</p>`}
        <button class="secondary small-action" type="button" data-action="close-cc-contacts">Done</button>
      </div>
      <small class="helper">${clientId ? "Select one or more client-side contacts for this request." : "Select a client first to choose CC contacts."}</small>
    </div>
  `;
}

function assignmentCheckboxes(selectedIds = []) {
  const selected = new Set(selectedIds);
  const people = assignableTeamMembers();
  return `
    <div class="field wide service-dropdown assignment-dropdown" data-assignment-dropdown>
      <span>Tagged Team Members</span>
      <button class="service-dropdown-toggle" type="button" data-action="toggle-assignments" aria-expanded="false">
        <span data-assignment-summary>${selected.size ? escapeHtml(people.filter((member) => selected.has(member.id)).map((member) => member.full_name).join(", ")) : "Select Team Members"}</span>
        <span aria-hidden="true">▾</span>
      </button>
      <div class="service-dropdown-menu" data-assignment-menu hidden>
        ${people.map((member) => `
          <label>
            <input type="checkbox" name="assignedProfileIds" value="${member.id}" data-assignment-name="${escapeHtml(member.full_name)}" ${selected.has(member.id) ? "checked" : ""} />
            <span>${escapeHtml(member.full_name)} · ${escapeHtml(roleLabel(member.role))}</span>
          </label>
        `).join("") || `<p class="helper">Add developer/reviewer/assignee team members first, then tag them here.</p>`}
        <button class="secondary small-action" type="button" data-action="close-assignments">Done</button>
      </div>
    </div>
  `;
}

function displayRequestNumber(request) {
  const storedNumber = String(request?.request_number || "").trim();
  if (/^REQ-\d{1,3}$/i.test(storedNumber)) return storedNumber.toUpperCase();

  const relatedRequests = [...state.requests, ...state.history]
    .filter((item, index, list) => item.client_id === request?.client_id && list.findIndex((other) => other.id === item.id) === index)
    .sort((left, right) => new Date(left.created_at || 0).getTime() - new Date(right.created_at || 0).getTime());
  const requestIndex = relatedRequests.findIndex((item) => item.id === request?.id);
  return requestIndex >= 0 ? `REQ-${requestIndex + 1}` : storedNumber || "REQ-1";
}

function adminDashboardPage() {
  const activeRequests = state.requests.filter((request) => !isTerminalRequestStatus(request.status));
  const permissionText = canAccessManagementPages()
    ? "management permissions."
    : `${roleLabel(state.profile.role)} access.`;
  return `
    <section class="admin-page">
      <div class="admin-heading">
        <div>
          <h1>Dashboard</h1>
          <p class="subtitle">Overview of clients, active requests, team members, and recent requests. Signed in as ${escapeHtml(state.profile.full_name)} · ${escapeHtml(permissionText)}</p>
        </div>
      </div>
      <div class="metric-grid">
        ${canAccessManagementPages() ? metricCard("Clients", state.clients.length) : ""}
        ${metricCard("Active Requests", activeRequests.length)}
        ${metricCard("Team Members", state.team.length)}
        ${metricCard("Access", roleLabel(state.profile.role))}
      </div>
      <section class="card">
        <p class="section-label">Recent Requests</p>
        ${adminRequestRows(state.requests, { source: "dashboard" })}
      </section>
      ${!canAccessManagementPages() && (state.profile?.must_change_password || state.showPasswordForm) ? passwordSection("Password and Account") : ""}
    </section>
  `;
}

function metricCard(label, value) {
  return `<section class="card metric-card"><span>${label}</span><strong>${value}</strong></section>`;
}

function clientStatusOptions(selected) {
  return ["signed", "ongoing", "dropped"].map((status) => (
    `<option value="${status}" ${selected === status ? "selected" : ""}>${statusLabel(status)}</option>`
  )).join("");
}

function requestStatusOptions(selected) {
  const selectedStatus = workflowStatusKey(selected);
  return [
    "new",
    "scoping",
    "agreement",
    "payment",
    "in_progress",
    "validation",
    "closed",
    "cancelled"
  ].map((status) => (
    `<option value="${status}" ${selectedStatus === status ? "selected" : ""}>${statusLabel(status)}</option>`
  )).join("");
}

function clientStatusBar() {
  const counts = ["signed", "ongoing", "dropped"].map((status) => ({
    status,
    count: state.clients.filter((client) => (client.status || "signed") === status).length
  }));

  return `
    <div class="status-bar">
      ${counts.map((item) => `
        <div class="status-segment ${item.status}">
          <span>${statusLabel(item.status)}</span>
          <strong>${item.count}</strong>
        </div>
      `).join("")}
    </div>
  `;
}

function adminClientsPage() {
  const editingClient = state.clients.find((client) => client.id === state.editingClientId);
  const clientStatus = editingClient?.status || clientDraftValue("status", "signed");
  const showClientCancel = editingClient || hasClientDraft();
  const editingClientContacts = editingClient ? organizationContacts(editingClient.id) : [];
  return `
    <section class="admin-page">
      <div class="admin-heading">
        <div>
          <h1>Client Management</h1>
          <p class="subtitle">Create the client company, then create requests against that client.</p>
        </div>
      </div>
      <section class="card">
        <p class="section-label">${editingClient ? "Edit Client" : "Add Client"}</p>
        <form class="admin-form" id="clientForm">
          <label class="field"><span>Organization</span><input name="name" value="${escapeHtml(clientDraftValue("name", editingClient?.name || ""))}" required /></label>
          <label class="field"><span>Primary Contact</span><input name="contactName" value="${escapeHtml(clientDraftValue("contactName", editingClient?.primary_contact_name || ""))}" required /></label>
          <label class="field"><span>Client Email</span><input name="email" type="email" value="${escapeHtml(clientDraftValue("email", editingClient?.primary_contact_email || ""))}" required /></label>
          <label class="field"><span>Billing Email</span><input name="billingEmail" type="email" value="${escapeHtml(clientDraftValue("billingEmail", editingClient?.billing_email || ""))}" /></label>
          <label class="field"><span>Status</span><select name="status">${clientStatusOptions(clientStatus)}</select></label>
          <p class="section-label cc-contact-heading wide">Add CC Contact</p>
          <label class="field"><span>Contact Name</span><input name="ccFullName" value="${escapeHtml(clientDraftValue("ccFullName", ""))}" /></label>
          <label class="field"><span>Email</span><input name="ccEmail" type="email" value="${escapeHtml(clientDraftValue("ccEmail", ""))}" /></label>
          <small class="helper wide">${editingClient ? `Optional: add one CC contact for ${escapeHtml(editingClient.name)} while updating this client.` : "Optional: add one CC contact while creating this client."} New contacts receive an account setup email.</small>
          <div class="form-actions wide client-form-actions">
            <button class="primary" type="submit">${editingClient ? "Update Client" : "Create Client"}</button>
            <button class="secondary" type="button" data-cancel-client-edit ${showClientCancel ? "" : "hidden"}>${editingClient ? "Cancel Edit" : "Cancel"}</button>
          </div>
        </form>
      </section>
      ${editingClient ? `
        <section class="card">
          <p class="section-label">CC Contacts</p>
          <p class="helper">Saved CC contacts for ${escapeHtml(editingClient.name)}. You can add more than one CC contact.</p>
          <div class="cc-contact-list existing-cc-contacts">
            ${editingClientContacts.map((contact) => `
              <div class="cc-contact-row">
                <strong>${escapeHtml(contact.full_name || contact.email)}</strong>
                <span>${escapeHtml(contact.email)}</span>
              </div>
            `).join("") || `<p class="helper">No CC contacts added for this organization yet.</p>`}
          </div>
        </section>
      ` : ""}
      <section class="card">
        <p class="section-label">Client List</p>
        ${clientStatusBar()}
        ${state.clients.map((client) => `
          <div class="admin-row clickable-row" data-open-client="${client.id}">
            <div>
              <strong>${escapeHtml(client.name)}</strong>
              <span>Primary: ${escapeHtml(client.primary_contact_name || "-")} · ${escapeHtml(client.primary_contact_email || "-")}</span>
              <span>CC Contacts: ${escapeHtml(listDisplay(organizationContacts(client.id).map((contact) => `${contact.full_name || contact.email} <${contact.email}>`), "None"))}</span>
            </div>
            <div class="row-actions">
              <span class="status-pill">${escapeHtml(statusLabel(client.status || "signed"))}</span>
              <button class="secondary small-action" data-edit-client="${client.id}">Edit</button>
              ${canDelete() ? `<button class="danger-link" data-delete-client="${client.id}">Delete</button>` : ""}
            </div>
          </div>
        `).join("")}
      </section>
    </section>
  `;
}

function adminClientDetailPage() {
  const client = state.clients.find((item) => item.id === state.selectedClientId) || state.clients[0];
  if (!client) return emptyCard("Client Not Found", "The selected client is no longer available.");

  const contacts = organizationContacts(client.id);
  const clientRequests = state.requests.filter((request) => request.client_id === client.id);
  return `
    <section class="admin-page">
      <button class="secondary back-button" data-page="admin-clients">Back to Clients</button>
      <div class="admin-heading">
        <div>
          <p class="section-label green">Client Details</p>
          <h1>${escapeHtml(client.name)}</h1>
          <p class="subtitle">${escapeHtml(client.primary_contact_name || "-")} · ${escapeHtml(client.primary_contact_email || "-")}</p>
        </div>
        <div class="row-actions">
          <button class="secondary" data-edit-client="${client.id}">Edit Client</button>
          ${canDelete() ? `<button class="danger-button" data-delete-client="${client.id}">Delete Client</button>` : ""}
        </div>
      </div>
      <div class="detail-grid">
        <section class="card">
          <p class="section-label">Organization</p>
          ${accountRow("Organization", client.name)}
          ${accountRow("Primary Contact", client.primary_contact_name)}
          ${accountRow("Primary Email", client.primary_contact_email)}
          ${accountRow("Billing Email", client.billing_email)}
          ${accountRow("Status", statusLabel(client.status || "signed"))}
          ${accountRow("Created", formatDate(client.created_at))}
        </section>
        <section class="card">
          <p class="section-label">CC Contacts</p>
          ${contacts.map((contact) => `
            <div class="list-row">
              <strong>${escapeHtml(contact.full_name || contact.email)}</strong>
              <span>${escapeHtml(contact.email)}</span>
            </div>
          `).join("") || `<p class="helper">No CC contacts added for this organization yet.</p>`}
        </section>
        <section class="card">
          <p class="section-label">Requests</p>
          ${clientRequests.map((request) => `
            <div class="list-row clickable-row" data-open-request="${request.id}">
              <strong>${escapeHtml(displayRequestNumber(request))} · ${escapeHtml(request.title)}</strong>
              <span>${escapeHtml(statusLabel(request.status))} · Due ${formatDate(request.due_date)}</span>
            </div>
          `).join("") || `<p class="helper">No requests for this client yet.</p>`}
        </section>
      </div>
    </section>
  `;
}

function adminRequestsPage() {
  const editingRequest = state.requests.find((request) => request.id === state.editingRequestId);
  const requestStatus = requestDraftValue("status", editingRequest?.status || "new");
  const selectedAssignees = requestDraftList("assignedProfileIds", editingRequest ? assignedProfileIdsForRequest(editingRequest.id) : []);
  const selectedClientId = state.requestClientSelection || requestDraftValue("clientId", editingRequest?.client_id || "");
  const selectedCcContacts = editingRequest
    ? clientContactsForRequest(editingRequest.id)
    : organizationContacts(selectedClientId).filter((contact) => (
      requestDraftList("ccContactEmails").map(normalizeEmail).includes(normalizeEmail(contact.email))
    ));
  const selectedServicesText = requestDraftList("services", requestServices(editingRequest || {})).join(", ");
  const showRequestCancel = editingRequest || hasRequestDraft();
  return `
    <section class="admin-page">
      <div class="admin-heading">
        <div>
          <h1>Request Management</h1>
          <p class="subtitle">Create work for a client and keep the client view scoped to that request/company.</p>
        </div>
      </div>
      ${canManageRequests() ? `
        <section class="card">
          <p class="section-label">${editingRequest ? "Edit Request" : "Create Request"}</p>
          <form class="admin-form" id="requestForm">
            <label class="field"><span>Client</span><select name="clientId" required><option value="" ${selectedClientId ? "" : "selected"} disabled>Select Client</option>${state.clients.map((client) => `<option value="${client.id}" ${selectedClientId === client.id ? "selected" : ""}>${escapeHtml(client.name)}</option>`).join("")}</select></label>
            <label class="field"><span>Title</span><input name="title" value="${escapeHtml(requestDraftValue("title", editingRequest?.title || ""))}" required /></label>
            <label class="field wide"><span>Description</span><input name="description" value="${escapeHtml(requestDraftValue("description", editingRequest?.description || ""))}" /></label>
            ${ccContactCheckboxes(selectedClientId, selectedCcContacts)}
            ${serviceCheckboxes(selectedServicesText)}
            ${assignmentCheckboxes(selectedAssignees)}
            <label class="field"><span>Due Date</span><input name="dueDate" type="date" value="${escapeHtml(requestDraftValue("dueDate", editingRequest?.due_date || ""))}" /></label>
            <label class="field"><span>Status</span><select name="status">${requestStatusOptions(requestStatus)}</select></label>
            <div class="form-actions wide request-form-actions">
              <button class="primary" type="submit">${editingRequest ? "Update Request" : "Create Request"}</button>
              <button class="secondary" type="button" data-cancel-request-edit ${showRequestCancel ? "" : "hidden"}>${editingRequest ? "Cancel Edit" : "Cancel"}</button>
            </div>
          </form>
        </section>
      ` : `
        <section class="card">
          <p class="section-label">Work Queue</p>
          <p class="helper">You can view request details and continue request conversations. Client creation, request edits, and deletion are available only to Admin and Project Manager.</p>
        </section>
      `}
      <section class="card">
        <p class="section-label">All Requests</p>
        ${adminRequestRows(state.requests)}
      </section>
    </section>
  `;
}

function adminRequestRows(requests, { source = "requests" } = {}) {
  return requests.map((request) => `
    <div class="admin-row clickable-row" data-open-request="${request.id}">
      <div>
        <strong class="request-client-line">${escapeHtml(clientName(request.client_id))}</strong>
        <span class="request-title-line">
          <span class="request-number">${escapeHtml(displayRequestNumber(request))}</span>
          · Due ${formatDate(request.due_date)}
          <span class="request-status-text">${statusLabel(request.status)}</span>
        </span>
        ${isInternal() ? `<span class="assigned-line">Tagged: ${escapeHtml(assignedPeopleText(request.id))}</span>` : ""}
      </div>
      <div class="row-actions">
        ${requestUnreadBadge(request.id)}
        ${canManageRequests() ? `<button class="secondary small-action" data-edit-request="${request.id}">Edit</button>` : ""}
        ${canDelete() ? `<button class="danger-link" data-delete-request="${request.id}">Delete</button>` : ""}
      </div>
    </div>
  `).join("") || `<p class="helper">No Requests Yet.</p>`;
}

function adminRequestDetailPage() {
  const request = state.requests.find((item) => item.id === state.selectedRequestId) || state.activeRequest;
  if (!request) return emptyCard("Request Not Found", "The selected request is no longer available.");

  const requestMessages = state.messages.filter((message) => message.request_id === request.id);
  return `
    <section class="admin-page">
      <button class="secondary back-button" data-page="admin-requests">Back to Requests</button>
      <div class="admin-heading">
        <div>
          <p class="section-label green">${escapeHtml(displayRequestNumber(request))}</p>
          <h1>${escapeHtml(request.title)}</h1>
          <p class="subtitle">${escapeHtml(clientName(request.client_id))} · ${escapeHtml(request.service_type || "Service")}</p>
        </div>
        <div class="row-actions">
          ${canManageRequests() ? `<button class="secondary" data-edit-request="${request.id}">Edit Request</button>` : ""}
          ${canDelete() ? `<button class="danger-button" data-delete-request="${request.id}">Delete Request</button>` : ""}
        </div>
      </div>
      <div class="detail-grid request-detail-stack">
        <section class="card">
          <p class="section-label">Request Details</p>
          ${accountRow("Client", clientName(request.client_id))}
          ${accountRow("Status", statusLabel(request.status))}
          ${accountRow("Tagged Team", assignedPeopleText(request.id))}
          ${accountRow("Due Date", formatDate(request.due_date))}
          ${accountRow("Created", formatDate(request.created_at))}
          <p class="card-note">${escapeHtml(request.description || "No description added.")}</p>
        </section>
        ${statusTracker(request)}
        <section class="card">
          <p class="section-label">Conversation Summary</p>
          <p class="helper">Showing the latest 4 messages. Open the full conversation to see everything.</p>
          ${requestMessages.slice(-4).map((message) => `
            <div class="list-row conversation-summary-row">
              <strong>${escapeHtml(message.profiles?.full_name || "User")}</strong>
              <span>${escapeHtml(messageSummaryText(message))}</span>
            </div>
          `).join("") || `<p class="helper">No Messages for This Request Yet.</p>`}
          <button class="primary conversation-button" type="button" data-open-request-messages="${request.id}">Open Conversation</button>
        </section>
        ${requestSignatureDocumentsCard(request)}
      </div>
    </section>
  `;
}

function adminMessagesPage() {
  const request = state.activeRequest || state.requests[0];
  if (!request) return emptyCard("Messages", "Create a request first, then messages will appear here.");
  const requestMessages = state.messages.filter((message) => message.request_id === request.id);

  return `
    <section class="admin-page">
      <div class="admin-heading">
        <div>
          <h1>Message Management</h1>
          <p class="subtitle">${escapeHtml(displayRequestNumber(request))} · ${escapeHtml(request.title)} · ${escapeHtml(clientName(request.client_id))}</p>
        </div>
      </div>
      <div class="message-layout">
        <aside class="card message-request-list">
          <p class="section-label">Requests</p>
          ${state.requests.map((item) => `
            <button type="button" class="${item.id === request.id ? "active" : ""}" data-admin-message-request="${item.id}">
              <span>
                <strong>${escapeHtml(displayRequestNumber(item))}</strong>
                <span>${escapeHtml(item.title)}</span>
                <span>${escapeHtml(clientName(item.client_id))}</span>
              </span>
              ${requestUnreadBadge(item.id)}
            </button>
          `).join("")}
        </aside>
        <section>
          ${requestMessages.map(messageCard).join("") || emptyMessage()}
          <form class="card composer" id="internalMessageForm">
            <label class="section-label" for="internalMessageText">New Message</label>
            <textarea id="internalMessageText" name="message" data-message-draft="${request.id}" placeholder="Write a message to the client or project team">${messageDraftValue(request.id)}</textarea>
            <div class="selected-file-row" data-selected-file-for="internalAttachmentInput" hidden>
              <span data-selected-file-name></span>
              <button class="remove-file-button" type="button" data-clear-file="internalAttachmentInput" aria-label="Remove selected file">×</button>
            </div>
            <div class="composer-actions">
              <div class="composer-meta">
                <label class="file-control">
                  Attachment
                  <input id="internalAttachmentInput" name="attachment" type="file" />
                </label>
                <span class="helper">Visible on the request conversation.</span>
              </div>
              <button class="primary" type="submit">Send Message</button>
            </div>
          </form>
          <div data-message-end></div>
        </section>
      </div>
    </section>
  `;
}

function adminTeamPage() {
  const editingMember = state.team.find((member) => member.id === state.editingTeamId);
  const formTitle = editingMember ? "Update Team Member" : "Add Team Member";
  const submitText = editingMember ? "Update Team Member" : "Add Team Member";
  const roleValue = editingMember?.role || "";
  return `
    <section class="admin-page">
      <div class="admin-heading">
        <div>
          <h1>Team Management</h1>
          <p class="subtitle">Internal users who can own, manage, develop, or review work.</p>
        </div>
      </div>
      ${canManageTeam() ? `
        <section class="card">
          <p class="section-label">${formTitle}</p>
          <p class="helper">This creates or updates the Supabase Auth user and profile through the local/server backend. Share the configured temporary password, then ask the user to change it after first login.</p>
          <form class="admin-form" id="teamForm">
            <label class="field"><span>Full Name</span><input name="fullName" value="${escapeHtml(editingMember?.full_name || "")}" required /></label>
            <label class="field"><span>Email</span><input name="email" type="email" value="${escapeHtml(editingMember?.email || "")}" required /></label>
            <label class="field"><span>Role</span><select name="role">
              <option value="" ${roleValue ? "" : "selected"} disabled>Select Role</option>
              <option value="assignee" ${roleValue === "assignee" ? "selected" : ""}>Assignee</option>
              <option value="developer" ${roleValue === "developer" ? "selected" : ""}>Developer</option>
              <option value="reviewer" ${roleValue === "reviewer" ? "selected" : ""}>Reviewer</option>
              <option value="project_manager" ${roleValue === "project_manager" ? "selected" : ""}>Project Manager</option>
              <option value="owner" ${roleValue === "owner" ? "selected" : ""}>Admin</option>
            </select></label>
            <label class="field"><span>Job Title</span><input name="jobTitle" value="${escapeHtml(editingMember?.job_title || "")}" /></label>
            <button class="primary team-form-button" type="submit">${submitText}</button>
            ${editingMember ? `<button class="primary team-form-button" type="button" data-cancel-team-edit>Cancel Edit</button>` : ""}
          </form>
        </section>
      ` : `
        <section class="card">
          <p class="section-label">Team Directory</p>
          <p class="helper">You can view team members. Adding, editing, and deleting team members is restricted to Admin and Project Manager.</p>
        </section>
      `}
      <section class="card">
        <p class="section-label">People</p>
        ${state.team.map((member) => `
          <div class="admin-row">
            <div>
              <strong>${escapeHtml(member.full_name)}</strong>
              <span>${escapeHtml(member.email)} · ${escapeHtml(member.job_title || roleLabel(member.role))}</span>
              <span class="role-meta">${escapeHtml(roleLabel(member.role))}</span>
            </div>
            <div class="row-actions">
              ${canManageTeam() ? `<button class="secondary small-action" data-edit-team="${member.id}">Edit</button>` : ""}
              ${canDelete() ? `<button class="danger-link" data-delete-team="${member.id}" ${member.id === state.profile.id ? "disabled" : ""}>Delete</button>` : ""}
            </div>
          </div>
        `).join("")}
      </section>
    </section>
  `;
}

function adminSettingsPage() {
  if (!canAccessManagementPages()) {
    return `
      <section class="admin-page settings-page">
        <div class="admin-heading">
          <div>
            <p class="section-label green">Personal Settings</p>
            <h1>Settings</h1>
            <p class="subtitle">Manage your profile details and password.</p>
          </div>
        </div>
        <div class="settings-grid personal-settings-grid">
          <section class="card">
            <p class="section-label">Profile</p>
            <form class="admin-form profile-form" id="profileForm">
              <label class="field"><span>Name</span><input name="fullName" value="${escapeHtml(state.profile.full_name || "")}" required /></label>
              <label class="field"><span>Email</span><input name="email" type="email" value="${escapeHtml(state.profile.email || "")}" required /></label>
              <label class="field"><span>Role</span><input value="${escapeHtml(roleLabel(state.profile.role))}" disabled /></label>
              <button class="primary" type="submit">Update Profile</button>
            </form>
          </section>
          ${passwordSection("Password")}
        </div>
      </section>
    `;
  }

  return `
    <section class="admin-page">
      <div class="admin-heading">
        <div>
          <p class="section-label green">Workspace Settings</p>
          <h1>Settings</h1>
          <p class="subtitle">Manage the workspace basics and your account password.</p>
        </div>
      </div>
      <div class="settings-grid">
        <section class="card">
          <p class="section-label">Organization Profile</p>
          ${accountRow("Workspace Name", APP_NAME)}
          ${accountRow("Default Admin", state.profile.full_name)}
          ${accountRow("Support Email", "support@accessible.org")}
        </section>
        ${passwordSection("Password and Account")}
        <section class="card">
          <p class="section-label">Current Workspace</p>
          ${accountRow("Clients", state.clients.length)}
          ${accountRow("Active Requests", state.requests.filter((request) => !isTerminalRequestStatus(request.status)).length)}
          ${accountRow("Team Members", state.team.length)}
        </section>
      </div>
    </section>
  `;
}

function messagesPage() {
  if (!state.activeRequest) {
    return emptyCard("No Active Request", "Your portal is ready, but there are no active requests linked to this account yet.");
  }
  const requestFromName = organizationName();
  const requestMessages = state.messages.filter((message) => message.request_id === state.activeRequest.id);

  return `
    <section class="page">
      <div class="heading-accent">
        <h1>Messages</h1>
        <p class="subtitle message-subtitle">${escapeHtml(requestFromName)} · ${escapeHtml(requestTitle())}</p>
        <p class="assigned-line">Team: ${escapeHtml(assignedPeopleText(state.activeRequest.id))}</p>
      </div>
      <div class="message-layout client-message-layout">
        ${clientRequestSwitcher()}
        <section>
          <div class="date-row conversation-row"><span>Conversation</span></div>
          ${requestMessages.map(messageCard).join("") || emptyMessage()}
          <form class="card composer" id="messageForm">
            <label class="section-label" for="messageText">New Message</label>
            <textarea id="messageText" name="message" data-message-draft="${state.activeRequest.id}" placeholder="Write a message about ${escapeHtml(requestTitle())}">${messageDraftValue(state.activeRequest.id)}</textarea>
            <div class="selected-file-row" data-selected-file-for="attachmentInput" hidden>
              <span data-selected-file-name></span>
              <button class="remove-file-button" type="button" data-clear-file="attachmentInput" aria-label="Remove selected file">×</button>
            </div>
            <div class="composer-actions">
              <div class="composer-meta">
                <label class="file-control">
                  Attachment
                  <input id="attachmentInput" name="attachment" type="file" />
                </label>
              </div>
              <button class="primary" type="submit">Send Message</button>
            </div>
          </form>
          <div data-message-end></div>
        </section>
      </div>
    </section>
  `;
}

function messageCard(message) {
  const isClient = message.profiles?.role === "client";
  const messageRequest = state.requests.find((request) => request.id === message.request_id) || state.activeRequest;
  const sender = isClient
    ? (message.profiles?.full_name || clientPrimaryContactName(messageRequest?.client_id))
    : (message.profiles?.full_name || "Team Member");
  const attachment = message.attachment;
  const messageText = String(message.message || "");
  const isLongMessage = messageText.length > 420 || messageText.split(/\r?\n/).length > 8;
  return `
    <article class="message-card ${isClient ? "client" : "team"}">
      <div class="message-head">
        <span class="sender ${isClient ? "client-name" : ""}">${escapeHtml(sender)}</span>
        <time class="time">${formatTime(message.created_at)}</time>
      </div>
      ${messageText && messageText !== "Attachment" ? `
        <div class="message-text ${isLongMessage ? "is-collapsed" : ""}" data-message-text>${formatMessageText(messageText)}</div>
        ${isLongMessage ? `<button class="message-toggle" type="button" data-action="toggle-message">Show More</button>` : ""}
      ` : ""}
      ${attachment ? attachmentCard(attachment) : ""}
    </article>
  `;
}

function messageSummaryText(message) {
  const text = String(message?.message || "")
    .replace(/https?:\/\/\S+/g, "[link]")
    .replace(/\s+/g, " ")
    .trim();
  return text.length > 180 ? `${text.slice(0, 177)}...` : text;
}

function formatMessageText(text) {
  return escapeHtml(text)
    .replace(/(https?:\/\/[^\s<]+)/g, `<a href="$1" target="_blank" rel="noopener noreferrer">$1</a>`)
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .replace(/\n/g, "<br />");
}

function attachmentCard(file) {
  const meta = [file.mime_type, formatFileSize(file.file_size)].filter(Boolean).join(" · ");
  return `
    <div class="attachment-card">
      <div class="attachment-file">
        <span class="attachment-icon" aria-hidden="true">📎</span>
        <span>
          <strong>${escapeHtml(file.file_name || "Attachment")}</strong>
          ${meta ? `<small>${escapeHtml(meta)}</small>` : ""}
        </span>
      </div>
      <button class="download-button" type="button" aria-label="Download ${escapeHtml(file.file_name || "attachment")}" data-attachment-id="${escapeHtml(file.id)}">${downloadIcon()}</button>
    </div>
  `;
}

function clientRequestSwitcher() {
  if (isInternal() || !state.requests.length) return "";
  return `
    <aside class="card request-switcher message-request-list client-request-list-card">
      <p class="section-label">Requests</p>
      ${state.requests.map((request) => `
        <button type="button" class="${request.id === state.activeRequest?.id ? "active" : ""}" data-client-message-request="${request.id}">
          <span>
            <strong>${escapeHtml(displayRequestNumber(request))}</strong>
            <span>${escapeHtml(request.title)}</span>
            <span>${escapeHtml(clientName(request.client_id))}</span>
          </span>
          ${requestUnreadBadge(request.id)}
        </button>
      `).join("")}
    </aside>
    <section class="client-request-select-card">
      <label class="field" for="clientMessageRequestSelect">
        <span>Request</span>
        <select id="clientMessageRequestSelect" data-client-message-request-select>
          ${state.requests.map((request) => `
            <option value="${escapeHtml(request.id)}" ${request.id === state.activeRequest?.id ? "selected" : ""}>
              ${escapeHtml(displayRequestNumber(request))} · ${escapeHtml(request.title)}
            </option>
          `).join("")}
        </select>
      </label>
      <p class="helper">Change request here to view another conversation.</p>
    </section>
  `;
}

function dashboardPage() {
  return `
    <section class="page">
      <h1>Dashboard</h1>
      <p class="subtitle">Review your requests, status, services, and deliverables.</p>
      ${clientRequestCards(state.requests)}
    </section>
  `;
}

function clientRequestPage() {
  if (!state.activeRequest) {
    return emptyCard("Request", "No request is selected.");
  }

  return `
    <section class="page">
      <button class="secondary back-button" data-page="dashboard">Back to Dashboard</button>
      <div class="heading-accent">
        <h1>${escapeHtml(state.activeRequest.title)}</h1>
        <p class="subtitle">${escapeHtml(displayRequestNumber(state.activeRequest))} · ${statusLabel(state.activeRequest.status)} ${requestUnreadBadge(state.activeRequest.id)}</p>
      </div>
      <section class="card status-card">
        <p class="section-label green">Request Details</p>
        ${accountRow("Status", statusLabel(state.activeRequest.status))}
        ${accountRow("Tagged Team", assignedPeopleText(state.activeRequest.id))}
        ${accountRow("Due Date", formatDate(state.activeRequest.due_date))}
        ${accountRow("Created", formatDate(state.activeRequest.created_at))}
        <p class="card-note">${escapeHtml(state.activeRequest.description || "No description added.")}</p>
      </section>
      ${requestCcPanel()}
      ${statusTracker(state.activeRequest)}
      <section class="card">
        <p class="section-label">Services in this request</p>
        ${requestServices(state.activeRequest).map((service) => `<div class="list-row">${escapeHtml(service)}</div>`).join("") || `<p class="helper">No Services Listed.</p>`}
      </section>
      <section class="card">
        <p class="section-label">Deliverables</p>
        ${state.deliverables.map(deliverableRow).join("") || `<p class="helper">No Deliverables Have Been Released Yet.</p>`}
      </section>
      ${requestSignatureDocumentsCard(state.activeRequest)}
      <button class="primary" type="button" data-open-active-messages>Open Messages for This Request</button>
    </section>
  `;
}

function deliverableRow(deliverable) {
  const file = deliverable.files;
  return `
    <div class="deliverable-row">
      <span>${escapeHtml(deliverable.title)}${file?.file_name ? `<small>${escapeHtml(file.file_name)}</small>` : ""}</span>
      <time>${formatDate(deliverable.sent_at || deliverable.created_at)}</time>
      ${file ? `<button class="download-button" aria-label="Download ${escapeHtml(deliverable.title)}" data-file-id="${file.id}">${downloadIcon()}</button>` : ""}
    </div>
  `;
}

function signatureStatusLabel(status) {
  return String(status || "sent")
    .replaceAll("_", " ")
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function documentsForRequest(requestId) {
  return state.signatureDocuments.filter((document) => document.request_id === requestId);
}

function signatureRecipientRows(document) {
  const recipients = document.recipients || [];
  return recipients.map((recipient) => `
    <div class="deliverable-row">
      <span>
        ${escapeHtml(recipient.name || recipient.email)}
        <small>${escapeHtml(recipient.email)} · ${escapeHtml(signatureStatusLabel(recipient.status))}</small>
        ${isInternal() && recipient.signing_url ? `<small><a href="${escapeHtml(recipient.signing_url)}" target="_blank" rel="noopener noreferrer">Open signing link</a></small>` : ""}
      </span>
      <span class="status-pill">${escapeHtml(signatureStatusLabel(recipient.status))}</span>
    </div>
  `).join("") || `<p class="helper">No recipients added.</p>`;
}

function signatureEventRows(document) {
  const events = document.events || [];
  return events.map((event) => `
    <div class="signature-event-row">
      <span>
        <strong>${escapeHtml(signatureStatusLabel(event.event_type))}</strong>
        <small>${escapeHtml(signatureEventNote(event.event_note))}</small>
      </span>
      <time>${formatTime(event.created_at)}</time>
    </div>
  `).join("") || `<p class="helper">No activity yet.</p>`;
}

function signatureEventNote(note) {
  const raw = String(note || "");
  try {
    const parsed = JSON.parse(raw);
    return parsed?.message || raw;
  } catch {
    return raw;
  }
}

function signedSignatureDetails(payload) {
  const signedEvent = [...(payload?.events || [])].reverse().find((event) => event.event_type === "signed");
  if (!signedEvent?.event_note) return null;
  try {
    const parsed = JSON.parse(signedEvent.event_note);
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

function proposalApprovalLabel(document) {
  const events = Array.isArray(document?.events) ? document.events : [];
  const latestEvent = [...events].reverse().find((event) => event?.event_type);
  if (document?.status === "completed" || latestEvent?.event_type === "signed") return "Agreement Signed";
  if (document?.proposal_approved || latestEvent?.event_type === "proposal_approved") return "Agreement Unlocked";
  if (latestEvent?.event_type === "viewed" || document?.status === "viewed") return "Proposal Viewed";
  return "Proposal Sent";
}

function proposalViewerModal() {
  const viewer = state.proposalViewer;
  if (!viewer) return "";
  const isDraft = viewer === "draft" || viewer?.type === "draft";
  const documentId = isDraft ? "" : (viewer?.documentId || viewer);
  const proposalDocument = isDraft
    ? null
    : state.signatureDocuments.find((document) => document.id === documentId);
  if (!isDraft && !proposalDocument) return "";

  const details = isDraft
    ? state.signatureDraft || {}
    : parseAgreementDetailsFromSnapshot(proposalDocument.agreement || {}, { document: proposalDocument });
  const title = isDraft
    ? "Proposal preview"
    : (proposalDocument.title || "Accessibility Services Proposal");
  const proposalUrl = proposalDocument
    ? (proposalDocument.recipients || []).find((recipient) => recipient.signing_url)?.signing_url || ""
    : "";

  return `
    <div class="proposal-viewer-backdrop" data-proposal-viewer-backdrop>
      <section class="proposal-viewer-modal" role="dialog" aria-modal="true" aria-labelledby="proposal-viewer-title">
        <header class="proposal-viewer-header">
          <div>
            <p class="section-label">${isDraft ? "Generated proposal" : proposalDocument?.proposal_approved ? "Agreement" : "Sent proposal"}</p>
            <h2 id="proposal-viewer-title">${escapeHtml(title)}</h2>
            ${proposalDocument ? `<p class="helper">${escapeHtml(proposalApprovalLabel(proposalDocument))}</p>` : ""}
          </div>
          <div class="proposal-viewer-actions">
            ${proposalUrl ? `<a class="secondary signature-document-link" href="${escapeHtml(proposalUrl)}" target="_blank" rel="noopener noreferrer">Open client view</a>` : ""}
            <button class="proposal-viewer-close" type="button" aria-label="Close proposal preview" data-close-proposal-view>×</button>
          </div>
        </header>
        <div class="proposal-viewer-document" data-proposal-viewer-document>
          ${renderAgreementTerms(details)}
        </div>
      </section>
    </div>
  `;
}

function signatureDocumentCard(document) {
  const request = state.requests.find((item) => item.id === document.request_id);
  const proposalApproved = Boolean(document.proposal_approved);
  const proposalUrl = (document.recipients || []).find((recipient) => recipient.signing_url)?.signing_url || "";
  return `
    <article class="signature-document-item signature-document-detail-card">
      <div class="signature-document-header">
        <span>
          <strong>${escapeHtml(document.title || "Agreement")}</strong>
          <small>${escapeHtml(request ? `${displayRequestNumber(request)} · ${request.title}` : "Request agreement")}</small>
          <small>Proposal</small>
        </span>
        <span class="signature-document-actions">
            <span class="status-pill proposal-status-text">${escapeHtml(proposalApprovalLabel(document))}</span>
            ${(proposalUrl || document.agreement) ? `<button class="secondary signature-document-link proposal-status-text" type="button" data-open-proposal-view="${escapeHtml(document.id)}">Open</button>` : ""}
        </span>
      </div>
      <div class="signature-document-detail-grid">
        <div>
          <p class="section-label">Recipients</p>
          ${signatureRecipientRows(document)}
        </div>
        <div>
          <p class="section-label">Activity</p>
          <div class="signature-event-list">${signatureEventRows(document)}</div>
        </div>
      </div>
    </article>
  `;
}

function sentProposalFileRow(document) {
  const request = state.requests.find((item) => item.id === document.request_id);
  const lastModified = document.updated_at || document.sent_at || document.created_at;
  return `
    <button
      class="sent-proposal-file-row"
      type="button"
      data-open-proposal-view="${document.id}"
    >
      <span class="sent-proposal-file-name">
        <strong>${escapeHtml(document.title || "Accessibility Services Proposal")}</strong>
        ${request ? `<small>${escapeHtml(displayRequestNumber(request))} · ${escapeHtml(request.title)}</small>` : ""}
        <small class="sent-proposal-file-date">Last modified: ${escapeHtml(formatDate(lastModified))}</small>
      </span>
      <span class="sent-proposal-file-meta">
        <span class="status-pill proposal-status-text">${escapeHtml(proposalApprovalLabel(document))}</span>
        <span class="sent-proposal-file-view proposal-status-text">Open</span>
      </span>
    </button>
  `;
}

function sentProposalsCard(documents) {
  return `
    <section class="card sent-proposals-card">
      <div class="section-heading-row">
        <p class="section-label sent-proposals-title">Sent Proposals</p>
      </div>
      <p class="helper">Select a proposal file name to open the full proposal screen.</p>
      <div class="sent-proposals-dropdown" role="list">
        ${documents.map((document) => sentProposalFileRow(document)).join("") || `<p class="helper">No proposals have been sent yet.</p>`}
      </div>
    </section>
  `;
}

function requestSignatureDocumentsCard(request) {
  const documents = documentsForRequest(request?.id);
  return `
    <section class="card request-documents-card">
      <div class="section-heading-row">
        <p class="section-label">Proposals</p>
      </div>
      <div class="request-documents-scroll">
        ${documents.map((document) => `
          <button class="signature-document-row" type="button" data-open-proposal-view="${document.id}">
            <span>
              <strong>${escapeHtml(document.title || "Agreement")}</strong>
              <small>Proposal</small>
            </span>
            <span class="signature-document-row-actions">
              <span class="status-pill proposal-status-text">${escapeHtml(proposalApprovalLabel(document))}</span>
              <span class="signature-document-row-view proposal-status-text">Open</span>
            </span>
          </button>
        `).join("") || `<p class="helper">No proposals have been sent for this request yet.</p>`}
      </div>
    </section>
  `;
}

function signatureRecipientDefaults(request) {
  const client = state.clients.find((item) => item.id === request?.client_id);
  const primary = client?.primary_contact_email
    ? [{ name: client.primary_contact_name || "Primary Contact", email: client.primary_contact_email, role: "signer" }]
    : [];
  const ccContacts = clientContactsForRequest(request?.id)
    .map((contact) => ({ name: contact.name || contact.email, email: contact.email, role: "signer" }));
  return [...primary, ...ccContacts].filter((recipient) => recipient.email).slice(0, 1);
}

function todayIsoDate() {
  return new Date().toISOString().slice(0, 10);
}

const DEFAULT_AGREEMENT_TOTAL_COST = "$2,550";

function cleanAgreementText(value) {
  return String(value || "").trim();
}

function defaultAgreementServicesText(wcagStandard = "WCAG 2.2 AA", timeline = "2-week timeline") {
  return `Desktop + Mobile Audit
• ${wcagStandard} standard
• Scope defined below
• ${timeline}
Price: $1,450

Technical Support
• 5 hours
• $150/hour
• Issue Validation
• Technical Questions
Price: $750

VPAT Service
• WCAG Edition — Accessibility Conformance Report
• Issued after validation
Price: $350`;
}

function defaultAgreementScopeText(projectName = "the selected digital asset", wcagStandard = "WCAG 2.2 AA") {
  return `Digital asset / project: ${projectName}
Accessibility standard: ${wcagStandard}
Desktop audit environment: NVDA screen reader, Google Chrome, PC desktop, Windows 11
Mobile audit environment: VoiceOver screen reader, Safari, iPhone, iOS
Evaluation methods include screen reader testing, keyboard-only interaction, code inspection, visual inspection, browser zoom review, color contrast analysis, and AXE automated scan as a secondary review.
Scope excludes documents, third-party portals, subdomains, websites, pages, screens, properties, platforms, or assets not named in this Agreement.`;
}

function defaultAgreementDeliverablesText() {
  return `Excel audit report with issue descriptions, URL locations, element locations, testing environment, WCAG success criteria, related code, visual documentation, remediation recommendations, and notes.
Administrative audit support so Client can understand and use the audit report.
Technical support for audit questions, remediation questions, issue validation, and related digital accessibility questions.
Accessibility Conformance Report (VPAT / ACR) when the VPAT service is included.`;
}

function defaultAgreementCostBreakdownText() {
  return `Desktop + Mobile Audit: $1,450
Technical Support: $750
VPAT Service: $350`;
}

function formatAgreementCurrency(value) {
  const digits = String(value || "").replace(/[^\d]/g, "");
  if (!digits) return "";
  return `$${Number(digits).toLocaleString("en-US")}`;
}

function moneyFromText(value) {
  const text = String(value || "");
  const currencyMatches = [...text.matchAll(/[$£€]\s*([\d,]+(?:\.\d+)?)/g)];
  if (currencyMatches.length) return formatAgreementCurrency(currencyMatches[currencyMatches.length - 1][1]);

  // A plain amount is valid input too, but WCAG versions and durations are not prices.
  const numbers = [...text.matchAll(/\b(\d[\d,]*(?:\.\d+)?)\b/g)]
    .map((match) => ({ value: match[1], index: match.index || 0 }))
    .filter(({ value, index }) => {
      const before = text.slice(Math.max(0, index - 10), index);
      const after = text.slice(index + value.length, index + value.length + 12);
      return !/^2\.[12]$/.test(value) && !/wcag\s*$/i.test(before) && !/^\s*(?:days?|weeks?|months?|hours?|hrs?|horus)\b/i.test(after);
    });
  return numbers.length ? formatAgreementCurrency(numbers[numbers.length - 1].value) : "";
}

function lastMoneyFromText(value) {
  const matches = [...String(value || "").matchAll(/\$?\s*([\d,]+(?:\.\d+)?)/g)];
  return matches.length ? formatAgreementCurrency(matches[matches.length - 1][1]) : "";
}

function parseAgreementNotes(notes, request) {
  const raw = cleanAgreementText(notes);
  if (!raw) return null;

  const defaults = agreementDefaultsForRequest(request);
  const lines = raw.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const normalized = raw.replace(/\s+/g, " ");
  const urls = [...new Set((raw.match(/https?:\/\/[^\s)]+/g) || []).map((url) => url.replace(/[.,;]+$/, "")))];
  const wcagStandard = normalized.match(/WCAG\s*2\.[12]\s*AA/i)?.[0].replace(/\s+/g, " ").toUpperCase().replace("WCAG 2.", "WCAG 2.") || defaults.wcagStandard;
  const totalCost = formatAgreementCurrency(normalized.match(/total\s+cost\s*:?\s*\$?\s*([\d,]+)/i)?.[1]) || defaults.totalCost;

  const timelineMatch = normalized.match(/(\d+)\s*[- ]?(?:day|business day|week|month)s?/i);
  const expeditedLine = lines.find((line) => /expedited/i.test(line)) || "";
  const expeditedDays = expeditedLine.match(/(\d+)\s*[- ]?(?:day|business day)s?/i)?.[1] || "";
  const timeline = timelineMatch?.[0] || defaults.timeline;
  const vpatLine = lines.find((line) => /vpat/i.test(line)) || "";
  const vpatEdition = vpatLine.match(/\b([A-Za-z]+)\s+Edition\b/i)?.[1];
  const vpatEditionLabel = vpatEdition ? `${vpatEdition.toUpperCase()} Edition` : "WCAG Edition";

  // Treat the assistant message as a lightweight proposal outline. Phase headings
  // are carried onto each service, while service-specific lines remain bullets.
  const serviceTitleFor = (line) => {
    if (/technical\s+support|support\s+horus|support\s+hours/i.test(line)) return "Technical Support";
    if (/user\s+testing/i.test(line)) return "User Testing";
    if (/vpat/i.test(line)) return "VPAT Service";
    if (/expedited/i.test(line)) return "Expedited Service";
    if (/document\s+remediation/i.test(line)) return "Document Remediation";
    if (/certification/i.test(line)) return "Certification";
    if (/audit/i.test(line)) return /mobile/i.test(line) ? "Desktop + Mobile Audit" : "Accessibility Audit";
    return "";
  };
  const defaultServiceBullets = (entry) => {
    if (entry.baseTitle === "Desktop + Mobile Audit" || entry.baseTitle === "Accessibility Audit") {
      return [`${wcagStandard} standard`, "Scope defined below", timeline];
    }
    if (entry.baseTitle === "User Testing") {
      return ["1 session", "30-minute recorded session", "Takes place after remediation and validation", "Session recording and supplemental report provided"];
    }
    if (entry.baseTitle === "Technical Support") {
      return [entry.hours ? `${entry.hours} hours` : "Support hours as requested", "Issue Validation", "Technical Questions"];
    }
    if (entry.baseTitle === "VPAT Service") {
      return [`${entry.editionLabel || vpatEditionLabel} — Accessibility Conformance Report`, "Issued after validation"];
    }
    if (entry.baseTitle === "Expedited Service") return [entry.days ? `${entry.days} days` : "Rush delivery" ];
    return [];
  };
  const entries = [];
  let currentPhase = "";
  let currentEntry = null;
  let inScope = false;
  const flushEntry = () => {
    if (!currentEntry) return;
    if (!currentEntry.bullets.length) currentEntry.bullets = defaultServiceBullets(currentEntry);
    entries.push(currentEntry);
    currentEntry = null;
  };

  lines.forEach((rawLine) => {
    const line = rawLine.replace(/^(?:[-•*]|\d+[.)])\s*/, "").trim();
    const phaseMatch = line.match(/^phase\s*(\d+)\s*:?(?:\s*.*)?$/i);
    if (phaseMatch) {
      flushEntry();
      currentPhase = phaseMatch[1];
      inScope = false;
      return;
    }
    if (/^scope\s*:?$/i.test(line)) {
      flushEntry();
      inScope = true;
      return;
    }
    if (/^(?:cost\s+breakdown|total\s+cost)\s*:?/i.test(line)) {
      inScope = false;
      return;
    }
    if (inScope) return;

    const baseTitle = serviceTitleFor(line);
    const hasServicePrice = Boolean(moneyFromText(line));
    const beginsAsService = /^(?:desktop|accessibility|wcag|technical|support|user|vpat|expedited|document|certification)/i.test(line);
    if (baseTitle && (hasServicePrice || beginsAsService)) {
      flushEntry();
      const hours = line.match(/(\d+)\s*(?:hours?|hrs?|horus)/i)?.[1] || "";
      const days = line.match(/(\d+)\s*[- ]?(?:day|business day)s?/i)?.[1] || "";
      const edition = line.match(/\b([A-Za-z]+)\s+Edition\b/i)?.[1];
      currentEntry = {
        baseTitle,
        title: `${baseTitle}${currentPhase ? ` (Phase ${currentPhase})` : ""}`,
        price: moneyFromText(line),
        hours,
        days,
        editionLabel: edition ? `${edition.toUpperCase()} Edition` : "",
        bullets: []
      };
      return;
    }

    if (!currentEntry) return;
    if (/^price\s*:/i.test(line)) {
      currentEntry.price = moneyFromText(line) || currentEntry.price;
      return;
    }
    if (/^total\s+cost\s*:/i.test(line)) return;
    if (line) currentEntry.bullets.push(line);
  });
  flushEntry();

  if (!entries.length) {
    entries.push({
      baseTitle: /mobile/i.test(normalized) ? "Desktop + Mobile Audit" : "Accessibility Audit",
      title: /mobile/i.test(normalized) ? "Desktop + Mobile Audit" : "Accessibility Audit",
      price: "$1,450",
      hours: "",
      days: "",
      editionLabel: "",
      bullets: []
    });
    entries[0].bullets = defaultServiceBullets(entries[0]);
  }

  const services = [];
  const costBreakdown = [];
  entries.forEach((entry, index) => {
    if (index) services.push("");
    services.push(entry.title);
    entry.bullets.forEach((bullet) => services.push(`• ${bullet}`));
    if (entry.price) services.push(`Price: ${entry.price}`);
    if (entry.price) costBreakdown.push(`${entry.title}: ${entry.price}`);
  });

  return {
    wcagStandard,
    timeline,
    totalCost,
    servicesText: services.join("\n"),
    scopeText: urls.length ? urls.join("\n") : defaults.scopeText,
    deliverablesText: [
      "Audit Report",
      ...(entries.some((entry) => entry.baseTitle === "VPAT Service") ? [`Accessibility Conformance Report (${vpatEditionLabel})`] : []),
      ...(entries.some((entry) => entry.baseTitle === "Expedited Service") ? ["Expedited service delivery"] : [])
    ].join("\n"),
    costBreakdownText: costBreakdown.join("\n")
  };
}

function agreementDefaultsForRequest(request) {
  const client = state.clients.find((item) => item.id === request?.client_id);
  const clientDisplayName = client?.name || clientName(request?.client_id) || "Client";
  const serviceName = request?.service_type || request?.title || "Accessibility Services";
  const projectName = request?.title || request?.description || "the selected digital asset";
  const wcagStandard = "WCAG 2.2 AA";
  const timeline = "2-week timeline";
  return {
    agreementDate: todayIsoDate(),
    clientLegalName: clientDisplayName,
    projectName,
    wcagStandard,
    timeline,
    totalCost: DEFAULT_AGREEMENT_TOTAL_COST,
    projectOverview: `Accessible.org will provide ${serviceName} for ${clientDisplayName} for ${projectName}. Project completion is governed by the Project Completion section below.`,
    servicesText: defaultAgreementServicesText(wcagStandard, timeline),
    scopeText: defaultAgreementScopeText(projectName, wcagStandard),
    deliverablesText: defaultAgreementDeliverablesText(),
    costBreakdownText: defaultAgreementCostBreakdownText(),
    trackerRequirement: "required-if-validation",
    validationIncluded: "yes",
    technicalSupportIncluded: "no",
    vpatIncluded: "no"
  };
}

function agreementDraftValue(name, request) {
  const defaults = agreementDefaultsForRequest(request);
  const value = state.signatureDraft?.[name];
  return value !== undefined && value !== null && String(value) !== "" ? value : defaults[name] || "";
}

function agreementDetailsFromFormData(formData, request) {
  const defaults = agreementDefaultsForRequest(request);
  const textValue = (name) => String(formData.get(name) || defaults[name] || "").trim();
  return {
    kind: "accessible_terms_v1",
    agreementDate: textValue("agreementDate"),
    clientLegalName: textValue("clientLegalName"),
    projectName: textValue("projectName"),
    wcagStandard: textValue("wcagStandard"),
    timeline: textValue("timeline"),
    totalCost: textValue("totalCost"),
    agreementIntro: textValue("agreementIntro"),
    projectOverview: textValue("projectOverview"),
    servicesText: textValue("servicesText"),
    scopeText: textValue("scopeText"),
    deliverablesText: textValue("deliverablesText"),
    costBreakdownText: textValue("costBreakdownText"),
    trackerRequirement: textValue("trackerRequirement"),
    validationIncluded: textValue("validationIncluded"),
    technicalSupportIncluded: textValue("technicalSupportIncluded"),
    vpatIncluded: textValue("vpatIncluded")
  };
}

function signatureDraftFromForm(form) {
  const formData = new FormData(form);
  const names = formData.getAll("recipientName").map(String);
  const emails = formData.getAll("recipientEmail").map(String);
  const requestId = String(formData.get("requestId") || "");
  const request = state.requests.find((item) => item.id === requestId);
  const agreementDetails = agreementDetailsFromFormData(formData, request);
  const hasComposer = formData.has("proposalPrompt");
  const composerValue = hasComposer ? String(formData.get("proposalPrompt") || "") : "";
  const promptValue = composerValue.trim() || String(formData.get("agreementPrompt") || "").trim();

  state.signatureDraft = {
    clientId: String(formData.get("clientId") || ""),
    requestId,
    title: String(formData.get("title") || ""),
    documentPurpose: String(formData.get("documentPurpose") || "signature"),
    agreementPrompt: promptValue || state.signatureDraft?.agreementPrompt || "",
    proposalComposerDraft: hasComposer ? composerValue : (state.signatureDraft?.proposalComposerDraft || ""),
    proposalGenerated: Boolean(state.signatureDraft?.proposalGenerated),
    proposalMessages: Array.isArray(state.signatureDraft?.proposalMessages) ? state.signatureDraft.proposalMessages : [],
    ...agreementDetails,
    recipients: names.map((name, index) => ({
      name,
      email: emails[index] || "",
      role: "signer"
    }))
  };
}

function mergeProposalMessage(currentDraft, parsedDetails, notes, request) {
  if (!currentDraft?.proposalGenerated) return parsedDetails;

  const normalized = cleanAgreementText(notes);
  const next = { ...currentDraft };
  const mentions = (pattern) => pattern.test(normalized);

  if (mentions(/total\s+cost|total\s+price|overall\s+(?:cost|price)/i)) next.totalCost = parsedDetails.totalCost;
  if (mentions(/timeline|turnaround|\b(?:day|days|week|weeks|month|months)\b/i)) next.timeline = parsedDetails.timeline;
  if (mentions(/wcag\s*2\.[12]/i)) next.wcagStandard = parsedDetails.wcagStandard;
  if (mentions(/scope|url|https?:\/\//i)) next.scopeText = parsedDetails.scopeText;
  if (mentions(/deliverable/i)) next.deliverablesText = parsedDetails.deliverablesText;

  // A message that contains service/pricing details is treated as a replacement
  // for the editable services block. A cost-only message changes only Total Cost.
  if (mentions(/audit|technical\s+support|support\s+hours?|vpat|expedited|price\s*:/i)) {
    next.servicesText = parsedDetails.servicesText;
    next.costBreakdownText = parsedDetails.costBreakdownText || next.costBreakdownText;
  }

  if (mentions(/client\s+(?:name|is)|project\s+(?:name|is)|asset\s+(?:name|is)/i)) {
    const clientMatch = normalized.match(/client\s+(?:name|is)\s*[:=-]?\s*([^,.;\n]+)/i);
    const projectMatch = normalized.match(/(?:project|asset)\s+(?:name|is)\s*[:=-]?\s*([^,.;\n]+)/i);
    if (clientMatch?.[1]) next.clientLegalName = clientMatch[1].trim();
    if (projectMatch?.[1]) next.projectName = projectMatch[1].trim();
  }

  return next;
}

function setSignatureDraftRecipientsForRequest(request) {
  const defaults = signatureRecipientDefaults(request);
  state.signatureDraft = {
    ...state.signatureDraft,
    clientId: request?.client_id || state.signatureDraft.clientId || "",
    requestId: request?.id || "",
    recipients: defaults.length ? defaults : [{ name: "", email: "", role: "signer" }]
  };
}

function signatureRecipientInputs(request) {
  const draftRecipients = Array.isArray(state.signatureDraft.recipients) ? state.signatureDraft.recipients : [];
  const defaults = draftRecipients.length ? draftRecipients : signatureRecipientDefaults(request);
  const rows = (defaults.length ? defaults : [{ name: "", email: "", role: "signer" }]).slice(0, 1);
  return rows.map((recipient) => `
    <div class="signature-recipient-row">
      <label class="field"><span>Recipient Name</span><input name="recipientName" value="${escapeHtml(recipient.name || "")}" /></label>
      <label class="field"><span>Email</span><input name="recipientEmail" type="email" value="${escapeHtml(recipient.email || "")}" /></label>
      <button class="secondary recipient-remove-button" type="button" data-remove-signature-recipient>Remove Recipient</button>
    </div>
  `).join("");
}

function agreementParameterInputs(request) {
  return `
    <p class="section-label">Terms Parameters</p>
    <p class="helper">These fields generate the Terms page. The legal boilerplate stays common; these values are injected into the agreement.</p>
    <section class="agreement-ai-box">
      <label class="field"><span>Paste agreement notes</span><textarea name="agreementPrompt" rows="8" placeholder="$1,450 for a WCAG 2.1 AA desktop + mobile audit&#10;Technical support hours: 5 total cost 750&#10;Expedited service: 3 days 350&#10;VPAT service: 950 INT Edition&#10;total cost: 3600&#10;&#10;scope&#10;https://example.com/page">${escapeHtml(state.signatureDraft?.agreementPrompt || "")}</textarea></label>
      <button class="secondary" type="button" data-generate-agreement-terms>Generate Terms from Notes</button>
      <p class="helper">This fills the editable fields below. You can review and change anything before sending.</p>
    </section>
    <div class="form-grid">
      <label class="field"><span>Agreement Date</span><input name="agreementDate" type="date" value="${escapeHtml(agreementDraftValue("agreementDate", request))}" /></label>
      <label class="field"><span>Client Legal Name</span><input name="clientLegalName" value="${escapeHtml(agreementDraftValue("clientLegalName", request))}" /></label>
      <label class="field"><span>Project / Asset Name</span><input name="projectName" value="${escapeHtml(agreementDraftValue("projectName", request))}" /></label>
      <label class="field"><span>WCAG Standard</span>
        <select name="wcagStandard">
          ${["WCAG 2.1 AA", "WCAG 2.2 AA"].map((option) => `<option value="${option}" ${agreementDraftValue("wcagStandard", request) === option ? "selected" : ""}>${option}</option>`).join("")}
        </select>
      </label>
      <label class="field"><span>Timeline</span><input name="timeline" value="${escapeHtml(agreementDraftValue("timeline", request))}" /></label>
      <label class="field"><span>Total Cost</span><input name="totalCost" placeholder="$2,550" value="${escapeHtml(agreementDraftValue("totalCost", request))}" /></label>
      <label class="field"><span>Tracker Requirement</span>
        <select name="trackerRequirement">
          <option value="required-if-validation" ${agreementDraftValue("trackerRequirement", request) !== "not-required" ? "selected" : ""}>Required only if validation is needed</option>
          <option value="not-required" ${agreementDraftValue("trackerRequirement", request) === "not-required" ? "selected" : ""}>Not required</option>
        </select>
      </label>
      <label class="field"><span>Validation Included</span>
        <select name="validationIncluded">
          <option value="yes" ${agreementDraftValue("validationIncluded", request) !== "no" ? "selected" : ""}>Yes</option>
          <option value="no" ${agreementDraftValue("validationIncluded", request) === "no" ? "selected" : ""}>No</option>
        </select>
      </label>
    </div>
    <label class="field"><span>Services block shown under Project Overview</span><textarea name="servicesText" rows="10">${escapeHtml(agreementDraftValue("servicesText", request))}</textarea></label>
    <label class="field"><span>Project Scope</span><textarea name="scopeText" rows="6">${escapeHtml(agreementDraftValue("scopeText", request))}</textarea></label>
    <label class="field"><span>Deliverables</span><textarea name="deliverablesText" rows="4">${escapeHtml(agreementDraftValue("deliverablesText", request))}</textarea></label>
    <label class="field"><span>Cost Breakdown</span><textarea name="costBreakdownText" rows="4">${escapeHtml(agreementDraftValue("costBreakdownText", request))}</textarea></label>
  `;
}

function proposalHiddenFields(request) {
  const names = [
    "agreementDate",
    "clientLegalName",
    "projectName",
    "wcagStandard",
    "timeline",
    "totalCost",
    "agreementIntro",
    "projectOverview",
    "servicesText",
    "scopeText",
    "deliverablesText",
    "costBreakdownText",
    "trackerRequirement",
    "validationIncluded",
    "technicalSupportIncluded",
    "vpatIncluded"
  ];
  return names.map((name) => `<input type="hidden" name="${name}" value="${escapeHtml(agreementDraftValue(name, request))}" />`).join("");
}

function proposalBuilderPreview(request) {
  const draft = state.signatureDraft || {};
  if (!draft.proposalGenerated) {
    return `
      <section class="proposal-builder-empty">
        <span class="proposal-builder-empty-icon" aria-hidden="true">✦</span>
        <div>
          <strong>Your proposal preview will appear here</strong>
          <p>Paste the scope, services, pricing, and URLs in the conversation. The builder will turn it into the client-facing proposal format.</p>
        </div>
      </section>
    `;
  }

  return `
    <section class="proposal-builder-preview">
      <div class="proposal-builder-preview-header">
        <div>
          <p class="section-label">Generated proposal</p>
          <h2>Accessibility Services Agreement</h2>
        </div>
        <div class="proposal-builder-preview-actions">
          <span class="status-pill success">Ready to send</span>
          <button class="secondary" type="button" data-open-proposal-view="draft">View proposal</button>
        </div>
      </div>
      <div class="proposal-builder-preview-document" data-proposal-preview-document>
        <div data-proposal-preview-output>${renderAgreementTerms(draft, { editable: true })}</div>
      </div>
    </section>
  `;
}

function proposalBuilderChat(request) {
  const draft = state.signatureDraft || {};
  const messages = Array.isArray(draft.proposalMessages) ? draft.proposalMessages : [];
  const composerDraft = draft.proposalComposerDraft || "";
  return `
    <section class="proposal-builder-chat">
      <div class="proposal-chat-header">
        <div class="proposal-chat-avatar" aria-hidden="true">✦</div>
        <div>
          <strong>Proposal assistant</strong>
          <p>Describe the work in plain language. I’ll organize it into the proposal layout.</p>
        </div>
      </div>
      <div class="proposal-chat-messages" aria-live="polite">
        <div class="proposal-chat-message assistant">Tell me the client, scope, services, prices, timeline, and any URLs that should appear in the proposal.</div>
        ${messages.map((message) => `<div class="proposal-chat-message ${message.role === "user" ? "user" : "assistant"}">${formatMessageText(message.text || "")}</div>`).join("")}
      </div>
      <label class="field proposal-chat-input">
        <span>Message the proposal assistant</span>
        <textarea name="proposalPrompt" rows="10" placeholder="Example:\n$1,700 for a WCAG 2.1 AA desktop + mobile audit\nUser Testing: $450\nVPAT Service: $350\nTechnical Support: $450 (3 hours)\nTotal Cost: $2,950\n\nScope:\nhttps://example.com/signin\nhttps://example.com/assistant">${escapeHtml(composerDraft)}</textarea>
      </label>
      <button class="secondary" type="button" data-send-proposal-message>Send message</button>
      <p class="helper">Send details or a correction such as “change the total cost to $900”. The assistant updates the preview after each message.</p>
    </section>
  `;
}

function clientOptionsForDocuments() {
  const clientIds = [...new Set(state.requests.map((request) => request.client_id).filter(Boolean))];
  const clients = state.clients.filter((client) => clientIds.includes(client.id));
  return clients.length
    ? clients
    : clientIds.map((clientId) => ({ id: clientId, name: clientName(clientId) }));
}

function requestsForClient(clientId) {
  return state.requests.filter((request) => request.client_id === clientId);
}

function signatureDocumentsPage() {
  if (!isInternal()) {
    return `
      <section class="page">
        <h1>Proposals</h1>
        <p class="subtitle">Proposals are attached to each request. Open a request to view proposal approval and signing status.</p>
        ${clientRequestCards(state.requests)}
      </section>
    `;
  }

  const clients = clientOptionsForDocuments();
  const draft = state.signatureDraft || {};
  const initialClientId = draft.clientId || state.signatureClientSelection || "";
  const clientRequests = requestsForClient(initialClientId);
  const selectedRequest = clientRequests.find((request) => request.id === draft.requestId) || null;

  return `
    <section class="${isInternal() ? "admin-page" : "page"}">
      <h1>Proposals</h1>
      <p class="subtitle">Build a client-facing proposal from a short conversation. The client approves it before signing is unlocked.</p>
      ${isInternal() ? `
        <form class="proposal-builder" id="signatureDocumentForm">
          <div class="proposal-builder-selection">
          <div class="form-grid">
            <label class="field"><span>Client</span>
              <select name="clientId" data-signature-client-select required>
                <option value="">Select Client</option>
                ${clients.map((client) => `<option value="${client.id}" ${client.id === initialClientId ? "selected" : ""}>${escapeHtml(client.name)}</option>`).join("")}
              </select>
            </label>
            <label class="field"><span>Request</span>
              <select name="requestId" data-signature-request-select required ${initialClientId ? "" : "disabled"}>
                <option value="">Select Request</option>
                ${clientRequests.map((request) => `<option value="${request.id}" ${request.id === selectedRequest?.id ? "selected" : ""}>${escapeHtml(displayRequestNumber(request))} · ${escapeHtml(request.title)}</option>`).join("")}
              </select>
            </label>
          </div>
          <input type="hidden" name="title" value="${escapeHtml(draft.title || "Accessibility Services Proposal")}" />
          <input type="hidden" name="documentPurpose" value="signature" />
          ${proposalHiddenFields(selectedRequest)}
          </div>
          ${proposalBuilderChat(selectedRequest)}
          ${proposalBuilderPreview(selectedRequest)}
          <section class="proposal-recipient-box">
            <p class="section-label send-to-title">Send to</p>
            <p class="helper">The client contact below will receive a private proposal link.</p>
            <div data-signature-recipient-list>${signatureRecipientInputs(selectedRequest)}</div>
          </section>
          <div class="signature-form-actions">
            <button class="primary" type="submit" ${draft.proposalGenerated ? "" : "disabled"}>Send proposal</button>
          </div>
          <p class="helper">Signing is locked for the client until they approve the proposal.</p>
        </form>
      ` : ""}
      ${sentProposalsCard(state.signatureDocuments)}
    </section>
  `;
}

function historyPage() {
  return `
    <section class="page">
      <h1>Request History</h1>
      ${clientRequestCards(state.history)}
    </section>
  `;
}

function clientRequestCards(requests) {
  return requests.map((request) => `
    <section class="card history-card clickable-row" data-client-open-request="${request.id}">
      <h2>${escapeHtml(request.title)} ${requestUnreadBadge(request.id)}</h2>
      <p>${escapeHtml(request.description || "Request linked to this client account.")}</p>
      <div class="deliverable-row request-card-meta">
        <span>${escapeHtml(displayRequestNumber(request))} · ${escapeHtml(request.service_type || "Accessibility Service")}</span>
        <span class="request-card-status">
          <time>${formatDate(request.due_date || request.closed_at || request.created_at)}</time>
          <span class="status-pill">${statusLabel(request.status)}</span>
        </span>
      </div>
      <p class="assigned-line">Team: ${escapeHtml(assignedPeopleText(request.id))}</p>
    </section>
  `).join("") || emptyCard("No Requests Yet", "Requests linked to this client account will appear here.");
}

function accountPage() {
  const client = state.profile?.clients;
  return `
    <section class="page">
      <h1>Account</h1>
      <section class="card">
        <p class="section-label">Organization</p>
        ${accountRow("Organization", client?.name)}
        ${accountRow("Primary Contact", client?.primary_contact_name || state.profile?.full_name)}
        ${accountRow("Email", client?.primary_contact_email || state.profile?.email)}
        ${accountRow("Billing Email", client?.billing_email)}
        ${accountRow("Client Since", formatDate(client?.created_at))}
        <p class="card-note">To change any of these, send a note in <a href="#" data-jump="messages">Messages</a>.</p>
      </section>
      <section class="card">
        <p class="section-label">Sign In</p>
        <p>You are signed in as ${escapeHtml(state.profile?.email || "")} on this device.</p>
        <button class="primary" id="signOut">Sign Out</button>
      </section>
      ${passwordSection("Password")}
    </section>
  `;
}

function passwordSection(title) {
  const mustChange = Boolean(state.profile?.must_change_password);
  const showForm = mustChange || state.showPasswordForm;
  return `
    <section class="card">
      <p class="section-label">${escapeHtml(title)}</p>
      <p class="helper">
        ${mustChange
          ? "Your account is using a temporary password. Please set a new password to continue."
          : `Signed in as ${escapeHtml(state.profile?.email || "")}.`}
      </p>
      ${showForm ? `
        <form class="password-form" id="passwordForm">
          <label class="field">
            <span>New Password</span>
            <input name="password" type="password" autocomplete="new-password" minlength="8" required />
          </label>
          <label class="field">
            <span>Confirm Password</span>
            <input name="confirmPassword" type="password" autocomplete="new-password" minlength="8" required />
          </label>
          <label class="password-toggle">
            <input type="checkbox" data-toggle-password="password,confirmPassword" />
            <span>Show Password</span>
          </label>
          <div class="form-actions">
            <button class="primary" type="submit">Update Password</button>
            ${mustChange ? "" : `<button class="primary" type="button" data-action="cancel-password-change">Cancel</button>`}
          </div>
        </form>
      ` : `
        <button class="primary" type="button" data-action="show-password-change">Update Password</button>
      `}
    </section>
  `;
}

function accountRow(label, value) {
  return `<div class="account-row"><span>${label}</span><strong>${escapeHtml(value || "-")}</strong></div>`;
}

function emptyMessage() {
  return `<article class="message-card team"><p>No Messages Yet. Start the conversation below.</p></article>`;
}

function emptyCard(title, body) {
  return `<section class="card"><h1>${title}</h1><p>${body}</p></section>`;
}

function toastHtml() {
  return `<div class="toast ${state.toast ? "show" : ""}" role="status" aria-live="polite">${escapeHtml(state.toast)}</div>`;
}

function downloadIcon() {
  return `<svg width="20" height="20" viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M5 20h14v-2H5v2Zm7-16v9.17l3.59-3.58L17 11l-6 6-6-6 1.41-1.41L10 13.17V4h2Z"/></svg>`;
}

function parseAgreementDetailsFromSnapshot(agreement, payload) {
  const text = String(agreement?.agreementText || "").trim();
  if (text) {
    try {
      const parsed = JSON.parse(text);
      if (parsed?.kind === "accessible_terms_v1") return parsed;
    } catch {
      return {
        kind: "legacy_text",
        agreementDate: todayIsoDate(),
        clientLegalName: "Client",
        projectName: agreement?.title || payload?.document?.title || "the selected digital asset",
        projectOverview: text,
        servicesText: defaultAgreementServicesText(),
        scopeText: defaultAgreementScopeText(agreement?.title || payload?.document?.title || "the selected digital asset"),
        deliverablesText: defaultAgreementDeliverablesText(),
        costBreakdownText: defaultAgreementCostBreakdownText(),
        totalCost: DEFAULT_AGREEMENT_TOTAL_COST,
        timeline: "2-week timeline",
        wcagStandard: "WCAG 2.2 AA",
        trackerRequirement: "required-if-validation",
        validationIncluded: "yes"
      };
    }
  }
  return {
    kind: "accessible_terms_v1",
    agreementDate: todayIsoDate(),
    clientLegalName: "Client",
    projectName: agreement?.title || payload?.document?.title || "the selected digital asset",
    projectOverview: "Accessible.org will provide accessibility services for Client for the selected digital asset. Project completion is governed by the Project Completion section below.",
    servicesText: defaultAgreementServicesText(),
    scopeText: defaultAgreementScopeText(agreement?.title || payload?.document?.title || "the selected digital asset"),
    deliverablesText: defaultAgreementDeliverablesText(),
    costBreakdownText: defaultAgreementCostBreakdownText(),
    totalCost: DEFAULT_AGREEMENT_TOTAL_COST,
    timeline: "2-week timeline",
    wcagStandard: "WCAG 2.2 AA",
    trackerRequirement: "required-if-validation",
    validationIncluded: "yes"
  };
}

function multilineParagraph(value) {
  const lines = String(value || "").split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (!lines.length) return "";
  return `<p>${lines.map(escapeHtml).join("<br />")}</p>`;
}

function multilineList(value) {
  const lines = String(value || "").split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (!lines.length) return "";
  return `<ul>${lines.map((line) => `<li>${escapeHtml(line)}</li>`).join("")}</ul>`;
}

function agreementBulletList(items) {
  return `<ul>${items.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ul>`;
}

function agreementServiceBlockHtml(value) {
  const lines = String(value || "").split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const html = [];
  let bullets = [];
  const flushBullets = () => {
    if (!bullets.length) return;
    html.push(agreementBulletList(bullets));
    bullets = [];
  };

  lines.forEach((line) => {
    const bulletMatch = line.match(/^[•*-]\s*(.+)$/);
    if (bulletMatch) {
      bullets.push(bulletMatch[1]);
      return;
    }
    flushBullets();
    if (/^price\s*:/i.test(line)) {
      html.push(`<p>${escapeHtml(line)}</p>`);
    } else {
      html.push(`<h4 class="agreement-service-title">${escapeHtml(line)}</h4>`);
    }
  });

  flushBullets();
  return html.join("");
}

function proposalInlineText(value, field, editable) {
  const text = escapeHtml(value || "");
  return editable
    ? `<span class="proposal-inline-editable" contenteditable="true" data-proposal-inline-edit="${field}" role="textbox" spellcheck="true">${text}</span>`
    : text;
}

function proposalInlineBlock(html, field, editable) {
  return editable
    ? `<div class="proposal-inline-editable proposal-inline-block" contenteditable="true" data-proposal-inline-edit="${field}" role="textbox" spellcheck="true">${html}</div>`
    : html;
}

function hasOnlyOldPlaceholderText(value, projectName) {
  const text = cleanAgreementText(value).replace(/\s+/g, " ").toLowerCase();
  const project = cleanAgreementText(projectName).replace(/\s+/g, " ").toLowerCase();
  return !text
    || text === "scope to be defined by the agreement administrator."
    || text === "scope to be defined by the agreement administrator"
    || text === "accessibility services scope defined below price:"
    || text === "audit report"
    || (project && text === project && /^agreement\s+\d+$/i.test(cleanAgreementText(projectName)));
}

function renderAgreementTerms(details, { editable = false } = {}) {
  const client = details.clientLegalName || "Client";
  const project = details.projectName || "the selected digital asset";
  const wcagStandard = cleanAgreementText(details.wcagStandard) || "WCAG 2.2 AA";
  const timeline = cleanAgreementText(details.timeline) || "2-week timeline";
  const totalCost = cleanAgreementText(details.totalCost) || DEFAULT_AGREEMENT_TOTAL_COST;
  const servicesText = hasOnlyOldPlaceholderText(details.servicesText, project)
    ? defaultAgreementServicesText(wcagStandard, timeline)
    : details.servicesText;
  const scopeText = hasOnlyOldPlaceholderText(details.scopeText, project)
    ? defaultAgreementScopeText(project, wcagStandard)
    : details.scopeText;
  const deliverablesText = hasOnlyOldPlaceholderText(details.deliverablesText, project)
    ? defaultAgreementDeliverablesText()
    : details.deliverablesText;
  const costBreakdownText = cleanAgreementText(details.costBreakdownText)
    ? details.costBreakdownText
    : defaultAgreementCostBreakdownText();
  const trackerText = details.trackerRequirement === "not-required"
    ? "Accessibility Tracker is not required for this agreement unless the parties later agree otherwise in writing."
    : "Accessibility Tracker is required only if Client would like Service Provider to validate fixes. Tracker is not required for the audit or other services. If validation is needed, Client may sign up month-to-month or purchase a plan upfront through this Agreement.";
  const validationText = details.validationIncluded === "no"
    ? "Validation is not included unless later added by written Addendum."
    : "Remediation must begin within 21 days of audit report delivery, no gap in project activity may exceed 14 days, and remediation and validation must be completed within 4 months of audit report delivery. Outside these windows, a new audit is required.";
  const agreementIntroText = details.agreementIntro || `This Services Agreement is made on ${details.agreementDate || todayIsoDate()} between Accessible.org, LLC, a Texas company with its principal place of business at 770 Broadway Street Ste 104 #1126, San Antonio, Texas 78209 (“Service Provider”), and ${client} (“Client”).`;
  const projectOverviewText = details.projectOverview || `Accessible.org will provide the following accessibility services for ${client} for ${project}. Project completion is governed by the Project Completion section below.`;

  return `
    <div class="proposal-terms-content">
      <p class="agreement-intro ${editable ? "proposal-inline-editable" : ""}" ${editable ? 'contenteditable="true" data-proposal-inline-edit="agreementIntro" role="textbox" spellcheck="true"' : ""}>${escapeHtml(agreementIntroText)}</p>

      <h3>Project Overview</h3>
      ${proposalInlineBlock(multilineParagraph(projectOverviewText), "projectOverview", editable)}
      ${proposalInlineBlock(agreementServiceBlockHtml(servicesText), "servicesText", editable)}

      <h3>Key Terms</h3>
      <p>Below are key provisions of this Agreement. The full terms govern.</p>
      <h4>Total Cost</h4>
      <p>${proposalInlineText(totalCost, "totalCost", editable)}. Payment terms are set forth in the Payment Terms section.</p>
      <h4>Electronic Payment Only</h4>
      <p>All payments must be made electronically. Physical checks and third-party payment platforms are not accepted. Wire transfer or ACH is preferred for agreements with a Total Cost over $10,000.</p>
      <h4>Accessibility Tracker</h4>
      <p>${escapeHtml(trackerText)}</p>
      <h4>Scope</h4>
      <p>The scope named in this Agreement is final upon execution. Post-execution changes are addressed through Addendum and may involve additional fees.</p>
      <h4>Technical Support Hours</h4>
      <p>Technical support hours are estimated, not fixed.</p>
      <h4>Validation Windows</h4>
      <p>${escapeHtml(validationText)}</p>

      <h3>Project Timeline</h3>
      <p>Project start date is one day after payment is received by Service Provider. If access to content within scope is required and has not been provided when payment is received, the project start date is one day after Service Provider receives working access.</p>
      <p>Service Provider will deliver applicable deliverables according to the following timeline: ${proposalInlineText(timeline, "timeline", editable)}.</p>

      <h3>Communication and Project Management</h3>
      <h4>Platforms and Tools</h4>
      <p>Service Provider utilizes the following platforms for project delivery, tracking, and communication:</p>
      ${agreementBulletList([
        "Technical Support: Accessibility Tracker platform for validation and related technical questions; email and video calls for all other technical support.",
        "Virtual Meetings: Video calls for all scheduled consultation and support.",
        "Communication: Email for all non-technical project-related correspondence."
      ])}
      <h4>Accessibility Tracker</h4>
      <p>Accessibility Tracker is our accessibility project platform that enables clients to easily track and manage their project. Tracker saves time and lowers project cost by making remediation more efficient and reducing technical support hours needed for questions and validation.</p>
      <p>Tracker is required only for clients who would like Service Provider to validate fixes. Clients who do not need validation do not need Tracker. Most single digital asset projects can be completed using a Small Business Plan ($19/month, cancel anytime).</p>
      <p>Client may purchase a 1-year Accessibility Tracker plan upfront through this Agreement: $250 for 1 project, $500 for 4 projects, or $1,100 for 10 projects. If selected, the plan amount is added to the Total Cost under Project Cost.</p>
      <h4>Communication Guidelines</h4>
      <p>To ensure efficient project management across multiple clients, routine status questions and check-ins prior to established deadlines are not included in the scope of services.</p>
      <h4>Alternative Platforms</h4>
      <p>The use of additional project management or communication platforms such as Basecamp, Slack, or custom project email addresses is not included in the standard service agreement. Implementation of custom communication and platforms requires prior negotiation and may incur additional fees.</p>

      <h3>Audit Process</h3>
      <p>Service Provider conducts thorough, formal accessibility evaluations using a robust combination of environments and methodologies. Choosing the desktop + mobile option means the audit includes additional mobile environments. Additional environments can be added for a fee upon request.</p>
      <p>Audit work is measured against ${escapeHtml(wcagStandard)} unless another standard is expressly stated in this Agreement.</p>
      <h4>Desktop Environments</h4>
      ${agreementBulletList(["Assistive Technology: NVDA screen reader", "Browser: Google Chrome", "Device: PC Desktop", "Operating System: Windows 11"])}
      <h4>Mobile Environments</h4>
      ${agreementBulletList(["Assistive Technology: VoiceOver screen reader", "Browser: Safari", "Device: iPhone", "Operating System: iOS"])}
      <h4>Evaluation Methodologies</h4>
      ${agreementBulletList(["Screen reader testing", "Keyboard-only interaction", "Code inspection", "Visual inspection", "Browser zoom 200% and 400%", "Color contrast analyzer tool", "Automated accessibility scan (AXE)"])}
      <h4>Audit Report</h4>
      <p>Upon audit completion, Client will receive a detailed Excel spreadsheet report that includes the following information:</p>
      ${agreementBulletList(["Issue description", "URL location", "Specific element location", "Testing environment", "Applicable WCAG success criterion", "Related code", "Visual documentation (screenshots/clips)", "Remediation recommendations", "Additional notes"])}
      <h4>Audit Support</h4>
      <p>All audit packages include administrative support to ensure Client is able to understand and use the audit report.</p>
      <h4>Technical Support</h4>
      <p>Technical support is provided by an accessibility expert who will answer questions related to the audit, remediation, and digital accessibility. Technical support hours are billed in 15-minute increments, are non-refundable, and expire when the validation windows close.</p>
      ${agreementBulletList(["Email communication", "Video calls", "Direct access to accessibility experts"])}

      <h3>Validation</h3>
      <p>Validation is available for issues identified in Service Provider’s audit report. Validation is performed using technical support hours and tracked in Accessibility Tracker. So that audit findings remain current, the following windows apply:</p>
      ${agreementBulletList([
        "Remediation must begin within 21 days of audit report delivery, with status logged in Accessibility Tracker.",
        "No gap in project activity may exceed 14 days.",
        "Remediation and validation must be completed within 4 months of audit report delivery."
      ])}
      <p>If any window is not met, a new audit is required before Service Provider validates fixes or issues any documentation, including Accessibility Conformance Reports, certifications, conformance statements, or validation reports.</p>
      <h4>Validation Turnaround</h4>
      <p>Service Provider will complete the initial validation round within five (5) business days of Client’s submission for validation, and each subsequent validation round within three (3) business days of resubmission.</p>
      <h4>Validation Hours</h4>
      <p>Validation activity draws against the technical support hours included in this Agreement. Service Provider will provide advance written notice before the included technical support hours are used up. Continued validation beyond the included hours requires the purchase of additional technical support hours at the rate of $150/hour, payable in advance.</p>
      <h4>Pre-Remediation Static State</h4>
      <p>From the project start date until remediation is initiated, no changes whatsoever may be made to the digital asset. This includes content updates, code changes, design adjustments, third-party integration changes, and platform or framework modifications. Any change during this period invalidates the audit and triggers the Re-Audit Requirements below.</p>
      <p>If a change is unavoidable, Client must notify Service Provider in writing at least 5 days in advance. Service Provider will determine in its sole judgment whether the audit can proceed as planned, must be re-scoped, or must be re-audited at Client’s cost.</p>
      <h4>Permitted Changes During Validation</h4>
      <p>The only changes permitted to the audited asset during validation are remediation actions directly responsive to issues identified in the audit report. Any non-responsive change during validation invalidates the audit and triggers the Re-Audit Requirements below.</p>
      <h4>Re-Audit Requirements</h4>
      <p>Where a new audit is required under this Agreement, including when a validation window is not met, when the audit has been invalidated, or where Client otherwise requires Service Provider to re-evaluate previously audited content, the following terms apply:</p>
      ${agreementBulletList([
        "Within four (4) months of original audit report delivery, and provided no significant changes have been made to the audited asset, a re-audit covering the same scope may be conducted at seventy percent (70%) of the original agreement total.",
        "After four (4) months from original audit report delivery, or where Service Provider determines in its reasonable judgment that significant changes have been made to the audited asset, a re-audit will be priced as a new engagement at then-current rates.",
        "“Significant changes” includes modifications to navigation structure, page templates, design systems, frameworks, platforms, or any changes substantially altering the layout, functionality, or content of the audited asset."
      ])}
      <h4>Completion Window Extension</h4>
      <p>Client may purchase up to two extension months: $100 per month if purchased at signing, or $250 per month if purchased after the project is underway. Extension months extend only the four-month completion window; the 21-day initiation window and the 14-day activity requirement are unaffected.</p>
      <h4>Audit Details</h4>
      ${agreementBulletList([
        "Audit services and prices named herein are for named scope. Any pages, domains, subdomains, portals, documents, and other screens or content not specifically named are excluded from scope.",
        "Client can increase or decrease the number of pages in scope before this Agreement is executed. Changes after execution are addressed through Addendum.",
        "Client can add additional pages/screens to audit scope at a cost of $25 to $100 per light page/screen or $100 to $250 per primary page/screen.",
        "Client’s digital assets must remain static while the audit is being conducted. If edits are necessary, Client must let Service Provider know so the evaluation can be timed appropriately.",
        "If any login is required to access content within scope, Client must provide a test account and login details.",
        "The formal evaluation may require submitting forms, creating records, and interacting with features as an end user would. Client is responsible for providing an environment and accounts suitable for this activity."
      ])}

      <h3>VPAT Service</h3>
      <p>A Voluntary Product Accessibility Template (VPAT) is used to generate an Accessibility Conformance Report (ACR). The ACR documents the conformance level of a product against the specified accessibility standard.</p>
      <h4>Certification Details</h4>
      <p>Service Provider certification and conformance statements are contingent upon full WCAG conformance, without exception. Certification is only possible upon either 1) an audit returning 0 accessibility issues or 2) validation of fixes.</p>
      <h4>Documentation</h4>
      <p>When all issues within the defined scope have been properly fixed and validated, Service Provider can issue certification and conformance documentation. Certification is only issued when there is full conformance with the technical standard for the entire defined scope.</p>
      <h4>VPAT / Accessibility Conformance Report (ACR)</h4>
      <p>The ACR documents the conformance level of a product against the specified accessibility standard.</p>
      <h4>Accessible.org Certification</h4>
      <p>Accessible.org Certification confirms full conformance with the specified WCAG standard and includes the scope of certification, date of issuance, evaluation methodologies, and Service Provider’s qualifications as accessibility experts.</p>
      <h4>Statement of Conformance</h4>
      <p>A Statement of Conformance follows the W3C’s conformance requirements and states that the listed assets, pages, and screens are fully WCAG conformant.</p>
      <h4>Statement of Partial Conformance</h4>
      <p>If parts of Client’s digital asset are not under Client’s control and are non-conformant, a Statement of Partial Conformance can be issued stating that all controllable elements are WCAG conformant.</p>

      <h3>Project Deliverables</h3>
      <p>Service Provider will email all document deliverables including reports and documentation.</p>
      ${proposalInlineBlock(multilineList(deliverablesText), "deliverablesText", editable)}
      <h4>Deliverables License</h4>
      <p>Service Provider retains ownership of its methodologies, templates, evaluation processes, and pre-existing materials used to produce the deliverables. Upon receipt of full payment, Service Provider grants Client a perpetual, non-exclusive, royalty-free, worldwide license to use, reproduce, distribute, and publish the deliverables identified in this Agreement for Client’s business purposes, including in RFP responses and procurement processes. Deliverables must be presented without alteration and together with the scope, standard, environment, and date of issuance stated within them.</p>

      <h3>Project Scope</h3>
      <p>Audit scope includes all content and non-document media on the URLs and screens named below. Scope does not include any documents, third-party portals, subdomains, websites, pages, screens, properties, or platforms not named below.</p>
      ${proposalInlineBlock(multilineList(scopeText), "scopeText", editable)}
      <h4>Scope Acceptance</h4>
      <p>Client has reviewed and agrees to the scope of services described in this Agreement, including all deliverables and pricing. The scope is final upon execution. Any changes Client wishes to make to the scope must be requested and incorporated into this Agreement before it is executed by both parties.</p>
      <p>Changes requested after execution may be addressed through a separate addendum at Service Provider’s discretion and may involve additional fees.</p>
      <h4>Defined Scope</h4>
      <p>The scope of services is limited to the specific pages, screens, documents, and components expressly identified in this Agreement as of the Effective Date (“Defined Scope”). The Defined Scope is fixed and does not extend to Client’s entire website, application, or other digital assets.</p>
      <h4>Ordinary Content Additions</h4>
      <p>Client’s addition of new content that does not alter the Defined Scope does not constitute a scope change and does not obligate Service Provider to evaluate such content, nor does it void or modify the services provided under this Agreement.</p>
      <h4>Representative Sampling Methodology</h4>
      <p>The Defined Scope is assembled to be representative of Client’s digital asset, selecting pages, screens, and views that reflect the layouts, templates, and components in use across the asset. Because most accessibility issues originate at the template or component level, remediating the issues identified in the audit will, in most cases, resolve the same issues wherever those templates and components appear.</p>
      <p>Where issues arise from unique content rather than templates, the findings serve as a guide for Client to review similar content types on pages outside the Defined Scope for the same issue patterns.</p>
      <h4>Documentation Scope</h4>
      <p>Any documentation issued by Service Provider in connection with this Agreement, including Accessibility Conformance Reports, certification, conformance statements, audit reports, and validation reports, will reflect the exact scope, environment, standard, and version stated in this Agreement.</p>
      <p>If the scope includes a staging environment, all documentation will reference the staging environment and will not represent any other environment, including production. Documentation reflecting a different environment, scope, standard, or version requires a separate audit and engagement.</p>

      <h3>Project Cost</h3>
      <h4>Total Cost</h4>
      <p>${proposalInlineText(totalCost, "totalCost", editable)}</p>
      <h4>Cost Breakdown</h4>
      ${proposalInlineBlock(multilineList(costBreakdownText), "costBreakdownText", editable)}
      <p>Cost does not include any services not named under cost breakdown.</p>

      <h3>Project Completion</h3>
      <p>The project is complete when all deliverables identified in this Agreement, and any deliverables added through Addendum, have been delivered to Client. Validation activity and technical support are governed separately by their respective sections of this Agreement and do not affect the determination of project completion unless expressly stated.</p>

      <h3>Termination</h3>
      <p>This Agreement may be terminated only by Service Provider, upon written notice to Client. If Service Provider terminates this Agreement, Service Provider will refund all fees paid, less fees for services performed, deliverables delivered, and technical support hours used as of the termination date. Except as provided under Force Majeure, Client may not terminate this Agreement. Except as provided in this section, fees paid are non-refundable.</p>

      <h3>No Vendor Onboarding</h3>
      <p>Service Provider does not participate in vendor onboarding, registration, approval, or qualification processes. Service Provider does not complete vendor portals, security questionnaires, supplier registration forms, background check workflows, insurance verification systems, or similar third-party platforms.</p>

      <h3>Payment Terms</h3>
      <p>Payment is due prior to project start. Payment options include wire transfer, crypto, and all payment methods available through Stripe, including credit card, Amazon Pay, and ACH Direct Debit. Payment is processed securely through Stripe. Service Provider does not accept checks or alternative payment methods unless specifically agreed upon in advance.</p>
      <p>For agreements with a Total Cost over $10,000, wire transfer or ACH is the preferred payment method. Service Provider does not accept payment through third-party accounts payable or payment platforms. Any purchase order issued by Client is for Client’s internal administrative purposes only, and its terms do not apply to this Agreement.</p>
      <h4>Additional Services and Addendums</h4>
      <p>Additional services pertinent to this project may be added without a new agreement through written Addendum signed by both parties. Each Addendum will identify the additional services and associated cost.</p>

      <h3>Governing Law</h3>
      <p>This Agreement shall be governed by and construed in accordance with the laws of the State of Texas without giving effect to any choice or conflict of law provision or rule.</p>

      <h3>Dispute Resolution</h3>
      <p>Any dispute arising out of or relating to this Agreement shall be resolved as follows: for claims of $20,000 or less, either party may elect to pursue the matter in small claims court or state court in Bexar County, Texas. For claims exceeding $20,000, the parties agree to first attempt resolution through non-binding mediation in San Antonio, Texas, with costs split equally. If mediation fails to resolve the dispute within 30 days, either party may pursue the matter in state or federal court located in Bexar County, Texas.</p>
      <p>Client consents to the exclusive jurisdiction and venue of these courts and waives any objection based on forum non conveniens or any other basis. Client further waives any right to a jury trial in any proceeding arising out of or related to this Agreement.</p>

      <h3>Confidentiality</h3>
      <p>Each party agrees to hold in confidence all Confidential Information disclosed by the other party in connection with this Agreement. “Confidential Information” means any non-public information, technical data, or know-how disclosed by either party, whether orally or in writing, that is designated as confidential or reasonably should be understood to be confidential given the nature of the information.</p>
      <p>The receiving party shall not disclose Confidential Information to any third party without the disclosing party’s prior written consent, except to employees or contractors who need to know such information to perform obligations under this Agreement and who are bound by confidentiality obligations at least as protective as those herein.</p>
      <p>These confidentiality obligations continue for two (2) years from the date of this Agreement. Confidential Information does not include information that becomes publicly available through no fault of the receiving party, was rightfully known prior to disclosure, is independently developed without use of Confidential Information, or is required to be disclosed by law.</p>
      <p>If the parties have executed a mutual non-disclosure agreement, it remains in effect and governs Confidential Information together with this section. Service Provider does not publicly identify its clients. Client is free to share that it has worked with Service Provider.</p>

      <h3>No Third-Party Beneficiaries</h3>
      <p>This Agreement is between Service Provider and Client only. No other person or entity, including end users, website visitors, or plaintiffs in accessibility lawsuits, has any rights under this Agreement or may make any claims against Service Provider based on the services provided. Client shall not represent to any third party that Service Provider’s audit creates any warranties or obligations to anyone other than Client.</p>

      <h3>Limitation of Liability</h3>
      <p>Notwithstanding anything to the contrary contained in this Agreement, the aggregate liability of either party for any claim, loss, damage, or expense of any kind arising out of or related to this Agreement shall not exceed the total amount paid by Client to Service Provider under this Agreement. Under no circumstances shall either party be liable for any consequential, incidental, indirect, special, punitive, or exemplary damages arising from or related to this Agreement or the services provided.</p>
      <p>Client acknowledges that Service Provider’s fees reflect this allocation of risk and that Service Provider would not enter into this Agreement without these limitations. The remedies stated in this Agreement are Client’s sole and exclusive remedies.</p>

      <h3>Assumption of Risk and No Warranty</h3>
      <p>Client acknowledges that accessibility compliance is subject to varying interpretations by courts, regulatory agencies, and other entities. Service Provider’s audit represents a technical evaluation based on the above named WCAG standard at a specific point in time and does not constitute a warranty or guarantee of legal compliance with the ADA, Section 508, any other digital accessibility laws or regulations, or protection from lawsuits.</p>
      <p>Client assumes all risk associated with the implementation, non-implementation, or modification of Service Provider’s recommendations. Service Provider expressly disclaims all warranties, express or implied. Client acknowledges that Service Provider’s role is limited to technical evaluation and that WCAG conformance and legal compliance remains Client’s sole responsibility.</p>

      <h3>Indemnification</h3>
      <p>Client agrees to indemnify, defend, and hold harmless Service Provider, its officers, employees, agents, and subcontractors from and against all claims, demands, losses, costs, damages, actions, suits, or proceedings brought by third parties arising out of or related to Client’s website, application, or digital properties, including accessibility-related lawsuits, regulatory actions, or user complaints.</p>

      <h3>Force Majeure</h3>
      <p>Neither party shall be liable for any failure or delay in performing its obligations under this Agreement to the extent such failure or delay results from circumstances beyond the reasonable control of the affected party, including acts of God, natural disasters, pandemics, government actions, war, terrorism, labor disputes, or internet or infrastructure failures. If a force majeure event continues for more than 60 days, either party may terminate this Agreement upon written notice.</p>

      <h3>Statute of Limitations</h3>
      <p>Any claim or cause of action arising out of or related to this Agreement must be brought within one (1) year after the cause of action accrues, regardless of any longer statute of limitations period that might otherwise apply. A cause of action accrues when Service Provider delivers the audit report or when services are terminated, whichever occurs first.</p>

      <h3>Survival of Terms</h3>
      <p>The following provisions shall survive termination or expiration of this Agreement: Limitation of Liability, Assumption of Risk and No Warranty, Indemnification, Statute of Limitations, No Third-Party Beneficiaries, Governing Law, Confidentiality, Deliverables License, Dispute Resolution, and any payment obligations.</p>

      <h3>Modification and Waiver</h3>
      <p>No modification of this Agreement shall be valid unless in writing and signed by both parties. No waiver of any provision of this Agreement shall be deemed or shall constitute a waiver of any other provision, nor shall any waiver constitute a continuing waiver.</p>

      <h3>Assignment</h3>
      <p>Neither party may assign this Agreement without the prior written consent of the other party; provided, however, that either party may assign this Agreement without such consent to an affiliate or to a successor in interest in connection with a merger, reorganization, or sale of all or substantially all of its assets.</p>

      <h3>Notices</h3>
      <p>All notices required under this Agreement must be sent by email to the addresses on file for each party. A notice is deemed received on the first business day after it is sent unless the sending party receives a delivery failure message. Each party is responsible for keeping its email address current and providing written notice of any change.</p>

      <h3>Severability</h3>
      <p>If any provision of this Agreement is held by a court of competent jurisdiction to be invalid, illegal, or unenforceable, such provision shall be modified to the minimum extent necessary to make it valid, legal, and enforceable, or if such modification is not possible, such provision shall be severed from this Agreement. The remaining provisions remain in full force and effect.</p>

      <h3>Entire Agreement</h3>
      <p>This Agreement contains the entire agreement between the parties and supersedes all prior agreements and understandings, both written and oral, with respect to the subject matter hereof, except that any mutual non-disclosure agreement between the parties remains in effect.</p>

      <h3>Execution</h3>
      <p>In Witness Whereof, the parties have executed this Agreement as of the date first above written.</p>
      <h4>Accessible.org, LLC</h4>
      <p>Signature: Kris Rivenburgh<br />Name: Kris Rivenburgh<br />Title: Founder, Accessible.org<br />Date: ${escapeHtml(details.agreementDate || todayIsoDate())}</p>
    </div>
  `;
}

function renderPublicSignature() {
  const payload = state.publicSignature;
  if (!payload) {
    const errorMessage = state.publicSignatureError || "This signing link could not be loaded. Please request a fresh link.";
    const needsSignIn = /sign in|recipient portal account|different recipient account/i.test(errorMessage);
    root.innerHTML = needsSignIn ? `
      <main class="signin-shell">
        <form class="signin-card" id="signinForm">
          ${brandLogo("signin")}
          <h1>Sign in to open proposal</h1>
          <p class="helper">${escapeHtml(errorMessage)}</p>
          <label class="field">
            <span>Email Address</span>
            <input name="email" type="email" autocomplete="email" required />
          </label>
          <label class="field">
            <span>Password</span>
            <input name="password" type="password" autocomplete="current-password" required />
          </label>
          <label class="password-toggle">
            <input type="checkbox" data-toggle-password="password" />
            <span>Show Password</span>
          </label>
          <button class="primary" type="submit">Sign In and Open Proposal</button>
          <div class="signin-actions">
            <button class="link-button" type="button" data-action="forgot-password">Forgot Password?</button>
          </div>
        </form>
        ${toastHtml()}
      </main>
    ` : `
      <main class="signin-shell">
        <section class="signin-card">
          ${brandLogo("signin")}
          <h1>Proposal link unavailable</h1>
          <p class="helper">${escapeHtml(errorMessage)}</p>
          ${toastHtml()}
        </section>
      </main>
    `;
    if (needsSignIn) attachSignInEvents();
    return;
  }
  const alreadySigned = payload.recipient?.status === "signed";
  const canSign = payload.recipient?.role === "signer";
  const proposalApproved = Boolean(payload.proposalApproved || (payload.events || []).some((event) => event.event_type === "proposal_approved"));
  const agreement = payload.agreement || {};
  const recipientName = payload.recipient?.name || payload.recipient?.email || "recipient";
  const agreementTitle = agreement.title || payload.document?.title || "Proposal";
  const agreementDetails = parseAgreementDetailsFromSnapshot(agreement, payload);
  const signedDetails = signedSignatureDetails(payload);
  const proposalPages = ["services", "training", "about", "terms"];
  const activeProposalPage = proposalPages.includes(state.publicProposalPage) ? state.publicProposalPage : "services";
  state.publicProposalPage = activeProposalPage;
  const proposalSectionClass = (page) => `proposal-section${page === activeProposalPage ? "" : " proposal-section-hidden"}`;
  const proposalNavButton = (page, label) => `
    <button type="button" class="${page === activeProposalPage ? "active" : ""}" data-proposal-page="${page}">${label}</button>
  `;
  root.innerHTML = `
    <main class="proposal-site">
      <aside class="proposal-sidebar">
        ${brandLogo("signin")}
        <nav class="proposal-sidebar-nav" aria-label="Proposal sections">
          ${proposalNavButton("services", "Services")}
          ${proposalNavButton("training", "Training")}
          ${proposalNavButton("about", "About")}
          ${proposalNavButton("terms", proposalApproved ? "Agreement" : "Terms")}
        </nav>
      </aside>

      <div class="proposal-document">
        <section class="${proposalSectionClass("services")}" id="services">
          <h1>Services</h1>
          <p class="proposal-service-lede">Accessible.org can help make your website, app, or other digital asset meet WCAG 2.1 AA or 2.2 AA standards and follow best practices in ADA compliance.</p>
          <div class="proposal-service-hero">
            <div>
              <span class="proposal-eyebrow">Accessibility + compliance</span>
              <h3>Expert work, clear scope, no surprises.</h3>
              <p>Our services are built around detailed manual evaluations, practical remediation guidance, and documentation your team can use.</p>
              <a class="proposal-media-link" href="https://accessible.org/services/" target="_blank" rel="noopener">Explore all services at Accessible.org</a>
            </div>
            <img src="https://i0.wp.com/accessible.org/wp-content/uploads/2024/09/Phone-Tilted.png?resize=567%2C659&amp;ssl=1" alt="A phone showing an accessibility review" />
          </div>
          <div class="proposal-service-details">
            <article>
              <h2>Audits</h2>
              <p>We evaluate your digital asset against WCAG 2.1 AA or 2.2 AA using manual screen reader, keyboard, touch, visual, code, contrast, browser, and device testing.</p>
              <p class="proposal-service-price">Cost: $100–$250 per page or screen; $25–$100 for light pages or screens.</p>
            </article>
            <article>
              <h2>VPATs / ACRs</h2>
              <p>We complete a VPAT and issue an Accessibility Conformance Report (ACR) that documents your product’s accessibility status for procurement and compliance conversations.</p>
              <p class="proposal-service-price">Cost: $350 WCAG edition; $550 Section 508; $650 EU; $950 INT, in addition to audit cost.</p>
            </article>
            <article>
              <h2>Technical Support</h2>
              <p>Technical experts validate fixes, support remediation, answer implementation questions, and help your team complete the project successfully.</p>
              <p class="proposal-service-price">Cost: $195/hour, minimum 3 hours.</p>
            </article>
            <article>
              <h2>Certification</h2>
              <p>Certification documents can include statements of conformance, partial conformance, Accessible.org certification, or a recorded user-testing session to document project progress.</p>
              <p class="proposal-service-price">Cost: Issued when the required conformance conditions are met; not sold separately.</p>
            </article>
            <article>
              <h2>User Testing</h2>
              <p>Professionals with disabilities use assistive technologies to evaluate your digital assets. Sessions are recorded and include up to 10 pages or screens, capped at 30 minutes after remediation.</p>
              <p class="proposal-service-price">Cost: $550 per session; $450 per session with an audit.</p>
            </article>
            <article>
              <h2>Document Remediation</h2>
              <p>We remediate PDFs, Word, PowerPoint, Canva-generated files, and other documents to meet WCAG 2.2 AA and PDF/UA standards.</p>
              <p class="proposal-service-price">Cost: Starts at $7/page.</p>
            </article>
            <article>
              <h2>Expedited Accessibility</h2>
              <p>Rush accessibility services support urgent deadlines. Some document or PDF remediation requests can be completed the same day or overnight.</p>
              <p class="proposal-service-price">Cost: $250–$750 depending on document size and content.</p>
            </article>
            <article>
              <h2>Custom Accessibility Statement</h2>
              <p>Kris Rivenburgh creates a custom accessibility statement aligned with your organization’s policy, commitment, and current accessibility efforts.</p>
              <p class="proposal-service-price">Cost: $250 to start; varies by project request.</p>
            </article>
          </div>
        </section>

        <section class="${proposalSectionClass("training")}" id="training">
          <h2>Training</h2>
          <div class="proposal-training-content">
            <div class="proposal-training-hero">
              <img src="https://i0.wp.com/accessible.org/wp-content/uploads/2025/08/Web-Accessibility-Training.jpg?resize=1200%2C675&amp;ssl=1" alt="Accessibility training with Kris Rivenburgh" />
              <div>
                <span class="proposal-eyebrow">Learn at your pace</span>
                <h3>Practical accessibility training for real teams.</h3>
                <p>Live workshops and on-demand courses make WCAG easier to understand for designers, developers, content editors, and non-technical teams.</p>
                <a class="proposal-media-link" href="https://adacompliance.net/course/wcag-course" target="_blank" rel="noopener">Start the WCAG course</a>
              </div>
            </div>
            <div class="proposal-training-table-wrap">
              <table class="proposal-training-table">
                <thead>
                  <tr>
                    <th>WCAG Course Features &amp; Benefits</th>
                    <th>Description</th>
                    <th>Benefit</th>
                  </tr>
                </thead>
                <tbody>
                  <tr>
                    <th>Video &amp; Text Explanations</th>
                    <td>Comprehensive coverage of WCAG 2.1 AA and 2.2 AA success criteria</td>
                    <td>Reinforced learning through video and text</td>
                  </tr>
                  <tr>
                    <th>Plain English Explanations</th>
                    <td>Simple, jargon-free lessons</td>
                    <td>Understand complex accessibility concepts easily</td>
                  </tr>
                  <tr>
                    <th>Practical Code Examples</th>
                    <td>Real-world application examples</td>
                    <td>Apply knowledge immediately to actual projects</td>
                  </tr>
                  <tr>
                    <th>Excel Spreadsheet Checklist</th>
                    <td>Detailed and sortable conformance checklist</td>
                    <td>Valuable reference sheets for projects and processes</td>
                  </tr>
                  <tr>
                    <th>Certificate of Completion</th>
                    <td>ADACompliance.net official certification</td>
                    <td>Demonstrate expertise and training completion</td>
                  </tr>
                  <tr>
                    <th>Self-Paced Learning</th>
                    <td>Organized, straightforward, easy-to-understand structure</td>
                    <td>Learn at your own speed and schedule</td>
                  </tr>
                  <tr>
                    <th>Legal Compliance</th>
                    <td>Supports Section 508, Section 504, ADA, AODA, HB21-1110, and EAA</td>
                    <td>Meet various accessibility compliance requirements</td>
                  </tr>
                </tbody>
              </table>
            </div>

            <h3>Web Accessibility Training</h3>
            <div class="proposal-training-block">
              <p>Web accessibility training is crucial for reaching and maintaining WCAG 2.1 AA conformance, reducing the cost of digital accessibility, and being compliant with the law. We offer both live workshops and on-demand courses.</p>
              <p>To start learning right now, sign up for our <a href="https://adacompliance.net/course/wcag-course" target="_blank" rel="noopener">WCAG Course</a> at ADACompliance.net. This course is perfect for individuals or teams who want to learn WCAG 2.1 AA and/or WCAG 2.2 AA.</p>
            </div>

            <h3>WCAG Course</h3>
            <div class="proposal-training-block">
              <p>The WCAG Course includes individual lessons for all 50 WCAG 2.1 AA success criteria as well as the 6 new success criteria in WCAG 2.2 AA.</p>
              <p>Each lesson contains simple, easy to understand explanations of what is required for each success criterion. The video and text explanations make it easy for anyone to learn what is required, even non-technical beginners who know nothing about accessibility.</p>
              <p>Each lesson links to the official W3C documentation and, where applicable, includes curated helpful resources in case your team wants to explore the success criterion further.</p>
            </div>

            <h3>Application of Principles</h3>
            <div class="proposal-training-block">
              <p>While the principles outlined in these requirements are designed for web content such as websites, web pages, web apps, videos, and images, they are also applicable to all digital assets, including mobile apps, software, and documents.</p>
            </div>

            <h3>Compliance with Digital Accessibility Laws</h3>
            <div class="proposal-training-block">
              <p>Given that WCAG conformance is mandated by almost all digital accessibility laws, the WCAG Course can help your team in working towards compliance with many different laws and regulations including:</p>
              <ul>
                <li>ADA Title II</li>
                <li>Section 504</li>
                <li>Section 508</li>
                <li>AODA</li>
                <li>HB21-1110</li>
                <li>European Accessibility Act (EAA)</li>
              </ul>
            </div>

            <h3>Supplemental Materials</h3>
            <div class="proposal-training-block">
              <p>To help your team put WCAG into practice, the course includes:</p>
              <ul>
                <li>Accessibility workflows for designers, developers, and content editors.</li>
                <li>A master WCAG checklist in Excel spreadsheet format.</li>
                <li>WCAG in Chunks, which groups similar success criteria together.</li>
              </ul>
              <p>These downloads give your organization the reminders and easy reference points they need when coding, designing, or creating content.</p>
            </div>

            <h3>Course Design</h3>
            <div class="proposal-training-block">
              <p>This highly organized, self-paced course features modules that divide success criteria for WCAG 2.0 AA, 2.1 AA, and 2.2 AA, allowing your team to progress from foundational accessibility to newer success criteria.</p>
              <p>We have designed this course to be as efficient and effective as possible, enabling your team to learn accessibility in less time and retain more of the information.</p>
            </div>

            <h3>ADA Compliance Course</h3>
            <div class="proposal-training-block">
              <p>Our <a href="https://accessible.org/ada-compliance-course/" target="_blank" rel="noopener">ADA Compliance Course</a> teaches prioritizing website accessibility issues from a strategic, legal point of view. The lessons are ordered in the recommended order to prevent lawsuits and explain exactly how to find and fix each issue. This course is also on-demand so you can begin learning right now.</p>
            </div>

            <h3>Course Content and Structure</h3>
            <div class="proposal-training-block">
              <p>The ADA Compliance Course centers around individual lessons for the 15 most commonly claimed accessibility issues in website accessibility lawsuits.</p>
              <p>Each of the primary lessons is dedicated to a single issue and details:</p>
              <ul>
                <li>What the issue is</li>
                <li>What role is responsible</li>
                <li>How to find it</li>
                <li>How to fix it</li>
                <li>Code examples</li>
                <li>Potential defenses</li>
              </ul>
              <p>The course also features lessons on how to get started, strategy, mindset, and additional claims.</p>
            </div>

            <h3>Course Logic</h3>
            <div class="proposal-training-block">
              <p>The ADA Compliance Course is premised upon the idea that if you remediate all of the most commonly claimed issues from the most active plaintiffs’ law firms, you will significantly reduce your risk of being sued.</p>
              <p>Accessible.org has researched hundreds of lawsuits filed by the most active plaintiffs’ law firms and distilled those findings and recommendations into this course.</p>
            </div>

            <h3>Supplemental Materials</h3>
            <div class="proposal-training-block">
              <p>This course includes an ADA Compliance Course checklist, Issue Roles download, Issues Summary download, Interactive Elements in a Nutshell, and actual complaints filed in court.</p>
              <p>These supplemental materials are excellent references as your digital team works through the course.</p>
            </div>

            <h3>Course Design</h3>
            <div class="proposal-training-block">
              <p>This course is methodical, detailed, and straightforward. The core message is that you must proactively fix accessibility issues as fast as possible.</p>
              <p>The ADA Compliance Course is an excellent complement to the WCAG Course. As you implement the lessons and resolve issues on your website one-by-one, you will incrementally reduce your risk of being sued.</p>
            </div>

            <div class="proposal-training-image">
              <img src="/images/accessibility-training.png" alt="Accessibility Training" />
            </div>
            <div class="proposal-video-card">
              <div>
                <span class="proposal-eyebrow">Video library</span>
                <h3>Keep learning with Accessible.org</h3>
                <p>Browse practical accessibility and compliance videos from Kris Rivenburgh and the Accessible.org team.</p>
                <a class="primary proposal-media-link" href="https://www.youtube.com/@adabook" target="_blank" rel="noopener">Watch on YouTube</a>
              </div>
              <a class="proposal-video-card-media" href="https://www.youtube.com/@adabook" target="_blank" rel="noopener" aria-label="Open the Accessible.org video library on YouTube">
                <img src="/images/accessibility-training.png" alt="Accessible.org accessibility training video thumbnail" />
                <span aria-hidden="true">▶</span>
              </a>
            </div>
          </div>
        </section>

        <section class="${proposalSectionClass("about")}" id="about">
          <h2>About</h2>
          <div class="proposal-about-content">
            <div class="proposal-about-hero">
              <div>
                <span class="proposal-eyebrow">Client-first accessibility</span>
                <h3>Clear guidance. Practical expertise. Better outcomes.</h3>
                <p>Accessible.org helps organizations make digital assets WCAG conformant and compliant while building internal accessibility knowledge.</p>
              </div>
              <img src="https://i0.wp.com/accessible.org/wp-content/uploads/2025/06/author-image-Kris.jpg?ssl=1&amp;w=1200" alt="Kris Rivenburgh, founder of Accessible.org" />
            </div>
            <p>Accessible.org, LLC is a U.S. based digital accessibility company that puts clients first. Founded by Kris Rivenburgh, an attorney and author of The ADA Book and Digital Accessibility and Compliance, Accessible.org provides audit and VPAT services to clients across the world.</p>
            <p>We help clients make their digital assets WCAG conformant and compliant while building internal accessibility knowledge.</p>

            <h3>Our Approach</h3>
            <div class="proposal-content-box">
              <p>We take a contrarian approach to sales and marketing. Instead of email campaigns, sales calls, forced demos, long-term contracts, and outreach, we focus on:</p>
              <ul>
                <li>Education and free resources</li>
                <li>À la carte services</li>
                <li>Complete transparency</li>
                <li>Saving clients time</li>
              </ul>
              <p>This client-first model prioritizes sustainable growth and reliable service over short-term profits.</p>
            </div>

            <h3>Our Team</h3>
            <p>Our accessibility specialists combine legal, technical, and practical expertise. Kris Rivenburgh has studied accessibility and compliance for years to ensure clients receive accurate, actionable information. Our auditors are certified DHS Trusted Testers.</p>
            <p><strong>Note:</strong> The DHS Trusted Tester certification process is rigorous and often takes 1 to 2 months to complete. Participants work through an estimated 40 to 80 hours of training, incremental exams, a practice exam, and a final certification exam requiring a score of 85% or higher. The mandatory window for completing the full program is 6 months (180 days).</p>

            <h3>Innovating with AI</h3>
            <p>At Accessible.org Labs, we are pioneering the use of real AI in accessibility. We are the first company to develop AI generated VPATs built from real, fully manual audits, not automated scans. Inside Accessibility Tracker, AI powers progress reports, project insights, and an AI Consultant that helps teams understand and resolve accessibility issues in real time. We use AI to make accessibility faster and more efficient without replacing the manual expertise that accurate conformance requires.</p>
            <p>We are researching and developing to advance AI hybrid accessibility audits by 2027.</p>

            <h3>Our Products</h3>
            <p>Accessibility Tracker is our project platform built for teams that need to track, manage, and resolve accessibility issues across audits and projects.</p>
            <p>Accessibility Base is our directory marketplace connecting organizations with accessibility professionals, products, and services.</p>

            <h3>Who We Serve</h3>
            <p>We work with organizations of all sizes, from small businesses working on their new Shopify store to Fortune 500 companies managing complex digital assets. Our clients include governments, non-profits, corporations, solo entrepreneurs, startups, professionals, media companies, universities, and retail brands.</p>
            <p>Reach out and we’ll reply right away.</p>
          </div>
        </section>

        <section class="${proposalSectionClass("terms")} proposal-terms-section" id="terms">
          <h2>Accessibility Services Agreement</h2>
          ${renderAgreementTerms(agreementDetails)}
          <div class="proposal-authorized-row">
            <span>Duly authorized, for and on behalf of the Customer</span>
          </div>
          <div class="proposal-signature-area">
            ${!canSign ? `
              <section class="proposal-sign-panel">
                <p class="helper">This document is view-only.</p>
              </section>
            ` : alreadySigned ? `
              <section class="proposal-sign-panel proposal-signed-panel">
                <div class="signed-agreement-summary">
                  <strong>Agreement signed</strong>
                  <div class="signature-field-grid">
                    <p><span>Signature</span><strong>${escapeHtml(signedDetails?.typedSignature || (signedDetails?.signatureImage ? "Drawn signature" : "-"))}</strong></p>
                    <p><span>Name</span><strong>${escapeHtml(signedDetails?.signerName || recipientName)}</strong></p>
                    <p><span>Title</span><strong>${escapeHtml(signedDetails?.signerTitle || "-")}</strong></p>
                    <p><span>Date</span><strong>${escapeHtml(signedDetails?.signatureDate || payload.recipient?.signed_at || "-")}</strong></p>
                  </div>
                  ${signedDetails?.signatureImage ? `<img class="signed-signature-image" src="${escapeHtml(signedDetails.signatureImage)}" alt="Drawn signature" />` : ""}
                  <button class="secondary" type="button" data-download-signed-pdf>Print / Download signed PDF</button>
                </div>
              </section>
            ` : !proposalApproved ? `
              <section class="proposal-sign-panel proposal-sign-locked">
                <div class="proposal-lock-icon" aria-hidden="true">🔒</div>
                <div>
                  <strong>Signing is locked</strong>
                  <p class="helper">Review the proposal above. When everything looks correct, approve it to unlock the signature field.</p>
                </div>
                <button class="primary" type="button" data-approve-proposal>Approve proposal and unlock signing</button>
              </section>
            ` : `
              <form class="proposal-sign-panel" id="publicSignatureForm">
                <p>I, ${escapeHtml(recipientName)}, agree to the terms of this agreement and consent to use the signature below as my digital signature.</p>
                <div class="proposal-sign-tabs" role="tablist" aria-label="Signature method">
                  <button type="button" class="active" data-signature-mode-button="typing">▣ Sign by typing</button>
                  <button type="button" data-signature-mode-button="drawing">✎ Sign by drawing</button>
                </div>
                <div data-signature-mode="typing">
                  <label class="field"><span>Signature</span><input name="typedSignature" autocomplete="off" /></label>
                </div>
                <div class="signature-drawing-panel" data-signature-mode="drawing" hidden>
                  <span class="field-label">Draw your signature</span>
                  <canvas class="signature-canvas" data-signature-canvas width="720" height="220" aria-label="Draw your signature"></canvas>
                  <input name="signatureImage" type="hidden" />
                  <button class="link-button" type="button" data-clear-signature>Clear drawing</button>
                </div>
                <div class="signature-field-grid">
                  <label class="field"><span>Name</span><input name="signerName" value="${escapeHtml(recipientName)}" required autocomplete="name" /></label>
                  <label class="field"><span>Title</span><input name="signerTitle" required autocomplete="organization-title" /></label>
                  <label class="field"><span>Date</span><input name="signatureDate" type="date" value="${new Date().toISOString().slice(0, 10)}" required /></label>
                </div>
                <button class="primary" type="submit">Accept and sign</button>
              </form>
            `}
          </div>
        </section>
      </div>
      ${toastHtml()}
    </main>
  `;
  attachPublicSignatureEvents();
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function render() {
  const previousWindowScroll = window.scrollY;
  const previousPreviewScroll = document.querySelector("[data-proposal-preview-document]")?.scrollTop || 0;
  const previousViewerScroll = document.querySelector("[data-proposal-viewer-document]")?.scrollTop || 0;

  if (state.loading) {
    root.innerHTML = `<main class="signin-shell"><section class="signin-card">${brandLogo("signin")}<p class="helper center-text">Loading ${APP_NAME}...</p></section>${toastHtml()}</main>`;
    return;
  }

  if (state.publicSignatureToken) {
    renderPublicSignature();
    return;
  }

  if (!state.session) {
    if (state.authView === "reset-password") {
      renderResetPassword();
    } else if (state.authView === "forgot-password") {
      renderForgotPassword();
    } else {
      renderSignIn();
    }
    return;
  }

  if (state.authView === "reset-password") {
    renderResetPassword();
    return;
  }

  if (state.loadError) {
    root.innerHTML = `
      <main class="signin-shell">
        <section class="signin-card">
          ${brandLogo("signin")}
          <h1>Unable to Load Account</h1>
          <p class="helper">${escapeHtml(state.loadError)}</p>
          <p class="helper">Your sign-in session is still active. Please retry, or sign out and sign in again if the issue continues.</p>
          <div class="signin-actions">
            <button class="primary" type="button" data-action="retry-load">Retry</button>
            <button class="secondary" type="button" data-action="logout">Sign Out</button>
          </div>
        </section>
        ${toastHtml()}
      </main>
    `;
    attachEvents();
    return;
  }

  if (state.profile?.must_change_password && state.page !== defaultPage()) state.page = defaultPage();
  if (!pageIsAllowed(state.page)) state.page = defaultPage();

  const pageHtml = {
    messages: messagesPage,
    dashboard: dashboardPage,
    documents: signatureDocumentsPage,
    history: historyPage,
    request: clientRequestPage,
    account: accountPage,
    "admin-dashboard": adminDashboardPage,
    "admin-clients": adminClientsPage,
    "admin-client-detail": adminClientDetailPage,
    "admin-requests": adminRequestsPage,
    "admin-request-detail": adminRequestDetailPage,
    "admin-messages": adminMessagesPage,
    "admin-documents": signatureDocumentsPage,
    "admin-team": adminTeamPage,
    "admin-settings": adminSettingsPage
  }[state.page]();

  root.innerHTML = `${navHtml()}<main>${pageHtml}</main>${toastHtml()}${proposalViewerModal()}`;
  attachEvents();
  keepActiveNavVisible();
  window.requestAnimationFrame(() => {
    window.scrollTo({ top: previousWindowScroll, behavior: "auto" });
    const preview = document.querySelector("[data-proposal-preview-document]");
    if (preview) preview.scrollTop = previousPreviewScroll;
    const viewer = document.querySelector("[data-proposal-viewer-document]");
    if (viewer) viewer.scrollTop = previousViewerScroll;
  });
}

function keepActiveNavVisible() {
  const activeTab = document.querySelector(".nav button.active");
  if (!activeTab) return;
  window.requestAnimationFrame(() => {
    activeTab.scrollIntoView({ block: "nearest", inline: "center" });
  });
}

function attachPublicSignatureEvents() {
  document.querySelectorAll("[data-proposal-page]").forEach((button) => {
    button.addEventListener("click", () => {
      const nextPage = button.dataset.proposalPage;
      if (!nextPage || nextPage === state.publicProposalPage) return;
      state.publicProposalPage = nextPage;
      renderPublicSignature();
      window.scrollTo({ top: 0, behavior: "smooth" });
    });
  });

  const form = document.getElementById("publicSignatureForm");
  const approveButton = document.querySelector("[data-approve-proposal]");
  if (approveButton) {
    approveButton.addEventListener("click", async () => {
      await withActionLock("approve-proposal", approveButton, async () => {
        try {
          await signSignatureRecipient(state.publicSignatureToken, { action: "approve" });
          state.publicSignature = await loadSignatureByToken(state.publicSignatureToken);
          showToast("Proposal approved. Signing is now unlocked.");
          renderPublicSignature();
        } catch (error) {
          showAppError(error, "Approve proposal");
        }
      });
    });
  }

  document.querySelector("[data-download-signed-pdf]")?.addEventListener("click", () => {
    window.print();
  });

  if (!form) return;

  const signatureModeButtons = form.querySelectorAll("[data-signature-mode-button]");
  const signatureModePanels = form.querySelectorAll("[data-signature-mode]");
  signatureModeButtons.forEach((button) => {
    button.addEventListener("click", () => {
      const mode = button.dataset.signatureModeButton;
      signatureModeButtons.forEach((item) => item.classList.toggle("active", item === button));
      signatureModePanels.forEach((panel) => {
        panel.hidden = panel.dataset.signatureMode !== mode;
      });
      const typedInput = form.querySelector("[name='typedSignature']");
      if (typedInput) typedInput.required = mode === "typing";
    });
  });

  const canvas = form.querySelector("[data-signature-canvas]");
  const signatureImageInput = form.querySelector("[name='signatureImage']");
  if (canvas && signatureImageInput) {
    const context = canvas.getContext("2d");
    context.lineCap = "round";
    context.lineJoin = "round";
    context.lineWidth = 3;
    context.strokeStyle = "#171b22";
    let drawing = false;
    let hasDrawing = false;
    const pointFromEvent = (event) => {
      const rect = canvas.getBoundingClientRect();
      return {
        x: (event.clientX - rect.left) * (canvas.width / rect.width),
        y: (event.clientY - rect.top) * (canvas.height / rect.height)
      };
    };
    canvas.addEventListener("pointerdown", (event) => {
      event.preventDefault();
      drawing = true;
      hasDrawing = true;
      canvas.setPointerCapture(event.pointerId);
      const point = pointFromEvent(event);
      context.beginPath();
      context.moveTo(point.x, point.y);
    });
    canvas.addEventListener("pointermove", (event) => {
      if (!drawing) return;
      event.preventDefault();
      const point = pointFromEvent(event);
      context.lineTo(point.x, point.y);
      context.stroke();
    });
    const finishDrawing = () => {
      if (!drawing) return;
      drawing = false;
      signatureImageInput.value = hasDrawing ? canvas.toDataURL("image/png") : "";
    };
    canvas.addEventListener("pointerup", finishDrawing);
    canvas.addEventListener("pointercancel", finishDrawing);
    canvas.addEventListener("pointerleave", finishDrawing);
    form.querySelector("[data-clear-signature]")?.addEventListener("click", () => {
      context.clearRect(0, 0, canvas.width, canvas.height);
      hasDrawing = false;
      signatureImageInput.value = "";
    });
  }

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const values = Object.fromEntries(new FormData(event.currentTarget));
    await withActionLock("public-signature", event.currentTarget, async () => {
      try {
        await signSignatureRecipient(state.publicSignatureToken, {
          typedSignature: values.typedSignature,
          signatureImage: values.signatureImage,
          signerName: values.signerName,
          signerTitle: values.signerTitle,
          signatureDate: values.signatureDate
        });
        state.publicSignature = await loadSignatureByToken(state.publicSignatureToken);
        showToast("Proposal signed.");
        renderPublicSignature();
      } catch (error) {
        showAppError(error, "Sign agreement");
      }
    });
  });
}

function attachEvents() {
  document.querySelectorAll("[data-action='logout']").forEach((button) => {
    button.addEventListener("click", handleLogout);
  });

  document.querySelectorAll("[data-action='show-password-change']").forEach((button) => {
    button.addEventListener("click", () => {
      state.showPasswordForm = true;
      render();
    });
  });

  document.querySelectorAll("[data-action='cancel-password-change']").forEach((button) => {
    button.addEventListener("click", () => {
      state.showPasswordForm = false;
      render();
    });
  });

  attachPasswordToggles();

  document.querySelectorAll("[data-action='toggle-services']").forEach((button) => {
    button.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      const dropdown = button.closest("[data-service-dropdown]");
      const menu = dropdown?.querySelector("[data-service-menu]");
      if (menu) {
        menu.hidden = !menu.hidden;
        button.setAttribute("aria-expanded", String(!menu.hidden));
      }
    });
  });

  document.querySelectorAll("[data-action='close-services']").forEach((button) => {
    button.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      const dropdown = button.closest("[data-service-dropdown]");
      const menu = dropdown?.querySelector("[data-service-menu]");
      const toggle = dropdown?.querySelector("[data-action='toggle-services']");
      if (menu) {
        menu.hidden = true;
        toggle?.setAttribute("aria-expanded", "false");
      }
    });
  });

  document.querySelectorAll("[data-service-dropdown] input[name='services']").forEach((checkbox) => {
    checkbox.addEventListener("change", () => {
      const dropdown = checkbox.closest("[data-service-dropdown]");
      const summary = dropdown?.querySelector("[data-service-summary]");
      const selected = Array.from(dropdown?.querySelectorAll("input[name='services']:checked") || []).map((input) => input.value);
      if (summary) summary.textContent = selected.length ? selected.join(", ") : "Select Services";
    });
  });

  document.querySelectorAll("[data-action='toggle-assignments']").forEach((button) => {
    button.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      const dropdown = button.closest("[data-assignment-dropdown]");
      const menu = dropdown?.querySelector("[data-assignment-menu]");
      if (menu) {
        menu.hidden = !menu.hidden;
        button.setAttribute("aria-expanded", String(!menu.hidden));
      }
    });
  });

  document.querySelectorAll("[data-action='close-assignments']").forEach((button) => {
    button.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      const dropdown = button.closest("[data-assignment-dropdown]");
      const menu = dropdown?.querySelector("[data-assignment-menu]");
      const toggle = dropdown?.querySelector("[data-action='toggle-assignments']");
      if (menu) {
        menu.hidden = true;
        toggle?.setAttribute("aria-expanded", "false");
      }
    });
  });

  document.querySelectorAll("[data-assignment-dropdown] input[name='assignedProfileIds']").forEach((checkbox) => {
    checkbox.addEventListener("change", () => {
      const dropdown = checkbox.closest("[data-assignment-dropdown]");
      const summary = dropdown?.querySelector("[data-assignment-summary]");
      const selected = Array.from(dropdown?.querySelectorAll("input[name='assignedProfileIds']:checked") || [])
        .map((input) => input.dataset.assignmentName || input.value);
      if (summary) summary.textContent = selected.length ? selected.join(", ") : "Select Team Members";
    });
  });

  document.querySelectorAll("[data-action='toggle-cc-contacts']").forEach((button) => {
    button.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      const dropdown = button.closest("[data-cc-dropdown]");
      const menu = dropdown?.querySelector("[data-cc-menu]");
      if (menu) {
        menu.hidden = !menu.hidden;
        button.setAttribute("aria-expanded", String(!menu.hidden));
      }
    });
  });

  document.querySelectorAll("[data-action='close-cc-contacts']").forEach((button) => {
    button.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      const dropdown = button.closest("[data-cc-dropdown]");
      const menu = dropdown?.querySelector("[data-cc-menu]");
      const toggle = dropdown?.querySelector("[data-action='toggle-cc-contacts']");
      if (menu) {
        menu.hidden = true;
        toggle?.setAttribute("aria-expanded", "false");
      }
    });
  });

  document.querySelectorAll("[data-cc-dropdown] input[name='ccContactEmails']").forEach((checkbox) => {
    checkbox.addEventListener("change", () => {
      const dropdown = checkbox.closest("[data-cc-dropdown]");
      const summary = dropdown?.querySelector("[data-cc-summary]");
      const selected = Array.from(dropdown?.querySelectorAll("input[name='ccContactEmails']:checked") || [])
        .map((input) => input.dataset.ccName || input.value);
      if (summary) summary.textContent = selected.length ? selected.join(", ") : "Select CC Contacts";
    });
  });

  document.removeEventListener("click", closeServiceDropdownsOnOutsideClick);
  document.addEventListener("click", closeServiceDropdownsOnOutsideClick);

  document.querySelectorAll("[data-action='retry-load']").forEach((button) => {
    button.addEventListener("click", async () => {
      const generation = ++loadGeneration;
      state.loading = true;
      state.loadError = "";
      render();
      try {
        await withTimeout(loadPortalData(), "Account data loading");
        await restorePageAfterPortalLoad({ fallbackToCurrent: true });
      } catch (error) {
        await returnToSignInAfterLoadFailure(error, "Retry account loading");
        return;
      } finally {
        if (generation !== loadGeneration) return;
        state.loading = false;
        render();
      }
    });
  });

  document.querySelectorAll("[data-page]").forEach((button) => {
    button.addEventListener("click", async () => {
      await goToPage(button.dataset.page);
    });
  });

  document.querySelectorAll("[data-open-request]").forEach((row) => {
    row.addEventListener("click", async () => {
      await goToPage("admin-request-detail", { requestId: row.dataset.openRequest });
    });
  });

  document.querySelectorAll("[data-open-client]").forEach((row) => {
    row.addEventListener("click", async (event) => {
      if (event.target.closest("button, a")) return;
      await goToPage("admin-client-detail", { clientId: row.dataset.openClient });
    });
  });

  document.querySelectorAll("[data-admin-message-request]").forEach((button) => {
    button.addEventListener("click", async () => {
      await goToPage("admin-messages", { requestId: button.dataset.adminMessageRequest });
    });
  });

  document.querySelectorAll("[data-open-request-messages]").forEach((button) => {
    button.addEventListener("click", async () => {
      await goToPage("admin-messages", { requestId: button.dataset.openRequestMessages });
    });
  });

  document.querySelectorAll("[data-client-message-request]").forEach((button) => {
    button.addEventListener("click", async () => {
      await goToPage("messages", { requestId: button.dataset.clientMessageRequest });
    });
  });

  document.querySelectorAll("[data-client-message-request-select]").forEach((select) => {
    select.addEventListener("change", async () => {
      await goToPage("messages", { requestId: select.value });
    });
  });

  document.querySelectorAll("[data-client-open-request]").forEach((card) => {
    card.addEventListener("click", async (event) => {
      if (event.target.closest("form, button, input, textarea, select, a")) return;
      await goToPage("request", { requestId: card.dataset.clientOpenRequest });
    });
  });

  document.querySelectorAll("[data-select-signature-document]").forEach((button) => {
    button.addEventListener("click", () => {
      state.selectedSignatureDocumentId = state.selectedSignatureDocumentId === button.dataset.selectSignatureDocument
        ? null
        : button.dataset.selectSignatureDocument;
      render();
    });
  });

  document.querySelectorAll("[data-select-sent-proposal]").forEach((button) => {
    button.addEventListener("click", () => {
      state.selectedSignatureDocumentId = button.dataset.selectSentProposal;
      state.proposalViewer = { documentId: button.dataset.selectSentProposal };
      render();
    });
  });

  document.querySelectorAll("[data-open-proposal-view]").forEach((button) => {
    button.addEventListener("click", () => {
      const value = button.dataset.openProposalView;
      state.proposalViewer = value === "draft" ? "draft" : { documentId: value };
      render();
    });
  });

  document.querySelectorAll("[data-close-proposal-view]").forEach((button) => {
    button.addEventListener("click", () => {
      state.proposalViewer = null;
      render();
    });
  });

  document.querySelector("[data-proposal-viewer-backdrop]")?.addEventListener("click", (event) => {
    if (event.target !== event.currentTarget) return;
    state.proposalViewer = null;
    render();
  });

  document.querySelectorAll("[data-open-active-messages]").forEach((button) => {
    button.addEventListener("click", async () => {
      await goToPage("messages", { requestId: state.activeRequest?.id });
    });
  });

  document.querySelectorAll("[data-open-active-request]").forEach((button) => {
    button.addEventListener("click", async () => {
      await goToPage("request", { requestId: state.activeRequest?.id });
    });
  });

  document.querySelectorAll("[data-jump]").forEach((link) => {
    link.addEventListener("click", (event) => {
      event.preventDefault();
      goToPage(link.dataset.jump);
    });
  });

  const signatureClientSelect = document.querySelector("[data-signature-client-select]");
  if (signatureClientSelect) {
    signatureClientSelect.addEventListener("change", (event) => {
      const form = event.currentTarget.closest("form");
      if (form) signatureDraftFromForm(form);
      state.signatureClientSelection = event.currentTarget.value;
      state.signatureDraft = {
        ...state.signatureDraft,
        clientId: state.signatureClientSelection,
        requestId: "",
        proposalGenerated: false,
        agreementPrompt: "",
        proposalComposerDraft: "",
        proposalMessages: [],
        recipients: [{ name: "", email: "", role: "signer" }]
      };
      render();
    });
  }

  const signatureRequestSelect = document.querySelector("[data-signature-request-select]");
  if (signatureRequestSelect) {
    signatureRequestSelect.addEventListener("change", (event) => {
      const form = event.currentTarget.closest("form");
      if (form) signatureDraftFromForm(form);
      state.activeRequest = state.requests.find((request) => request.id === event.currentTarget.value) || state.activeRequest;
      state.signatureClientSelection = state.activeRequest?.client_id || state.signatureClientSelection;
      if (event.currentTarget.value) {
        state.signatureDraft = {
          ...state.signatureDraft,
          ...agreementDefaultsForRequest(state.activeRequest),
          proposalGenerated: false,
          agreementPrompt: "",
          proposalComposerDraft: "",
          proposalMessages: []
        };
        setSignatureDraftRecipientsForRequest(state.activeRequest);
      }
      render();
    });
  }

  document.querySelectorAll("[data-remove-signature-recipient]").forEach((button) => {
    button.addEventListener("click", () => {
      const form = button.closest("form");
      const row = button.closest(".signature-recipient-row");
      row?.remove();
      if (form) signatureDraftFromForm(form);
    });
  });

  const signatureDocumentForm = document.getElementById("signatureDocumentForm");
  if (signatureDocumentForm) {
    signatureDocumentForm.querySelector("[data-send-proposal-message]")?.addEventListener("click", () => {
      const formData = new FormData(signatureDocumentForm);
      const request = state.requests.find((item) => item.id === formData.get("requestId"));
      const notes = String(formData.get("proposalPrompt") || "").trim();
      const generated = parseAgreementNotes(notes, request);
      if (!generated || !notes) {
        showToast("Add the proposal details first.");
        return;
      }
      signatureDraftFromForm(signatureDocumentForm);
      const updatedDetails = mergeProposalMessage(state.signatureDraft, generated, notes, request);
      const previousMessages = Array.isArray(state.signatureDraft?.proposalMessages) ? state.signatureDraft.proposalMessages : [];
      state.signatureDraft = {
        ...state.signatureDraft,
        title: "Accessibility Services Proposal",
        documentPurpose: "signature",
        agreementPrompt: notes,
        proposalComposerDraft: "",
        proposalGenerated: true,
        ...updatedDetails,
        proposalMessages: [
          ...previousMessages,
          { role: "user", text: notes },
          { role: "assistant", text: "I updated the proposal preview with those details. Review the document and use Edit preview for any final changes." }
        ],
        recipients: state.signatureDraft?.recipients?.length
          ? state.signatureDraft.recipients
          : signatureRecipientDefaults(request)
      };
      render();
      showToast(state.signatureDraft.proposalMessages.length > 2 ? "Proposal updated." : "Proposal preview generated.");
    });

    signatureDocumentForm.addEventListener("input", (event) => {
      const inlineField = event.target?.closest?.("[data-proposal-inline-edit]");
      if (inlineField) {
        const fieldName = inlineField.dataset.proposalInlineEdit;
        const value = inlineField.innerText || "";
        const hiddenField = signatureDocumentForm.querySelector(`input[type="hidden"][name="${fieldName}"]`);
        if (hiddenField) hiddenField.value = value;
        state.signatureDraft = { ...state.signatureDraft, [fieldName]: value };
        document.querySelectorAll(`[data-proposal-inline-edit="${fieldName}"]`).forEach((element) => {
          if (element !== inlineField && element.innerText !== value) element.innerText = value;
        });
        return;
      }
      signatureDraftFromForm(signatureDocumentForm);
    });
    signatureDocumentForm.addEventListener("change", (event) => {
      if (event.target?.type === "file") return;
      signatureDraftFromForm(signatureDocumentForm);
    });
    signatureDocumentForm.addEventListener("submit", async (event) => {
      event.preventDefault();
      const form = event.currentTarget;
      signatureDraftFromForm(form);
      const formData = new FormData(form);
      const request = state.requests.find((item) => item.id === formData.get("requestId"));
      const names = formData.getAll("recipientName").map(String);
      const emails = formData.getAll("recipientEmail").map(String);
      const requiresSignature = formData.get("documentPurpose") !== "view";
      const recipients = emails.map((email, index) => ({
        name: names[index],
        email,
        role: requiresSignature ? "signer" : "viewer"
      })).filter((recipient) => recipient.name && recipient.email).slice(0, 1);

      if (!request) {
        showToast("Select a request.");
        return;
      }
      if (!state.signatureDraft?.proposalGenerated) {
        showToast("Generate the proposal preview before sending.");
        return;
      }
      if (!recipients.length) {
        showToast("Add at least one recipient.");
        return;
      }

      await withActionLock("signature-document-form", form, async () => {
        try {
          const agreementDetails = agreementDetailsFromFormData(formData, request);
          const createdDocument = await createSignatureDocument({
            request,
            profile: state.profile,
            title: formData.get("title") || "Accessibility Services Proposal",
            agreementText: JSON.stringify(agreementDetails),
            recipients,
            requiresSignature
          });
          state.signatureDocuments = await loadSignatureDocuments();
          state.messagesByRequest[request.id] = await loadMessages(request.id);
          if (state.activeRequest?.id === request.id) state.messages = state.messagesByRequest[request.id];
          state.signatureDraft = {};
          form.reset();
          const failedEmail = (createdDocument.email_results || []).find((result) => result && result.sent === false);
          const messageWarning = createdDocument.message_result?.created === false ? " Message entry was not created." : "";
          showToast(failedEmail
            ? `Proposal saved, but email was not sent: ${failedEmail.reason || "email service failed."}${messageWarning}`
            : `${requiresSignature ? "Proposal sent for review." : "Proposal sent for viewing."}${messageWarning}`
          );
          render();
        } catch (error) {
          showAppError(error, "Send for signature");
        }
      });
    });
  }

  const clientForm = document.getElementById("clientForm");
  if (clientForm) {
    const saveClientDraft = (event) => {
      if (!event.target?.name) return;
      state.clientDraft[event.target.name] = event.target.value;
      const cancelButton = clientForm.querySelector("[data-cancel-client-edit]");
      if (cancelButton && hasClientDraft()) cancelButton.hidden = false;
    };
    clientForm.addEventListener("input", (event) => {
      saveClientDraft(event);
    });
    clientForm.addEventListener("change", (event) => {
      saveClientDraft(event);
    });
    clientForm.addEventListener("submit", async (event) => {
      event.preventDefault();
      const values = Object.fromEntries(new FormData(event.currentTarget));
      const ccFullName = String(values.ccFullName || "").trim();
      const ccEmail = normalizeEmail(values.ccEmail);
      delete values.ccFullName;
      delete values.ccEmail;

      if (ccFullName && !ccEmail) {
        showToast("Enter CC contact email before saving.");
        return;
      }

      await withActionLock("client-form", event.currentTarget, async () => {
        try {
        if (state.editingClientId) {
          await updateClient(state.editingClientId, values);
          if (ccEmail) {
            await createClientContact({
              clientId: state.editingClientId,
              fullName: ccFullName || ccEmail,
              email: ccEmail
            });
            state.clientContacts = await loadClientContacts();
          }
          state.editingClientId = null;
          clearClientDraft();
          showToast(ccEmail ? "Client updated and CC contact added." : "Client updated.");
        } else {
          const createdClient = await createClient(values);
          if (ccEmail && createdClient?.id) {
            await createClientContact({
              clientId: createdClient.id,
              fullName: ccFullName || ccEmail,
              email: ccEmail
            });
            state.clientContacts = await loadClientContacts();
          }
          clearClientDraft();
          if (createdClient?.account_setup_email?.sent) {
            showToast(ccEmail ? "Client and CC contact created. Invite emails sent." : "Client created and invite email sent.");
          } else if (createdClient?.account_setup_email?.reason) {
            showToast(`Client created, but invite email was not sent: ${createdClient.account_setup_email.reason}`);
          } else {
            showToast(ccEmail ? "Client and CC contact created." : "Client created.");
          }
        }
        state.clients = await loadClients();
        render();
        } catch (error) {
          showAppError(error, "Save client");
        }
      });
    });
  }

  document.querySelectorAll("[data-client-cc-contact-form]").forEach((clientCcContactForm) => {
    clientCcContactForm.addEventListener("click", (event) => {
      event.stopPropagation();
    });
    clientCcContactForm.addEventListener("input", (event) => {
      const form = event.currentTarget;
      const requestId = form.dataset.requestId || state.activeRequest?.id;
      if (!requestId || !event.target?.name) return;
      state.ccContactDrafts[requestId] = {
        ...ccContactDraft(requestId),
        [event.target.name]: event.target.value
      };
    });
    clientCcContactForm.querySelector("[data-cancel-request-cc-contact]")?.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      const form = event.currentTarget.closest("[data-client-cc-contact-form]");
      const requestId = form?.dataset.requestId || state.activeRequest?.id;
      clearCcContactDraft(requestId);
      form?.reset();
      render();
    });
    clientCcContactForm.addEventListener("submit", async (event) => {
      event.preventDefault();
      event.stopPropagation();
      const form = event.currentTarget;
      const requestId = form.dataset.requestId || state.activeRequest?.id;
      if (!requestId) return;
      const values = Object.fromEntries(new FormData(form));
      const contactName = String(values.name || "").trim();
      const contactEmail = normalizeEmail(values.email);
      if (!contactEmail) {
        showToast("Enter a CC contact email.");
        return;
      }

      await withActionLock(`client-cc-${requestId}`, form, async () => {
        try {
          const result = await addRequestClientContact(requestId, {
            name: contactName,
            email: contactEmail
          });
          state.requestClientContacts = await loadRequestClientContacts();
          clearCcContactDraft(requestId);
          form.reset();

          if (!result?.already_exists) {
            const displayName = contactName || contactEmail;
            try {
              await createMessage(
                requestId,
                state.profile.id,
                `${state.profile.full_name || "A client contact"} added ${displayName} as a CC contact.`,
                { excludeEmails: [contactEmail] }
              );
              if (state.activeRequest?.id === requestId) {
                await refreshActiveMessages({ markRead: true });
              }
            } catch (messageError) {
              console.warn("[Clients] CC contact activity message failed", messageError);
            }
          }

          if (result?.already_exists && result?.cc_contact_email?.sent) {
            showToast("CC contact was already added. Setup email was sent again.");
          } else if (result?.already_exists) {
            showToast("CC contact is already on this request.");
          } else if (result?.cc_contact_email?.type === "account_setup") {
            showToast("CC contact added and setup email sent.");
          } else {
            showToast("CC contact added and access email sent.");
          }
          render();
        } catch (error) {
          showAppError(error, "Add request CC contact");
        }
      });
    });
  });

  document.querySelectorAll("[data-edit-client]").forEach((button) => {
    button.addEventListener("click", (event) => {
      event.stopPropagation();
      state.editingClientId = button.dataset.editClient;
      clearClientDraft();
      state.page = "admin-clients";
      rememberPage();
      render();
      window.scrollTo({ top: 0, behavior: "smooth" });
    });
  });

  const cancelClientEdit = document.querySelector("[data-cancel-client-edit]");
  if (cancelClientEdit) {
    cancelClientEdit.addEventListener("click", () => {
      state.editingClientId = null;
      clearClientDraft();
      render();
    });
  }

  document.querySelectorAll("[data-delete-client]").forEach((button) => {
    button.addEventListener("click", async (event) => {
      event.stopPropagation();
      if (!canDelete()) {
        showToast("Only owner/admin can delete clients.");
        return;
      }
      const client = state.clients.find((item) => item.id === button.dataset.deleteClient);
      if (!window.confirm(`Delete ${client?.name || "this client"} and its related requests?`)) return;

      await withActionLock(`delete-client-${button.dataset.deleteClient}`, button, async () => {
        try {
          await deleteClient(button.dataset.deleteClient);
          state.clients = await loadClients();
          state.requests = await loadRequests();
          if (state.editingClientId === button.dataset.deleteClient) state.editingClientId = null;
          if (state.selectedClientId === button.dataset.deleteClient) {
            state.selectedClientId = null;
            state.page = "admin-clients";
            rememberPage();
          }
          showToast("Client deleted.");
          render();
        } catch (error) {
          showAppError(error, "Delete client");
        }
      });
    });
  });

  const requestForm = document.getElementById("requestForm");
  if (requestForm) {
    const saveRequestDraft = () => {
      if (state.editingRequestId) return;
      state.requestDraft = requestDraftFromForm(requestForm);
      state.requestClientSelection = state.requestDraft.clientId || null;
      const cancelButton = requestForm.querySelector("[data-cancel-request-edit]");
      if (cancelButton && hasRequestDraft()) cancelButton.hidden = false;
    };
    requestForm.addEventListener("input", saveRequestDraft);
    requestForm.addEventListener("change", saveRequestDraft);
    requestForm.addEventListener("submit", async (event) => {
      event.preventDefault();
      const formData = new FormData(event.currentTarget);
      const values = Object.fromEntries(formData);
      const selectedServices = formData.getAll("services").map(String);
      const assignedProfileIds = formData.getAll("assignedProfileIds").map(String);
      const selectedCcEmails = new Set(formData.getAll("ccContactEmails").map(normalizeEmail));
      const clientContacts = organizationContacts(values.clientId)
        .filter((contact) => selectedCcEmails.has(normalizeEmail(contact.email)))
        .map((contact) => ({
          name: contact.full_name || "",
          email: contact.email
        }));
      if (!selectedServices.length) {
        showToast("Select at least one service.");
        return;
      }
      await withActionLock("request-form", event.currentTarget, async () => {
        try {
        const previousRequest = state.requests.find((request) => request.id === state.editingRequestId);
        const previousAssignedIds = state.editingRequestId ? assignedProfileIdsForRequest(state.editingRequestId) : [];
        const previousContacts = state.editingRequestId ? clientContactsForRequest(state.editingRequestId) : [];
        const addedCcEmails = newContactEmails(previousContacts, clientContacts);
        const requestPayload = {
          clientId: values.clientId,
          title: values.title,
          description: values.description,
          serviceType: selectedServices.join(", "),
          dueDate: values.dueDate,
          ownerId: state.profile.id,
          status: values.status
        };

        if (state.editingRequestId) {
          await updateRequest(state.editingRequestId, requestPayload);
          await setRequestAssignments(state.editingRequestId, assignedProfileIds, state.profile.id);
          await setRequestClientContacts(state.editingRequestId, clientContacts);
          if (previousRequest) {
            const updateMessage = requestUpdateMessage({
              previousRequest,
              nextRequest: requestPayload,
              previousAssignedIds,
              nextAssignedIds: assignedProfileIds,
              previousContacts,
              nextContacts: clientContacts,
              actorName: state.profile.full_name
            });
            if (updateMessage) {
              await createMessage(state.editingRequestId, state.profile.id, updateMessage, {
                excludeEmails: addedCcEmails
              });
            }
          }
          state.editingRequestId = null;
          clearRequestDraft();
          showToast("Request updated.");
        } else {
          const createdRequest = await createRequest(requestPayload);
          await setRequestAssignments(createdRequest.id, assignedProfileIds, state.profile.id);
          await setRequestClientContacts(createdRequest.id, clientContacts);
          await createMessage(
            createdRequest.id,
            state.profile.id,
            serviceVersionMessage({ versionLabel: "Services v1", services: requestPayload.serviceType }),
            { notify: false }
          );
          clearRequestDraft();
          showToast("Request created and linked to the selected client.");
        }
        await loadPortalData();
        render();
        } catch (error) {
          showAppError(error, "Save request");
        }
      });
    });
  }

  document.querySelectorAll("[data-edit-request]").forEach((button) => {
    button.addEventListener("click", async (event) => {
      event.stopPropagation();
      await withActionLock(`edit-request-${button.dataset.editRequest}`, button, async () => {
        try {
          const [team, assignments] = await Promise.all([
            loadTeam(),
            loadRequestAssignments()
          ]);
          state.team = team;
          state.requestAssignments = assignments;
          clearRequestDraft();
          state.editingRequestId = button.dataset.editRequest;
          state.requestClientSelection = state.requests.find((request) => request.id === state.editingRequestId)?.client_id || null;
          state.page = "admin-requests";
          rememberPage();
          render();
          window.scrollTo({ top: 0, behavior: "smooth" });
        } catch (error) {
          showAppError(error, "Load request edit form");
        }
      });
    });
  });

  const cancelRequestEdit = document.querySelector("[data-cancel-request-edit]");
  if (cancelRequestEdit) {
    cancelRequestEdit.addEventListener("click", () => {
      state.editingRequestId = null;
      clearRequestDraft();
      render();
    });
  }

  const requestClientSelect = document.querySelector("#requestForm select[name='clientId']");
  if (requestClientSelect) {
    requestClientSelect.addEventListener("change", (event) => {
      const form = event.currentTarget.closest("form");
      if (form && !state.editingRequestId) state.requestDraft = requestDraftFromForm(form);
      state.requestClientSelection = event.currentTarget.value;
      render();
    });
  }

  document.querySelectorAll("[data-delete-request]").forEach((button) => {
    button.addEventListener("click", async (event) => {
      event.stopPropagation();
      if (!canDelete()) {
        showToast("Only owner/admin can delete requests.");
        return;
      }
      const request = state.requests.find((item) => item.id === button.dataset.deleteRequest);
      if (!window.confirm(`Delete ${request ? displayRequestNumber(request) : "this request"}?`)) return;

      await withActionLock(`delete-request-${button.dataset.deleteRequest}`, button, async () => {
        try {
          await deleteRequest(button.dataset.deleteRequest);
          state.requests = await loadRequests();
          state.activeRequest = state.requests[0] || null;
          state.selectedRequestId = null;
          state.editingRequestId = null;
          state.requestClientSelection = null;
          state.page = "admin-requests";
          rememberPage();
          showToast("Request deleted.");
          render();
        } catch (error) {
          showAppError(error, "Delete request");
        }
      });
    });
  });

  const teamForm = document.getElementById("teamForm");
  if (teamForm) {
    teamForm.addEventListener("submit", async (event) => {
      event.preventDefault();
      const values = Object.fromEntries(new FormData(event.currentTarget));
      await withActionLock("team-form", event.currentTarget, async () => {
        try {
        if (state.editingTeamId) {
          await updateTeamMember(state.editingTeamId, values);
          state.editingTeamId = null;
          showToast("Team member updated.");
        } else {
          await createTeamMember(values);
          showToast("Team member added.");
        }
        state.team = await loadTeam();
        render();
        } catch (error) {
          showAppError(error, "Save team member");
        }
      });
    });
  }

  document.querySelectorAll("[data-edit-team]").forEach((button) => {
    button.addEventListener("click", () => {
      state.editingTeamId = button.dataset.editTeam;
      render();
      window.scrollTo({ top: 0, behavior: "smooth" });
    });
  });

  const cancelTeamEdit = document.querySelector("[data-cancel-team-edit]");
  if (cancelTeamEdit) {
    cancelTeamEdit.addEventListener("click", () => {
      state.editingTeamId = null;
      render();
    });
  }

  document.querySelectorAll("[data-delete-team]").forEach((button) => {
    button.addEventListener("click", async (event) => {
      event.stopPropagation();
      if (button.disabled) return;
      if (!canDelete()) {
        showToast("Only owner/admin can delete team members.");
        return;
      }
      const member = state.team.find((item) => item.id === button.dataset.deleteTeam);
      if (!window.confirm(`Delete ${member?.full_name || "this team member"}?`)) return;

      await withActionLock(`delete-team-${button.dataset.deleteTeam}`, button, async () => {
        try {
          await deleteTeamMember(button.dataset.deleteTeam);
          state.team = await loadTeam();
          showToast("Team member deleted.");
          render();
        } catch (error) {
          showAppError(error, "Delete team member");
        }
      });
    });
  });

  const profileForm = document.getElementById("profileForm");
  if (profileForm) {
    profileForm.addEventListener("submit", async (event) => {
      event.preventDefault();
      const values = Object.fromEntries(new FormData(event.currentTarget));
      await withActionLock("profile-form", event.currentTarget, async () => {
        try {
        const updatedProfile = await updateOwnProfile(values);
        if (updatedProfile) state.profile = updatedProfile;
        showToast("Profile updated.");
        render();
        } catch (error) {
          showAppError(error, "Update profile");
        }
      });
    });
  }

  attachFileInputRemovers();

  document.querySelectorAll("[data-message-draft]").forEach((textarea) => {
    textarea.addEventListener("input", () => {
      state.messageDrafts[textarea.dataset.messageDraft] = textarea.value;
    });
  });

  const form = document.getElementById("messageForm");
  if (form) {
    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      if (event.currentTarget.dataset.submitting === "true") return;
      const message = document.getElementById("messageText").value.trim();
      const file = document.getElementById("attachmentInput").files[0];

      if (!message && !file) {
        showToast("Write a message or choose an attachment first.");
        return;
      }

      await withActionLock(`message-${state.activeRequest.id}`, event.currentTarget, async () => {
        try {
          event.currentTarget.dataset.submitting = "true";
          if (message) await createMessage(state.activeRequest.id, state.profile.id, message);
          if (file) await uploadRequestAttachment({ request: state.activeRequest, profile: state.profile, file });
          clearMessageDraft(state.activeRequest.id);
          await refreshActiveMessages({ markRead: true });
          showToast(message ? "Message sent." : "Attachment uploaded.");
          render();
        } catch (error) {
          showAppError(error, "Send client message");
        } finally {
          delete event.currentTarget.dataset.submitting;
        }
      });
    });
  }

  const internalMessageForm = document.getElementById("internalMessageForm");
  if (internalMessageForm) {
    internalMessageForm.addEventListener("submit", async (event) => {
      event.preventDefault();
      if (event.currentTarget.dataset.submitting === "true") return;
      const message = document.getElementById("internalMessageText").value.trim();
      const file = document.getElementById("internalAttachmentInput").files[0];

      if (!message && !file) {
        showToast("Write a message or choose an attachment first.");
        return;
      }

      await withActionLock(`internal-message-${state.activeRequest.id}`, event.currentTarget, async () => {
        try {
          event.currentTarget.dataset.submitting = "true";
          if (message) await createMessage(state.activeRequest.id, state.profile.id, message);
          if (file) await uploadRequestAttachment({ request: state.activeRequest, profile: state.profile, file });
          clearMessageDraft(state.activeRequest.id);
          await refreshActiveMessages({ markRead: true });
          showToast(message ? "Message sent." : "Attachment uploaded.");
          render();
        } catch (error) {
          showAppError(error, "Send internal message");
        } finally {
          delete event.currentTarget.dataset.submitting;
        }
      });
    });
  }

  document.querySelectorAll("[data-file-id]").forEach((button) => {
    button.addEventListener("click", async () => {
      const deliverable = state.deliverables.find((item) => item.files?.id === button.dataset.fileId);
      if (!deliverable?.files) return;
      try {
        const url = await createSignedDownload(deliverable.files);
        downloadFromUrl(url, deliverable.files.file_name || deliverable.title || "deliverable");
      } catch (error) {
        showAppError(error, "Download deliverable");
      }
    });
  });

  document.querySelectorAll("[data-attachment-id]").forEach((button) => {
    button.addEventListener("click", async () => {
      const message = state.messages.find((item) => String(item.attachment?.id) === String(button.dataset.attachmentId));
      if (!message?.attachment) return;
      try {
        const url = await createSignedDownload(message.attachment);
        downloadFromUrl(url, message.attachment.file_name || "attachment");
      } catch (error) {
        showAppError(error, "Download attachment");
      }
    });
  });

  document.querySelectorAll("[data-action='toggle-message']").forEach((button) => {
    button.addEventListener("click", () => {
      const text = button.closest(".message-card")?.querySelector("[data-message-text]");
      if (!text) return;
      const isCollapsed = text.classList.toggle("is-collapsed");
      button.textContent = isCollapsed ? "Show More" : "Show Less";
    });
  });

  const signOutButton = document.getElementById("signOut");
  if (signOutButton) {
    signOutButton.addEventListener("click", handleLogout);
  }

  const passwordForm = document.getElementById("passwordForm");
  if (passwordForm) {
    passwordForm.addEventListener("submit", async (event) => {
      event.preventDefault();
      const form = event.currentTarget;
      const values = Object.fromEntries(new FormData(form));
      if (values.password !== values.confirmPassword) {
        showToast("Passwords do not match.");
        return;
      }
      try {
        await updatePassword(values.password);
        state.profile = { ...state.profile, must_change_password: false };
        state.showPasswordForm = false;
        clearPasswordRecoveryUrl();
        form.reset();
        showToast("Password updated.");
        render();
      } catch (error) {
        showAppError(error);
      }
    });
  }
}

function attachFileInputRemovers() {
  document.querySelectorAll("input[type='file']").forEach((input) => {
    const row = document.querySelector(`[data-selected-file-for="${input.id}"]`);
    const fileName = row?.querySelector("[data-selected-file-name]");
    const updateSelectedFile = () => {
      const file = input.files?.[0];
      if (!row || !fileName) return;
      if (file) {
        fileName.textContent = file.name;
        row.hidden = false;
      } else {
        fileName.textContent = "";
        row.hidden = true;
      }
    };
    input.addEventListener("change", updateSelectedFile);
    updateSelectedFile();
  });

  document.querySelectorAll("[data-clear-file]").forEach((button) => {
    button.addEventListener("click", () => {
      const input = document.getElementById(button.dataset.clearFile);
      if (!input) return;
      input.value = "";
      input.dispatchEvent(new Event("change", { bubbles: true }));
      input.focus();
    });
  });
}

function attachPasswordToggles() {
  document.querySelectorAll("[data-toggle-password]").forEach((checkbox) => {
    checkbox.addEventListener("change", () => {
      const scope = checkbox.closest("form") || document;
      const fieldNames = String(checkbox.dataset.togglePassword || "")
        .split(",")
        .map((name) => name.trim())
        .filter(Boolean);
      fieldNames.forEach((name) => {
        const input = scope.querySelector(`[name="${name}"]`);
        if (!input) return;
        input.type = checkbox.checked ? "text" : "password";
      });
    });
  });
}

async function handleLogout() {
  if (!window.confirm("Are you sure you want to log out?")) return;

  try {
    await signOut();
    resetSessionState();
    localStorage.removeItem(LAST_PAGE_KEY);
    if (isLocalAutoLoginMode()) {
      state.loading = true;
      render();
      state.session = await getSession();
      await loadPortalData();
      state.page = defaultPage();
      state.loading = false;
      showToast("Local test session restored.");
      render();
      return;
    }
    render();
  } catch (error) {
    showAppError(error);
  }
}

function resetSessionState() {
  state.session = null;
  state.profile = null;
  state.requests = [];
  state.activeRequest = null;
  state.messages = [];
  state.messagesByRequest = {};
  state.unreadCounts = {};
  state.deliverables = [];
  state.history = [];
  state.clients = [];
  state.clientContacts = [];
  state.team = [];
  state.requestAssignments = [];
  state.requestClientContacts = [];
  state.signatureDocuments = [];
  state.publicSignature = null;
  state.publicSignatureToken = "";
  state.messageDrafts = {};
  state.clientDraft = {};
  state.requestDraft = {};
  state.ccContactDrafts = {};
  state.signatureDraft = {};
  state.pendingActions = new Set();
  state.selectedRequestId = null;
  state.selectedSignatureDocumentId = null;
  state.requestClientSelection = null;
  state.signatureClientSelection = null;
  state.editingClientId = null;
  state.editingRequestId = null;
  state.editingTeamId = null;
  state.showPasswordForm = false;
  state.authView = "signin";
  state.loadError = "";
  state.page = "dashboard";
}

onAuthStateChange((session, event) => {
  window.setTimeout(async () => {
    const currentUserId = state.session?.user?.id || null;
    const nextUserId = session?.user?.id || null;

    if (event === "INITIAL_SESSION") {
      return;
    }

    if (event === "TOKEN_REFRESHED" || (event === "SIGNED_IN" && state.profile && currentUserId === nextUserId)) {
      state.session = session;
      return;
    }

    const generation = ++loadGeneration;
    state.session = session;
    const recoveryFlow = isPasswordRecoveryFlow(event);
    if (session) {
      if (recoveryFlow) {
        state.authView = "reset-password";
        state.loading = false;
        state.loadError = "";
        render();
        return;
      }
      const hasExistingPortal = Boolean(state.profile);
      state.loading = !hasExistingPortal;
      state.loadError = "";
      if (!hasExistingPortal) render();
      try {
        const pageBeforeRefresh = state.page;
        const requestBeforeRefresh = state.activeRequest?.id;
        await withTimeout(loadPortalData(), "Account data loading");
        if (hasExistingPortal && pageIsAllowed(pageBeforeRefresh)) {
          state.page = pageBeforeRefresh;
          if (requestBeforeRefresh) {
            state.activeRequest = state.requests.find((request) => request.id === requestBeforeRefresh) || state.activeRequest;
            state.selectedRequestId = state.activeRequest?.id || null;
          }
        } else {
          await restorePageAfterPortalLoad();
        }
        syncBrowserHistory({ replace: true });
      } catch (error) {
        await returnToSignInAfterLoadFailure(error, `${event || "Auth"} account loading`, {
          keepCurrentPortal: hasExistingPortal
        });
        return;
      } finally {
        if (generation !== loadGeneration) return;
        state.loading = false;
        render();
      }
    } else {
      if (recoveryFlow) {
        state.session = null;
        state.authView = "reset-password";
        state.loadError = "";
        state.loading = false;
        render();
        return;
      }
      resetSessionState();
      state.loadError = "";
      state.loading = false;
      render();
    }
  }, 0);
});

window.addEventListener("popstate", async () => {
  if (!state.session || state.loading) return;
  const params = new URLSearchParams(window.location.search);
  const page = params.get("page") || defaultPage();
  const requestId = params.get("request");
  if (!pageIsAllowed(page) || (pageUsesRequestParam(page) && !requestId)) {
    await goToPage(defaultPage(), { replace: true, scroll: false });
    return;
  }
  if (requestId && pageUsesRequestParam(page)) {
    await setActiveRequest(requestId, { page, markRead: isConversationPage(page) });
  } else {
    state.page = page;
    rememberPage();
  }
  render();
});

window.setInterval(pollActiveMessages, MESSAGE_POLL_MS);
window.setInterval(() => refreshUnreadCounts(), UNREAD_POLL_MS);
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") {
    pollActiveMessages();
    refreshUnreadCounts();
  }
});

boot();
