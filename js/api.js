// =============================================================================
//  API client. Every call is a preflight-free POST (text/plain) carrying a
//  JSON envelope. The session token travels in the body, never the URL.
//
//  Google Apps Script is single-threaded + slow. We coalesce identical in-flight
//  reads and avoid stampeding the backend (which made the whole app feel laggy).
// =============================================================================
import { API_URL } from "./config.js";

let _token = "";
export function setToken(t) { _token = t || ""; }
export function getToken() { return _token; }

function uuid() {
  if (crypto && crypto.randomUUID) return crypto.randomUUID();
  return "id-" + Date.now() + "-" + Math.random().toString(16).slice(2);
}

export class ApiError extends Error {
  constructor(code, message, retryAfter) {
    super(message || code);
    this.code = code;
    this.retryAfter = retryAfter;
  }
}

const GAS_TIMEOUT_MS = 60000;
const COALESCE = new Set([
  "getMessages", "listConversations", "contactsHome", "listDirectory",
  "listContacts", "listContactRequests", "getConversation", "validateSession"
]);
const _inflight = new Map();
/**
 * GAS is single-threaded — never overlap requests (overlap = multi-second UI freeze).
 * A tiny priority queue keeps that guarantee (one call at a time) but lets
 * user-initiated calls jump ahead of background polls, so a tap doesn't sit
 * behind a refresh. Pass { background: true } to send a call to the back.
 */
const _pending = [];   // waiting jobs: { fn, resolve, reject, bg }
let _active = false;

function _pump() {
  if (_active) return;
  const job = _pending.shift();
  if (!job) return;
  _active = true;
  Promise.resolve().then(job.fn).then(
    (v) => { _active = false; job.resolve(v); _pump(); },
    (e) => { _active = false; job.reject(e); _pump(); }
  );
}

function enqueue(fn, bg) {
  return new Promise((resolve, reject) => {
    const job = { fn: fn, resolve: resolve, reject: reject, bg: !!bg };
    if (bg) {
      _pending.push(job);                 // background → back of the line
    } else {                              // foreground → ahead of background, FIFO among foreground
      let i = 0;
      while (i < _pending.length && !_pending[i].bg) i++;
      _pending.splice(i, 0, job);
    }
    _pump();
  });
}

/**
 * Call a backend action.
 * @param {string} action
 * @param {object} payload
 * @param {object} [opts] { token, timeoutMs }
 */
export async function call(action, payload = {}, opts = {}) {
  if (!API_URL || API_URL.indexOf("PASTE_YOUR") === 0) {
    throw new ApiError("NOT_CONFIGURED", "The app is not connected yet. Set API_URL in js/config.js.");
  }

  // Ping wakes the script — short timeout, still queued so login follows a warm server
  if (action === "ping") {
    return enqueue(() => doFetch(action, payload, { ...opts, timeoutMs: 12000 }), true);
  }

  const bg = !!opts.background;
  const coalesce = COALESCE.has(action);
  const key = coalesce
    ? action + "|" + JSON.stringify(payload || {}) + "|" + (opts.token !== undefined ? opts.token : _token)
    : null;
  if (key && _inflight.has(key)) return _inflight.get(key);

  const p = enqueue(() => doFetch(action, payload, opts), bg).finally(() => {
    if (key) _inflight.delete(key);
  });
  if (key) _inflight.set(key, p);
  return p;
}

async function doFetch(action, payload, opts) {
  const body = JSON.stringify({
    action,
    token: opts.token !== undefined ? opts.token : _token,
    requestId: "req_" + uuid(),
    clientTime: new Date().toISOString(),
    payload
  });

  let res;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs || GAS_TIMEOUT_MS);
  try {
    res = await fetch(API_URL, {
      method: "POST",
      headers: { "Content-Type": "text/plain;charset=utf-8" },
      body,
      redirect: "follow",
      mode: "cors",
      credentials: "omit",
      cache: "no-store",
      signal: controller.signal
    });
  } catch (netErr) {
    const name = netErr && netErr.name;
    const msg = String((netErr && netErr.message) || "");
    if (name === "AbortError" || /aborted/i.test(msg)) {
      throw new ApiError("TIMEOUT", "Server is waking up — wait a moment and try again.");
    }
    if (typeof navigator !== "undefined" && navigator.onLine === false) {
      throw new ApiError("NETWORK", "You're offline — we'll retry automatically.");
    }
    throw new ApiError("NETWORK", "Can't reach the server. Check the Web App URL / redeploy Apps Script (Anyone access).");
  } finally {
    clearTimeout(timer);
  }

  const ctype = (res.headers && res.headers.get("content-type")) || "";
  let json;
  try {
    const text = await res.text();
    if (!text) throw new Error("empty");
    if (ctype.includes("text/html") || text.trim().charAt(0) === "<") {
      throw new ApiError("BAD_RESPONSE", "Got an HTML page instead of JSON. Redeploy the Web App (Execute as: Me, Who has access: Anyone).");
    }
    json = JSON.parse(text);
  } catch (e) {
    if (e instanceof ApiError) throw e;
    throw new ApiError("BAD_RESPONSE", "Unexpected server response.");
  }

  if (!json || json.success !== true) {
    const err = (json && json.error) || {};
    throw new ApiError(err.code || "INTERNAL_ERROR", err.message || "Request failed.", err.retryAfter);
  }
  return json.data;
}
