// =============================================================================
//  Vault — seal sensitive local data when the clock lock engages.
//  While locked, IndexedDB holds ciphertext only (token/messages wiped).
// =============================================================================
import { DB } from "./db.js";
import { encryptJson, decryptJson } from "./crypto.js";

export const Vault = {
  async hasVault() {
    return !!(await DB.getKV("vault"));
  },

  async _snapshot() {
    return {
      v: 2,
      sealedAt: Date.now(),
      token: await DB.getKV("token"),
      user: await DB.getKV("user"),
      conversations: await DB.getConversations(),
      messages: await DB.getAllMessages(),
      pending: await DB.getPending(),
      contactsCache: await DB.getKV("contactsCache")
    };
  },

  /** Write encrypted backup without wiping (keeps session usable while unlocked). */
  async backup(key) {
    if (!key) throw new Error("NO_KEY");
    const payload = await this._snapshot();
    if (!(payload.token || payload.user || (payload.messages && payload.messages.length) ||
        (payload.conversations && payload.conversations.length) || (payload.pending && payload.pending.length))) {
      return false;
    }
    await DB.setKV("vault", await encryptJson(key, payload));
    return true;
  },

  /** Snapshot sensitive data → encrypted vault, then wipe plaintext copies. */
  async seal(key) {
    if (!key) throw new Error("NO_KEY");
    await this.backup(key);
    await this.wipePlaintextSensitive();
  },

  /** Decrypt vault back into IndexedDB. Returns payload or null if no vault. */
  async unseal(key) {
    if (!key) throw new Error("NO_KEY");
    const blob = await DB.getKV("vault");
    if (!blob) return null;
    const payload = await decryptJson(key, blob);
    await this.wipePlaintextSensitive();
    if (payload.token) await DB.setKV("token", payload.token);
    if (payload.user) await DB.setKV("user", payload.user);
    if (payload.contactsCache) await DB.setKV("contactsCache", payload.contactsCache);
    if (payload.conversations && payload.conversations.length) await DB.putConversations(payload.conversations);
    if (payload.messages && payload.messages.length) {
      const by = {};
      for (const m of payload.messages) {
        const id = m.conversationId;
        if (!id) continue;
        (by[id] || (by[id] = [])).push(m);
      }
      for (const [cid, list] of Object.entries(by)) await DB.putMessages(cid, list);
    }
    if (payload.pending && payload.pending.length) {
      for (const p of payload.pending) await DB.addPending(p);
    }
    // Keep vault on disk so a force-kill while chatting still has an encrypted backup
    return payload;
  },

  /** Remove sensitive plaintext so a digger only sees public keys + vault. */
  async wipePlaintextSensitive() {
    await DB.clearStore("conversations");
    await DB.clearStore("messages");
    await DB.clearStore("pending");
    await DB.delKV("token");
    await DB.delKV("user");
    await DB.delKV("contactsCache");
    await DB.delKV("adminToken");
  },

  /** Boot safety: if lock is on, never leave plaintext session on disk. */
  async hardenForLockedBoot() {
    const hasVault = await this.hasVault();
    if (hasVault) {
      await this.wipePlaintextSensitive();
      return "vault";
    }
    const token = await DB.getKV("token");
    const user = await DB.getKV("user");
    if (token || user) {
      await this.wipePlaintextSensitive();
      return "wiped";
    }
    return "empty";
  }
};
