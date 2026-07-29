// =============================================================================
//  IndexedDB wrapper. Stores session, settings, cached conversations/messages,
//  sync cursors and the pending (unsent) message queue. Cleared on logout.
// =============================================================================
const DB_NAME = "ripple-db";
const DB_VERSION = 1;
let _db = null;

function open() {
  if (_db) return Promise.resolve(_db);
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (e) => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains("kv")) db.createObjectStore("kv");
      if (!db.objectStoreNames.contains("conversations")) db.createObjectStore("conversations", { keyPath: "conversationId" });
      if (!db.objectStoreNames.contains("messages")) {
        const s = db.createObjectStore("messages", { keyPath: "clientKey" });
        s.createIndex("byConversation", "conversationId", { unique: false });
      }
      if (!db.objectStoreNames.contains("pending")) db.createObjectStore("pending", { keyPath: "clientMessageId" });
    };
    req.onsuccess = () => { _db = req.result; resolve(_db); };
    req.onerror = () => reject(req.error);
  });
}

function tx(store, mode) {
  return open().then((db) => db.transaction(store, mode).objectStore(store));
}
function done(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

export const DB = {
  // key/value
  async setKV(key, value) { const s = await tx("kv", "readwrite"); return done(s.put(value, key)); },
  async getKV(key) { const s = await tx("kv", "readonly"); return done(s.get(key)); },
  async delKV(key) { const s = await tx("kv", "readwrite"); return done(s.delete(key)); },

  // conversations
  async putConversations(list) {
    const s = await tx("conversations", "readwrite");
    await Promise.all(list.map((c) => done(s.put(c))));
  },
  async getConversations() { const s = await tx("conversations", "readonly"); return done(s.getAll()); },
  async putConversation(c) { const s = await tx("conversations", "readwrite"); return done(s.put(c)); },

  // messages  (clientKey = conversationId + ":" + (messageId || clientMessageId))
  async putMessages(conversationId, messages) {
    const s = await tx("messages", "readwrite");
    await Promise.all(messages.map((m) => {
      m.conversationId = conversationId;
      m.clientKey = conversationId + ":" + (m.messageId || m.clientMessageId);
      return done(s.put(m));
    }));
  },
  async getMessages(conversationId) {
    const s = await tx("messages", "readonly");
    const idx = s.index("byConversation");
    const list = await done(idx.getAll(IDBKeyRange.only(conversationId)));
    return list.sort((a, b) => (a.sequenceNumber || 0) - (b.sequenceNumber || 0)
      || (a.createdAt || "").localeCompare(b.createdAt || ""));
  },
  async clearMessages(conversationId) {
    const s = await tx("messages", "readwrite");
    const idx = s.index("byConversation");
    const keys = await done(idx.getAllKeys(IDBKeyRange.only(conversationId)));
    await Promise.all(keys.map((k) => done(s.delete(k))));
  },

  // pending queue
  async addPending(item) { const s = await tx("pending", "readwrite"); return done(s.put(item)); },
  async getPending() { const s = await tx("pending", "readonly"); return done(s.getAll()); },
  async removePending(clientMessageId) { const s = await tx("pending", "readwrite"); return done(s.delete(clientMessageId)); },

  // wipe everything (logout)
  async clearAll() {
    const db = await open();
    await Promise.all(["kv", "conversations", "messages", "pending"].map((name) =>
      new Promise((res) => {
        const r = db.transaction(name, "readwrite").objectStore(name).clear();
        r.onsuccess = res; r.onerror = res;
      })
    ));
  }
};
