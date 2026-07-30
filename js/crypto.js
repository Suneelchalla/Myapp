// =============================================================================
//  Web Crypto helpers — PBKDF2 key derivation + AES-GCM for the vault.
// =============================================================================

const te = new TextEncoder();
const td = new TextDecoder();

export function randomBytes(n = 16) {
  const buf = new Uint8Array(n);
  crypto.getRandomValues(buf);
  return buf;
}

export function bytesToB64(bytes) {
  let s = "";
  const arr = bytes instanceof ArrayBuffer ? new Uint8Array(bytes) : bytes;
  for (let i = 0; i < arr.length; i++) s += String.fromCharCode(arr[i]);
  return btoa(s);
}

export function b64ToBytes(b64) {
  const s = atob(b64);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

/** Derive an AES-GCM key from the unlock time (PIN) + salt. */
export async function deriveKey(pin, saltBytes, iterations = 100000) {
  const base = await crypto.subtle.importKey("raw", te.encode(String(pin)), "PBKDF2", false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    { name: "PBKDF2", salt: saltBytes, iterations, hash: "SHA-256" },
    base,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"]
  );
}

/** Encrypt a JSON-serializable value → { v, iv, ct } (base64 fields). */
export async function encryptJson(key, value) {
  const iv = randomBytes(12);
  const plain = te.encode(JSON.stringify(value));
  const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, plain);
  return { v: 1, iv: bytesToB64(iv), ct: bytesToB64(ct) };
}

/** Decrypt a blob from encryptJson. Throws if key/PIN is wrong. */
export async function decryptJson(key, blob) {
  if (!blob || !blob.iv || !blob.ct) throw new Error("BAD_VAULT");
  const iv = b64ToBytes(blob.iv);
  const ct = b64ToBytes(blob.ct);
  const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, ct);
  return JSON.parse(td.decode(plain));
}
