import { getCacheMap, saveCacheMap } from "./storage.js";

const CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const EVICT_RATIO = 0.2;

export interface CachedTranslation {
  word: string;
  meaning: string;
  phonetic?: string;
  exampleEn?: string;
  exampleZh?: string;
  note?: string;
  provider: string;
  ts: number;
  lastAccessedAt: number;
}

export interface CacheMap {
  [key: string]: CachedTranslation;
}

export function normalizeCacheKey(word: string): string {
  return String(word || "").trim().toLowerCase();
}

export async function getCachedTranslation(word: string): Promise<CachedTranslation | null> {
  const key = normalizeCacheKey(word);
  if (!key) {
    return null;
  }

  const cache = await getCacheMap();
  const entry = cache[key];
  if (!entry) {
    return null;
  }

  const isExpired = Date.now() - (entry.ts || 0) > CACHE_TTL_MS;
  if (isExpired) {
    delete cache[key];
    await saveCacheMap(cache);
    return null;
  }

  entry.lastAccessedAt = Date.now();
  cache[key] = entry;
  await saveCacheMap(cache);

  return {
    ...entry,
    word: entry.word || word,
  };
}

export async function setCachedTranslation(
  word: string,
  translation: Omit<CachedTranslation, 'ts' | 'lastAccessedAt'>,
  maxCacheSize: number = 200
): Promise<CachedTranslation> {
  const key = normalizeCacheKey(word);
  if (!key) {
    return {
      ...translation,
      ts: Date.now(),
      lastAccessedAt: Date.now(),
    } as CachedTranslation;
  }

  const cache = await getCacheMap();
  cache[key] = {
    ...translation,
    word: translation.word || word,
    ts: Date.now(),
    lastAccessedAt: Date.now(),
  };

  const entries = Object.entries(cache);
  const overflow = entries.length - maxCacheSize;
  if (overflow > 0) {
    const sorted = entries.sort((a, b) => {
      return (a[1].lastAccessedAt || a[1].ts || 0) - (b[1].lastAccessedAt || b[1].ts || 0);
    });
    const deleteCount = Math.max(overflow, Math.ceil(entries.length * EVICT_RATIO));
    sorted.slice(0, deleteCount).forEach(([entryKey]) => {
      delete cache[entryKey];
    });
  }

  await saveCacheMap(cache);
  return cache[key];
}
