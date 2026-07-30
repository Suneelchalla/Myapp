// =============================================================================
//  App lock (Clocker decoy) — looks like a real clock app.
//
//  Alarms / Timer / Stopwatch are fake cover only.
//  One unlock time: exact match → decrypt vault + open chats (+ wipe decoy alarms).
//  Any other valid time → normal fake alarm.
//  While locked: chat UI torn down; token/messages sealed with AES-GCM (key from PIN).
// =============================================================================
import { DB } from "./db.js";
import { deriveKey, randomBytes, bytesToB64, b64ToBytes } from "./crypto.js";

async function sha256Hex(str) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(str));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
function rnd() {
  return (crypto.randomUUID ? crypto.randomUUID() : String(Math.random())).replace(/-/g, "");
}
function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
}

/** "1130" → "11:30" */
export function formatTimePin(digits) {
  const d = String(digits || "").replace(/\D/g, "").slice(0, 4);
  const a = d.slice(0, 2).padEnd(2, "–");
  const b = d.slice(2, 4).padEnd(2, "–");
  return a + ":" + b;
}

/** Accept "11:30" or "1130" → "1130", or null if not a valid clock time. */
export function normalizeTimePin(raw) {
  const d = String(raw || "").replace(/\D/g, "");
  if (d.length !== 4) return null;
  const hh = Number(d.slice(0, 2));
  const mm = Number(d.slice(2, 4));
  if (hh > 23 || mm > 59) return null;
  return d;
}

export const AppLock = {
  _cfg: { enabled: false },
  _locked: false,
  _overlay: null,
  _clockTimer: null,
  _entry: "",
  _tab: "clock",
  _sheetOpen: false,
  _cb: {},
  _alarms: [],
  _key: null, // AES key in memory only while unlocked
  _locking: false,
  _busy: false,
  /* timer decoy */
  _timerSec: 5 * 60,
  _timerLeft: 5 * 60,
  _timerId: null,
  /* stopwatch decoy */
  _swMs: 0,
  _swId: null,
  _swRunning: false,

  async load() {
    this._cfg = (await DB.getKV("lock")) || { enabled: false };
    this._alarms = (await DB.getKV("decoyAlarms")) || [];
  },
  init(cb) { this._cb = cb || {}; },
  isEnabled() { return !!this._cfg.enabled; },
  isLocked() { return this._locked; },
  hasKey() { return !!this._key; },
  getKey() { return this._key; },

  _kdfSaltBytes() {
    if (this._cfg.kdfSalt) return b64ToBytes(this._cfg.kdfSalt);
    // Legacy installs: derive from hash salt string
    return new TextEncoder().encode(String(this._cfg.salt || "clocker"));
  },

  /** Set unlock time; keeps encryption key in memory for the active session. */
  async setPin(chatPin) {
    const c = normalizeTimePin(chatPin);
    if (!c) throw new Error("Time must look like 11:30 (00:00–23:59).");
    const salt = rnd();
    const kdfSalt = randomBytes(16);
    this._cfg = {
      enabled: true,
      salt,
      kdfSalt: bytesToB64(kdfSalt),
      chatHash: await sha256Hex(salt + "|chat|" + c),
      v: 2
    };
    await DB.setKV("lock", this._cfg);
    this._key = await deriveKey(c, kdfSalt);
    return this._key;
  },

  /** Android Back: close alarm sheet, or stay on clock. */
  handleBack() {
    if (!this._locked) return false;
    if (this._sheetOpen) { this._closeSheet(); return true; }
    if (this._tab !== "clock") { this._switchTab("clock"); return true; }
    try { history.pushState({ clockerLock: 1 }, ""); } catch (e) {}
    return true;
  },

  clearKey() { this._key = null; },

  async disable() {
    this._cfg = { enabled: false };
    this._key = null;
    await DB.setKV("lock", this._cfg);
    await DB.delKV("vault");
  },

  async _isChatPin(pin) {
    if (!this._cfg.enabled) return true;
    const dig = normalizeTimePin(pin) || String(pin || "").replace(/\D/g, "");
    if (this._cfg.chatHash && (await sha256Hex(this._cfg.salt + "|chat|" + dig)) === this._cfg.chatHash) return true;
    if (this._cfg.hash && (await sha256Hex(this._cfg.salt + "|" + dig)) === this._cfg.hash) return true;
    return false;
  },

  /** Derive vault key after a successful PIN check. */
  async unlockKey(pin) {
    const dig = normalizeTimePin(pin) || String(pin || "").replace(/\D/g, "");
    this._key = await deriveKey(dig, this._kdfSaltBytes());
    return this._key;
  },

  async lock() {
    if (this._locked || !this._cfg.enabled || this._locking) return;
    this._locking = true;
    try {
      if (this._cb.onLock) await this._cb.onLock();
      this._key = null; // never leave the key in memory while the clock is showing
      this._locked = true;
      this._entry = "";
      this._tab = "clock";
      this._sheetOpen = false;
      this._busy = false;
      this._stopTimerLoop();
      this._stopSwLoop();
      // Avoid duplicate overlays if lock is re-entered
      if (this._overlay) { this._overlay.remove(); this._overlay = null; }
      this._build();
      document.body.appendChild(this._overlay);
      document.body.classList.add("is-locked");
      // Trap Android system Back so it doesn't leave an empty app under the clock
      try { history.pushState({ clockerLock: 1 }, ""); } catch (e) {}
      this._startClock();
    } finally {
      this._locking = false;
    }
  },

  async _finishChat(pinOverride) {
    const pin = pinOverride || this._entry;
    this._alarms = [];
    try { await this._saveAlarms(); } catch (e) {}

    // Drop lock UI first so route() can paint chats
    this._locked = false;
    this._busy = false;
    this._stopClock();
    this._stopTimerLoop();
    this._stopSwLoop();
    document.body.classList.remove("is-locked");
    if (this._overlay) { this._overlay.remove(); this._overlay = null; }

    try {
      if (this._cb.onUnlock) await this._cb.onUnlock(pin);
    } catch (e) {
      // Wrong crypto / corrupt vault — show clock again
      await this.lock();
    }
  },

  /* ============================== shell ============================== */
  _build() {
    const ov = el("div", "lockscreen");
    const shell = el("div", "clock-app");

    const pages = el("div", "clock-pages");
    pages.append(
      this._buildAlarmPage(),
      this._buildClockPage(),
      this._buildTimerPage(),
      this._buildStopwatchPage()
    );

    shell.append(pages, this._buildTabBar(), this._buildSheet());
    ov.appendChild(shell);
    this._overlay = ov;
    this._switchTab("clock");
  },

  _buildTabBar() {
    const bar = el("nav", "clock-tabbar");
    const tabs = [
      { id: "alarm", label: "Alarm" },
      { id: "clock", label: "Clock" },
      { id: "timer", label: "Timer" },
      { id: "stopwatch", label: "Stopwatch" }
    ];
    this._tabBtns = {};
    tabs.forEach((t) => {
      const b = el("button", "clock-tab");
      b.dataset.tab = t.id;
      const icon = el("span", "clock-tab__icon clock-tab__icon--" + t.id);
      icon.setAttribute("aria-hidden", "true");
      const label = el("span", "clock-tab__label", t.label);
      b.append(icon, label);
      b.addEventListener("click", () => this._switchTab(t.id));
      bar.appendChild(b);
      this._tabBtns[t.id] = b;
    });
    return bar;
  },

  _switchTab(id) {
    this._tab = id;
    this._closeSheet();
    ["alarm", "clock", "timer", "stopwatch"].forEach((k) => {
      const page = this._overlay && this._overlay.querySelector(`[data-page="${k}"]`);
      if (page) page.classList.toggle("hidden", k !== id);
      if (this._tabBtns[k]) this._tabBtns[k].classList.toggle("clock-tab--active", k === id);
    });
    if (id === "alarm") this._paintAlarms();
    if (id === "timer") this._paintTimer();
    if (id === "stopwatch") this._paintSw();
  },

  /* ---- Clock home ---- */
  _buildClockPage() {
    const page = el("div", "clock-page");
    page.dataset.page = "clock";

    const face = el("div", "clock-face");
    this._timeEl = el("div", "lock-time");
    this._timeEl.setAttribute("role", "button");
    this._timeEl.setAttribute("aria-label", "Long press or double tap to set alarm");
    this._dateEl = el("div", "lock-date");

    // Android-friendly unlock doors on the clock face
    this._bindDoubleTap(this._timeEl, () => this._openSheet());
    this._bindLongPress(this._timeEl, () => this._openSheet());

    const chip = el("button", "clock-chip");
    chip.type = "button";
    this._chipEl = chip;
    chip.addEventListener("click", () => {
      this._switchTab("alarm");
      this._openSheet();
    });

    face.append(this._timeEl, this._dateEl, chip);
    page.appendChild(face);
    this._updateChip();
    return page;
  },

  /** Double-tap — uses touchend on Android (more reliable than pointerup alone). */
  _bindDoubleTap(node, fn) {
    let last = 0;
    let lastX = 0;
    let lastY = 0;
    const GAP = 400;
    const DIST = 28;
    const fire = (x, y, e) => {
      const now = Date.now();
      const near = Math.abs(x - lastX) < DIST && Math.abs(y - lastY) < DIST;
      if (now - last > 0 && now - last < GAP && near) {
        last = 0;
        if (e && e.cancelable) e.preventDefault();
        fn();
      } else {
        last = now;
        lastX = x;
        lastY = y;
      }
    };
    node.addEventListener("touchend", (e) => {
      if (!e.changedTouches || !e.changedTouches.length) return;
      const t = e.changedTouches[0];
      fire(t.clientX, t.clientY, e);
    }, { passive: false });
    node.addEventListener("click", (e) => {
      // Desktop / mouse only — touch already handled above
      if (e.detail === 0) return; // not a real click
      if (window.matchMedia("(pointer: coarse)").matches) return;
      fire(e.clientX, e.clientY, e);
    });
  },

  /** Long-press (~0.55s) — easiest unlock door on Android. */
  _bindLongPress(node, fn) {
    let timer = null;
    let startX = 0;
    let startY = 0;
    const clear = () => { if (timer) { clearTimeout(timer); timer = null; } };
    const start = (x, y) => {
      clear();
      startX = x; startY = y;
      timer = setTimeout(() => { timer = null; fn(); }, 550);
    };
    const move = (x, y) => {
      if (Math.abs(x - startX) > 12 || Math.abs(y - startY) > 12) clear();
    };
    node.addEventListener("touchstart", (e) => {
      const t = e.changedTouches[0];
      start(t.clientX, t.clientY);
    }, { passive: true });
    node.addEventListener("touchmove", (e) => {
      const t = e.changedTouches[0];
      move(t.clientX, t.clientY);
    }, { passive: true });
    node.addEventListener("touchend", clear);
    node.addEventListener("touchcancel", clear);
    node.addEventListener("mousedown", (e) => start(e.clientX, e.clientY));
    node.addEventListener("mouseup", clear);
    node.addEventListener("mouseleave", clear);
  },

  _updateChip() {
    if (!this._chipEl) return;
    const next = (this._alarms || []).filter((a) => a.on).sort((a, b) => a.time.localeCompare(b.time))[0];
    this._chipEl.textContent = next ? `Alarm  ${next.time}` : "Set alarm";
  },

  /* ---- Alarm page ---- */
  _buildAlarmPage() {
    const page = el("div", "clock-page clock-page--alarm");
    page.dataset.page = "alarm";

    const head = el("div", "alarm-head");
    head.append(el("h2", "alarm-title", "Alarms"));
    const add = el("button", "alarm-add", "+");
    add.setAttribute("aria-label", "Add alarm");
    add.addEventListener("click", () => this._openSheet());
    head.appendChild(add);

    this._alarmListEl = el("div", "alarm-list");
    page.append(head, this._alarmListEl);
    return page;
  },

  /* ---- Timer decoy ---- */
  _buildTimerPage() {
    const page = el("div", "clock-page clock-page--center");
    page.dataset.page = "timer";
    this._timerDisplay = el("div", "decoy-big", "05:00");
    const row = el("div", "decoy-actions");
    const start = el("button", "decoy-btn decoy-btn--go", "Start");
    const reset = el("button", "decoy-btn", "Reset");
    start.addEventListener("click", () => {
      if (this._timerId) { this._stopTimerLoop(); start.textContent = "Start"; return; }
      if (this._timerLeft <= 0) this._timerLeft = this._timerSec;
      start.textContent = "Pause";
      this._timerId = setInterval(() => {
        this._timerLeft -= 1;
        if (this._timerLeft <= 0) { this._timerLeft = 0; this._stopTimerLoop(); start.textContent = "Start"; }
        this._paintTimer();
      }, 1000);
    });
    reset.addEventListener("click", () => {
      this._stopTimerLoop();
      this._timerLeft = this._timerSec;
      start.textContent = "Start";
      this._paintTimer();
    });
    // quick presets
    const presets = el("div", "decoy-presets");
    [1, 5, 10, 15].forEach((m) => {
      const p = el("button", "decoy-preset", m + "m");
      p.addEventListener("click", () => {
        this._stopTimerLoop();
        this._timerSec = m * 60;
        this._timerLeft = m * 60;
        start.textContent = "Start";
        this._paintTimer();
      });
      presets.appendChild(p);
    });
    row.append(reset, start);
    page.append(this._timerDisplay, presets, row);
    return page;
  },
  _paintTimer() {
    if (!this._timerDisplay) return;
    const s = Math.max(0, this._timerLeft);
    const mm = String(Math.floor(s / 60)).padStart(2, "0");
    const ss = String(s % 60).padStart(2, "0");
    this._timerDisplay.textContent = mm + ":" + ss;
  },
  _stopTimerLoop() { if (this._timerId) { clearInterval(this._timerId); this._timerId = null; } },

  /* ---- Stopwatch decoy ---- */
  _buildStopwatchPage() {
    const page = el("div", "clock-page clock-page--center");
    page.dataset.page = "stopwatch";
    this._swDisplay = el("div", "decoy-big", "00:00.00");
    const row = el("div", "decoy-actions");
    const start = el("button", "decoy-btn decoy-btn--go", "Start");
    const reset = el("button", "decoy-btn", "Reset");
    start.addEventListener("click", () => {
      if (this._swRunning) {
        this._stopSwLoop();
        start.textContent = "Start";
        return;
      }
      this._swRunning = true;
      start.textContent = "Stop";
      const t0 = Date.now() - this._swMs;
      this._swId = setInterval(() => {
        this._swMs = Date.now() - t0;
        this._paintSw();
      }, 50);
    });
    reset.addEventListener("click", () => {
      this._stopSwLoop();
      this._swMs = 0;
      start.textContent = "Start";
      this._paintSw();
    });
    row.append(reset, start);
    page.append(this._swDisplay, row);
    return page;
  },
  _paintSw() {
    if (!this._swDisplay) return;
    const ms = this._swMs;
    const m = String(Math.floor(ms / 60000)).padStart(2, "0");
    const s = String(Math.floor((ms % 60000) / 1000)).padStart(2, "0");
    const c = String(Math.floor((ms % 1000) / 10)).padStart(2, "0");
    this._swDisplay.textContent = `${m}:${s}.${c}`;
  },
  _stopSwLoop() {
    this._swRunning = false;
    if (this._swId) { clearInterval(this._swId); this._swId = null; }
  },

  /* ---- Add-alarm bottom sheet (natural unlock entry) ---- */
  _buildSheet() {
    const sheet = el("div", "alarm-sheet hidden");
    const handle = el("div", "alarm-sheet__handle");
    const title = el("div", "alarm-sheet__title", "Add alarm");
    this._timeEntryEl = el("div", "lock-time-entry", "––:––");

    const grid = el("div", "lock-grid");
    ["1", "2", "3", "4", "5", "6", "7", "8", "9", "", "0", "del"].forEach((k) => {
      if (k === "") { grid.appendChild(document.createElement("span")); return; }
      const b = el("button", "lock-key" + (k === "del" ? " lock-key--del" : ""), k === "del" ? "⌫" : k);
      b.addEventListener("click", () => this._press(k));
      grid.appendChild(b);
    });

    const cancel = el("button", "lock-cancel", "Cancel");
    cancel.addEventListener("click", () => this._closeSheet());

    const backdrop = el("button", "alarm-sheet__scrim");
    backdrop.type = "button";
    backdrop.setAttribute("aria-label", "Dismiss");
    backdrop.addEventListener("click", () => this._closeSheet());

    const panel = el("div", "alarm-sheet__panel");
    this._sheetStatusEl = el("div", "alarm-sheet__status hidden");
    panel.append(handle, title, this._timeEntryEl, this._sheetStatusEl, grid, cancel);

    sheet.append(backdrop, panel);
    this._sheetEl = sheet;
    return sheet;
  },

  _openSheet() {
    if (this._busy) return;
    this._entry = "";
    this._renderTimeEntry();
    this._setSheetStatus("");
    this._sheetOpen = true;
    if (this._sheetEl) this._sheetEl.classList.remove("hidden");
  },
  _closeSheet() {
    if (this._busy) return;
    this._sheetOpen = false;
    this._entry = "";
    this._renderTimeEntry();
    this._setSheetStatus("");
    if (this._sheetEl) this._sheetEl.classList.add("hidden");
    if (this._sheetEl) this._sheetEl.classList.remove("lock-shake");
  },

  async _press(k) {
    if (this._busy) return;
    if (k === "del") {
      this._entry = this._entry.slice(0, -1);
      this._renderTimeEntry();
      return;
    }
    if (this._entry.length >= 4) return;
    this._entry += k;
    this._renderTimeEntry();
    if (this._entry.length < 4) return;

    this._busy = true;
    this._setSheetStatus("Checking…");
    try {
      // Exact Messages secret → chats (and clear decoy alarms). Anything else → fake alarm.
      if (await this._isChatPin(this._entry)) {
        this._setSheetStatus("Opening…");
        await this._finishChat();
        return;
      }

      const valid = normalizeTimePin(this._entry);
      if (valid) {
        const time = valid.slice(0, 2) + ":" + valid.slice(2, 4);
        this._alarms.unshift({ id: "a_" + Date.now(), time, label: "Alarm", on: true });
        await this._saveAlarms();
        this._busy = false;
        this._setSheetStatus("");
        this._closeSheet();
        this._switchTab("alarm");
        this._updateChip();
        return;
      }
      this._busy = false;
      this._setSheetStatus("");
      this._wrong();
    } catch (e) {
      this._busy = false;
      this._setSheetStatus("");
      this._wrong();
    }
  },

  _setSheetStatus(text) {
    if (!this._sheetStatusEl) return;
    this._sheetStatusEl.textContent = text || "";
    this._sheetStatusEl.classList.toggle("hidden", !text);
  },

  _wrong() {
    if (this._sheetEl) {
      this._sheetEl.classList.add("lock-shake");
      setTimeout(() => this._sheetEl && this._sheetEl.classList.remove("lock-shake"), 450);
    }
    this._entry = "";
    this._renderTimeEntry();
  },

  _renderTimeEntry() {
    if (!this._timeEntryEl) return;
    this._timeEntryEl.textContent = formatTimePin(this._entry);
  },

  async _saveAlarms() { await DB.setKV("decoyAlarms", this._alarms); },

  _paintAlarms() {
    if (!this._alarmListEl) return;
    this._alarmListEl.textContent = "";
    if (!this._alarms.length) {
      const empty = el("div", "alarm-empty-wrap");
      empty.append(
        el("p", "alarm-empty", "No alarms"),
        (() => {
          const b = el("button", "decoy-btn decoy-btn--go", "Add alarm");
          b.addEventListener("click", () => this._openSheet());
          return b;
        })()
      );
      this._alarmListEl.appendChild(empty);
      return;
    }
    this._alarms.forEach((a) => {
      const row = el("div", "alarm-row" + (a.on ? "" : " alarm-row--off"));
      const main = el("button", "alarm-main");
      main.append(el("div", "alarm-time", a.time), el("div", "alarm-label", a.label || "Alarm"));
      main.addEventListener("click", () => this._editAlarm(a));

      const tog = el("button", "alarm-toggle" + (a.on ? " alarm-toggle--on" : ""));
      tog.setAttribute("aria-label", a.on ? "On" : "Off");
      tog.addEventListener("click", async (e) => {
        e.stopPropagation();
        a.on = !a.on;
        await this._saveAlarms();
        this._paintAlarms();
        this._updateChip();
      });

      row.append(main, tog);
      this._alarmListEl.appendChild(row);
    });
  },

  _editAlarm(alarm) {
    const existing = this._overlay.querySelector(".alarm-editor");
    if (existing) existing.remove();

    const ed = el("div", "alarm-editor");
    ed.append(el("div", "alarm-editor-title", "Edit alarm"));

    const timeInput = el("input", "alarm-editor-time");
    timeInput.inputMode = "numeric";
    timeInput.maxLength = 5;
    timeInput.value = alarm.time;

    const labelInput = el("input", "alarm-editor-label");
    labelInput.value = alarm.label || "";
    labelInput.placeholder = "Label";

    const actions = el("div", "alarm-editor-actions");
    const del = el("button", "alarm-editor-del", "Delete");
    del.addEventListener("click", async () => {
      this._alarms = this._alarms.filter((x) => x.id !== alarm.id);
      await this._saveAlarms();
      ed.remove();
      this._paintAlarms();
      this._updateChip();
    });
    const save = el("button", "alarm-editor-save", "Save");
    save.addEventListener("click", async () => {
      const n = normalizeTimePin(timeInput.value);
      if (!n) return;
      if (await this._isChatPin(n)) { await this._finishChat(n); return; }
      alarm.time = n.slice(0, 2) + ":" + n.slice(2, 4);
      alarm.label = (labelInput.value || "Alarm").trim();
      await this._saveAlarms();
      ed.remove();
      this._paintAlarms();
      this._updateChip();
    });
    actions.append(del, save);
    ed.append(timeInput, labelInput, actions);
    const alarmPage = this._overlay.querySelector('[data-page="alarm"]');
    (alarmPage || this._overlay).appendChild(ed);
    timeInput.focus();
  },

  _startClock() {
    const upd = () => {
      if (!this._timeEl) return;
      const d = new Date();
      this._timeEl.textContent = d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
      this._dateEl.textContent = d.toLocaleDateString([], { weekday: "long", day: "numeric", month: "long" });
    };
    upd();
    this._clockTimer = setInterval(upd, 1000);
  },
  _stopClock() {
    if (this._clockTimer) { clearInterval(this._clockTimer); this._clockTimer = null; }
  }
};
