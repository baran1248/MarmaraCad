import type { ProjectDocument } from "../model/types";
import { normalizeDocument } from "./project";

const DB_NAME = "marmaracad";
const DB_VERSION = 1;
const STORE = "kv";
const AUTOSAVE_KEY = "autosave";
const RECENT_LIMIT = 8;

export interface RecentEntry {
  key: string;
  name: string;
  savedAt: number;
  doc: ProjectDocument;
}

let dbPromise: Promise<IDBDatabase | null> | null = null;

function openDb(): Promise<IDBDatabase | null> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve) => {
    if (!("indexedDB" in window)) {
      resolve(null);
      return;
    }
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => resolve(null);
  });
  return dbPromise;
}

function tx<T>(mode: IDBTransactionMode, fn: (store: IDBObjectStore) => IDBRequest<T> | null): Promise<T | null> {
  return openDb().then(
    (db) =>
      new Promise<T | null>((resolve) => {
        if (!db) {
          resolve(null);
          return;
        }
        try {
          const transaction = db.transaction(STORE, mode);
          const store = transaction.objectStore(STORE);
          const request = fn(store);
          if (!request) {
            resolve(null);
            return;
          }
          request.onsuccess = () => resolve(request.result ?? null);
          request.onerror = () => resolve(null);
        } catch {
          resolve(null);
        }
      }),
  );
}

export async function saveAutosave(doc: ProjectDocument): Promise<void> {
  await tx("readwrite", (store) => store.put({ savedAt: Date.now(), doc }, AUTOSAVE_KEY));
}

export async function loadAutosave(): Promise<{ doc: ProjectDocument; savedAt: number } | null> {
  const raw = await tx<any>("readonly", (store) => store.get(AUTOSAVE_KEY));
  if (!raw || !raw.doc) return null;
  try {
    return { doc: normalizeDocument(raw.doc), savedAt: Number(raw.savedAt) || Date.now() };
  } catch {
    return null;
  }
}

export async function clearAutosave(): Promise<void> {
  await tx("readwrite", (store) => store.delete(AUTOSAVE_KEY));
}

export async function addRecent(doc: ProjectDocument): Promise<void> {
  const key = `recent:${Date.now()}:${Math.random().toString(36).slice(2, 6)}`;
  await tx("readwrite", (store) => store.put({ name: doc.name, savedAt: Date.now(), doc }, key));
  const keys = (await tx<IDBValidKey[]>("readonly", (store) => store.getAllKeys())) ?? [];
  const recentKeys = keys
    .map((k) => String(k))
    .filter((k) => k.startsWith("recent:"))
    .sort()
    .reverse();
  if (recentKeys.length > RECENT_LIMIT) {
    await tx("readwrite", (store) => {
      for (const k of recentKeys.slice(RECENT_LIMIT)) store.delete(k);
      return null;
    });
  }
}

export async function listRecent(): Promise<RecentEntry[]> {
  const keys = (await tx<IDBValidKey[]>("readonly", (store) => store.getAllKeys())) ?? [];
  const recentKeys = keys
    .map((k) => String(k))
    .filter((k) => k.startsWith("recent:"))
    .sort()
    .reverse()
    .slice(0, RECENT_LIMIT);
  const out: RecentEntry[] = [];
  for (const key of recentKeys) {
    const raw = await tx<any>("readonly", (store) => store.get(key));
    if (!raw?.doc) continue;
    try {
      out.push({ key, name: raw.name || "Untitled", savedAt: Number(raw.savedAt) || Date.now(), doc: normalizeDocument(raw.doc) });
    } catch {
      /* skip corrupt entries */
    }
  }
  return out;
}

export async function clearAll(): Promise<void> {
  await tx("readwrite", (store) => store.clear());
}
