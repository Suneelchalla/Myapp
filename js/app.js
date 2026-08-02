// =============================================================================
//  Ripple — main application module (vanilla JS, no framework).
// =============================================================================
import { POLL, APP_NAME, MESSAGE_MAX } from "./config.js";
import { DB } from "./db.js";
import { call, ApiError, setToken, getToken } from "./api.js";
import { AppLock, normalizeTimePin, formatTimePin } from "./lock.js";
import { Vault } from "./vault.js";

/* ------------------------------------------------------------- tiny helpers */
const $ = (sel, root = document) => root.querySelector(sel);
const appRoot = () => $("#app");

/** Safe DOM builder. Strings become textContent (never innerHTML). */
function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null) continue;
    if (k === "class") node.className = v;
    else if (k === "text") node.textContent = v;
    else if (k === "html") node.innerHTML = v;          // used ONLY for our own trusted SVG icons
    else if (k.startsWith("on") && typeof v === "function") node.addEventListener(k.slice(2), v);
    else if (k === "dataset") Object.assign(node.dataset, v);
    else node.setAttribute(k, v);
  }
  (Array.isArray(children) ? children : [children]).forEach((c) => {
    if (c == null || c === false) return;
    node.appendChild(typeof c === "string" ? document.createTextNode(c) : c);
  });
  return node;
}

function uuid() {
  return (crypto && crypto.randomUUID) ? crypto.randomUUID()
    : "id-" + Date.now() + "-" + Math.random().toString(16).slice(2);
}
function initials(name) {
  const n = (name || "?").trim();
  const parts = n.split(/\s+/);
  return ((parts[0]?.[0] || "") + (parts[1]?.[0] || "")).toUpperCase() || n[0]?.toUpperCase() || "?";
}
function timeOf(iso) {
  if (!iso) return "";
  return new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}
function dayLabel(iso) {
  const d = new Date(iso), now = new Date();
  const same = (a, b) => a.toDateString() === b.toDateString();
  const yest = new Date(now); yest.setDate(now.getDate() - 1);
  if (same(d, now)) return "Today";
  if (same(d, yest)) return "Yesterday";
  return d.toLocaleDateString([], { day: "numeric", month: "short", year: d.getFullYear() === now.getFullYear() ? undefined : "numeric" });
}
function lastSeenText(user) {
  if (!user) return "";
  if (user.online) return "online";
  if (!user.lastSeenAt) return "";
  return "last seen " + timeOf(user.lastSeenAt) + " · " + dayLabel(user.lastSeenAt).toLowerCase();
}

/* ------------------------------------------------------------------ toasts */
function toast(message, kind = "info") {
  let host = $("#toasts");
  if (!host) { host = el("div", { id: "toasts" }); document.body.appendChild(host); }
  const t = el("div", { class: "toast toast--" + kind, role: "status", text: message });
  host.appendChild(t);
  setTimeout(() => { t.classList.add("toast--out"); setTimeout(() => t.remove(), 300); }, 3200);
}
function errText(e) {
  if (e instanceof ApiError) {
    if (e.code === "NETWORK" || e.code === "TIMEOUT" || e.code === "BAD_RESPONSE" || e.code === "NOT_CONFIGURED") {
      return e.message || "Connection problem.";
    }
    return e.message || "Something went wrong.";
  }
  return "Something went wrong.";
}

/* --------------------------------------------------------- modal / sheet UI */
function closeOverlays() { document.querySelectorAll(".overlay").forEach((o) => o.remove()); }
function modal(title, contentNodes, actions = [], opts = {}) {
  closeOverlays();
  const sticky = !!opts.sticky;
  const box = el("div", { class: "modal", role: "dialog", "aria-modal": "true", "aria-label": title }, [
    el("h2", { class: "modal__title", text: title }),
    el("div", { class: "modal__body" }, contentNodes),
    el("div", { class: "modal__actions" }, actions)
  ]);
  const overlay = el("div", { class: "overlay", onclick: (e) => {
    if (e.target === overlay && !sticky) closeOverlays();
  } }, [box]);
  document.body.appendChild(overlay);
  const first = box.querySelector("input,textarea,button,select");
  if (first) first.focus();
  if (!sticky) {
    document.addEventListener("keydown", function esc(ev) {
      if (ev.key === "Escape") { closeOverlays(); document.removeEventListener("keydown", esc); }
    });
  }
  return overlay;
}
function sheet(items) {
  closeOverlays();
  const list = el("div", { class: "sheet", role: "menu" },
    items.map((it) => el("button", {
      class: "sheet__item" + (it.danger ? " sheet__item--danger" : ""), role: "menuitem",
      onclick: () => { closeOverlays(); it.onClick(); }, text: it.label
    })));
  const overlay = el("div", { class: "overlay overlay--bottom", onclick: (e) => { if (e.target === overlay) closeOverlays(); } }, [list]);
  document.body.appendChild(overlay);
}

/* ------------------------------------------------------------------- state */
const state = {
  user: null,
  deviceId: null,
  route: { name: "login", param: null },
  poll: { timer: null, presenceTick: 0 },
  activeConversation: null,   // { conversationId, otherUser, lastSequence, clearedBefore }
  syncing: false,
  unreadTotal: 0,
  badgeTimer: null,
  // In-memory tab caches — avoid IDB + GAS on every Chats/Contacts tap
  mem: { conversations: null, conversationsAt: 0, contacts: null, contactsAt: 0 }
};

/* --------------------------------------------------------------- SVG icons */
const ICON = {
  chats: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 11.5a8.38 8.38 0 0 1-8.5 8.5 8.5 8.5 0 0 1-3.9-.9L3 21l1.9-5.6A8.5 8.5 0 1 1 21 11.5z"/></svg>',
  people: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75"/></svg>',
  user: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>',
  back: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M19 12H5M12 19l-7-7 7-7"/></svg>',
  send: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 2 11 13M22 2l-7 20-4-9-9-4 20-7z"/></svg>',
  more: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="5" r="1.6"/><circle cx="12" cy="12" r="1.6"/><circle cx="12" cy="19" r="1.6"/></svg>',
  check: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>',
  checks: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M18 7 8.5 17 5 13.5"/><path d="M23 7l-9 10"/></svg>',
  clock: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>',
  alert: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 9v4M12 17h.01"/><circle cx="12" cy="12" r="9"/></svg>'
};
const icon = (name, cls) => el("span", { class: "icon " + (cls || ""), html: ICON[name], "aria-hidden": "true" });

function avatar(user, size) {
  return el("div", { class: "avatar", style: size ? `width:${size}px;height:${size}px;font-size:${size / 2.4}px` : "" }, [
    el("span", { text: initials(user?.displayName || user?.username) }),
    user?.online ? el("span", { class: "avatar__dot", "aria-label": "online" }) : null
  ]);
}

/* ======================================================== AUTH SCREENS ==== */
function authShell(titleText, subtitleText, formNode, footerNode) {
  return el("div", { class: "auth" }, [
    el("div", { class: "auth__brand" }, [
      el("div", { class: "brand-mark", html: ICON.clock }),
      el("h1", { class: "brand-name", text: APP_NAME })
    ]),
    el("div", { class: "auth__card glass" }, [
      el("h2", { class: "auth__title", text: titleText }),
      el("p", { class: "auth__subtitle", text: subtitleText }),
      formNode,
      footerNode
    ].filter(Boolean))
  ]);
}
function field(labelText, input) {
  const id = "f_" + Math.random().toString(16).slice(2);
  input.id = id;
  return el("label", { class: "field", for: id }, [el("span", { class: "field__label", text: labelText }), input]);
}

function renderLogin() {
  // Wake Apps Script while the user types — cuts cold-start wait on Sign in
  call("ping", {}).catch(() => {});

  const username = el("input", { class: "input", type: "text", autocomplete: "username", placeholder: "your username" });
  const password = el("input", { class: "input", type: "password", autocomplete: "current-password", placeholder: "••••••••" });
  const submit = el("button", { class: "btn btn--primary btn--block", text: "Sign in" });

  async function doLogin() {
    submit.disabled = true; submit.textContent = "Signing in…";
    let lastErr = null;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        if (attempt > 0) { submit.textContent = "Retrying…"; toast("Waking server…", "info"); }
        else toast("Connecting… first wake can take up to a minute", "info");
        const data = await call("login", { username: username.value, password: password.value, deviceId: state.deviceId });
        await afterAuth(data);
        lastErr = null;
        break;
      } catch (e) {
        lastErr = e;
        if (!(e instanceof ApiError) || !["TIMEOUT", "NETWORK"].includes(e.code) || attempt === 1) break;
      }
    }
    if (lastErr) toast(errText(lastErr), "error");
    submit.disabled = false; submit.textContent = "Sign in";
  }
  submit.addEventListener("click", doLogin);
  [username, password].forEach((i) => i.addEventListener("keydown", (e) => { if (e.key === "Enter") doLogin(); }));

  mount(authShell("Welcome back", "Sign in to keep the conversation going.",
    el("div", { class: "form" }, [field("Username", username), field("Password", password), submit]),
    el("div", { class: "auth__footer" }, [
      el("p", {}, [el("a", { class: "link", href: "#/forgot", text: "Forgot password?" })]),
      el("p", {}, ["New here? ", el("a", { class: "link", href: "#/register", text: "Create an account" })]),
      el("a", { class: "link link--muted", href: "#/admin/login", text: "Admin sign in" })
    ])));
  username.focus();
}

function renderForgotPassword() {
  const username = el("input", { class: "input", type: "text", autocomplete: "username", placeholder: "your username" });
  const recovery = el("input", { class: "input", type: "text", autocomplete: "off", placeholder: "ABCD-EFGH", spellcheck: "false" });
  const password = el("input", { class: "input", type: "password", autocomplete: "new-password", placeholder: "at least 6 characters" });
  const confirm = el("input", { class: "input", type: "password", autocomplete: "new-password", placeholder: "repeat new password" });
  const submit = el("button", { class: "btn btn--primary btn--block", text: "Set new password" });

  submit.addEventListener("click", async () => {
    if (password.value !== confirm.value) { toast("Passwords don't match", "error"); return; }
    if (password.value.length < 6) { toast("Password must be at least 6 characters", "error"); return; }
    submit.disabled = true; submit.textContent = "Updating…";
    try {
      const data = await call("resetPassword", {
        username: username.value,
        recoveryCode: recovery.value,
        newPassword: password.value
      });
      toast(data.message || "Password updated", "success");
      location.hash = "#/login";
    } catch (e) { toast(errText(e), "error"); }
    finally { submit.disabled = false; submit.textContent = "Set new password"; }
  });

  mount(authShell("Reset password", "Use the recovery code you saved when you created your account.",
    el("div", { class: "form" }, [
      field("Username", username),
      field("Recovery code", recovery),
      field("New password", password),
      field("Confirm password", confirm),
      submit
    ]),
    el("div", { class: "auth__footer" }, [
      el("p", { class: "hint", style: "padding:0", text: "No recovery code? Sign in (if you still can) and create one in Profile, or ask an admin to reset your password." }),
      el("p", {}, [el("a", { class: "link", href: "#/login", text: "← Back to sign in" })])
    ])));
  username.focus();
}

function showRecoveryCodeModal(code, opts = {}) {
  const codeEl = el("p", { class: "recovery-code", text: code });
  modal(opts.title || "Save your recovery code", [
    el("p", { class: "hint", text: opts.hint || "This code is shown once. You need it if you forget your password. Store it somewhere safe." }),
    codeEl,
    el("button", { class: "btn btn--ghost btn--block", text: "Copy code", onclick: async () => {
      try {
        await navigator.clipboard.writeText(code);
        toast("Copied", "success");
      } catch (e) { toast("Copy failed — write it down", "error"); }
    } })
  ], [
    el("button", { class: "btn btn--primary", text: opts.doneText || "I've saved it", onclick: () => {
      closeOverlays();
      if (opts.onDone) opts.onDone();
    } })
  ], { sticky: opts.sticky !== false });
}

function renderRegister() {
  const username = el("input", { class: "input", type: "text", autocomplete: "username", placeholder: "lowercase, 3–20 chars" });
  const display = el("input", { class: "input", type: "text", autocomplete: "name", placeholder: "how others see you" });
  const password = el("input", { class: "input", type: "password", autocomplete: "new-password", placeholder: "at least 6 characters" });
  const submit = el("button", { class: "btn btn--primary btn--block", text: "Create account" });

  submit.addEventListener("click", async () => {
    if (password.value.length < 6) { toast("Password must be at least 6 characters", "error"); return; }
    submit.disabled = true; submit.textContent = "Creating…";
    try {
      const data = await call("register", {
        username: username.value, displayName: display.value || username.value,
        password: password.value, deviceId: state.deviceId
      });
      // Persist session first — dismissing the recovery modal must not lose the login
      await afterAuth(data);
      if (data.recoveryCode) {
        showRecoveryCodeModal(data.recoveryCode, { sticky: true });
      }
    } catch (e) { toast(errText(e), "error"); }
    finally { submit.disabled = false; submit.textContent = "Create account"; }
  });

  mount(authShell("Create your account", "Pick a unique username. You can change your display name later.",
    el("div", { class: "form" }, [field("Username", username), field("Display name", display), field("Password", password), submit]),
    el("div", { class: "auth__footer" }, [
      el("p", {}, ["Already have an account? ", el("a", { class: "link", href: "#/login", text: "Sign in" })])
    ])));
  username.focus();
}

async function afterAuth(data) {
  setToken(data.token);
  state.user = data.user;
  state.mem = { conversations: null, conversationsAt: 0, contacts: null, contactsAt: 0 };
  // Navigate immediately — don't wait on IndexedDB before the chats tab paints
  toast("Signed in", "success");
  location.hash = "#/chats";
  DB.setKV("token", data.token).catch(() => {});
  DB.setKV("user", data.user).catch(() => {});
  flushPending();
}

/* ======================================================= APP SHELL ======== */
function shell(headerNode, contentNode, opts = {}) {
  const hideNav = !!opts.hideNav;
  const root = appRoot();
  let shellEl = root.querySelector(":scope > .shell");
  const hasNav = !!(shellEl && shellEl.querySelector(".bottomnav"));

  // Reuse shell when staying in main tabs (huge win on Android tab switches)
  if (shellEl && hasNav === !hideNav) {
    const content = shellEl.querySelector("#content");
    const oldHeader = shellEl.querySelector(":scope > .topbar, :scope > header");
    if (oldHeader) oldHeader.replaceWith(headerNode);
    else shellEl.insertBefore(headerNode, content || shellEl.firstChild);
    if (content) {
      content.textContent = "";
      const nodes = Array.isArray(contentNode) ? contentNode : [contentNode];
      nodes.filter(Boolean).forEach((n) => content.appendChild(n));
    }
    if (!hideNav) syncBottomNav();
    return shellEl;
  }

  const tabs = hideNav ? null : el("nav", { class: "bottomnav", "aria-label": "Primary" }, [
    navButton("chats", "Chats", "#/chats"),
    navButton("people", "Signals", "#/signals"),
    navButton("user", "Profile", "#/profile")
  ]);
  mount(el("div", { class: "shell" }, [headerNode, el("main", { class: "content", id: "content" }, contentNode), tabs].filter(Boolean)));
  return root.querySelector(":scope > .shell");
}

function syncBottomNav() {
  document.querySelectorAll(".bottomnav .navbtn").forEach((a) => {
    const href = a.getAttribute("href") || "";
    const active = location.hash.indexOf(href) === 0;
    a.classList.toggle("navbtn--active", active);
    if (active) a.setAttribute("aria-current", "page");
    else a.removeAttribute("aria-current");
    if (a.dataset.nav === "chats") {
      let dot = a.querySelector(".nav-dot");
      if (state.unreadTotal > 0) {
        if (!dot) a.appendChild(el("span", { class: "nav-dot", "aria-label": "new messages" }));
      } else if (dot) dot.remove();
    }
  });
}

function navButton(iconName, label, href) {
  const active = location.hash.indexOf(href) === 0;
  const children = [icon(iconName), el("span", { class: "navbtn__label", text: label })];
  if (iconName === "chats" && state.unreadTotal > 0) children.push(el("span", { class: "nav-dot", "aria-label": "new messages" }));
  return el("a", { class: "navbtn" + (active ? " navbtn--active" : ""), href, "aria-current": active ? "page" : null, dataset: { nav: iconName } }, children);
}
function topbar(title, opts = {}) {
  return el("header", { class: "topbar" }, [
    opts.back ? el("button", { class: "iconbtn", "aria-label": "Back", onclick: () => history.back(), html: ICON.back }) : null,
    opts.avatar ? opts.avatar : null,
    el("div", { class: "topbar__titles" }, [
      el("h1", { class: "topbar__title", text: title }),
      opts.subtitle != null ? el("span", { class: "topbar__subtitle" + (opts.subtitleOnline ? " is-online" : ""), text: opts.subtitle }) : null
    ]),
    opts.action ? opts.action : null
  ].filter(Boolean));
}

function emptyState(iconName, title, body) {
  return el("div", { class: "empty" }, [
    el("div", { class: "empty__art", html: ICON[iconName] }),
    el("h3", { class: "empty__title", text: title }),
    el("p", { class: "empty__body", text: body })
  ]);
}
function skeletonList(n = 5) {
  return el("div", { class: "skel-list" }, Array.from({ length: n }, () =>
    el("div", { class: "skel-row" }, [el("div", { class: "skel-avatar" }), el("div", { class: "skel-lines" }, [el("div", { class: "skel-line" }), el("div", { class: "skel-line skel-line--short" })])])));
}

/* ======================================================= CHAT LIST ======== */
async function renderChatList() {
  stopPolling();
  const header = topbar("Chats");
  const container = el("div", { class: "list", id: "chatlist" });
  shell(header, [container]);

  // Paint from memory first (instant tab switch), then IDB, then network if stale
  if (state.mem.conversations) {
    paintChatList(container, state.mem.conversations);
  } else {
    const cached = await DB.getConversations();
    if (cached.length) {
      state.mem.conversations = cached;
      paintChatList(container, cached);
    } else {
      container.appendChild(emptyState("chats", "No conversations yet", "Head to Signals to connect with someone, then start chatting."));
    }
  }

  const stale = Date.now() - (state.mem.conversationsAt || 0) > POLL.TAB_CACHE_MS;
  if (stale) {
    // Yield to the browser so the tab paints before the slow GAS call
    requestAnimationFrame(() => refreshChatList(container));
  }
  startPolling(POLL.CHAT_LIST, () => refreshChatList(container));
}
async function refreshChatList(container) {
  if (!container.isConnected) return;
  try {
    const { conversations } = await call("listConversations", {}, { background: true });
    state.mem.conversations = conversations;
    state.mem.conversationsAt = Date.now();
    await DB.putConversations(conversations);
    applyBadge(conversations.reduce((n, c) => n + (c.unreadCount || 0), 0));
    if (state.route.name === "chats" && container.isConnected) paintChatList(container, conversations);
  } catch (e) {
    if (isSessionDead(e)) forceReLogin(e);
    else if (!(e instanceof ApiError && (e.code === "NETWORK" || e.code === "TIMEOUT"))) toast(errText(e), "error");
  }
}

// ---- unread badge (Chats tab dot + installed-icon badge) ----
function applyBadge(total) {
  state.unreadTotal = total || 0;
  const chatsBtn = document.querySelector('.navbtn[data-nav="chats"]');
  if (chatsBtn) {
    let dot = chatsBtn.querySelector(".nav-dot");
    if (state.unreadTotal > 0) { if (!dot) chatsBtn.appendChild(el("span", { class: "nav-dot", "aria-label": "new messages" })); }
    else if (dot) dot.remove();
  }
  try {
    if ("setAppBadge" in navigator) {
      if (state.unreadTotal > 0) navigator.setAppBadge(state.unreadTotal).catch(() => {});
      else navigator.clearAppBadge().catch(() => {});
    }
  } catch (e) { /* unsupported */ }
}
async function refreshBadge() {
  if (!state.user || !getToken()) return;
  // Don't compete with chat polling
  if (state.route.name === "chats" || state.route.name === "conversation") return;
  try {
    const { conversations } = await call("listConversations", {}, { background: true });
    await DB.putConversations(conversations);
    applyBadge(conversations.reduce((n, c) => n + (c.unreadCount || 0), 0));
  } catch (e) { /* silent */ }
}
function paintChatList(container, conversations) {
  container.textContent = "";
  const list = conversations.slice().sort((a, b) => (b.lastMessageAt || "").localeCompare(a.lastMessageAt || ""));
  if (!list.length) { container.appendChild(emptyState("chats", "No conversations yet", "Head to Signals to connect with someone, then start chatting.")); return; }
  list.forEach((c) => {
    const other = c.otherUser || { displayName: c.title || "Conversation" };
    const lastSeq = c.lastMessageSequence || 0;
    const cleared = c.clearedBeforeSequence || 0;
    const hasVisible = lastSeq > cleared;
    const preview = hasVisible ? (c.lastMessagePreview || "") : (lastSeq === 0 ? "Say hi 👋" : "No messages");
    const timeTxt = hasVisible && c.lastMessageAt ? timeOf(c.lastMessageAt) : "";
    const row = el("a", { class: "row", href: "#/chat/" + c.conversationId }, [
      avatar(other, 52),
      el("div", { class: "row__main" }, [
        el("div", { class: "row__top" }, [
          el("span", { class: "row__name", text: other.displayName || other.username || "Conversation" }),
          el("span", { class: "row__time", text: timeTxt })
        ]),
        el("div", { class: "row__bottom" }, [
          el("span", { class: "row__preview", text: preview }),
          hasVisible && c.unreadCount > 0 ? el("span", { class: "badge", text: String(c.unreadCount) }) : null
        ].filter(Boolean))
      ])
    ]);
    container.appendChild(row);
  });
}

/* ======================================================= CONTACTS ========= */
/* ======================================================= SIGNALS ========= */
// Rebrand knobs — change these strings to rename the whole tab in one place.
const SIGNAL = {
  tab: "Signals",
  code: "Your Signal Code",
  connectTitle: "Connect with someone",
  connect: "Connect",
  requests: "Requests",
  pending: "Pending",
  linked: "Linked"
};

// Live view handle so action handlers can update the lists instantly (optimistic)
// and reconcile in the background, instead of waiting on a second round-trip.
let _signals = null;

function myCodeText() {
  const c = state.user && state.user.pairingCode;
  return c ? String(c) : "—";
}

function paintMyCode(box) {
  box.textContent = "";
  const code = myCodeText();
  box.appendChild(el("div", { class: "card" }, [
    el("h3", { class: "card__title", text: SIGNAL.code }),
    el("div", { text: code, style: "font-size:30px;font-weight:800;letter-spacing:8px;text-align:center;padding:6px 0" }),
    el("div", { class: "row__actions", style: "justify-content:center" }, [
      el("button", { class: "btn btn--ghost btn--sm", text: "Copy code", onclick: async () => {
        try { await navigator.clipboard.writeText(code); toast("Code copied", "success"); }
        catch (e) { toast("Copy failed — write it down", "error"); }
      } })
    ]),
    el("p", { class: "hint", style: "padding:0", text: "Share this only with people you want to reach you." })
  ]));
}

/**
 * Optimistic Signals action: apply a local change to the lists immediately,
 * repaint, then confirm with the server in the background. On failure, re-fetch
 * the truth so the UI can't drift.
 */
function signalOptimistic(mutate, apiCall, okToast) {
  if (!_signals || !_signals.data) {
    apiCall().then(() => { if (_signals && _signals.reload) _signals.reload(); })
      .catch((e) => { if (isSessionDead(e)) forceReLogin(e); else toast(errText(e), "error"); });
    return;
  }
  try { mutate(); _signals.repaint(); } catch (e) {}
  apiCall().then(() => {
    if (okToast) toast(okToast, "success");
    state.mem.contactsAt = Date.now(); // keep cache "fresh" so a revisit doesn't flicker
  }).catch((e) => {
    if (isSessionDead(e)) { forceReLogin(e); return; }
    toast(errText(e), "error");
    if (_signals && _signals.reload) _signals.reload(); // restore server truth
  });
}

function paintConnect(box) {
  box.textContent = "";
  const input = el("input", {
    class: "input", type: "text", inputmode: "numeric", maxlength: "5",
    placeholder: "Enter a 5-digit code", autocomplete: "off", "aria-label": "Enter a code to connect"
  });
  input.addEventListener("input", () => { input.value = input.value.replace(/\D/g, "").slice(0, 5); });
  const btn = el("button", { class: "btn btn--primary btn--block", text: SIGNAL.connect });
  const submit = async () => {
    const code = input.value.replace(/\D/g, "");
    if (code.length !== 5) { toast("Enter the full 5-digit code", "error"); return; }
    btn.disabled = true; const orig = btn.textContent; btn.textContent = "Sending…";
    try {
      const data = await call("pairByCode", { code }); // foreground — jumps the queue
      input.value = "";
      const d = _signals && _signals.data;
      if (data && data.alreadyPaired) { toast("Already linked", "info"); }
      else if (data && data.linked) {
        toast("Linked!", "success");
        if (d && data.request) {
          const me = state.user && state.user.userId;
          const other = (data.request.requester && data.request.requester.userId === me)
            ? data.request.receiver : data.request.requester;
          if (other) { d.paired = d.paired || []; d.paired.push(other); _signals.repaint(); }
        }
      }
      else if (data && data.pending) { toast("Already requested", "info"); }
      else {
        toast("Request sent", "success");
        if (d && data.request) { d.outgoing = d.outgoing || []; d.outgoing.push(data.request); _signals.repaint(); }
      }
    } catch (e) { toast(errText(e), "error"); }
    finally { btn.disabled = false; btn.textContent = orig; }
  };
  btn.addEventListener("click", submit);
  input.addEventListener("keydown", (e) => { if (e.key === "Enter") submit(); });
  box.appendChild(el("div", { class: "card" }, [
    el("h3", { class: "card__title", text: SIGNAL.connectTitle }),
    el("p", { class: "hint", style: "padding:0", text: "Ask for their code, enter it here, and they'll get a request to link with you." }),
    field("Their code", input),
    btn
  ]));
}

function paintSignalRequests(box, incoming, outgoing) {
  box.textContent = "";
  if (incoming && incoming.length) {
    box.appendChild(el("h3", { class: "section__title", text: SIGNAL.requests }));
    incoming.forEach((r) => {
      const u = r.requester || {};
      const accept = el("button", { class: "btn btn--sm btn--primary", text: "Accept", onclick: () => {
        signalOptimistic(
          () => {
            const d = _signals.data;
            d.incoming = (d.incoming || []).filter((x) => x.contactId !== r.contactId);
            d.paired = d.paired || [];
            if (r.requester) d.paired.push(r.requester);
          },
          () => call("acceptContactRequest", { contactId: r.contactId }),
          "Linked"
        );
      } });
      const decline = el("button", { class: "btn btn--sm btn--ghost", text: "Decline", onclick: () => {
        signalOptimistic(
          () => { const d = _signals.data; d.incoming = (d.incoming || []).filter((x) => x.contactId !== r.contactId); },
          () => call("rejectContactRequest", { contactId: r.contactId })
        );
      } });
      box.appendChild(el("div", { class: "row row--compact" }, [
        avatar(u, 44),
        el("div", { class: "row__main" }, [
          el("span", { class: "row__name", text: u.displayName || "New request" }),
          el("span", { class: "row__preview", text: u.username ? "@" + u.username : "wants to link" })
        ]),
        el("div", { class: "row__actions" }, [accept, decline])
      ]));
    });
  }
  if (outgoing && outgoing.length) {
    box.appendChild(el("h3", { class: "section__title", text: SIGNAL.pending }));
    outgoing.forEach((r) => {
      const u = r.receiver || {};
      const cancel = el("button", { class: "btn btn--sm btn--ghost", text: "Cancel", onclick: () => {
        signalOptimistic(
          () => { const d = _signals.data; d.outgoing = (d.outgoing || []).filter((x) => x.contactId !== r.contactId); },
          () => call("cancelContactRequest", { contactId: r.contactId }),
          "Request cancelled"
        );
      } });
      box.appendChild(el("div", { class: "row row--compact" }, [
        avatar(u, 44),
        el("div", { class: "row__main" }, [
          el("span", { class: "row__name", text: u.displayName || "Pending" }),
          el("span", { class: "row__preview", text: "waiting for them to accept" })
        ]),
        cancel
      ]));
    });
  }
}

function paintLinked(box, paired) {
  box.textContent = "";
  box.appendChild(el("h3", { class: "section__title", text: SIGNAL.linked }));
  if (!paired || !paired.length) {
    box.appendChild(emptyState("people", "No one linked yet", "Share your code, or enter someone else's above to connect."));
    return;
  }
  paired.forEach((u) => {
    box.appendChild(el("div", { class: "row row--compact" }, [
      avatar(u, 44),
      el("div", { class: "row__main" }, [
        el("span", { class: "row__name", text: u.displayName }),
        el("span", { class: "row__preview", text: u.online ? "online" : "@" + u.username })
      ]),
      el("div", { class: "row__actions" }, [
        el("button", { class: "btn btn--sm btn--ghost", text: "Message", onclick: () => startChat(u) }),
        el("button", { class: "btn btn--sm btn--danger", text: "Remove", onclick: () => {
          signalOptimistic(
            () => { const d = _signals.data; d.paired = (d.paired || []).filter((x) => x.userId !== u.userId); },
            () => call("removeContact", { userId: u.userId }),
            "Removed"
          );
        } })
      ])
    ]));
  });
}

async function renderSignals() {
  stopPolling();
  const header = el("header", { class: "topbar" }, [
    el("div", { class: "topbar__titles" }, [el("h1", { class: "topbar__title", text: SIGNAL.tab })])
  ]);
  const codeBox = el("div", { class: "section", id: "mycode" });
  const connectBox = el("div", { class: "section", id: "connect" });
  const requestsBox = el("div", { class: "section", id: "requests" });
  const linkedBox = el("div", { class: "section", id: "linked" });
  shell(header, [codeBox, connectBox, requestsBox, linkedBox]);

  const reload = () => { if (state.poll.fn) state.poll.fn(); };
  _signals = {
    data: null,
    boxes: { requests: requestsBox, linked: linkedBox },
    reload: reload,
    repaint: function () {
      if (this.data && state.route.name === "signals") {
        paintSignalRequests(this.boxes.requests, this.data.incoming || [], this.data.outgoing || []);
        paintLinked(this.boxes.linked, this.data.paired || []);
      }
    }
  };

  paintMyCode(codeBox);
  paintConnect(connectBox);

  function applyPayload(data) {
    if (!data.paired) data.paired = data.contacts || []; // normalize older cache shape
    _signals.data = data;
    _signals.repaint();
  }

  async function loadAll(silent) {
    try {
      let data;
      try {
        data = await call("pairingHome", {}, { background: true });
      } catch (e) {
        if (!(e instanceof ApiError) || e.code === "NETWORK" || e.code === "TIMEOUT") throw e;
        // Fallback if the backend hasn't been updated to pairingHome yet
        const [cts, reqs] = await Promise.all([
          call("listContacts", {}, { background: true }),
          call("listContactRequests", {}, { background: true })
        ]);
        data = { paired: cts.contacts || [], incoming: reqs.incoming || [], outgoing: reqs.outgoing || [] };
      }
      state.mem.contacts = data;
      state.mem.contactsAt = Date.now();
      await DB.setKV("contactsCache", data);
      if (state.route.name === "signals") applyPayload(data);
    } catch (e) {
      if (isSessionDead(e)) { forceReLogin(e); return; }
      if (!silent && !(e instanceof ApiError && (e.code === "NETWORK" || e.code === "TIMEOUT"))) toast(errText(e), "error");
    }
  }

  // Instant paint from cache, then refresh in background
  if (state.mem.contacts) {
    applyPayload(state.mem.contacts);
  } else {
    linkedBox.appendChild(el("h3", { class: "section__title", text: SIGNAL.linked }));
    linkedBox.appendChild(skeletonList(3));
    const cached = await DB.getKV("contactsCache");
    if (cached && (cached.paired || cached.contacts)) { state.mem.contacts = cached; applyPayload(cached); }
  }
  const stale = Date.now() - (state.mem.contactsAt || 0) > POLL.TAB_CACHE_MS;
  if (stale) requestAnimationFrame(() => loadAll(!!state.mem.contacts));
  startPolling(POLL.CONTACTS, () => loadAll(true));
}

async function startChat(user) {
  try {
    const { conversation } = await call("createDirectConversation", { otherUserId: user.userId });
    await DB.putConversation(conversation);
    location.hash = "#/chat/" + conversation.conversationId;
  } catch (e) { toast(errText(e), "error"); }
}

/* ==================================================== CONVERSATION ======== */
async function renderConversation(conversationId) {
  stopPolling();
  let conv = (await DB.getConversations()).find((c) => c.conversationId === conversationId);
  const other = conv?.otherUser || {};
  state.activeConversation = {
    conversationId,
    otherUser: other,
    lastSequence: 0,
    clearedBefore: conv?.clearedBeforeSequence || 0,
    readUpTo: 0
  };

  const menuBtn = el("button", { class: "iconbtn", "aria-label": "Conversation options", html: ICON.more, onclick: () => convMenu(conversationId) });
  const header = topbar(other.displayName || "Conversation", {
    back: true, avatar: avatar(other, 40),
    subtitle: lastSeenText(other), subtitleOnline: other.online, action: menuBtn
  });

  const thread = el("div", { class: "thread", id: "thread" });
  const loadMore = el("button", { class: "loadmore", text: "Load earlier messages", onclick: () => loadHistory(thread) });
  const textarea = el("textarea", { class: "composer__input", rows: "1", placeholder: "Message", maxlength: String(MESSAGE_MAX), "aria-label": "Message" });
  const sendBtn = el("button", { class: "composer__send", "aria-label": "Send", html: ICON.send, disabled: true });
  const composer = el("div", { class: "composer" }, [
    el("div", { class: "composer__box" }, [textarea, sendBtn])
  ]);

  shell(header, [el("div", { class: "loadmore-wrap", id: "loadmore-wrap" }, [loadMore]), thread, composer], { hideNav: true });

  // auto-grow + enable send
  const grow = () => { textarea.style.height = "auto"; textarea.style.height = Math.min(textarea.scrollHeight, 140) + "px"; sendBtn.disabled = textarea.value.trim() === ""; };
  textarea.addEventListener("input", grow);
  textarea.addEventListener("keydown", (e) => { if (e.key === "Enter" && !e.shiftKey && !isMobile()) { e.preventDefault(); doSend(); } });
  textarea.addEventListener("focus", () => setTimeout(() => scrollBottom(thread), 350));
  sendBtn.addEventListener("click", doSend);

  async function doSend() {
    const text = textarea.value.trim();
    if (!text) return;
    textarea.value = ""; grow(); textarea.focus();
    const clientMessageId = "cm_" + uuid();
    const pending = {
      clientMessageId, conversationId, senderId: state.user.userId, text,
      status: "pending", createdAt: new Date().toISOString(), sequenceNumber: 999999999
    };
    await DB.addPending(pending);
    appendMessage(thread, pending);
    scrollBottom(thread);
    sendBtn.classList.add("composer__send--pulse");
    setTimeout(() => sendBtn.classList.remove("composer__send--pulse"), 400);
    flushPending();
  }

  // initial paint from cache, then live fetch
  const cached = await DB.getMessages(conversationId);
  const visible = cached.filter((m) => (m.sequenceNumber || 0) > state.activeConversation.clearedBefore);
  paintThread(thread, visible);
  const pend = (await DB.getPending()).filter((p) => p.conversationId === conversationId);
  pend.forEach((p) => appendMessage(thread, p));
  if (visible.length) state.activeConversation.lastSequence = visible[visible.length - 1].sequenceNumber || 0;
  scrollBottom(thread);

  // Cache is already on screen — refresh in background (don't freeze the composer)
  pollConversation(thread, true);
  startPolling(POLL.OPEN_CONVERSATION, () => pollConversation(thread, false));
}

async function pollConversation(thread, first) {
  const ac = state.activeConversation;
  if (!ac) return;
  if (state.poll.msgInFlight) return;
  state.poll.msgInFlight = true;
  try {
    const pending = await DB.getPending();
    if (pending.length) flushPending().catch(() => {});

    const { messages, readUpTo } = await call("getMessages", { conversationId: ac.conversationId, afterSequence: ac.lastSequence }, { background: true });
    if (messages.length) {
      await DB.putMessages(ac.conversationId, messages);
      const wasBottom = nearBottom(thread);
      messages.forEach((m) => upsertMessage(thread, m));
      ac.lastSequence = Math.max(ac.lastSequence, ...messages.map((m) => m.sequenceNumber || 0));
      if (wasBottom || first) scrollBottom(thread);
      markRead(ac.conversationId, ac.lastSequence);
      state.poll.burst = true;
    }
    if (readUpTo != null && readUpTo > ac.readUpTo) { ac.readUpTo = readUpTo; markReadTicks(readUpTo); }
  } catch (e) {
    if (isSessionDead(e)) forceReLogin(e);
  } finally { state.poll.msgInFlight = false; }
}
async function refreshPresence() {
  const ac = state.activeConversation;
  if (!ac || state.poll.presenceInFlight) return;
  state.poll.presenceInFlight = true;
  try {
    const { conversation } = await call("getConversation", { conversationId: ac.conversationId }, { background: true });
    ac.otherUser = conversation.otherUser || ac.otherUser;
    const sub = $(".topbar__subtitle");
    if (sub) { sub.textContent = lastSeenText(ac.otherUser); sub.classList.toggle("is-online", !!ac.otherUser.online); }
    const av = $(".topbar .avatar");
    if (av) { av.querySelector(".avatar__dot")?.remove(); if (ac.otherUser.online) av.appendChild(el("span", { class: "avatar__dot" })); }
  } catch (e) {}
  finally { state.poll.presenceInFlight = false; }
}

let _readTimer = null;
function markRead(conversationId, seq) {
  clearTimeout(_readTimer);
  _readTimer = setTimeout(async () => {
    try {
      const convs = await DB.getConversations();
      const c = convs.find((x) => x.conversationId === conversationId);
      const was = (c && c.unreadCount) || 0;
      if (c && was) {
        c.unreadCount = 0;
        await DB.putConversation(c);
      }
      applyBadge(Math.max(0, (state.unreadTotal || 0) - was));
    } catch (e) { /* keep prior badge */ }
    call("markConversationRead", { conversationId, lastReadSequence: seq }).catch((e) => {
      if (isSessionDead(e)) forceReLogin(e);
    });
  }, 1200);
}

function isSessionDead(e) {
  return e instanceof ApiError && ["INVALID_TOKEN", "UNAUTHENTICATED", "SESSION_EXPIRED", "ACCOUNT_SUSPENDED"].includes(e.code);
}

async function forceReLogin(e) {
  stopPolling();
  if (state.badgeTimer) { clearInterval(state.badgeTimer); state.badgeTimer = null; }
  setToken("");
  state.user = null;
  state.activeConversation = null;
  try {
    await DB.delKV("token");
    await DB.delKV("user");
  } catch (err) {}
  if (location.hash !== "#/login") location.hash = "#/login";
  toast(e && e.code === "ACCOUNT_SUSPENDED" ? "Account suspended" : "Session expired — sign in again", "error");
}

function paintThread(thread, messages) {
  thread.textContent = "";
  let lastDay = "";
  messages.forEach((m) => {
    const d = dayLabel(m.createdAt);
    if (d !== lastDay) { thread.appendChild(el("div", { class: "daysep" }, [el("span", { text: d })])); lastDay = d; }
    thread.appendChild(bubble(m));
  });
}
function appendMessage(thread, m) {
  const msgs = thread.querySelectorAll(".bubble");
  const lastTime = msgs.length ? msgs[msgs.length - 1].dataset.day : "";
  const d = dayLabel(m.createdAt);
  if (d !== lastTime) thread.appendChild(el("div", { class: "daysep" }, [el("span", { text: d })]));
  thread.appendChild(bubble(m));
}
function upsertMessage(thread, m) {
  const existing = thread.querySelector(`[data-cid="${CSS.escape(m.clientMessageId || "")}"]`) ||
    thread.querySelector(`[data-mid="${CSS.escape(m.messageId || "")}"]`);
  const node = bubble(m);
  if (existing) existing.replaceWith(node);
  else appendMessage(thread, m);
}
function bubble(m) {
  const mine = m.senderId === state.user.userId;
  const node = el("div", {
    class: "bubble " + (mine ? "bubble--mine" : "bubble--theirs") + (m.status === "failed" ? " bubble--failed" : ""),
    dataset: { day: dayLabel(m.createdAt), cid: m.clientMessageId || "", mid: m.messageId || "", seq: String(m.sequenceNumber || 0) }
  });
  if (m.deleted) {
    node.appendChild(el("p", { class: "bubble__text bubble__text--deleted", text: "This message was deleted" }));
  } else {
    node.appendChild(el("p", { class: "bubble__text", text: m.text }));   // textContent — XSS-safe
  }
  let tickState = m.status;
  if (mine && !m.deleted && (m.status === "sent" || m.status === "read")) {
    const readUpTo = (state.activeConversation && state.activeConversation.readUpTo) || 0;
    tickState = (m.sequenceNumber && m.sequenceNumber <= readUpTo) ? "read" : "sent";
  }
  const meta = el("div", { class: "bubble__meta" }, [
    m.editedAt ? el("span", { class: "bubble__edited", text: "edited" }) : null,
    el("span", { class: "bubble__time", text: timeOf(m.createdAt) }),
    mine ? statusIcon(tickState) : null
  ].filter(Boolean));
  node.appendChild(meta);
  if (!m.deleted) node.addEventListener("click", () => messageMenu(m, mine));
  return node;
}
function statusIcon(status) {
  if (status === "pending") return el("span", { class: "tick tick--pending", html: ICON.clock, "aria-label": "sending" });
  if (status === "failed") return el("span", { class: "tick tick--failed", html: ICON.alert, "aria-label": "failed" });
  if (status === "read") return el("span", { class: "tick tick--read", html: ICON.checks, "aria-label": "seen" });
  return el("span", { class: "tick tick--sent", html: ICON.check, "aria-label": "sent" });
}
// Update tick marks in place when the other person's read position advances.
function markReadTicks(readUpTo) {
  const thread = $("#thread");
  if (!thread) return;
  thread.querySelectorAll(".bubble--mine").forEach((b) => {
    const seq = Number(b.dataset.seq) || 0;
    if (seq && seq <= readUpTo) {
      const tick = b.querySelector(".tick");
      if (tick && !tick.classList.contains("tick--read") && !tick.classList.contains("tick--pending") && !tick.classList.contains("tick--failed")) {
        tick.replaceWith(statusIcon("read"));
      }
    }
  });
}

function messageMenu(m, mine) {
  const items = [];
  if (!m.deleted && m.text) items.push({ label: "Copy", onClick: () => navigator.clipboard?.writeText(m.text).then(() => toast("Copied", "success")) });
  if (mine && m.messageId && m.status !== "pending") {
    items.push({ label: "Edit", onClick: () => editMessage(m) });
    items.push({ label: "Delete", danger: true, onClick: () => deleteMessage(m) });
  }
  if (!mine && m.messageId) items.push({ label: "Report message", danger: true, onClick: () => reportMessage(m) });
  if (m.status === "failed") items.push({ label: "Retry send", onClick: () => flushPending() });
  if (items.length) sheet(items);
}
function editMessage(m) {
  const ta = el("textarea", { class: "input input--area", rows: "3" }); ta.value = m.text;
  modal("Edit message", [ta], [
    el("button", { class: "btn btn--ghost", text: "Cancel", onclick: closeOverlays }),
    el("button", { class: "btn btn--primary", text: "Save", onclick: async () => {
      try { await call("editMessage", { messageId: m.messageId, text: ta.value.trim() }); closeOverlays(); toast("Message updated", "success"); refreshThreadNow(); }
      catch (e) { toast(errText(e), "error"); } } })
  ]);
}
function deleteMessage(m) {
  modal("Delete message?", [el("p", { text: "This removes the message for everyone in the chat." })], [
    el("button", { class: "btn btn--ghost", text: "Cancel", onclick: closeOverlays }),
    el("button", { class: "btn btn--danger", text: "Delete", onclick: async () => {
      try { await call("deleteMessage", { messageId: m.messageId }); closeOverlays(); refreshThreadNow(); }
      catch (e) { toast(errText(e), "error"); } } })
  ]);
}
function reportMessage(m) {
  reportDialog("Report message", async (reason, details) => {
    await call("reportMessage", { messageId: m.messageId, reason, details });
  });
}
function reportDialog(title, submit) {
  const reason = el("select", { class: "input" }, ["Spam", "Harassment", "Inappropriate", "Other"].map((r) => el("option", { value: r.toLowerCase(), text: r })));
  const details = el("textarea", { class: "input input--area", rows: "3", placeholder: "Add any details (optional)" });
  modal(title, [field("Reason", reason), field("Details", details)], [
    el("button", { class: "btn btn--ghost", text: "Cancel", onclick: closeOverlays }),
    el("button", { class: "btn btn--danger", text: "Submit report", onclick: async () => {
      try { await submit(reason.value, details.value); closeOverlays(); toast("Report submitted", "success"); }
      catch (e) { toast(errText(e), "error"); } } })
  ]);
}
async function refreshThreadNow() {
  const ac = state.activeConversation; if (!ac) return;
  await DB.clearMessages(ac.conversationId);
  ac.lastSequence = ac.clearedBefore;
  const thread = $("#thread"); if (thread) { thread.textContent = ""; await pollConversation(thread, true); }
}

function convMenu(conversationId) {
  const items = [];
  // Only offer Clear when this thread actually has messages (or pending sends)
  if (threadHasMessages(conversationId)) {
    items.push({ label: "Clear chat (this device)", onClick: () => clearChat(conversationId) });
  }
  items.push({
    label: "Report user", danger: true, onClick: () => {
      const other = state.activeConversation?.otherUser;
      if (other?.userId) reportDialog("Report user", async (reason, details) => { await call("reportUser", { reportedUserId: other.userId, reason, details }); });
    }
  });
  sheet(items);
}

/** True if the open thread (or local cache) still has something to clear. */
function threadHasMessages(conversationId) {
  const thread = $("#thread");
  if (thread && thread.querySelector(".bubble")) return true;
  // Fallback for race before paint: check in-memory active cursor
  const ac = state.activeConversation;
  if (ac && ac.conversationId === conversationId && ac.lastSequence > (ac.clearedBefore || 0)) return true;
  return false;
}

function clearChat(conversationId) {
  if (!threadHasMessages(conversationId)) return;
  let busy = false;
  const clearBtn = el("button", { class: "btn btn--danger", text: "Clear", onclick: async () => {
    if (busy) return;
    busy = true;
    clearBtn.disabled = true;
    clearBtn.textContent = "Clearing…";
    try {
      const { clearedBeforeSequence } = await call("clearConversation", { conversationId });
      await DB.clearMessages(conversationId);
      if (state.activeConversation) {
        state.activeConversation.clearedBefore = clearedBeforeSequence;
        state.activeConversation.lastSequence = clearedBeforeSequence;
      }
      // Hide last-message preview in the chat list for this device
      const convs = await DB.getConversations();
      const conv = convs.find((c) => c.conversationId === conversationId);
      if (conv) {
        conv.clearedBeforeSequence = clearedBeforeSequence;
        conv.lastMessagePreview = "";
        conv.lastMessageAt = "";
        conv.unreadCount = 0;
        await DB.putConversation(conv);
      }
      closeOverlays();
      const thread = $("#thread"); if (thread) thread.textContent = "";
      toast("Chat cleared", "success");
    } catch (e) {
      busy = false;
      clearBtn.disabled = false;
      clearBtn.textContent = "Clear";
      toast(errText(e), "error");
    }
  }});
  modal("Clear this chat?", [el("p", { text: "Messages will be hidden for you on all devices. Your contact keeps their copy." })], [
    el("button", { class: "btn btn--ghost", text: "Cancel", onclick: closeOverlays }),
    clearBtn
  ]);
}

async function loadHistory(thread) {
  const ac = state.activeConversation; if (!ac) return;
  const cached = await DB.getMessages(ac.conversationId);
  const oldest = cached.filter((m) => (m.sequenceNumber || 0) > ac.clearedBefore)[0];
  const before = oldest ? oldest.sequenceNumber : ac.lastSequence + 1;
  try {
    const { messages, hasMore } = await call("getMessages", { conversationId: ac.conversationId, beforeSequence: before });
    if (!messages.length) { $("#loadmore-wrap")?.classList.add("hidden"); return; }
    await DB.putMessages(ac.conversationId, messages);
    const prevHeight = thread.scrollHeight;
    const merged = (await DB.getMessages(ac.conversationId)).filter((m) => (m.sequenceNumber || 0) > ac.clearedBefore && (m.sequenceNumber || 0) < (ac.lastSequence + 1));
    // repaint keeping pending at end
    paintThread(thread, merged);
    const pend = (await DB.getPending()).filter((p) => p.conversationId === ac.conversationId);
    pend.forEach((p) => appendMessage(thread, p));
    thread.scrollTop = thread.scrollHeight - prevHeight;
    if (!hasMore) $("#loadmore-wrap")?.classList.add("hidden");
  } catch (e) { toast(errText(e), "error"); }
}

/* ======================================================= PROFILE ========= */
async function renderProfile() {
  stopPolling();
  const u = state.user;
  const header = topbar("Profile");
  const theme = state.theme || "system";

  const display = el("input", { class: "input", type: "text", value: u.displayName || "" });
  const bio = el("textarea", { class: "input input--area", rows: "3", maxlength: "200" }); bio.value = u.bio || "";
  const saveBtn = el("button", { class: "btn btn--primary", text: "Save profile", onclick: async () => {
    saveBtn.disabled = true;
    try {
      const { user } = await call("updateProfile", { displayName: display.value, bio: bio.value });
      state.user = user; await DB.setKV("user", user); toast("Profile saved", "success");
    } catch (e) { toast(errText(e), "error"); } finally { saveBtn.disabled = false; }
  } });

  const themeSel = el("select", { class: "input", onchange: async (e) => {
    state.theme = e.target.value;
    await DB.setKV("theme", e.target.value);
    applyTheme(e.target.value);
  } },
    [["system", "Match system"], ["light", "Light"], ["dark", "Dark"]].map(([v, l]) => el("option", { value: v, text: l, selected: v === theme ? "selected" : null })));

  const logoutBtn = el("button", { class: "btn btn--danger btn--block", text: "Log out", onclick: logout });

  shell(header, [
    el("div", { class: "profile" }, [
      el("div", { class: "profile__head" }, [avatar(u, 84), el("div", {}, [
        el("h2", { class: "profile__name", text: u.displayName }),
        el("span", { class: "profile__handle", text: "@" + u.username }),
        u.pairingCode ? el("span", { class: "profile__handle", text: "Code " + u.pairingCode, style: "letter-spacing:3px" }) : null
      ])]),
      el("div", { class: "card" }, [field("Display name", display), field("Bio", bio), saveBtn]),
      passwordCard(),
      el("div", { class: "card" }, [el("h3", { class: "card__title", text: "Appearance" }), field("Theme", themeSel)]),
      lockCard(),
      el("div", { class: "card" }, [logoutBtn])
    ])
  ]);
}

function passwordCard() {
  const hasRecovery = !!(state.user && state.user.hasRecoveryCode);
  return el("div", { class: "card" }, [
    el("h3", { class: "card__title", text: "Password" }),
    el("p", { class: "hint", style: "padding:0", text: hasRecovery
      ? "You can change your password, or get a new recovery code (the old one stops working)."
      : "Set a recovery code so you can reset your password if you forget it." }),
    el("div", { class: "row__actions" }, [
      el("button", { class: "btn btn--ghost btn--sm", text: "Change password", onclick: openChangePassword }),
      el("button", { class: "btn btn--primary btn--sm", text: hasRecovery ? "New recovery code" : "Create recovery code", onclick: openRotateRecovery })
    ])
  ]);
}

function openChangePassword() {
  const cur = el("input", { class: "input", type: "password", autocomplete: "current-password", placeholder: "current password" });
  const next = el("input", { class: "input", type: "password", autocomplete: "new-password", placeholder: "new password (6+)" });
  const again = el("input", { class: "input", type: "password", autocomplete: "new-password", placeholder: "confirm new password" });
  modal("Change password", [
    field("Current password", cur),
    field("New password", next),
    field("Confirm", again)
  ], [
    el("button", { class: "btn btn--ghost", text: "Cancel", onclick: closeOverlays }),
    el("button", { class: "btn btn--primary", text: "Save", onclick: async () => {
      if (next.value !== again.value) { toast("Passwords don't match", "error"); return; }
      if (next.value.length < 6) { toast("Password must be at least 6 characters", "error"); return; }
      try {
        const data = await call("changePassword", {
          currentPassword: cur.value,
          newPassword: next.value,
          deviceId: state.deviceId
        });
        if (data.token) {
          setToken(data.token);
          await DB.setKV("token", data.token);
        }
        // Keep encrypted backup in sync — old vault still had the revoked token
        if (AppLock.isEnabled() && AppLock.getKey()) {
          try { await Vault.backup(AppLock.getKey()); } catch (e) {}
        }
        closeOverlays();
        toast("Password updated", "success");
      } catch (e) { toast(errText(e), "error"); }
    } })
  ]);
}

function openRotateRecovery() {
  const cur = el("input", { class: "input", type: "password", autocomplete: "current-password", placeholder: "current password" });
  modal("Recovery code", [
    el("p", { class: "hint", text: "Enter your password to create a new recovery code. Any old code will stop working." }),
    field("Current password", cur)
  ], [
    el("button", { class: "btn btn--ghost", text: "Cancel", onclick: closeOverlays }),
    el("button", { class: "btn btn--primary", text: "Generate", onclick: async () => {
      try {
        const data = await call("rotateRecoveryCode", { currentPassword: cur.value });
        if (state.user) {
          state.user.hasRecoveryCode = true;
          await DB.setKV("user", state.user);
        }
        closeOverlays();
        showRecoveryCodeModal(data.recoveryCode, { title: "Your new recovery code", onDone: () => renderProfile() });
      } catch (e) { toast(errText(e), "error"); }
    } })
  ]);
}

function lockCard() {
  const enabled = AppLock.isEnabled();
  const rows = [el("h3", { class: "card__title", text: "Privacy" })];
  if (enabled) {
    rows.push(el("p", { class: "hint", text: "App lock is on. On Android: long-press (or double-tap) the clock time, then enter your unlock time. Leaving the app seals chats." }));
    rows.push(el("div", { class: "row__actions" }, [
      el("button", { class: "btn btn--ghost btn--sm", text: "Change time", onclick: () => openLockSetup(true) }),
      el("button", { class: "btn btn--danger btn--sm", text: "Turn off", onclick: async () => {
        await AppLock.disable();
        toast("App lock turned off", "success");
        renderProfile();
      } })
    ]));
  } else {
    rows.push(el("p", { class: "hint", text: "Hide chats behind a clock. Your unlock time also encrypts messages on this device while locked." }));
    rows.push(el("button", { class: "btn btn--primary", text: "Turn on app lock", onclick: () => openLockSetup(false) }));
  }
  return el("div", { class: "card" }, rows);
}

function timeField(labelText, placeholder) {
  const input = el("input", {
    class: "input", type: "text", inputmode: "numeric", maxlength: "5",
    placeholder: placeholder || "11:30", autocomplete: "off", "aria-label": labelText
  });
  input.addEventListener("input", () => {
    let d = input.value.replace(/\D/g, "").slice(0, 4);
    if (d.length > 2) d = d.slice(0, 2) + ":" + d.slice(2);
    input.value = d;
  });
  return { wrap: field(labelText, input), input };
}

function openLockSetup(isChange) {
  const chat = timeField("Messages unlock time", "11:30");
  modal(isChange ? "Change unlock time" : "Set unlock time", [
    el("p", { class: "hint", text: "Use a clock time (e.g. 11:30). This unlocks chats and encrypts local data while the clock is showing." }),
    chat.wrap
  ], [
    el("button", { class: "btn btn--ghost", text: "Cancel", onclick: closeOverlays }),
    el("button", { class: "btn btn--primary", text: "Save", onclick: async () => {
      const c = normalizeTimePin(chat.input.value);
      if (!c) { toast("Enter a valid time like 11:30", "error"); return; }
      try {
        await AppLock.setPin(c);
        // Seal then restore so disk is encrypted-capable with the new key, session stays usable
        const key = AppLock.getKey();
        if (key) {
          await Vault.seal(key);
          await Vault.unseal(key);
          const token = await DB.getKV("token");
          const user = await DB.getKV("user");
          if (token) setToken(token);
          if (user) state.user = user;
        }
        closeOverlays();
        toast("App lock is on — unlock at " + formatTimePin(c), "success");
        renderProfile();
      } catch (e) { toast(e.message || "Could not save", "error"); }
    } })
  ]);
}

async function logout() {
  try { await call("logout", {}); } catch (e) {}
  if (state.badgeTimer) { clearInterval(state.badgeTimer); state.badgeTimer = null; }
  applyBadge(0);
  stopPolling();
  const keep = {
    deviceId: await DB.getKV("deviceId"),
    theme: await DB.getKV("theme"),
    lock: await DB.getKV("lock"),
    decoyAlarms: await DB.getKV("decoyAlarms")
  };
  await DB.clearAll();
  for (const [k, v] of Object.entries(keep)) {
    if (v != null) await DB.setKV(k, v);
  }
  AppLock.clearKey();
  await AppLock.load();
  setToken(""); state.user = null;
  state.mem = { conversations: null, conversationsAt: 0, contacts: null, contactsAt: 0 };
  document.body.classList.remove("is-locked");
  toast("Logged out", "success");
  location.hash = "#/login";
}

/* ======================================================= ADMIN =========== */
async function renderAdminLogin() {
  stopPolling();
  const username = el("input", { class: "input", type: "text", placeholder: "admin username", value: "Admin" });
  const password = el("input", { class: "input", type: "password", placeholder: "admin password" });
  const submit = el("button", { class: "btn btn--primary btn--block", text: "Sign in as admin", onclick: async () => {
    submit.disabled = true;
    try {
      const data = await call("adminLogin", { username: username.value, password: password.value }, { token: "" });
      await DB.setKV("adminToken", data.token);
      setToken(data.token);
      location.hash = "#/admin";
    } catch (e) { toast(errText(e), "error"); } finally { submit.disabled = false; }
  } });
  mount(authShell("Admin console", "Restricted access.",
    el("div", { class: "form" }, [field("Username", username), field("Password", password), submit]),
    el("div", { class: "auth__footer" }, [el("a", { class: "link link--muted", href: "#/login", text: "← Back to app" })])));
}

function confirmDeleteUser(u) {
  const confirmInput = el("input", { class: "input", placeholder: u.username, autocomplete: "off" });
  modal("Delete @" + u.username + "?", [
    el("p", { text: "This permanently deletes the account, all of its messages, and its chats. This cannot be undone." }),
    field("Type the username to confirm", confirmInput)
  ], [
    el("button", { class: "btn btn--ghost", text: "Cancel", onclick: closeOverlays }),
    el("button", { class: "btn btn--danger", text: "Delete permanently", onclick: async () => {
      if (confirmInput.value.trim() !== u.username) { toast("Username doesn't match", "error"); return; }
      try { await call("adminDeleteUser", { userId: u.userId }); closeOverlays(); toast("Account deleted", "success"); renderAdmin(); }
      catch (e) { toast(errText(e), "error"); }
    } })
  ]);
}

async function renderAdmin() {
  stopPolling();  const token = await DB.getKV("adminToken");
  if (!token) { location.hash = "#/admin/login"; return; }
  setToken(token);
  const header = el("header", { class: "topbar" }, [
    el("h1", { class: "topbar__title", text: "Admin" }),
    el("button", { class: "btn btn--sm btn--ghost", text: "Sign out", onclick: async () => { await DB.delKV("adminToken"); setToken(""); location.hash = "#/login"; } })
  ]);
  const stats = el("div", { class: "stats" });
  const usersBox = el("div", { class: "list" });
  const reportsBox = el("div", { class: "list" });
  shell(header, [
    stats,
    el("h3", { class: "section__title", text: "Reports" }), reportsBox,
    el("h3", { class: "section__title", text: "Users" }), usersBox
  ], { hideNav: true });

  try {
    const { totals } = await call("adminGetStats", {});
    stats.textContent = "";
    [["Users", totals.users], ["Chats", totals.conversations], ["Messages", totals.messages], ["Open reports", totals.openReports]]
      .forEach(([l, v]) => stats.appendChild(el("div", { class: "stat" }, [el("span", { class: "stat__num", text: String(v) }), el("span", { class: "stat__label", text: l })])));

    const { reports } = await call("adminListReports", {});
    reportsBox.textContent = "";
    if (!reports.length) reportsBox.appendChild(el("p", { class: "hint", text: "No reports." }));
    reports.forEach((r) => reportsBox.appendChild(el("div", { class: "row row--compact" }, [
      el("div", { class: "row__main" }, [
        el("span", { class: "row__name", text: (r.reported?.displayName || "?") + "  ·  " + r.reason }),
        el("span", { class: "row__preview", text: (r.details || "no details") + "  (" + r.status + ")" })
      ]),
      r.status === "open" ? el("button", { class: "btn btn--sm btn--ghost", text: "Mark reviewed", onclick: async () => {
        try { await call("adminUpdateReport", { reportId: r.reportId, status: "reviewed" }); renderAdmin(); } catch (e) { toast(errText(e), "error"); } } }) : null
    ].filter(Boolean))));

    const { users } = await call("adminListUsers", {});
    usersBox.textContent = "";
    users.forEach((u) => {
      const suspended = u.accountStatus === "suspended";
      usersBox.appendChild(el("div", { class: "row row--compact" }, [
        avatar({ displayName: u.displayName, online: u.online }, 40),
        el("div", { class: "row__main" }, [
          el("span", { class: "row__name", text: u.displayName + (suspended ? " (suspended)" : "") }),
          el("span", { class: "row__preview", text: "@" + u.username })
        ]),
        el("div", { class: "row__actions" }, [
          el("button", { class: "btn btn--sm btn--ghost", text: "Reset PW", onclick: () => adminResetUserPassword(u) }),
          el("button", { class: "btn btn--sm " + (suspended ? "btn--primary" : "btn--ghost"), text: suspended ? "Reactivate" : "Suspend", onclick: async () => {
            try { await call(suspended ? "adminReactivateUser" : "adminSuspendUser", { userId: u.userId, reason: "admin action" }); renderAdmin(); }
            catch (e) { toast(errText(e), "error"); } } }),
          el("button", { class: "btn btn--sm btn--danger", text: "Delete", onclick: () => confirmDeleteUser(u) })
        ])
      ]));
    });
  } catch (e) {
    toast(errText(e), "error");
    if (e instanceof ApiError && (e.code === "FORBIDDEN" || e.code === "INVALID_TOKEN")) { await DB.delKV("adminToken"); location.hash = "#/admin/login"; }
  }
}

function adminResetUserPassword(u) {
  const pw = el("input", { class: "input", type: "password", autocomplete: "new-password", placeholder: "new password (6+)" });
  modal("Reset @" + u.username, [
    el("p", { class: "hint", text: "Sets a new password and a new recovery code. Give both to the user securely." }),
    field("New password", pw)
  ], [
    el("button", { class: "btn btn--ghost", text: "Cancel", onclick: closeOverlays }),
    el("button", { class: "btn btn--primary", text: "Reset", onclick: async () => {
      if (pw.value.length < 6) { toast("Password must be at least 6 characters", "error"); return; }
      try {
        const data = await call("adminResetPassword", { userId: u.userId, newPassword: pw.value });
        closeOverlays();
        showRecoveryCodeModal(data.recoveryCode, {
          title: "Give to @" + u.username,
          hint: "New password was set. Also give them this recovery code (shown once).",
          doneText: "Done"
        });
      } catch (e) { toast(errText(e), "error"); }
    } })
  ]);
}

/* ======================================================= POLLING ========= */
function startPolling(interval, fn) {
  stopPolling();
  state.poll.fn = fn;
  state.poll.base = interval;
  state.poll.burst = false;
  const schedule = (delay) => { state.poll.timer = setTimeout(tick, delay); };
  const tick = async () => {
    await fn();
    // Always wait AFTER the previous call finishes — never stack on slow GAS
    let next = document.hidden ? POLL.HIDDEN_TAB : interval;
    if (state.poll.burst && !document.hidden) {
      next = POLL.CATCH_UP;
      state.poll.burst = false;
    }
    schedule(next);
  };
  schedule(interval);
}
function stopPolling() {
  if (state.poll.timer) { clearTimeout(state.poll.timer); state.poll.timer = null; }
  state.poll.fn = null;
  state.poll.msgInFlight = false;
  state.poll.presenceInFlight = false;
}

/* ======================================================= SYNC (offline) == */
async function flushPending() {
  if (state.syncing || !getToken()) return;
  state.syncing = true;
  try {
    const queue = await DB.getPending();
    for (const item of queue) {
      try {
        const { message } = await call("sendMessage", { conversationId: item.conversationId, clientMessageId: item.clientMessageId, text: item.text });
        await DB.removePending(item.clientMessageId);
        await DB.putMessages(item.conversationId, [message]);
        // swap the pending bubble for the confirmed one if the chat is open
        const thread = $("#thread");
        if (thread && state.activeConversation?.conversationId === item.conversationId) {
          upsertMessage(thread, message);
          state.activeConversation.lastSequence = Math.max(state.activeConversation.lastSequence, message.sequenceNumber || 0);
        }
      } catch (e) {
        const code = e instanceof ApiError ? e.code : "NETWORK";
        if (isSessionDead(e)) { await forceReLogin(e); break; }
        // Transient (offline, cold start, temporary server hiccup): keep the
        // message queued and retry next cycle. Resends are safe — the server
        // de-duplicates by clientMessageId — so nothing sends twice.
        if (["NETWORK", "TIMEOUT", "BAD_RESPONSE", "INTERNAL_ERROR", "RATE_LIMITED"].includes(code)) break;
        // Genuine error (e.g. validation): flag the bubble, no popup.
        item.status = "failed"; await DB.addPending(item);
        const node = document.querySelector(`[data-cid="${CSS.escape(item.clientMessageId)}"]`);
        if (node) { node.classList.add("bubble--failed"); node.querySelector(".tick")?.replaceWith(statusIcon("failed")); }
      }
    }
  } finally { state.syncing = false; }
}

/* ======================================================= THEME =========== */
function applyTheme(theme) {
  const root = document.documentElement;
  if (theme === "system") root.removeAttribute("data-theme");
  else root.setAttribute("data-theme", theme);
}

/* ======================================================= ROUTER ========== */
function parseHash() {
  const h = location.hash.replace(/^#/, "") || "/";
  const parts = h.split("/").filter(Boolean);       // ["chat","conv_x"]
  if (parts[0] === "chat" && parts[1]) return { name: "conversation", param: parts[1] };
  if (parts[0] === "admin" && parts[1] === "login") return { name: "adminLogin", param: null };
  if (parts[0] === "admin") return { name: "admin", param: null };
  const map = { register: "register", forgot: "forgot", chats: "chats", signals: "signals", contacts: "signals", profile: "profile", login: "login" };
  return { name: map[parts[0]] || (state.user ? "chats" : "login"), param: null };
}

async function route() {
  if (AppLock.isLocked()) return; // clock cover — no chat UI underneath
  closeOverlays();
  const r = parseHash();
  state.route = r;
  const needsAuth = ["chats", "signals", "profile", "conversation"].includes(r.name);
  if (needsAuth && !state.user) { location.hash = "#/login"; return; }
  if (state.user && ["login", "register", "forgot"].includes(r.name)) { location.hash = "#/chats"; return; }
  // Token is kept in memory — only hit IndexedDB if somehow missing
  if (r.name !== "admin" && r.name !== "adminLogin" && state.user && !getToken()) {
    const t = await DB.getKV("token");
    if (t) setToken(t);
  }

  switch (r.name) {
    case "login": return renderLogin();
    case "register": return renderRegister();
    case "forgot": return renderForgotPassword();
    case "chats": return renderChatList();
    case "signals": return renderSignals();
    case "conversation": return renderConversation(r.param);
    case "profile": return renderProfile();
    case "adminLogin": return renderAdminLogin();
    case "admin": return renderAdmin();
    default: return renderLogin();
  }
}

/* ======================================================= UTILITIES ======= */
function mount(node) { const root = appRoot(); root.textContent = ""; root.appendChild(node); }
function scrollBottom(node) { requestAnimationFrame(() => { node.scrollTop = node.scrollHeight; }); }
function applyViewportHeight() {
  const vv = window.visualViewport;
  const h = vv ? vv.height : window.innerHeight;
  document.documentElement.style.setProperty("--app-height", Math.round(h) + "px");
}
function nearBottom(node) { return node.scrollHeight - node.scrollTop - node.clientHeight < 120; }
function isMobile() { return matchMedia("(max-width: 640px)").matches; }

/* ======================================================= BOOT ============ */
async function secureLockUI() {
  stopPolling();
  if (state.badgeTimer) { clearInterval(state.badgeTimer); state.badgeTimer = null; }
  applyBadge(0);
  closeOverlays();
  setToken("");
  state.user = null;
  state.activeConversation = null;
  state.unreadTotal = 0;
  state.mem = { conversations: null, conversationsAt: 0, contacts: null, contactsAt: 0 };
  state.poll.fn = null;
  const root = appRoot();
  if (root) root.textContent = "";
}

async function secureLockSeal(key) {
  if (key) {
    try { await Vault.seal(key); } catch (e) { /* still locked visually */ }
  } else {
    try { await Vault.wipePlaintextSensitive(); } catch (e) {}
  }
}

async function secureUnlock(pin) {
  await AppLock.unlockKey(pin);
  const key = AppLock.getKey();
  let payload = null;
  try {
    payload = await Vault.unseal(key);
  } catch (e) {
    AppLock.clearKey();
    throw e;
  }
  const token = (payload && payload.token) || (await DB.getKV("token"));
  const user = (payload && payload.user) || (await DB.getKV("user"));
  if (token && user) {
    setToken(token);
    state.user = user;
    try {
      const v = await call("validateSession", {});
      if (v && v.user) {
        state.user = v.user;
        await DB.setKV("user", v.user);
      }
    } catch (e) {
      if (isSessionDead(e)) {
        AppLock.clearKey();
        await forceReLogin(e);
        return;
      }
    }
    // Refresh vault so force-kill keeps the live token
    try { await Vault.backup(key); } catch (e) {}
    location.hash = "#/chats";
    await route();
    flushPending();
    refreshBadge();
    if (state.badgeTimer) clearInterval(state.badgeTimer);
    state.badgeTimer = setInterval(refreshBadge, POLL.BADGE);
  } else {
    setToken("");
    state.user = null;
    location.hash = "#/login";
    await route();
    toast("Enter your account to continue", "info");
  }
}

async function boot() {
  // device id
  state.deviceId = await DB.getKV("deviceId");
  if (!state.deviceId) { state.deviceId = "dev_" + uuid(); await DB.setKV("deviceId", state.deviceId); }

  // theme
  state.theme = await DB.getKV("theme") || "system";
  applyTheme(state.theme);

  // keep the app sized to the visible area so the keyboard doesn't hide the chat
  applyViewportHeight();
  if (window.visualViewport) {
    window.visualViewport.addEventListener("resize", () => { applyViewportHeight(); const t = $("#thread"); if (t) scrollBottom(t); });
    window.visualViewport.addEventListener("scroll", applyViewportHeight);
  }
  window.addEventListener("resize", applyViewportHeight);
  window.addEventListener("orientationchange", () => setTimeout(applyViewportHeight, 300));

  // app lock first — decide whether session may be restored
  await AppLock.load();
  AppLock.init({
    onLockUI: () => secureLockUI(),
    onLockSeal: (key) => secureLockSeal(key),
    onUnlock: (pin) => secureUnlock(pin)
  });

  if (AppLock.isEnabled()) {
    await Vault.hardenForLockedBoot();
    // Do not restore session until unlock time is entered
    setToken("");
    state.user = null;
  } else {
    const token = await DB.getKV("token");
    const user = await DB.getKV("user");
    if (token && user) { setToken(token); state.user = user; }
  }

  // listeners
  window.addEventListener("hashchange", route);
  window.addEventListener("online", () => { toast("Back online", "success"); flushPending(); if (state.poll.fn) state.poll.fn(); });
  // Keep vault fresh while unlocked so force-kill doesn't restore a revoked/stale token
  const refreshVaultBackup = () => {
    if (!AppLock.isEnabled() || AppLock.isLocked() || !AppLock.getKey() || !getToken()) return;
    Vault.backup(AppLock.getKey()).catch(() => {});
  };
  document.addEventListener("visibilitychange", () => { if (document.hidden) refreshVaultBackup(); });
  window.addEventListener("pagehide", refreshVaultBackup);
  window.addEventListener("offline", () => toast("You're offline", "info"));

  const requestLock = () => {
    if (!AppLock.isEnabled() || AppLock.isLocked()) return;
    if (state.user || AppLock.hasKey()) AppLock.lock();
  };
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) { requestLock(); return; }
    if (state.poll.fn) state.poll.fn();
    if (state.user) refreshBadge();
  });
  // Android Chrome PWA: lock when app is backgrounded
  window.addEventListener("pagehide", requestLock);
  window.addEventListener("blur", () => { if (document.hidden) requestLock(); });
  window.addEventListener("pageshow", (e) => {
    if (e.persisted) requestLock();
  });
  // Android system Back button
  window.addEventListener("popstate", () => {
    if (AppLock.handleBack()) return;
  });

  // service worker — force update check on Android so deploys stick
  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("./service-worker.js")
      .then((reg) => { try { reg.update(); } catch (e) {} })
      .catch(() => {});
  }

  if (AppLock.isEnabled()) {
    // Clock only until secret time — no chat DOM underneath
    const root = appRoot();
    if (root) root.textContent = "";
    await AppLock.lock();
    return;
  }

  // validate session in background (silently drop if invalid)
  if (state.user) {
    call("validateSession", {}).then((d) => { if (d.user) { state.user = d.user; DB.setKV("user", d.user); } })
      .catch(async (e) => {
        if (e instanceof ApiError && ["INVALID_TOKEN", "SESSION_EXPIRED", "ACCOUNT_SUSPENDED"].includes(e.code)) {
          await Vault.wipePlaintextSensitive();
          await DB.delKV("vault");
          AppLock.clearKey();
          state.user = null; setToken("");
          location.hash = "#/login"; route();
        }
      });
  }

  if (!location.hash) location.hash = state.user ? "#/chats" : "#/login";
  await route();
  flushPending();
  if (state.user) { refreshBadge(); state.badgeTimer = setInterval(refreshBadge, POLL.BADGE); }
}

boot();
