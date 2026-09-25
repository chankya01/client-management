import {
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
  loadRequests,
  loadTeam,
  onAuthStateChange,
  sendMagicLink,
  sendPasswordReset,
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
  selectedRequestId: null,
  editingClientId: null,
  editingRequestId: null,
  editingTeamId: null,
  showPasswordForm: false,
  authView: "signin",
  page: "messages",
  loading: true,
  loadError: "",
  toast: ""
};

const adminPages = ["admin-dashboard", "admin-clients", "admin-requests", "admin-request-detail", "admin-messages", "admin-team", "admin-settings"];
const clientPages = ["messages", "dashboard", "history", "request", "account"];
const managementRoles = ["owner", "project_manager"];
const workRoles = ["developer", "reviewer", "assignee"];
const internalRoles = [...managementRoles, ...workRoles];
const workPortalPages = ["admin-dashboard", "admin-requests", "admin-request-detail", "admin-messages", "admin-team", "admin-settings"];
const LOAD_TIMEOUT_MS = 8000;
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

function withTimeout(promise, label, ms = LOAD_TIMEOUT_MS) {
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      window.setTimeout(() => reject(new Error(`${label} took too long. Please sign out and sign in again, or check Supabase profile/RLS setup.`)), ms);
    })
  ]);
}

function statusLabel(status) {
  return String(status || "new")
    .replaceAll("_", " ")
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function roleLabel(role) {
  if (role === "owner") return "Admin";
  if (role === "project_manager") return "Project Manager";
  return statusLabel(role || "team member");
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
        <span data-service-summary>${selectedServices.size ? escapeHtml(Array.from(selectedServices).join(", ")) : "Select services"}</span>
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
  const steps = ["new", "scoping", "agreement_pending", "in_progress", "validation", "delivered", "closed"];
  const currentIndex = Math.max(0, steps.indexOf(request?.status || "new"));
  return `
    <section class="card">
      <p class="section-label">Status tracker</p>
      <div class="status-timeline">
        ${steps.map((step, index) => `
          <div class="timeline-step ${index < currentIndex ? "done" : ""} ${index === currentIndex ? "current" : ""}">
            <span class="timeline-dot"></span>
            <div>
              <strong>${statusLabel(step)}</strong>
              <small>${index < currentIndex ? "Completed" : index === currentIndex ? "Current stage" : "Pending"}</small>
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
    return message.includes("already exists")
      ? message
      : "A record with this email already exists. Please use the existing record.";
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

function defaultPage() {
  if (state.profile?.must_change_password) {
    if (!isInternal()) return "account";
    return "admin-settings";
  }
  if (canAccessManagementPages()) return "admin-dashboard";
  return isInternal() ? "admin-requests" : "messages";
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
  return isInternal() ? senderRole === "client" : senderRole !== "client";
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

function pendingReadText(requestId) {
  const count = state.unreadCounts[requestId] || 0;
  return count ? `<span class="pending-read">${count} pending read</span>` : "";
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
    await setActiveRequest(requestId, { page, markRead: page === "messages" });
  } else if (page === "messages" && state.activeRequest) {
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

async function boot() {
  const generation = ++loadGeneration;
  const recoveryFlow = isPasswordRecoveryFlow();
  try {
    state.session = await withTimeout(getSession(), "Session check");
    if (state.session) {
      await withTimeout(loadPortalData(), "Account data loading");
      const params = new URLSearchParams(window.location.search);
      const routePage = params.get("page");
      const routeRequestId = params.get("request");
      if (recoveryFlow) {
        state.showPasswordForm = true;
        state.page = passwordRecoveryPage();
        clearPasswordRecoveryUrl();
      } else if (routePage && pageIsAllowed(routePage)) {
        state.page = routePage;
        if (routeRequestId) await setActiveRequest(routeRequestId, { page: routePage });
      } else {
        state.page = savedPage() || defaultPage();
      }
      syncBrowserHistory({ replace: true });
    }
  } catch (error) {
    state.loadError = error.message;
  } finally {
    if (generation !== loadGeneration) return;
    state.loading = false;
    render();
  }
}

async function loadPortalData() {
  state.profile = await loadProfile();
  const loadedRequests = await loadRequests();
  state.requestAssignments = isInternal() ? await loadRequestAssignments() : [];
  state.requests = isInternal() && !canAccessManagementPages()
    ? loadedRequests.filter((request) => state.requestAssignments.some((assignment) => (
      assignment.request_id === request.id && assignment.profile_id === state.profile.id
    )))
    : loadedRequests;
  state.clients = isInternal() ? await loadClients() : [];
  state.team = isInternal() ? await loadTeam() : [];
  const lastRequestId = localStorage.getItem(LAST_REQUEST_KEY);
  state.activeRequest = state.requests.find((request) => request.id === lastRequestId)
    || state.requests.find((request) => !["closed", "cancelled"].includes(request.status))
    || state.requests[0]
    || null;
  state.selectedRequestId = state.activeRequest?.id || null;
  state.history = isInternal() ? await loadClosedRequests() : state.requests;
  const messageEntries = await Promise.all(state.requests.map(async (request) => [
    request.id,
    await loadMessages(request.id)
  ]));
  state.messagesByRequest = Object.fromEntries(messageEntries);
  calculateUnreadCounts();

  if (state.activeRequest) {
    state.messages = state.messagesByRequest[state.activeRequest.id] || [];
    state.deliverables = await loadDeliverables(state.activeRequest.id);
  } else {
    state.messages = [];
    state.deliverables = [];
  }
}

function renderSignIn() {
  root.innerHTML = `
    <main class="signin-shell">
      <form class="signin-card" id="signinForm">
        <div class="brand">${APP_NAME}</div>
        <h1>Sign in</h1>
        <p class="helper">Use your email and password to access your workspace or client portal.</p>
        <label class="field">
          <span>Email address</span>
          <input name="email" type="email" autocomplete="email" required />
        </label>
        <label class="field">
          <span>Password</span>
          <input name="password" type="password" autocomplete="current-password" required />
        </label>
        <label class="password-toggle">
          <input type="checkbox" data-toggle-password="password" />
          <span>Show password</span>
        </label>
        <button class="primary" type="submit">Sign in</button>
        <div class="signin-actions">
          <button class="link-button" type="button" data-action="forgot-password">Forgot password?</button>
          <button class="link-button" type="button" data-action="magic-link">Send magic link instead</button>
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

  document.querySelector("[data-action='magic-link']").addEventListener("click", async () => {
    const email = document.querySelector("#signinForm [name='email']").value.trim();
    if (!email) {
      showToast("Enter your email first, then click Send magic link.");
      return;
    }
    try {
      const session = await sendMagicLink(email);
      if (session?.user) {
        state.authView = "signin";
        await completeSignIn(session);
        return;
      }
      showToast("Magic link sent. Check your email to continue.");
    } catch (error) {
      showAppError(error);
    }
  });

  attachPasswordToggles();
}

function renderForgotPassword() {
  root.innerHTML = `
    <main class="signin-shell">
      <form class="signin-card" id="forgotPasswordForm">
        <div class="brand">${APP_NAME}</div>
        <h1>Reset password</h1>
        <p class="helper">Enter your account email address. We’ll send a secure password reset link.</p>
        <label class="field">
          <span>Email address</span>
          <input name="email" type="email" autocomplete="email" required />
        </label>
        <div class="auth-actions">
          <button class="primary" type="submit">Send reset link</button>
          <button class="secondary" type="button" data-action="back-to-signin">Back to sign in</button>
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
        <div class="brand">${APP_NAME}</div>
        <nav class="nav" aria-label="Client portal">
          ${navButton("messages", `Messages ${unreadCount ? `<span class="count">${unreadCount}</span>` : ""}`)}
          ${navButton("dashboard", "Dashboard")}
          ${navButton("history", "History")}
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
        <div class="brand">${APP_NAME}</div>
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

function requestTitle() {
  return state.activeRequest?.title || "No active request";
}

function organizationName() {
  return state.profile?.clients?.name || "Client organization";
}

function clientName(clientId) {
  return state.clients.find((client) => client.id === clientId)?.name || organizationName();
}

function assignableTeamMembers() {
  return state.team.filter((member) => ["developer", "reviewer", "assignee"].includes(member.role));
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
  return names.length ? names.join(", ") : "Not assigned";
}

function assignmentCheckboxes(selectedIds = []) {
  const selected = new Set(selectedIds);
  const people = assignableTeamMembers();
  return `
    <div class="field wide service-dropdown assignment-dropdown" data-assignment-dropdown>
      <span>Tagged Team Members</span>
      <button class="service-dropdown-toggle" type="button" data-action="toggle-assignments" aria-expanded="false">
        <span data-assignment-summary>${selected.size ? escapeHtml(people.filter((member) => selected.has(member.id)).map((member) => member.full_name).join(", ")) : "Select team members"}</span>
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
  const activeRequests = state.requests.filter((request) => !["closed", "cancelled"].includes(request.status));
  const workspaceLabel = canAccessManagementPages() ? "Admin Workspace" : "Work Workspace";
  const permissionText = canAccessManagementPages()
    ? "management permissions."
    : `${roleLabel(state.profile.role)} access.`;
  return `
    <section class="admin-page">
      <div class="admin-heading">
        <div>
          <p class="section-label green">${workspaceLabel}</p>
          <h1>${APP_NAME} Dashboard</h1>
          <p class="subtitle">Signed in as ${escapeHtml(state.profile.full_name)} · ${escapeHtml(permissionText)}</p>
        </div>
        ${canManageClients() ? `<button class="primary" data-page="admin-clients">Add Client</button>` : ""}
      </div>
      <div class="metric-grid">
        ${canAccessManagementPages() ? metricCard("Clients", state.clients.length) : ""}
        ${metricCard("Active requests", activeRequests.length)}
        ${metricCard("Team members", state.team.length)}
        ${metricCard("Access", roleLabel(state.profile.role))}
      </div>
      <section class="card">
        <p class="section-label">Recent requests</p>
        ${adminRequestRows(state.requests, { source: "dashboard" })}
      </section>
      ${!canAccessManagementPages() && (state.profile?.must_change_password || state.showPasswordForm) ? passwordSection("Password and account") : ""}
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
  return ["new", "scoping", "agreement_pending", "in_progress", "validation", "delivered", "closed", "cancelled"].map((status) => (
    `<option value="${status}" ${selected === status ? "selected" : ""}>${statusLabel(status)}</option>`
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
  const clientStatus = editingClient?.status || "signed";
  return `
    <section class="admin-page">
      <div class="admin-heading">
        <div>
          <p class="section-label green">Client Onboarding</p>
          <h1>Clients</h1>
          <p class="subtitle">Create the client company, then create requests against that client.</p>
        </div>
      </div>
      <section class="card">
        <p class="section-label">${editingClient ? "Edit Client" : "Add Client"}</p>
        <form class="admin-form" id="clientForm">
          <label class="field"><span>Organization</span><input name="name" value="${escapeHtml(editingClient?.name || "")}" required /></label>
          <label class="field"><span>Primary contact</span><input name="contactName" value="${escapeHtml(editingClient?.primary_contact_name || "")}" required /></label>
          <label class="field"><span>Client email</span><input name="email" type="email" value="${escapeHtml(editingClient?.primary_contact_email || "")}" required /></label>
          <label class="field"><span>Billing email</span><input name="billingEmail" type="email" value="${escapeHtml(editingClient?.billing_email || "")}" /></label>
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
          <p class="section-label green">Request Management</p>
          <h1>Requests</h1>
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
            ${serviceCheckboxes(editingRequest?.service_type || "")}
            ${assignmentCheckboxes(selectedAssignees)}
            <label class="field"><span>Due date</span><input name="dueDate" type="date" value="${editingRequest?.due_date || ""}" /></label>
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
        <p class="section-label">All requests</p>
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
        ${pendingReadText(request.id)}
      </div>
      <div class="row-actions">
        ${requestUnreadBadge(request.id)}
        ${source === "dashboard" ? `<button class="secondary small-action" data-open-request-button="${request.id}">Open</button>` : ""}
        ${canManageRequests() ? `<button class="secondary small-action" data-edit-request="${request.id}">Edit</button>` : ""}
        ${canDelete() ? `<button class="danger-link" data-delete-request="${request.id}">Delete</button>` : ""}
      </div>
    </div>
  `).join("") || `<p class="helper">No requests yet.</p>`;
}

function adminRequestDetailPage() {
  const request = state.requests.find((item) => item.id === state.selectedRequestId) || state.activeRequest;
  if (!request) return emptyCard("Request not found", "The selected request is no longer available.");

  const requestMessages = state.messages.filter((message) => message.request_id === request.id);
  return `
    <section class="admin-page">
      <button class="secondary back-button" data-page="admin-requests">Back to requests</button>
      <div class="admin-heading">
        <div>
          <p class="section-label green">${escapeHtml(displayRequestNumber(request))}</p>
          <h1>${escapeHtml(request.title)}</h1>
          <p class="subtitle">${escapeHtml(clientName(request.client_id))} · ${escapeHtml(request.service_type || "Service")}</p>
        </div>
        <div class="row-actions">
          ${canManageRequests() ? `<button class="secondary" data-edit-request="${request.id}">Edit request</button>` : ""}
          ${canDelete() ? `<button class="danger-button" data-delete-request="${request.id}">Delete request</button>` : ""}
        </div>
      </div>
      <div class="detail-grid">
        <section class="card">
          <p class="section-label">Request details</p>
          ${accountRow("Client", clientName(request.client_id))}
          ${accountRow("Status", statusLabel(request.status))}
          ${accountRow("Tagged team", assignedPeopleText(request.id))}
          ${accountRow("Due date", formatDate(request.due_date))}
          ${accountRow("Created", formatDate(request.created_at))}
          <p class="card-note">${escapeHtml(request.description || "No description added.")}</p>
        </section>
        ${statusTracker(request)}
        <section class="card">
          <p class="section-label">Conversation summary</p>
          ${requestMessages.slice(-4).map((message) => `
            <div class="list-row">
              <strong>${escapeHtml(message.profiles?.full_name || "User")}</strong>
              <span>${escapeHtml(message.message)}</span>
            </div>
          `).join("") || `<p class="helper">No messages for this request yet.</p>`}
          <button class="primary conversation-button" type="button" data-open-request-messages="${request.id}">Open conversation</button>
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
          <p class="section-label green">Internal messages</p>
          <h1>Request Conversation</h1>
          <p class="subtitle">${escapeHtml(displayRequestNumber(request))} · ${escapeHtml(request.title)} · ${escapeHtml(clientName(request.client_id))}</p>
        </div>
      </div>
      <div class="message-layout">
        <aside class="card message-request-list">
          <p class="section-label">Requests</p>
          ${state.requests.map((item) => `
            <button class="${item.id === request.id ? "active" : ""}" data-chat-request="${item.id}">
              <strong>${escapeHtml(displayRequestNumber(item))}</strong>
              <span>${escapeHtml(item.title)}</span>
            </button>
          `).join("")}
        </aside>
        <section>
          ${state.messages.map(messageCard).join("") || emptyMessage()}
          <form class="card composer" id="internalMessageForm">
            <label class="section-label" for="internalMessageText">New message</label>
            <textarea id="internalMessageText" name="message" placeholder="Write a message to the client or project team"></textarea>
            <div class="composer-actions">
              <label class="file-control">
                Attachment
                <input id="internalAttachmentInput" name="attachment" type="file" />
              </label>
              <span class="helper">Visible on the request conversation.</span>
              <button class="primary" type="submit">Send message</button>
            </div>
          </form>
        </section>
      </div>
    </section>
  `;
}

function adminTeamPage() {
  const editingMember = state.team.find((member) => member.id === state.editingTeamId);
  const formTitle = editingMember ? "Update team member" : "Add team member";
  const submitText = editingMember ? "Update team member" : "Add team member";
  const roleValue = editingMember?.role || "";
  return `
    <section class="admin-page">
      <h1>Team</h1>
      <p class="subtitle">Internal users who can own, manage, develop, or review work.</p>
      ${canManageTeam() ? `
        <section class="card">
          <p class="section-label">${formTitle}</p>
          <p class="helper">This creates or updates the Supabase Auth user and profile through the local/server backend. Share the configured temporary password, then ask the user to change it after first login.</p>
          <form class="admin-form" id="teamForm">
            <label class="field"><span>Full name</span><input name="fullName" value="${escapeHtml(editingMember?.full_name || "")}" required /></label>
            <label class="field"><span>Email</span><input name="email" type="email" value="${escapeHtml(editingMember?.email || "")}" required /></label>
            <label class="field"><span>Role</span><select name="role">
              <option value="" ${roleValue ? "" : "selected"} disabled>Select role</option>
              <option value="assignee" ${roleValue === "assignee" ? "selected" : ""}>Assignee</option>
              <option value="developer" ${roleValue === "developer" ? "selected" : ""}>Developer</option>
              <option value="reviewer" ${roleValue === "reviewer" ? "selected" : ""}>Reviewer</option>
              <option value="project_manager" ${roleValue === "project_manager" ? "selected" : ""}>Project Manager</option>
              <option value="owner" ${roleValue === "owner" ? "selected" : ""}>Admin</option>
            </select></label>
            <label class="field"><span>Job title</span><input name="jobTitle" value="${escapeHtml(editingMember?.job_title || "")}" /></label>
            <button class="primary" type="submit">${submitText}</button>
            ${editingMember ? `<button class="secondary" type="button" data-cancel-team-edit>Cancel edit</button>` : ""}
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
            <div><strong>${escapeHtml(member.full_name)}</strong><span>${escapeHtml(member.email)} · ${escapeHtml(member.job_title || roleLabel(member.role))}</span></div>
            <div class="row-actions">
              <span class="status-pill team-role-pill">${escapeHtml(roleLabel(member.role))}</span>
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
              <label class="field"><span>Email</span><input value="${escapeHtml(state.profile.email || "")}" disabled /></label>
              <label class="field"><span>Role</span><input value="${escapeHtml(roleLabel(state.profile.role))}" disabled /></label>
              <label class="field"><span>Job title</span><input name="jobTitle" value="${escapeHtml(state.profile.job_title || "")}" /></label>
              <label class="field wide"><span>Phone</span><input name="phone" value="${escapeHtml(state.profile.phone || "")}" /></label>
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
          <p class="section-label green">Workspace controls</p>
          <h1>Settings</h1>
          <p class="subtitle">Operational defaults for requests, notifications, services, and client access.</p>
        </div>
        <button class="primary" type="button" onclick="return false;">Save settings</button>
      </div>
      <div class="settings-grid">
        <section class="card">
          <p class="section-label">Organization profile</p>
          ${accountRow("Workspace name", APP_NAME)}
          ${accountRow("Default admin", state.profile.full_name)}
          ${accountRow("Default timezone", "Asia/Kolkata")}
          ${accountRow("Support email", "support@accessible.org")}
        </section>
        ${passwordSection("Password and account")}
        <section class="card">
          <p class="section-label">Request workflow</p>
          <div class="list-row">New request -> Scoping -> Agreement -> In progress -> Validation -> Closed</div>
          <div class="list-row">Default request prefix: REQ</div>
          <div class="list-row">Next request number: ${1000 + state.requests.length + 1}</div>
          <div class="list-row">Auto-assign new requests to workspace admin</div>
        </section>
        <section class="card">
          <p class="section-label">Permission policy</p>
          <div class="list-row">Admin: full create, update, delete, and settings access</div>
          <div class="list-row">Project manager: manage clients, requests, team, and conversations</div>
          <div class="list-row">Developer/reviewer: view assigned work and participate in request chat</div>
          <div class="list-row">Client: messages, attachments, dashboard, history, and account only</div>
        </section>
        <section class="card">
          <p class="section-label">Notifications</p>
          <div class="list-row">Email all request participants when a new message is posted</div>
          <div class="list-row">Email assigned team when request status changes</div>
          <div class="list-row">Notify admin when deliverables are uploaded</div>
          <div class="list-row">Send client reminder if awaiting response for 3 business days</div>
        </section>
        <section class="card">
          <p class="section-label">Service catalog</p>
          <div class="list-row">WCAG 2.1 AA audit</div>
          <div class="list-row">VPAT / ACR creation</div>
          <div class="list-row">Accessibility remediation support</div>
          <div class="list-row">Validation and regression testing</div>
        </section>
        <section class="card">
          <p class="section-label">Storage and files</p>
          <div class="list-row">Request attachments: private bucket</div>
          <div class="list-row">Deliverables: private bucket with signed downloads</div>
          <div class="list-row">Agreements: private bucket, owner/project manager upload</div>
          <div class="list-row">Maximum upload size policy: 25 MB per file</div>
        </section>
      </div>
    </section>
  `;
}

function messagesPage() {
  if (!state.activeRequest) {
    return emptyCard("No active request", "Your portal is ready, but there are no active requests linked to this account yet.");
  }

  return `
    <section class="page">
      <div class="heading-accent">
        <h1>Messages</h1>
        <p class="subtitle">${organizationName()} and Accessible.org · ${requestTitle()}</p>
      </div>
      ${clientRequestSwitcher()}
      <div class="date-row"><span>Conversation</span></div>
      ${state.messages.map(messageCard).join("") || emptyMessage()}
      <form class="card composer" id="messageForm">
        <label class="section-label" for="messageText">New message</label>
        <textarea id="messageText" name="message" placeholder="Write a message to Accessible.org"></textarea>
        <div class="composer-actions">
          <label class="file-control">
            Attachment
            <input id="attachmentInput" name="attachment" type="file" />
          </label>
          <button class="primary" type="submit">Send message</button>
        </div>
      </form>
    </section>
  `;
}

function messageCard(message) {
  const isClient = message.profiles?.role === "client";
  const messageRequest = state.requests.find((request) => request.id === message.request_id) || state.activeRequest;
  const sender = isClient ? clientName(messageRequest?.client_id) : "Accessible.org";
  const attachment = message.attachment;
  return `
    <article class="message-card ${isClient ? "client" : "team"}">
      <div class="message-head">
        <span class="sender ${isClient ? "client-name" : ""}">${sender}</span>
        <time class="time">${formatTime(message.created_at)}</time>
      </div>
      ${attachment ? attachmentCard(attachment) : `<p>${escapeHtml(message.message)}</p>`}
      <span class="author">${escapeHtml(message.profiles?.full_name || "Team member")}</span>
    </article>
  `;
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
  if (isInternal() || state.requests.length <= 1) return "";
  return `
    <section class="card request-switcher">
      <p class="section-label">Requests</p>
      ${state.requests.map((request) => `
        <button class="${request.id === state.activeRequest?.id ? "active" : ""}" data-client-request="${request.id}">
          <span>
            <strong>${escapeHtml(displayRequestNumber(request))}</strong>
            ${escapeHtml(request.title)}
            ${pendingReadText(request.id)}
          </span>
          ${requestUnreadBadge(request.id)}
        </button>
      `).join("")}
    </section>
  `;
}

function dashboardPage() {
  if (!state.activeRequest) {
    return emptyCard("Dashboard", "No active requests are currently linked to this client account.");
  }

  return `
    <section class="page">
      <h1>${escapeHtml(requestTitle())}: ${statusLabel(state.activeRequest.status)}</h1>
      ${clientRequestSwitcher()}

      <section class="card">
        <p class="section-label">Services</p>
        ${requestServices(state.activeRequest).map((service) => `<div class="list-row">${escapeHtml(service)}</div>`).join("") || `<div class="list-row">Accessibility service</div>`}
        <p class="card-note">Need something else? Just ask in <a href="#" data-jump="messages">Messages</a>.</p>
      </section>

      <section class="card">
        <p class="section-label">Deliverables</p>
        ${state.deliverables.map(deliverableRow).join("") || `<p class="helper">No deliverables have been released yet.</p>`}
      </section>
    </section>
  `;
}

function clientRequestPage() {
  if (!state.activeRequest) {
    return emptyCard("Request", "No request is selected.");
  }

  return `
    <section class="page">
      <button class="secondary back-button" data-page="history">Back to history</button>
      <div class="heading-accent">
        <h1>${escapeHtml(state.activeRequest.title)}</h1>
        <p class="subtitle">${escapeHtml(displayRequestNumber(state.activeRequest))} · ${statusLabel(state.activeRequest.status)} ${requestUnreadBadge(state.activeRequest.id)}</p>
      </div>
      <section class="card status-card">
        <p class="section-label green">Request details</p>
        ${accountRow("Status", statusLabel(state.activeRequest.status))}
        ${accountRow("Due date", formatDate(state.activeRequest.due_date))}
        ${accountRow("Created", formatDate(state.activeRequest.created_at))}
        <p class="card-note">${escapeHtml(state.activeRequest.description || "No description added.")}</p>
      </section>
      ${statusTracker(state.activeRequest)}
      <section class="card">
        <p class="section-label">Services in this request</p>
        ${requestServices(state.activeRequest).map((service) => `<div class="list-row">${escapeHtml(service)}</div>`).join("") || `<p class="helper">No services listed.</p>`}
      </section>
      <section class="card">
        <p class="section-label">Deliverables</p>
        ${state.deliverables.map(deliverableRow).join("") || `<p class="helper">No deliverables have been released yet.</p>`}
      </section>
      <button class="primary" type="button" data-open-active-messages>Open messages for this request</button>
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
      <h1>Request history</h1>
      ${
        state.history.map((request) => `
          <section class="card history-card clickable-row" data-client-open-request="${request.id}">
            <h2>${escapeHtml(request.title)} ${requestUnreadBadge(request.id)}</h2>
            <p>${escapeHtml(request.description || "Request linked to this client account.")}</p>
            <div class="deliverable-row">
              <span>${escapeHtml(displayRequestNumber(request))} · ${escapeHtml(request.service_type || "Accessibility service")}</span>
              <time>${formatDate(request.closed_at || request.created_at)}</time>
              <span class="status-pill">${statusLabel(request.status)}</span>
            </div>
            <p class="helper open-request-link">Open this request</p>
          </section>
        `).join("") || emptyCard("No requests yet", "Requests linked to this client account will appear here.")
      }
    </section>
  `;
}

function accountPage() {
  const client = state.profile?.clients;
  return `
    <section class="page">
      <h1>Account</h1>
      <section class="card">
        <p class="section-label">Organization</p>
        ${accountRow("Organization", client?.name)}
        ${accountRow("Primary contact", client?.primary_contact_name || state.profile?.full_name)}
        ${accountRow("Email", client?.primary_contact_email || state.profile?.email)}
        ${accountRow("Billing email", client?.billing_email)}
        ${accountRow("Client since", formatDate(client?.created_at))}
        <p class="card-note">To change any of these, send a note in <a href="#" data-jump="messages">Messages</a>.</p>
      </section>
      <section class="card">
        <p class="section-label">Sign in</p>
        <p>You are signed in as ${escapeHtml(state.profile?.email || "")} on this device.</p>
        <button class="secondary" id="signOut">Sign out</button>
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
            <span>New password</span>
            <input name="password" type="password" autocomplete="new-password" minlength="8" required />
          </label>
          <label class="field">
            <span>Confirm password</span>
            <input name="confirmPassword" type="password" autocomplete="new-password" minlength="8" required />
          </label>
          <label class="password-toggle">
            <input type="checkbox" data-toggle-password="password,confirmPassword" />
            <span>Show password</span>
          </label>
          <div class="form-actions">
            <button class="primary" type="submit">Update password</button>
            ${mustChange ? "" : `<button class="secondary" type="button" data-action="cancel-password-change">Cancel</button>`}
          </div>
        </form>
      ` : `
        <button class="secondary" type="button" data-action="show-password-change">Update password</button>
      `}
    </section>
  `;
}

function accountRow(label, value) {
  return `<div class="account-row"><span>${label}</span><strong>${escapeHtml(value || "-")}</strong></div>`;
}

function emptyMessage() {
  return `<article class="message-card team"><p>No messages yet. Start the conversation below.</p></article>`;
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
    root.innerHTML = `<main class="signin-shell"><p>Loading ${APP_NAME}...</p>${toastHtml()}</main>`;
    return;
  }

  if (!state.session) {
    if (state.authView === "forgot-password") {
      renderForgotPassword();
    } else {
      renderSignIn();
    }
    return;
  }

  if (state.loadError) {
    root.innerHTML = `
      <main class="signin-shell">
        <section class="signin-card">
          <div class="brand">${APP_NAME}</div>
          <h1>Account setup required</h1>
          <p class="helper">${escapeHtml(state.loadError)}</p>
          <p class="helper">Check Supabase Auth and public.profiles for this email, then sign in again.</p>
          <div class="quick-login">
            <button class="primary" data-action="logout">Sign out</button>
            <button class="secondary" data-action="retry-load">Retry</button>
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
      if (summary) summary.textContent = selected.length ? selected.join(", ") : "Select services";
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
      if (summary) summary.textContent = selected.length ? selected.join(", ") : "Select team members";
    });
  });

  document.addEventListener("click", closeServiceDropdownsOnOutsideClick, { once: true });

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
        state.loadError = error.message;
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

  document.querySelectorAll("[data-open-request-button]").forEach((button) => {
    button.addEventListener("click", async (event) => {
      event.stopPropagation();
      await goToPage("admin-request-detail", { requestId: button.dataset.openRequestButton });
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
    clientForm.addEventListener("submit", async (event) => {
      event.preventDefault();
      const values = Object.fromEntries(new FormData(event.currentTarget));
      try {
        if (state.editingClientId) {
          await updateClient(state.editingClientId, values);
          state.editingClientId = null;
          showToast("Client updated.");
        } else {
          await createClient(values);
          showToast("Client created. In production, send a magic-link invitation next.");
        }
        state.clients = await loadClients();
        render();
      } catch (error) {
        showAppError(error, "Save client");
      }
    });
  }

  document.querySelectorAll("[data-edit-client]").forEach((button) => {
    button.addEventListener("click", (event) => {
      event.stopPropagation();
      state.editingClientId = button.dataset.editClient;
      render();
      window.scrollTo({ top: 0, behavior: "smooth" });
    });
  });

  const cancelClientEdit = document.querySelector("[data-cancel-client-edit]");
  if (cancelClientEdit) {
    cancelClientEdit.addEventListener("click", () => {
      state.editingClientId = null;
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

  const requestForm = document.getElementById("requestForm");
  if (requestForm) {
    requestForm.addEventListener("submit", async (event) => {
      event.preventDefault();
      const formData = new FormData(event.currentTarget);
      const values = Object.fromEntries(formData);
      const selectedServices = formData.getAll("services").map(String);
      const assignedProfileIds = formData.getAll("assignedProfileIds").map(String);
      if (!selectedServices.length) {
        showToast("Select at least one service.");
        return;
      }
      try {
        const previousRequest = state.requests.find((request) => request.id === state.editingRequestId);
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
          if (previousRequest && previousRequest.service_type !== requestPayload.serviceType) {
            const versionLabel = nextServiceVersionLabel(state.editingRequestId);
            await createMessage(
              state.editingRequestId,
              state.profile.id,
              serviceVersionMessage({ versionLabel, services: requestPayload.serviceType })
            );
          }
          state.editingRequestId = null;
          showToast("Request updated.");
        } else {
          const createdRequest = await createRequest(requestPayload);
          await setRequestAssignments(createdRequest.id, assignedProfileIds, state.profile.id);
          await createMessage(
            createdRequest.id,
            state.profile.id,
            serviceVersionMessage({ versionLabel: "Services v1", services: requestPayload.serviceType })
          );
          showToast("Request created and linked to the selected client.");
        }
        await loadPortalData();
        render();
      } catch (error) {
        showAppError(error, "Save request");
      }
    });
  }

  document.querySelectorAll("[data-edit-request]").forEach((button) => {
    button.addEventListener("click", (event) => {
      event.stopPropagation();
      state.editingRequestId = button.dataset.editRequest;
      state.page = "admin-requests";
      rememberPage();
      render();
      window.scrollTo({ top: 0, behavior: "smooth" });
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

  const teamForm = document.getElementById("teamForm");
  if (teamForm) {
    teamForm.addEventListener("submit", async (event) => {
      event.preventDefault();
      const values = Object.fromEntries(new FormData(event.currentTarget));
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

  const profileForm = document.getElementById("profileForm");
  if (profileForm) {
    profileForm.addEventListener("submit", async (event) => {
      event.preventDefault();
      const values = Object.fromEntries(new FormData(event.currentTarget));
      try {
        const updatedProfile = await updateOwnProfile(values);
        if (updatedProfile) state.profile = updatedProfile;
        showToast("Profile updated.");
        render();
      } catch (error) {
        showAppError(error, "Update profile");
      }
    });
  }

  const form = document.getElementById("messageForm");
  if (form) {
    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      const message = document.getElementById("messageText").value.trim();
      const file = document.getElementById("attachmentInput").files[0];

      if (!message && !file) {
        showToast("Write a message or choose an attachment first.");
        return;
      }

      try {
        if (message) await createMessage(state.activeRequest.id, state.profile.id, message);
        if (file) await uploadRequestAttachment({ request: state.activeRequest, profile: state.profile, file });
        await refreshActiveMessages({ markRead: true });
        showToast("Message sent. Related people can be notified by email from your backend.");
        render();
      } catch (error) {
        showAppError(error, "Send client message");
      }
    });
  }

  const internalMessageForm = document.getElementById("internalMessageForm");
  if (internalMessageForm) {
    internalMessageForm.addEventListener("submit", async (event) => {
      event.preventDefault();
      const message = document.getElementById("internalMessageText").value.trim();
      const file = document.getElementById("internalAttachmentInput").files[0];

      if (!message && !file) {
        showToast("Write a message or choose an attachment first.");
        return;
      }

      try {
        if (message) await createMessage(state.activeRequest.id, state.profile.id, message);
        if (file) await uploadRequestAttachment({ request: state.activeRequest, profile: state.profile, file });
        await refreshActiveMessages({ markRead: true });
        showToast("Message sent on the request conversation.");
        render();
      } catch (error) {
        showAppError(error, "Send internal message");
      }
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
      const hasExistingPortal = Boolean(state.profile);
      state.loading = !hasExistingPortal;
      state.loadError = "";
      if (!hasExistingPortal) render();
      try {
        await withTimeout(loadPortalData(), "Account data loading");
        if (recoveryFlow) {
          state.showPasswordForm = true;
          state.page = passwordRecoveryPage();
          clearPasswordRecoveryUrl();
        } else {
          state.page = savedPage() || defaultPage();
        }
      } catch (error) {
        state.loadError = `${event || "Auth"}: ${error.message}`;
      } finally {
        if (generation !== loadGeneration) return;
        state.loading = false;
        render();
      }
    } else {
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
    await setActiveRequest(requestId, { page, markRead: page === "messages" });
  } else {
    state.page = page;
    rememberPage();
  }
  render();
});

boot();
