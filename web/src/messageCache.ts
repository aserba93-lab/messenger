/**
 * Локальное хранение ленты сообщений (IndexedDB) для браузера и Capacitor:
 * после перезапуска показываем последнюю сохранённую копию, затем подменяем ответом сервера.
 */

const DB_NAME = "tg-messenger-messages";
const DB_VER = 1;
const STORE = "byChat";

export type CachedMessageList = {
  savedAt: string;
  items: unknown[];
};

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VER);
    req.onerror = () => reject(req.error);
    req.onsuccess = () => resolve(req.result);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE, { keyPath: "key" });
      }
    };
  });
}

function storageKey(organizationId: string, chatKey: string): string {
  return `${organizationId}::${chatKey}`;
}

export async function messageCacheGet(organizationId: string, chatKey: string): Promise<unknown[] | null> {
  if (typeof indexedDB === "undefined" || !organizationId || !chatKey) return null;
  try {
    const db = await openDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, "readonly");
      const st = tx.objectStore(STORE);
      const r = st.get(storageKey(organizationId, chatKey));
      r.onerror = () => reject(r.error);
      r.onsuccess = () => {
        const row = r.result as { items?: unknown[] } | undefined;
        const items = row?.items;
        resolve(Array.isArray(items) ? items : null);
      };
    });
  } catch {
    return null;
  }
}

export async function messageCachePut(organizationId: string, chatKey: string, items: unknown[]): Promise<void> {
  if (typeof indexedDB === "undefined" || !organizationId || !chatKey) return;
  try {
    const db = await openDb();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE, "readwrite");
      const st = tx.objectStore(STORE);
      st.put({
        key: storageKey(organizationId, chatKey),
        items,
        savedAt: new Date().toISOString(),
      });
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } catch {
    /* ignore quota / private mode */
  }
}

export async function messageCacheClearAll(): Promise<void> {
  if (typeof indexedDB === "undefined") return;
  try {
    const db = await openDb();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE, "readwrite");
      tx.objectStore(STORE).clear();
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } catch {
    /* ignore */
  }
}
