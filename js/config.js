// =============================================================================
//  CONFIG  —  the ONLY file you must edit before the app works.
//  Paste your Google Apps Script Web App /exec URL between the quotes below.
//  Example: "https://script.google.com/macros/s/AKfy...../exec"
// =============================================================================
export const API_URL = "https://script.google.com/macros/s/AKfycbwVHL6nX4_HoetICPpX3AQEVTeBN_WvUezt3gRhNhobUNMjih5Pz5J-IuOoJzGZ_jP-SQ/exec";

// Polling intervals (milliseconds) — safe defaults, no need to change.
export const POLL = {
  OPEN_CONVERSATION: 2000,   // active chat open
  CHAT_LIST: 8000,           // chat list / contacts screen
  HIDDEN_TAB: 30000          // browser tab hidden / inactive
};

export const APP_NAME = "Ripple";
export const MESSAGE_MAX = 2000;
