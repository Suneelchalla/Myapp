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

  /** Snapshot sensitive data → encrypted vault, then wipe plaintext copies. */
  async seal(key) {
    if (!key) throw new Error("NO_KEY");
    const payload = {
      token: await DB.getKV("token"),
      user: await DB.getKV("user"),
      conversations: await DB.getConversations(),
      messages: await DB.getAllMessages(),
      pending: await DB.getPending()
    };
    // Only seal if there is something worth protecting
    if (payload.token || payload.user || (payload.messages && payload.messages.length) ||
        (payload.conversations && payload.conversations.length) || (payload.pending && payload.pending.length)) {
      const blob = await encryptJson(key, payload);
      await DB.setKV("vault", blob);
    }
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
    if (payload.conversations && payload.conversations.length) await DB.putConversations(payload.conversations);
    if (payload.messages && payload.messages.length) {
      // Group by conversation for putMessages
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
  },

  /** Boot safety: if lock is on, never leave plaintext session on disk. */
  async hardenForLockedBoot() {
    const token = await DB.getKV("token");
    const user = await DB.getKV("user");
    const hasVault = await this.hasVault();
    if (hasVault) {
      // Prefer vault — drop any leftover plaintext
      await this.wipePlaintextSensitive();
      return "vault";
    }
    if (token || user) {
      // Lock enabled but never sealed (upgrade / crash) — drop plaintext;
      // user must sign in again after unlock if vault is missing.
      await this.wipePlaintextSensitive();
      return "wiped";
    }
    return "empty";
  }
};
