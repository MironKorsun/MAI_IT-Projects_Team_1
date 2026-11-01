/**
 * Зашифрованная локальная очередь изменений М1 (ТЗ КЧ FR-11, NFR-10, NFR-19):
 * IndexedDB + AES-GCM 256 бит с неизвлекаемым ключом Web Crypto API.
 * Хранятся только ответы и заметки — маркеры аутентификации сюда не попадают (NFR-15).
 */

export interface QueueItem {
  id: string;
  type: 'answer' | 'note' | 'ui' | 'events';
  taskId?: string;
  kind?: 'short';
  value?: string;
  seq?: number;
  changedAtServerClock?: string;
  idempotencyKey: string;
  payload?: unknown;
}

interface Snapshot {
  attemptId: string;
  answers: Record<string, { kind: 'short'; value: string; seq: number }>;
  notes: Record<string, string>;
  queue: QueueItem[];
  seq: number;
  savedAt: number;
}

const DB = 'ege-m1';
const STORE = 'kv';

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function idb<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest): Promise<T> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, mode);
    const r = fn(tx.objectStore(STORE));
    r.onsuccess = () => resolve(r.result as T);
    r.onerror = () => reject(r.error);
  });
}

async function key(): Promise<CryptoKey> {
  const existing = await idb<CryptoKey | undefined>('readonly', (s) => s.get('key'));
  if (existing) return existing;
  const k = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
  await idb('readwrite', (s) => s.put(k, 'key'));
  return k;
}

export async function saveSnapshot(snap: Snapshot) {
  try {
    const k = await key();
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const data = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, k, new TextEncoder().encode(JSON.stringify(snap)));
    await idb('readwrite', (s) => s.put({ iv, data }, `snap:${snap.attemptId}`));
  } catch {
    /* хранилище недоступно — работа продолжается в памяти */
  }
}

export async function loadSnapshot(attemptId: string): Promise<Snapshot | undefined> {
  try {
    const rec = await idb<{ iv: Uint8Array; data: ArrayBuffer } | undefined>('readonly', (s) => s.get(`snap:${attemptId}`));
    if (!rec) return undefined;
    const k = await key();
    const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: rec.iv as Uint8Array<ArrayBuffer> }, k, rec.data);
    return JSON.parse(new TextDecoder().decode(plain)) as Snapshot;
  } catch {
    return undefined;
  }
}

/** Удаление данных попытки после конечного состояния (NFR-19: не позднее 60 с). */
export async function wipe() {
  try {
    const db = await openDb();
    db.close();
    await new Promise<void>((resolve) => {
      const r = indexedDB.deleteDatabase(DB);
      r.onsuccess = r.onerror = r.onblocked = () => resolve();
    });
  } catch {
    /* ignore */
  }
}

export type { Snapshot };