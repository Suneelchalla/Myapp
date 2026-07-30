// =============================================================================
//  CONFIG  —  the ONLY file you must edit before the app works.
//  Paste your Google Apps Script Web App /exec URL between the quotes below.
//  Example: "https://script.google.com/macros/s/AKfy...../exec"
// =============================================================================
export const API_URL = "https://script.google.com/macros/s/AKfycbwVHL6nX4_HoetICPpX3AQEVTeBN_WvUezt3gRhNhobUNMjih5Pz5J-IuOoJzGZ_jP-SQ/exec";

// Polling — Apps Script is slow; aggressive polling stacks requests and lags the whole app.
export const POLL = {
  OPEN_CONVERSATION: 10000,  // open chat — GAS cold/slow; faster = stacked lag
  CHAT_LIST: 25000,          // chats tab
  CONTACTS: 60000,           // contacts tab
  BADGE: 90000,              // app badge
  HIDDEN_TAB: 180000,        // backgrounded — almost idle
  CATCH_UP: 7000             // after new messages (still behind OPEN base)
};

export const APP_NAME = "Clocker";
export const MESSAGE_MAX = 2000;
