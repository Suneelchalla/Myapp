// =============================================================================
//  API client. Every call is a preflight-free POST (text/plain) carrying a
//  JSON envelope. The session token travels in the body, never the URL.
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

/**
 * Call a backend action.
 * @param {string} action
 * @param {object} payload
 * @param {object} [opts] { token }  override token (e.g. admin)
 */
export async function call(action, payload = {}, opts = {}) {
  if (!API_URL || API_URL.indexOf("PASTE_YOUR") === 0) {
    throw new ApiError("NOT_CONFIGURED", "The app is not connected yet. Set API_URL in js/config.js.");
  }
  const body = JSON.stringify({
    action,
    token: opts.token !== undefined ? opts.token : _token,
    requestId: "req_" + uuid(),
    clientTime: new Date().toISOString(),
    payload
  });

  let res;
  try {
    res = await fetch(API_URL, {
      method: "POST",
      headers: { "Content-Type": "text/plain;charset=utf-8" },
      body,
      redirect: "follow"
    });
  } catch (netErr) {
    throw new ApiError("NETWORK", "You appear to be offline.");
  }

  let json;
  try { json = await res.json(); }
  catch (e) { throw new ApiError("BAD_RESPONSE", "Unexpected server response."); }

  if (!json || json.success !== true) {
    const err = (json && json.error) || {};
    throw new ApiError(err.code || "INTERNAL_ERROR", err.message || "Request failed.", err.retryAfter);
  }
  return json.data;
}
