// =============================================================================
//  Ripple — main application module (vanilla JS, no framework).
// =============================================================================
import { POLL, APP_NAME, MESSAGE_MAX } from "./config.js";
import { DB } from "./db.js";
import { call, ApiError, setToken, getToken } from "./api.js";
import { AppLock } from "./lock.js";

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
    if (e.code === "NETWORK") return "You're offline — we'll retry automatically.";
    if (e.code === "NOT_CONFIGURED") return e.message;
    return e.message || "Something went wrong.";
  }
  return "Something went wrong.";
}

/* --------------------------------------------------------- modal / sheet UI */
function closeOverlays() { document.querySelectorAll(".overlay").forEach((o) => o.remove()); }
function modal(title, contentNodes, actions = []) {
  closeOverlays();
  const box = el("div", { class: "modal", role: "dialog", "aria-modal": "true", "aria-label": title }, [
    el("h2", { class: "modal__title", text: title }),
    el("div", { class: "modal__body" }, contentNodes),
    el("div", { class: "modal__actions" }, actions)
  ]);
  const overlay = el("div", { class: "overlay", onclick: (e) => { if (e.target === overlay) closeOverlays(); } }, [box]);
  document.body.appendChild(overlay);
  const first = box.querySelector("input,textarea,button,select");
  if (first) first.focus();
  document.addEventListener("keydown", function esc(ev) {
    if (ev.key === "Escape") { closeOverlays(); document.removeEventListener("keydown", esc); }
  });
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
  badgeTimer: null
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
      el("div", { class: "brand-mark", html: ICON.chats }),
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
  const username = el("input", { class: "input", type: "text", autocomplete: "username", placeholder: "your username" });
  const password = el("input", { class: "input", type: "password", autocomplete: "current-password", placeholder: "••••••••" });
  const submit = el("button", { class: "btn btn--primary btn--block", text: "Sign in" });

  async function doLogin() {
    submit.disabled = true; submit.textContent = "Signing in…";
    try {
      const data = await call("login", { username: username.value, password: password.value, deviceId: state.deviceId });
      await afterAuth(data);
    } catch (e) { toast(errText(e), "error"); }
    finally { submit.disabled = false; submit.textContent = "Sign in"; }
  }
  submit.addEventListener("click", doLogin);
  [username, password].forEach((i) => i.addEventListener("keydown", (e) => { if (e.key === "Enter") doLogin(); }));

  mount(authShell("Welcome back", "Sign in to keep the conversation going.",
    el("div", { class: "form" }, [field("Username", username), field("Password", password), submit]),
    el("div", { class: "auth__footer" }, [
      el("p", {}, ["New here? ", el("a", { class: "link", href: "#/register", text: "Create an account" })]),
      el("a", { class: "link link--muted", href: "#/admin/login", text: "Admin sign in" })
    ])));
  username.focus();
}

function renderRegister() {
  const username = el("input", { class: "input", type: "text", autocomplete: "username", placeholder: "lowercase, 3–20 chars" });
  const display = el("input", { class: "input", type: "text", autocomplete: "name", placeholder: "how others see you" });
  const password = el("input", { class: "input", type: "password", autocomplete: "new-password", placeholder: "at least 6 characters" });
  const submit = el("button", { class: "btn btn--primary btn--block", text: "Create account" });

  submit.addEventListener("click", async () => {
    submit.disabled = true; submit.textContent = "Creating…";
    try {
      const data = await call("register", {
        username: username.value, displayName: display.value || username.value,
        password: password.value, deviceId: state.deviceId
      });
      await afterAuth(data);
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
  await DB.setKV("token", data.token);
  await DB.setKV("user", data.user);
  toast("Signed in", "success");
  location.hash = "#/chats";
  flushPending();
}

/* ======================================================= APP SHELL ======== */
function shell(headerNode, contentNode, opts = {}) {
  const tabs = opts.hideNav ? null : el("nav", { class: "bottomnav", "aria-label": "Primary" }, [
    navButton("chats", "Chats", "#/chats"),
    navButton("people", "Contacts", "#/contacts"),
    navButton("user", "Profile", "#/profile")
  ]);
  mount(el("div", { class: "shell" }, [headerNode, el("main", { class: "content", id: "content" }, contentNode), tabs].filter(Boolean)));
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

  const cached = await DB.getConversations();
  if (cached.length) paintChatList(container, cached);
  else container.appendChild(skeletonList());

  await refreshChatList(container);
  startPolling(POLL.CHAT_LIST, () => refreshChatList(container));
}
async function refreshChatList(container) {
  try {
    const { conversations } = await call("listConversations", {});
    await DB.putConversations(conversations);
    applyBadge(conversations.reduce((n, c) => n + (c.unreadCount || 0), 0));
    if (state.route.name === "chats") paintChatList(container, conversations);
  } catch (e) { if (!(e instanceof ApiError && e.code === "NETWORK")) toast(errText(e), "error"); }
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
  try {
    const { conversations } = await call("listConversations", {});
    await DB.putConversations(conversations);
    applyBadge(conversations.reduce((n, c) => n + (c.unreadCount || 0), 0));
  } catch (e) { /* silent */ }
}
function paintChatList(container, conversations) {
  container.textContent = "";
  const list = conversations.slice().sort((a, b) => (b.lastMessageAt || "").localeCompare(a.lastMessageAt || ""));
  if (!list.length) { container.appendChild(emptyState("chats", "No conversations yet", "Head to Contacts to add someone, then start chatting.")); return; }
  list.forEach((c) => {
    const other = c.otherUser || { displayName: c.title || "Conversation" };
    const row = el("a", { class: "row", href: "#/chat/" + c.conversationId }, [
      avatar(other, 52),
      el("div", { class: "row__main" }, [
        el("div", { class: "row__top" }, [
          el("span", { class: "row__name", text: other.displayName || other.username || "Conversation" }),
          el("span", { class: "row__time", text: c.lastMessageAt ? timeOf(c.lastMessageAt) : "" })
        ]),
        el("div", { class: "row__bottom" }, [
          el("span", { class: "row__preview", text: c.lastMessagePreview || "Say hi 👋" }),
          c.unreadCount > 0 ? el("span", { class: "badge", text: String(c.unreadCount) }) : null
        ].filter(Boolean))
      ])
    ]);
    container.appendChild(row);
  });
}

/* ======================================================= CONTACTS ========= */
async function renderContacts() {
  stopPolling();
  const search = el("input", { class: "input", type: "search", placeholder: "Search people by name or username", "aria-label": "Search people" });
  const header = el("header", { class: "topbar topbar--stack" }, [
    el("h1", { class: "topbar__title", text: "Contacts" }),
    el("div", { class: "searchbar" }, [search])
  ]);
  const requestsBox = el("div", { class: "section", id: "requests" });
  const peopleBox = el("div", { class: "section", id: "people" });
  shell(header, [requestsBox, peopleBox]);

  peopleBox.appendChild(el("h3", { class: "section__title", text: "People" }));
  peopleBox.appendChild(skeletonList(4));

  let directory = [];
  const rel = { contacts: new Set(), outgoing: new Set(), incoming: new Map() };

  async function loadAll() {
    try {
      const [dir, cts, reqs] = await Promise.all([
        call("listDirectory", {}),
        call("listContacts", {}),
        call("listContactRequests", {})
      ]);
      directory = dir.users || [];
      rel.contacts = new Set((cts.contacts || []).map((u) => u.userId));
      rel.outgoing = new Set((reqs.outgoing || []).map((r) => (r.receiver && r.receiver.userId) || r.receiverId));
      rel.incoming = new Map((reqs.incoming || []).map((r) => [(r.requester && r.requester.userId) || r.requesterId, r.contactId]));
      paintRequests(reqs.incoming || []);
      paintPeople();
    } catch (e) {
      if (!(e instanceof ApiError && e.code === "NETWORK")) toast(errText(e), "error");
    }
  }

  function paintRequests(incoming) {
    requestsBox.textContent = "";
    if (!incoming.length) return;
    requestsBox.appendChild(el("h3", { class: "section__title", text: "Requests" }));
    incoming.forEach((r) => {
      const u = r.requester || {};
      const accept = el("button", { class: "btn btn--sm btn--primary", text: "Accept", onclick: async () => {
        try { await call("acceptContactRequest", { contactId: r.contactId }); toast("Contact added", "success"); loadAll(); }
        catch (e) { toast(errText(e), "error"); } } });
      const reject = el("button", { class: "btn btn--sm btn--ghost", text: "Decline", onclick: async () => {
        try { await call("rejectContactRequest", { contactId: r.contactId }); loadAll(); }
        catch (e) { toast(errText(e), "error"); } } });
      requestsBox.appendChild(el("div", { class: "row row--compact" }, [
        avatar(u, 44),
        el("div", { class: "row__main" }, [el("span", { class: "row__name", text: u.displayName }), el("span", { class: "row__preview", text: "@" + u.username })]),
        el("div", { class: "row__actions" }, [accept, reject])
      ]));
    });
  }

  function paintPeople() {
    peopleBox.textContent = "";
    peopleBox.appendChild(el("h3", { class: "section__title", text: "People" }));
    const q = search.value.trim().toLowerCase();
    const list = directory.filter((u) => !q || u.username.indexOf(q) !== -1 || String(u.displayName || "").toLowerCase().indexOf(q) !== -1);
    if (!directory.length) { peopleBox.appendChild(emptyState("people", "No one else yet", "When other people sign up, they'll appear here to add.")); return; }
    if (!list.length) { peopleBox.appendChild(el("p", { class: "hint", text: "No matches." })); return; }
    list.forEach((u) => {
      let btn;
      if (rel.contacts.has(u.userId)) {
        btn = el("button", { class: "btn btn--sm btn--ghost", text: "Message", onclick: () => startChat(u) });
      } else if (rel.incoming.has(u.userId)) {
        btn = el("button", { class: "btn btn--sm btn--primary", text: "Accept", onclick: async () => {
          try { await call("acceptContactRequest", { contactId: rel.incoming.get(u.userId) }); toast("Contact added", "success"); loadAll(); }
          catch (e) { toast(errText(e), "error"); } } });
      } else if (rel.outgoing.has(u.userId)) {
        btn = el("button", { class: "btn btn--sm btn--ghost", text: "Requested", disabled: "disabled" });
      } else {
        btn = el("button", { class: "btn btn--sm btn--primary", text: "Add", onclick: async (ev) => {
          const b = ev.currentTarget; b.disabled = true;
          try { await call("sendContactRequest", { receiverId: u.userId }); toast("Request sent", "success"); rel.outgoing.add(u.userId); paintPeople(); }
          catch (e) { toast(errText(e), "error"); b.disabled = false; } } });
      }
      peopleBox.appendChild(el("div", { class: "row row--compact" }, [
        avatar(u, 44),
        el("div", { class: "row__main" }, [
          el("span", { class: "row__name", text: u.displayName }),
          el("span", { class: "row__preview", text: u.online ? "online" : "@" + u.username })
        ]),
        btn
      ]));
    });
  }

  search.addEventListener("input", () => paintPeople());
  await loadAll();
  startPolling(POLL.CHAT_LIST, () => loadAll());
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
    clearedBefore: conv?.clearedBeforeSequence || 0
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
    appendMessage(thread, pending, true);
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
  pend.forEach((p) => appendMessage(thread, p, true));
  if (visible.length) state.activeConversation.lastSequence = visible[visible.length - 1].sequenceNumber || 0;
  scrollBottom(thread);

  await pollConversation(thread, true);
  startPolling(POLL.OPEN_CONVERSATION, () => pollConversation(thread, false));
}

async function pollConversation(thread, first) {
  const ac = state.activeConversation;
  if (!ac) return;
  await flushPending();
  try {
    const { messages } = await call("getMessages", { conversationId: ac.conversationId, afterSequence: ac.lastSequence });
    if (messages.length) {
      await DB.putMessages(ac.conversationId, messages);
      const wasBottom = nearBottom(thread);
      messages.forEach((m) => upsertMessage(thread, m));
      ac.lastSequence = Math.max(ac.lastSequence, ...messages.map((m) => m.sequenceNumber || 0));
      if (wasBottom || first) scrollBottom(thread);
      markRead(ac.conversationId, ac.lastSequence);
    }
  } catch (e) { if (!(e instanceof ApiError && e.code === "NETWORK")) { /* keep quiet on transient */ } }

  // refresh presence every ~5 ticks
  state.poll.presenceTick = (state.poll.presenceTick + 1) % 5;
  if (first || state.poll.presenceTick === 0) refreshPresence();
}
async function refreshPresence() {
  const ac = state.activeConversation;
  if (!ac) return;
  try {
    const { conversation } = await call("getConversation", { conversationId: ac.conversationId });
    ac.otherUser = conversation.otherUser || ac.otherUser;
    const sub = $(".topbar__subtitle");
    if (sub) { sub.textContent = lastSeenText(ac.otherUser); sub.classList.toggle("is-online", !!ac.otherUser.online); }
    const av = $(".topbar .avatar");
    if (av) { av.querySelector(".avatar__dot")?.remove(); if (ac.otherUser.online) av.appendChild(el("span", { class: "avatar__dot" })); }
  } catch (e) {}
}

let _readTimer = null;
function markRead(conversationId, seq) {
  clearTimeout(_readTimer);
  _readTimer = setTimeout(() => { call("markConversationRead", { conversationId, lastReadSequence: seq }).then(() => refreshBadge()).catch(() => {}); }, 600);
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
    dataset: { day: dayLabel(m.createdAt), cid: m.clientMessageId || "", mid: m.messageId || "" }
  });
  if (m.deleted) {
    node.appendChild(el("p", { class: "bubble__text bubble__text--deleted", text: "This message was deleted" }));
  } else {
    node.appendChild(el("p", { class: "bubble__text", text: m.text }));   // textContent — XSS-safe
  }
  const meta = el("div", { class: "bubble__meta" }, [
    m.editedAt ? el("span", { class: "bubble__edited", text: "edited" }) : null,
    el("span", { class: "bubble__time", text: timeOf(m.createdAt) }),
    mine ? statusIcon(m.status) : null
  ].filter(Boolean));
  node.appendChild(meta);
  if (!m.deleted) node.addEventListener("click", () => messageMenu(m, mine));
  return node;
}
function statusIcon(status) {
  if (status === "pending") return el("span", { class: "tick tick--pending", html: ICON.clock, "aria-label": "sending" });
  if (status === "failed") return el("span", { class: "tick tick--failed", html: ICON.alert, "aria-label": "failed" });
  return el("span", { class: "tick tick--sent", html: ICON.check, "aria-label": "sent" });
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
  sheet([
    { label: "Clear chat (this device)", onClick: () => clearChat(conversationId) },
    { label: "Report user", danger: true, onClick: () => {
      const other = state.activeConversation?.otherUser;
      if (other?.userId) reportDialog("Report user", async (reason, details) => { await call("reportUser", { reportedUserId: other.userId, reason, details }); });
    } }
  ]);
}
function clearChat(conversationId) {
  modal("Clear this chat?", [el("p", { text: "Messages will be removed from this device. Your contact keeps their copy." })], [
    el("button", { class: "btn btn--ghost", text: "Cancel", onclick: closeOverlays }),
    el("button", { class: "btn btn--danger", text: "Clear", onclick: async () => {
      try {
        const { clearedBeforeSequence } = await call("clearConversation", { conversationId });
        await DB.clearMessages(conversationId);
        if (state.activeConversation) { state.activeConversation.clearedBefore = clearedBeforeSequence; state.activeConversation.lastSequence = clearedBeforeSequence; }
        closeOverlays();
        const thread = $("#thread"); if (thread) thread.textContent = "";
        toast("Chat cleared", "success");
      } catch (e) { toast(errText(e), "error"); }
    } })
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
  const theme = await DB.getKV("theme") || "system";

  const display = el("input", { class: "input", type: "text", value: u.displayName || "" });
  const bio = el("textarea", { class: "input input--area", rows: "3", maxlength: "200" }); bio.value = u.bio || "";
  const saveBtn = el("button", { class: "btn btn--primary", text: "Save profile", onclick: async () => {
    saveBtn.disabled = true;
    try {
      const { user } = await call("updateProfile", { displayName: display.value, bio: bio.value });
      state.user = user; await DB.setKV("user", user); toast("Profile saved", "success");
    } catch (e) { toast(errText(e), "error"); } finally { saveBtn.disabled = false; }
  } });

  const themeSel = el("select", { class: "input", onchange: async (e) => { await DB.setKV("theme", e.target.value); applyTheme(e.target.value); } },
    [["system", "Match system"], ["light", "Light"], ["dark", "Dark"]].map(([v, l]) => el("option", { value: v, text: l, selected: v === theme ? "selected" : null })));

  const logoutBtn = el("button", { class: "btn btn--danger btn--block", text: "Log out", onclick: logout });

  shell(header, [
    el("div", { class: "profile" }, [
      el("div", { class: "profile__head" }, [avatar(u, 84), el("div", {}, [
        el("h2", { class: "profile__name", text: u.displayName }),
        el("span", { class: "profile__handle", text: "@" + u.username })
      ])]),
      el("div", { class: "card" }, [field("Display name", display), field("Bio", bio), saveBtn]),
      el("div", { class: "card" }, [el("h3", { class: "card__title", text: "Appearance" }), field("Theme", themeSel)]),
      lockCard(),
      el("div", { class: "card" }, [logoutBtn])
    ])
  ]);
}

function lockCard() {
  const enabled = AppLock.isEnabled();
  const rows = [el("h3", { class: "card__title", text: "Privacy" })];
  if (enabled) {
    rows.push(el("p", { class: "hint", text: "App lock is on. When you reopen the app you'll see a clock — tap the top-right corner, then enter your PIN." }));
    rows.push(el("div", { class: "row__actions" }, [
      el("button", { class: "btn btn--ghost btn--sm", text: "Change PIN", onclick: () => openLockSetup(true) }),
      el("button", { class: "btn btn--danger btn--sm", text: "Turn off", onclick: async () => { await AppLock.disable(); toast("App lock turned off", "success"); renderProfile(); } })
    ]));
  } else {
    rows.push(el("p", { class: "hint", text: "Hide the app behind a clock screen. Reopening shows a clock; tap the top-right corner to reveal a keypad and enter your PIN." }));
    rows.push(el("button", { class: "btn btn--primary", text: "Turn on app lock", onclick: () => openLockSetup(false) }));
  }
  return el("div", { class: "card" }, rows);
}

function openLockSetup(isChange) {
  const digits = (e) => { e.target.value = e.target.value.replace(/\D/g, ""); };
  const pin = el("input", { class: "input", type: "password", inputmode: "numeric", maxlength: "6", placeholder: "4–6 digits", autocomplete: "off" });
  const confirm = el("input", { class: "input", type: "password", inputmode: "numeric", maxlength: "6", placeholder: "re-enter PIN", autocomplete: "off" });
  pin.addEventListener("input", digits); confirm.addEventListener("input", digits);
  modal(isChange ? "Change PIN" : "Set a PIN", [field("New PIN", pin), field("Confirm PIN", confirm)], [
    el("button", { class: "btn btn--ghost", text: "Cancel", onclick: closeOverlays }),
    el("button", { class: "btn btn--primary", text: "Save", onclick: async () => {
      const v = pin.value.trim();
      if (v.length < 4 || v.length > 6) { toast("PIN must be 4–6 digits", "error"); return; }
      if (v !== confirm.value.trim()) { toast("PINs don't match", "error"); return; }
      await AppLock.setPin(v); closeOverlays(); toast("App lock is on", "success"); renderProfile();
    } })
  ]);
}

async function logout() {
  try { await call("logout", {}); } catch (e) {}
  if (state.badgeTimer) { clearInterval(state.badgeTimer); state.badgeTimer = null; }
  applyBadge(0);
  await DB.clearAll();
  setToken(""); state.user = null;
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

/* ======================================================= POLLING ========= */
function startPolling(interval, fn) {
  stopPolling();
  state.poll.fn = fn;
  state.poll.base = interval;
  const run = () => { const iv = document.hidden ? POLL.HIDDEN_TAB : interval; state.poll.timer = setTimeout(async () => { await fn(); run(); }, iv); };
  run();
}
function stopPolling() { if (state.poll.timer) { clearTimeout(state.poll.timer); state.poll.timer = null; } state.poll.fn = null; }

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
        if (e instanceof ApiError && e.code === "NETWORK") break;       // offline: stop, keep queue
        item.status = "failed"; await DB.addPending(item);              // real error: mark failed
        const node = document.querySelector(`[data-cid="${CSS.escape(item.clientMessageId)}"]`);
        if (node) { node.classList.add("bubble--failed"); node.querySelector(".tick")?.replaceWith(statusIcon("failed")); }
        toast(errText(e), "error");
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
  const map = { register: "register", chats: "chats", contacts: "contacts", profile: "profile", login: "login" };
  return { name: map[parts[0]] || (state.user ? "chats" : "login"), param: null };
}

async function route() {
  closeOverlays();
  const r = parseHash();
  state.route = r;
  const needsAuth = ["chats", "contacts", "profile", "conversation"].includes(r.name);
  if (needsAuth && !state.user) { location.hash = "#/login"; return; }
  if (r.name !== "admin" && r.name !== "adminLogin" && state.user) setToken(await DB.getKV("token"));

  switch (r.name) {
    case "login": return renderLogin();
    case "register": return renderRegister();
    case "chats": return renderChatList();
    case "contacts": return renderContacts();
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
function nearBottom(node) { return node.scrollHeight - node.scrollTop - node.clientHeight < 120; }
function isMobile() { return matchMedia("(max-width: 640px)").matches; }

/* ======================================================= BOOT ============ */
async function boot() {
  // device id
  state.deviceId = await DB.getKV("deviceId");
  if (!state.deviceId) { state.deviceId = "dev_" + uuid(); await DB.setKV("deviceId", state.deviceId); }

  // theme
  applyTheme(await DB.getKV("theme") || "system");

  // restore session
  const token = await DB.getKV("token");
  const user = await DB.getKV("user");
  if (token && user) { setToken(token); state.user = user; }

  // app lock
  await AppLock.load();
  AppLock.init({ onLock: () => stopPolling(), onUnlock: () => route() });

  // listeners
  window.addEventListener("hashchange", route);
  window.addEventListener("online", () => { toast("Back online", "success"); flushPending(); if (state.poll.fn) state.poll.fn(); });
  window.addEventListener("offline", () => toast("You're offline", "info"));
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) { if (state.user && AppLock.isEnabled()) AppLock.lock(); return; }
    if (state.poll.fn) state.poll.fn();
    refreshBadge();
  });
  window.addEventListener("pagehide", () => { if (state.user && AppLock.isEnabled()) AppLock.lock(); });

  // service worker
  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("./service-worker.js").catch(() => {});
  }

  // validate session in background (silently drop if invalid)
  if (state.user) {
    call("validateSession", {}).then((d) => { if (d.user) { state.user = d.user; DB.setKV("user", d.user); } })
      .catch(async (e) => { if (e instanceof ApiError && ["INVALID_TOKEN", "SESSION_EXPIRED", "ACCOUNT_SUSPENDED"].includes(e.code)) { await DB.clearAll(); state.user = null; setToken(""); location.hash = "#/login"; route(); } });
  }

  if (!location.hash) location.hash = state.user ? "#/chats" : "#/login";
  await route();
  if (state.user && AppLock.isEnabled()) AppLock.lock();  // show decoy over the rendered app
  flushPending();
  if (state.user) { refreshBadge(); state.badgeTimer = setInterval(refreshBadge, 15000); }
}

boot();
