// =============================================================================
//  App lock (hide-only). Shows a neutral clock screen on launch / resume.
//  Tap the top-right corner to reveal a keypad; the correct PIN opens the app.
//  This is camouflage, not encryption — it deters casual snooping only.
// =============================================================================
import { DB } from "./db.js";

async function sha256Hex(str) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(str));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
function rnd() {
  return (crypto.randomUUID ? crypto.randomUUID() : String(Math.random())).replace(/-/g, "");
}

export const AppLock = {
  _cfg: { enabled: false },
  _locked: false,
  _overlay: null,
  _clockTimer: null,
  _entry: "",
  _cb: {},

  async load() { this._cfg = (await DB.getKV("lock")) || { enabled: false }; },
  init(cb) { this._cb = cb || {}; },
  isEnabled() { return !!this._cfg.enabled; },
  isLocked() { return this._locked; },

  async setPin(pin) {
    const salt = rnd();
    this._cfg = { enabled: true, salt, hash: await sha256Hex(salt + "|" + pin), len: pin.length };
    await DB.setKV("lock", this._cfg);
  },
  async disable() { this._cfg = { enabled: false }; await DB.setKV("lock", this._cfg); },
  async _verify(pin) {
    if (!this._cfg.enabled) return true;
    return (await sha256Hex(this._cfg.salt + "|" + pin)) === this._cfg.hash;
  },

  lock() {
    if (this._locked || !this._cfg.enabled) return;
    this._locked = true;
    this._entry = "";
    this._build();
    document.body.appendChild(this._overlay);
    this._startClock();
    if (this._cb.onLock) this._cb.onLock();
  },

  _finish() {
    this._locked = false;
    this._stopClock();
    if (this._overlay) { this._overlay.remove(); this._overlay = null; }
    if (this._cb.onUnlock) this._cb.onUnlock();
  },

  /* ---- decoy + keypad DOM ---- */
  _build() {
    const ov = document.createElement("div");
    ov.className = "lockscreen";

    const clock = document.createElement("div");
    clock.className = "lock-clock";
    this._timeEl = document.createElement("div"); this._timeEl.className = "lock-time";
    this._dateEl = document.createElement("div"); this._dateEl.className = "lock-date";
    clock.append(this._timeEl, this._dateEl);
    clock.addEventListener("click", () => this._showPad(false)); // tap background hides pad

    const hot = document.createElement("button");
    hot.className = "lock-hotspot";
    hot.setAttribute("aria-hidden", "true");
    hot.tabIndex = -1;
    hot.addEventListener("click", (e) => { e.stopPropagation(); this._showPad(true); });

    ov.append(clock, this._buildPad(), hot);
    this._overlay = ov;
  },

  _buildPad() {
    const pad = document.createElement("div");
    pad.className = "lock-pad hidden";
    this._dotsEl = document.createElement("div"); this._dotsEl.className = "lock-dots";
    const grid = document.createElement("div"); grid.className = "lock-grid";
    ["1","2","3","4","5","6","7","8","9","","0","del"].forEach((k) => {
      if (k === "") { grid.appendChild(document.createElement("span")); return; }
      const b = document.createElement("button");
      b.className = "lock-key" + (k === "del" ? " lock-key--del" : "");
      b.textContent = k === "del" ? "⌫" : k;
      b.addEventListener("click", () => this._press(k));
      grid.appendChild(b);
    });
    pad.append(this._dotsEl, grid);
    this._padEl = pad;
    this._renderDots();
    return pad;
  },

  _showPad(show) {
    if (!this._padEl) return;
    if (show) { this._padEl.classList.remove("hidden"); }
    else { this._padEl.classList.add("hidden"); this._entry = ""; this._renderDots(); }
  },

  async _press(k) {
    if (k === "del") { this._entry = this._entry.slice(0, -1); this._renderDots(); return; }
    if (this._entry.length >= 6) return;
    this._entry += k;
    this._renderDots();
    if (this._entry.length >= (this._cfg.len || 4)) {
      if (await this._verify(this._entry)) this._finish();
      else this._wrong();
    }
  },

  _wrong() {
    if (this._padEl) {
      this._padEl.classList.add("lock-shake");
      setTimeout(() => this._padEl && this._padEl.classList.remove("lock-shake"), 450);
    }
    this._entry = "";
    this._renderDots();
  },

  _renderDots() {
    if (!this._dotsEl) return;
    const len = this._cfg.len || 4;
    this._dotsEl.textContent = "";
    for (let i = 0; i < len; i++) {
      const d = document.createElement("span");
      d.className = "lock-dot" + (i < this._entry.length ? " lock-dot--on" : "");
      this._dotsEl.appendChild(d);
    }
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
  _stopClock() { if (this._clockTimer) { clearInterval(this._clockTimer); this._clockTimer = null; } }
};
