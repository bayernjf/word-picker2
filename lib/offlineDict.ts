/**
 * 离线词库（IndexedDB）
 *
 * 数据源：assets/dict/ecdict.min.json（由 scripts/build-dict.js 从 ECDICT 生成）
 * 结构：
 *   { version, count, lemmaCount, entries:[{w,p,t}], lemma:{ 变形: 原词 } }
 *
 * 能力：
 *   - ensureDictImported()  首次安装把 JSON 灌入 IndexedDB（幂等，按版本跳过）
 *   - lookupOffline(word)   查询单词，未命中时用 lemma 词形还原后再查
 *
 * 仅在 service worker 中使用（IndexedDB 不可用于无 window 的纯函数模块）。
 */

import { createLogger } from "./logger.js";

const logger = createLogger("offlineDict");

const DB_NAME = "wordcatcher-dict";
const DB_VERSION = 1;
const STORE_ENTRIES = "entries"; // keyPath: key（小写单词）
const STORE_LEMMA = "lemma"; // keyPath: from（小写变形）
const STORE_META = "meta"; // keyPath: name

const DICT_ASSET_PATH = "assets/dict/ecdict.min.json";
const META_VERSION_KEY = "dictVersion";

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_ENTRIES)) {
        db.createObjectStore(STORE_ENTRIES, { keyPath: "key" });
      }
      if (!db.objectStoreNames.contains(STORE_LEMMA)) {
        db.createObjectStore(STORE_LEMMA, { keyPath: "from" });
      }
      if (!db.objectStoreNames.contains(STORE_META)) {
        db.createObjectStore(STORE_META, { keyPath: "name" });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function txComplete(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

function getByKey(db: IDBDatabase, storeName: string, key: string): Promise<any> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, "readonly");
    const request = tx.objectStore(storeName).get(key);
    request.onsuccess = () => resolve(request.result || null);
    request.onerror = () => reject(request.error);
  });
}

let importPromise: Promise<void> | null = null;

/**
 * 确保离线词库已导入 IndexedDB（幂等）。
 * 多次并发调用复用同一 Promise，避免重复导入。
 */
export function ensureDictImported(): Promise<void> {
  logger.debug('ensureDictImported');
  if (!importPromise) {
    importPromise = doImport().catch((error) => {
      // 导入失败时重置，允许下次重试；不抛出以免阻塞翻译主流程
      importPromise = null;
      logger.warn("[offlineDict] 词库导入失败：", error);
    });
  }
  return importPromise;
}

interface DictData {
  version?: number;
  entries?: Array<{ w?: string; p?: string; t?: string }>;
  lemma?: Record<string, string>;
}

async function doImport(): Promise<void> {
  const db = await openDb();

  // 读取打包词库的版本号
  const assetUrl = chrome.runtime.getURL(DICT_ASSET_PATH);
  const response = await fetch(assetUrl);
  if (!response.ok) {
    throw new Error(`无法加载词库资源：HTTP ${response.status}`);
  }
  const data: DictData = await response.json();
  const assetVersion = Number(data?.version) || 0;

  // 已是同版本则跳过
  const meta = await getByKey(db, STORE_META, META_VERSION_KEY);
  if (meta && Number(meta.value) === assetVersion) {
    db.close();
    return;
  }

  const entries = Array.isArray(data.entries) ? data.entries : [];
  const lemma = data.lemma && typeof data.lemma === "object" ? data.lemma : {};

  // 分批写入，避免单事务过大
  const BATCH = 5000;
  for (let i = 0; i < entries.length; i += BATCH) {
    const slice = entries.slice(i, i + BATCH);
    const tx = db.transaction(STORE_ENTRIES, "readwrite");
    const store = tx.objectStore(STORE_ENTRIES);
    for (const e of slice) {
      const word = String(e.w || "").trim();
      if (!word) continue;
      store.put({
        key: word.toLowerCase(),
        word,
        phonetic: e.p || "",
        translation: e.t || "",
      });
    }
    await txComplete(tx);
  }

  const lemmaEntries = Object.entries(lemma);
  for (let i = 0; i < lemmaEntries.length; i += BATCH) {
    const slice = lemmaEntries.slice(i, i + BATCH);
    const tx = db.transaction(STORE_LEMMA, "readwrite");
    const store = tx.objectStore(STORE_LEMMA);
    for (const [from, to] of slice) {
      if (!from || !to) continue;
      store.put({ from: String(from).toLowerCase(), to: String(to).toLowerCase() });
    }
    await txComplete(tx);
  }

  // 标记版本，完成导入
  const metaTx = db.transaction(STORE_META, "readwrite");
  metaTx.objectStore(STORE_META).put({ name: META_VERSION_KEY, value: assetVersion });
  await txComplete(metaTx);

  db.close();
  logger.info(`[offlineDict] 词库导入完成：${entries.length} 词条 / ${lemmaEntries.length} 词形`);
}

export interface OfflineTranslationResult {
  word: string;
  meaning: string;
  phonetic: string;
  exampleEn: string;
  exampleZh: string;
  note: string;
  provider: "offline";
}

/**
 * 离线查询单词。
 * @returns 命中返回 translator 兼容结构，未命中返回 null。
 */
export async function lookupOffline(word: string): Promise<OfflineTranslationResult | null> {
  const normalized = String(word || "").trim().toLowerCase();
  if (!normalized) return null;
  logger.debug('lookupOffline', { word: normalized });

  let db: IDBDatabase;
  try {
    db = await openDb();
  } catch (error) {
    logger.warn("[offlineDict] 打开数据库失败：", error);
    return null;
  }

  try {
    // 1. 直接查原词
    let entry = await getByKey(db, STORE_ENTRIES, normalized);

    // 2. 未命中 -> 词形还原（went -> go）后再查
    if (!entry) {
      const lemmaEntry = await getByKey(db, STORE_LEMMA, normalized);
      if (lemmaEntry?.to) {
        entry = await getByKey(db, STORE_ENTRIES, lemmaEntry.to);
      }
    }

    if (!entry || !entry.translation) {
      logger.debug('lookupOffline miss', { word: normalized });
      return null;
    }

    logger.info('lookupOffline hit', { word: entry.word || word });
    return {
      word: entry.word || word,
      meaning: entry.translation,
      phonetic: entry.phonetic || "",
      exampleEn: "",
      exampleZh: "",
      note: "",
      provider: "offline",
    };
  } catch (error) {
    logger.warn("[offlineDict] 查询失败：", error);
    return null;
  } finally {
    db.close();
  }
}
