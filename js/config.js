// =============================================================================
//  CONFIG  —  the ONLY file you must edit before the app works.
//  Paste your Google Apps Script Web App /exec URL between the quotes below.
//  Example: "https://script.google.com/macros/s/AKfy...../exec"
// =============================================================================
export const API_URL = "https://script.google.com/macros/s/AKfycbwVHL6nX4_HoetICPpX3AQEVTeBN_WvUezt3gRhNhobUNMjih5Pz5J-IuOoJzGZ_jP-SQ/exec";

// Polling intervals (milliseconds) — open-chat is aggressive so messages feel live.
export const POLL = {
  OPEN_CONVERSATION: 800,    // active chat open (was 2000 — felt laggy behind GAS latency)
  CHAT_LIST: 5000,           // chat list / contacts screen
  HIDDEN_TAB: 20000,         // browser tab hidden / inactive
  CATCH_UP: 200              // re-poll quickly after new messages arrive
};

export const APP_NAME = "Clocker";
export const MESSAGE_MAX = 2000;
