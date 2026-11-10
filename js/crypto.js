// --- Verschlüsselung (Zero-Access: der Server sieht nur Chiffretext) --------
// Zweistufiger Schlüssel: ein zufälliger DEK (Data Encryption Key) verschlüsselt die
// eigentlichen Werte in habit_entries.data. Der DEK selbst wird zweifach "verpackt"
// (wrapped) serverseitig abgelegt — einmal mit einem aus dem Passwort abgeleiteten KEK
// (Key Encryption Key), einmal mit einem zufälligen Recovery-Key, den nur der Nutzer
// kennt (einmalig angezeigt, siehe renderRecoveryKeyDisplay). Der DEK selbst ändert
// sich dadurch nie — ein Passwort-Reset mit Recovery-Key "vererbt" ihn einfach ins neu
// verpackte Feld weiter, ohne dass irgendwelche Bestandsdaten neu verschlüsselt werden
// müssten. Alles über die native Web Crypto API, keine externe Library nötig.

export function bufToBase64(buf) {
  return btoa(String.fromCharCode(...new Uint8Array(buf)));
}
export function base64ToBuf(b64) {
  return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)).buffer;
}
export function bufToHex(buf) {
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
export function hexToBuf(hex) {
  const clean = hex.replace(/[^0-9a-fA-F]/g, '');
  const bytes = new Uint8Array(clean.length / 2);
  for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(clean.substr(i * 2, 2), 16);
  return bytes.buffer;
}
// Recovery-Key fürs Anzeigen in Fünferblöcken gruppieren, z.B. "a1b2c-d3e4f-...".
export function formatRecoveryKey(hex) {
  return hex.match(/.{1,5}/g).join('-');
}

// OWASP-Empfehlung für PBKDF2-SHA256 (Stand 2023). Konten mit weniger Runden (bis
// 2026-09-29: 250.000) werden beim nächsten Entsperren mit Passwort still hochgestuft
// (upgradePasswordWrap).
export const PBKDF2_ITERATIONS = 600000;

export async function deriveKek(password, saltBuf, iterations) {
  const baseKey = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt: saltBuf, iterations, hash: 'SHA-256' },
    baseKey,
    { name: 'AES-GCM', length: 256 },
    false,
    ['wrapKey', 'unwrapKey']
  );
}

export async function generateDek() {
  return crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']);
}

export function generateRecoveryKeyBytes() {
  return crypto.getRandomValues(new Uint8Array(32));
}

export async function importRecoveryKeyAsCryptoKey(bytesBuf) {
  return crypto.subtle.importKey('raw', bytesBuf, 'AES-GCM', false, ['wrapKey', 'unwrapKey']);
}

export async function wrapDek(dek, wrappingKey) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const wrapped = await crypto.subtle.wrapKey('raw', dek, wrappingKey, { name: 'AES-GCM', iv });
  return { iv: bufToBase64(iv), wrapped: bufToBase64(wrapped) };
}

export async function unwrapDek(wrappedB64, ivB64, wrappingKey) {
  return crypto.subtle.unwrapKey(
    'raw',
    base64ToBuf(wrappedB64),
    wrappingKey,
    { name: 'AES-GCM', iv: new Uint8Array(base64ToBuf(ivB64)) },
    { name: 'AES-GCM', length: 256 },
    true,
    ['encrypt', 'decrypt']
  );
}

// Klartext vor dem Verschlüsseln mit Leerzeichen auf ein Vielfaches von 256 Byte
// auffüllen: die Länge des Chiffretexts verriet sonst grob, wie viel jemand an einem Tag
// eingetragen/geschrieben hat (z.B. lange Notizen). JSON.parse ignoriert Leerzeichen am
// Ende, decryptData braucht deshalb keine Änderung und liest alte, ungepolsterte Daten
// genauso.
export const ENCRYPT_PAD_BLOCK = 256;
export async function encryptData(dek, obj) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const bytes = new TextEncoder().encode(JSON.stringify(obj));
  const padded = new Uint8Array(Math.ceil((bytes.length + 1) / ENCRYPT_PAD_BLOCK) * ENCRYPT_PAD_BLOCK).fill(0x20);
  padded.set(bytes);
  const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, dek, padded);
  return { iv: bufToBase64(iv), ciphertext: bufToBase64(ciphertext) };
}

export async function decryptData(dek, enc) {
  const plainBuf = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: new Uint8Array(base64ToBuf(enc.iv)) }, dek, base64ToBuf(enc.ciphertext));
  return JSON.parse(new TextDecoder().decode(plainBuf));
}

// --- Lokaler DEK-Cache (IndexedDB) -------------------------------------------
// Rohbytes des entpackten DEK, ausschließlich auf diesem Gerät — geht nie an den
// Server. Erspart bei jedem App-Start auf demselben Gerät die erneute Passworteingabe
// (und die PBKDF2-Ableitung). Vergleichbares Sicherheitsniveau wie die ohnehin schon
// lokal gespeicherte Supabase-Session. Neben dem Schlüssel liegt seine Kennung
// (user_encryption.dek_id), damit sich ein veralteter Cache erkennen lässt (siehe
// usableCachedDek). Einträge von vor dieser Kennung sind ein reiner base64-String.
function openKeyDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('logbuch-keys', 1);
    req.onupgradeneeded = () => req.result.createObjectStore('deks');
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
export async function cacheDek(userId, dek, dekId) {
  const raw = await crypto.subtle.exportKey('raw', dek);
  const db = await openKeyDb();
  await new Promise((resolve, reject) => {
    const tx = db.transaction('deks', 'readwrite');
    tx.objectStore('deks').put({ key: bufToBase64(raw), dekId }, userId);
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
  });
}
export async function loadCachedDek(userId) {
  const db = await openKeyDb();
  const stored = await new Promise((resolve, reject) => {
    const tx = db.transaction('deks', 'readonly');
    const req = tx.objectStore('deks').get(userId);
    req.onsuccess = () => resolve(req.result || null);
    req.onerror = () => reject(req.error);
  });
  if (!stored) return null;
  const legacy = typeof stored === 'string';
  const dek = await crypto.subtle.importKey('raw', base64ToBuf(legacy ? stored : stored.key), { name: 'AES-GCM' }, true, ['encrypt', 'decrypt']);
  return { dek, dekId: legacy ? null : stored.dekId };
}
export async function clearCachedDek(userId) {
  try {
    const db = await openKeyDb();
    await new Promise((resolve, reject) => {
      const tx = db.transaction('deks', 'readwrite');
      tx.objectStore('deks').delete(userId);
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
    });
  } catch { /* IndexedDB evtl. nicht verfügbar (privater Modus etc.) - egal, nur Cache */ }
}
