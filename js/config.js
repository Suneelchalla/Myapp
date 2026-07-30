// =============================================================================
//  CONFIG  —  the ONLY file you must edit before the app works.
//  Paste your Google Apps Script Web App /exec URL between the quotes below.
//  Example: "https://script.google.com/macros/s/AKfy...../exec"
// =============================================================================
export const API_URL = "https://script.google.com/macros/s/AKfycbwVHL6nX4_HoetICPpX3AQEVTeBN_WvUezt3gRhNhobUNMjih5Pz5J-IuOoJzGZ_jP-SQ/exec";

// Polling — Apps Script is slow; aggressive polling stacks requests and lags the whole app.
export const POLL = {
  OPEN_CONVERSATION: 3500,   // open chat (was 800 — flooded GAS)
  CHAT_LIST: 12000,          // chats tab
  CONTACTS: 30000,           // contacts tab
  BADGE: 30000,              // app badge while elsewhere
  HIDDEN_TAB: 45000,         // tab / app backgrounded
  CATCH_UP: 1500             // after new messages arrive (min gap)
};

export const APP_NAME = "Clocker";
export const MESSAGE_MAX = 2000;
