import {
  completePasswordRecoverySession,
  createClient,
  createMessage,
  createRequest,
  createSignedDownload,
  createTeamMember,
  deleteClient,
  deleteRequest,
  deleteTeamMember,
  getSession,
  isLocalAutoLoginMode,
  loadClients,
  loadClosedRequests,
  loadDeliverables,
  loadMessages,
  loadProfile,
  loadRequestAssignments,
  loadRequestClientContacts,
  loadRequests,
  loadTeam,
  onAuthStateChange,
  sendMagicLink,
  sendPasswordReset,
  setRequestClientContacts,
  setRequestAssignments,
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
  team: [],
  requestAssignments: [],
  requestClientContacts: [],
  messageDrafts: {},
  clientDraft: {},
  pendingActions: new Set(),
  selectedRequestId: null,
  editingClientId: null,
  editingRequestId: null,
  editingTeamId: null,
  showPasswordForm: false,
  authView: isPasswordRecoveryFlow() ? "reset-password" : "signin",
  page: "messages",
  loading: true,
  loadError: "",
  toast: ""
};

const adminPages = ["admin-dashboard", "admin-clients", "admin-requests", "admin-request-detail", "admin-messages", "admin-team", "admin-settings"];
const clientPages = ["messages", "dashboard", "request", "account"];
const managementRoles = ["owner", "project_manager"];
const workRoles = ["developer", "reviewer", "assignee"];
const internalRoles = [...managementRoles, ...workRoles];
const workPortalPages = ["admin-dashboard", "admin-requests", "admin-request-detail", "admin-messages", "admin-team", "admin-settings"];
const LOAD_TIMEOUT_MS = 20000;
const MESSAGE_POLL_MS = 8000;
const MESSAGE_PRELOAD_LIMIT = 6;
const LAST_PAGE_KEY = "requestManagementLastPage";
const LAST_REQUEST_KEY = "requestManagementLastRequest";
const serviceCatalog = [
  "WCAG 2.1 AA Audit",
  "VPAT / ACR creation",
  "Accessibility remediation support",
  "Validation and regression testing",
  "Accessibility Tracker setup"
];
let loadGeneration = 0;
let messagePollInFlight = false;

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
  return isInternal() ? "admin-requests" : "dashboard";
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

function rememberPage() {
  if (pageIsAllowed(state.page)) {
    localStorage.setItem(LAST_PAGE_KEY, state.page);
  }
}

function currentRoute() {
  const params = new URLSearchParams();
  if (state.page) params.set("page", state.page);
  if (state.activeRequest?.id) params.set("request", state.activeRequest.id);
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
  if (event.target.closest?.("[data-service-dropdown], [data-assignment-dropdown]")) return;
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
    "Client Followers",
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

function messageDraftValue(requestId) {
  return escapeHtml(state.messageDrafts[requestId] || "");
}

function clearMessageDraft(requestId) {
  if (!requestId) return;
  delete state.messageDrafts[requestId];
}

function clientDraftValue(field, fallback = "") {
  return state.editingClientId ? fallback : (state.clientDraft[field] ?? fallback ?? "");
}

function clearClientDraft() {
  state.clientDraft = {};
}

function isConversationPage(page) {
  return page === "messages" || page === "admin-messages";
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
  state.activeRequest = state.requests.find((request) => request.id === requestId) || state.activeRequest || state.requests[0] || null;
  state.selectedRequestId = state.activeRequest?.id || null;
  rememberActiveRequest();
  state.messages = state.activeRequest ? (state.messagesByRequest[state.activeRequest.id] || await loadMessages(state.activeRequest.id)) : [];
  if (state.activeRequest) state.messagesByRequest[state.activeRequest.id] = state.messages;
  state.deliverables = state.activeRequest ? await loadDeliverables(state.activeRequest.id) : [];
  if (markRead && state.activeRequest) markRequestRead(state.activeRequest.id);
  if (page) {
    state.page = page;
    rememberPage();
  }
}

async function goToPage(page, { requestId, replace = false, scroll = true } = {}) {
  state.page = page;
  rememberPage();
  if (requestId) {
    await setActiveRequest(requestId, { page, markRead: isConversationPage(page) });
  } else if (isConversationPage(page) && state.activeRequest) {
    await setActiveRequest(state.activeRequest.id, { markRead: true });
  }
  syncBrowserHistory({ replace });
  render();
  if (scroll) window.scrollTo({ top: 0, behavior: "smooth" });
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

async function preloadUnreadCounts(generation = loadGeneration) {
  const requestsToLoad = state.requests
    .filter((request) => !state.messagesByRequest[request.id])
    .slice(0, MESSAGE_PRELOAD_LIMIT);
  if (!requestsToLoad.length) return;
  try {
    const messageEntries = await Promise.all(requestsToLoad.map(async (request) => [
      request.id,
      await loadMessages(request.id)
    ]));
    if (generation !== loadGeneration) return;
    messageEntries.forEach(([requestId, messages]) => {
      state.messagesByRequest[requestId] = messages;
    });
    calculateUnreadCounts();
    render();
  } catch (error) {
    console.warn(`[${APP_NAME}] Unable to preload unread counts`, error);
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
      const params = new URLSearchParams(window.location.search);
      const routePage = params.get("page");
      const routeRequestId = params.get("request");
      if (routePage && pageIsAllowed(routePage)) {
        state.page = routePage;
        if (routeRequestId) await setActiveRequest(routeRequestId, { page: routePage });
      } else {
        state.page = savedPage() || defaultPage();
      }
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
    clients,
    team,
    history
  ] = await Promise.all([
    loadRequests(),
    isInternal() ? safeLoad("Request assignment loading", loadRequestAssignments, []) : Promise.resolve([]),
    canAccessManagementPages() ? safeLoad("Request contact loading", loadRequestClientContacts, []) : Promise.resolve([]),
    isInternal() ? safeLoad("Client loading", loadClients, []) : Promise.resolve([]),
    isInternal() ? safeLoad("Team loading", loadTeam, []) : Promise.resolve([]),
    isInternal() ? safeLoad("History loading", loadClosedRequests, null) : Promise.resolve(null)
  ]);
  state.requestAssignments = requestAssignments;
  state.requestClientContacts = requestClientContacts;
  state.requests = isInternal() && !canAccessManagementPages()
    ? loadedRequests.filter((request) => state.requestAssignments.some((assignment) => (
      assignment.request_id === request.id && assignment.profile_id === state.profile.id
    )))
    : loadedRequests;
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
    const [messages, deliverables] = await Promise.all([
      safeLoad("Message loading", () => loadMessages(state.activeRequest.id), []),
      safeLoad("Deliverable loading", () => loadDeliverables(state.activeRequest.id), [])
    ]);
    state.messages = messages;
    state.messagesByRequest[state.activeRequest.id] = state.messages;
    calculateUnreadCounts();
    state.messages = state.messagesByRequest[state.activeRequest.id] || [];
    state.deliverables = deliverables;
  } else {
    state.messages = [];
    state.deliverables = [];
    calculateUnreadCounts();
  }

  preloadUnreadCounts(loadGeneration);
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

  document.getElementById("signinForm").addEventListener("submit", async (event) => {
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

  document.querySelector("[data-action='forgot-password']").addEventListener("click", () => {
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
  await loadPortalData();
  state.loading = false;
  state.page = savedPage() || defaultPage();
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
        <nav class="nav" aria-label="Client portal">
          ${navButton("dashboard", "Dashboard")}
          ${navButton("messages", `Messages ${unreadCount ? `<span class="count">${unreadCount}</span>` : ""}`)}
          ${navButton("account", "Account")}
          <button class="nav-logout" data-action="logout">Logout</button>
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

function formatClientContactsForInput(requestId) {
  return clientContactsForRequest(requestId)
    .map((contact) => contact.name ? `${contact.name} <${contact.email}>` : contact.email)
    .join("\n");
}

function parseClientContactInput(value) {
  return String(value || "")
    .split(/[\n,;]+/)
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => {
      const match = entry.match(/^(.*?)<([^>]+)>$/);
      if (match) {
        return {
          name: match[1].trim(),
          email: match[2].trim().toLowerCase()
        };
      }
      return {
        name: "",
        email: entry.toLowerCase()
      };
    })
    .filter((contact) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(contact.email));
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
          <button class="primary" type="submit">${editingClient ? "Update Client" : "Create Client"}</button>
          ${editingClient ? `<button class="secondary" type="button" data-cancel-client-edit>Cancel Edit</button>` : ""}
        </form>
      </section>
      <section class="card">
        <p class="section-label">Client List</p>
        ${clientStatusBar()}
        ${state.clients.map((client) => `
          <div class="admin-row">
            <div><strong>${escapeHtml(client.name)}</strong><span>${escapeHtml(client.primary_contact_name || "-")} · ${escapeHtml(client.primary_contact_email || "-")}</span></div>
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

function adminRequestsPage() {
  const editingRequest = state.requests.find((request) => request.id === state.editingRequestId);
  const requestStatus = editingRequest?.status || "new";
  const selectedAssignees = editingRequest ? assignedProfileIdsForRequest(editingRequest.id) : [];
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
            <label class="field"><span>Client</span><select name="clientId" required>${state.clients.map((client) => `<option value="${client.id}" ${editingRequest?.client_id === client.id ? "selected" : ""}>${escapeHtml(client.name)}</option>`).join("")}</select></label>
            <label class="field"><span>Title</span><input name="title" value="${escapeHtml(editingRequest?.title || "")}" required /></label>
            <label class="field wide"><span>Description</span><input name="description" value="${escapeHtml(editingRequest?.description || "")}" /></label>
            <label class="field wide">
              <span>Client Followers</span>
              <textarea name="clientFollowers" placeholder="name@example.com or Name <name@example.com>">${escapeHtml(editingRequest ? formatClientContactsForInput(editingRequest.id) : "")}</textarea>
              <small>Add extra client-side people who should receive updates for this request.</small>
            </label>
            ${serviceCheckboxes(editingRequest?.service_type || "")}
            ${assignmentCheckboxes(selectedAssignees)}
            <label class="field"><span>Due Date</span><input name="dueDate" type="date" value="${editingRequest?.due_date || ""}" /></label>
            <label class="field"><span>Status</span><select name="status">${requestStatusOptions(requestStatus)}</select></label>
            <div class="form-actions wide request-form-actions">
              <button class="primary" type="submit">${editingRequest ? "Update Request" : "Create Request"}</button>
              ${editingRequest ? `<button class="secondary" type="button" data-cancel-request-edit>Cancel Edit</button>` : ""}
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
      <div class="detail-grid">
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
            <div class="list-row">
              <strong>${escapeHtml(message.profiles?.full_name || "User")}</strong>
              <span>${escapeHtml(message.message)}</span>
            </div>
          `).join("") || `<p class="helper">No Messages for This Request Yet.</p>`}
          <button class="primary conversation-button" type="button" data-open-request-messages="${request.id}">Open Conversation</button>
        </section>
      </div>
    </section>
  `;
}

function adminMessagesPage() {
  const request = state.activeRequest || state.requests[0];
  if (!request) return emptyCard("Messages", "Create a request first, then messages will appear here.");

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
            <button class="${item.id === request.id ? "active" : ""}" data-chat-request="${item.id}">
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
          ${state.messages.map(messageCard).join("") || emptyMessage()}
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

  return `
    <section class="page">
      <div class="heading-accent">
        <h1>Messages</h1>
        <p class="subtitle message-subtitle">${escapeHtml(requestFromName)} · ${escapeHtml(requestTitle())}</p>
      </div>
      <div class="message-layout client-message-layout">
        ${clientRequestSwitcher()}
        <section>
          <div class="date-row conversation-row"><span>Conversation</span></div>
          ${state.messages.map(messageCard).join("") || emptyMessage()}
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
        </section>
      </div>
    </section>
  `;
}

function messageCard(message) {
  const isClient = message.profiles?.role === "client";
  const messageRequest = state.requests.find((request) => request.id === message.request_id) || state.activeRequest;
  const sender = isClient ? clientName(messageRequest?.client_id) : (message.profiles?.full_name || "Team Member");
  const attachment = message.attachment;
  const messageText = String(message.message || "");
  const isLongMessage = messageText.length > 420 || messageText.split(/\r?\n/).length > 8;
  return `
    <article class="message-card ${isClient ? "client" : "team"}">
      <div class="message-head">
        <span class="sender ${isClient ? "client-name" : ""}">${escapeHtml(sender)}</span>
        <time class="time">${formatTime(message.created_at)}</time>
      </div>
      ${attachment ? attachmentCard(attachment) : `
        <div class="message-text ${isLongMessage ? "is-collapsed" : ""}" data-message-text>${formatMessageText(messageText)}</div>
        ${isLongMessage ? `<button class="message-toggle" type="button" data-action="toggle-message">Show More</button>` : ""}
      `}
    </article>
  `;
}

function formatMessageText(text) {
  return escapeHtml(text)
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
    <aside class="card request-switcher message-request-list">
      <p class="section-label">Requests</p>
      ${state.requests.map((request) => `
        <button class="${request.id === state.activeRequest?.id ? "active" : ""}" data-client-request="${request.id}">
          <span>
            <strong>${escapeHtml(displayRequestNumber(request))}</strong>
            ${escapeHtml(request.title)}
          </span>
          ${requestUnreadBadge(request.id)}
        </button>
      `).join("")}
    </aside>
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
        ${accountRow("Due Date", formatDate(state.activeRequest.due_date))}
        ${accountRow("Created", formatDate(state.activeRequest.created_at))}
        <p class="card-note">${escapeHtml(state.activeRequest.description || "No description added.")}</p>
      </section>
      ${statusTracker(state.activeRequest)}
      <section class="card">
        <p class="section-label">Services in this request</p>
        ${requestServices(state.activeRequest).map((service) => `<div class="list-row">${escapeHtml(service)}</div>`).join("") || `<p class="helper">No Services Listed.</p>`}
      </section>
      <section class="card">
        <p class="section-label">Deliverables</p>
        ${state.deliverables.map(deliverableRow).join("") || `<p class="helper">No Deliverables Have Been Released Yet.</p>`}
      </section>
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
      <div class="deliverable-row">
        <span>${escapeHtml(displayRequestNumber(request))} · ${escapeHtml(request.service_type || "Accessibility Service")}</span>
        <time>${formatDate(request.due_date || request.closed_at || request.created_at)}</time>
        <span class="status-pill">${statusLabel(request.status)}</span>
      </div>
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

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function render() {
  if (state.loading) {
    root.innerHTML = `<main class="signin-shell"><section class="signin-card">${brandLogo("signin")}<p class="helper center-text">Loading ${APP_NAME}...</p></section>${toastHtml()}</main>`;
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
  rememberPage();

  const pageHtml = {
    messages: messagesPage,
    dashboard: dashboardPage,
    history: historyPage,
    request: clientRequestPage,
    account: accountPage,
    "admin-dashboard": adminDashboardPage,
    "admin-clients": adminClientsPage,
    "admin-requests": adminRequestsPage,
    "admin-request-detail": adminRequestDetailPage,
    "admin-messages": adminMessagesPage,
    "admin-team": adminTeamPage,
    "admin-settings": adminSettingsPage
  }[state.page]();

  root.innerHTML = `${navHtml()}<main>${pageHtml}</main>${toastHtml()}`;
  attachEvents();
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
        state.page = savedPage() || defaultPage();
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

  document.querySelectorAll("[data-chat-request]").forEach((button) => {
    button.addEventListener("click", async () => {
      await setActiveRequest(button.dataset.chatRequest, { markRead: true });
      render();
    });
  });

  document.querySelectorAll("[data-open-request-messages]").forEach((button) => {
    button.addEventListener("click", async () => {
      await goToPage("admin-messages", { requestId: button.dataset.openRequestMessages });
    });
  });

  document.querySelectorAll("[data-client-request]").forEach((button) => {
    button.addEventListener("click", async () => {
      const targetPage = state.page === "dashboard" ? "request" : state.page;
      await goToPage(targetPage, { requestId: button.dataset.clientRequest });
    });
  });

  document.querySelectorAll("[data-client-open-request]").forEach((card) => {
    card.addEventListener("click", async () => {
      await goToPage("request", { requestId: card.dataset.clientOpenRequest });
    });
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

  const clientForm = document.getElementById("clientForm");
  if (clientForm) {
    clientForm.addEventListener("input", (event) => {
      if (state.editingClientId || !event.target?.name) return;
      state.clientDraft[event.target.name] = event.target.value;
    });
    clientForm.addEventListener("change", (event) => {
      if (state.editingClientId || !event.target?.name) return;
      state.clientDraft[event.target.name] = event.target.value;
    });
    clientForm.addEventListener("submit", async (event) => {
      event.preventDefault();
      const values = Object.fromEntries(new FormData(event.currentTarget));
      await withActionLock("client-form", event.currentTarget, async () => {
        try {
        if (state.editingClientId) {
          await updateClient(state.editingClientId, values);
          state.editingClientId = null;
          showToast("Client updated.");
        } else {
          const createdClient = await createClient(values);
          clearClientDraft();
          if (createdClient?.account_setup_email?.sent) {
            showToast("Client created and invite email sent.");
          } else if (createdClient?.account_setup_email?.reason) {
            showToast(`Client created, but invite email was not sent: ${createdClient.account_setup_email.reason}`);
          } else {
            showToast("Client created.");
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

  document.querySelectorAll("[data-edit-client]").forEach((button) => {
    button.addEventListener("click", (event) => {
      event.stopPropagation();
      state.editingClientId = button.dataset.editClient;
      clearClientDraft();
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
    requestForm.addEventListener("submit", async (event) => {
      event.preventDefault();
      const formData = new FormData(event.currentTarget);
      const values = Object.fromEntries(formData);
      const selectedServices = formData.getAll("services").map(String);
      const assignedProfileIds = formData.getAll("assignedProfileIds").map(String);
      const clientContacts = parseClientContactInput(values.clientFollowers);
      if (!selectedServices.length) {
        showToast("Select at least one service.");
        return;
      }
      await withActionLock("request-form", event.currentTarget, async () => {
        try {
        const previousRequest = state.requests.find((request) => request.id === state.editingRequestId);
        const previousAssignedIds = state.editingRequestId ? assignedProfileIdsForRequest(state.editingRequestId) : [];
        const previousContacts = state.editingRequestId ? clientContactsForRequest(state.editingRequestId) : [];
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
              await createMessage(state.editingRequestId, state.profile.id, updateMessage);
            }
          }
          state.editingRequestId = null;
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
          state.editingRequestId = button.dataset.editRequest;
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
        window.open(url, "_blank", "noopener,noreferrer");
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
        window.open(url, "_blank", "noopener,noreferrer");
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
      const values = Object.fromEntries(new FormData(event.currentTarget));
      if (values.password !== values.confirmPassword) {
        showToast("Passwords do not match.");
        return;
      }
      try {
        await updatePassword(values.password);
        state.profile = { ...state.profile, must_change_password: false };
        state.showPasswordForm = false;
        clearPasswordRecoveryUrl();
        event.currentTarget.reset();
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
  state.team = [];
  state.requestAssignments = [];
  state.requestClientContacts = [];
  state.messageDrafts = {};
  state.clientDraft = {};
  state.pendingActions = new Set();
  state.selectedRequestId = null;
  state.editingClientId = null;
  state.editingRequestId = null;
  state.editingTeamId = null;
  state.showPasswordForm = false;
  state.authView = "signin";
  state.loadError = "";
  state.page = "messages";
}

onAuthStateChange((session, event) => {
  window.setTimeout(async () => {
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
        await withTimeout(loadPortalData(), "Account data loading");
        state.page = savedPage() || defaultPage();
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
  if (!pageIsAllowed(page)) {
    await goToPage(defaultPage(), { replace: true, scroll: false });
    return;
  }
  if (requestId) {
    await setActiveRequest(requestId, { page, markRead: isConversationPage(page) });
  } else {
    state.page = page;
    rememberPage();
  }
  render();
});

window.setInterval(pollActiveMessages, MESSAGE_POLL_MS);
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") pollActiveMessages();
});

boot();
